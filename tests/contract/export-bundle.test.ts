import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReleaseManifest } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import type { DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import { writeExportBundle } from "../../packages/cli/src/deploy/export-bundle.js";
import type { DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";

const ENV = "staging";
const REGION = "us-east-1";
const OTHER_REGION = "eu-west-1";
const ACCOUNT = "123456789012";
const STACK_NAME = `agentx-${ENV}-access`;

const RUNTIME_ASSET = "a".repeat(64);
const CONTROL_PLANE_ASSET = "b".repeat(64);
const WORKER_DIGEST = `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`;
const SLACK_DIGEST = `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}`;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

let releaseDir: string;
/** The real, CDK-synthesized access template for ENV: ruling (a) requires the access-deployer
 * policy's resources to match the actual role, policy and bucket names the access stack
 * synthesizes, not a hand-written stand-in for them. */
let accessTemplateText: string;
const zipBytes: Record<string, Buffer> = {
  [RUNTIME_ASSET]: Buffer.from("runtime zip bytes"),
  [CONTROL_PLANE_ASSET]: Buffer.from("control plane zip bytes"),
};

beforeAll(async () => {
  releaseDir = await mkdtemp(join(tmpdir(), "agentx-export-bundle-"));
  for (const [assetId, bytes] of Object.entries(zipBytes)) {
    await writeFile(join(releaseDir, `${assetId}.zip`), bytes);
  }
  // The "legacy" synthesizer, not CDK's default bootstrapped one: it is what the real release
  // pipeline uses to build the templates a release ships (scripts/release/build.ts), so this is
  // the actual shape `LoadedRelease.template("access", ...)` returns in production — no
  // BootstrapVersion parameter or CDK-bootstrap coupling, which the default synthesizer would add.
  const app = buildAgentXApp({ agentxEnv: ENV, agentxSynthesizer: "legacy" });
  const access = app.node.children.find((c): c is Stack => Stack.isStack(c) && c.stackName === STACK_NAME)!;
  accessTemplateText = JSON.stringify(Template.fromStack(access).toJSON());
}, 240_000);

function pkg(assetId: string, part: DeployPart) {
  return {
    assetId,
    file: `packages/${assetId}.zip`,
    sha256: sha256(zipBytes[assetId]!),
    parts: [part],
    bucketParameter: `AssetParameters${assetId}Bucket`,
    keyParameter: `AssetParameters${assetId}Key`,
    hashParameter: `AssetParameters${assetId}Hash`,
    keyParameterValue: `packages/||${assetId}.zip`,
  };
}

function fakeRelease(): LoadedRelease {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: "1.2.3",
    gitCommit: "c".repeat(40),
    environmentPlaceholder: "qqenv-placeholderqq",
    templates: [],
    packages: [pkg(RUNTIME_ASSET, "runtime"), pkg(CONTROL_PLANE_ASSET, "control-plane")],
    images: { worker: WORKER_DIGEST, slack: SLACK_DIGEST },
  };
  return {
    manifest,
    dir: releaseDir,
    regions: () => [REGION],
    // The access part gets the real synthesized template; every other part a small stand-in that
    // still proves it was rendered for the right part/region/env (the export bundle's own job is
    // just to write whatever `release.template` returns, unchanged).
    template: (part, region, env) => (part === "access" ? accessTemplateText : JSON.stringify({ part, region, env })),
    packagePath: (assetId) => join(releaseDir, `${assetId}.zip`),
  };
}

function cognitoAnswers(overrides: Partial<DeployAnswers> = {}): DeployAnswers & { clientId?: string } {
  return {
    env: ENV,
    region: REGION,
    account: ACCOUNT,
    models: { orchestrator: "orchestrator-model", classifier: "classifier-model", worker: "worker-model" },
    identity: { mode: "cognito" },
    github: {
      account: "a-real-github-account",
      appId: "12345",
      installationId: "67890",
      privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-key",
    },
    ...overrides,
  };
}

/** Converts an IAM ARN pattern (`*` wildcard only) into a regex that matches the same set of ARNs. */
function arnPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

describe("writeExportBundle", () => {
  it("writes the documented layout for the environment and region", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-export-out-")), "bundle");
    const result = await writeExportBundle({ dir, answers: cognitoAnswers(), release: fakeRelease() });

    const expected = [
      "README.md",
      "deploy-access.sh",
      "packages/SHA256SUMS",
      `packages/${CONTROL_PLANE_ASSET}.zip`,
      `packages/${RUNTIME_ASSET}.zip`,
      "parameters/access.json",
      "parameters/control-plane.json",
      "parameters/foundation.json",
      "parameters/identity.json",
      "parameters/runtime.json",
      "parameters/slack.json",
      "policies/access-deployer.json",
      "policies/default-boundary.json",
      "policies/operator-role.json",
      "policies/service-role.json",
      "templates/access.template.json",
      "templates/control-plane.template.json",
      "templates/foundation.template.json",
      "templates/identity.template.json",
      "templates/runtime.template.json",
      "templates/slack.template.json",
    ].sort();
    expect(result.files).toEqual(expected);
    expect((await allFiles(dir)).sort()).toEqual(expected);

    expect(await readFile(join(dir, "templates/access.template.json"), "utf8")).toBe(accessTemplateText);
    const foundationTemplate = JSON.parse(await readFile(join(dir, "templates/foundation.template.json"), "utf8")) as unknown;
    expect(foundationTemplate).toEqual({ part: "foundation", region: REGION, env: ENV });

    const readmeText = await readFile(join(dir, "README.md"), "utf8");
    expect(readmeText).toContain(STACK_NAME);
    expect(readmeText).toContain(REGION);
    expect(readmeText).toContain(ACCOUNT);
    expect(readmeText).toContain("agentx init --resume");
    expect(readmeText).toContain("access-deployer.json");

    const sums = await readFile(join(dir, "packages/SHA256SUMS"), "utf8");
    // Sorted by asset id: RUNTIME_ASSET ("a"...) before CONTROL_PLANE_ASSET ("b"...).
    expect(sums).toBe(`${sha256(zipBytes[RUNTIME_ASSET]!)}  ${RUNTIME_ASSET}.zip\n${sha256(zipBytes[CONTROL_PLANE_ASSET]!)}  ${CONTROL_PLANE_ASSET}.zip\n`);
    expect(await readFile(join(dir, `packages/${RUNTIME_ASSET}.zip`))).toEqual(zipBytes[RUNTIME_ASSET]);
  });

  it("writes parameter files whose unknown values are markers, and never a secret value", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-export-out-")), "bundle");
    await writeExportBundle({ dir, answers: cognitoAnswers(), release: fakeRelease() });

    const paramsOf = async (part: string) => {
      const raw = JSON.parse(await readFile(join(dir, `parameters/${part}.json`), "utf8")) as Array<{ ParameterKey: string; ParameterValue: string }>;
      return Object.fromEntries(raw.map((p) => [p.ParameterKey, p.ParameterValue]));
    };

    const controlPlane = await paramsOf("control-plane");
    expect(controlPlane.CallbackSigningKey).toBe("{{secret:agentx/staging/callback-signing-key}}");
    expect(controlPlane.OidcIssuer).toBe("{{output:identity.Issuer}}");
    expect(controlPlane.OidcAudience).toBe("{{output:identity.Audience}}");
    expect(controlPlane.GitHubAppAccount).toBe("{{github:account}}");
    expect(controlPlane.GitHubAppId).toBe("{{github:appId}}");
    expect(controlPlane.GitHubAppInstallationId).toBe("{{github:installationId}}");
    expect(controlPlane.GitHubAppPrivateKeySecretArn).toBe("{{github:privateKeySecretArn}}");
    expect(controlPlane[`AssetParameters${CONTROL_PLANE_ASSET}Bucket`]).toBe("{{output:access.ArtifactBucketName}}");
    expect(controlPlane[`AssetParameters${CONTROL_PLANE_ASSET}Key`]).toBe(`packages/||${CONTROL_PLANE_ASSET}.zip`);
    expect(controlPlane[`AssetParameters${CONTROL_PLANE_ASSET}Hash`]).toBe(CONTROL_PLANE_ASSET);

    const runtime = await paramsOf("runtime");
    expect(runtime.ControlPlaneUrl).toBe("{{output:control-plane.ApiEndpoint}}");
    expect(runtime.CapacityProviderArn).toBe("{{output:foundation.CapacityProviderArn}}");
    expect(runtime.WorkerImageUri).toContain("{{output:access.PullThroughPrefix}}");
    expect(runtime.WorkerImageUri).toContain(`sha256:${"a".repeat(64)}`);

    const slack = await paramsOf("slack");
    expect(slack.VpcId).toBe("{{output:foundation.VpcId}}");
    expect(slack.SlackRequestQueueUrl).toBe("{{output:control-plane.SlackRequestQueueUrl}}");

    const access = await paramsOf("access");
    expect(access.PermissionsBoundaryArn).toBe("");
    expect(access.OperatorPrincipalArn).toBe("");

    // No file anywhere in the bundle contains a real (non-marker) CallbackSigningKey value, and no
    // text file contains a 40+ character run that looks like a generated key: base64url-random
    // text mixes upper case, lower case AND digits within any long span with overwhelming
    // probability, unlike this bundle's own long identifiers, which are either a pure-hex sha256
    // digest/asset id (no upper case) or a namey CamelCase/kebab-case AWS identifier (no digits).
    const suspiciousKeyRun = /[A-Za-z0-9_-]{40,}/g;
    for (const relativePath of await allFiles(dir)) {
      if (relativePath.endsWith(".zip")) continue;
      const text = await readFile(join(dir, relativePath), "utf8");
      expect(text).not.toMatch(/"ParameterKey"\s*:\s*"CallbackSigningKey"\s*,\s*"ParameterValue"\s*:\s*"(?!{{secret:)/);
      const runs = text.match(suspiciousKeyRun) ?? [];
      const generatedLooking = runs.filter((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run));
      expect(generatedLooking).toEqual([]);
    }
  });

  it("writes a deploy-access.sh that passes bash -n and names only the access stack", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-export-out-")), "bundle");
    await writeExportBundle({ dir, answers: cognitoAnswers(), release: fakeRelease() });

    const scriptPath = join(dir, "deploy-access.sh");
    const script = await readFile(scriptPath, "utf8");

    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain(STACK_NAME);
    for (const otherPart of ["foundation", "identity", "control-plane", "runtime", "slack"]) {
      expect(script).not.toContain(`agentx-${ENV}-${otherPart}`);
    }
    // Only the AWS CLI is used.
    expect(script).not.toMatch(/\bjq\b|\bpython/);
    // Never reads or prints a secret value: no call to Secrets Manager, and no reference to the
    // one secret parameter that exists elsewhere in this deploy (the access stack itself has none).
    expect(script).not.toMatch(/secretsmanager|get-secret-value/);
    expect(script).not.toContain("CallbackSigningKey");
    expect(script).not.toContain("{{secret:");
    // Every variable reference is braced (no bare `$NAME`, a common way to leave one unquoted).
    expect(script).not.toMatch(/[^$"(]\$[A-Za-z_][A-Za-z0-9_]*\b(?!\()/);
    // Every CLI flag that takes one of the script's own variables passes it as a single, fully
    // double-quoted argument (word-splitting- and globbing-safe), never bare.
    const flagLines = script.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("--"));
    expect(flagLines.length).toBeGreaterThan(0);
    for (const line of flagLines) {
      if (!/\$\{(STACK_NAME|CHANGE_SET_NAME)\}/.test(line)) continue;
      expect(line).toMatch(/^--[\w-]+ "\$\{(STACK_NAME|CHANGE_SET_NAME)\}" ?\\?$/);
    }

    expect(() => execFileSync("bash", ["-n", scriptPath])).not.toThrow();
    const info = await stat(scriptPath);
    expect(info.mode & 0o111).not.toBe(0);
  });

  it("writes policies with concrete account and region, and the access deployer policy scoped to the environment", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "agentx-export-out-")), "bundle");
    await writeExportBundle({ dir, answers: cognitoAnswers(), release: fakeRelease() });

    const readJson = async (relativePath: string) => JSON.parse(await readFile(join(dir, relativePath), "utf8")) as { Version: string; Statement: Array<{ Sid: string; Effect: string; Action: string[]; Resource: string | string[] }> };

    for (const name of ["service-role", "operator-role", "default-boundary", "access-deployer"]) {
      const text = await readFile(join(dir, `policies/${name}.json`), "utf8");
      expect(text).not.toContain('"Ref"');
      expect(text).not.toContain("AWS::");
      expect(text).toContain(ACCOUNT);
    }

    const serviceRole = await readJson("policies/service-role.json");
    expect(serviceRole.Version).toBe("2012-10-17");
    const iamRoles = serviceRole.Statement.find((s) => s.Sid === "IamRoles")!;
    expect([iamRoles.Resource].flat()).toEqual([`arn:aws:iam::${ACCOUNT}:role/agentx/${ENV}/*`]);

    const operatorRole = await readJson("policies/operator-role.json");
    const stacks = operatorRole.Statement.find((s) => s.Sid === "Stacks")!;
    expect([stacks.Resource].flat()).toContain(`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${STACK_NAME}/*`);

    const defaultBoundary = await readJson("policies/default-boundary.json");
    expect(defaultBoundary.Statement.some((s) => s.Sid === "Services")).toBe(true);

    // --- ruling (a): the access-deployer policy must cover every named IAM role, the managed
    // policy, and the bucket the access stack's REAL synthesized template actually declares. ---
    const accessDeployer = await readJson("policies/access-deployer.json");
    const byName = (action: string, resource: string) =>
      accessDeployer.Statement.some((s) => s.Effect === "Allow" && s.Action.includes(action) && [s.Resource].flat().some((r) => arnPatternToRegex(r).test(resource)));

    const template = JSON.parse(accessTemplateText) as { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
    const roles = Object.values(template.Resources).filter((r) => r.Type === "AWS::IAM::Role");
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const roleName = role.Properties!.RoleName as string;
      const roleArn = `arn:aws:iam::${ACCOUNT}:role/${roleName}`;
      expect(byName("iam:CreateRole", roleArn) || accessDeployer.Statement.some((s) => [s.Resource].flat().some((r) => arnPatternToRegex(r).test(roleArn)) && s.Action.some((a) => a.includes("Role")))).toBe(true);
    }

    const managedPolicies = Object.values(template.Resources).filter((r) => r.Type === "AWS::IAM::ManagedPolicy");
    expect(managedPolicies.length).toBeGreaterThan(0);
    for (const policy of managedPolicies) {
      const name = policy.Properties!.ManagedPolicyName as string;
      const path = policy.Properties!.Path as string;
      const policyArn = `arn:aws:iam::${ACCOUNT}:policy${path}${name}`;
      expect(accessDeployer.Statement.some((s) => [s.Resource].flat().some((r) => arnPatternToRegex(r).test(policyArn)) && s.Action.includes("iam:CreatePolicy"))).toBe(true);
    }

    const buckets = Object.values(template.Resources).filter((r) => r.Type === "AWS::S3::Bucket");
    expect(buckets.length).toBe(1);
    // The bucket declares no BucketName: CloudFormation names it itself at deploy time as
    // "<StackName>-<LogicalID>-<uniqueID>" (verified against the CloudFormation user guide), so its
    // real name always starts with the stack's own name. The bucket statement's resource pattern
    // must be exactly that prefix plus a wildcard for the policy to actually cover it.
    expect(buckets[0]!.Properties?.BucketName).toBeUndefined();
    const bucketStatement = accessDeployer.Statement.find((s) => s.Sid === "ArtifactBucket")!;
    expect(bucketStatement.Action).toEqual(expect.arrayContaining(["s3:CreateBucket*", "s3:PutBucket*"]));
    expect([bucketStatement.Resource].flat()).toEqual([`arn:aws:s3:::${STACK_NAME}-*`]);

    const pullThrough = accessDeployer.Statement.find((s) => s.Sid === "PullThroughCache")!;
    expect(pullThrough.Action.sort()).toEqual(["ecr:CreatePullThroughCacheRule", "ecr:DeletePullThroughCacheRule"]);
  });

  it("refuses a non-empty directory and an uncovered region, writing nothing", async () => {
    const nonEmptyDir = await mkdtemp(join(tmpdir(), "agentx-export-nonempty-"));
    await writeFile(join(nonEmptyDir, "already-here.txt"), "hi");
    await expect(writeExportBundle({ dir: nonEmptyDir, answers: cognitoAnswers(), release: fakeRelease() })).rejects.toThrow(/is not empty/);
    expect(await readdir(nonEmptyDir)).toEqual(["already-here.txt"]);

    const absentDir = join(await mkdtemp(join(tmpdir(), "agentx-export-absent-")), "bundle");
    await expect(writeExportBundle({ dir: absentDir, answers: cognitoAnswers({ region: OTHER_REGION }), release: fakeRelease() })).rejects.toThrow(/does not cover region eu-west-1/);
    await expect(readdir(absentDir)).rejects.toThrow();
  });

  it("makes no AWS calls at all", async () => {
    expect(writeExportBundle.length).toBe(1);

    const dir = join(await mkdtemp(join(tmpdir(), "agentx-export-out-")), "bundle");
    const savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AWS_")) delete process.env[key];
    }
    try {
      const result = await writeExportBundle({ dir, answers: cognitoAnswers(), release: fakeRelease() });
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      process.env = savedEnv;
    }
  });
});

describe("the access template this bundle deploys", () => {
  it("stays under CloudFormation's 51,200-byte inline template-body limit", () => {
    expect(Buffer.byteLength(accessTemplateText, "utf8")).toBeLessThan(51_200);
  });

  it("has no asset parameters or other reference to packages in the bucket it creates itself", () => {
    expect(accessTemplateText).not.toContain("AssetParameters");
    expect(accessTemplateText).not.toContain("BootstrapVersion");
  });
});
