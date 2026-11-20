import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { NAT_ELASTIC_IPS } from "../../packages/cli/src/init/prerequisites.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import {
  ProductionFoundationStack,
  defaultProductionAvailabilityZoneIds,
  validateProductionFoundationConfiguration,
} from "../../infra/lib/production-foundation.js";
import { WorkerSettingsStack } from "../../infra/lib/worker-settings.js";
import {
  AGENTX_RELEASE_PROJECT_NAME,
  AGENTX_RELEASE_TRIGGER_PATHS,
  AGENTX_STAGING_BUILD_ROLE_NAME,
  AGENTX_STAGING_RELEASE_PROJECT_NAME,
  AGENTX_STAGING_RELEASE_ROLE_NAME,
  PROMOTION_GATE_REASON,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { StagingReleaseAccessStack } from "../../infra/lib/staging-release-access.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";

skipLambdaBundling();

interface PolicyStatement {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

function policyStatements(template: Template): PolicyStatement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: PolicyStatement[] }; Roles: unknown[] };
  }>).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function statementsForRole(template: Template, roleLogicalIdPrefix: string, options: { switchedOff?: boolean } = {}): PolicyStatement[] {
  return (Object.entries(template.findResources("AWS::IAM::Policy")) as Array<[string, {
    Condition?: string; Properties: { PolicyDocument: { Statement: PolicyStatement[] }; Roles: Array<{ Ref?: string }> };
  }]>)
    // #1171: with `switchedOff`, the grants that exist only under a switch's CloudFormation condition (Slack company mode's, slack-company-workspaces.ts) are left out:
    // with the switch off (its default) CloudFormation creates none of them. They are pinned on their own in slack-company-workspaces-infrastructure.test.ts.
    .filter(([id, policy]) => !(options.switchedOff === true && policy.Condition !== undefined && id.startsWith("SlackCompanyMode")))
    .filter(([, policy]) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(roleLogicalIdPrefix)))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: PolicyStatement) => [statement.Action].flat();

