// Step 1: ModelGatewayImage (#1578).
// - beta (release): builds linux/arm64 image from Code commit keyed by contextSha256 (ctx-<64hex>), reuses existing digest in ECR if unchanged, else builds & pushes.
// - production (release/rollback): never builds; copies beta's exact digest with `crane copy` and asserts byte-identical digest in production ECR.
// - adopt: checks live gateway stack + ECR digest, builds/copies nothing, records adopted state.
// - rollback (beta): uses a recorded last-good gateway digest (never builds from old source), verifies ECR + floors.
import { modelGatewayImagesStackName, modelGatewayStackName } from "./context.js";
import { IMAGE_DIGEST, assertTag, contentTagFor, findImage, imageTagFor, ownRepository, registryLogin, removeDir } from "./ecr.js";
import type { Repository } from "./ecr.js";
import { judgeDigest, judgeGatewayCodeSha, loadFloors } from "./floors.js";
import { gatewayCodeForRecordedDigest, keepsLiveGateway, readLastGood, recordedGatewayDigests, recordedGateways } from "./lastgood.js";
import { StageError } from "./types.js";
import type { GatewayLastGoodRecord, GatewayManifest, PipelineEnv, PipelineMode, Ports } from "./types.js";

const SHA40 = /^[0-9a-f]{40}$/u;
const ACCOUNT = /^[0-9]{12}$/u;
const tail = (text: string): string => text.split("\n").filter((line) => line !== "").slice(-3).join(" / ");

export interface ImageStepArgs {
  env: PipelineEnv;
  mode: PipelineMode;
  codeRelease: "run" | "skip";
  execId: string;
  codeSha: string;
  codeLiveSha: string | null;
  codeRollbackTarget: string | null;
  gatewayDigest: string | null;
  expectedAccount: string;
  betaAccountId: string | null;
  region: string;
  repoDir: string;
  workDir: string;
  dryRun: boolean;
  previousManifest: GatewayManifest | null;
  ports: Ports;
  log: (line: string) => void;
  floorsPath?: string;
}

export function newManifest(args: ImageStepArgs, skipped: boolean, skipReason?: string): GatewayManifest {
  const exec8 = args.execId.slice(0, 8);
  const base: GatewayManifest = args.previousManifest !== null
    ? structuredClone(args.previousManifest)
    : {
        schema: 1,
        executionId: args.execId,
        exec8,
        createdAt: args.ports.clock.now().toISOString(),
        mode: args.mode,
        skipped,
        ...(skipReason === undefined ? {} : { skipReason }),
        code: {
          sha: args.codeSha,
          rollbackTarget: args.codeRollbackTarget,
          liveSha: { beta: null, production: null },
        },
        gateway: { digest: null, source: null, imageTag: null, repository: null, codeSha: null },
        stages: {},
      };
  base.skipped = skipped;
  if (skipReason !== undefined) base.skipReason = skipReason;
  base.code.liveSha[args.env] = args.codeLiveSha;
  base.stages[args.env] = {
    env: args.env,
    account: null,
    startedAt: args.ports.clock.now().toISOString(),
    dryRun: args.dryRun,
    changeSet: null,
    gates: [],
    warnings: [],
  };
  return base;
}

async function assertExpectedAccount(ports: Ports, expectedAccount: string): Promise<string> {
  if (!ACCOUNT.test(expectedAccount)) throw new StageError("REFUSED", "ROVARA_EXPECTED_DEPLOY_ACCOUNT must be a 12-digit account id");
  const actual = await ports.sts.account();
  if (actual !== expectedAccount) {
    throw new StageError("REFUSED", `signed-in account ${actual} does not match expected deploy account ${expectedAccount}`);
  }
  return actual;
}

function printedContextHash(stdout: string, which: "last" | "first"): string | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const scan = which === "last" ? lines.slice(-1) : lines;
  for (const line of scan) {
    try {
      const parsed = JSON.parse(line) as { contextSha256?: unknown };
      if (typeof parsed.contextSha256 === "string") return parsed.contextSha256;
    } catch { /* non-JSON build output */ }
  }
  return null;
}

