import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { E2EApplicationEvidenceRefSchema, E2E_AGENT_TRACES_PER_GROUP_MAX, E2E_AGENT_TRACE_FILE_MAX_BYTES, ProjectSetupRunnerToolchainSchema, canonicalJson, type E2EApplicationEvidenceRef, type E2ERunBinding } from "@agentx/contracts";
import { bindMockLedgers, type CaseWindow, type ParsedMockLedger } from "./mock-ledger.js";
import { buildMockProofs } from "./mock-proofs.js";
import { SINKHOLE_ORIGIN_REF } from "../application-mocks.js";
import type { E2EActualApplicationRun, E2EActualApplicationShard } from "../application-collection.js";
import { compareE2EApplicationPublicList } from "../application-identity.js";
import { parseE2EApplicationReport } from "../application-report-schema.js";
import type { E2EAgentModelEvidence } from "../application-agent-result.js";
import { E2EApplicationAssertionAssetBindingSchema, E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema, e2eApplicationAggregateRunUsage,
  normalizeE2EApplicationPublicList, type E2EApplicationAssertionAssetBinding, type E2EApplicationObservationBinding, type E2EApplicationProofBytes } from "../application-result-adapter.js";
import { expectedE2EApplicationReporterDigest } from "../application-runtime-assets.js";
import type { E2ECompiledApplicationSuite } from "../application-scenarios.js";
import { uuidFor } from "../executor/case-ledger.js";
import { CAPTURE_ARTIFACTS_FILE, CAPTURE_DIR, CAPTURE_SCREENSHOT_MAX_BYTES, type CaptureEntry } from "../executor/capture.js";
import { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE } from "../executor/evidence-paths.js";
import { openRegularFile, readRegularFileHead } from "./regular-file.js";

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
/** A stored screenshot as the executor left it, under the name it was stored by (`case-<index>-<kind>.<ext>`). */
export type ExecutorCaptureFile = Readonly<{ name: string; sha256: string; bytes: Uint8Array }>;
/**
 * What the executor left besides the verdict inputs, read best effort: the head of its own log and the screenshots of failed cases. Neither is ever a verdict
 * input, so neither can fail a snapshot; what cannot be read is simply absent.
 */
export type ExecutorOutputEvidence = Readonly<{
  /** The first 64 KiB of `executor.log` (redacted by the executor); empty when there is none or it carries a credential. */
  executorLogHead: Uint8Array;
  /** `artifacts.json` and the capture files it lists that are still on disk and clean; null when the run listed none. */
  captures: Readonly<{ artifacts: readonly CaptureEntry[]; files: readonly ExecutorCaptureFile[] }> | null;
  /**
   * What an agent step left (Task 4.3b), present only for a run that had one: the action ledger of each case that ran an agent step, exactly as the executor wrote it, and the replay
   * recordings it kept. The ledger is read by Task 4.4 through `parseVerifiedE2EAgentActionLedger` and never trusted as is; neither file is ever a verdict input here. A file
   * that carries a run credential (the host's own predicate) or is not a plain bounded file is not handed on and is counted in `dropped`.
   */
  agent?: ExecutorAgentEvidence;
}>;
export type ExecutorAgentEvidence = Readonly<{
  ledgers: ReadonlyArray<Readonly<{ caseDirectory: string; bytes: Uint8Array }>>;
  traces: ReadonlyArray<Readonly<{ name: string; bytes: Uint8Array }>>;
  dropped: number;
}>;
/** One action of one case as the executor's ledger recorded it: when it began and, if it did, when it finished. */
export type ExecutorActionWindow = Readonly<{ caseId: string; actionIndex: number; beganAt: string; finishedAt: string | null }>;
type ShardFiles = Readonly<{ list: Uint8Array; listStderr: Uint8Array; report: Uint8Array; runStderr: Uint8Array; runStart: Uint8Array }>;
/** Everything the host takes out of the executor's out directory, read once, before the directory is removed. */
export type ExecutorOutputSnapshot = Readonly<{ result: ExecutorResultFile; shardFiles: ReadonlyMap<string, ShardFiles>; evidence: readonly OutputEvidence[];
  /** The protected facts the ledger persisted for the collector's oracle: one observation binding per case, one binding per approved assertion asset. */
  observationBindings: readonly E2EApplicationObservationBinding[]; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  /** The merged report for a single-shard run, kept so the host can hand it to the lifecycle as the raw report. */
  reportBytes: Uint8Array | null;
  /** The executor's log head and its captures, for the operator's evidence; never read to decide a result. */
  executorEvidence: ExecutorOutputEvidence;
  /** The executor's action windows, which bind a mock ledger line to the case that was running when it was recorded. */
  actionWindows?: readonly ExecutorActionWindow[];
  /** The ledgers of the run's mocks and sinkhole, read by the host after it stopped them; absent for a run that had none. */
  mockLedgers?: readonly ParsedMockLedger[] }>;

