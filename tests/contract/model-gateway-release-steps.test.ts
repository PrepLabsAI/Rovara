// Contract tests for Code's own model gateway release CLI, gates, adopt mode, rollback, and cross-account pull policy (#1578).
// Uses fake AWS/CDK/HTTP/exec ports and throwaway git repos: no AWS, no Docker, no network.
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { betaModelGatewayPullPolicy } from "../../infra/lib/release-pipeline.js";
import { checkStep, judgeHealthz } from "../../scripts/model-gateway-release/check-step.js";
import { main as cliMain } from "../../scripts/model-gateway-release/cli.js";
import { MODEL_GATEWAY_LAST_GOOD_PARAMETER, modelGatewayCdkContext } from "../../scripts/model-gateway-release/context.js";
import { deployStep } from "../../scripts/model-gateway-release/deploy-step.js";
import { contentTagFor, parseRepositoryUri } from "../../scripts/model-gateway-release/ecr.js";
import { FLOORS_PATH, judgeDigest, judgeGatewayCodeSha, parseFloors } from "../../scripts/model-gateway-release/floors.js";
import { imageStep } from "../../scripts/model-gateway-release/image-step.js";
import { PROTECTED_PATH, checkProtected, parseProtected } from "../../scripts/model-gateway-release/protected.js";
import { judgeGatewaySwitch } from "../../scripts/model-gateway-release/source-switch.js";
import { EXIT, StageError } from "../../scripts/model-gateway-release/types.js";
import type { ChangeSetDescription, ChangeSetRecord, ExecResult, GatewayManifest, Ports, StackDescription } from "../../scripts/model-gateway-release/types.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_1 = `sha256:${"1".repeat(64)}`;
const DIGEST_2 = `sha256:${"2".repeat(64)}`;
const CTX_HASH = "3".repeat(64);
const BETA_ACCT = "111122223333";
const PROD_ACCT = "999988887777";
const BETA_REPO = "rovara-cloud-beta-gateway-images-imagesabc123";
const PROD_REPO = "rovara-cloud-production-gateway-images-imagesxyz789";