async function checkoutCleanCodeTree(ports: Ports, repoDir: string, workDir: string, codeSha: string): Promise<string> {
  const head = await ports.exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  if (head.code === 0 && head.stdout.trim() === codeSha) {
    const status = await ports.exec("git", ["status", "--porcelain", "--untracked-files=all", "--", "packages/model-gateway", "environments/model-gateway", "tsconfig.base.json", "scripts/model-gateway-image.ts"], { cwd: repoDir });
    const ignored = await ports.exec("git", ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", "packages/model-gateway/src"], { cwd: repoDir });
    if (status.code === 0 && status.stdout.trim() === "" && ignored.code === 0 && ignored.stdout.trim() === "") return repoDir;
    throw new StageError("REFUSED", "the Code tree has changed, untracked, or ignored files under the model gateway build inputs");
  }
  const treeDir = `${workDir}/code-${codeSha.slice(0, 12)}`;
  await removeDir(ports, treeDir);
  const wt = await ports.exec("git", ["worktree", "add", "--detach", treeDir, codeSha], { cwd: repoDir });
  if (wt.code !== 0) throw new StageError("FAILED", `git worktree add for ${codeSha.slice(0, 12)} failed: ${tail(wt.stderr)}`);
  return treeDir;
}

async function computeContextHash(ports: Ports, sourceDir: string, workDir: string): Promise<string> {
  const out = `${workDir}/model-gateway-context`;
  await removeDir(ports, out);
  try {
    const ran = await ports.exec("npx", ["--no-install", "tsx", "scripts/model-gateway-image.ts", "context", "--out", out], { cwd: sourceDir });
    if (ran.code !== 0) throw new StageError("FAILED", `model gateway image context failed (exit ${ran.code}): ${tail(ran.stderr || ran.stdout)}`);
    const hash = printedContextHash(ran.stdout, "last");
    if (hash === null) throw new StageError("FAILED", "model-gateway-image.ts context printed no contextSha256");
    return hash;
  } finally {
    await removeDir(ports, out);
  }
}

async function buildAndPushBeta(
  args: ImageStepArgs,
  repository: Repository,
  sourceDir: string,
  codeSha: string,
): Promise<{ digest: string; imageTag: string }> {
  const { ports, log, workDir } = args;
  const contextSha256 = await computeContextHash(ports, sourceDir, workDir);
  const tag = assertTag(contentTagFor(contextSha256));
  const existing = await findImage(ports, repository.name, { tag });
  if (existing !== null) {
    if (!IMAGE_DIGEST.test(existing.digest)) throw new StageError("FAILED", `tag ${tag} resolves to something that is not a digest`);
    log(`tag ${tag} is already in ${repository.name} (unchanged gateway context): reusing ${existing.digest.slice(0, 19)}...`);
    return { digest: existing.digest, imageTag: tag };
  }
  const local = `rovara-model-gateway:${tag}`;
  log(`building linux/arm64 image ${local} from Code ${codeSha.slice(0, 12)}`);
  const built = await ports.exec("npx", ["--no-install", "tsx", "scripts/model-gateway-image.ts", "build", "--tag", local], { cwd: sourceDir });
  if (built.code !== 0) throw new StageError("FAILED", `model gateway image build exited ${built.code}: ${tail(built.stderr || built.stdout)}`);
  const buildHash = printedContextHash(built.stdout, "first");
  if (buildHash === null || buildHash !== contextSha256) {
    throw new StageError("REFUSED", "the image build context hash disagreed with the computed tag hash: nothing pushed");
  }
  const platform = await ports.exec("docker", ["image", "inspect", local, "--format", "{{.Os}}/{{.Architecture}}"]);
  if (platform.code !== 0 || platform.stdout.trim() !== "linux/arm64") {
    throw new StageError("FAILED", `built image platform is ${platform.stdout.trim() || "unreadable"}, not linux/arm64`);
  }
  return await pushDockerImage(ports, repository, local, tag, workDir, log);
}

async function pushDockerImage(
  ports: Ports,
  repository: Repository,
  local: string,
  tag: string,
  workDir: string,
  log: (line: string) => void,
): Promise<{ digest: string; imageTag: string }> {
  const configDir = `${workDir}/registry-auth-docker`;
  const remote = `${repository.uri}:${tag}`;
  try {
    await registryLogin(ports, "docker", repository.registry, [repository.registry], configDir);
    const env = { DOCKER_CONFIG: configDir };
    const tagged = await ports.exec("docker", ["tag", local, remote], { env });
    if (tagged.code !== 0) throw new StageError("FAILED", `docker tag failed: ${tail(tagged.stderr)}`);
    const pushed = await ports.exec("docker", ["push", remote], { env });
    if (pushed.code !== 0) {
      if ((await findImage(ports, repository.name, { tag })) !== null) {
        throw new StageError("REFUSED", `tag ${tag} appeared in ${repository.name} during build (repository is immutable): refusing to use it`);
      }
      throw new StageError("FAILED", `docker push failed: ${tail(pushed.stderr || pushed.stdout)}`);
    }
    const reported = /digest: (sha256:[0-9a-f]{64})/u.exec(`${pushed.stdout}\n${pushed.stderr}`)?.[1];
    const row = await findImage(ports, repository.name, { tag });
    if (row === null || !IMAGE_DIGEST.test(row.digest)) throw new StageError("FAILED", `tag ${tag} did not resolve to a digest in ${repository.name}`);
    if (reported !== undefined && reported !== row.digest) {
      throw new StageError("REFUSED", `push reported ${reported.slice(0, 19)}... but ECR resolves ${tag} to ${row.digest.slice(0, 19)}...`);
    }
    log(`pushed ${repository.name}:${tag} = ${row.digest.slice(0, 19)}...`);
    return { digest: row.digest, imageTag: tag };
  } finally {
    await removeDir(ports, configDir);
  }
}

async function copyFromBeta(
  args: ImageStepArgs,
  manifest: GatewayManifest,
  target: Repository,
): Promise<{ digest: string; imageTag: string }> {
  const { ports, log, workDir } = args;
  const digest = manifest.gateway.digest;
  if (digest === null || !IMAGE_DIGEST.test(digest)) throw new StageError("REFUSED", "production has no beta model gateway digest to copy");
  const sourceName = manifest.gateway.repository;
  const betaPrefix = `${modelGatewayImagesStackName("beta")}-`;
  if (sourceName === null || !sourceName.startsWith(betaPrefix)) {
    throw new StageError("REFUSED", "the beta manifest does not name beta's gateway-images repository");
  }
  const configured = args.betaAccountId;
  const recorded = manifest.stages.beta?.account ?? null;
  if (configured === null || !ACCOUNT.test(configured)) throw new StageError("REFUSED", "BETA_ACCOUNT_ID must be a 12-digit account id");
  if (recorded === null || !ACCOUNT.test(recorded)) throw new StageError("REFUSED", "the beta manifest records no beta account");
  if (configured !== recorded) throw new StageError("REFUSED", "BETA_ACCOUNT_ID differs from the beta account recorded in the manifest");
  if (configured === target.account) throw new StageError("REFUSED", "the beta account equals the production account");
  const sourceRegistry = `${configured}.dkr.ecr.${target.region}.amazonaws.com`;
  if ((await findImage(ports, sourceName, { digest }, configured)) === null) {
    throw new StageError("REFUSED", `beta repository ${sourceName} does not hold ${digest.slice(0, 19)}... (or production cannot read it)`);
  }
  const tag = assertTag(imageTagFor(manifest));
  const existing = await findImage(ports, target.name, { tag });
  if (existing !== null && existing.digest !== digest) {
    throw new StageError("REFUSED", `tag ${tag} already exists in ${target.name} with ${existing.digest.slice(0, 19)}..., not beta's ${digest.slice(0, 19)}...: refusing`);
  }
  if (existing !== null) {
    log(`tag ${tag} already holds ${digest.slice(0, 19)}... in ${target.name}: nothing to copy`);
    return { digest, imageTag: tag };
  }
  return await runCraneCopy(ports, target, `${sourceRegistry}/${sourceName}@${digest}`, sourceRegistry, tag, digest, workDir, log);
}

async function runCraneCopy(
  ports: Ports,
  target: Repository,
  source: string,
  sourceRegistry: string,
  tag: string,
  digest: string,
  workDir: string,
  log: (line: string) => void,
): Promise<{ digest: string; imageTag: string }> {
  const destination = `${target.uri}:${tag}`;
  const configDir = `${workDir}/registry-auth-crane`;
  const env = { DOCKER_CONFIG: configDir };
  try {
    await registryLogin(ports, "crane", target.registry, [sourceRegistry, target.registry], configDir);
    log(`copying beta ${source.slice(source.indexOf("/") + 1, source.indexOf("@"))}@${digest.slice(0, 19)}... -> ${target.name}:${tag}`);
    const copied = await ports.exec("crane", ["copy", source, destination], { env });
    if (copied.code === 127) throw new StageError("FAILED", "crane is not installed on this build machine");
    if (copied.code !== 0) throw new StageError("FAILED", `crane copy failed (exit ${copied.code}): ${tail(copied.stderr || copied.stdout)}`);
    const seen = await ports.exec("crane", ["digest", destination], { env });
    if (seen.code !== 0 || seen.stdout.trim() !== digest) {
      throw new StageError("REFUSED", `after copy ${tag} resolved to ${seen.stdout.trim().slice(0, 19)}..., not beta's ${digest.slice(0, 19)}...`);
    }
  } finally {
    await removeDir(ports, configDir);
  }
  const row = await findImage(ports, target.name, { tag });
  if (row === null || row.digest !== digest) {
    throw new StageError("REFUSED", `ECR holds ${row === null ? "no image" : row.digest.slice(0, 19)} for ${tag} after copy, not beta's ${digest.slice(0, 19)}...`);
  }
  log(`copied ${target.name}:${tag} = ${digest.slice(0, 19)}... (byte-identical to beta)`);
  return { digest, imageTag: tag };
}

async function adoptLiveGateway(args: ImageStepArgs, manifest: GatewayManifest, repository: Repository): Promise<GatewayManifest> {
  const stack = modelGatewayStackName(args.env);
  const live = await args.ports.cfn.describeStack(stack);
  if (live === null) throw new StageError("REFUSED", `adopt failed: gateway stack ${stack} does not exist`);
  const digest = live.parameters.ImageDigest;
  if (digest === undefined || !IMAGE_DIGEST.test(digest)) {
    throw new StageError("REFUSED", `adopt failed: ${stack} has no valid ImageDigest parameter`);
  }
  const row = await findImage(args.ports, repository.name, { digest });
  if (row === null) throw new StageError("REFUSED", `adopt failed: live digest ${digest.slice(0, 19)}... is not in ${repository.name}`);
  const stamped = live.outputs.DeployedCodeSha;
  const codeSha = stamped !== undefined && SHA40.test(stamped) ? stamped : args.codeLiveSha ?? args.codeSha;
  manifest.gateway = {
    digest,
    source: "adopted",
    imageTag: row.tags[0] ?? null,
    repository: repository.name,
    codeSha,
  };
  args.log(`adopt (${args.env}): live gateway runs ${digest.slice(0, 19)}... in ${repository.name}, Code ${codeSha.slice(0, 12)} (no image built or copied)`);
  return manifest;
}

function resolveRollbackDigest(args: ImageStepArgs, manifest: GatewayManifest, lastGood: GatewayLastGoodRecord | null): string {
  if (args.env === "production") {
    if (args.gatewayDigest !== null) throw new StageError("REFUSED", "production copies the digest beta ran; it takes no MODEL_GATEWAY_DIGEST");
    if (manifest.gateway.digest === null || !IMAGE_DIGEST.test(manifest.gateway.digest)) {
      throw new StageError("REFUSED", "production rollback has no beta gateway digest in the manifest");
    }
    return manifest.gateway.digest;
  }
  if (args.gatewayDigest !== null) return args.gatewayDigest;
  if (args.codeRollbackTarget !== null) {
    const match = recordedGateways(lastGood).find((entry) => entry.codeSha === args.codeRollbackTarget);
    if (match !== undefined) return match.digest;
  }
  throw new StageError("ROLLBACK_REFUSED", "a beta rollback requires MODEL_GATEWAY_DIGEST (or a recorded gateway digest matching CODE_ROLLBACK_TARGET); run rollback-plan to see recorded digests");
}

async function runRollbackImage(
  args: ImageStepArgs,
  manifest: GatewayManifest,
  repository: Repository,
  lastGood: GatewayLastGoodRecord | null,
): Promise<GatewayManifest> {
  const digest = resolveRollbackDigest(args, manifest, lastGood);
  const recorded = recordedGatewayDigests(lastGood);
  if (!recorded.includes(digest)) {
    throw new StageError("ROLLBACK_REFUSED", `rollback digest ${digest.slice(0, 19)}... is not in ${args.env}'s model gateway last-good record`);
  }
  const floors = loadFloors(args.ports, args.floorsPath);
  const digestFailures = judgeDigest(floors, digest);
  if (digestFailures.length > 0) throw new StageError("ROLLBACK_REFUSED", digestFailures.join("; "));
  const codeSha = await gatewayCodeForRecordedDigest(args.ports, lastGood, digest, args.env);
  if (codeSha !== null) {
    const shaVerdict = await judgeGatewayCodeSha(args.ports, floors, args.repoDir, codeSha);
    if (shaVerdict.failures.length > 0) throw new StageError("ROLLBACK_REFUSED", shaVerdict.failures.join("; "));
  }
  if (args.env === "beta") {
    const found = await findImage(args.ports, repository.name, { digest });
    if (found === null) throw new StageError("ROLLBACK_REFUSED", `rollback digest ${digest.slice(0, 19)}... is not in ${repository.name}`);
    manifest.gateway = { digest, source: "supplied", imageTag: found.tags[0] ?? null, repository: repository.name, codeSha };
    args.log(`rollback (beta): verified recorded digest ${digest.slice(0, 19)}... in ${repository.name}`);
    return manifest;
  }
  const copied = await copyFromBeta(args, manifest, repository);
  manifest.gateway = { digest: copied.digest, source: "copied", imageTag: copied.imageTag, repository: repository.name, codeSha };
  return manifest;
}

export async function imageStep(args: ImageStepArgs): Promise<GatewayManifest> {
  if (args.codeRelease === "skip" && args.mode === "release") {
    args.log(`CODE_RELEASE=skip: skipping model gateway image step for ${args.env}`);
    return newManifest(args, true, "CODE_RELEASE=skip");
  }
  const account = await assertExpectedAccount(args.ports, args.expectedAccount);
  const manifest = newManifest(args, false);
  manifest.stages[args.env]!.account = account;
  if (args.gatewayDigest !== null && !IMAGE_DIGEST.test(args.gatewayDigest)) {
    throw new StageError("USAGE", "MODEL_GATEWAY_DIGEST must look like sha256:<64 hex>");
  }
  if (args.mode !== "rollback" && args.gatewayDigest !== null) {
    throw new StageError("USAGE", `MODEL_GATEWAY_DIGEST is only for PIPELINE_MODE=rollback (got mode ${args.mode})`);
  }
  const repository = await ownRepository(args.ports, args.env);
  if (args.mode === "adopt") return await adoptLiveGateway(args, manifest, repository);
  const lastGood = await readLastGood(args.ports, args.env);
  if (lastGood === null) {
    throw new StageError("ADOPTION_REQUIRED", `${args.env} has no model gateway last-good record: run PIPELINE_MODE=adopt once before the first release`);
  }
  if (args.mode === "rollback") return await runRollbackImage(args, manifest, repository, lastGood);
  if (args.dryRun) {
    manifest.stages[args.env]!.warnings.push("dry run: no model gateway image built or copied");
    return manifest;
  }
  if (args.env === "beta") {
    const sourceDir = await checkoutCleanCodeTree(args.ports, args.repoDir, args.workDir, args.codeSha);
    const built = await buildAndPushBeta(args, repository, sourceDir, args.codeSha);
    manifest.gateway = { digest: built.digest, source: "built", imageTag: built.imageTag, repository: repository.name, codeSha: args.codeSha };
    return manifest;
  }
  if (args.gatewayDigest !== null) throw new StageError("REFUSED", "production copies beta's digest; it takes no MODEL_GATEWAY_DIGEST");
  const codeSha = manifest.gateway.codeSha;
  if (codeSha === null && !(await keepsLiveGateway(args.ports, "production", manifest.gateway.digest ?? "")).keep) {
    throw new StageError("REFUSED", "production has no Code commit for the model gateway from beta");
  }
  const copied = await copyFromBeta(args, manifest, repository);
  manifest.gateway = { digest: copied.digest, source: "copied", imageTag: copied.imageTag, repository: repository.name, codeSha };
  return manifest;
}