/** A regular, non-link file below `root`, read in full and never past the bound. */
async function readRegular(root: string, relativePath: string, budget: { total: number }, maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES): Promise<Uint8Array> {
  const path = join(root, ...relativePath.split("/"));
  // Decided on the open handle, not on the path: a link or FIFO swapped in by a container that still runs is refused, never followed or waited on.
  let opened: Awaited<ReturnType<typeof openRegularFile>>;
  try { opened = await openRegularFile(path); } catch { throw new Error(`executor output ${relativePath} is not a bounded regular file`); }
  const { handle, size } = opened;
  try {
    if (size > maxFileBytes) throw new Error(`executor output ${relativePath} is not a bounded regular file`);
    budget.total += size;
    if (budget.total > maxTotalBytes) throw new Error("executor output exceeds the host's total read bound");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== size) throw new Error(`executor output ${relativePath} changed while being read`);
    return Uint8Array.from(bytes);
  } finally { await handle.close(); }
}

const MAX_BINDING_FILES = 64;
const MAX_ASSET_FILES = 128;
const actionWindowSchema = z.object({ schemaVersion: z.literal("e2e-executor-action-window/v1"), state: z.enum(["open", "finished"]), actionId: z.string().max(200),
  caseId: z.string().min(1).max(160), actionIndex: z.number().int().min(0).max(99), actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  beganAt: z.string().datetime(), finishedAt: z.string().datetime().optional() }).strict();
const MAX_WINDOW_FILES = 2_048;
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

