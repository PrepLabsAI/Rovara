import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { E2EApplicationEvidenceRefSchema, ProjectSetupRunnerToolchainSchema, canonicalJson, type E2EApplicationEvidenceRef, type E2ERunBinding } from "@agentx/contracts";
import type { E2EActualApplicationRun, E2EActualApplicationShard } from "../application-collection.js";
import { compareE2EApplicationPublicList } from "../application-identity.js";
import { parseE2EApplicationReport } from "../application-report-schema.js";
import { E2EApplicationAssertionAssetBindingSchema, E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema, e2eApplicationAggregateRunUsage,
  normalizeE2EApplicationPublicList, type E2EApplicationAssertionAssetBinding, type E2EApplicationObservationBinding, type E2EApplicationProofBytes } from "../application-result-adapter.js";
import { expectedE2EApplicationReporterDigest } from "../application-runtime-assets.js";
import type { E2ECompiledApplicationSuite } from "../application-scenarios.js";
import { uuidFor } from "../executor/case-ledger.js";
import { openRegularFile } from "./regular-file.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 2_048;
const SAFE_DIR = /^[a-f0-9]{16}$/;

/** What the executor wrote to `executor-result.json`; only the fields the host reads are listed. */
const processRecordSchema = z.object({ status: z.number().int().nullable(), signal: z.string().nullable(), startedAt: z.string(), finishedAt: z.string(),
  timedOut: z.boolean(), aborted: z.boolean(), outputExceeded: z.boolean().optional(), stdoutSha256: z.string(), stderrSha256: z.string(),
  stdoutBytes: z.number().int().nonnegative(), stderrBytes: z.number().int().nonnegative() }).strict();
export const ExecutorResultFileSchema = z.object({
  schemaVersion: z.literal("e2e-executor-result/v1"), exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]), reason: z.string().nullable(),
  startedAt: z.string(), finishedAt: z.string(),
  node: z.object({ version: z.string(), execPath: z.string(), platform: z.string(), arch: z.string() }).strict(),
  runId: z.string().nullable(), groupId: z.string().nullable(),
  shards: z.array(z.object({ shardId: z.string(), launchId: z.string().uuid(), targetKind: z.string(), upstreamRunId: z.string().uuid().nullable(),
    completed: z.boolean(), failed: z.boolean(), reason: z.string().nullable(), list: processRecordSchema, run: processRecordSchema.nullable() }).strict()),
}).strict();
export type ExecutorResultFile = z.infer<typeof ExecutorResultFileSchema>;

type OutputEvidence = Readonly<{ ref: E2EApplicationEvidenceRef; bytes: Uint8Array; kind: string }>;
type ShardFiles = Readonly<{ list: Uint8Array; listStderr: Uint8Array; report: Uint8Array; runStderr: Uint8Array; runStart: Uint8Array }>;
/** Everything the host takes out of the executor's out directory, read once, before the directory is removed. */
export type ExecutorOutputSnapshot = Readonly<{ result: ExecutorResultFile; shardFiles: ReadonlyMap<string, ShardFiles>; evidence: readonly OutputEvidence[];
  /** The protected facts the ledger persisted for the collector's oracle: one observation binding per case, one binding per approved assertion asset. */
  observationBindings: readonly E2EApplicationObservationBinding[]; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  /** The merged report for a single-shard run, kept so the host can hand it to the lifecycle as the raw report. */
  reportBytes: Uint8Array | null }>;

/** A regular, non-link file below `root`, read in full and never past the bound. */
async function readRegular(root: string, relativePath: string, budget: { total: number }): Promise<Uint8Array> {
  const path = join(root, ...relativePath.split("/"));
  // Decided on the open handle, not on the path: a link or FIFO swapped in by a container that still runs is refused, never followed or waited on.
  let opened: Awaited<ReturnType<typeof openRegularFile>>;
  try { opened = await openRegularFile(path); } catch { throw new Error(`executor output ${relativePath} is not a bounded regular file`); }
  const { handle, size } = opened;
  try {
    if (size > MAX_FILE_BYTES) throw new Error(`executor output ${relativePath} is not a bounded regular file`);
    budget.total += size;
    if (budget.total > MAX_TOTAL_BYTES) throw new Error("executor output exceeds the host's total read bound");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== size) throw new Error(`executor output ${relativePath} changed while being read`);
    return Uint8Array.from(bytes);
  } finally { await handle.close(); }
}