const tempDirs: string[] = [];
const scratchDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mgw-release-test-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeFakePorts(overrides: Partial<{
  account: string;
  stacks: Record<string, StackDescription | null>;
  changeSets: Record<string, ChangeSetDescription | null>;
  stackResources: Record<string, Array<{ logicalId: string; resourceType: string; physicalId: string }>>;
  liveTemplates: Record<string, unknown>;
  csTemplates: Record<string, unknown>;
  ssm: Record<string, string>;
  releaseSsm: Record<string, string>;
  awsHandler: (args: readonly string[]) => unknown;
  execHandler: (cmd: string, args: readonly string[]) => ExecResult;
  httpHandler: (url: string) => { status: number; body?: string };
}> = {}): { ports: Ports; executed: string[]; deleted: string[]; releaseWrites: Record<string, string>; execCalls: string[] } {
  const stacks = overrides.stacks ?? {};
  const changeSets = overrides.changeSets ?? {};
  const stackResources = overrides.stackResources ?? {};
  const releaseSsm: Record<string, string> = { ...(overrides.releaseSsm ?? {}) };
  const ssm: Record<string, string> = { ...(overrides.ssm ?? {}) };
  const executed: string[] = [];
  const deleted: string[] = [];
  const execCalls: string[] = [];
  const files = new Map<string, string>();
  const now = new Date("2026-11-26T20:00:00.000Z");

  const ports: Ports = {
    async exec(cmd, args) {
      execCalls.push(`${cmd} ${args.join(" ")}`);
      if (overrides.execHandler !== undefined) return overrides.execHandler(cmd, args);
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${SHA_A}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    aws: {
      async json(args) {
        if (overrides.awsHandler !== undefined) return overrides.awsHandler(args);
        return null;
      },
    },
    sts: { async account() { return overrides.account ?? BETA_ACCT; } },
    cfn: {
      async describeStack(name) { return stacks[name] ?? null; },
      async describeChangeSet(stack, name) { return changeSets[`${stack}:${name}`] ?? null; },
      async listStackResources(stack) { return stackResources[stack] ?? []; },
      async templateSha256() { return "f".repeat(64); },
      async templateBody(stack, name) { return (overrides.csTemplates ?? {})[`${stack}:${name}`] ?? { Resources: {}, Outputs: {} }; },
      async liveTemplateBody(stack) { return (overrides.liveTemplates ?? {})[stack] ?? null; },
      async executeChangeSet(stack, name) {
        executed.push(`${stack}:${name}`);
        const s = stacks[stack];
        const cs = changeSets[`${stack}:${name}`];
        if (s !== null && s !== undefined && cs !== null && cs !== undefined) {
          s.changeSetId = cs.id;
          s.lastUpdatedTime = now.toISOString();
          s.status = "UPDATE_COMPLETE";
        }
      },
      async deleteChangeSet(stack, name) { deleted.push(`${stack}:${name}`); },
      async listChangeSetNames() { return []; },
      async waitSettled(stack) { return stacks[stack]?.status ?? "UPDATE_COMPLETE"; },
    },
    cdk: { async deployNoExecute() { /* preview creates changeSet already stubbed */ } },
    ssm: { async get(name) { return ssm[name] ?? null; } },
    releaseSsm: {
      async get(name) { return releaseSsm[name] ?? null; },
      async put(name, value) { releaseSsm[name] = value; },
    },
    http: {
      async get(url) { return overrides.httpHandler !== undefined ? overrides.httpHandler(url) : { status: 200, body: JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 4 } }) }; },
    },
    fs: {
      readText(path) { return files.get(path) ?? readFileSync(path, "utf8"); },
      writeText(path, text) { files.set(path, text); },
      exists(path) { return files.has(path) || path === FLOORS_PATH || path === PROTECTED_PATH; },
      mkdirp() { /* in-memory */ },
    },
    clock: { now: () => now, async sleep() { /* instant */ } },
  };
  return { ports, executed, deleted, releaseWrites: releaseSsm, execCalls };
}

describe("protected.json matches real synthesized ModelGatewayStack and ModelGatewayImagesStack", () => {
  it("every protected logical id exists in the synthesized templates with the exact CloudFormation resource type", () => {
    const list = parseProtected(readFileSync(PROTECTED_PATH, "utf8"));
    const app = buildAgentXApp({ ...modelGatewayCdkContext("beta", "us-east-1", SHA_A) });
    const gateway = Template.fromStack(app.node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, { Type: string }> };
    const images = Template.fromStack(app.node.findChild("RovaraModelGatewayImages") as Stack).toJSON() as { Resources: Record<string, { Type: string }> };

    for (const [id, type] of Object.entries(list.parts.gateway!)) {
      expect(gateway.Resources[id]?.Type, `gateway.${id}`).toBe(type);
    }
    for (const [id, type] of Object.entries(list.parts.gatewayImages!)) {
      expect(images.Resources[id]?.Type, `gatewayImages.${id}`).toBe(type);
    }
  });

  it("blocks removals, replacements (True and Conditional), data-rewriting property edits, and non-image rows during image-only changes", () => {
    const list = parseProtected(readFileSync(PROTECTED_PATH, "utf8"));
    const cs = (rows: ChangeSetRecord["rows"]): ChangeSetRecord => ({
      part: "gateway", stack: "rovara-cloud-beta-gateway", changeSetName: "rovara-pipeline-12345678",
      changeSetId: "arn:aws:cloudformation:us-east-1:111122223333:changeSet/x/1", noChanges: false,
      status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", templateSha256: "f".repeat(64),
      rows, counts: { add: 0, modify: rows.length, remove: 0, replace: 0 }, previewedAt: "2026-11-26T20:00:00.000Z", executedAt: null, finalStatus: null,
    });
    expect(checkProtected(list, cs([{ action: "Modify", logicalId: "ServeTask1234ABCD", physicalId: null, resourceType: "AWS::ECS::TaskDefinition", replacement: "True" }]), { imageOnly: true }).failures).toEqual([]);
    expect(checkProtected(list, cs([{ action: "Modify", logicalId: "MeterFF56B2C9", physicalId: null, resourceType: "AWS::DynamoDB::GlobalTable", replacement: "Conditional" }]), { imageOnly: false }).failures).toHaveLength(1);
    expect(checkProtected(list, cs([{ action: "Modify", logicalId: "ProviderKeyanthropic", physicalId: null, resourceType: "AWS::SecretsManager::Secret", replacement: "False", changedProperties: ["Properties:GenerateSecretString"] }]), { imageOnly: false }).failures).toHaveLength(1);
    expect(checkProtected(list, cs([{ action: "Modify", logicalId: "SomeRole1234ABCD", physicalId: null, resourceType: "AWS::IAM::Role", replacement: "False" }]), { imageOnly: true }).failures[0]).toContain("not one of the image rows");
  });
});