describe("hosted Slack control-plane infrastructure", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "SlackControlPlane"));

  it("lets the dispatcher read only the immutable E2E admission objects, to hold a reference's kind to its admission", () => {
    const statements = statementsForRole(template, "DispatcherServiceRole");
    const reads = statements.filter((statement) => actionsOf(statement).some((action) => action === "s3:GetObject*" || action === "s3:GetObject"));
    // #1148: plus the core engine's company-bound artifact reader (DISPATCHER_ARTIFACTS_READ_SID), read only.
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads.map((statement) => statement.Resource))).toContain("/workflow-e2e-admissions/*");
    for (const read of reads) expect(actionsOf(read).some((action) => /Put|Delete/.test(action))).toBe(false);
    const dispatcher = Object.values(template.findResources("AWS::Lambda::Function")).find((fn) => JSON.stringify(fn).includes("MAX_DISPATCH_ATTEMPTS")) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
    expect(dispatcher.Properties.Environment.Variables).toHaveProperty("ARTIFACT_BUCKET_NAME");
  });

  it("routes Slack events without a JWT and service calls only with IAM authorization", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/slack/events",
      AuthorizationType: "NONE",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^SlackIngressIntegration") }]] },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /v1/service/{proxy+}",
      AuthorizationType: "AWS_IAM",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^BrokerIntegration") }]] },
    });
  });

  it("exposes a broker-verified GitHub webhook endpoint without a user JWT", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/github/webhooks",
      AuthorizationType: "NONE",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^BrokerIntegration") }]] },
    });
    template.hasOutput("GithubWebhookUrl", {});
  });

  it("routes only the capability-protected project setup execution read through the internal API", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
      AuthorizationType: "NONE",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^BrokerIntegration") }]] },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/internal/{proxy+}",
      AuthorizationType: "NONE",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^BrokerIntegration") }]] },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /{proxy+}",
      AuthorizationType: "JWT",
      AuthorizerId: { Ref: Match.stringLikeRegexp("^JwtAuthorizer") },
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^BrokerIntegration") }]] },
    });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")) as Array<{ Properties: { RouteKey: string } }>;
    expect(routes.some((route) => route.Properties.RouteKey === "GET /v1/internal/{proxy+}")).toBe(false);
  });

  it("indexes due GitHub webhook retries and invokes the broker from a bounded recovery schedule", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: "github-webhook-recovery",
        KeySchema: [{ AttributeName: "webhookRecoveryPk", KeyType: "HASH" }, { AttributeName: "webhookRecoverySk", KeyType: "RANGE" }],
      })]),
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(1 minute)",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: Match.objectLike({ Input: '{"source":"agentx.github-webhook-recovery"}', RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 } }),
    });
  });

  it("invokes the broker every minute to recover lost workflow dispatches", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "rate(1 minute)", FlexibleTimeWindow: { Mode: "OFF" },
      Target: Match.objectLike({ Input: '{"source":"agentx.workflow-dispatch-recovery"}', RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 } }) });
    // The sweep reads due rows through a sparse due-time index, so rows waiting out a backoff never hide due ones.
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: "workflow-dispatch-due",
        KeySchema: [{ AttributeName: "dispatchDuePk", KeyType: "HASH" }, { AttributeName: "dispatchDueSk", KeyType: "RANGE" }],
      })]),
    });
  });

  it("lets only this account's own schedules assume the scheduler recovery roles (confused deputy)", () => {
    const roles = Object.entries(template.findResources("AWS::IAM::Role"))
      .filter(([id]) => id.startsWith("GithubWebhookRecoveryRole") || id.startsWith("WorkflowDispatchRecoveryRole"));
    expect(roles).toHaveLength(2);
    for (const [, role] of roles) {
      expect((role as { Properties: { AssumeRolePolicyDocument: { Statement: unknown[] } } }).Properties.AssumeRolePolicyDocument.Statement).toEqual([expect.objectContaining({
        Principal: { Service: "scheduler.amazonaws.com" },
        Condition: {
          StringEquals: {
            "aws:SourceAccount": { Ref: "AWS::AccountId" },
            "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":scheduler:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":schedule-group/default"]] },
          },
        },
      })]);
    }
  });

  it("queues Slack requests in a FIFO queue with a dead-letter queue after five receives", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      ContentBasedDeduplication: false,
      VisibilityTimeout: 900,
      RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({ GenerateStringKey: "signingSecret" }),
    });
    template.hasParameter("SlackMemberWorkspaceLimit", { Type: "Number", Default: 3 });
    template.hasParameter("SlackOrganizationWorkspaceLimit", { Type: "Number", Default: 20 });
  });

  it("tells the broker which role is the orchestrator and which limits apply", () => {
    // #1149: the legacy broker packs the limits (and keeps the role's ARN whole); read them as the broker does.
    const [, broker] = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    const variables = unpackedBrokerVariables((broker as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables, template.toJSON() as never);
    expect(variables.SLACK_ORCHESTRATOR_ROLE_ARN).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^SlackOrchestratorTaskRole/u) as unknown, "Arn"] });
    expect(variables.SLACK_MEMBER_WORKSPACE_LIMIT).toEqual({ Ref: "SlackMemberWorkspaceLimit" });
    expect(variables.SLACK_ORGANIZATION_WORKSPACE_LIMIT).toEqual({ Ref: "SlackOrganizationWorkspaceLimit" });
  });

  it("the broker can send to the Slack request queue and knows its URL", () => {
    const [, broker] = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => /^Broker[0-9A-F]{8}$/.test(id))!;
    // #1149: packed as the queue's name; the broker builds the URL from it (tests/contract/legacy-broker-packed-environment.test.ts).
    expect(unpackedBrokerVariables((broker as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables, template.toJSON() as never).SLACK_REQUEST_QUEUE_URL)
      .toEqual({ "Fn::GetAtt": [expect.stringMatching(/^SlackRequestQueue[0-9A-F]{8}$/) as unknown, "QueueName"] });
    const statements = statementsForRole(template, "BrokerServiceRole");
    const send = statements.find((statement) => actionsOf(statement).includes("sqs:SendMessage") && JSON.stringify(statement.Resource).includes("SlackRequestQueue"));
    expect(send).toBeDefined();
    // Send only: the broker never reads or deletes the service's requests.
    expect(statements.filter((statement) => JSON.stringify(statement.Resource).includes("SlackRequestQueue")).flatMap(actionsOf)).not.toContain("sqs:ReceiveMessage");
  });

  it("gives the orchestrator role service-route invoke only, and no access to the control-plane state table", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "ecs-tasks.amazonaws.com" } })]),
      }),
    });
    // Slack company mode off (its default): its read of the team's binding (#1171) exists only under the switch's condition.
    const statements = statementsForRole(template, "SlackOrchestratorTaskRole", { switchedOff: true });
    const invoke = statements.find((statement) => actionsOf(statement).includes("execute-api:Invoke"));
    expect(JSON.stringify(invoke?.Resource)).toContain("/*/*/v1/service/*");
    expect(JSON.stringify(statements)).not.toMatch(/"State[0-9A-F]{8}"/);
    expect(statements.flatMap(actionsOf)).not.toContain("dynamodb:*");
  });

  it("limits the ingress Lambda to reading items by key from the state table: channel bindings, shared threads and task buttons", () => {
    // Slack company mode off (its default): its project-company Query (#1171) exists only under the switch's condition.
    const statements = statementsForRole(template, "SlackIngress", { switchedOff: true });
    const stateAccess = statements.filter((statement) => JSON.stringify(statement.Resource).match(/"State[0-9A-F]{8}"/));
    for (const statement of stateAccess) expect(actionsOf(statement)).toEqual(["dynamodb:GetItem"]);
    const keys = stateAccess.map((statement) => (statement.Condition as Record<string, Record<string, unknown>>)["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]);
    expect(keys).toEqual(expect.arrayContaining([["SLACK_BINDING#*"], ["SHARED_TASK#*"], ["DEVTASK#*"]]));
    expect(keys.every((entry) => Array.isArray(entry))).toBe(true);
  });
});

