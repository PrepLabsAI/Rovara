import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, renderTemplate, type ReleaseManifest } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SECRET_PARAMETERS, installOrder, privateImageUri, stackParameters, upgradeOrder, type DeployPart, type InstallAnswers } from "../../packages/cli/src/deploy/parameters.js";

const d = (c: string) => c.repeat(64);
let templates: Map<string, { Parameters?: Record<string, { Default?: unknown }> }>;
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
  foundation: { CapacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/agentx_staging_capacity-AbCdEfGhIj", VpcId: "vpc-0123456789abcdef0", PrivateSubnetIds: "subnet-1,subnet-2" },
  identity: { Issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", Audience: "client123" },
  "control-plane": { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com", SlackOrchestratorTaskRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-control-plane-SlackTask", SlackRequestQueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo", SlackThreadsTableName: "t", TurnRecordsTableName: "tr", SlackThreadSessionBucketName: "b", SlackSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:SlackSecret-x" },
};
// No "identity" key: your own OIDC provider means there is no identity stack to read outputs from.
const oidcOutputs = { access: outputs.access, foundation: outputs.foundation, "control-plane": outputs["control-plane"] };
const oidcAnswers = (): InstallAnswers => ({
  ...answers(),
  identity: { mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx", adminClaim: "custom:roles", adminValues: ["platform-admin"] },
});

describe("deploy parameters", () => {
  it.each(["access", "foundation", "identity", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s and nothing unknown", (part) => {
    const params = stackParameters(part, answers(), outputs);
    const declared = templates.get(part)!.Parameters ?? {};
    const required = Object.entries(declared).filter(([, p]) => p.Default === undefined).map(([name]) => name);
    expect(required.filter((name) => !(name in params))).toEqual([]);
    expect(Object.keys(params).filter((name) => !(name in declared))).toEqual([]);
  });

  it.each(["access", "foundation", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s under your own OIDC and nothing unknown", (part) => {
    const params = stackParameters(part, oidcAnswers(), oidcOutputs);
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
    expect(stackParameters("control-plane", answers(), outputs)).toMatchObject({ OidcIssuer: outputs.identity.Issuer, OidcAudience: "client123" });
    const own = oidcAnswers();
    expect(stackParameters("control-plane", own, oidcOutputs)).toMatchObject({ OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" });
  });

  it("requires an admin claim and values for your own OIDC, and sets them when given", () => {
    const noAdmin = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx" } };
    expect(() => stackParameters("control-plane", noAdmin, oidcOutputs)).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    expect(stackParameters("control-plane", oidcAnswers(), oidcOutputs)).toMatchObject({
      AdminClaim: "custom:roles",
      AdminValues: JSON.stringify(["platform-admin"]),
    });
  });

  it("refuses your own OIDC when only one of adminClaim/adminValues is given", () => {
    const claimOnly = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx", adminClaim: "custom:roles" } };
    expect(() => stackParameters("control-plane", claimOnly, oidcOutputs)).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    const valuesOnly = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx", adminValues: ["platform-admin"] } };
    expect(() => stackParameters("control-plane", valuesOnly, oidcOutputs)).toThrow(
      "bringing your own OIDC provider requires adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
  });

  it("refuses your own OIDC when adminClaim is empty or adminValues is an empty list", () => {
    const emptyClaim = { ...answers(), identity: { ...oidcAnswers().identity, adminClaim: "" } };
    expect(() => stackParameters("control-plane", emptyClaim, oidcOutputs)).toThrow(
      "bringing your own OIDC provider requires a non-empty adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
    const emptyValues = { ...answers(), identity: { ...oidcAnswers().identity, adminValues: [] } };
    expect(() => stackParameters("control-plane", emptyValues, oidcOutputs)).toThrow(
      "bringing your own OIDC provider requires a non-empty adminClaim and adminValues (the claim and values that mark AgentX administrators)",
    );
  });

  it("keeps the Cognito template defaults (never sets AdminClaim/AdminValues) when using the identity stack", () => {
    const params = stackParameters("control-plane", answers(), outputs);
    expect(params).not.toHaveProperty("AdminClaim");
    expect(params).not.toHaveProperty("AdminValues");
  });

  it("passes the GitHub App credential ref through when given", () => {
    const withRef = { ...answers(), github: { ...answers().github, credentialRef: "github-custom-ref" } };
    expect(stackParameters("control-plane", withRef, outputs)).toMatchObject({ GitHubAppCredentialRef: "github-custom-ref" });
  });

  it("names the missing output or image", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { VpcId: _gone, ...foundation } = outputs.foundation;
    expect(() => stackParameters("slack", answers(), { ...outputs, foundation })).toThrow("stack agentx-staging-foundation has no output VpcId");
    const noWorker = { ...answers(), release: { ...release, images: {} } };
    expect(() => stackParameters("runtime", noWorker, outputs)).toThrow("release 1.0.0 has no worker image digest");
  });

  it("names a missing access output", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { PullThroughPrefix: _prefixGone, ...accessNoPrefix } = outputs.access;
    expect(() => stackParameters("runtime", answers(), { ...outputs, access: accessNoPrefix })).toThrow("stack agentx-staging-access has no output PullThroughPrefix");

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { ArtifactBucketName: _bucketGone, ...accessNoBucket } = outputs.access;
    expect(() => stackParameters("control-plane", answers(), { ...outputs, access: accessNoBucket })).toThrow("stack agentx-staging-access has no output ArtifactBucketName");
  });

  it("refuses a release package that lists the access stack (it has no zip assets of its own)", () => {
    const [firstPackage] = release.packages;
    if (firstPackage === undefined) throw new Error("test setup: the synthesized release has no packages to corrupt");
    const badRelease: ReleaseManifest = { ...release, packages: [{ ...firstPackage, parts: ["access"] }] };
    expect(() => stackParameters("access", { ...answers(), release: badRelease }, outputs)).toThrow(/access stack carries no zip assets/);
  });

  it("marks the callback signing key as secret", () => {
    expect([...SECRET_PARAMETERS]).toEqual(["CallbackSigningKey"]);
  });
});
