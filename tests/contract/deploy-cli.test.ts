// `agentx deploy` and `agentx init --export`: executeCli end to end, with every AWS-facing piece
// injected through CliDependencies.deploy (main.ts follows the same pattern env commands use). No
// AWS is ever touched by any test here.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import type { CallerIdentity } from "../../packages/cli/src/environments/adopt.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "../../packages/cli/src/deploy/deployer.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import type { SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import type { DeployCliDependencies } from "../../packages/cli/src/deploy/commands.js";
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

// ---- temp directories: tracked and removed after every test -------------------------------------

const tempDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A release directory with no templates/packages: enough for `loadRelease` and for
 * `deployEnvironment` (which only reads `release.manifest.version`), never for the real templates
 * engine (which the fake `StackDeployer` below always replaces in these tests). */
async function emptyReleaseDir(): Promise<string> {
  const dir = await tmp("agentx-deploy-cli-release-");
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
  const dir = await tmp("agentx-deploy-cli-release-full-");
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
  const dir = await tmp("agentx-deploy-cli-answers-");
  const path = join(dir, "answers.json");
  await writeFile(path, JSON.stringify(answersJson(overrides)));
  return path;
}

const fakeIdentity: CallerIdentity = { async get() { return { account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/alice` }; } };
const throwingIdentity: CallerIdentity = { async get() { throw new Error("test setup: sts must not be called"); } };
const throwingStore: ParameterStore = {
  get: () => { throw new Error("test setup: the parameter store must not be called"); },
  put: () => { throw new Error("test setup: the parameter store must not be called"); },
  delete: () => { throw new Error("test setup: the parameter store must not be called"); },
  list: () => { throw new Error("test setup: the parameter store must not be called"); },
};
const throwingDeployer: StackDeployer = {
  deploy: () => { throw new Error("test setup: the deployer must not be called"); },
  outputs: () => { throw new Error("test setup: the deployer must not be called"); },
};

function unexpectedAwsCall(): never {
  throw new Error("unexpected AWS call in test");
}

/**
 * `agentx deploy`'s dependency overrides, with `identity`, `store` and `secrets` always present and
 * throwing "unexpected AWS call in test" by default: `runDeploy` falls back to constructing *real*
 * STS/SSM/SecretsManager clients for whichever of these a test omits, so a deploy test that forgets
 * one no longer silently risks reaching them (and, through them, real AWS) — it fails loudly instead,
 * the moment that fake is actually invoked. `overrides` replaces any of these three, and adds
 * whichever of `deployer`/`commandRunner`/`confirm`/`isInteractive`/`now` the test needs; every
 * `describe("agentx deploy", ...)` test builds its dependencies through this helper.
 */
function safeDeployDeps(overrides: DeployCliDependencies = {}): DeployCliDependencies {
  return {
    identity: { get: () => unexpectedAwsCall() },
    store: {
      get: () => unexpectedAwsCall(),
      put: () => unexpectedAwsCall(),
      delete: () => unexpectedAwsCall(),
      list: () => unexpectedAwsCall(),
    },
    secrets: {
      get: () => unexpectedAwsCall(),
      create: () => unexpectedAwsCall(),
    },
    ...overrides,
  };
}

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

/** A CommandRunner faking a clean checkout at the release's tag: `git status --porcelain` empty,
 * `git tag --points-at HEAD` includes `v<RELEASE_VERSION>`. `npx cdk deploy ... --outputs-file <f>`
 * writes `scripted` to whatever file it's asked for (a superset every time; `cdkDeployer.deploy`
 * only ever reads its own stack's key back out), and records the outputs directory it saw so a test
 * can confirm it's removed afterward. */
function cleanCdkRunner(scripted: Record<string, StackOutputs>): CommandRunner & { outputsDir?: string } {
  const runner: CommandRunner & { outputsDir?: string } = {
    outputsDir: undefined,
    async run(command, args) {
      if (command === "git") {
        if (args[0] === "status") return { stdout: "" };
        return { stdout: `v${RELEASE_VERSION}\n` };
      }
      const outIndex = args.indexOf("--outputs-file");
      if (outIndex >= 0) {
        const outputsFile = args[outIndex + 1] as string;
        runner.outputsDir = dirname(outputsFile);
        await writeFile(outputsFile, JSON.stringify(scripted));
      }
      return { stdout: "" };
    },
  };
  return runner;
}

describe("agentx init --export", () => {
  it("writes a bundle and makes no AWS write call", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
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

  it("without an explicit --env refuses: the default is the live production environment", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity, store: throwingStore } },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--env");
    await expect(stat(exportDir)).rejects.toThrow();
  });

  it("refuses --env production explicitly: that name belongs to the legacy deployment", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", "production", "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity, store: throwingStore } },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("production");
    await expect(stat(exportDir)).rejects.toThrow();
  });

  it("takes the account from sts GetCallerIdentity when --account is omitted", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const stsAccount = "999999999999";
    const identity: CallerIdentity = { async get() { return { account: stsAccount, arn: `arn:aws:iam::${stsAccount}:user/bot` }; } };
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--release", releaseDir],
      { ...io, deploy: { identity } },
    );

    expect(code).toBe(0);
    const policyText = await readFile(join(exportDir, "policies", "access-deployer.json"), "utf8");
    expect(policyText).toContain(stsAccount);
  });

  it("--identity oidc without --oidc-issuer refuses", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir, "--identity", "oidc", "--oidc-audience", "api://agentx"],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--oidc-issuer and --oidc-audience are required with --identity oidc");
  });

  it("refuses an invalid --region before writing anything", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", "not-a-region", "--account", ACCOUNT, "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--region not-a-region");
    await expect(stat(exportDir)).rejects.toThrow();
  });

  it("refuses an invalid --account before writing anything", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", "not-an-account", "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--account not-an-account");
    await expect(stat(exportDir)).rejects.toThrow();
  });
});

describe("agentx deploy", () => {
  it("refuses answers that do not match the schema, naming the field", async () => {
    const answersPath = await writeAnswers({ region: undefined });
    const io = capture();

    const code = await executeCli(["deploy", "--mode", "install", "--release", "/nonexistent-release", "--answers", answersPath, "--yes"], { ...io, deploy: safeDeployDeps() });

    expect(code).toBe(2);
    expect(io.err.join("")).toBe(`AgentX error [CONFIG_INVALID]: answers file ${answersPath} is invalid: region Invalid input: expected string, received undefined\n`);
  });

  it("--engine cdk requires --source", async () => {
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", "/nonexistent", "--answers", "/nonexistent.json", "--yes"],
      { ...io, deploy: safeDeployDeps() },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--source is required for --engine cdk");
  });

  it("--engine cdk without --yes refuses (no change-set review to confirm)", async () => {
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", "/nonexistent", "--answers", "/nonexistent.json", "--source", "/nonexistent-source"],
      { ...io, deploy: safeDeployDeps() },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("--engine cdk has no change set review; pass --yes to deploy with cdk");
  });

  it("refuses when stdin is not a terminal and --yes is missing, before touching AWS", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath],
      { ...io, deploy: safeDeployDeps({ isInteractive: () => false }) },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("agentx deploy needs --yes when stdin is not a terminal");
  });

  it("--engine cdk refuses a source checkout with uncommitted changes, before deploying anything", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const dirtyRunner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args[0] === "status") return { stdout: " M some/file.ts\n" };
        return { stdout: "" };
      },
    };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", releaseDir, "--answers", answersPath, "--source", "/some/source", "--yes"],
      // assertSourceAtRelease (a dirty tree) refuses before assertCdkBootstrapped ever reads the
      // store: the default throwing store is never touched.
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, commandRunner: dirtyRunner }) },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("has uncommitted changes");
  });

  it("--engine cdk refuses when CDK is not bootstrapped in the region", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const cleanRunner: CommandRunner = {
      async run(command, args) {
        if (command === "git") {
          if (args[0] === "status") return { stdout: "" };
          return { stdout: `v${RELEASE_VERSION}\n` };
        }
        return { stdout: "" };
      },
    };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", releaseDir, "--answers", answersPath, "--source", "/some/source", "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), commandRunner: cleanRunner }) },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("CDK is not bootstrapped in");
  });

  it("--engine cdk removes its outputs temp directory after the deploy finishes", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const store = new MemoryParameterStore();
    await store.put("/cdk-bootstrap/hnb659fds/version", "21");
    const runner = cleanCdkRunner(scriptedOutputs());
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", releaseDir, "--answers", answersPath, "--source", "/some/source", "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store, secrets: memorySecrets(), commandRunner: runner }) },
    );

    expect(code).toBe(0);
    expect(runner.outputsDir).toBeDefined();
    await expect(stat(runner.outputsDir as string)).rejects.toThrow();
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
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store, secrets, deployer }) },
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
        deploy: safeDeployDeps({
          identity: fakeIdentity,
          store,
          secrets,
          deployer,
          confirm: async (event) => {
            confirmCalls.push(event.stackName);
            return event.stackName === stackName("access");
          },
        }),
      },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("not executed; confirmation declined");
    expect(confirmCalls).toEqual([stackName("access"), stackName("foundation")]);
    expect(deployer.calls).toEqual(["access", "foundation"]);
  });

  it("refuses when --env does not match the answers file's environment, naming both", async () => {
    const answersPath = await writeAnswers(); // env: "staging"
    const io = capture();

    const code = await executeCli(
      // The mismatch is caught right after the answers file loads, before identity/store/secrets are
      // ever touched: safeDeployDeps' throwing defaults prove that (no overrides needed at all).
      ["--env", "otherenv", "deploy", "--mode", "install", "--release", "/nonexistent-release", "--answers", answersPath, "--yes"],
      { ...io, deploy: safeDeployDeps() },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("otherenv");
    expect(io.err.join("")).toContain(ENV);
  });

  it("an omitted --env, or one that explicitly matches the answers file, still works", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();

    const omitted = capture();
    const codeOmitted = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...omitted, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer: progressFakeDeployer(scriptedOutputs()) }) },
    );
    expect(codeOmitted).toBe(0);

    const matching = capture();
    const codeMatching = await executeCli(
      ["--env", ENV, "deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...matching, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer: progressFakeDeployer(scriptedOutputs()) }) },
    );
    expect(codeMatching).toBe(0);
  });

  it("refuses when the answers file's partition disagrees with the caller identity's own ARN partition", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers({ partition: "aws-us-gov" });
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      {
        ...io,
        // The mismatch is caught right after identity resolves (needed for the real partition) but
        // before store/secrets/deployer are ever touched: safeDeployDeps' throwing store/secrets
        // defaults, plus an explicit throwing deployer, prove that.
        deploy: safeDeployDeps({ identity: fakeIdentity, deployer: throwingDeployer }), // arn:aws:... -> partition "aws"
      },
    );

    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("aws-us-gov");
    expect(io.err.join("")).toContain("aws");
  });
});