describe("hosted Slack orchestrator service", () => {
  const template = Template.fromStack(new SlackOrchestratorStack(new App(), "TestSlackOrchestrator", { env: { region: "us-east-1" } }));

  it("runs one ARM64 Fargate task with the control-plane task role and no public IP", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
      TaskRoleArn: { Ref: "TaskRoleArn" },
      ContainerDefinitions: [Match.objectLike({
        Image: { Ref: "OrchestratorImageUri" },
        Environment: Match.arrayWith([
          { Name: "CONTROL_PLANE_URL", Value: { Ref: "ControlPlaneUrl" } },
          { Name: "SLACK_REQUEST_QUEUE_URL", Value: { Ref: "SlackRequestQueueUrl" } },
        ]),
      })],
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED", Subnets: { Ref: "PrivateSubnetIds" } }) },
    });
    template.hasParameter("OrchestratorImageUri", { AllowedPattern: "^.+@sha256:[a-f0-9]{64}$" });
    template.hasParameter("OrchestratorImageRepositoryName", { AllowedPattern: "^(?:\\{\\{output:access\\.PullThroughPrefix\\}\\}/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$" });
  });

  it("allows only outbound HTTPS and pulls only the orchestrator image", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupEgress: [Match.objectLike({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 })],
      SecurityGroupIngress: Match.absent(),
    });
    const statements = policyStatements(template);
    expect(statements.filter((statement) => statement.Resource === "*").flatMap(actionsOf)).toEqual(["ecr:GetAuthorizationToken"]);
    const pull = statements.find((statement) => actionsOf(statement).includes("ecr:BatchGetImage"));
    expect(pull?.Sid).toBe("EcrSelectedImage");
    expect(JSON.stringify(pull?.Resource)).toContain("repository/");
    expect(JSON.stringify(pull?.Resource)).toContain("OrchestratorImageRepositoryName");
  });
});

