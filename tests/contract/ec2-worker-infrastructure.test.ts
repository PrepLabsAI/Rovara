import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_SESSION_STATE_INDEX } from "../../packages/contracts/src/session.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { EC2_WORKER_AMI_PARAMETER, EC2_WORKER_PORT } from "../../infra/lib/ec2-workers.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Template, type: string) => Object.entries(resourcesOf(template)).filter(([, r]) => r.Type === type);
const actionsOf = (statements: Array<{ Action: string | string[] }>) => statements.flatMap((s) => [s.Action].flat());

describe("EC2 worker infrastructure (issue #82), shown for a named environment", () => {
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

  it.each([["OpenRouter", "openrouter"], ["Anthropic", "anthropic"], ["OpenAI", "openai"]] as const)("grants %s secret access only when enabled and only to the configured ARN", (prefix, provider) => {
    for (const template of [controlPlane]) {
      template.hasParameter(`${prefix}SecretArn`, { Default: "" });
      const policy = ofType(template, "AWS::IAM::Policy").find(([, resource]) => resource.Properties.PolicyName === `${prefix}SecretRead`)!;
      expect(policy).toBeDefined();
      expect(policy[1]).toHaveProperty("Condition", `${prefix}Enabled`);
      expect(policy[1].Properties.PolicyDocument).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: `${prefix}SecretArn` } }] });
    }
    expect(JSON.stringify(foundation.toJSON())).not.toContain(prefix);
    // Both role attachments live in the control plane, including correct path removal for
    // /agentx/<env>/ worker roles and the legacy production role at /.
    for (const [templates, roleIndex] of [[[controlPlane], 3], [legacy, 1]] as const) {
      const policies = templates.flatMap((template) => ofType(template, "AWS::IAM::Policy"))
        .filter(([, policy]) => policy.Properties.PolicyName === `${prefix}SecretRead`);
      expect(policies).toHaveLength(1);
      expect(policies[0]![1].Properties.Roles).toEqual([
        { Ref: expect.stringMatching(/^SlackOrchestratorTaskRole/) as unknown },
        { "Fn::Select": [roleIndex, { "Fn::Split": ["/", { Ref: "Ec2WorkerInstanceRoleArn" }] }] },
      ]);
    }
    const serialized = JSON.stringify(runtime.toJSON());
    expect(serialized).toContain(`worker-${provider}-secret-arn`);
    expect(serialized).not.toMatch(/OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  it("tags launched instances and root volumes for named environments only", () => {
    for (const [templates, env] of [[[foundation], "staging"], [legacy, undefined]] as const) {
      const launch = templates.flatMap((t) => ofType(t, "AWS::EC2::LaunchTemplate"))[0]![1];
      const data = launch.Properties.LaunchTemplateData as { TagSpecifications: Array<{ ResourceType: string; Tags: Array<{ Key: string; Value: string }> }> };
      expect(data.TagSpecifications.map((s) => s.ResourceType).sort()).toEqual(["instance", "volume"]);
      for (const spec of data.TagSpecifications) {
        expect(spec.Tags.filter((tag) => tag.Key === "agentx:env")).toEqual(env === undefined ? [] : [{ Key: "agentx:env", Value: env }]);
      }
    }
    // Check the actual lifecycle wiring, not just the standalone definition helper.
    const definitions = ofType(controlPlane, "AWS::StepFunctions::StateMachine").map(([, r]) => JSON.stringify(r.Properties.DefinitionString).replaceAll("\\", ""));
    const provisioner = definitions.find((definition) => definition.includes("createVolume"))!;
    expect(provisioner.match(/"Key":"agentx:env","Value":"staging"/g)).toHaveLength(2);
  });

  it("gives production the same resources under its own names", () => {
    const all = (type: string) => legacy.flatMap((template) => ofType(template, type).map(([, r]) => r));
    expect(all("AWS::EC2::LaunchTemplate").map((r) => r.Properties.LaunchTemplateName)).toEqual(["agentx-production-worker"]);
    expect(all("AWS::EC2::SecurityGroup").map((r) => r.Properties.GroupName).filter((name) => name !== undefined).sort()).toEqual([
      "agentx-production-dispatcher", "agentx-production-ec2-workers", "agentx-production-session-manager",
    ]);
    expect(all("AWS::SSM::Parameter").map((r) => r.Properties.Name).sort()).toEqual([
      "/agentx/production/worker-anthropic-secret-arn", "/agentx/production/worker-executor-image",
      "/agentx/production/worker-image", "/agentx/production/worker-model-id", "/agentx/production/worker-model-provider",
      "/agentx/production/worker-openai-secret-arn", "/agentx/production/worker-openrouter-providers", "/agentx/production/worker-openrouter-secret-arn",
      "/agentx/production/worker-prompt-cache-retention",
    ]);
    expect(all("AWS::KMS::Alias").map((r) => r.Properties.AliasName).sort()).toEqual([
      "alias/agentx/production-workspaces", "alias/agentx/production/invoke-signing",
    ]);
    const logGroups = all("AWS::Logs::LogGroup").map((r) => r.Properties.LogGroupName).filter((name) => typeof name === "string");
    expect(logGroups).toContain("/agentx/production/worker");
    // Production's roles have no environment path, and it has no ECR pull-through cache.
    const [profile] = all("AWS::IAM::InstanceProfile");
    expect(profile!.Properties.Path).toBeUndefined();
    expect(JSON.stringify(legacy.map((t) => t.toJSON()))).not.toContain("EcrPullThroughCache");
    expect(JSON.stringify(legacy.map((t) => t.toJSON()))).toContain(WORKSPACE_SESSION_STATE_INDEX.name);
  });

  it("launches arm64 Amazon Linux 2023 m6g.large with IMDSv2 at one hop and an encrypted root volume", () => {
    const [[, template]] = ofType(foundation, "AWS::EC2::LaunchTemplate") as [[string, Resource]];
    const data = (template.Properties.LaunchTemplateData ?? {}) as Record<string, unknown>;
    expect(template.Properties.LaunchTemplateName).toBe("agentx-staging-worker");
    expect(data.ImageId).toBe(`resolve:ssm:${EC2_WORKER_AMI_PARAMETER}`);
    expect(data.InstanceType).toBe("m6g.large");
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

  it("no longer has the retired runtime workers' security group (#118)", () => {
    expect(ofType(foundation, "AWS::EC2::SecurityGroup").map(([, r]) => r.Properties.GroupName)).not.toContain("agentx-staging-workers");
  });

  it("gives instances ECR pull, Bedrock and their own log group, and nothing of retired runtime, KMS or SSM", () => {
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
    // arrayWith, not the whole list: spec 041 adds a second index (byWorkspaceProject) to the same
    // table, and this test is about the session one.
    controlPlane.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([{
        IndexName: "bySessionState",
        KeySchema: [
          { AttributeName: "sessionState", KeyType: "HASH" },
          { AttributeName: "workspaceId", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      }]),
    });
  });

  it("signs invocations with a P-256 key only the dispatcher may use", () => {
    // Spec 025 adds the developer-token RSA key to named environments; this is the P-256 invocation key.
    const p256Keys = ofType(controlPlane, "AWS::KMS::Key").filter(([, r]) => r.Properties.KeySpec === "ECC_NIST_P256");
    expect(p256Keys).toHaveLength(1);
    const [[keyId, key]] = p256Keys as [[string, Resource]];
    const otherKeyIds = ofType(controlPlane, "AWS::KMS::Key").map(([id]) => id).filter((id) => id !== keyId);
    expect(key.Properties).toMatchObject({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" });
    const keyPolicy = (key.Properties.KeyPolicy as { Statement: Array<Record<string, unknown>> }).Statement;
    const deny = keyPolicy.find((s) => s.Sid === "SignOnlyAsDispatcher")!;
    expect(deny).toMatchObject({ Effect: "Deny", Principal: { AWS: "*" }, Action: "kms:Sign", Resource: "*" });
    const dispatcherRole = JSON.stringify((deny.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"]);
    expect(dispatcherRole).toMatch(/DispatcherServiceRole/);
    // No identity policy but the dispatcher's grants kms:Sign on this key. A kms:Sign grant counts
    // unless its resources name only another key of this template (so a wildcard still counts).
    const signsThisKey = (s: { Action: string | string[]; Resource?: unknown }) => {
      const resource = JSON.stringify(s.Resource);
      return actionsOf([s]).includes("kms:Sign") && (resource.includes(keyId) || !otherKeyIds.some((id) => resource.includes(id)));
    };
    const signers = ofType(controlPlane, "AWS::IAM::Policy").filter(([, p]) => (p.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource?: unknown }> }).Statement.some(signsThisKey));
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

describe("standing E2E qualification transport (agentx:e2eQualificationTransport)", () => {
  type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown };
  const synth = (context: Record<string, unknown> = {}) => {
    const stacks = stacksOf(buildAgentXApp({ agentxEnv: "staging", ...context }));
    const byName = (name: string) => Template.fromStack(stacks.find((s) => s.stackName === name)!);
    return { foundation: byName("agentx-staging-foundation"), controlPlane: byName("agentx-staging-control-plane") };
  };
  const statementsOf = (template: Template): Statement[] => ofType(template, "AWS::IAM::Policy")
    .concat(ofType(template, "AWS::IAM::ManagedPolicy"))
    .flatMap(([, r]) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  const withAction = (template: Template, action: string) => statementsOf(template).filter((s) => [s.Action].flat().includes(action));
  // A resource is a Fn::Join ending in the object key pattern; render its literal tail.
  const tail = (resource: unknown): string => {
    const parts = (resource as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
    return parts.filter((p): p is string => typeof p === "string").join("");
  };
  const qualification = (template: Template) => statementsOf(template).filter((s) => JSON.stringify(s.Resource).includes("e2e-runtime/"));
  let off: ReturnType<typeof synth>;
  let on: ReturnType<typeof synth>;
  let booleanTrue: ReturnType<typeof synth>;
  let stringTrue: ReturnType<typeof synth>;

  beforeAll(() => {
    off = synth();
    on = synth({ "agentx:e2eQualificationTransport": "enabled" });
    booleanTrue = synth({ "agentx:e2eQualificationTransport": true });
    stringTrue = synth({ "agentx:e2eQualificationTransport": "true" });
  }, 240_000);

  it("adds no qualification transport by default", () => {
    expect(qualification(off.controlPlane)).toHaveLength(0);
    expect(qualification(off.foundation)).toHaveLength(0);
  });

  it("fails closed unless the context is exactly the string enabled", () => {
    for (const t of [booleanTrue, stringTrue]) {
      expect(qualification(t.controlPlane)).toHaveLength(0);
      expect(qualification(t.foundation)).toHaveLength(0);
      expect(ofType(t.controlPlane, "AWS::IAM::Policy").filter(([, r]) => r.Properties.PolicyName === "E2eQualificationTransport")).toHaveLength(0);
    }
  });

  it("adds challenge/proposal/ready/status object access scoped to the caller's own role session (${aws:userid}) when enabled", () => {
    const policyNamed = (name: string) => ofType(on.controlPlane, "AWS::IAM::Policy").find(([, r]) => r.Properties.PolicyName === name);
    const statementsOf = (name: string) => (policyNamed(name)![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    const resourcesFor = (statements: Statement[], action: string) => statements.filter((s) => [s.Action].flat().includes(action)).flatMap((s) => [s.Resource].flat().map(tail)).sort();
    expect(withAction(on.controlPlane, "s3:GetObject").filter((s) => JSON.stringify(s.Resource).includes("e2e-runtime/"))).toHaveLength(2);
    expect(withAction(on.controlPlane, "s3:PutObject").filter((s) => JSON.stringify(s.Resource).includes("e2e-runtime/"))).toHaveLength(2);
    // The IAM policy variable stays literal in the synthesized template (an EC2 role session's aws:userid is <role unique ID>:<instance ID>),
    // so one instance of the shared worker role reaches only its own prefix.
    const transport = statementsOf("E2eQualificationTransport");
    expect(resourcesFor(transport, "s3:GetObject")).toEqual(["/e2e-runtime/${aws:userid}/challenge.json"]);
    expect(resourcesFor(transport, "s3:PutObject")).toEqual(["/e2e-runtime/${aws:userid}/proposal.json", "/e2e-runtime/${aws:userid}/ready.json", "/e2e-runtime/${aws:userid}/status.json"]);
    // M1.4 Task 4.9: the model canary's two keys, in a policy of their own (added beside the deployed grant, never modifying it).
    const canary = statementsOf("E2eQualificationTransportCanary");
    expect(resourcesFor(canary, "s3:GetObject")).toEqual(["/e2e-runtime/${aws:userid}/canary-request.json"]);
    expect(resourcesFor(canary, "s3:PutObject")).toEqual(["/e2e-runtime/${aws:userid}/canary-result.json"]);
    expect(JSON.stringify(on.controlPlane.toJSON())).not.toContain("e2e-runtime/*");
    for (const name of ["E2eQualificationTransport", "E2eQualificationTransportCanary"]) {
      const statements = statementsOf(name);
      // The bucket is the control plane's own artifact bucket.
      expect(JSON.stringify(statements.map((s) => s.Resource)), name).toMatch(/Artifacts/);
      // No List, Delete or wildcard access in the policy that carries it.
      expect(actionsOf(statements).sort(), name).toEqual(["s3:GetObject", "s3:PutObject"]);
      expect(JSON.stringify(statements.map((s) => s.Resource)), name).not.toMatch(/\/\*"|\/\*\\"/);
      // It attaches to the EC2 workers' instance role, the same way the provider secret policies do.
      expect(policyNamed(name)![1].Properties.Roles, name).toEqual([{ "Fn::Select": [3, { "Fn::Split": ["/", { Ref: "Ec2WorkerInstanceRoleArn" }] }] }]);
    }
  });

  it("leaves the protected foundation template and its instance role unchanged", () => {
    expect(on.foundation.toJSON()).toEqual(off.foundation.toJSON());
  });

  it("keeps the IMDS hop limit at 1", () => {
    for (const { foundation } of [off, on]) {
      const launch = ofType(foundation, "AWS::EC2::LaunchTemplate")[0]![1];
      const data = launch.Properties.LaunchTemplateData as { MetadataOptions: { HttpPutResponseHopLimit: number } };
      expect(data.MetadataOptions.HttpPutResponseHopLimit).toBe(1);
    }
  });
});
