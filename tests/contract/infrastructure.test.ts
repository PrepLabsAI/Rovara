import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import {
  AgentRuntimeStack,
  validateAgentRuntimeConfiguration,
} from "../../infra/lib/agent-runtime.js";
import {
  DemoRuntimeStack,
  selectDemoRuntime,
  validateDemoRuntimeConfiguration,
} from "../../infra/lib/demo-runtime.js";

describe("control-plane infrastructure", () => {
  const binding = { credentialRef: "github-charterarc-demo", account: "PrepLabsAI", appId: "5006456", installationId: "163149623",
    privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:944937319445:secret:new-AbCd12",
    repositories: ["https://github.com/PrepLabsAI/charterarc-integration-demo.git"] };
  const env = { account: "944937319445", region: "us-east-1" };
  it("guards additional references against the actual retained legacy deployment parameter", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "CustomLegacyRef", {
      env, additionalGitHubApps: [{ ...binding, credentialRef: "existing-custom-ref" }],
    })).toJSON() as { Rules?: Record<string, { Assertions: Array<{ Assert: unknown }> }> };
    const assertions = Object.entries(template.Rules ?? {})
      .filter(([name]) => name.startsWith("DistinctAdditionalGitHubCredential"))
      .flatMap(([, rule]) => rule.Assertions);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.Assert).toEqual({ "Fn::Not": [{ "Fn::Equals": [
      { Ref: "GitHubAppCredentialRef" }, "existing-custom-ref",
    ] }] });
    const expression = assertions[0]!.Assert as { "Fn::Not": [{ "Fn::Equals": [{ Ref: string }, string] }] };
    const [parameter, additionalRef] = expression["Fn::Not"][0]["Fn::Equals"];
    const permits = (parameters: Record<string, string>) => parameters[parameter.Ref] !== additionalRef;
    expect(permits({ GitHubAppCredentialRef: "existing-custom-ref" })).toBe(false);
    expect(permits({ GitHubAppCredentialRef: "another-custom-ref" })).toBe(true);
  });
  it("adds only the new broker secret permission and preserves storage identities", () => {
    type Resource = { Type: string; Properties: {
      Environment?: { Variables?: Record<string, string> };
      PolicyDocument?: { Statement: Array<{ Action: string | string[]; Resource: unknown }> };
    } };
    type TemplateDocument = { Resources: Record<string, Resource> };
    const base = Template.fromStack(new ControlPlaneStack(new App(), "SameStack", { env })).toJSON() as TemplateDocument;
    const extra = Template.fromStack(new ControlPlaneStack(new App(), "SameStack", { env, additionalGitHubApps: [binding] })).toJSON() as TemplateDocument;
    expect(JSON.stringify(base)).not.toContain("GITHUB_APP_ADDITIONAL_BINDINGS");
    const resources = extra.Resources;
    const withRegistry = Object.entries(resources).filter(([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.Environment?.Variables?.GITHUB_APP_ADDITIONAL_BINDINGS);
    expect(withRegistry).toHaveLength(1);
    expect(withRegistry[0]![0]).toMatch(/^Broker/);
    const configured = JSON.parse(withRegistry[0]![1].Properties.Environment!.Variables!.GITHUB_APP_ADDITIONAL_BINDINGS!) as Array<{ privateKeySecretArn: string }>;
    expect(configured[0]?.privateKeySecretArn).toBe(binding.privateKeySecretArn);
    const secretPolicies = Object.entries(resources).filter(([, r]) => r.Type === "AWS::IAM::Policy")
      .flatMap(([id, r]) => r.Properties.PolicyDocument!.Statement
        .filter((s: { Action: string | string[] }) => [s.Action].flat().includes("secretsmanager:GetSecretValue"))
        .map((s: { Resource: unknown }) => ({ id, resource: s.Resource })));
    expect(secretPolicies.map((p: { resource: unknown }) => p.resource)).toEqual([
      { Ref: "GitHubAppPrivateKeySecretArn" }, binding.privateKeySecretArn,
    ]);
    expect(secretPolicies.every((p: { id: string }) => p.id.startsWith("Broker"))).toBe(true);
    for (const [id, resource] of Object.entries(resources)) {
      if (["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::SQS::Queue"].includes(resource.Type)) expect(resource).toEqual(base.Resources[id]);
    }
  });
  it.each([
    { account: "000000000000", region: "us-east-1" },
    { account: "944937319445", region: "us-west-2" },
    undefined,
  ])("rejects additional secret bindings without matching concrete deployment identity", (deploymentEnv) => {
    expect(() => new ControlPlaneStack(new App(), "InvalidAccount", { ...(deploymentEnv ? { env: deploymentEnv } : {}), additionalGitHubApps: [binding] })).toThrow();
  });
  it("rejects a registry that exceeds its environment budget", () => {
    const repositories = Array.from({ length: 25 }, (_, i) => `https://github.com/PrepLabsAI/${"long-repository-".repeat(5)}${i}.git`);
    expect(() => new ControlPlaneStack(new App(), "OversizedRegistry", { env, additionalGitHubApps: [{ ...binding, repositories }] })).toThrow(/large|budget/i);
  });
  it("synthesizes private storage, durable dispatch, JWT auth and a single runtime invoker", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "TestControlPlane");
    const template = Template.fromStack(stack).toJSON();
    const json = JSON.stringify(template);

    expect(json).toContain("AWS::DynamoDB::Table");
    expect(json).toContain("AWS::SQS::Queue");
    expect(json).toContain("AWS::S3::Bucket");
    expect(json).toContain("JWT");
    expect(json.match(/bedrock-agentcore:InvokeAgentRuntime/g)).toHaveLength(1);
    Template.fromStack(stack).hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "agentx-control-plane",
      ProtocolType: "HTTP",
    });
  });

  it("packages real handlers with durable environment wiring instead of inline stubs", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "PackagedControlPlane");
    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());

    template.resourceCountIs("AWS::Lambda::Function", 3);
    expect(json).not.toContain("ZipFile");
    expect(json).not.toContain("not packaged");
    expect(json).toContain("STATE_TABLE_NAME");
    expect(json).toContain("ARTIFACT_BUCKET_NAME");
    expect(json).toContain("DISPATCH_QUEUE_URL");
    expect(json).toContain("CALLBACK_SIGNING_KEY");
    expect(json).toContain("ADMIN_CLAIM");
    expect(json).toContain("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
    expect(json).toContain("GITHUB_APP_INSTALLATION_ID");
    expect(json).toContain("secretsmanager:GetSecretValue");
    expect(json.match(/secretsmanager:GetSecretValue/g)).toHaveLength(1);
    expect(json.match(/GITHUB_APP_PRIVATE_KEY_SECRET_ARN/g)).toHaveLength(1);
  });
});