const MAX_BINDING_FILES = 64;
const MAX_ASSET_FILES = 128;
const bindingFileSchema = z.object({ schemaVersion: z.string(), caseId: z.string().min(1).max(160), sha256: z.string().regex(/^[a-f0-9]{64}$/), binding: z.unknown() }).strict();

/** The executor's result must describe a finished run of exactly this group before anything else in its out directory is trusted. */
export function validateExecutorResult(result: ExecutorResultFile, binding: Pick<E2ERunBinding, "runId" | "groupId">): void {
  if (result.exitCode === 2 || result.runId !== binding.runId || result.groupId !== binding.groupId) throw new Error("executor result is not a completed run of this group");
}

/** A directory the executor created inside its own out directory: a link in its place would read whatever it points at. */
async function requireRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`executor output ${label} is not a real directory`);
}

const observationSchema = z.object({ schemaVersion: z.literal("e2e-executor-observation/v1"), artifactId: z.string().min(1).max(200), kind: z.string(),
  mediaType: z.string().min(1).max(120), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative(),
  encoding: z.enum(["utf8", "base64"]).optional(), content: z.string().optional(), file: z.string().optional() }).passthrough();

/** Reads `executor-result.json` alone; the host decides from it (and the container exit code) whether the rest may be read. */
export async function readExecutorResultFile(outDir: string): Promise<ExecutorResultFile> {
  const bytes = await readRegular(outDir, "executor-result.json", { total: 0 });
  return ExecutorResultFileSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export const executorShardDirectory = (shardId: string): string => sha(shardId).slice(0, 16);

/** Reads the out directory of a finished executor run: its result file, every shard's CLI files and every evidence item. */
export async function snapshotExecutorOutput(outDir: string, result: ExecutorResultFile): Promise<ExecutorOutputSnapshot> {
  const budget = { total: 0 };
  const shardFiles = new Map<string, ShardFiles>();
  if (result.shards.length > 0) await requireRealDirectory(join(outDir, "shards"), "shards");
  for (const shard of result.shards) {
    const directory = `shards/${executorShardDirectory(shard.shardId)}`;
    if (!SAFE_DIR.test(directory.slice("shards/".length))) throw new Error("executor shard directory name is invalid");
    await requireRealDirectory(join(outDir, directory), directory);
    shardFiles.set(shard.shardId, Object.freeze({
      list: await readRegular(outDir, `${directory}/list.stdout.json`, budget), listStderr: await readRegular(outDir, `${directory}/list.stderr.txt`, budget),
      report: await readRegular(outDir, `${directory}/report.json`, budget), runStderr: await readRegular(outDir, `${directory}/run.stderr.txt`, budget),
      runStart: await readRegular(outDir, `${directory}/run-start.jsonl`, budget) }));
  }
  await requireRealDirectory(join(outDir, "observations"), "observations");
  const names = (await readdir(join(outDir, "observations"))).filter((name) => /^ev-[A-Za-z0-9_-]+\.json$/.test(name)).sort();
  if (names.length > MAX_FILES) throw new Error("executor output holds more evidence items than the host reads");
  const evidence: OutputEvidence[] = [];
  for (const name of names) {
    const row = observationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRegular(outDir, `observations/${name}`, budget))));
    let bytes: Uint8Array;
    if (row.file !== undefined) {
      if (!/^downloads\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(row.file) || row.file.includes("..")) throw new Error("executor evidence file path is outside downloads");
      await requireRealDirectory(join(outDir, "downloads"), "downloads");
      bytes = await readRegular(outDir, row.file, budget);
    } else if (row.content !== undefined && row.encoding !== undefined) bytes = Uint8Array.from(Buffer.from(row.content, row.encoding === "base64" ? "base64" : "utf8"));
    else throw new Error("executor evidence row carries neither content nor a file");
    if (bytes.byteLength !== row.byteLength || sha(bytes) !== row.sha256 || row.artifactId !== name.slice(0, -".json".length)) {
      throw new Error("executor evidence bytes differ from the digest the executor recorded");
    }
    const ref = E2EApplicationEvidenceRefSchema.parse({ artifactId: row.artifactId, sha256: row.sha256, byteLength: row.byteLength, mediaType: row.mediaType });
    evidence.push(Object.freeze({ ref, bytes, kind: row.kind }));
  }
  let reportBytes: Uint8Array | null = null;
  try { reportBytes = await readRegular(outDir, "report.json", budget); } catch { /* a run without a merged report has none */ }
  const readBindings = async <T>(pattern: RegExp, max: number, schemaVersion: string, parse: (value: unknown) => T): Promise<T[]> => {
    const files = (await readdir(join(outDir, "observations"))).filter((name) => pattern.test(name)).sort();
    if (files.length > max) throw new Error("executor output holds more protected bindings than the host reads");
    return Promise.all(files.map(async (name) => {
      const row = bindingFileSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRegular(outDir, `observations/${name}`, budget))));
      if (row.schemaVersion !== schemaVersion || row.sha256 !== sha(canonicalJson(row.binding))) throw new Error("executor binding differs from the digest the executor recorded");
      return parse(row.binding);
    }));
  };
  const observationBindings = await readBindings(/^binding-[A-Za-z0-9._-]+\.json$/, MAX_BINDING_FILES, "e2e-executor-observation-binding/v1",
    (value) => E2EApplicationObservationBindingSchema.parse(value));
  const assertionAssets = await readBindings(/^asset-[A-Za-z0-9._-]+\.json$/, MAX_ASSET_FILES, "e2e-executor-asset-binding/v1",
    (value) => E2EApplicationAssertionAssetBindingSchema.parse(value));
  return Object.freeze({ result, shardFiles, evidence: Object.freeze(evidence), observationBindings: Object.freeze(observationBindings),
    assertionAssets: Object.freeze(assertionAssets), reportBytes });
}