describe("control-plane infrastructure", () => {
  it("synthesizes private storage, durable dispatch and JWT auth", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "TestControlPlane");
    const template = Template.fromStack(stack).toJSON();
    const json = JSON.stringify(template);

    expect(json).toContain("AWS::DynamoDB::Table");
    expect(json).toContain("AWS::SQS::Queue");
    expect(json).toContain("AWS::S3::Bucket");
    expect(json).toContain("JWT");
    expect(json).not.toContain("InvokeAgentRuntime");
    Template.fromStack(stack).hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "agentx-control-plane",
      ProtocolType: "HTTP",
    });
  });

  it("packages real handlers with durable environment wiring instead of inline stubs", { timeout: 30_000 }, () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "PackagedControlPlane");
    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());

    // Broker, outbox publisher, dispatcher, Slack ingress, the EC2 session steps (#83), idle
    // reaper (#85) and reconciler (#86), the eval batch tick (spec 052), and the channel API and its event sender
    // (spec 062 Phase 7d: the built-in Slack adapter), and developer sign-in for account linking (spec 064). #1148: and the core engine's attention email sender
    // (which exists only while CoreAttentionEmail is on).
    template.resourceCountIs("AWS::Lambda::Function", 13);
    expect(json).not.toContain("ZipFile");
    expect(json).not.toContain("not packaged");
    expect(json).toContain("STATE_TABLE_NAME");
    expect(json).toContain("ARTIFACT_BUCKET_NAME");
    expect(json).toContain("DISPATCH_QUEUE_URL");
    expect(json).toContain("MAX_DISPATCH_ATTEMPTS");
    // The key reaches a function as the name of its secret, never as a value.
    expect(json).toContain("CALLBACK_SIGNING_KEY_SECRET_ID");
    expect(json).not.toContain("\"CALLBACK_SIGNING_KEY\"");
    expect(json).toContain("ADMIN_CLAIM");
    expect(json).toContain("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
    // The broker looks up the GitHub App's installation per repository owner (#123).
    expect(json).not.toContain("GITHUB_APP_INSTALLATION_ID");
    expect(json).not.toContain("GITHUB_APP_ACCOUNT");
    expect(json).toContain("secretsmanager:GetSecretValue");
    const githubSecretGrants = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy) => (policy as { Properties: { PolicyDocument: { Statement: Array<{ Resource: unknown }> } } })
        .Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Resource).includes("GitHubAppPrivateKeySecretArn"));
    expect(githubSecretGrants).toHaveLength(1);
    expect(json.match(/GITHUB_APP_PRIVATE_KEY_SECRET_ARN/g)).toHaveLength(1);
    expect(json).toContain("codebuild:StartBuild");
    expect(json).toContain("codebuild:BatchGetBuilds");
    expect(json).toContain(":codebuild:");
    expect(json).toContain("project/agentx-*");
    // retired runtime was removed (#118).
    expect(json).not.toMatch(/bedrock-[a-z]+:/);
  });

  it("lets the broker read connector secrets under agentx/connectors/* and never every secret", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "ConnectorSecretsControlPlane");
    const reads = policyStatements(Template.fromStack(stack))
      .filter((statement) => [statement.Action].flat().includes("secretsmanager:GetSecretValue"));
    const connectorGrants = reads.filter((statement) => JSON.stringify(statement.Resource).includes("secret:agentx/connectors/*"));
    expect(connectorGrants).toHaveLength(1);
    expect(reads.some((statement) => [statement.Resource].flat().includes("*"))).toBe(false);
  });

  it("retains each Lambda log group for 30 days and removes it with the demo stack", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "LoggedControlPlane");
    const template = Template.fromStack(stack);

    // One per Lambda, plus the EC2 session provisioner's and deleter's (#83). #1148: the attention email sender's too.
    template.resourceCountIs("AWS::Logs::LogGroup", 15);
    template.allResourcesProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 30,
    });
    template.allResources("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
    template.allResourcesProperties("AWS::Lambda::Function", {
      LoggingConfig: {
        LogGroup: Match.anyValue(),
      },
    });
  });
});

