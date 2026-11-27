// Step 2: ModelGatewayDeploy (#1578).
// Synthesizes Code's RovaraModelGateway stack at manifest.gateway.codeSha with -c rovaraCodeSha=<codeSha>,
// previews a change set by name, runs integrity / protected / rollback-floor / source-switch gates on it,
// executes by name (or discards in adopt/dry-run mode), waits to settle, and tidies old change sets.
import { MODEL_GATEWAY_STACK_ID, changeSetNameFor, modelGatewayCdkContext, modelGatewayStackName } from "./context.js";
import { discardChangeSet, executeRecorded, previewGatewayChangeSet, tidyChangeSets } from "./changesets.js";
import { removeDir } from "./ecr.js";
import { judgeDigest, judgeGatewayCodeSha, loadFloors } from "./floors.js";
import { keepsLiveGateway } from "./lastgood.js";
import { PROTECTED_PATH, checkProtected, parseProtected } from "./protected.js";
import type { ProtectedList } from "./protected.js";
import { judgeGatewaySwitch } from "./source-switch.js";
import { StageError } from "./types.js";
import type { ChangeSetRecord, GateVerdict, GatewayManifest, PipelineEnv, Ports } from "./types.js";

export const SETTLE_TIMEOUT_SECONDS = 30 * 60;
const SHA40 = /^[0-9a-f]{40}$/u;

export interface DeployStepArgs {
  env: PipelineEnv;
  region: string;
  repoDir: string;
  workDir: string;
  dryRun: boolean;
  manifest: GatewayManifest;
  ports: Ports;
  log: (line: string) => void;
  protectedPath?: string;
  floorsPath?: string;
}

function adoptRowFailures(record: ChangeSetRecord): string[] {
  const failures: string[] = [];
  for (const row of record.rows) {
    if (row.action === "Modify" && row.resourceType === "AWS::CDK::Metadata") continue;
    failures.push(`${record.stack}: adopt mode must change nothing, but ${row.action} ${row.logicalId} (${row.resourceType})`);
  }
  return failures;
}

function judgeIntegrity(manifest: GatewayManifest, record: ChangeSetRecord): GateVerdict {
  const failures: string[] = [];
  const expected = changeSetNameFor(manifest.exec8);
  if (record.changeSetName !== expected) failures.push(`${record.stack}: change set is named ${record.changeSetName}, not ${expected}`);
  if (!record.noChanges) {
    if (record.changeSetId === null || record.templateSha256 === null) failures.push(`${record.stack}: missing change set id or template hash`);
    if (record.status !== "CREATE_COMPLETE" || record.executionStatus !== "AVAILABLE") {
      failures.push(`${record.stack}: change set is ${record.status}/${record.executionStatus}, not CREATE_COMPLETE/AVAILABLE`);
    }
  }
  if (manifest.mode === "adopt") failures.push(...adoptRowFailures(record));
  const result = failures.length === 0 ? "pass" : "fail";
  return failures.length === 0
    ? { name: "change-set-integrity", phase: "change-sets", result }
    : { name: "change-set-integrity", phase: "change-sets", result, failures };
}

async function isImageOnlyChange(args: DeployStepArgs, list: ProtectedList, notes: string[]): Promise<boolean> {
  if (args.manifest.mode === "adopt") return false;
  const stack = await args.ports.cfn.describeStack(modelGatewayStackName(args.env));
  const liveCode = stack?.outputs.DeployedCodeSha;
  const candidateCode = args.manifest.gateway.codeSha;
  if (liveCode === undefined || !SHA40.test(liveCode) || candidateCode === null) {
    notes.push("live gateway has no DeployedCodeSha output: general protected rules apply");
    return false;
  }
  if (liveCode === candidateCode) return true;
  const diff = await args.ports.exec("git", ["-C", args.repoDir, "diff", "--quiet", liveCode, candidateCode, "--", ...list.imageOnlyCodePaths]);
  if (diff.code === 0) return true;
  notes.push(`gateway infra changed between ${liveCode.slice(0, 9)} and ${candidateCode.slice(0, 9)}: general protected rules apply`);
  return false;
}

