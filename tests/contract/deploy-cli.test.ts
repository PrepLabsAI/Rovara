// `agentx deploy` and `agentx init --export`: executeCli end to end, with every AWS-facing piece
// injected through CliDependencies.deploy (main.ts follows the same pattern env commands use). No
// AWS is ever touched by any test here.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import type { CallerIdentity } from "../../packages/cli/src/environments/adopt.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "staging";
const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const RELEASE_VERSION = "1.2.3";
const stackName = (part: string) => environmentStackName(ENV, part as never);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) } };
}

/** A release directory with no templates/packages: enough for `loadRelease` and for
 * `deployEnvironment` (which only reads `release.manifest.version`), never for the real templates
 * engine (which the fake `StackDeployer` below always replaces in these tests). */
async function emptyReleaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-deploy-cli-release-"));
  await writeFile(
    join(dir, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: RELEASE_VERSION,
      gitCommit: "a".repeat(40),
      environmentPlaceholder: "qqenv-placeholderqq",
      templates: [],
      packages: [],
      images: {},
    }),
  );
  return dir;
}

/** A release directory whose templates and images are real enough for `writeExportBundle` (which
 * reads every part's template and, for runtime/slack, a real image digest) to succeed with no
 * `StackDeployer` involved at all. */
async function fullReleaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-deploy-cli-release-full-"));
  const parts = ["access", "foundation", "identity", "control-plane", "runtime", "slack"];
  const templates = [];
  await mkdir(join(dir, "templates", REGION), { recursive: true });
  for (const part of parts) {
    const content = "{}";
    const file = `templates/${REGION}/${part}.template.json`;
    await writeFile(join(dir, file), content);
    templates.push({ region: REGION, part, file, sha256: sha256(content) });
  }
  await writeFile(
    join(dir, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: RELEASE_VERSION,
      gitCommit: "a".repeat(40),
      environmentPlaceholder: "qqenv-placeholderqq",
      templates,
      packages: [],
      images: {
        worker: `public.ecr.aws/agentx/worker@sha256:${"a".repeat(64)}`,
        slack: `public.ecr.aws/agentx/slack@sha256:${"b".repeat(64)}`,
      },
    }),
  );
  return dir;
}

function answersJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: ENV,
    region: REGION,
    account: ACCOUNT,
    models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
    identity: { mode: "cognito" },
    github: { account: "acme", appId: "123", installationId: "456", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
    // Testing-only override (parameters.ts): lets stackParameters resolve runtime/slack's image
    // parameters without needing a real release image digest, since `emptyReleaseDir` has none.
    images: {
      worker: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agentx/worker@sha256:${"a".repeat(64)}`,
      slack: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agentx/slack@sha256:${"b".repeat(64)}`,
    },
    ...overrides,
  };
}

async function writeAnswers(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-deploy-cli-answers-"));
  const path = join(dir, "answers.json");
  await writeFile(path, JSON.stringify(answersJson(overrides)));
  return path;
}

const fakeIdentity: CallerIdentity = { async get() { return { account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/alice` }; } };
const throwingIdentity: CallerIdentity = { async get() { throw new Error("test setup: sts must not be called"); } };

function memorySecrets(): SecretValueStore & { creates: Array<{ name: string; value: string }> } {
  const values = new Map<string, string>();
  const creates: Array<{ name: string; value: string }> = [];
  return {
    creates,
    async get(name) { return values.get(name); },
    async create(name, value) { creates.push({ name, value }); values.set(name, value); },
  };
}

/** Every part's scripted outputs, exactly enough for `stackParameters` and settings-writing to succeed. */
function scriptedOutputs(): Record<string, StackOutputs> {
  return {
    [stackName("access")]: {
      ArtifactBucketName: "agentx-staging-access-artifactbucket-abc",
      CloudFormationRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx-staging-cloudformation`,
      OperatorRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx-staging-operator`,
      PullThroughPrefix: "agentx-staging",
    },
    [stackName("foundation")]: {
      CapacityProviderArn: `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:capacity-provider/agentx_staging_capacity-AbCdEfGhIj`,
      VpcId: "vpc-0123456789abcdef0",
      PrivateSubnetIds: "subnet-1,subnet-2",
    },
    [stackName("identity")]: {
      Issuer: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_abc`,
      Audience: "client123",
      ClientId: "client123",
    },
    [stackName("control-plane")]: {
      ApiEndpoint: `https://abc.execute-api.${REGION}.amazonaws.com`,
      SlackOrchestratorTaskRoleArn: `arn:aws:iam::${ACCOUNT}:role/agentx-staging-control-plane-SlackTask`,
      SlackRequestQueueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/q.fifo`,
      SlackThreadsTableName: "t",
      TurnRecordsTableName: "tr",
      SlackThreadSessionBucketName: "b",
      SlackSecretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:SlackSecret-x`,
    },
    [stackName("runtime")]: { RuntimeArn: "arn:runtime" },
    [stackName("slack")]: { OrchestratorArn: "arn:slack" },
  };
}

