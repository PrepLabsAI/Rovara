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
  AGENTX_BETA_BUILD_ROLE_NAME,
  AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME,
  AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME,
  AGENTX_BETA_RELEASE_PROJECT_NAME,
  AGENTX_BETA_RELEASE_ROLE_NAME,
  AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME,
  AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME,
  MODEL_GATEWAY_LAST_GOOD_PARAMETER,
  PROMOTION_GATE_REASON,
  PIPELINE_MODE_NOTE,
  CODE_HISTORY_PARAMETER,
  betaModelGatewayPullPolicy,
  rollbackReleaseChecks,
  ROLLBACK_TARGET_CHECK,
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { BetaDomainStack } from "../../infra/lib/beta-domain.js";
import { BetaReleaseAccessStack } from "../../infra/lib/beta-release-access.js";
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

  it("keeps the due-time indexes of the retired workflow engine's rows but runs no recovery schedule for them (D1)", () => {
    // D1 deleted the three one-minute schedules of the old workflow engine (GitHub webhook recovery, workflow merge recovery, workflow dispatch recovery) and their two roles. The indexes are
    // kept (a GSI delete is its own later lane): the rows they list are the old engine's, which nothing reads now.
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: "github-webhook-recovery",
        KeySchema: [{ AttributeName: "webhookRecoveryPk", KeyType: "HASH" }, { AttributeName: "webhookRecoverySk", KeyType: "RANGE" }],
      }), Match.objectLike({
        IndexName: "workflow-dispatch-due",
        KeySchema: [{ AttributeName: "dispatchDuePk", KeyType: "HASH" }, { AttributeName: "dispatchDueSk", KeyType: "RANGE" }],
      })]),
    });
    const retiredSources = ["agentx.github-webhook-recovery", "agentx.workflow-merge-recovery", "agentx.workflow-dispatch-recovery"];
    for (const [, schedule] of Object.entries(template.findResources("AWS::Scheduler::Schedule"))) {
      for (const source of retiredSources) expect(JSON.stringify((schedule as { Properties: { Target?: unknown } }).Properties.Target)).not.toContain(source);
    }
    const retiredRoles = Object.keys(template.findResources("AWS::IAM::Role")).filter((id) => id.startsWith("GithubWebhookRecoveryRole") || id.startsWith("WorkflowDispatchRecoveryRole"));
    expect(retiredRoles).toEqual([]);
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
    // reaper (#85) and reconciler (#86), and the channel API and its event sender
    // (spec 062 Phase 7d: the built-in Slack adapter), and developer sign-in for account linking (spec 064). #1148: and the core engine's attention email sender
    // (which exists only while CoreAttentionEmail is on). WORKER-DELIVERY-IDENTITY step 0: and the EC2 instance state-change handler. CANARY-SESSION: and the beta canary person's session function (declared in the template under its condition; see canary-session-infrastructure.test.ts).
    template.resourceCountIs("AWS::Lambda::Function", 14);
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

    // One per Lambda, plus the EC2 session provisioner's and deleter's (#83). #1148: the attention email sender's too. Code train 23: the HTTP API's access log group. WORKER-DELIVERY-IDENTITY step 0: the instance state-change handler's.
    template.resourceCountIs("AWS::Logs::LogGroup", 17);
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
  interface PipelineAction {
    Name: string;
    RunOrder: number;
    Namespace?: string;
    Configuration: Record<string, unknown>;
    InputArtifacts: Array<{ Name: string }>;
    OutputArtifacts: Array<{ Name: string }>;
  }
  interface PipelineProperties {
    Stages: Array<{ Name: string; Actions: PipelineAction[] }>;
    Variables: Array<{ Name: string; DefaultValue: string; Description: string }>;
  }
  /** An action's environment variables; a value that holds a template reference reads `<Ref Name>` (the CDK renders such a list as a join). */
  const actionVariables = (action: PipelineAction): Record<string, { value: string; type: string }> => {
    const raw = action.Configuration.EnvironmentVariables as string | { "Fn::Join": [string, unknown[]] };
    const text = typeof raw === "string" ? raw : raw["Fn::Join"][1].map((part) => (typeof part === "string" ? part : `<Ref ${(part as { Ref: string }).Ref}>`)).join("");
    return Object.fromEntries((JSON.parse(text) as Array<{ name: string; value: string; type: string }>).map((variable) => [variable.name, variable]));
  };
  const pipelineProperties = (): PipelineProperties =>
    (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: PipelineProperties }).Properties;
  const stagePlan = (): string[] =>
    pipelineProperties().Stages.map((stage) => `${stage.Name}:${stage.Actions.map((action) => `${action.RunOrder}:${action.Name}`).join(",")}`);

  it("starts a Code-only V2 pipeline for filtered mainline pushes, with beta first and production behind a disabled transition and its own approval", () => {
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      PipelineType: "V2",
      ExecutionMode: "SUPERSEDED",
      DisableInboundStageTransitions: [{ StageName: "Production", Reason: PROMOTION_GATE_REASON }],
      Triggers: [
        {
          ProviderType: "CodeStarSourceConnection",
          GitConfiguration: {
            SourceActionName: "GitHub",
            Push: [{
              Branches: { Includes: ["mainline"] },
              FilePaths: { Includes: [...AGENTX_RELEASE_TRIGGER_PATHS] },
            }],
          },
        },
      ],
      Stages: Match.arrayWith([Match.objectLike({
        Name: "Source",
        Actions: [
          Match.objectLike({
            Name: "GitHub",
            Namespace: "CodeSource",
            Configuration: {
              ConnectionArn: { Ref: "GitHubConnectionArn" },
              FullRepositoryId: "PrepLabsAI/Rovara",
              BranchName: "mainline",
              OutputArtifactFormat: "CODEBUILD_CLONE_REF",
            },
          }),
        ],
      })]),
    });
    template.resourceCountIs("AWS::KMS::Key", 0);
    expect(stagePlan()).toEqual([
      "Source:1:GitHub",
      "Beta:1:CodePreflight,2:ModelGatewayImage,3:ModelGatewayDeploy,4:ModelGatewayCheck,5:ReleaseBeta",
      "Production:1:CodePreflight,2:ApproveProduction,3:ModelGatewayImage,4:ModelGatewayDeploy,5:ModelGatewayCheck,6:ReleaseProduction",
    ]);
  });

  it("puts CodePreflight first, then Code's model gateway steps before the Code release in strict run order", () => {
    const stages = pipelineProperties().Stages;
    for (const [name, release, preflightProject] of [["Beta", "ReleaseBeta", AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME], ["Production", "ReleaseProduction", AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME]] as const) {
      const stage = stages.find((candidate) => candidate.Name === name)!;
      const orders = stage.Actions.map((action) => action.RunOrder);
      expect(new Set(orders).size, `${name}: no two actions may share a run order`).toBe(orders.length);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      const names = stage.Actions.map((action) => action.Name).filter((actionName) => actionName !== "ApproveProduction");
      expect(stage.Actions.map((action) => action.Name).slice(0, 2)).toEqual(name === "Production" ? ["CodePreflight", "ApproveProduction"] : ["CodePreflight", "ModelGatewayImage"]);
      expect(names).toEqual(["CodePreflight", "ModelGatewayImage", "ModelGatewayDeploy", "ModelGatewayCheck", release]);
      expect(JSON.stringify(stage.Actions.find((action) => action.Name === "CodePreflight")!.Configuration.ProjectName)).toContain(`${name}CodePreflight`);
      template.hasResourceProperties("AWS::CodeBuild::Project", { Name: preflightProject });
    }
  });

  it("declares the four Code-only V2 variables with defaults so a mainline push can start a run", () => {
    const variables = pipelineProperties().Variables;
    expect(variables.map((variable) => [variable.Name, variable.DefaultValue])).toEqual([
      ["CODE_RELEASE", "run"],
      ["PIPELINE_MODE", "release"],
      ["CODE_ROLLBACK_TARGET", "none"],
      ["MODEL_GATEWAY_DIGEST", "none"],
    ]);
    expect(variables[1]!.Description).toContain("adopt");
    expect(variables[1]!.Description).toContain("rollback");
    expect(variables[2]!.Description).toContain("must be in the stage release history");
    expect(variables[3]!.Description).toContain("MODEL_GATEWAY_DIGEST".length > 0 ? "sha256" : "");
  });

  it("runs Code's model gateway steps in Code-owned CodeBuild projects with no Cloud parameters or Cloud projects", () => {
    for (const name of [AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME, AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME, AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME]) {
      expect(name).toMatch(/^release-/u);
      expect(name).not.toMatch(/^agentx-/iu);
    }
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME });
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME,
      Environment: {
        EnvironmentVariables: Match.arrayWith([
          { Name: "GATEWAY_STAGE_ENV", Type: "PLAINTEXT", Value: "beta" },
          { Name: "ROVARA_EXPECTED_DEPLOY_ACCOUNT", Type: "PLAINTEXT", Value: { Ref: "BetaAccountId" } },
        ]),
      },
    });
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME,
      Environment: {
        EnvironmentVariables: Match.arrayWith([
          { Name: "GATEWAY_STAGE_ENV", Type: "PLAINTEXT", Value: "production" },
          { Name: "ROVARA_EXPECTED_DEPLOY_ACCOUNT", Type: "PLAINTEXT", Value: { Ref: "AWS::AccountId" } },
        ]),
      },
    });
    const expectedSteps = [
      ["ModelGatewayImage", "image", "Image"],
      ["ModelGatewayDeploy", "deploy", "Deploy"],
      ["ModelGatewayCheck", "check", "Check"],
    ] as const;
    let previousState: string | undefined;
    for (const [stageName, , prefix] of [["Beta", "beta", "GatewayBeta"], ["Production", "production", "GatewayProd"]] as const) {
      const stageActions = pipelineProperties().Stages.find((stage) => stage.Name === stageName)!.Actions;
      for (const [name, step, suffix] of expectedSteps) {
        const action = stageActions.find((a) => a.Name === name)!;
        const inputs = action.InputArtifacts.map((artifact) => artifact.Name);
        expect(inputs[0], `${stageName} ${name}`).toBe("Source");
        expect(inputs[1], `${stageName} ${name}`).toBe(previousState);
        if (inputs.length > 1) expect(action.Configuration.PrimarySource, `${stageName} ${name}`).toBe("Source");
        expect(action.OutputArtifacts.map((artifact) => artifact.Name), `${stageName} ${name}`).toEqual([`${prefix}${suffix}`]);
        const variables = actionVariables(action);
        expect(variables.GATEWAY_STAGE_STEP?.value).toBe(step);
        expect(variables.PIPELINE_STATE_ARTIFACT?.value).toBe(previousState);
        expect(variables.CODE_RELEASE?.value).toBe("#{variables.CODE_RELEASE}");
        expect(variables.PIPELINE_MODE?.value).toBe("#{variables.PIPELINE_MODE}");
        expect(variables.CODE_ROLLBACK_TARGET?.value).toBe("#{variables.CODE_ROLLBACK_TARGET}");
        expect(variables.MODEL_GATEWAY_DIGEST?.value).toBe("#{variables.MODEL_GATEWAY_DIGEST}");
        expect(variables.EXEC_ID?.value).toBe("#{codepipeline.PipelineExecutionId}");
        expect(variables.CODE_SHA?.value).toBe("#{CodeSource.CommitId}");
        expect(variables.CODE_LIVE_SHA?.value).toBe(`#{${stageName}CodePreflight.CODE_LIVE_SHA}`);
        previousState = `${prefix}${suffix}`;
      }
    }
    const prodImage = pipelineProperties().Stages.find((stage) => stage.Name === "Production")!.Actions.find((action) => action.Name === "ModelGatewayImage")!;
    expect(prodImage.InputArtifacts.map((artifact) => artifact.Name)).toEqual(["Source", "GatewayBetaCheck"]);
    const pullPolicy = betaModelGatewayPullPolicy("arn:aws:iam::123456789012:role/agentx-release-model-gateway-production-build");
    expect(pullPolicy.Statement[0]).toMatchObject({ Effect: "Allow", Principal: { AWS: "arn:aws:iam::123456789012:role/agentx-release-model-gateway-production-build" } });
  });

  it("exposes no adoption override: PIPELINE_MODE is the only switch and nothing named ROVARA_ADOPT_* exists", () => {
    const names = [
      ...pipelineProperties().Variables.map((variable) => variable.Name),
      ...pipelineProperties().Stages.flatMap((stage) => stage.Actions).flatMap((action) =>
        action.Configuration.EnvironmentVariables === undefined ? [] : Object.keys(actionVariables(action))),
    ];
    expect(names.filter((name) => /ROVARA_ADOPT|ADOPT_DEPLOYED/iu.test(name))).toEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/ROVARA_ADOPT/u);
    for (const stageName of ["Beta", "Production"]) {
      const preflight = pipelineProperties().Stages.find((stage) => stage.Name === stageName)!.Actions.find((action) => action.Name === "CodePreflight")!;
      expect(actionVariables(preflight).PIPELINE_MODE?.value).toBe("#{variables.PIPELINE_MODE}");
    }
    for (const name of [AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME]) {
      const spec = preflightSpec(name);
      expect(spec.env.variables.PIPELINE_MODE).toBe("release");
      expect(spec.phases.pre_build!.commands).toEqual([PIPELINE_MODE_NOTE, ROLLBACK_TARGET_CHECK]);
    }
  });

  it("exports CODE_LIVE_SHA from each stage's CodePreflight and keeps rollback and pipeline rights narrow", () => {
    const stage = (name: string) => pipelineProperties().Stages.find((candidate) => candidate.Name === name)!;
    for (const [stageName, namespace, beta] of [["Beta", "BetaCodePreflight", true], ["Production", "ProductionCodePreflight", false]] as const) {
      const preflight = stage(stageName).Actions.find((action) => action.Name === "CodePreflight")!;
      expect(preflight.Namespace).toBe(namespace);
      expect(actionVariables(preflight).CODE_ROLLBACK_TARGET?.value).toBe("#{variables.CODE_ROLLBACK_TARGET}");
      expect(actionVariables(preflight).EXEC_ID?.value).toBe(beta ? "#{codepipeline.PipelineExecutionId}" : undefined);
      const spec = preflightSpec(beta ? AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME : AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME) as unknown as { env: { variables: Record<string, string>; "exported-variables": string[] } };
      expect(spec.env["exported-variables"]).toEqual(["CODE_LIVE_SHA"]);
      expect(spec.env.variables.CODE_ROLLBACK_TARGET).toBe("none");
      expect(preflight.RunOrder).toBe(1);
    }
    for (const [roleMatch, stageName] of [["BetaCodePreflightRole", "beta"], ["ProductionCodePreflightRole", "production"]] as const) {
      const history = policyOf(roleMatch).find((statement) => statement.Sid === "ReadCodeHistory");
      expect(history?.Action).toEqual("ssm:GetParameter");
      expect(JSON.stringify(history?.Resource)).toContain(`parameter/agentx/release/code-history/${stageName}`);
    }
    expect(policyOf("BetaCodePreflightRole").find((statement) => statement.Sid === "ReadWaitingRun")?.Action).toEqual(["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution"]);
    expect(policyOf("ProductionCodePreflightRole").flatMap(actionsOf)).not.toContain("codepipeline:GetPipelineState");
    for (const roleMatch of ["ReleaseBuildRole", "BetaReleaseBuildRole", "BetaModelGatewayBuildRole", "ProductionModelGatewayBuildRole"]) {
      expect(policyOf(roleMatch).flatMap(actionsOf).filter((action) => action.startsWith("codepipeline:")), roleMatch).toEqual([]);
    }
    // Each gateway build role records only its own stage's model-gateway-last-good parameter.
    for (const [roleMatch, stageName] of [["BetaModelGatewayBuildRole", "beta"], ["ProductionModelGatewayBuildRole", "production"]] as const) {
      const lastGood = policyOf(roleMatch).find((statement) => statement.Sid === "RecordModelGatewayLastGood");
      expect(lastGood?.Action).toEqual(["ssm:GetParameter", "ssm:PutParameter"]);
      expect(JSON.stringify(lastGood?.Resource)).toContain(`parameter${MODEL_GATEWAY_LAST_GOOD_PARAMETER[stageName]}`);
    }
  });

  it("hands CODE_RELEASE directly from pipeline variables to ReleaseBeta and ReleaseProduction and keeps private values out of the template", () => {
    for (const [stageName, actionName] of [["Beta", "ReleaseBeta"], ["Production", "ReleaseProduction"]] as const) {
      const action = pipelineProperties().Stages.find((stage) => stage.Name === stageName)!.Actions.find((candidate) => candidate.Name === actionName)!;
      const variables = JSON.parse(String(action.Configuration.EnvironmentVariables)) as Array<{ name: string; value: string }>;
      expect(variables).toEqual([
        { name: "CODE_RELEASE", value: "#{variables.CODE_RELEASE}", type: "PLAINTEXT" },
        { name: "PIPELINE_MODE", value: "#{variables.PIPELINE_MODE}", type: "PLAINTEXT" },
        { name: "CODE_ROLLBACK_TARGET", value: "#{variables.CODE_ROLLBACK_TARGET}", type: "PLAINTEXT" },
      ]);
      expect(action.InputArtifacts.map((artifact) => artifact.Name)).toEqual(["Source"]);
    }
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toMatch(/\b[0-9]{12}\b|execute-api|rovara\.dev/u);
  });

  it("gives the transition into Production a reason CodePipeline accepts", () => {
    // CodePipeline refuses any other character in a transition's reason (DisableStageTransition), and the release passes the same text.
    expect(PROMOTION_GATE_REASON).toMatch(/^[a-zA-Z0-9!@ ().*?-]{1,300}$/u);
  });

  const projects = Object.values(template.findResources("AWS::CodeBuild::Project")) as Array<{
    Properties: { Name: string; Source: { BuildSpec: unknown }; ServiceRole: unknown };
  }>;
  /** A build spec as text; the beta one is a join around the beta account parameter. */
  const buildSpecOf = (name: string): string => {
    const spec = projects.find((project) => project.Properties.Name === name)?.Properties.Source.BuildSpec;
    if (typeof spec === "string") return spec;
    const parts = (spec as { "Fn::Join"?: [string, unknown[]] } | undefined)?.["Fn::Join"]?.[1] ?? [];
    return parts.map((part) => (typeof part === "string" ? part : "<token>")).join("");
  };

  const preflightSpec = (name: string) => JSON.parse(buildSpecOf(name)) as { env: { variables: Record<string, string> }; phases: Record<string, { commands: string[] }> };
  const GATE_COMMAND = `aws codepipeline disable-stage-transition --pipeline-name AgentXProductionRelease --stage-name Production --transition-type Inbound --reason "${PROMOTION_GATE_REASON}"`;
  const policyOf = (roleMatch: string) => (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{ Properties: { Roles: unknown; PolicyDocument: { Statement: Statement[] } } }>)
    .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleMatch)).flatMap((policy) => policy.Properties.PolicyDocument.Statement);

  it("closes the gate as the FIRST command of the production Code Preflight, before anything is installed, so one promotion lets in one commit", () => {
    const spec = preflightSpec(AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME);
    expect(spec.phases.install!.commands[0]).toBe(GATE_COMMAND);
    expect(spec.phases.install!.commands.indexOf(GATE_COMMAND)).toBeLessThan(spec.phases.install!.commands.findIndex((command) => command.startsWith("node_version=")));
    // Beta's Preflight never closes it, and neither release project does any more.
    for (const name of [AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, AGENTX_RELEASE_PROJECT_NAME, AGENTX_BETA_RELEASE_PROJECT_NAME]) expect(buildSpecOf(name), name).not.toContain("disable-stage-transition");
    expect(buildSpecOf(AGENTX_RELEASE_PROJECT_NAME)).not.toContain("--profile");
    // The right moved with the command: only the production Preflight's role may close the transition.
    expect(policyOf("ProductionCodePreflightRole").find((statement) => statement.Sid === "ClosePromotionGate")?.Action).toEqual("codepipeline:DisableStageTransition");
    for (const roleMatch of ["BetaCodePreflightRole", "ReleaseBuildRole", "BetaReleaseBuildRole"]) {
      expect(policyOf(roleMatch).flatMap(actionsOf), roleMatch).not.toContain("codepipeline:DisableStageTransition");
    }
  });

  it("runs the port guard with the private name list in both Code Preflights, whatever the CI proof or CODE_RELEASE say, from the previously released commit (L14 review a to d, L1 review R4)", () => {
    template.hasParameter("PortGuardNamesParameterName", { Type: "String" });
    template.hasParameter("PortGuardNamesKeyArn", { Type: "String", AllowedPattern: Match.stringLikeRegexp("kms") });
    for (const name of [AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME]) {
      const spec = preflightSpec(name);
      // Only the parameter's NAME reaches the build, as a plain variable; the value is fetched inside the step.
      expect(Object.keys(spec.env.variables)).toContain("PORT_GUARD_NAMES_PARAMETER");
      // L9b's additions (CODE_LIVE_SHA and the waiting run for the Cloud actions, the rollback checks and range) are asserted in release-pipeline-l9b-rollback.test.ts;
      // the L1 commands are asserted here as they were.
      // PIPELINE-CODE-RELEASE-BY-TRIGGER's commands (Beta only) are asserted in release-pipeline-code-release-by-trigger.test.ts.
      const isL9b = (command: string): boolean =>
        /^(SUPERSEDES_EXEC=|export CODE_LIVE_SHA=|WAITING_EXEC=|if \[\[ "\$WAITING_EXEC")/u.test(command) || command.startsWith('[ "$CODE_ROLLBACK_TARGET" = none ] ||');
      const build = spec.phases.build!.commands.filter((command) => !isL9b(command));
      // (a) never from the code being released: a detached worktree of the PREVIOUSLY RELEASED commit (read from this stage's record) runs the guard over released..commit,
      // so an edit of the guard, anywhere in the landing, is judged by the old guard. R4: the checks that refuse come first.
      const parameter = name === AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME ? "/agentx/release/code-released/beta" : "/agentx/release/code-released/production";
      expect(build[0]).toBe(`RELEASED_SHA="$(aws ssm get-parameter --name ${parameter} --query Parameter.Value --output text)" || { echo "port-guard: the last released Code commit could not be read; refusing to run the release" >&2; exit 2; }`);
      expect(build.slice(1, 6).every((command) => command.endsWith("exit 2; }"))).toBe(true);
      expect(build.slice(1, 6).map((command) => command.split(" ||")[0])).toEqual([
        '[[ "$RELEASED_SHA" =~ ^[0-9a-f]{40}$ ]]',
        'git cat-file -e "$RELEASED_SHA^{commit}"',
        'git merge-base --is-ancestor "$RELEASED_SHA" HEAD',
        '[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ]',
        '[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ]',
      ]);
      expect(build[4]).toContain("-le 3");
      expect(build[4]).toContain("octopus merge");
      expect(build[5]).toContain("not merged as one change");
      expect(build.slice(6)).toEqual([
        "git update-ref refs/heads/release-tip HEAD",
        'git worktree add --detach /tmp/port-guard-trusted "$RELEASED_SHA"',
        "cd /tmp/port-guard-trusted",
        "set +x",
        'test -n "$PORT_GUARD_NAMES_PARAMETER" || { echo "port-guard: PORT_GUARD_NAMES_PARAMETER is not set; refusing to run without the private name list" >&2; exit 2; }',
        "node scripts/port-guard-pipeline.ts --range HEAD..release-tip --allow-guard-edits",
      ]);
      // (d) unconditional: no CI proof, no --skip-checks, no CODE_RELEASE test anywhere in the project.
      const text = buildSpecOf(name);
      expect(text).not.toMatch(/release-ci-proof|skip-checks|CODE_RELEASE|RELEASE_CHECKS/u);
      // The tools the guard needs are installed before it runs.
      expect(spec.phases.install!.commands.join("\n")).toContain("gitleaks");
    }
    // (c) the read grant: that one parameter, and decrypt with that one key through SSM, on both Preflight roles; nothing else secret.
    for (const roleMatch of ["BetaCodePreflightRole", "ProductionCodePreflightRole"]) {
      const statements = policyOf(roleMatch);
      const read = statements.find((statement) => statement.Sid === "ReadPortGuardNames");
      expect(read?.Action).toEqual("ssm:GetParameter");
      expect(JSON.stringify(read?.Resource)).toContain('{"Ref":"PortGuardNamesParameterName"}');
      const decrypt = statements.find((statement) => statement.Sid === "DecryptPortGuardNames");
      expect(decrypt?.Action).toEqual("kms:Decrypt");
      expect(decrypt?.Resource).toEqual({ Ref: "PortGuardNamesKeyArn" });
      expect(JSON.stringify(decrypt)).toContain("kms:ViaService");
      // Plus the record of the last released Code commit (R4), read-only and only this stage's.
      // Plus this stage's release history (L9b), read-only.
      expect(statements.flatMap(actionsOf).filter((action) => /secretsmanager|ssm:|kms:/u.test(action)).sort()).toEqual(["kms:Decrypt", "ssm:GetParameter", "ssm:GetParameter", "ssm:GetParameter"]);
      const record = statements.find((statement) => statement.Sid === "ReadReleasedCode");
      expect(record?.Action).toEqual("ssm:GetParameter");
      expect(JSON.stringify(record?.Resource)).toContain(roleMatch.startsWith("Beta") ? "parameter/agentx/release/code-released/beta" : "parameter/agentx/release/code-released/production");
    }
    // The release builds write that record, only theirs, and only that right.
    for (const [roleMatch, stage] of [["BetaReleaseBuildRole", "beta"], ['"ReleaseBuildRole', "production"]] as const) {
      const record = policyOf(roleMatch).find((statement) => statement.Sid === "RecordReleasedCode");
      expect(record?.Action).toEqual("ssm:PutParameter");
      expect(JSON.stringify(record?.Resource)).toContain(`parameter/agentx/release/code-released/${stage}`);
      // Plus the stage's release history, written by the same step (L9b): read to prepend, then written; nothing else of SSM.
      const history = policyOf(roleMatch).find((statement) => statement.Sid === "RecordCodeHistory");
      expect(history?.Action).toEqual(["ssm:GetParameter", "ssm:PutParameter"]);
      expect(JSON.stringify(history?.Resource)).toContain(`parameter/agentx/release/code-history/${stage}`);
      expect(policyOf(roleMatch).flatMap(actionsOf).filter((action) => action.startsWith("ssm:")).sort()).toEqual(["ssm:GetParameter", "ssm:PutParameter", "ssm:PutParameter"]);
    }
  });

  it("skips every Code step when CODE_RELEASE=skip or PIPELINE_MODE=adopt, refuses any other CODE_RELEASE value, and still leaves the manifest file", () => {
    for (const name of [AGENTX_RELEASE_PROJECT_NAME, AGENTX_BETA_RELEASE_PROJECT_NAME]) {
      const buildSpec = JSON.parse(buildSpecOf(name)) as { env: { variables: Record<string, string> }; phases: Record<string, { commands: string[] }> };
      expect(buildSpec.env.variables.CODE_RELEASE).toBe("run");
      const install = buildSpec.phases.install!.commands;
      expect(install[0]).toBe('case "$CODE_RELEASE" in run|skip) ;; *) echo "CODE_RELEASE must be run or skip, got: $CODE_RELEASE" >&2; exit 1;; esac');
      for (const command of install.slice(3).filter((command) => !Object.values(CODE_HISTORY_PARAMETER).flatMap(rollbackReleaseChecks).includes(command))) {
        expect(command, `${name}: ${command}`).toMatch(/^\{ \[ "\$CODE_RELEASE" = skip \] \|\| \[ "\$PIPELINE_MODE" = adopt \]; \} \|\| \{ .* \}$/u);
      }
      expect(buildSpec.phases.pre_build!.commands).toEqual(['{ [ "$CODE_RELEASE" = skip ] || [ "$PIPELINE_MODE" = adopt ]; } || { npm ci; }']);
      const build = buildSpec.phases.build!.commands;
      expect(build).toHaveLength(1);
      expect(build[0]).toMatch(/^if \{ \[ "\$CODE_RELEASE" = skip \] \|\| \[ "\$PIPELINE_MODE" = adopt \]; \}; then mkdir -p cdk\.out && printf '\{"codeRelease":"skip"\}\\n' > cdk\.out\/agentx-production-release\.json; else if node scripts\/release-ci-proof\.ts /u);
      expect(build[0]).toMatch(/npm run release:prod -- .*; fi$/u);
      expect(build[0]!.indexOf("release-ci-proof")).toBeLessThan(build[0]!.indexOf("npm run release:prod"));
    }
  });

  it("runs the beta release in the beta account, as its release role, after CI's proof in this account", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_BETA_RELEASE_PROJECT_NAME,
      ConcurrentBuildLimit: 1,
      TimeoutInMinutes: 120,
      Environment: Match.objectLike({ Type: "ARM_CONTAINER", ComputeType: "BUILD_GENERAL1_LARGE", PrivilegedMode: true }),
    });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: AGENTX_BETA_BUILD_ROLE_NAME });
    template.hasParameter("BetaAccountId", { Type: "String", AllowedPattern: "^[0-9]{12}$" });
    const buildSpec = buildSpecOf(AGENTX_BETA_RELEASE_PROJECT_NAME);
    expect(buildSpec).not.toContain("disable-stage-transition");
    const proof = buildSpec.indexOf("node scripts/release-ci-proof.ts");
    const profile = buildSpec.indexOf("[profile agentx-beta]");
    expect(proof).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(proof);
    expect(buildSpec).toContain("credential_source = EcsContainer");
    expect(buildSpec).toContain(`:role/${AGENTX_BETA_RELEASE_ROLE_NAME}`);
    expect(buildSpec).toContain('npm run release:prod -- --region \\"$AWS_REGION\\" --profile agentx-beta --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS');
    expect(buildSpec.match(/--skip-checks/gu)).toHaveLength(1);
    expect(buildSpec).not.toMatch(/--allow-dirty/);
    // The beta build's own rights: CI's proof here, and the beta account's release role; nothing that deploys in this account.
    const betaPolicy = Object.values(template.findResources("AWS::IAM::Policy")).find((policy) =>
      JSON.stringify((policy as { Properties: { Roles: unknown } }).Properties.Roles).includes("BetaReleaseBuildRole")) as
      { Properties: { PolicyDocument: { Statement: Statement[] } } } | undefined;
    const sids = (betaPolicy?.Properties.PolicyDocument.Statement ?? []).map((statement) => statement.Sid).filter(Boolean);
    expect(sids).toEqual(expect.arrayContaining(["ReadGithubAppKeyForCiProof", "ReadReleaseStacks", "AssumeBetaReleaseRole"]));
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
    expect(AGENTX_BETA_RELEASE_PROJECT_NAME).not.toMatch(/^agentx-/i);
  });

  it("grants no wildcard actions and scopes release and model gateway permissions to their own resources", () => {
    const json = JSON.stringify(template.toJSON());
    const actions = statements.flatMap(actionsOf);
    expect(actions.filter((action) => action === "*" || action.endsWith(":*"))).toEqual([]);
    // Only actions that AWS IAM requires Resource "*" on (plus ECS service/task reads conditioned on ecs:cluster).
    expect(
      statements.filter((statement) => statement.Resource === "*").flatMap(actionsOf).sort(),
    ).toEqual([
      "ecr:GetAuthorizationToken",
      "ecr:GetAuthorizationToken",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListServices",
      "ecs:ListTasks",
    ]);
    const assume = statements.find((statement) => statement.Sid === "AssumeCdkBootstrapRoles");
    expect(JSON.stringify(assume?.Resource)).toContain(":role/cdk-hnb659fds-*-");
    const repository = statements.find((statement) => statement.Sid === "ProductionWorkerRepository");
    expect(JSON.stringify(repository?.Resource)).toContain("repository/agentx-worker-production");
    expect(JSON.stringify(repository?.Resource)).toContain("repository/agentx-slack-orchestrator");
    expect(actionsOf(repository!)).not.toContain("ecr:CreateRepository");
    const gatewayPull = statements.find((statement) => statement.Sid === "PullBetaModelGatewayImage");
    expect(JSON.stringify(gatewayPull?.Resource)).toContain("repository/rovara-cloud-beta-gateway-images-*");
    expect(actionsOf(gatewayPull!).sort()).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"]);
    const gatewayRepo = statements.find((statement) => statement.Sid === "ProductionModelGatewayRepository");
    expect(JSON.stringify(gatewayRepo?.Resource)).toContain("repository/rovara-cloud-production-gateway-images-*");
    expect(actionsOf(gatewayRepo!)).not.toContain("ecr:BatchDeleteImage");
    const stacks = statements.find((statement) => statement.Sid === "ReadReleaseStacks");
    expect(JSON.stringify(stacks?.Resource)).toContain("stack/AgentXSlackOrchestrator/*");
    expect(json).toContain("codeconnections:UseConnection");
    expect(json).not.toMatch(/bedrock-[a-z]+:/);
    expect(actions).not.toContain("cloudformation:CreateStack");
  });
});