async function judgeProtectedGate(args: DeployStepArgs, record: ChangeSetRecord): Promise<GateVerdict> {
  const path = args.protectedPath ?? PROTECTED_PATH;
  let list: ProtectedList;
  try { list = parseProtected(args.ports.fs.readText(path)); } catch (error) {
    return { name: "protected", phase: "change-sets", result: "fail", failures: [`cannot read protected.json: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const notes: string[] = [];
  const imageOnly = await isImageOnlyChange(args, list, notes);
  const result = checkProtected(list, record, { imageOnly });
  return {
    name: "protected",
    phase: "change-sets",
    result: result.failures.length === 0 ? "pass" : "fail",
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
    notes: [...notes, ...result.notes],
    data: { rows: result.checkedRows, imageOnly },
  };
}

async function judgeFloorsGate(args: DeployStepArgs): Promise<GateVerdict> {
  if (args.manifest.mode === "adopt") {
    return { name: "rollback-floor", phase: "change-sets", result: "skipped", skippedReason: "adopt mode checks what is already live" };
  }
  let floors;
  try { floors = loadFloors(args.ports, args.floorsPath); } catch (error) {
    return { name: "rollback-floor", phase: "change-sets", result: "fail", failures: [error instanceof Error ? error.message : String(error)] };
  }
  const failures: string[] = [];
  const notes: string[] = [];
  if (args.manifest.gateway.digest !== null) failures.push(...judgeDigest(floors, args.manifest.gateway.digest));
  const codeSha = args.manifest.gateway.codeSha;
  if (codeSha === null) failures.push("manifest has no Code commit for the model gateway");
  else {
    const verdict = await judgeGatewayCodeSha(args.ports, floors, args.repoDir, codeSha);
    failures.push(...verdict.failures);
    notes.push(...verdict.notes);
  }
  return { name: "rollback-floor", phase: "change-sets", result: failures.length === 0 ? "pass" : "fail", ...(failures.length === 0 ? {} : { failures }), notes };
}

async function judgeSourceSwitchGate(args: DeployStepArgs, record: ChangeSetRecord): Promise<GateVerdict> {
  const name = modelGatewayStackName(args.env);
  const live = await args.ports.cfn.describeStack(name);
  if (live === null) return { name: "gateway-source-switch", phase: "change-sets", result: "skipped", skippedReason: "gateway stack does not exist yet" };
  const deployedFrom = live.outputs.DeployedCodeSha;
  if (deployedFrom !== undefined && SHA40.test(deployedFrom)) {
    return { name: "gateway-source-switch", phase: "change-sets", result: "skipped", skippedReason: `live gateway already deployed from Code (${deployedFrom.slice(0, 12)})` };
  }
  if (record.noChanges) return { name: "gateway-source-switch", phase: "change-sets", result: "pass", notes: ["change set has no changes"] };
  const liveDigest = live.parameters.ImageDigest;
  if (record.rows.length > 0 && liveDigest !== undefined && liveDigest === args.manifest.gateway.digest) {
    return { name: "gateway-source-switch", phase: "change-sets", result: "fail", failures: [`image is unchanged (${liveDigest.slice(0, 19)}...) so first Code change set must have 0 resource rows, found ${record.rows.length}`] };
  }
  const codeSha = args.manifest.gateway.codeSha;
  if (codeSha === null) return { name: "gateway-source-switch", phase: "change-sets", result: "fail", failures: ["manifest names no Code commit for source-switch check"] };
  const liveTemplate = await args.ports.cfn.liveTemplateBody(name);
  const nextTemplate = await args.ports.cfn.templateBody(name, record.changeSetName);
  if (liveTemplate === null) return { name: "gateway-source-switch", phase: "change-sets", result: "fail", failures: [`live template of ${name} could not be read`] };
  const verdict = judgeGatewaySwitch(liveTemplate, nextTemplate, codeSha);
  return {
    name: "gateway-source-switch",
    phase: "change-sets",
    result: verdict.failures.length === 0 ? "pass" : "fail",
    ...(verdict.failures.length === 0 ? { notes: ["first Code change set changes outputs only"] } : { failures: verdict.failures }),
  };
}

async function prepareCdkTree(args: DeployStepArgs, codeSha: string): Promise<string> {
  const head = await args.ports.exec("git", ["rev-parse", "HEAD"], { cwd: args.repoDir });
  let dir = args.repoDir;
  if (head.code !== 0 || head.stdout.trim() !== codeSha) {
    dir = `${args.workDir}/cdk-${codeSha.slice(0, 12)}`;
    await removeDir(args.ports, dir);
    const wt = await args.ports.exec("git", ["worktree", "add", "--detach", dir, codeSha], { cwd: args.repoDir });
    if (wt.code !== 0) throw new StageError("FAILED", `git worktree add failed for ${codeSha.slice(0, 12)}`);
    const ci = await args.ports.exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir });
    if (ci.code !== 0) throw new StageError("FAILED", `npm ci failed in ${dir} (exit ${ci.code})`);
  }
  const build = await args.ports.exec("npx", ["--no-install", "tsc", "-b", "infra"], { cwd: dir });
  if (build.code !== 0) throw new StageError("FAILED", `tsc -b infra failed (exit ${build.code})`);
  return dir;
}

export async function deployStep(args: DeployStepArgs): Promise<GatewayManifest> {
  const { manifest, env, ports, log } = args;
  if (manifest.skipped) {
    log(`skipping model gateway deploy step (${manifest.skipReason ?? "skipped"})`);
    return manifest;
  }
  const stage = manifest.stages[env];
  if (stage === undefined) throw new StageError("REFUSED", `manifest has no ${env} stage record`);
  const digest = manifest.gateway.digest;
  if (digest === null) throw new StageError("REFUSED", "manifest has no model gateway digest: image step did not complete");
  const codeSha = manifest.gateway.codeSha;
  if (codeSha === null) {
    const kept = await keepsLiveGateway(ports, env, digest);
    if (!kept.keep) throw new StageError("REFUSED", `manifest has no Code commit for gateway and live gateway cannot be kept: ${kept.why}`);
    stage.warnings.push(`kept live ${env} gateway (${digest.slice(0, 19)}...) without a change set`);
    log(`keeping live ${env} gateway stack (${digest.slice(0, 19)}...): no change set created`);
    return manifest;
  }
  if (args.dryRun) {
    stage.warnings.push("dry run: no gateway change set created");
    return manifest;
  }
  const stack = modelGatewayStackName(env);
  const changeSetName = changeSetNameFor(manifest.exec8);
  const dir = await prepareCdkTree(args, codeSha);
  try {
    const record = await previewGatewayChangeSet({
      ports, dir, changeSetName, stack, stackId: MODEL_GATEWAY_STACK_ID,
      context: modelGatewayCdkContext(env, args.region, codeSha),
      parameters: { ImageDigest: digest },
      log,
    });
    stage.changeSet = record;
    const verdicts = [
      judgeIntegrity(manifest, record),
      await judgeProtectedGate(args, record),
      await judgeFloorsGate(args),
      await judgeSourceSwitchGate(args, record),
    ];
    stage.gates.push(...verdicts);
    const failed = verdicts.filter((v) => v.result === "fail");
    if (failed.length > 0) {
      const detail = failed.map((v) => `${v.name}: ${(v.failures ?? []).join("; ")}`).join(" | ");
      throw new StageError("GATE_FAILED", `gateway change-set gate failed: ${detail}`);
    }
    if (manifest.mode === "adopt") {
      await discardChangeSet(ports, stack, changeSetName, log);
      log(`adopt (${env}): change set verified as no-op and discarded; nothing executed`);
      return manifest;
    }
    stage.changeSet = await executeRecorded(ports, record, SETTLE_TIMEOUT_SECONDS, log);
  } catch (error) {
    await discardChangeSet(ports, stack, changeSetName, log);
    throw error;
  }
  await tidyChangeSets(ports, stack, changeSetName, log);
  return manifest;
}