describe("production foundation and worker settings", () => {
  it("synthesizes a dedicated two-AZ VPC, the retained workspace key and the EC2 workers, and nothing of retired runtime", () => {
    const app = new App();
    const stack = new ProductionFoundationStack(app, "TestFoundation", {
      deploymentRegion: "us-east-1",
    });
    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());

    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::Subnet", 4);
    template.resourceCountIs("AWS::EC2::NatGateway", 2);
    // init's prerequisite check counts on this many Elastic IPs for a new environment.
    template.resourceCountIs("AWS::EC2::EIP", NAT_ELASTIC_IPS);
    template.resourceCountIs("AWS::EC2::FlowLog", 1);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
    template.resourceCountIs("AWS::KMS::Key", 1);
    expect(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).filter((resource) => resource.Type.startsWith("AWS::Bedrock"))).toEqual([]);
    expect(json).not.toContain("AWS::Bedrock");
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({ InstanceType: "m6g.large" }),
    });
    expect(json).toContain("alias/agentx/production-workspaces");
    expect(json).toContain('"RetentionInDays":30');
  });

  it("releases only the EC2 worker settings, under the parameter logical IDs the runtime stack used", () => {
    const template = Template.fromStack(new WorkerSettingsStack(new App(), "TestRuntime"));
    const resources = template.toJSON().Resources as Record<string, { Type: string }>;
    // The live stack's logical IDs, so CloudFormation updates these parameters in place; a new ID
    // would try to create a second parameter with the same name and fail the release (#117).
    expect(Object.entries(resources).filter(([, resource]) => resource.Type !== "AWS::CDK::Metadata").map(([id, resource]) => [id, resource.Type]).sort()).toEqual([
      [expect.stringMatching(/^WorkerAnthropicSecretParameter/), "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerE2eAgentModelParameter/), "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerExecutorImageParameter/), "AWS::SSM::Parameter"],
      ["WorkerImageParameter7CA9ADBB", "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerModelFallbackParameter/), "AWS::SSM::Parameter"],
      ["WorkerModelIdParameter02DE997A", "AWS::SSM::Parameter"],
      ["WorkerModelProviderParameterFBA25A19", "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerOpenAISecretParameter/), "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerOpenRouterProvidersParameter/), "AWS::SSM::Parameter"],
      [expect.stringMatching(/^WorkerOpenRouterSecretParameter/), "AWS::SSM::Parameter"],
      ["WorkerPromptCacheRetentionParameter7E1031C3", "AWS::SSM::Parameter"],
    ]);
    expect(Object.keys(template.toJSON().Parameters as object)).toEqual(expect.arrayContaining(["WorkerImageUri", "ModelProvider", "ModelId", "PromptCacheRetention"]));
    expect(template.toJSON().Parameters).not.toHaveProperty("ControlPlaneUrl");
    expect(template.toJSON().Parameters).not.toHaveProperty("CapacityProviderArn");
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/agentx/production/worker-image",
      Value: { Ref: "WorkerImageUri" },
    });
    // The browser executor image: optional, so a release without one deploys unchanged, and published for the worker's boot config.
    template.hasParameter("ExecutorImageUri", {
      Type: "String",
      Default: "none",
      AllowedPattern: "^(none|.+@sha256:[a-f0-9]{64})$",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/agentx/production/worker-executor-image",
      Value: { Ref: "ExecutorImageUri" },
    });
    template.hasParameter("PromptCacheRetention", {
      Type: "String",
      Default: "long",
      AllowedValues: ["short", "long"],
    });
  });

  it("rejects invalid AZ settings", () => {
    const foundation = {
      region: "us-east-1",
      availabilityZoneIds: defaultProductionAvailabilityZoneIds("us-east-1"),
      instanceType: "m6g.medium",
    };
    expect(validateProductionFoundationConfiguration(foundation)).toEqual(foundation);
    expect(() => validateProductionFoundationConfiguration({
      ...foundation,
      availabilityZoneIds: ["use1-az1", "use1-az1"],
    })).toThrow(/distinct/i);
    expect(() => defaultProductionAvailabilityZoneIds("eu-west-1")).toThrow(/no verified/i);
  });
});