/** The identity of what the host owns for one run, so a collector can recompute it without asking the host. */
export function dockerOwnedResourceInventory(runId: string): { schemaVersion: "rovara-docker-owned-inventory/v1"; runId: string; label: string; network: string; containers: string[] } {
  return { schemaVersion: "rovara-docker-owned-inventory/v1", runId, label: `rovara.run=${runId}`, network: `rovara-e2e-${runId}`,
    containers: [`rovara-app-${runId}`, `rovara-executor-${runId}`] };
}
export const dockerOwnedResourceInventoryDigest = (runId: string): string => sha(canonicalJson(dockerOwnedResourceInventory(runId)));

const compare = (a: string, b: string) => a.localeCompare(b);
function proof(value: unknown, mediaType: string, artifactId: string): { ref: E2EApplicationEvidenceRef; bytes: Uint8Array } {
  const bytes = Uint8Array.from(Buffer.from(typeof value === "string" ? value : canonicalJson(value), "utf8"));
  return { ref: E2EApplicationEvidenceRefSchema.parse({ artifactId, sha256: sha(bytes), byteLength: bytes.byteLength, mediaType }), bytes };
}
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

type OwnedCleanup = { removedAt: string; containers: readonly string[]; network: string };
const ownedCleanupReceipt = (binding: Pick<E2ERunBinding, "runId">, cleanup: OwnedCleanup) => proof({ schemaVersion: "rovara-docker-owned-cleanup/v1",
  runId: binding.runId, removedAt: cleanup.removedAt, network: cleanup.network, containers: [...cleanup.containers].sort(compare),
  inventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId) }, "application/json", `rovara-owned-cleanup-${binding.runId}`);

/** What `collectE2EApplicationRun` takes besides the actual run, the compiled suite, the binding and the round. */
export type DockerCollectionInputs = Readonly<{ environment: { ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string };
  usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
  observationBindings: readonly E2EApplicationObservationBinding[]; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  governedModelReceipts: readonly never[]; ownedClosedAt: string }>;

/**
 * The collector's protected inputs for a finished run: the bindings the ledger persisted, the cleanup receipt the host will
 * attest, the inventory digest recomputed from the run id, and the close time. Environment, limits and usage come from the
 * runner's own reports, reconciled with the runner's sum and max rules.
 */