const EXECUTOR_LOG_HEAD_BYTES = 64 * 1024;
const MAX_ARTIFACTS_FILE_BYTES = 256 * 1024;
const MAX_CAPTURE_ENTRIES = 256;
/** A little more than the executor's own budget, so a listing the executor kept within 6 MiB is read whole. */
const MAX_CAPTURE_READ_BYTES = 7 * 1024 * 1024;
const captureEntrySchema = z.object({ caseId: z.string().min(1).max(160), kind: z.literal("screenshot"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(), omitted: z.enum(["budget", "credential-match"]).optional() }).strict();
const artifactsFileSchema = z.object({ schemaVersion: z.literal("e2e-executor-artifacts/v1"), artifacts: z.array(captureEntrySchema).max(MAX_CAPTURE_ENTRIES) }).strict();
const CAPTURE_FILE = /^case-\d{1,4}-screenshot\.jpg$/;

/**
 * The executor's log head and its captures, read best effort from its out directory. A capture file that carries a credential (by the host's own predicate, which also
 * opens archives) is not handed on and its listing says so; a file the listing names but the directory does not hold is listed as dropped. Anything unreadable leaves
 * the part it belongs to absent and never fails the snapshot: none of it is a verdict input.
 */
async function readExecutorEvidence(outDir: string, containsCredential: (bytes: Uint8Array) => boolean): Promise<ExecutorOutputEvidence> {
  let executorLogHead: Uint8Array = new Uint8Array();
  try {
    const head = await readRegularFileHead(join(outDir, "executor.log"), EXECUTOR_LOG_HEAD_BYTES);
    if (!containsCredential(head)) executorLogHead = Uint8Array.from(head);
  } catch { /* a run without a log has no head */ }
  try {
    const listing = artifactsFileSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRegular(outDir, CAPTURE_ARTIFACTS_FILE, { total: 0 }, MAX_ARTIFACTS_FILE_BYTES))));
    // Every capture file the directory holds, read once within a bound; a listing is matched to a file by kind and digest, not by trusting a name.
    const budget = { total: 0 };
    const loaded: Array<{ name: string; kind: "screenshot"; sha256: string; bytes: Uint8Array }> = [];
    for (const name of (await readdir(join(outDir, CAPTURE_DIR))).sort()) {
      const match = CAPTURE_FILE.exec(name);
      if (!match) continue;
      const kind = "screenshot" as const;
      try {
        const bytes = await readRegular(outDir, `${CAPTURE_DIR}/${name}`, budget, CAPTURE_SCREENSHOT_MAX_BYTES, MAX_CAPTURE_READ_BYTES);
        loaded.push({ name, kind, sha256: sha(bytes), bytes });
      } catch { /* a file past the bound, or not a plain regular file, is not handed on */ }
    }
    const files: ExecutorCaptureFile[] = [];
    const artifacts: CaptureEntry[] = [];
    for (const parsed of listing.artifacts) {
      const entry: CaptureEntry = { caseId: parsed.caseId, kind: parsed.kind, sha256: parsed.sha256, bytes: parsed.bytes, ...(parsed.omitted === undefined ? {} : { omitted: parsed.omitted }) };
      if (entry.omitted !== undefined) { artifacts.push(entry); continue; }
      const found = loaded.find((file) => file.kind === entry.kind && file.sha256 === entry.sha256 && file.bytes.byteLength === entry.bytes
        && !files.some((kept) => kept.name === file.name));
      if (!found) artifacts.push({ ...entry, omitted: "budget" });
      else if (containsCredential(found.bytes)) artifacts.push({ ...entry, omitted: "credential-match" });
      else { files.push({ name: found.name, sha256: found.sha256, bytes: found.bytes }); artifacts.push(entry); }
    }
    return Object.freeze({ executorLogHead, captures: Object.freeze({ artifacts: Object.freeze(artifacts), files: Object.freeze(files) }) });
  } catch { return Object.freeze({ executorLogHead, captures: null }); }
}

const MAX_AGENT_LEDGER_BYTES = 256 * 1024;
const MAX_AGENT_TRACE_BYTES = E2E_AGENT_TRACE_FILE_MAX_BYTES;
const MAX_AGENT_TRACES = E2E_AGENT_TRACES_PER_GROUP_MAX;
const MAX_AGENT_LEDGERS = 64;
const AGENT_TRACE_FILE = /^trace-[a-f0-9]{16}\.json$/;

/** The agent step's files under `agent/`, read once, best effort and bounded. Null when the run left none; anything unreadable is dropped and counted. */
async function readAgentEvidence(outDir: string, containsCredential: (bytes: Uint8Array) => boolean): Promise<ExecutorAgentEvidence | null> {
  const root = join(outDir, E2E_AGENT_EVIDENCE_DIR);
  let entries: string[];
  try { await requireRealDirectory(root, E2E_AGENT_EVIDENCE_DIR); entries = (await readdir(root)).sort(); } catch { return null; }
  const budget = { total: 0 };
  const total = 8 * 1024 * 1024;
  let dropped = 0;
  const ledgers: Array<{ caseDirectory: string; bytes: Uint8Array }> = [];
  const traces: Array<{ name: string; bytes: Uint8Array }> = [];
  const take = async (relative: string, max: number): Promise<Uint8Array | null> => {
    try {
      const bytes = await readRegular(outDir, relative, budget, max, total);
      if (containsCredential(bytes)) { dropped += 1; return null; }
      return bytes;
    } catch { dropped += 1; return null; }
  };
  for (const name of entries) {
    if (SAFE_DIR.test(name)) {
      if (ledgers.length >= MAX_AGENT_LEDGERS) { dropped += 1; continue; }
      const bytes = await take(`${E2E_AGENT_EVIDENCE_DIR}/${name}/${E2E_AGENT_LEDGER_FILE}`, MAX_AGENT_LEDGER_BYTES);
      if (bytes !== null) ledgers.push({ caseDirectory: name, bytes });
    } else if (name === "traces") {
      let files: string[];
      try { await requireRealDirectory(join(root, "traces"), `${E2E_AGENT_EVIDENCE_DIR}/traces`); files = (await readdir(join(root, "traces"))).filter((file) => AGENT_TRACE_FILE.test(file)).sort(); } catch { dropped += 1; continue; }
      for (const file of files) {
        if (traces.length >= MAX_AGENT_TRACES) { dropped += 1; continue; }
        const bytes = await take(`${E2E_AGENT_EVIDENCE_DIR}/traces/${file}`, MAX_AGENT_TRACE_BYTES);
        if (bytes !== null) traces.push({ name: file, bytes });
      }
    }
  }
  return Object.freeze({ ledgers: Object.freeze(ledgers), traces: Object.freeze(traces), dropped });
}