describe("production release pipeline", () => {
  const template = Template.fromStack(
    new ReleasePipelineStack(new App(), "TestReleasePipeline", { env: { region: "us-east-1" } }),
  );
  interface Statement {
    Sid?: string;
    Action: string | string[];
    Resource: unknown;
  }
  const policies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: Statement[] } };
  }>;
  const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const actionsOf = (statement: Statement) => [statement.Action].flat();

  it("starts a V2 pipeline only for filtered mainline pushes, with a full Git clone, staging first and production behind a disabled transition", () => {
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      PipelineType: "V2",
      // #1242: a run waiting at the disabled transition is replaced by a newer one only in SUPERSEDED mode, so a promotion takes staging's newest commit.
      ExecutionMode: "SUPERSEDED",
      DisableInboundStageTransitions: [{ StageName: "Production", Reason: PROMOTION_GATE_REASON }],
      Triggers: [{
        ProviderType: "CodeStarSourceConnection",
        GitConfiguration: {
          SourceActionName: "GitHub",
          Push: [{
            Branches: { Includes: ["mainline"] },
            FilePaths: { Includes: [...AGENTX_RELEASE_TRIGGER_PATHS] },
          }],
        },
      }],
      Stages: Match.arrayWith([Match.objectLike({
        Name: "Source",
        Actions: [Match.objectLike({
          Configuration: {
            ConnectionArn: { Ref: "GitHubConnectionArn" },
            FullRepositoryId: "PrepLabsAI/Rovara",
            BranchName: "mainline",
            OutputArtifactFormat: "CODEBUILD_CLONE_REF",
          },
        })],
      })]),
    });
    template.resourceCountIs("AWS::KMS::Key", 0);
    const [pipeline] = Object.values(template.findResources("AWS::CodePipeline::Pipeline")) as Array<{
      Properties: { Stages: Array<{ Name: string; Actions: Array<{ Name: string; Configuration: { ProjectName: unknown } }> }> };
    }>;
    expect(pipeline?.Properties.Stages.map((stage) => `${stage.Name}:${stage.Actions.map((action) => action.Name).join(",")}`))
      .toEqual(["Source:GitHub", "Staging:ReleaseStaging", "Production:ReleaseProduction"]);
  });

  it("gives the transition into Production a reason CodePipeline accepts", () => {
    // CodePipeline refuses any other character in a transition's reason (DisableStageTransition), and the release passes the same text.
    expect(PROMOTION_GATE_REASON).toMatch(/^[a-zA-Z0-9!@ ().*?-]{1,300}$/u);
  });

  const projects = Object.values(template.findResources("AWS::CodeBuild::Project")) as Array<{
    Properties: { Name: string; Source: { BuildSpec: unknown }; ServiceRole: unknown };
  }>;
  /** A build spec as text; the staging one is a join around the staging account parameter. */
  const buildSpecOf = (name: string): string => {
    const spec = projects.find((project) => project.Properties.Name === name)?.Properties.Source.BuildSpec;
    if (typeof spec === "string") return spec;
    const parts = (spec as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"]?.[1] ?? [];
    return parts.map((part) => (typeof part === "string" ? part : "<token>")).join("");
  };

  it("closes the gate first in the production release, so one promotion lets in one commit", () => {
    const buildSpec = buildSpecOf(AGENTX_RELEASE_PROJECT_NAME);
    const install = buildSpec.indexOf('"install"');
    const close = buildSpec.indexOf("aws codepipeline disable-stage-transition --pipeline-name AgentXProductionRelease --stage-name Production --transition-type Inbound");
    expect(close).toBeGreaterThan(install);
    expect(close).toBeLessThan(buildSpec.indexOf("node_version="));
    expect(statements.find((statement) => statement.Sid === "ClosePromotionGate")?.Action).toEqual("codepipeline:DisableStageTransition");
    expect(buildSpec).not.toContain("--profile");
  });

  it("runs the staging release in the staging account, as its release role, after CI's proof in this account", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_STAGING_RELEASE_PROJECT_NAME,
      ConcurrentBuildLimit: 1,
      TimeoutInMinutes: 120,
      Environment: Match.objectLike({ Type: "ARM_CONTAINER", ComputeType: "BUILD_GENERAL1_LARGE", PrivilegedMode: true }),
    });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: AGENTX_STAGING_BUILD_ROLE_NAME });
    template.hasParameter("StagingAccountId", { Type: "String", AllowedPattern: "^[0-9]{12}$" });
    const buildSpec = buildSpecOf(AGENTX_STAGING_RELEASE_PROJECT_NAME);
    expect(buildSpec).not.toContain("disable-stage-transition");
    const proof = buildSpec.indexOf("node scripts/release-ci-proof.ts");
    const profile = buildSpec.indexOf("[profile agentx-staging]");
    expect(proof).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(proof);
    expect(buildSpec).toContain("credential_source = EcsContainer");
    expect(buildSpec).toContain(`:role/${AGENTX_STAGING_RELEASE_ROLE_NAME}`);
    expect(buildSpec).toContain('npm run release:prod -- --region \\"$AWS_REGION\\" --profile agentx-staging --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS');
    expect(buildSpec.match(/--skip-checks/gu)).toHaveLength(1);
    expect(buildSpec).not.toMatch(/--allow-dirty/);
    // The staging build's own rights: CI's proof here, and the staging account's release role; nothing that deploys in this account.
    const stagingPolicy = Object.values(template.findResources("AWS::IAM::Policy")).find((policy) =>
      JSON.stringify((policy as { Properties: { Roles: unknown } }).Properties.Roles).includes("StagingReleaseBuildRole")) as
      { Properties: { PolicyDocument: { Statement: Statement[] } } } | undefined;
    const sids = (stagingPolicy?.Properties.PolicyDocument.Statement ?? []).map((statement) => statement.Sid).filter(Boolean);
    expect(sids).toEqual(expect.arrayContaining(["ReadGithubAppKeyForCiProof", "ReadReleaseStacks", "AssumeStagingReleaseRole"]));
    expect(sids).not.toContain("AssumeCdkBootstrapRoles");
    expect(sids).not.toContain("ProductionWorkerRepository");
  });

  it("runs the checked production release on one native ARM Docker build at a time", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_RELEASE_PROJECT_NAME,
      ConcurrentBuildLimit: 1,
      TimeoutInMinutes: 120,
      Environment: Match.objectLike({
        Type: "ARM_CONTAINER",
        ComputeType: "BUILD_GENERAL1_LARGE",
        Image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
        PrivilegedMode: true,
      }),
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    const buildSpec = buildSpecOf(AGENTX_RELEASE_PROJECT_NAME);
    expect(buildSpec).toContain("npm run release:prod");
    // #1145: --skip-checks only behind the CI proof; without it every check runs.
    expect(buildSpec).toContain("if node scripts/release-ci-proof.ts --repository PrepLabsAI/Rovara --github-app-stack AgentXControlPlane --region ");
    expect(buildSpec).toContain("; then RELEASE_CHECKS=--skip-checks; else RELEASE_CHECKS=; fi; ");
    expect(buildSpec).toContain("--require-existing-foundation $RELEASE_CHECKS");
    expect(buildSpec.match(/--skip-checks/gu)).toHaveLength(1);
    expect(buildSpec).toContain("--reuse-unchanged-worker");
    expect(buildSpec).toContain("--require-existing-foundation");
    expect(buildSpec).not.toMatch(/--allow-dirty/);
    expect(buildSpec).toContain("sha256sum -c");
    expect(buildSpec).toContain("awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip");
    // The port guard's tests run the real secret scan: the release machine has the same pinned gitleaks as CI, checked before use.
    expect(buildSpec).toContain("gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz");
    expect(buildSpec).toContain('echo \\"${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz\\" | sha256sum -c -');
    expect(buildSpec).toContain("/opt/gitleaks:$PATH");
    // #1118: tsc -b needs about 4 GB since mainline took code/next; without a larger heap the release's typecheck dies out of memory.
    expect(buildSpec).toContain('"NODE_OPTIONS": "--max-old-space-size=8192"');
  });

  it("keeps the release projects outside the broker's CodeBuild gate allow-list", () => {
    expect(AGENTX_RELEASE_PROJECT_NAME).not.toMatch(/^agentx-/i);
    expect(AGENTX_STAGING_RELEASE_PROJECT_NAME).not.toMatch(/^agentx-/i);
  });

  it("grants no wildcard actions and scopes release permissions to production resources", () => {
    const json = JSON.stringify(template.toJSON());
    const actions = statements.flatMap(actionsOf);
    expect(actions.filter((action) => action === "*" || action.endsWith(":*"))).toEqual([]);
    expect(
      statements.filter((statement) => statement.Resource === "*").flatMap(actionsOf),
    ).toEqual(["ecr:GetAuthorizationToken"]);
    const assume = statements.find((statement) => statement.Sid === "AssumeCdkBootstrapRoles");
    expect(JSON.stringify(assume?.Resource)).toContain(":role/cdk-hnb659fds-*-");
    const repository = statements.find((statement) => statement.Sid === "ProductionWorkerRepository");
    expect(JSON.stringify(repository?.Resource)).toContain("repository/agentx-worker-production");
    expect(JSON.stringify(repository?.Resource)).toContain("repository/agentx-slack-orchestrator");
    expect(actionsOf(repository!)).not.toContain("ecr:CreateRepository");
    const stacks = statements.find((statement) => statement.Sid === "ReadReleaseStacks");
    expect(JSON.stringify(stacks?.Resource)).toContain("stack/AgentXSlackOrchestrator/*");
    expect(json).toContain("codeconnections:UseConnection");
    expect(json).not.toMatch(/bedrock-[a-z]+:/);
    expect(actions).not.toContain("cloudformation:CreateStack");
  });
});