export function assembleDockerCollectionInputs(input: { snapshot: ExecutorOutputSnapshot; binding: E2ERunBinding; cleanup: OwnedCleanup }): DockerCollectionInputs {
  validateExecutorResult(input.snapshot.result, input.binding);
  const reports = input.snapshot.result.shards.map((row) => {
    const files = input.snapshot.shardFiles.get(row.shardId);
    const parsed = files ? parseE2EApplicationReport(files.report) : null;
    if (!parsed || parsed.kind !== "parsed") throw new Error("a shard report is unreadable");
    return parsed.report.run;
  });
  const first = reports[0];
  const usage = e2eApplicationAggregateRunUsage(reports.map((run) => run.usage as Readonly<Record<string, number>>));
  if (!first || !usage) throw new Error("shard reports do not reconcile to one group usage");
  return Object.freeze({ environment: first.environment, usage, limits: first.limits,
    expectedSupervisorReceiptRefs: Object.freeze([ownedCleanupReceipt(input.binding, input.cleanup).ref]),
    ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(input.binding.runId),
    observationBindings: input.snapshot.observationBindings, assertionAssets: input.snapshot.assertionAssets, governedModelReceipts: Object.freeze([]),
    ownedClosedAt: input.cleanup.removedAt });
}

/**
 * Assembles the post-close private readback the lifecycle asks for. The executor's evidence is the case proof; the host adds
 * the two frames only it can attest (the owned-cleanup receipt and the supervisor receipt) once the run's resources are
 * confirmed gone. Nothing here decides pass or fail: the collector validates every byte again and the oracle judges the cases.
 */