/** Reads the out directory of a finished executor run: its result file, every shard's CLI files and every evidence item. */
/**
 * `containsCredential` is the host's own predicate for the run's account credentials (also over archives); a capture or log head it flags is held back from the
 * operator's evidence. It is never consulted for the verdict inputs, which the collector validates itself.
 */
export async function snapshotExecutorOutput(outDir: string, result: ExecutorResultFile, options: { containsCredential?: (bytes: Uint8Array) => boolean } = {}): Promise<ExecutorOutputSnapshot> {
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
    assertionAssets: Object.freeze(assertionAssets), reportBytes, executorEvidence: await withAgentEvidence(outDir, options.containsCredential ?? (() => false)) });
}

/** The log head and captures, plus the agent step's files when the run left any (the field is absent otherwise, so a run without an agent step reads back exactly as before). */
async function withAgentEvidence(outDir: string, containsCredential: (bytes: Uint8Array) => boolean): Promise<ExecutorOutputEvidence> {
  const base = await readExecutorEvidence(outDir, containsCredential);
  const agent = await readAgentEvidence(outDir, containsCredential);
  return agent === null ? base : Object.freeze({ ...base, agent });
}

/** The executor's action windows, read once the executor is done: they bind a mock ledger line to the case that was running when it was recorded. */
export async function readExecutorActionWindows(outDir: string): Promise<readonly ExecutorActionWindow[]> {
  const budget = { total: 0 };
  await requireRealDirectory(join(outDir, "observations"), "observations");
  const windowNames = (await readdir(join(outDir, "observations"))).filter((name) => /^action-[A-Za-z0-9._-]+-\d{1,2}\.json$/.test(name)).sort();
  if (windowNames.length > MAX_WINDOW_FILES) throw new Error("executor output holds more action windows than the host reads");
  const actionWindows: ExecutorActionWindow[] = [];
  for (const name of windowNames) {
    const row = actionWindowSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRegular(outDir, `observations/${name}`, budget))));
    actionWindows.push(Object.freeze({ caseId: row.caseId, actionIndex: row.actionIndex, beganAt: row.beganAt, finishedAt: row.state === "finished" ? row.finishedAt ?? null : null }));
  }
  return Object.freeze(actionWindows);
}

/**
 * The identity of what the host owns for one run, so a collector can recompute it without asking the host: the app, the executor, the sinkhole (always) and one mock container
 * for every origin the plan's approved mocks serve (`mockOrigins`, which the collector derives from the admitted plan, never from the worker).
 */
export function dockerOwnedResourceInventory(runId: string, mockOrigins: readonly string[]): { schemaVersion: "rovara-docker-owned-inventory/v1"; runId: string; label: string; network: string; containers: string[] } {
  const origins = [...new Set([...mockOrigins, SINKHOLE_ORIGIN_REF])].sort(compare);
  return { schemaVersion: "rovara-docker-owned-inventory/v1", runId, label: `rovara.run=${runId}`, network: `rovara-e2e-${runId}`,
    containers: [`rovara-app-${runId}`, `rovara-executor-${runId}`, ...origins.map((origin) => `rovara-mock-${runId}-${origin}`)] };
}
export const dockerOwnedResourceInventoryDigest = (runId: string, mockOrigins: readonly string[]): string => sha(canonicalJson(dockerOwnedResourceInventory(runId, mockOrigins)));

