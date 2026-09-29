import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, renderTemplate, type ReleaseManifest } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { OPERATOR_PARAMETERS, SECRET_PARAMETERS, installOrder, privateImageUri, stackParameters, upgradeOrder, type DeployPart, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";

const d = (c: string) => c.repeat(64);
let templates: Map<string, { Parameters?: Record<string, { Default?: unknown; NoEcho?: boolean }>; Outputs?: Record<string, unknown> }>;
let release: ReleaseManifest;

beforeAll(() => {
  const assembly = buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy" }).synth();
  templates = new Map();
  const packages = new Map<string, ReleaseManifest["packages"][number]>();
  for (const stack of assembly.stacks) {
    const part = stack.stackName.replace(`agentx-${ENVIRONMENT_PLACEHOLDER}-`, "");
    templates.set(part, JSON.parse(renderTemplate(JSON.stringify(stack.template), "staging")) as never);
    for (const asset of stack.assets.filter((a) => a.packaging === "zip")) {
      const existing = packages.get(asset.id);
      packages.set(asset.id, existing ? { ...existing, parts: [...existing.parts, part] } : {
        assetId: asset.id, file: `packages/${asset.id}.zip`, sha256: d("0"), parts: [part],
        bucketParameter: (asset as { s3BucketParameter: string }).s3BucketParameter,
        keyParameter: (asset as { s3KeyParameter: string }).s3KeyParameter,
        hashParameter: (asset as { artifactHashParameter: string }).artifactHashParameter,
        keyParameterValue: `packages/||${asset.id}.zip`,
      });
    }
  }
  release = { schemaVersion: 1, version: "1.0.0", gitCommit: "a".repeat(40), environmentPlaceholder: ENVIRONMENT_PLACEHOLDER, templates: [], packages: [...packages.values()],
    images: { worker: `public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, slack: `public.ecr.aws/agentx/agentx-slack@sha256:${d("c")}` } };
}, 300_000);

const answers = (): InstallAnswers => ({
  env: "staging", region: "us-east-1", account: "123456789012", release,
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  identity: { mode: "cognito" },
  github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
  callbackSigningKey: "k".repeat(40),
});
const outputs = {
  access: { ArtifactBucketName: "agentx-staging-access-artifactbucket-abc", CloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", OperatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", PullThroughPrefix: "agentx-staging" },
  foundation: {
    VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2",
    SessionManagerSecurityGroupId: "sg-0123456789abcdef0", DispatcherSecurityGroupId: "sg-0fedcba9876543210", WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k",
    Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker", Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
  },
  identity: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123" },
  "control-plane": { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask", SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b", SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x", OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts" },
};
// No "identity" key: your own OIDC provider means there is no identity stack to read outputs from.
const oidcOutputs = { access: outputs.access, foundation: outputs.foundation, "control-plane": outputs["control-plane"] };
const oidcAnswers = (): InstallAnswers => ({
  ...answers(),
  identity: { mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx", adminClaim: "custom:roles", adminValues: ["platform-admin"] },
});

describe("deploy parameters", () => {
  it("propagates mixed model providers and secret references to each declared stack parameter", () => {
    const configured = answers();
    configured.models.providers = { orchestrator: "openrouter", classifier: "amazon-bedrock", worker: "openrouter" };
    configured.models.openRouter = { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:openrouter-AbCdEf", providers: ["anthropic"] };
    expect(stackParameters("foundation", configured, outputs, { packages: true })).not.toHaveProperty("OpenRouterSecretArn");
    for (const part of ["control-plane", "runtime", "slack"] as const) {
      const params = stackParameters(part, configured, outputs, { packages: true });
      expect(params.OpenRouterSecretArn).toBe(configured.models.openRouter.secretArn);
      expect(Object.keys(params).filter((name) => !(name in templates.get(part)!.Parameters!))).toEqual([]);
      if (part === "runtime" || part === "slack") expect(params).toMatchObject({ ModelProvider: "openrouter", OpenRouterProviders: "anthropic" });
      if (part === "slack") expect(params.GateClassifierProvider).toBe("amazon-bedrock");
    }
  });
  it("passes the alert topic to the Slack stack, and the budget to the control plane only when there is one", () => {
    expect(stackParameters("slack", answers(), outputs, { packages: true }).OperatorAlertsTopicArn).toBe(outputs["control-plane"].OperatorAlertsTopicArn);
    expect(stackParameters("control-plane", answers(), outputs, { packages: true }).BudgetMonthlyUsd).toBeUndefined();
    const withBudget = stackParameters("control-plane", { ...answers(), budget: { monthlyUsd: 150, scope: "account" } }, outputs, { packages: true });
    expect(withBudget).toMatchObject({ BudgetMonthlyUsd: "150", BudgetScope: "account" });
  });
  it.each(["access", "foundation", "identity", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s and nothing unknown", (part) => {
    const params = stackParameters(part, answers(), outputs, { packages: true });
    const declared = templates.get(part)!.Parameters ?? {};
    const required = Object.entries(declared).filter(([, p]) => p.Default === undefined).map(([name]) => name);
    expect(required.filter((name) => !(name in params))).toEqual([]);
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
  });

  it.each(["access", "foundation", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s under your own OIDC and nothing unknown", (part) => {
    const params = stackParameters(part, oidcAnswers(), oidcOutputs, { packages: true });
    const declared = templates.get(part)!.Parameters ?? {};
    const required = Object.entries(declared).filter(([, p]) => p.Default === undefined).map(([name]) => name);
    expect(required.filter((name) => !(name in params))).toEqual([]);
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
  });

  it("maps a public image to its private pull-through address", () => {
    expect(privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, { account: "123456789012", region: "us-east-1", prefix: "agentx-staging" }))
      .toBe(`123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-worker@sha256:${d("b")}`);
    expect(() => privateImageUri("public.ecr.aws/agentx/agentx-worker:latest", { account: "1", region: "r", prefix: "p" })).toThrow(/digest/);
    expect(() => privateImageUri(`docker.io/x/y@sha256:${d("b")}`, { account: "1", region: "r", prefix: "p" })).toThrow(/public.ecr.aws/);
  });

  it("derives the ECR host suffix from the target partition, defaulting to aws", () => {
    expect(privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, { account: "123456789012", region: "cn-north-1", prefix: "agentx-staging", partition: "aws-cn" }))
      .toBe(`123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/agentx-staging/agentx/agentx-worker@sha256:${d("b")}`);
    expect(privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, { account: "123456789012", region: "us-gov-west-1", prefix: "agentx-staging", partition: "aws-us-gov" }))
      .toBe(`123456789012.dkr.ecr.us-gov-west-1.amazonaws.com/agentx-staging/agentx/agentx-worker@sha256:${d("b")}`);
    expect(() => privateImageUri(`public.ecr.aws/agentx/agentx-worker@sha256:${d("b")}`, { account: "1", region: "r", prefix: "p", partition: "aws-mars" })).toThrow(/partition/);
  });

  it("orders a fresh install and an upgrade differently, and skips identity for your own OIDC", () => {
    expect(installOrder("cognito")).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect(upgradeOrder("cognito")).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
    expect(installOrder("oidc")).not.toContain("identity");
  });

  it("takes the OIDC issuer from the identity stack or from your own provider", () => {
    expect(stackParameters("control-plane", answers(), outputs, { packages: true })).toMatchObject({ OidcIssuer: outputs.identity.Issuer, OidcAudience: "client123" });
    const own = oidcAnswers();
    expect(stackParameters("control-plane", own, oidcOutputs, { packages: true })).toMatchObject({ OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" });
  });

  it("requires an admin claim and values for your own OIDC, and sets them when given", () => {
    const noAdmin = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx" } };
    expect(() => stackParameters("control-plane", noAdmin, oidcOutputs, { packages: true })).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    expect(stackParameters("control-plane", oidcAnswers(), oidcOutputs, { packages: true })).toMatchObject({
      AdminClaim: "custom:roles",
      AdminValues: JSON.stringify(["platform-admin"]),
    });
  });

  it("refuses your own OIDC when only one of adminClaim/adminValues is given", () => {
    const claimOnly = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx", adminClaim: "custom:roles" } };
    expect(() => stackParameters("control-plane", claimOnly, oidcOutputs, { packages: true })).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    const valuesOnly = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx", adminValues: ["platform-admin"] } };
    expect(() => stackParameters("control-plane", valuesOnly, oidcOutputs, { packages: true })).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
  });

  it("refuses your own OIDC when adminClaim is empty or adminValues is an empty list", () => {
    const emptyClaim = { ...answers(), identity: { ...oidcAnswers().identity, adminClaim: "" } };
    expect(() => stackParameters("control-plane", emptyClaim, oidcOutputs, { packages: true })).toThrow(
      "bringing your own OIDC provider requires a non-empty adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    const emptyValues = { ...answers(), identity: { ...oidcAnswers().identity, adminValues: [] } };
    expect(() => stackParameters("control-plane", emptyValues, oidcOutputs, { packages: true })).toThrow(
      "bringing your own OIDC provider requires a non-empty adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
  });

  it("keeps the Cognito template defaults (never sets AdminClaim/AdminValues) when using the identity stack", () => {
    const params = stackParameters("control-plane", answers(), outputs, { packages: true });
    expect(params).not.toHaveProperty("AdminClaim");
    expect(params).not.toHaveProperty("AdminValues");
  });

  it("passes SlackAppPostedMessages to the control plane only when chosen", () => {
    expect(stackParameters("control-plane", { ...answers(), slackAppPostedMessages: "ignore" }, outputs, { packages: true }).SlackAppPostedMessages).toBe("ignore");
    expect(stackParameters("control-plane", answers(), outputs, { packages: true })).not.toHaveProperty("SlackAppPostedMessages");
  });

  it("passes the GitHub App credential ref through when given", () => {
    const withRef = { ...answers(), github: { ...answers().github, credentialRef: "github-custom-ref" } };
    expect(stackParameters("control-plane", withRef, outputs, { packages: true })).toMatchObject({ GitHubAppCredentialRef: "github-custom-ref" });
  });

  it("names the missing output or image", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { VpcId: _gone, ...foundation } = outputs.foundation;
    expect(() => stackParameters("slack", answers(), { ...outputs, foundation }, { packages: true })).toThrow("stack agentx-staging-foundation has no output VpcId");
    const noWorker = { ...answers(), release: { ...release, images: {} } };
    expect(() => stackParameters("runtime", noWorker, outputs, { packages: true })).toThrow("release 1.0.0 has no worker image digest");
  });

  it("names a missing access output", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { PullThroughPrefix: _prefixGone, ...accessNoPrefix } = outputs.access;
    expect(() => stackParameters("runtime", answers(), { ...outputs, access: accessNoPrefix }, { packages: true })).toThrow("stack agentx-staging-access has no output PullThroughPrefix");

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { ArtifactBucketName: _bucketGone, ...accessNoBucket } = outputs.access;
    expect(() => stackParameters("control-plane", answers(), { ...outputs, access: accessNoBucket }, { packages: true })).toThrow("stack agentx-staging-access has no output ArtifactBucketName");
  });

  it("refuses a release package that lists the access stack (it has no zip assets of its own)", () => {
    const [firstPackage] = release.packages;
    if (firstPackage === undefined) throw new Error("test setup: the synthesized release has no packages to corrupt");
    const badRelease: ReleaseManifest = { ...release, packages: [{ ...firstPackage, parts: ["access"] }] };
    expect(() => stackParameters("access", { ...answers(), release: badRelease }, outputs, { packages: true })).toThrow(/access stack carries no zip assets/);
  });

  it("marks every NoEcho template parameter as secret, and nothing else", () => {
    const noEcho = new Set([...templates.values()].flatMap((t) => Object.entries(t.Parameters ?? {}).filter(([, p]) => p.NoEcho === true).map(([name]) => name)));
    expect(noEcho.size).toBeGreaterThan(0);
    expect([...SECRET_PARAMETERS].sort()).toEqual([...noEcho].sort());
  });

  it("lists no secret as an operator parameter an upgrade carries (none is in SECRET_PARAMETERS or NoEcho in any template)", () => {
    const operator = Object.values(OPERATOR_PARAMETERS).flat();
    expect(operator.length).toBeGreaterThan(0);
    for (const name of operator) expect(SECRET_PARAMETERS.has(name)).toBe(false);
    const noEcho = new Set([...templates.values()].flatMap((t) => Object.entries(t.Parameters ?? {}).filter(([, p]) => p.NoEcho === true).map(([name]) => name)));
    for (const name of operator) expect(noEcho.has(name)).toBe(false);
  });

  it("names only operator parameters its own part's template declares", () => {
    for (const [part, names] of Object.entries(OPERATOR_PARAMETERS)) {
      const declared = Object.keys(templates.get(part)?.Parameters ?? {});
      for (const name of names) expect(declared, `${part} ${name}`).toContain(name);
    }
  });

  it("reads only outputs the producing templates declare", () => {
    const read: Array<[DeployPart, string]> = [];
    const recording = (source: Partial<Record<DeployPart, Record<string, string>>>) =>
      Object.fromEntries(Object.entries(source).map(([part, values]) => [part, new Proxy(values, {
        get: (target, name: string) => { read.push([part as DeployPart, name]); return target[name]; },
      })]));
    for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"] as DeployPart[]) stackParameters(part, answers(), recording(outputs), { packages: true });
    for (const part of ["access", "foundation", "control-plane", "runtime", "slack"] as DeployPart[]) stackParameters(part, oidcAnswers(), recording(oidcOutputs), { packages: true });
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter(([part, name]) => !(name in (templates.get(part)!.Outputs ?? {}))).map(([part, name]) => `${part}.${name}`)).toEqual([]);
  });

  it("refuses a callback signing key shorter than 32 characters without echoing it", () => {
    const shortKey = "short-signing-key-value";
    let message = "";
    try {
      stackParameters("control-plane", { ...answers(), callbackSigningKey: shortKey }, outputs, { packages: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("the callback signing key must be at least 32 characters");
    expect(message).not.toContain(shortKey);
    expect(() => stackParameters("control-plane", { ...answers(), callbackSigningKey: "k".repeat(32) }, outputs, { packages: true })).not.toThrow();
  });

  it("uses image overrides as-is, and only by digest", () => {
    const withOverrides = { ...answers(), images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${d("e")}` } };
    expect(stackParameters("runtime", withOverrides, outputs, { packages: true }).WorkerImageUri).toBe(withOverrides.images.worker);
    expect(() => stackParameters("runtime", { ...answers(), images: { worker: "x/y:latest" } }, outputs, { packages: true })).toThrow("image override for worker must be referenced by digest");
  });

  it("uses a slack image override as-is, and only by digest", () => {
    const withOverrides = { ...answers(), images: { slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-slack-production@sha256:${d("f")}` } };
    expect(stackParameters("slack", withOverrides, outputs, { packages: true }).OrchestratorImageUri).toBe(withOverrides.images.slack);
    expect(() => stackParameters("slack", { ...answers(), images: { slack: "x/y:latest" } }, outputs, { packages: true })).toThrow("image override for slack must be referenced by digest");
  });

  it("a worker image override does not require the access stack's PullThroughPrefix output", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { PullThroughPrefix: _prefixGone, ...accessNoPrefix } = outputs.access;
    const withOverride = { ...answers(), images: { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${d("e")}` } };
    expect(() => stackParameters("runtime", withOverride, { ...outputs, access: accessNoPrefix }, { packages: true })).not.toThrow();
  });

  it("a slack image override does not require the access stack's PullThroughPrefix output", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { PullThroughPrefix: _prefixGone, ...accessNoPrefix } = outputs.access;
    const withOverride = { ...answers(), images: { slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-slack-production@sha256:${d("f")}` } };
    expect(() => stackParameters("slack", withOverride, { ...outputs, access: accessNoPrefix }, { packages: true })).not.toThrow();
  });

  it("without an override, the slack stack still requires the access stack's PullThroughPrefix output, naming it", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { PullThroughPrefix: _prefixGone, ...accessNoPrefix } = outputs.access;
    expect(() => stackParameters("slack", answers(), { ...outputs, access: accessNoPrefix }, { packages: true })).toThrow("stack agentx-staging-access has no output PullThroughPrefix");
  });

  it("passes stored developer sign-in to the control plane, every key declared by the template", () => {
    const params = stackParameters("control-plane", { ...answers(), developerSignIn: { slackTeamId: "T0TEAM1", settings: { schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "x" } } }, outputs, { packages: true });
    expect(params).toMatchObject({ SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled", DeveloperOidcIssuer: "" });
    const declared = templates.get("control-plane")!.Parameters ?? {};
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
    expect(stackParameters("runtime", { ...answers(), developerSignIn: { slackTeamId: "T0TEAM1" } }, outputs, { packages: true })).not.toHaveProperty("SlackTeamId");
  });

  it("leaves the template defaults when no sign-in is stored", () => {
    expect(stackParameters("control-plane", answers(), outputs, { packages: true })).not.toHaveProperty("DeveloperSignInSlack");
  });
});