describe("staging release access (#1242)", () => {
  const template = Template.fromStack(new StagingReleaseAccessStack(new App(), "TestStagingReleaseAccess", { env: { region: "us-east-1" } }));
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> } };
  }>).flatMap((policy) => policy.Properties.PolicyDocument.Statement);

  it("trusts only the release account's staging build role", () => {
    template.hasParameter("ReleaseAccountId", { Type: "String", AllowedPattern: "^[0-9]{12}$" });
    const [role] = Object.values(template.findResources("AWS::IAM::Role")) as Array<{
      Properties: { RoleName: string; AssumeRolePolicyDocument: { Statement: Array<{ Principal: unknown; Condition: unknown }> } };
    }>;
    expect(role?.Properties.RoleName).toBe(AGENTX_STAGING_RELEASE_ROLE_NAME);
    expect(role?.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    const trust = JSON.stringify(role?.Properties.AssumeRolePolicyDocument.Statement[0]);
    expect(trust).toContain('"ArnEquals":{"aws:PrincipalArn"');
    expect(trust).toContain(`:role/${AGENTX_STAGING_BUILD_ROLE_NAME}`);
    expect(trust).toContain('{"Ref":"ReleaseAccountId"}');
  });

  it("has the production release build's rights in its own account and nothing more", () => {
    expect(statements.map((statement) => statement.Sid)).toEqual(["AssumeCdkBootstrapRoles", "EcrAuthorization", "ReleaseImageRepositories", "ReadReleaseStacks"]);
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    expect(actions.filter((action) => action === "*" || action.endsWith(":*"))).toEqual([]);
    expect(statements.filter((statement) => statement.Resource === "*").flatMap((statement) => [statement.Action].flat())).toEqual(["ecr:GetAuthorizationToken"]);
    expect(actions).not.toContain("secretsmanager:GetSecretValue");
    expect(actions).not.toContain("ecr:CreateRepository");
  });
});

