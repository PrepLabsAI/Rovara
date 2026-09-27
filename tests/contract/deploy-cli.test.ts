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
import type { TemplatesEngineClients } from "../../packages/cli/src/deploy/templates-engine.js";
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

/** A release directory with no packages and one placeholder template per part for REGION only:
 * enough for `loadRelease`, for `runDeploy`'s check that the release covers the answers' region,
 * and for `deployEnvironment` (which only reads `release.manifest.version`), never for the real
 * templates engine (which the fake `StackDeployer` below always replaces in these tests). */
async function emptyReleaseDir(): Promise<string> {
  const dir = await tmp("agentx-deploy-cli-release-");
  const templates = [];
  await mkdir(join(dir, "templates", REGION), { recursive: true });
  for (const part of ["access", "foundation", "identity", "control-plane", "runtime", "slack"]) {
    const file = `templates/${REGION}/${part}.template.json`;
    await writeFile(join(dir, file), "{}");
    templates.push({ region: REGION, part, file, sha256: sha256("{}") });
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
    stackOutputs: () => unexpectedAwsCall(),
    templatesClients: {
      cloudFormation: { send: () => unexpectedAwsCall() } as unknown as TemplatesEngineClients["cloudFormation"],
      s3: { send: () => unexpectedAwsCall() } as unknown as TemplatesEngineClients["s3"],
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
      SessionManagerSecurityGroupId: "sg-0123456789abcdef0",
      WorkspaceKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/k",
      Ec2WorkerInstanceRoleArn: "arn:aws:iam::123456789012:role/agentx/staging/worker",
      Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
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

  const OIDC_FLAGS: Record<string, string> = {
    "--oidc-issuer": "https://idp.example.com",
    "--oidc-audience": "api://agentx",
    "--oidc-client-id": "cli-client",
    "--admin-claim": "groups",
    "--admin-values": "agentx-admins",
  };

  for (const missing of Object.keys(OIDC_FLAGS)) {
    it(`--identity oidc without ${missing} refuses with CONFIG_INVALID naming it, writing nothing`, async () => {
      const releaseDir = await fullReleaseDir();
      const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
      const flags = Object.entries(OIDC_FLAGS).filter(([flag]) => flag !== missing).flat();
      const io = capture();

      const code = await executeCli(
        ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir, "--identity", "oidc", ...flags],
        { ...io, deploy: { identity: throwingIdentity } },
      );

      expect(code).toBe(2);
      expect(io.err.join("")).toBe(`AgentX error [CONFIG_INVALID]: --identity oidc requires ${missing}\n`);
      await expect(stat(exportDir)).rejects.toThrow();
    });
  }

  it("--identity oidc refuses --admin-values with no value in it", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const flags = Object.entries({ ...OIDC_FLAGS, "--admin-values": " , " }).flat();
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir, "--identity", "oidc", ...flags],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toBe("AgentX error [CONFIG_INVALID]: --identity oidc requires --admin-values\n");
  });

  it("--identity oidc with every flag writes a bundle", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--account", ACCOUNT, "--release", releaseDir, "--identity", "oidc", ...Object.entries(OIDC_FLAGS).flat()],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(0);
  });

  it("maps missing AWS credentials while reading the caller's account to AUTH_REQUIRED", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const missing = Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", REGION, "--release", releaseDir],
      { ...io, deploy: { identity: { async get() { throw missing; } } } },
    );

    expect(code).toBe(3);
    expect(io.err.join("")).toBe("AgentX error [AUTH_REQUIRED]: AWS credentials missing or expired: Could not load credentials from any providers\n");
    await expect(stat(exportDir)).rejects.toThrow();
  });

  it("refuses a region the release does not cover with CONFIG_INVALID", async () => {
    const releaseDir = await fullReleaseDir();
    const exportDir = join(await tmp("agentx-deploy-cli-export-"), "bundle");
    const io = capture();

    const code = await executeCli(
      ["--env", ENV, "init", "--export", exportDir, "--region", "eu-west-1", "--account", ACCOUNT, "--release", releaseDir],
      { ...io, deploy: { identity: throwingIdentity } },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("[CONFIG_INVALID]");
    expect(io.err.join("")).toContain("eu-west-1");
    await expect(stat(exportDir)).rejects.toThrow();
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

  it("--engine cdk builds the tagged source (npm ci, npm run build) before any cdk deploy, and runs the installed CDK CLI", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const store = new MemoryParameterStore();
    await store.put("/cdk-bootstrap/hnb659fds/version", "21");
    const inner = cleanCdkRunner(scriptedOutputs());
    const calls: Array<{ line: string; display: string; cwd: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ line: [command, ...args.slice(0, 3)].join(" "), display: options.display, cwd: options.cwd });
        return inner.run(command, args, options);
      },
    };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", releaseDir, "--answers", answersPath, "--source", "/some/source", "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store, secrets: memorySecrets(), commandRunner: runner }) },
    );

    expect(code).toBe(0);
    expect(calls.slice(0, 5).map((call) => call.line)).toEqual([
      "git status --porcelain",
      "git tag --points-at HEAD",
      "npm ci",
      "npm run build",
      "npx --no-install cdk deploy",
    ]);
    expect(calls[2]).toMatchObject({ display: "npm ci", cwd: "/some/source" });
    expect(calls[3]).toMatchObject({ display: "npm run build", cwd: "/some/source" });
    expect(calls.slice(4).every((call) => call.line === "npx --no-install cdk deploy")).toBe(true);
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

  /** A lock, key or deploy would each hit one of these: store and secrets throw on any call. */
  function refusesBeforeAnyWrite(identity: CallerIdentity = fakeIdentity): DeployCliDependencies {
    return safeDeployDeps({ identity, deployer: throwingDeployer });
  }

  it("refuses when the caller's account is not the answers file's account, naming both, before the lock, the key or any deploy", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers({ account: "111111111111" });
    const io = capture();

    const code = await executeCli(["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"], { ...io, deploy: refusesBeforeAnyWrite() });

    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("[CONFIG_INVALID]");
    expect(err).toContain("111111111111");
    expect(err).toContain(ACCOUNT);
  });

  it("refuses a region the release does not cover, listing the supported regions, before the lock, the key or any deploy", async () => {
    const releaseDir = await emptyReleaseDir(); // covers us-east-1 only
    const answersPath = await writeAnswers({ region: "eu-west-1" });
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...io, deploy: refusesBeforeAnyWrite(throwingIdentity) },
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toBe(`AgentX error [CONFIG_INVALID]: release ${RELEASE_VERSION} does not cover region eu-west-1; it covers: us-east-1\n`);
  });

  const oidcIdentity = { mode: "oidc", issuer: "https://idp.example.com", audience: "api://agentx", adminClaim: "groups", adminValues: ["agentx-admins"], clientId: "cli-client" };

  for (const [label, identity, field] of [
    ["no adminClaim", { ...oidcIdentity, adminClaim: undefined }, "identity.adminClaim"],
    ["an empty adminClaim", { ...oidcIdentity, adminClaim: "" }, "identity.adminClaim"],
    ["no adminValues", { ...oidcIdentity, adminValues: undefined }, "identity.adminValues"],
    ["empty adminValues", { ...oidcIdentity, adminValues: [] }, "identity.adminValues"],
    ["no clientId", { ...oidcIdentity, clientId: undefined }, "identity.clientId"],
  ] as const) {
    it(`refuses your own OIDC provider with ${label}, naming the field, before the lock, the key or any deploy`, async () => {
      const releaseDir = await emptyReleaseDir();
      const answersPath = await writeAnswers({ identity });
      const io = capture();

      const code = await executeCli(
        ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
        { ...io, deploy: refusesBeforeAnyWrite(throwingIdentity) },
      );

      expect(code).toBe(2);
      expect(io.err.join("")).toContain(`answers file ${answersPath} is invalid: ${field}`);
    });
  }

  it("accepts your own OIDC provider with adminClaim, adminValues and clientId", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers({ identity: oidcIdentity });
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer: progressFakeDeployer(scriptedOutputs()) }) },
    );

    expect(code).toBe(0);
  });

  for (const [label, error] of [
    ["a missing credential chain", Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" })],
    ["an expired token", Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredToken" })],
    ["an expired token exception", Object.assign(new Error("token expired"), { name: "ExpiredTokenException" })],
    ["an invalid access key", Object.assign(new Error("The security token included in the request is invalid."), { name: "InvalidClientTokenId" })],
    ["an unrecognized client", Object.assign(new Error("The security token included in the request is invalid."), { name: "UnrecognizedClientException" })],
    ["a bad signature", Object.assign(new Error("The request signature we calculated does not match"), { name: "SignatureDoesNotMatch" })],
    ["an expired login session", new Error("Your session has expired. Please reauthenticate using 'aws login'.")],
  ] as const) {
    it(`maps ${label} to AUTH_REQUIRED`, async () => {
      const releaseDir = await emptyReleaseDir();
      const answersPath = await writeAnswers();
      const io = capture();

      const code = await executeCli(
        ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
        { ...io, deploy: refusesBeforeAnyWrite({ async get() { throw error; } }) },
      );

      expect(code).toBe(3);
      expect(io.err.join("")).toBe(`AgentX error [AUTH_REQUIRED]: AWS credentials missing or expired: ${error.message}\n`);
    });
  }

  it("maps a credential failure wrapped as another error's cause to AUTH_REQUIRED too", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredToken" });
    const deployer: StackDeployer = {
      deploy: async () => { throw new Error("could not read something: The security token included in the request is expired", { cause: expired }); },
      outputs: async () => undefined,
    };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer }) },
    );

    expect(code).toBe(3);
    expect(io.err.join("")).toContain("[AUTH_REQUIRED]: AWS credentials missing or expired: could not read something");
  });

  it("maps an AWS access denial to FORBIDDEN", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const denied = Object.assign(new Error("User: arn:aws:iam::123456789012:user/alice is not authorized to perform: cloudformation:CreateChangeSet"), { name: "AccessDenied" });
    const deployer: StackDeployer = { deploy: async () => { throw denied; }, outputs: async () => undefined };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer }) },
    );

    expect(code).toBe(4);
    expect(io.err.join("")).toBe(`AgentX error [FORBIDDEN]: AWS denied the request: ${denied.message}\n`);
  });

  it("when settings were not written, prints the deployed and missing parts and the exact resume command", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const scripted = scriptedOutputs();
    // Only the parts this run deploys exist: nothing else answers an outputs probe.
    const deployed = new Set<string>();
    const deployer: StackDeployer = {
      async deploy(request) {
        deployed.add(request.stackName);
        return scripted[request.stackName]!;
      },
      async outputs(name) { return deployed.has(name) ? scripted[name] : undefined; },
    };
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--release", releaseDir, "--answers", answersPath, "--parts", "access,foundation", "--yes"],
      { ...io, deploy: safeDeployDeps({ identity: fakeIdentity, store: new MemoryParameterStore(), secrets: memorySecrets(), deployer }) },
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toBe(
      [
        `Installed environment ${ENV} (not every part is deployed yet)`,
        "Deployed parts: access, foundation",
        "Missing parts: identity, control-plane, runtime, slack",
        "Environment settings are written once every part is deployed.",
        `Resume with: agentx deploy --mode install --parts identity,control-plane,runtime,slack --release ${releaseDir} --answers ${answersPath} --yes`,
        "",
      ].join("\n"),
    );
  });

  it("names the cdk engine and its source in the resume command", async () => {
    const releaseDir = await emptyReleaseDir();
    const answersPath = await writeAnswers();
    const store = new MemoryParameterStore();
    await store.put("/cdk-bootstrap/hnb659fds/version", "21");
    const io = capture();

    const code = await executeCli(
      ["deploy", "--mode", "install", "--engine", "cdk", "--release", releaseDir, "--answers", answersPath, "--source", "/some/source", "--parts", "access", "--yes"],
      {
        ...io,
        deploy: safeDeployDeps({
          identity: fakeIdentity,
          store,
          secrets: memorySecrets(),
          commandRunner: cleanCdkRunner(scriptedOutputs()),
          // A fresh install: none of the parts after access exist yet.
          stackOutputs: async () => undefined,
        }),
      },
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain(
      `Resume with: agentx deploy --mode install --engine cdk --source /some/source --parts foundation,identity,control-plane,runtime,slack --release ${releaseDir} --answers ${answersPath} --yes\n`,
    );
  });
});
