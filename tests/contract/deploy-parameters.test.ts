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

describe("deploy parameters", () => {
  it.each(["access", "foundation", "identity", "control-plane", "runtime", "slack"] as DeployPart[])("supplies every required parameter of %s and nothing unknown", (part) => {
    const params = stackParameters(part, answers(), outputs);
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

  it("orders a fresh install and an upgrade differently, and skips identity for your own OIDC", () => {
    expect(installOrder("cognito")).toEqual(["access", "foundation", "identity", "control-plane", "runtime", "slack"]);
    expect(upgradeOrder("cognito")).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
    expect(installOrder("oidc")).not.toContain("identity");
  });

  it("takes the OIDC issuer from the identity stack or from your own provider", () => {
    expect(stackParameters("control-plane", answers(), outputs)).toMatchObject({ OidcIssuer: outputs.identity.Issuer, OidcAudience: "client123" });
    const own = { ...answers(), identity: { mode: "oidc" as const, issuer: "https://login.example.com", audience: "api://agentx" } };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { identity: _identity, ...withoutIdentity } = outputs;
    expect(stackParameters("control-plane", own, withoutIdentity)).toMatchObject({ OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" });
  });

  it("names the missing output or image", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
    const { VpcId: _gone, ...foundation } = outputs.foundation;
    expect(() => stackParameters("slack", answers(), { ...outputs, foundation })).toThrow("stack agentx-staging-foundation has no output VpcId");
    const noWorker = { ...answers(), release: { ...release, images: {} } };
    expect(() => stackParameters("runtime", noWorker, outputs)).toThrow("release 1.0.0 has no worker image digest");
  });

  it("marks the callback signing key as secret", () => {
    expect([...SECRET_PARAMETERS]).toEqual(["CallbackSigningKey"]);
  });
});