describe("ECR helpers, rollback floors, and gateway-source-switch", () => {
  it("parses ECR repository URIs, derives content-addressed ctx-<64hex> tags, and produces the beta cross-account pull policy", () => {
    const repo = parseRepositoryUri(`${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}`);
    expect(repo).toEqual({
      uri: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}`,
      registry: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com`,
      name: BETA_REPO,
      account: BETA_ACCT,
      region: "us-east-1",
    });
    expect(contentTagFor(CTX_HASH)).toBe(`ctx-${CTX_HASH}`);
    const policy = betaModelGatewayPullPolicy(`arn:aws:iam::${PROD_ACCT}:role/agentx-release-model-gateway-production-build`);
    expect(policy.Statement[0]!.Action).toEqual([
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer",
    ]);
  });

  it("enforces below-floor digests and gatewayCode commit floors in a real git repo", async () => {
    const dir = scratchDir();
    git(dir, "init", "-q", "-b", "mainline");
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "old");
    const oldSha = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "2\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "floor");
    const floorSha = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "3\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "new");
    const newSha = git(dir, "rev-parse", "HEAD");

    const floors = parseFloors(JSON.stringify({
      schema: 1,
      floors: { gatewayCode: [{ sha: floorSha, reason: "requires price bands" }] },
      gatewayDigests: { belowFloor: [{ digest: DIGEST_1, reason: "no price bands" }] },
    }));
    expect(judgeDigest(floors, DIGEST_1)).toHaveLength(1);
    expect(judgeDigest(floors, DIGEST_2)).toEqual([]);

    const realExecPorts: Ports = {
      ...makeFakePorts().ports,
      async exec(cmd, args, opts) {
        const r = spawnSync(cmd, [...args], { cwd: opts?.cwd, encoding: "utf8" });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
    };
    expect((await judgeGatewayCodeSha(realExecPorts, floors, dir, newSha)).failures).toEqual([]);
    expect((await judgeGatewayCodeSha(realExecPorts, floors, dir, oldSha)).failures[0]).toContain("below the gatewayCode floor");
  });

  it("gateway-source-switch accepts DeployedCloudSha -> DeployedCodeSha only and rejects resource or stray output diffs", () => {
    const live = { Resources: { A: { Type: "AWS::SNS::Topic" } }, Outputs: { DeployedCloudSha: { Value: SHA_B }, ServiceArn: { Value: "arn:x" } } };
    const nextOk = { Resources: { A: { Type: "AWS::SNS::Topic" } }, Outputs: { DeployedCodeSha: { Value: SHA_A }, ServiceArn: { Value: "arn:x" } } };
    expect(judgeGatewaySwitch(live, nextOk, SHA_A).failures).toEqual([]);
    const nextBad = { Resources: { A: { Type: "AWS::SNS::Topic", Properties: { X: 1 } } }, Outputs: { DeployedCodeSha: { Value: SHA_A }, ServiceArn: { Value: "arn:x" } } };
    expect(judgeGatewaySwitch(live, nextBad, SHA_A).failures[0]).toContain("differs from the live stack outside Outputs");
  });
});