describe("hosted Slack ingress switches (spec 014)", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "SlackIngressSwitches"));

  it("lets an administrator turn off app-posted messages and change the per-thread turn limit", () => {
    template.hasParameter("SlackAppPostedMessages", { Type: "String", Default: "accept", AllowedValues: ["accept", "ignore"] });
    template.hasParameter("SlackThreadTurnsPerMinute", {
      Type: "String",
      Default: "6",
      AllowedPattern: "^([1-9]|[1-5][0-9]|60)$",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          SLACK_SECRET_ARN: Match.anyValue(),
          SLACK_APP_POSTED_MESSAGES: { Ref: "SlackAppPostedMessages" },
          SLACK_THREAD_TURNS_PER_MINUTE: { Ref: "SlackThreadTurnsPerMinute" },
        }),
      },
    });
  });
});

describe("Slack interactivity infrastructure (spec 014)", () => {
  it("routes Slack's interactivity requests, unauthenticated at the gateway, to the ingress Lambda that verifies them", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "SlackInteractivityControlPlane"));
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/slack/interactions",
      AuthorizationType: "NONE",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: Match.stringLikeRegexp("^SlackIngressIntegration") }]] },
    });
    template.hasOutput("SlackInteractivityUrl", {});
    // Broker, outbox publisher, dispatcher, Slack ingress, the EC2 session steps (#83), idle
    // reaper (#85) and reconciler (#86), the eval batch tick (spec 052), and the channel API and its event sender
    // (spec 062 Phase 7d: the built-in Slack adapter), and developer sign-in for account linking (spec 064). #1148: and the core engine's attention email sender
    // (which exists only while CoreAttentionEmail is on).
    template.resourceCountIs("AWS::Lambda::Function", 13);
  });
});

describe("action gate classifier setting (spec 014)", () => {
  it("passes the configured classifier model to the Slack service, defaulting to Claude Haiku 4.5", () => {
    const template = Template.fromStack(new SlackOrchestratorStack(new App(), "TestSlackOrchestratorGate", { env: { region: "us-east-1" } }));
    template.hasParameter("GateClassifierModelId", { Type: "String", Default: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([{ Name: "AGENTX_GATE_CLASSIFIER_MODEL", Value: { Ref: "GateClassifierModelId" } }]),
      })],
    });
  });
});
