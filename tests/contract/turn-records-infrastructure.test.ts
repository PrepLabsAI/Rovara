import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack, TURN_DETAILS_READ_ATTRIBUTES } from "../../infra/lib/control-plane.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { TURN_DETAILS_ATTRIBUTES } from "../../packages/contracts/src/index.js";

interface Statement { Action: string | string[]; Resource: unknown }

function statementsForRole(template: Template, prefix: string): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> };
  }>)
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(prefix)))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

const onTurnRecords = (statement: Statement) => JSON.stringify(statement.Resource).includes("TurnRecords");
const actions = (statements: Statement[]) => statements.filter(onTurnRecords).flatMap((statement) => [statement.Action].flat());

describe("turn record and alarm infrastructure", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "TurnRecordsControlPlane"));
  const topic = { Ref: Match.stringLikeRegexp("^OperatorAlerts") };

  it("keeps turn records 30 days by TTL and indexes them by time for export", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({
        IndexName: "byTime",
        KeySchema: [{ AttributeName: "exportPk", KeyType: "HASH" }, { AttributeName: "exportSk", KeyType: "RANGE" }],
        Projection: { ProjectionType: "ALL" },
      })],
    });
  });

  it("encrypts turn records at rest and retains the table on stack deletion", () => {
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "byTime" })] },
    });
    const entries = Object.values(tables) as Array<{ DeletionPolicy?: string; Properties: { SSESpecification?: { SSEEnabled?: boolean } } }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.Properties.SSESpecification?.SSEEnabled).toBe(true);
    expect(entries[0]!.DeletionPolicy).toBe("Retain");
  });

  it("lets the Slack service only put turn records and the broker only read them", () => {
    expect(actions(statementsForRole(template, "SlackOrchestratorTaskRole"))).toEqual(["dynamodb:PutItem"]);
    const broker = actions(statementsForRole(template, "BrokerServiceRole"));
    expect(broker).toEqual(["dynamodb:Query"]);
    expect(JSON.stringify(template.toJSON())).toContain("TURN_RECORDS_TABLE_NAME");
  });

  it("gives no other role access to turn records", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
      Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> };
    }>;
    const roles = policies
      .filter((policy) => policy.Properties.PolicyDocument.Statement.some(onTurnRecords))
      .flatMap((policy) => policy.Properties.Roles.map((role) => role.Ref ?? ""));
    // Spec 014 FR-024 admits exactly one more role: the ingress Lambda, for one record's Details fields (pinned below).
    expect(roles.every((role) => role.startsWith("SlackOrchestratorTaskRole") || role.startsWith("BrokerServiceRole") || role.startsWith("SlackIngressServiceRole"))).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(3);
  });

  it("ships the operator topic with no subscription and both alarms notifying it", () => {
    template.hasResourceProperties("AWS::SNS::Topic", { TopicName: "AgentXOperatorAlerts" });
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXConnectorBroken",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(discovery, 0) + FILL(drift, 0)" }),
        Match.objectLike({ Id: "discovery", MetricStat: Match.objectLike({ Metric: { Namespace: "AgentX", MetricName: "ConnectorDiscoveryFailed" }, Period: 300, Stat: "Sum" }) }),
        Match.objectLike({ Id: "drift", MetricStat: Match.objectLike({ Metric: { Namespace: "AgentX", MetricName: "ConnectorSchemaDrift" }, Period: 300, Stat: "Sum" }) }),
      ]),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXEmptyResponses",
      Namespace: "AgentX", MetricName: "TurnEmptyResponse", Statistic: "Sum", Period: 3_600,
      ComparisonOperator: "GreaterThanThreshold", Threshold: 3, TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
  });

  it("lets CloudWatch alarms in this account publish to the SSL-only topic", () => {
    template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      Topics: [topic],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Action: "sns:Publish", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
          Match.objectLike({
            Effect: "Allow",
            Action: "sns:Publish",
            Principal: { Service: "cloudwatch.amazonaws.com" },
            Resource: topic,
            Condition: {
              StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
              ArnLike: { "aws:SourceArn": Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":cloudwatch:", ":alarm:*"])]) }) },
            },
          }),
        ]),
      },
    });
  });

  it("pages the operator when turn records or turn metrics are being lost", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXRecordingFailures",
      AlarmDescription: Match.stringLikeRegexp("[Tt]urn records or turn metrics are being lost"),
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: "FILL(write,0) + FILL(emit,0)" }),
        Match.objectLike({ Id: "write", MetricStat: Match.objectLike({ Metric: { Namespace: "AgentX", MetricName: "TurnRecordWriteFailed" }, Period: 300, Stat: "Sum" }) }),
        Match.objectLike({ Id: "emit", MetricStat: Match.objectLike({ Metric: { Namespace: "AgentX", MetricName: "TurnMetricsEmitFailed" }, Period: 300, Stat: "Sum" }) }),
      ]),
    });
  });

  it("warns in the recording-failures alarm that a timed-out write may still have landed", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXRecordingFailures",
      AlarmDescription: Match.stringLikeRegexp("timed out may still have landed"),
    });
  });

  it("pages the operator when a vendor credential is not connected on any connector", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXConnectorNotConnected",
      Namespace: "AgentX", MetricName: "ConnectorNotConnected", Statistic: "Sum", Period: 300,
      Dimensions: Match.absent(),
      ComparisonOperator: "GreaterThanOrEqualToThreshold", Threshold: 1, EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
  });

  it("pages the operator when a Slack request lands in the dead-letter queue", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "AgentXSlackDeadLetters",
      Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Statistic: "Maximum", Period: 300,
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^SlackRequestDeadLetterQueue"), "QueueName"] } }],
      ComparisonOperator: "GreaterThanOrEqualToThreshold", Threshold: 1, EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
  });

  it("outputs the table and topic for the release and the deployer", () => {
    template.hasOutput("TurnRecordsTableName", {});
    template.hasOutput("OperatorAlertsTopicArn", {});
  });
});