const compare = (a: string, b: string) => a.localeCompare(b);
function proof(value: unknown, mediaType: string, artifactId: string): { ref: E2EApplicationEvidenceRef; bytes: Uint8Array } {
  const bytes = Uint8Array.from(Buffer.from(typeof value === "string" ? value : canonicalJson(value), "utf8"));
  return { ref: E2EApplicationEvidenceRefSchema.parse({ artifactId, sha256: sha(bytes), byteLength: bytes.byteLength, mediaType }), bytes };
}
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

type OwnedCleanup = { removedAt: string; containers: readonly string[]; network: string; mockOrigins: readonly string[] };
const ownedCleanupReceipt = (binding: Pick<E2ERunBinding, "runId">, cleanup: OwnedCleanup) => proof({ schemaVersion: "rovara-docker-owned-cleanup/v1",
  runId: binding.runId, removedAt: cleanup.removedAt, network: cleanup.network, containers: [...cleanup.containers].sort(compare),
  inventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId, cleanup.mockOrigins) }, "application/json", `rovara-owned-cleanup-${binding.runId}`);

/**
 * The owned-cleanup receipt the host attests once a run's resources are gone, recomputed from nothing but the run id and the close time: the inventory is a pure
 * function of the run id, so a broker can derive the receipt (and its reference) it expects without taking it from the worker.
 */
export function dockerOwnedCleanupReceipt(runId: string, removedAt: string, mockOrigins: readonly string[]): { ref: E2EApplicationEvidenceRef; bytes: Uint8Array } {
  const inventory = dockerOwnedResourceInventory(runId, mockOrigins);
  return ownedCleanupReceipt({ runId }, { removedAt, containers: inventory.containers, network: inventory.network, mockOrigins });
}

