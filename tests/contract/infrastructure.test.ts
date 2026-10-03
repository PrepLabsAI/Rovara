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
  ReleasePipelineStack,
} from "../../infra/lib/release-pipeline.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

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

function statementsForRole(template: Template, roleLogicalIdPrefix: string): PolicyStatement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
    Properties: { PolicyDocument: { Statement: PolicyStatement[] }; Roles: Array<{ Ref?: string }> };
  }>)
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith(roleLogicalIdPrefix)))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: PolicyStatement) => [statement.Action].flat();

describe("hosted Slack control-plane infrastructure", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "SlackControlPlane"));

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
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          SLACK_ORCHESTRATOR_ROLE_ARN: { "Fn::GetAtt": [Match.stringLikeRegexp("^SlackOrchestratorTaskRole"), "Arn"] },
          SLACK_MEMBER_WORKSPACE_LIMIT: { Ref: "SlackMemberWorkspaceLimit" },
          SLACK_ORGANIZATION_WORKSPACE_LIMIT: { Ref: "SlackOrganizationWorkspaceLimit" },
        }),
      },
    });
  });

  it("gives the orchestrator role service-route invoke only, and no access to the control-plane state table", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "ecs-tasks.amazonaws.com" } })]),
      }),
    });
    const statements = statementsForRole(template, "SlackOrchestratorTaskRole");
    const invoke = statements.find((statement) => actionsOf(statement).includes("execute-api:Invoke"));
    expect(JSON.stringify(invoke?.Resource)).toContain("/*/*/v1/service/*");
    expect(JSON.stringify(statements)).not.toMatch(/"State[0-9A-F]{8}"/);
    expect(statements.flatMap(actionsOf)).not.toContain("dynamodb:*");
  });

  it("limits the ingress Lambda to reading channel bindings from the state table", () => {
    const statements = statementsForRole(template, "SlackIngress");
    const stateAccess = statements.filter((statement) => JSON.stringify(statement.Resource).match(/"State[0-9A-F]{8}"/));
    expect(stateAccess).toHaveLength(1);
    expect(actionsOf(stateAccess[0]!)).toEqual(["dynamodb:GetItem"]);
    expect(stateAccess[0]?.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SLACK_BINDING#*"] } });
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
  });

  it("allows only outbound HTTPS and pulls only the orchestrator image", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupEgress: [Match.objectLike({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 })],
      SecurityGroupIngress: Match.absent(),
    });
    const statements = policyStatements(template);
    expect(statements.filter((statement) => statement.Resource === "*").flatMap(actionsOf)).toEqual(["ecr:GetAuthorizationToken"]);
    const pull = statements.find((statement) => actionsOf(statement).includes("ecr:BatchGetImage"));
    expect(JSON.stringify(pull?.Resource)).toContain("repository/agentx-slack-orchestrator");
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
    // reaper (#85) and reconciler (#86), and the eval batch tick (spec 052).
    template.resourceCountIs("AWS::Lambda::Function", 8);
    expect(json).not.toContain("ZipFile");
    expect(json).not.toContain("not packaged");
    expect(json).toContain("STATE_TABLE_NAME");
    expect(json).toContain("ARTIFACT_BUCKET_NAME");
    expect(json).toContain("DISPATCH_QUEUE_URL");
    expect(json).toContain("MAX_DISPATCH_ATTEMPTS");
    expect(json).toContain("CALLBACK_SIGNING_KEY");
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

    // One per Lambda, plus the EC2 session provisioner's and deleter's (#83).
    template.resourceCountIs("AWS::Logs::LogGroup", 10);
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
      LaunchTemplateData: Match.objectLike({ InstanceType: "m6g.medium" }),
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
      ["WorkerImageParameter7CA9ADBB", "AWS::SSM::Parameter"],
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
    expect(() => defaultProductionAvailabilityZoneIds("us-west-2")).toThrow(/no verified/i);
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

  it("starts a V2 pipeline only for filtered mainline pushes, with a full Git clone, releasing each merge in turn", () => {
    template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      PipelineType: "V2",
      ExecutionMode: "QUEUED",
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
            FullRepositoryId: "PrepLabsAI/AgentX",
            BranchName: "mainline",
            OutputArtifactFormat: "CODEBUILD_CLONE_REF",
          },
        })],
      })]),
    });
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  it("runs the checked production release on one native ARM Docker build at a time", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: AGENTX_RELEASE_PROJECT_NAME,
      ConcurrentBuildLimit: 1,
      TimeoutInMinutes: 60,
      Environment: Match.objectLike({
        Type: "ARM_CONTAINER",
        ComputeType: "BUILD_GENERAL1_MEDIUM",
        Image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
        PrivilegedMode: true,
      }),
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    const [project] = Object.values(template.findResources("AWS::CodeBuild::Project")) as Array<{
      Properties: { Source: { BuildSpec: string } };
    }>;
    const buildSpec = project?.Properties.Source.BuildSpec ?? "";
    expect(buildSpec).toContain("npm run release:prod");
    expect(buildSpec).toContain("--reuse-unchanged-worker");
    expect(buildSpec).toContain("--require-existing-foundation");
    expect(buildSpec).not.toMatch(/--skip-checks|--allow-dirty/);
    expect(buildSpec).toContain("sha256sum -c");
    expect(buildSpec).toContain("awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip");
  });

  it("keeps the release project outside the broker's CodeBuild gate allow-list", () => {
    expect(AGENTX_RELEASE_PROJECT_NAME).not.toMatch(/^agentx-/i);
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
    // reaper (#85) and reconciler (#86), and the eval batch tick (spec 052).
    template.resourceCountIs("AWS::Lambda::Function", 8);
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