describe("Slack service turn records and metric filters", () => {
  const template = Template.fromStack(new SlackOrchestratorStack(new App(), "TurnRecordsSlack", { env: { region: "us-east-1" } }));

  it("requires the turn record table name and passes it to the container", () => {
    template.hasParameter("TurnRecordsTableName", { Type: "String", MinLength: 3 });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([{ Name: "TURN_RECORDS_TABLE_NAME", Value: { Ref: "TurnRecordsTableName" } }]),
      })],
    });
  });

  it("has the production release pass every required Slack stack parameter", () => {
    const parameters = template.toJSON().Parameters as Record<string, { Default?: unknown }>;
    const required = Object.entries(parameters)
      .filter(([name, parameter]) => name !== "BootstrapVersion" && parameter.Default === undefined)
      .map(([name]) => name);
    expect(required).toContain("TurnRecordsTableName");
    const release = readFileSync("scripts/release-production.ts", "utf8");
    expect(release).toContain('...parameter("TurnRecordsTableName", stackOutput(controlPlane, "TurnRecordsTableName"))');
    const passed = [...release.matchAll(/\.\.\.parameter\("([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(required.filter((name) => !passed.includes(name))).toEqual([]);
  });

  it("turns each metric log line into an AgentX metric", () => {
    for (const metric of ["TurnCompleted", "TurnEmptyResponse", "ToolUnknownName", "TurnRecordWriteFailed"]) {
      template.hasResourceProperties("AWS::Logs::MetricFilter", {
        FilterPattern: `{ ($.event = "metric") && ($.metric = "${metric}") }`,
        MetricTransformations: [{ MetricNamespace: "AgentX", MetricName: metric, MetricValue: "$.count" }],
      });
    }
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: "{ ($.event = \"metric\") && ($.metric = \"ToolSchemaError\") }",
      MetricTransformations: [{ MetricNamespace: "AgentX", MetricName: "ToolSchemaError", MetricValue: "$.count", Dimensions: [{ Key: "connector", Value: "$.connector" }] }],
    });
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: "{ $.event = \"turn_metrics.emit_failed\" }",
      MetricTransformations: [{ MetricNamespace: "AgentX", MetricName: "TurnMetricsEmitFailed", MetricValue: "1" }],
    });
    // The six above, and spec 052's EvalBatchWatcherFailed (eval-batch-tick-infrastructure.test.ts).
    template.resourceCountIs("AWS::Logs::MetricFilter", 7);
  });
});

describe("Details view access to turn records (spec 014 FR-024)", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "TurnDetailsControlPlane"));

  it("lets the ingress Lambda get one turn record by key, with only the attributes the Details view shows", () => {
    const statements = statementsForRole(template, "SlackIngressServiceRole").filter(onTurnRecords);
    expect(statements).toHaveLength(1);
    expect([statements[0]!.Action].flat()).toEqual(["dynamodb:GetItem"]);
    expect(JSON.stringify(statements[0]!.Resource)).not.toContain("index");
    // The whole statement, exactly: no extra action, resource or condition operator can slip in.
    expect(statements[0]).toEqual({
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource: { "Fn::GetAtt": [expect.stringMatching(/^TurnRecords/) as string, "Arn"] },
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": TURN_DETAILS_READ_ATTRIBUTES },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        // ForAllValues passes on a missing key: a GetItem without a ProjectionExpression must be refused.
        Null: { "dynamodb:Attributes": "false" },
      },
    });
  });

  it("keeps the IAM attribute list equal to the keys plus what the Details reader asks for, never the request or response text", () => {
    expect([...TURN_DETAILS_READ_ATTRIBUTES].sort()).toEqual(["pk", "sk", "exportPk", "exportSk", ...TURN_DETAILS_ATTRIBUTES].sort());
    for (const name of ["requestText", "responseText", "textTruncated", "workspaceId", "conversationId", "workerOperations", "manifestHash"]) {
      expect(TURN_DETAILS_READ_ATTRIBUTES).not.toContain(name);
    }
  });

  it("passes the turn record table name to the ingress Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({
        SLACK_REQUEST_QUEUE_URL: Match.anyValue(),
        TURN_RECORDS_TABLE_NAME: { Ref: Match.stringLikeRegexp("^TurnRecords") },
      }) },
    });
  });
});