/** What `collectE2EApplicationRun` takes besides the actual run, the compiled suite, the binding and the round. */
export type DockerCollectionInputs = Readonly<{ environment: { ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string };
  usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>;
  expectedSupervisorReceiptRefs: readonly E2EApplicationEvidenceRef[]; ownedResourceInventoryDigest: string;
  observationBindings: readonly E2EApplicationObservationBinding[]; assertionAssets: readonly E2EApplicationAssertionAssetBinding[];
  governedModelReceipts: readonly never[]; ownedClosedAt: string;
  /**
   * The worker's receipts, the executor's action ledgers and the run's value key, for a group that has an agent step (Task 4.4a), added by the host from its closed model channel; absent
   * for any other group, so its evidence is what it was before. `governedModelReceipts` stays empty: the M1-era projection rows are not how an agent step is read.
   */
  agentModel?: E2EAgentModelEvidence }>;

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
  // A mixed group can put a deterministic 64k report before an AI 32k report.
  // Its shared ceiling is the strictest shard ceiling, independent of ordering;
  // the broker and collector still validate every configured and reported limit.
  const limits = { ...first.limits, maxModelTokensPerCall: Math.min(...reports.map(run => run.limits.maxModelTokensPerCall!)) };
  return Object.freeze({ environment: first.environment, usage, limits,
    expectedSupervisorReceiptRefs: Object.freeze([ownedCleanupReceipt(input.binding, input.cleanup).ref]),
    ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(input.binding.runId, input.cleanup.mockOrigins),
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
  const originalCaptures = snapshot.evidence.filter((item) => item.kind === "case-capture").map((item) => ({ item, original: E2EApplicationCaseCaptureSchema.parse(JSON.parse(decode(item.bytes))) }));
  const launches = result.shards.map((row) => ({ shardId: row.shardId, launchId: row.launchId, upstreamRunId: row.upstreamRunId ?? "" }))
    .sort((a, b) => compare(a.shardId, b.shardId));
  // What the mocks recorded belongs to the case that was running at the time: the span from the case's first action to its end (its terminal moment, since a call an action started
  // can land after the action itself returned). A call that fits no case is never ignored (see `bindMockLedgers`).
  const caseWindows: CaseWindow[] = originalCaptures.flatMap(({ original }) => {
    const own = (snapshot.actionWindows ?? []).filter((window) => window.caseId === original.caseId);
    if (own.length === 0) return [];
    const ends = [...own.map((window) => Date.parse(window.finishedAt ?? result.finishedAt)), Date.parse(original.terminal.at)];
    return [{ caseId: original.caseId, startMs: Math.min(...own.map((window) => Date.parse(window.beganAt))), endMs: Math.max(...ends) }];
  });
  const mockProofs = buildMockProofs({ runId: binding.runId, mockManifestDigest: binding.mockManifestDigest, lifecycleId, context, producer, proof,
    cases: originalCaptures.map(({ original }) => ({ caseId: original.caseId, shardId: original.shardId, upstreamRunId: launches.find((launch) => launch.shardId === original.shardId)?.upstreamRunId ?? "" })),
    bound: bindMockLedgers({ ledgers: snapshot.mockLedgers ?? [], windows: caseWindows, caseIds: originalCaptures.map(({ original }) => original.caseId), fallbackAt: observedAt }) });
  const declaredMocksOf = (caseId: string) => {
    const targetId = compiled.expectedCases.find((expected) => expected.caseId === caseId)?.targetId;
    return [...new Set(compiled.group.mocks.filter((mock) => mock.requestedTargetId === targetId && mock.effectiveTargetId === targetId && mock.kind === "api" && mock.apiFixture !== undefined)
      .map((mock) => mock.componentId))].sort();
  };
  const captures = originalCaptures.map(({ item, original }) => {
    // The in-run frame names the compiled test and the scenario's component list as coverage; the collector derives coverage from the
    // observations themselves and rejects anything else, so the sealed frame states it that way: the application ran, and the
    // behaviors not exercised are the assertions that did not pass. The mocks the case declared are the approved mocks of its target, and the ones it
    // observed are those its application really called, from the ledgers of the mocks themselves.
    const coverage = { ...original.coverage, executedCandidateParts: original.coverage.observedScope === "source" ? [] : [original.applicationId],
      unexercisedBehaviors: original.assertions.filter((assertion) => assertion.outcome !== "passed").map((assertion) => assertion.digest),
      mockedComponentIds: declaredMocksOf(original.caseId), observedMockedComponentIds: [...(mockProofs.observedComponentsByCase.get(original.caseId) ?? [])] };
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
    serverListening: false, ownedResourceInventoryDigest: dockerOwnedResourceInventoryDigest(binding.runId, input.cleanup.mockOrigins), ownedCleanupReceiptRefs: [cleanupReceipt.ref] },
  "application/json", `rovara-cleanup-frame-${binding.runId}`);
  const receiptFrame = proof({ schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
    caseCaptures: captures.map(({ capture, item }) => ({ caseId: capture.caseId, shardId: capture.shardId, ref: item.ref })).sort((a, b) => compare(a.caseId, b.caseId)),
    mockConsumptions: mockProofs.consumptionEntries, ...(mockProofs.unmockedEntries.length > 0 ? { unmockedCalls: mockProofs.unmockedEntries } : {}),
    cleanupRef: cleanupFrame.ref, additionalSupervisorReceiptRefs: [cleanupReceipt.ref] },
  "application/json", `rovara-supervisor-receipt-${binding.runId}`);

  const evidence: E2EApplicationProofBytes[] = [...snapshot.evidence.map(({ ref, bytes }) => ({ ref, bytes })), ...[...sealedCaptures.values()].map(({ ref, bytes }) => ({ ref, bytes })), ...mockProofs.frames, cleanupReceipt, cleanupFrame]
    .sort((a, b) => compare(a.ref.artifactId, b.ref.artifactId));
  const supervisorReceiptRefs = [receiptFrame.ref, cleanupReceipt.ref].sort((a, b) => compare(a.artifactId, b.artifactId));
  return Object.freeze({ protocol: "e2e-actual-application-run/v1" as const, runnerToolchain: toolchain, shards: Object.freeze(shards),
    applicationCaptures: Object.freeze(captures.map(({ capture }) => capture)), supervisorReceiptRefs: Object.freeze(supervisorReceiptRefs),
    declaredMockComponentIds: Object.freeze([...new Set(compiled.group.mocks.map((mock) => mock.componentId))].sort()),
    selected, filtered, supervisorReadback: Object.freeze({ schemaVersion: "e2e-application-supervisor-readback/v1" as const,
      receipt: receiptFrame, evidence: Object.freeze(evidence) }),
    cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: input.evidenceDirectory, executorEvidence: snapshot.executorEvidence });
}