describe("AgentCore Instances infrastructure", () => {
  it("synthesizes an encrypted per-session EBS volume at /mnt/workspace", () => {
    const app = new App();
    const stack = new AgentRuntimeStack(app, "TestRuntime", { deploymentRegion: "us-east-1" });
    const template = Template.fromStack(stack).toJSON();
    const json = JSON.stringify(template);

    expect(json).toContain("AWS::BedrockAgentCore::CapacityProvider");
    expect(json).toContain("AWS::BedrockAgentCore::Runtime");
    expect(json).toContain("/mnt/workspace");
    expect(json).toContain('"Encrypted":true');
    expect(json).toContain('"VolumeName":"workspace"');
  });

  it("rejects unsupported regions and runtime lifetimes beyond their provider", () => {
    const base = {
      region: "us-east-1",
      mountPath: "/mnt/workspace",
      providerIdleSeconds: 900,
      providerMaxLifetimeSeconds: 28_800,
      runtimeIdleSeconds: 900,
      runtimeMaxLifetimeSeconds: 28_800,
      volumeSizeGiB: 100,
    };
    expect(() => validateAgentRuntimeConfiguration({ ...base, region: "eu-north-1" })).toThrow(
      /not supported/i,
    );
    expect(() =>
      validateAgentRuntimeConfiguration({ ...base, runtimeMaxLifetimeSeconds: 28_801 }),
    ).toThrow(/cannot exceed/i);
  });
});

