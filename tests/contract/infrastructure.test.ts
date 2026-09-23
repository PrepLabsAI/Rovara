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
  validateDemoRuntimeConfiguration,
} from "../../infra/lib/demo-runtime.js";
import {
  ProductionFoundationStack,
  defaultProductionAvailabilityZoneIds,
  validateProductionFoundationConfiguration,
} from "../../infra/lib/production-foundation.js";

describe("control-plane infrastructure", () => {
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
    expect(json).toContain("MAX_DISPATCH_ATTEMPTS");
    expect(json).toContain("CALLBACK_SIGNING_KEY");
    expect(json).toContain("ADMIN_CLAIM");
    expect(json).toContain("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
    expect(json).toContain("GITHUB_APP_INSTALLATION_ID");
    expect(json).toContain("secretsmanager:GetSecretValue");
    expect(json.match(/secretsmanager:GetSecretValue/g)).toHaveLength(1);
    expect(json.match(/GITHUB_APP_PRIVATE_KEY_SECRET_ARN/g)).toHaveLength(1);
    expect(json).toContain("codebuild:StartBuild");
    expect(json).toContain("codebuild:BatchGetBuilds");
    expect(json).toContain(":codebuild:");
    expect(json).toContain("project/agentx-*");
  });

  it("retains each Lambda log group for 30 days and removes it with the demo stack", () => {
    const app = new App();
    const stack = new ControlPlaneStack(app, "LoggedControlPlane");
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Logs::LogGroup", 3);
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

describe("AgentCore Instances infrastructure", () => {
  it("synthesizes a retained ARM64 capacity provider in a dedicated two-AZ VPC", () => {
    const app = new App();
    const stack = new ProductionFoundationStack(app, "TestFoundation", {
      deploymentRegion: "us-east-1",
    });
    const template = Template.fromStack(stack);
    const json = JSON.stringify(template.toJSON());

    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::Subnet", 4);
    template.resourceCountIs("AWS::EC2::NatGateway", 2);
    template.resourceCountIs("AWS::EC2::FlowLog", 1);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.resourceCountIs("AWS::BedrockAgentCore::CapacityProvider", 1);
    template.resourceCountIs("AWS::BedrockAgentCore::Runtime", 0);
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "AgentX production workers: no ingress and HTTPS-only egress",
      SecurityGroupEgress: [{
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        CidrIp: "0.0.0.0/0",
        Description: Match.anyValue(),
      }],
    });
    template.hasResourceProperties("AWS::BedrockAgentCore::CapacityProvider", {
      Name: "agentx_production_capacity_v2",
      ComputeConfiguration: {
        Ec2Configuration: Match.objectLike({
          LaunchTemplateSource: {
            LaunchParameters: Match.objectLike({
              OperatingSystem: "LINUX_ARM64",
              InstanceRequirements: { AllowedInstanceTypes: ["m7g.large"] },
            }),
          },
          RootVolume: Match.objectLike({ Encrypted: true, VolumeType: "gp3" }),
          Volumes: [{
            EbsConfiguration: Match.objectLike({
              Name: "workspace",
              SizeGiB: 20,
              VolumeType: "gp3",
              Encrypted: true,
            }),
          }],
        }),
      },
    });
    template.hasResource("AWS::BedrockAgentCore::CapacityProvider", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    expect(json).toContain("BedrockAgentCoreRuntimeInstancesOperatorRolePolicy");
    expect(json).toContain("alias/agentx/production-workspaces");
    expect(json).toContain('"RetentionInDays":30');
  });

  it("synthesizes a separately releasable runtime mounted on the stable capacity provider", () => {
    const app = new App();
    const stack = new AgentRuntimeStack(app, "TestRuntime", {
      deploymentRegion: "us-east-1",
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::BedrockAgentCore::CapacityProvider", 0);
    template.resourceCountIs("AWS::EC2::VPC", 0);
    template.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      AgentRuntimeName: "agentx_production_worker",
      CapacityProviderConfiguration: { CapacityProviderArn: { Ref: "CapacityProviderArn" } },
      FilesystemConfigurations: [{
        CapacityProviderVolume: { VolumeName: "workspace", MountPath: "/mnt/workspace" },
      }],
      LifecycleConfiguration: {
        IdleRuntimeSessionTimeout: 300,
        MaxLifetime: 1_209_600,
      },
      EnvironmentVariables: {
        AGENTX_WORKSPACE_ROOT: "/mnt/workspace",
        AGENTX_CONTROL_PLANE_URL: { Ref: "ControlPlaneUrl" },
        AGENTX_MODEL_PROVIDER: { Ref: "ModelProvider" },
        AGENTX_MODEL_ID: { Ref: "ModelId" },
      },
      NetworkConfiguration: Match.absent(),
    });
    template.hasResource("AWS::BedrockAgentCore::Runtime", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("rejects unsupported regions and invalid lifecycle or AZ settings", () => {
    const base = {
      region: "us-east-1",
      mountPath: "/mnt/workspace",
      runtimeIdleSeconds: 900,
      runtimeMaxLifetimeSeconds: 1_209_600,
    };
    expect(() => validateAgentRuntimeConfiguration({ ...base, region: "eu-north-1" })).toThrow(
      /not supported/i,
    );
    expect(() =>
      validateAgentRuntimeConfiguration({ ...base, runtimeIdleSeconds: 1_000, runtimeMaxLifetimeSeconds: 900 }),
    ).toThrow(/idle/i);

    const foundation = {
      region: "us-east-1",
      availabilityZoneIds: defaultProductionAvailabilityZoneIds("us-east-1"),
      providerIdleSeconds: 300,
      providerMaxLifetimeSeconds: 1_209_600,
      volumeSizeGiB: 20,
      instanceType: "m7g.large",
    };
    expect(validateProductionFoundationConfiguration(foundation)).toEqual(foundation);
    expect(() => validateProductionFoundationConfiguration({
      ...foundation,
      availabilityZoneIds: ["use1-az1", "use1-az1"],
    })).toThrow(/distinct/i);
    expect(() => defaultProductionAvailabilityZoneIds("us-west-2")).toThrow(/no verified/i);
  });
});

describe("AgentCore VPC-free microVM demo infrastructure", () => {
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