describe("beta release access (#1242, #1578)", () => {
  const template = Template.fromStack(new BetaReleaseAccessStack(new App(), "TestBetaReleaseAccess", { env: { region: "us-east-1" } }));
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: unknown }> } };
  }>).flatMap((policy) => policy.Properties.PolicyDocument.Statement);

  it("trusts only the release account's beta Code build role and beta model gateway build role", () => {
    template.hasParameter("ReleaseAccountId", { Type: "String", AllowedPattern: "^[0-9]{12}$" });
    const [role] = Object.values(template.findResources("AWS::IAM::Role")) as Array<{
      Properties: { RoleName: string; AssumeRolePolicyDocument: { Statement: Array<{ Principal: unknown; Condition: unknown }> } };
    }>;
    expect(role?.Properties.RoleName).toBe(AGENTX_BETA_RELEASE_ROLE_NAME);
    expect(role?.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    const trust = JSON.stringify(role?.Properties.AssumeRolePolicyDocument.Statement[0]);
    expect(trust).toContain('"ArnEquals":{"aws:PrincipalArn"');
    expect(trust).toContain(`:role/${AGENTX_BETA_BUILD_ROLE_NAME}`);
    expect(trust).toContain(`:role/${AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME}`);
    expect(trust).toContain('{"Ref":"ReleaseAccountId"}');
  });

  it("has scoped Code release and beta model gateway rights in its own account and nothing more", () => {
    expect(statements.map((statement) => statement.Sid)).toEqual([
      "AssumeCdkBootstrapRoles",
      "EcrAuthorization",
      "ReleaseImageRepositories",
      "ReadReleaseStacks",
      "BetaModelGatewayRepository",
      "BetaModelGatewayServiceReads",
      "BetaModelGatewayTaskDefinitionRead",
      "BetaModelGatewayPriceFetchLogs",
      "BetaModelGatewayCertificateRead",
    ]);
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    expect(actions.filter((action) => action === "*" || action.endsWith(":*"))).toEqual([]);
    expect(statements.filter((statement) => statement.Resource === "*").flatMap((statement) => [statement.Action].flat()).sort()).toEqual([
      "ecr:GetAuthorizationToken",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListServices",
      "ecs:ListTasks",
    ]);
    expect(actions).not.toContain("secretsmanager:GetSecretValue");
    expect(actions).not.toContain("ecr:CreateRepository");
  });
});