describe("AgentCore VPC-free microVM demo infrastructure", () => {
  it("confines the new Team Tasks worker to its image, model and runtime logs", () => {
    const template = Template.fromStack(new DemoRuntimeStack(new App(), "CharterArcTeamTasksRuntime", {
      deploymentRegion: "us-east-1", runtimeName: "charterarc_team_tasks_worker",
      permissionProfile: "team-tasks",
      env: { account: "944937319445", region: "us-east-1" },
    }));
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "CharterArcTeamTasksRuntimeWorker",
      PermissionsBoundary: "arn:aws:iam::944937319445:policy/CharterArcTeamTasksRuntimeBoundary",
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Condition: {
          StringEquals: { "aws:SourceAccount": "944937319445" },
          ArnLike: { "aws:SourceArn": "arn:aws:bedrock-agentcore:us-east-1:944937319445:runtime/charterarc_team_tasks_worker-*" },
        },
      })], Version: "2012-10-17" },
    });
    type Statement = {Sid:string;Action:string|string[];Resource:unknown};
    const policies = template.findResources("AWS::IAM::Policy") as Record<string, { Properties: { PolicyDocument: { Statement: Statement[] } } }>;
    const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(statements.find(s => s.Sid === "EcrImageAccess")?.Resource).toBe("arn:aws:ecr:us-east-1:944937319445:repository/charterarc-team-tasks-worker");
    expect(statements.find(s => s.Sid === "BedrockModelInvocation")?.Resource).toBe("arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0");
    const logWrites = statements.filter(s => [s.Action].flat().some(a => ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"].includes(a)));
    expect(logWrites.length).toBeGreaterThan(0);
    expect(logWrites.every(s => JSON.stringify(s.Resource).includes("/aws/bedrock-agentcore/runtimes/charterarc_team_tasks_worker-"))).toBe(true);
    expect(statements.some(s => [s.Action].flat().includes("logs:PutResourcePolicy"))).toBe(false);
    template.hasParameter("ModelId", { AllowedValues: ["amazon.nova-pro-v1:0"] });
    template.hasParameter("ModelProvider", { AllowedValues: ["amazon-bedrock"] });
    const document = template.toJSON() as { Parameters: {WorkerImageUri: {AllowedPattern:string}} };
    const imagePattern = document.Parameters.WorkerImageUri.AllowedPattern;
    const acceptsImage = new RegExp(imagePattern);
    expect(acceptsImage.test("944937319445.dkr.ecr.us-east-1.amazonaws.com/charterarc-team-tasks-worker@sha256:" + "a".repeat(64))).toBe(true);
    expect(acceptsImage.test("944937319445.dkr.ecr.us-east-1.amazonaws.com/other@sha256:" + "a".repeat(64))).toBe(false);
  });

  it("rejects a Team Tasks permission profile on an unrelated runtime", () => {
    expect(() => new DemoRuntimeStack(new App(), "WrongRuntime", {
      deploymentRegion: "us-east-1", permissionProfile: "team-tasks",
      env: { account: "944937319445", region: "us-east-1" },
    })).toThrow(/Team Tasks/);
  });

  it("selects the isolated runtime only with explicit demo context", () => {
    expect(selectDemoRuntime("demo-microvm", undefined)).toEqual({ stackId: "AgentXDemoRuntime", runtimeName: "agentx_demo_worker" });
    for (const flag of [true, "true"]) {
      expect(selectDemoRuntime("demo-microvm", flag)).toEqual({ stackId: "CharterArcTeamTasksRuntime", runtimeName: "charterarc_team_tasks_worker" });
      expect(() => selectDemoRuntime("instances-ebs", flag)).toThrow(/demo-microvm/);
    }
    for (const flag of [false, "false", "yes", 1, null, {}]) {
      expect(() => selectDemoRuntime("demo-microvm", flag)).toThrow(/agentxTeamTasksRuntime/);
    }
  });
  it("creates a separate named runtime without changing legacy resource identities", () => {
    const legacy = Template.fromStack(new DemoRuntimeStack(new App(), "AgentXDemoRuntime", { deploymentRegion: "us-east-1" }));
    legacy.hasResourceProperties("AWS::BedrockAgentCore::Runtime", { AgentRuntimeName: "agentx_demo_worker" });
    const separate = Template.fromStack(new DemoRuntimeStack(new App(), "CharterArcTeamTasksRuntime", {
      deploymentRegion: "us-east-1", runtimeName: "charterarc_team_tasks_worker",
    }));
    separate.hasResourceProperties("AWS::BedrockAgentCore::Runtime", { AgentRuntimeName: "charterarc_team_tasks_worker" });
    separate.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    expect(Object.keys(separate.findResources("AWS::BedrockAgentCore::Runtime"))).toEqual(["AgentXDemoRuntime"]);
    expect(Object.keys(legacy.findResources("AWS::BedrockAgentCore::Runtime"))).toEqual(["AgentXDemoRuntime"]);
  });

  it.each(["", "bad-name", "1runtime", "a".repeat(49), "runtime\n"])("rejects invalid runtime name %j before synthesis", (runtimeName) => {
    expect(() => new DemoRuntimeStack(new App(), "Invalid", { deploymentRegion: "us-east-1", runtimeName })).toThrow(/runtime name/i);
  });

  it("uses PUBLIC networking and isolated session storage without a capacity provider", () => {
    const app = new App();
    const stack = new DemoRuntimeStack(app, "TestDemoRuntime", { deploymentRegion: "us-east-1" });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::BedrockAgentCore::CapacityProvider", 0);
    template.resourceCountIs("AWS::EC2::VPC", 0);
    template.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      FilesystemConfigurations: [{ SessionStorage: { MountPath: "/mnt/workspace" } }],
      LifecycleConfiguration: {
        IdleRuntimeSessionTimeout: 900,
        MaxLifetime: 28_800,
      },
      EnvironmentVariables: {
        AGENTX_WORKSPACE_ROOT: "/mnt/workspace",
        AGENTX_CONTROL_PLANE_URL: { Ref: "ControlPlaneUrl" },
        AGENTX_MODEL_PROVIDER: { Ref: "ModelProvider" },
        AGENTX_MODEL_ID: { Ref: "ModelId" },
      },
      CapacityProviderConfiguration: Match.absent(),
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "bedrock-agentcore.amazonaws.com" } }),
        ]),
      }),
    });
    template.hasResource("AWS::BedrockAgentCore::Runtime", {
      DependsOn: Match.arrayWith([Match.stringLikeRegexp("^RuntimeExecutionPolicy")]),
    });
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain("ecr:GetAuthorizationToken");
    expect(json).toContain("bedrock:InvokeModel");
    expect(json).not.toContain("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
    expect(json).not.toContain("GITHUB_APP_ID");
  });

  it("enforces the microVM mount and eight-hour lifecycle ceiling", () => {
    const base = {
      mountPath: "/mnt/workspace",
      idleSeconds: 900,
      maxLifetimeSeconds: 28_800,
    };
    expect(validateDemoRuntimeConfiguration(base)).toEqual(base);
    expect(() =>
      validateDemoRuntimeConfiguration({ ...base, mountPath: "/mnt/shared" }),
    ).toThrow(/workspace/i);
    expect(() =>
      validateDemoRuntimeConfiguration({ ...base, maxLifetimeSeconds: 28_801 }),
    ).toThrow(/28800/i);
    expect(() =>
      validateDemoRuntimeConfiguration({ ...base, idleSeconds: 1_000, maxLifetimeSeconds: 900 }),
    ).toThrow(/idle/i);
  });
});