describe("Code model gateway steps: image, deploy, check, adopt, rollback", () => {
  const betaLastGood = JSON.stringify({
    schema: 1, env: "beta", recordedAt: "2026-11-26T18:00:00.000Z", executionId: "00000000-1111-2222-3333-444455556666",
    mode: "adopt", gateway: { digest: DIGEST_1, codeSha: SHA_A, imageTag: `ctx-${CTX_HASH}`, repository: BETA_REPO },
    checks: ["gateway-digest-equal", "gateway-settled"], previous: { digest: DIGEST_2, codeSha: SHA_B },
  });

  it("refuses first release until adopt mode has seeded /agentx/release/model-gateway-last-good/<env>", async () => {
    const { ports } = makeFakePorts({
      account: BETA_ACCT,
      stacks: { "rovara-cloud-beta-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}` }, changeSetId: null, lastUpdatedTime: null } },
    });
    await expect(imageStep({
      env: "beta", mode: "release", codeRelease: "run", execId: "12345678-1111-2222-3333-444455556666",
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: null, gatewayDigest: null,
      expectedAccount: BETA_ACCT, betaAccountId: null, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: null, ports, log: () => {},
    })).rejects.toMatchObject({ exitName: "ADOPTION_REQUIRED" });
  });

  it("beta release reuses existing ECR digest when context hash tag is already present (zero docker build/push)", async () => {
    const { ports, execCalls } = makeFakePorts({
      account: BETA_ACCT,
      releaseSsm: { [MODEL_GATEWAY_LAST_GOOD_PARAMETER.beta]: betaLastGood },
      stacks: { "rovara-cloud-beta-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}` }, changeSetId: null, lastUpdatedTime: null } },
      awsHandler(args) {
        if (args[0] === "ecr" && args[1] === "describe-images") return { imageDetails: [{ imageDigest: DIGEST_1, imageTags: [`ctx-${CTX_HASH}`] }] };
        return null;
      },
      execHandler(cmd, args) {
        if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${SHA_A}\n`, stderr: "" };
        if (cmd === "npx" && args.includes("context")) return { code: 0, stdout: `${JSON.stringify({ contextSha256: CTX_HASH })}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const manifest = await imageStep({
      env: "beta", mode: "release", codeRelease: "run", execId: "12345678-1111-2222-3333-444455556666",
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: null, gatewayDigest: null,
      expectedAccount: BETA_ACCT, betaAccountId: null, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: null, ports, log: () => {},
    });
    expect(manifest.gateway).toEqual({ digest: DIGEST_1, source: "built", imageTag: `ctx-${CTX_HASH}`, repository: BETA_REPO, codeSha: SHA_A });
    expect(execCalls.some((c) => c.startsWith("docker "))).toBe(false);
  });

  it("production release copies beta's exact digest with crane copy and refuses a tag with a different digest", async () => {
    const prodLastGood = betaLastGood.replaceAll('"beta"', '"production"').replaceAll(BETA_REPO, PROD_REPO);
    const betaManifest: GatewayManifest = {
      schema: 1, executionId: "12345678-1111-2222-3333-444455556666", exec8: "12345678", createdAt: "2026-11-26T20:00:00.000Z",
      mode: "release", skipped: false, code: { sha: SHA_A, rollbackTarget: null, liveSha: { beta: SHA_A, production: null } },
      gateway: { digest: DIGEST_1, source: "built", imageTag: `ctx-${CTX_HASH}`, repository: BETA_REPO, codeSha: SHA_A },
      stages: { beta: { env: "beta", account: BETA_ACCT, startedAt: "2026-11-26T20:00:00.000Z", dryRun: false, changeSet: null, gates: [], warnings: [] } },
    };
    let prodDescribeCalls = 0;
    const { ports, execCalls } = makeFakePorts({
      account: PROD_ACCT,
      releaseSsm: { [MODEL_GATEWAY_LAST_GOOD_PARAMETER.production]: prodLastGood },
      stacks: { "rovara-cloud-production-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${PROD_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${PROD_REPO}` }, changeSetId: null, lastUpdatedTime: null } },
      awsHandler(args) {
        if (args[0] === "ecr" && args[1] === "get-authorization-token") {
          return { authorizationData: [{ authorizationToken: Buffer.from("AWS:pw").toString("base64"), proxyEndpoint: `https://${PROD_ACCT}.dkr.ecr.us-east-1.amazonaws.com` }] };
        }
        if (args[0] === "ecr" && args[1] === "describe-images") {
          if (args.includes(BETA_ACCT)) return { imageDetails: [{ imageDigest: DIGEST_1, imageTags: [`ctx-${CTX_HASH}`] }] };
          prodDescribeCalls += 1;
          return prodDescribeCalls === 1 ? { imageDetails: [] } : { imageDetails: [{ imageDigest: DIGEST_1, imageTags: [`ctx-${CTX_HASH}`] }] };
        }
        return null;
      },
      execHandler(cmd, args) {
        if (cmd === "crane" && args[0] === "digest") return { code: 0, stdout: `${DIGEST_1}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const manifest = await imageStep({
      env: "production", mode: "release", codeRelease: "run", execId: betaManifest.executionId,
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: null, gatewayDigest: null,
      expectedAccount: PROD_ACCT, betaAccountId: BETA_ACCT, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: betaManifest, ports, log: () => {},
    });
    expect(manifest.gateway).toMatchObject({ digest: DIGEST_1, source: "copied", repository: PROD_REPO });
    expect(execCalls.some((c) => c.startsWith("crane copy "))).toBe(true);

    // Tag already holds a DIFFERENT digest -> REFUSED.
    const conflict = makeFakePorts({
      account: PROD_ACCT,
      releaseSsm: { [MODEL_GATEWAY_LAST_GOOD_PARAMETER.production]: prodLastGood },
      stacks: { "rovara-cloud-production-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${PROD_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${PROD_REPO}` }, changeSetId: null, lastUpdatedTime: null } },
      awsHandler(args) {
        if (args[0] === "ecr" && args[1] === "describe-images") {
          return args.includes(BETA_ACCT) ? { imageDetails: [{ imageDigest: DIGEST_1 }] } : { imageDetails: [{ imageDigest: DIGEST_2 }] };
        }
        return null;
      },
    });
    await expect(imageStep({
      env: "production", mode: "release", codeRelease: "run", execId: betaManifest.executionId,
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: null, gatewayDigest: null,
      expectedAccount: PROD_ACCT, betaAccountId: BETA_ACCT, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: betaManifest, ports: conflict.ports, log: () => {},
    })).rejects.toThrow(/already exists/u);
  });

  it("adopt mode checks live gateway, previews a no-op change set and discards it, verifies live health via CoreModelGatewayHost, and writes last-good", async () => {
    const csKey = "rovara-cloud-beta-gateway:rovara-pipeline-12345678";
    const serviceArn = `arn:aws:ecs:us-east-1:${BETA_ACCT}:service/rovara-cloud-beta-gateway-Cluster1/Service1`;
    const { ports, executed, deleted, releaseWrites } = makeFakePorts({
      account: BETA_ACCT,
      stacks: {
        "rovara-cloud-beta-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}` }, changeSetId: null, lastUpdatedTime: null },
        "rovara-cloud-beta-gateway": { status: "UPDATE_COMPLETE", parameters: { ImageDigest: DIGEST_1 }, outputs: { DeployedCodeSha: SHA_A, ServiceArn: serviceArn }, changeSetId: "cs-0", lastUpdatedTime: "2026-11-26T18:00:00.000Z" },
        AgentXControlPlane: { status: "UPDATE_COMPLETE", parameters: { CoreModelGatewayHost: "gateway.example.invalid" }, outputs: { ModelRunPriceVersion: "1" }, changeSetId: null, lastUpdatedTime: null },
      },
      changeSets: {
        [csKey]: { id: "cs-1", status: "FAILED", executionStatus: "UNAVAILABLE", statusReason: "The submitted information didn't contain changes.", rows: [] },
      },
      stackResources: {
        "rovara-cloud-beta-gateway": [{ logicalId: "PriceFetchLogsABC", resourceType: "AWS::Logs::LogGroup", physicalId: "rovara-cloud-beta-gateway-PriceFetchLogs-1" }],
      },
      awsHandler(args) {
        if (args[0] === "ecr" && args[1] === "describe-images") return { imageDetails: [{ imageDigest: DIGEST_1, imageTags: [`ctx-${CTX_HASH}`] }] };
        if (args[0] === "ecs" && args[1] === "describe-services") return { services: [{ runningCount: 2, desiredCount: 2, deployments: [{ rolloutState: "COMPLETED", taskDefinition: "td:1" }] }] };
        if (args[0] === "ecs" && args[1] === "describe-task-definition") return { taskDefinition: { containerDefinitions: [{ image: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}@${DIGEST_1}` }] } };
        if (args[0] === "logs" && args[1] === "filter-log-events") return { events: [{ timestamp: Date.parse("2026-11-26T19:00:00.000Z") }] };
        return null;
      },
    });
    const afterImage = await imageStep({
      env: "beta", mode: "adopt", codeRelease: "run", execId: "12345678-1111-2222-3333-444455556666",
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: null, gatewayDigest: null,
      expectedAccount: BETA_ACCT, betaAccountId: null, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: null, ports, log: () => {},
    });
    expect(afterImage.gateway.source).toBe("adopted");

    const afterDeploy = await deployStep({ env: "beta", region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w", dryRun: false, manifest: afterImage, ports, log: () => {} });
    expect(executed).toEqual([]);
    expect(deleted).toContain(csKey);

    await checkStep({ env: "beta", repoDir: "/repo", dryRun: false, manifest: afterDeploy, pollAttempts: 1, pollWaitMs: 0, ports, log: () => {} });
    const written = JSON.parse(releaseWrites[MODEL_GATEWAY_LAST_GOOD_PARAMETER.beta]!) as { mode: string; gateway: { digest: string; codeSha: string } };
    expect(written.mode).toBe("adopt");
    expect(written.gateway).toMatchObject({ digest: DIGEST_1, codeSha: SHA_A });
  });

  it("rollback refuses an unrecorded digest and cli rollback-plan prints recorded digests", async () => {
    const { ports } = makeFakePorts({
      account: BETA_ACCT,
      releaseSsm: { [MODEL_GATEWAY_LAST_GOOD_PARAMETER.beta]: betaLastGood },
      stacks: { "rovara-cloud-beta-gateway-images": { status: "CREATE_COMPLETE", parameters: {}, outputs: { RepositoryUri: `${BETA_ACCT}.dkr.ecr.us-east-1.amazonaws.com/${BETA_REPO}` }, changeSetId: null, lastUpdatedTime: null } },
    });
    const unknownDigest = `sha256:${"9".repeat(64)}`;
    await expect(imageStep({
      env: "beta", mode: "rollback", codeRelease: "run", execId: "12345678-1111-2222-3333-444455556666",
      codeSha: SHA_A, codeLiveSha: SHA_A, codeRollbackTarget: SHA_B, gatewayDigest: unknownDigest,
      expectedAccount: BETA_ACCT, betaAccountId: null, region: "us-east-1", repoDir: "/repo", workDir: "/tmp/w",
      dryRun: false, previousManifest: null, ports, log: () => {},
    })).rejects.toBeInstanceOf(StageError);

    const lines: string[] = [];
    const code = await cliMain(["beta", "last-good"], { AWS_REGION: "us-east-1" }, { makePorts: () => ports, out: (l) => lines.push(l) });
    expect(code).toBe(EXIT.OK);
    expect(lines.join("\n")).toContain(DIGEST_1);
    expect(judgeHealthz(200, JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 2 } }), 1)).toBeNull();
    expect(judgeHealthz(200, JSON.stringify({ ok: true, runPrice: { version: 0, admissionVersion: 1, snapshotVersion: 2 } }), 1)).toContain("Code needs 1");
  });
});