export function assembleExecutorActualRun(input: { snapshot: ExecutorOutputSnapshot; compiled: E2ECompiledApplicationSuite; binding: E2ERunBinding;
  cleanup: OwnedCleanup; evidenceDirectory: string }): E2EActualApplicationRun {
  const { snapshot, compiled, binding } = input;
  const result = snapshot.result;
  if (result.exitCode === 2 || result.runId !== binding.runId || result.groupId !== binding.groupId) throw new Error("executor result is not a completed run of this group");
  const toolchain = ProjectSetupRunnerToolchainSchema.parse({ execPath: result.node.execPath, version: result.node.version, platform: result.node.platform, arch: result.node.arch });
  if (canonicalJson([...result.shards.map((item) => item.shardId)].sort()) !== canonicalJson(compiled.shards.map((item) => item.shardId).sort())) {
    throw new Error("executor result omits or adds a compiled shard");
  }
  let selected = 0; let filtered = 0;
  const shards: E2EActualApplicationShard[] = result.shards.map((row) => {
    const compiledShard = compiled.shards.find((item) => item.shardId === row.shardId)!;
    const files = snapshot.shardFiles.get(row.shardId);
    if (!files || !row.completed || row.run === null) throw new Error("executor shard did not complete");
    const publicList = normalizeE2EApplicationPublicList(JSON.parse(decode(files.list)) as unknown, compiledShard.selection.targetId);
    const listed = compareE2EApplicationPublicList(compiledShard.selection, publicList);
    selected += listed.selected.length; filtered += listed.filtered.length;
    const runStart = (() => { try { return JSON.parse(decode(files.runStart).trim()) as unknown; } catch { return null; } })();
    const pick = (record: NonNullable<typeof row.run>) => ({ status: record.status, signal: record.signal, startedAt: record.startedAt, finishedAt: record.finishedAt,
      timedOut: record.timedOut, aborted: record.aborted, stdoutSha256: record.stdoutSha256, stderrSha256: record.stderrSha256,
      stdoutBytes: record.stdoutBytes, stderrBytes: record.stderrBytes });
    return Object.freeze({ shardId: row.shardId, launchId: row.launchId, launchConfigDigest: compiledShard.expectedConfigDigest,
      fixedAssetDigests: Object.freeze({ reporter: expectedE2EApplicationReporterDigest(row.launchId), compilerInventory: compiledShard.inventory.digest }),
      publicList, listStdoutBytes: files.list, listStderrBytes: files.listStderr, rawReportBytes: files.report, runStderrBytes: files.runStderr,
      runStartCaptureBytes: files.runStart, runStartCapture: runStart, listProcess: pick(row.list), runProcess: pick(row.run) });
  });

  const lifecycleId = `rovara-executor-${binding.runId}`;
  const observedAt = new Date().toISOString();
  const producer = { producerId: "rovara-docker-host/v1", receiptId: `${binding.runId}:supervisor`, lifecycleId, operationId: uuidFor(binding.operationId),
    operationFence: binding.operationFence, runtimeManifestDigest: binding.runtimeManifestDigest, transportCorrelationId: randomUUID() };
  const context = { bindingDigest: sha(canonicalJson(binding)), compiledInventoryDigest: compiled.inventory.digest,
    preparedEnvironmentDigest: compiled.preparedEnvironmentDigest, candidateDigest: binding.candidateDigest, roundId: binding.roundId, runId: binding.runId,
    groupId: binding.groupId, lifecycleId, observedAt, producer };

  // The runtime writes each case capture with cleanup "pending": only the host can say the run's resources are gone. Once cleanup is
  // confirmed it re-seals each capture under the same artifact id, so the closure binds the new bytes.
  const sealedCaptures = new Map<string, OutputEvidence>();
  const captures = snapshot.evidence.filter((item) => item.kind === "case-capture").map((item) => {
    const original = E2EApplicationCaseCaptureSchema.parse(JSON.parse(decode(item.bytes)));
    // The in-run frame names the compiled test and the scenario's component list as coverage; the collector derives coverage from the
    // observations themselves and rejects anything else, so the sealed frame states it that way: the application ran, and the
    // behaviors not exercised are the assertions that did not pass.
    const coverage = { ...original.coverage, executedCandidateParts: original.coverage.observedScope === "source" ? [] : [original.applicationId],
      unexercisedBehaviors: original.assertions.filter((assertion) => assertion.outcome !== "passed").map((assertion) => assertion.digest) };
    // The sealed frame is a new artifact and lists the executor's original capture among its artifacts, so the original bytes stay in the
    // closure and an auditor can compare the two: only `cleanup` and `coverage` differ.
    const capture = E2EApplicationCaseCaptureSchema.parse({ ...original, coverage, cleanup: "confirmed", artifacts: [...original.artifacts, item.ref] });
    const sealed = proof(capture, item.ref.mediaType, `${item.ref.artifactId}-sealed`);
    const resealed: OutputEvidence = Object.freeze({ ref: sealed.ref, bytes: sealed.bytes, kind: item.kind });
    sealedCaptures.set(item.ref.artifactId, resealed);
    return { capture, item: resealed };
  });
  const cleanupReceipt = ownedCleanupReceipt(binding, input.cleanup);
  const cleanupFrame = proof({ schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close", cleanup: "confirmed", confirmed: true,
    serverListening: false, ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId), ownedCleanupReceiptRefs: [cleanupReceipt.ref] },
  "application/json", `rovara-cleanup-frame-${binding.runId}`);
  const launches = result.shards.map((row) => ({ shardId: row.shardId, launchId: row.launchId, upstreamRunId: row.upstreamRunId ?? "" }))
    .sort((a, b) => compare(a.shardId, b.shardId));
  const receiptFrame = proof({ schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
    caseCaptures: captures.map(({ capture, item }) => ({ caseId: capture.caseId, shardId: capture.shardId, ref: item.ref })).sort((a, b) => compare(a.caseId, b.caseId)),
    mockConsumptions: [], cleanupRef: cleanupFrame.ref, additionalSupervisorReceiptRefs: [cleanupReceipt.ref] },
  "application/json", `rovara-supervisor-receipt-${binding.runId}`);

  const evidence: E2EApplicationProofBytes[] = [...snapshot.evidence.map(({ ref, bytes }) => ({ ref, bytes })), ...[...sealedCaptures.values()].map(({ ref, bytes }) => ({ ref, bytes })), cleanupReceipt, cleanupFrame]
    .sort((a, b) => compare(a.ref.artifactId, b.ref.artifactId));
  const supervisorReceiptRefs = [receiptFrame.ref, cleanupReceipt.ref].sort((a, b) => compare(a.artifactId, b.artifactId));
  return Object.freeze({ protocol: "e2e-actual-application-run/v1" as const, runnerToolchain: toolchain, shards: Object.freeze(shards),
    applicationCaptures: Object.freeze(captures.map(({ capture }) => capture)), supervisorReceiptRefs: Object.freeze(supervisorReceiptRefs),
    declaredMockComponentIds: Object.freeze([...new Set(compiled.group.mocks.map((mock) => mock.componentId))].sort()),
    selected, filtered, supervisorReadback: Object.freeze({ schemaVersion: "e2e-application-supervisor-readback/v1" as const,
      receipt: receiptFrame, evidence: Object.freeze(evidence) }),
    cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: input.evidenceDirectory });
}
