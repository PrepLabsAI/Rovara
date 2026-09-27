import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_SESSION_STATE_INDEX } from "../../packages/contracts/src/session.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { EC2_WORKER_AMI_PARAMETER, EC2_WORKER_PORT } from "../../infra/lib/ec2-workers.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Template, type: string) => Object.entries(resourcesOf(template)).filter(([, r]) => r.Type === type);
const actionsOf = (statements: Array<{ Action: string | string[] }>) => statements.flatMap((s) => [s.Action].flat());

describe("EC2 worker infrastructure (issue #82)", () => {
  let foundation: Template;
  let controlPlane: Template;
  let runtime: Template;
  let legacy: Template[];

  beforeAll(() => {
    const staging = stacksOf(buildAgentXApp({ agentxEnv: "staging" }));
    const byName = (name: string) => Template.fromStack(staging.find((s) => s.stackName === name)!);
    foundation = byName("agentx-staging-foundation");
    controlPlane = byName("agentx-staging-control-plane");
    runtime = byName("agentx-staging-runtime");
    legacy = stacksOf(buildAgentXApp()).map((stack) => Template.fromStack(stack));
  }, 240_000);

  it("adds nothing to the production deployment before the cutover", () => {
    for (const template of legacy) {
      expect(ofType(template, "AWS::EC2::LaunchTemplate")).toEqual([]);
      expect(ofType(template, "AWS::IAM::InstanceProfile")).toEqual([]);
      expect(ofType(template, "AWS::SSM::Parameter")).toEqual([]);
      expect(JSON.stringify(template.toJSON())).not.toContain(WORKSPACE_SESSION_STATE_INDEX.name);
      expect(JSON.stringify(template.toJSON())).not.toContain("ECC_NIST_P256");
    }
  });

  it("launches arm64 Amazon Linux 2023 m6g.medium with IMDSv2 at one hop and an encrypted root volume", () => {
    const [[, template]] = ofType(foundation, "AWS::EC2::LaunchTemplate") as [[string, Resource]];
    const data = (template.Properties.LaunchTemplateData ?? {}) as Record<string, unknown>;
    expect(template.Properties.LaunchTemplateName).toBe("agentx-staging-worker");
    expect(data.ImageId).toBe(`resolve:ssm:${EC2_WORKER_AMI_PARAMETER}`);
    expect(data.InstanceType).toBe("m6g.medium");
    expect(data.MetadataOptions).toEqual({
      HttpEndpoint: "enabled", HttpTokens: "required", HttpPutResponseHopLimit: 1, InstanceMetadataTags: "disabled",
    });
    expect(data.BlockDeviceMappings).toEqual([{
      DeviceName: "/dev/xvda",
      Ebs: { VolumeSize: 30, VolumeType: "gp3", Encrypted: true, KmsKeyId: { "Fn::GetAtt": [expect.stringMatching(/^WorkspaceKey/), "Arn"] }, DeleteOnTermination: true },
    }]);
    expect(data.InstanceInitiatedShutdownBehavior).toBe("terminate");
    // The provisioner sends the boot script per launch; RunInstances user data would replace this anyway.
    expect(data).not.toHaveProperty("UserData");
    expect(data.SecurityGroupIds).toEqual([{ "Fn::GetAtt": [expect.stringMatching(/^Ec2WorkersWorkerSecurityGroup/), "GroupId"] }]);
  });

  it("opens the worker port only to the dispatcher and the session manager, and allows only HTTPS out", () => {
    const [[workerId, worker]] = ofType(foundation, "AWS::EC2::SecurityGroup").filter(([, r]) => r.Properties.GroupName === "agentx-staging-ec2-workers") as [[string, Resource]];
    expect(worker.Properties.SecurityGroupIngress).toBeUndefined();
    expect(worker.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" })]);
    const ingress = ofType(foundation, "AWS::EC2::SecurityGroupIngress").map(([, r]) => r.Properties);
    expect(ingress).toHaveLength(2);
    const callerIds = ingress.map((rule) => {
      expect(rule).toMatchObject({ GroupId: { "Fn::GetAtt": [workerId, "GroupId"] }, IpProtocol: "tcp", FromPort: EC2_WORKER_PORT, ToPort: EC2_WORKER_PORT });
      return (rule.SourceSecurityGroupId as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    });
    const callerNames = callerIds.map((id) => resourcesOf(foundation)[id]!.Properties.GroupName);
    expect(callerNames.sort()).toEqual(["agentx-staging-dispatcher", "agentx-staging-session-manager"]);
    for (const id of callerIds) {
      const egress = ofType(foundation, "AWS::EC2::SecurityGroupEgress").map(([, r]) => r.Properties).filter((rule) => JSON.stringify(rule.GroupId).includes(id));
      expect(egress).toEqual([expect.objectContaining({ FromPort: EC2_WORKER_PORT, ToPort: EC2_WORKER_PORT, DestinationSecurityGroupId: { "Fn::GetAtt": [workerId, "GroupId"] } })]);
    }
  });

  it("leaves the AgentCore workers' security group without ingress", () => {
    foundation.hasResourceProperties("AWS::EC2::SecurityGroup", { GroupName: "agentx-staging-workers", SecurityGroupIngress: Match.absent() });
  });

  it("gives instances ECR pull, Bedrock and their own log group, and nothing of AgentCore, KMS or SSM", () => {
    const [[, profile]] = ofType(foundation, "AWS::IAM::InstanceProfile") as [[string, Resource]];
    expect(profile.Properties.Path).toBe("/agentx/staging/");
    const roleId = (profile.Properties.Roles as Array<{ Ref: string }>)[0]!.Ref;
    const role = resourcesOf(foundation)[roleId]!;
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain("ec2.amazonaws.com");
    const policies = ofType(foundation, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(roleId));
    const actions = actionsOf(policies.flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[] }> }).Statement));
    expect(new Set(actions)).toEqual(new Set([
      "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:GetAuthorizationToken", "ecr:BatchImportUpstreamImage", "ecr:CreateRepository",
      "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "logs:CreateLogStream", "logs:PutLogEvents",
    ]));
    foundation.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/agentx/staging/worker", RetentionInDays: 30 });
  });

  it("outputs what the session provisioner and an ec2-ebs binding need", () => {
    const outputs = Object.keys(foundation.toJSON().Outputs as object);
    expect(outputs).toEqual(expect.arrayContaining([
      "Ec2WorkerLaunchTemplateId", "Ec2WorkerSecurityGroupId", "DispatcherSecurityGroupId", "SessionManagerSecurityGroupId",
      "Ec2WorkerInstanceRoleArn", "Ec2WorkerInstanceProfileArn", "Ec2WorkerLogGroupName", "Ec2WorkerSubnets",
    ]));
  });

  it("indexes SESSION items sparsely by state", () => {
    controlPlane.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: [{
        IndexName: "bySessionState",
        KeySchema: [
          { AttributeName: "sessionState", KeyType: "HASH" },
          { AttributeName: "workspaceId", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      }],
    });
  });

  it("signs invocations with a P-256 key only the dispatcher may use", () => {
    const [[keyId, key]] = ofType(controlPlane, "AWS::KMS::Key") as [[string, Resource]];
    expect(key.Properties).toMatchObject({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" });
    const keyPolicy = (key.Properties.KeyPolicy as { Statement: Array<Record<string, unknown>> }).Statement;
    const deny = keyPolicy.find((s) => s.Sid === "SignOnlyAsDispatcher")!;
    expect(deny).toMatchObject({ Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:Sign", Resource: "*" });
    const dispatcherRole = JSON.stringify((deny.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"]);
    expect(dispatcherRole).toMatch(/DispatcherServiceRole/);
    // No identity policy but the dispatcher's grants kms:Sign.
    const signers = ofType(controlPlane, "AWS::IAM::Policy").filter(([, p]) => actionsOf((p.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[] }> }).Statement).includes("kms:Sign"));
    expect(signers.map(([, p]) => JSON.stringify(p.Properties.Roles))).toEqual([expect.stringMatching(/DispatcherServiceRole/)]);
    expect(JSON.stringify(signers[0]![1].Properties.PolicyDocument)).toContain(keyId);
    controlPlane.hasResourceProperties("AWS::KMS::Alias", { AliasName: "alias/agentx/staging/invoke-signing" });
  });

  it("publishes the released worker image for the provisioner", () => {
    runtime.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/agentx/staging/worker-image",
      Type: "String",
      Value: { Ref: "WorkerImageUri" },
    });
  });
});