describe("beta domain (#1242)", () => {
  const template = Template.fromStack(new BetaDomainStack(new App(), "TestBetaDomain", { env: { region: "us-east-1" } }));

  it("maps the whole beta API, at its one $default stage, onto a regional TLS 1.2 domain with a DNS-validated certificate", () => {
    template.hasParameter("DomainName", { Type: "String" });
    template.hasParameter("ApiId", { Type: "String", AllowedPattern: "^[a-z0-9]{10}$" });
    template.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: { Ref: "DomainName" }, ValidationMethod: "DNS" });
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: { Ref: "DomainName" },
      DomainNameConfigurations: [Match.objectLike({ EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" })],
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", { ApiId: { Ref: "ApiId" }, Stage: "$default" });
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    template.hasOutput("RegionalDomainName", {});
    template.hasOutput("RegionalHostedZoneId", {});
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
    // reaper (#85) and reconciler (#86), and the channel API and its event sender
    // (spec 062 Phase 7d: the built-in Slack adapter), and developer sign-in for account linking (spec 064). #1148: and the core engine's attention email sender
    // (which exists only while CoreAttentionEmail is on). WORKER-DELIVERY-IDENTITY step 0: and the EC2 instance state-change handler. CANARY-SESSION: and the beta canary person's session function (declared in the template under its condition; see canary-session-infrastructure.test.ts).
    template.resourceCountIs("AWS::Lambda::Function", 14);
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