/** Emits a realistic run of progress events per stack (never a parameter value: only the
 * DeployEvent fields a real engine would emit) and returns the scripted outputs. */
function progressFakeDeployer(scripted: Record<string, StackOutputs>): StackDeployer & { calls: DeployRequest[] } {
  const calls: DeployRequest[] = [];
  return {
    calls,
    async deploy(request) {
      calls.push(request);
      request.onEvent?.({ kind: "uploading", what: `template ${request.part}` });
      request.onEvent?.({ kind: "changes", stackName: request.stackName, changes: [{ action: "Add", logicalId: "X", type: "AWS::X", replacement: "" }] });
      request.onEvent?.({ kind: "deploying", stackName: request.stackName });
      const result = scripted[request.stackName];
      if (result === undefined) throw new Error(`test setup: no scripted outputs for ${request.stackName}`);
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return result;
    },
    async outputs(name) { return scripted[name]; },
  };
}

/** Mimics the templates engine's own confirm handshake (templates-engine.ts): emits "changes", then
 * calls `request.confirm` and refuses exactly the way the real engine does when it is declined. */
function confirmingFakeDeployer(scripted: Record<string, StackOutputs>): StackDeployer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async deploy(request) {
      calls.push(request.part);
      request.onEvent?.({ kind: "changes", stackName: request.stackName, changes: [] });
      if (request.confirm !== undefined) {
        const proceed = await request.confirm({ stackName: request.stackName, changes: [] });
        if (!proceed) throw new Error(`deploy of ${request.stackName} not executed; confirmation declined`);
      }
      request.onEvent?.({ kind: "deploying", stackName: request.stackName });
      const result = scripted[request.stackName];
      if (result === undefined) throw new Error(`test setup: no scripted outputs for ${request.stackName}`);
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return result;
    },
    async outputs(name) { return scripted[name]; },
  };
}

describe("agentx init --export", () => {
  it("writes a bundle and makes no AWS write call", async () => {
    const releaseDir = await fullReleaseDir();
    const parent = await mkdtemp(join(tmpdir(), "agentx-deploy-cli-export-"));
    const exportDir = join(parent, "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain(exportDir);
    const files = await readdir(exportDir);
    expect(files).toContain("deploy-access.sh");
    expect(files).toContain("README.md");
    expect(files).toContain("templates");
  });

  it("without --export explains how to proceed and exits non-zero", async () => {
    const io = capture();

    const code = await executeCli(["init"], { ...io });

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("interactive install arrives in a later AgentX release; use agentx init --export or agentx deploy");
  });
});

describe("agentx deploy", () => {
  it("refuses answers that do not match the schema, naming the field", async () => {
    const answersPath = await writeAnswers({ region: undefined });
    const io = capture();

    const code = await executeCli(["deploy", "--mode", "install", "--release", "/nonexistent-release", "--answers", answersPath, "--yes"], { ...io });

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("region");
  });

  it("--engine cdk requires --source", async () => {
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", "/nonexistent", "--answers", "/nonexistent.json", "--yes"],
      { ...io },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--source is required for --engine cdk");
  });

  it("--engine cdk without --yes refuses (no change-set review to confirm)", async () => {
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", "/nonexistent", "--answers", "/nonexistent.json", "--source", "/nonexistent-source"],
      { ...io },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--engine cdk has no change set review; pass --yes to deploy with cdk");
  });

  it("prints progress and never a parameter value", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const deployer = progressFakeDeployer(scriptedOutputs());
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...io, deploy: { identity: fakeIdentity, store, secrets, deployer } },
    );

    expect(code).toBe(0);
    expect(secrets.creates).toHaveLength(1);
    const secretValue = secrets.creates[0]!.value;
    expect(secretValue.length).toBeGreaterThanOrEqual(32);
    const combined = io.out.join("") + io.err.join("");
    expect(combined).not.toContain(secretValue);
    expect(io.err.join("")).toContain(`changes ${stackName("access")}`);
    expect(io.err.join("")).toContain(`deployed ${stackName("access")}`);
  });

  it("without --yes asks before executing each change set and stops when refused", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const store = new MemoryParameterStore();
    const secrets = memorySecrets();
    const deployer = confirmingFakeDeployer(scriptedOutputs());
    const confirmCalls: string[] = [];
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath],
      {
        ...io,
        deploy: {
          identity: fakeIdentity,
          store,
          secrets,
          deployer,
          confirm: async (event) => {
            confirmCalls.push(event.stackName);
            return event.stackName === stackName("access");
          },
        },
      },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("not executed; confirmation declined");
    expect(confirmCalls).toEqual([stackName("access"), stackName("foundation")]);
    expect(deployer.calls).toEqual(["access", "foundation"]);
  });
});
