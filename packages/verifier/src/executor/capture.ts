import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRedactor } from "./redact.js";

/**
 * Screenshots of failed cases (owner decision D3), kept inside a fixed budget. Traces are deferred past M1.3 (Ruling CJ): a Playwright trace keeps rotated `Set-Cookie`
 * values, bearer and query tokens and the page's own text, none of which can be scrubbed reliably, so there is no trace capture here to enable, and a policy that asks
 * for one is refused. The executor passes the capture policy the admission approved and nothing else decides what is captured: with it off, no file is written. A dropped
 * capture is a recorded drop and never changes a verdict.
 */
export const CAPTURE_DIR = "captures";
export const CAPTURE_ARTIFACTS_FILE = "artifacts.json";
/** The recorder's own working listing, one file per capture (or dropped capture); removed when the group's captures are finalized. */
const ENTRIES_DIR = "entries";
export const CAPTURE_SCREENSHOT_MAX_BYTES = 524_288;
/** Proof and evidence B1: a passing case's strip is at most this many step-end screenshots (the evidence pack's own strip bound). */
export const CAPTURE_STRIP_MAX_FRAMES = 6;
/** What a group's captures may total, counted as the base64 text that is stored in the group evidence (inside its 8 MiB cap, Ruling BV). */
export const CAPTURE_GROUP_BUDGET_BYTES = 6 * 1024 * 1024;

export type CaptureKind = "screenshot" | "api-sample";
/** Proof and evidence B2: an API sample is one redacted request/response record (JSON), at most this large, at most this many a case. */
export const CAPTURE_API_SAMPLE_MAX_BYTES = 16_384;
export const CAPTURE_API_SAMPLES_MAX = 5;
/**
 * `screenshots` is whether any screenshot is admitted. `mode` is what is taken: "failed" (the default, and the only thing there was before B1) is one screenshot of each FAILED or UNKNOWN case;
 * "all" adds a strip, one screenshot at the end of each of a case's steps (at most `CAPTURE_STRIP_MAX_FRAMES`, chosen by `stripStepIndexes`), whatever the case's outcome.
 */
export type CaptureMode = "failed" | "all";
export type CapturePolicy = Readonly<{ screenshots: boolean; mode?: CaptureMode; /** Whether API samples are admitted (B2). Independent of screenshots. */ apiSamples?: boolean }>;
export type CaptureOmitted = "budget" | "credential-match";
/**
 * One line of `artifacts.json`. `omitted` says why a capture that was taken is not kept; no file exists for it then. `step` is set on a strip frame (the index of the declared step it was
 * taken after) and absent on the screenshot of a failed case.
 */
export type CaptureEntry = Readonly<{ caseId: string; kind: CaptureKind; sha256: string; bytes: number; omitted?: CaptureOmitted; step?: number }>;
/** Whether the policy admits this kind at all. */
const admits = (policy: CapturePolicy, kind: CaptureKind) => (kind === "screenshot" ? policy.screenshots : policy.apiSamples === true);

/**
 * The steps of a case that get a strip frame: all of them up to the bound, otherwise evenly spread with the first and the last always kept. It depends on the step count alone, so the same scenario on the
 * unchanged code and on the candidate takes frames at the same steps and the two strips pair up.
 */
export function stripStepIndexes(stepCount: number, max: number = CAPTURE_STRIP_MAX_FRAMES): number[] {
  if (!Number.isInteger(stepCount) || stepCount <= 0 || !Number.isInteger(max) || max <= 0) return [];
  if (stepCount <= max) return Array.from({ length: stepCount }, (_, index) => index);
  if (max === 1) return [stepCount - 1];
  const picked = new Set<number>();
  for (let slot = 0; slot < max; slot += 1) picked.add(Math.round((slot * (stepCount - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b);
}

/** The size of `bytes` bytes once base64 encoded, which is what they cost in the group evidence. */
export const encodedBytes = (bytes: number) => 4 * Math.ceil(bytes / 3);

/** The capture an admitted policy approves. A policy that asks for traces is refused: there is nothing that could honour it safely. */
export function admittedCapturePolicy(capture: Readonly<{ screenshots: boolean; traces: boolean; screenshotMode?: CaptureMode | undefined; apiSamples?: boolean | undefined }>): CapturePolicy {
  if (capture.traces) throw new Error("trace capture is not supported: a trace keeps session tokens that cannot be scrubbed (deferred past M1.3)");
  const apiSamples = capture.apiSamples === true ? { apiSamples: true as const } : {};
  // A strip is a kind of screenshot: asking for one with screenshots off is a contradiction, and nothing is taken.
  if (capture.screenshotMode === "all" && capture.screenshots) return Object.freeze({ screenshots: true, mode: "all" as const, ...apiSamples });
  return Object.freeze({ screenshots: capture.screenshots, ...apiSamples });
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The names a capture is stored under: the case's index in the compiled suite, never scenario text, a case id or an account name. */
export const captureFileName = (caseIndex: number) => `case-${caseIndex}-screenshot.jpg`;
/** A strip frame's name: the case's index and the step's index. */
export const captureStripFileName = (caseIndex: number, step: number) => `case-${caseIndex}-step-${step}-screenshot.jpg`;
/** An API sample's name: the case's index and the request step's index. */
export const captureApiSampleFileName = (caseIndex: number, step: number) => `case-${caseIndex}-api-${step}.json`;
const FILE_NAME = /^case-(\d{1,4})(?:-step-(\d{1,4}))?-screenshot\.jpg$/;
const API_FILE_NAME = /^case-(\d{1,4})-api-(\d{1,4})\.json$/;
const MAX_STEP = 9_999;

export type CaptureRecorder = Readonly<{
  /** Whether this kind is admitted. When it is not, `record` writes nothing. */
  enabled(kind: CaptureKind): boolean;
  /** Whether the strip of a passing case is admitted too (mode "all"). */
  stripEnabled(): boolean;
  /**
   * Stores one capture of one case. Resolves to its `artifacts.json` entry (with `omitted` when it was dropped and no file kept) or to null when the kind is not admitted.
   * A capture that carries an account credential (or the run's session secret) in any spelling is dropped. Any kind but a screenshot is refused.
   * With `step`, the capture is a strip frame (the end of that declared step): it is taken only in mode "all", at most `CAPTURE_STRIP_MAX_FRAMES` a case (the rest are recorded as dropped for budget).
   */
  record(input: { caseId: string; kind: CaptureKind; bytes: Uint8Array; step?: number }): Promise<CaptureEntry | null>;
}>;

async function writeExclusive(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export function createCaptureRecorder(input: { root: string; policy: CapturePolicy; caseIds: readonly string[]; redactor: CredentialRedactor }): CaptureRecorder {
  const { root, policy, redactor } = input;
  const strip = policy.screenshots && policy.mode === "all";
  const caseIndex = new Map(input.caseIds.map((caseId, index) => [caseId, index] as const));
  const takenOf = new Map<string, number>();
  return Object.freeze({
    enabled: (kind: CaptureKind) => (kind === "screenshot" || kind === "api-sample") && admits(policy, kind),
    stripEnabled: () => strip,
    async record({ caseId, kind, bytes, step }: { caseId: string; kind: CaptureKind; bytes: Uint8Array; step?: number }): Promise<CaptureEntry | null> {
      if (kind !== "screenshot" && kind !== "api-sample") throw new Error("trace capture is not supported");
      if (!admits(policy, kind)) return null;
      if (kind === "api-sample" && step === undefined) throw new Error("an API sample names the request step it records");
      if (step !== undefined) {
        if (kind === "screenshot" && !strip) return null;
        if (!Number.isInteger(step) || step < 0 || step > MAX_STEP) throw new Error("a capture names a declared step");
      }
      const index = caseIndex.get(caseId);
      if (index === undefined) throw new Error("unknown case: it is not in the compiled plan");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
      let overCap = false;
      if (step !== undefined) {
        const key = `${kind}:${caseId}`;
        const taken = takenOf.get(key) ?? 0;
        takenOf.set(key, taken + 1);
        overCap = taken >= (kind === "api-sample" ? CAPTURE_API_SAMPLES_MAX : CAPTURE_STRIP_MAX_FRAMES);
      }
      const maxBytes = kind === "api-sample" ? CAPTURE_API_SAMPLE_MAX_BYTES : CAPTURE_SCREENSHOT_MAX_BYTES;
      const omitted: CaptureOmitted | undefined = redactor.contains(bytes) ? "credential-match" : bytes.byteLength > maxBytes || overCap ? "budget" : undefined;
      const entry: CaptureEntry = Object.freeze({ caseId, kind, sha256: sha(bytes), bytes: bytes.byteLength, ...(step === undefined ? {} : { step }), ...(omitted === undefined ? {} : { omitted }) });
      const name = kind === "api-sample" ? captureApiSampleFileName(index, step!) : step === undefined ? captureFileName(index) : captureStripFileName(index, step);
      await mkdir(join(root, CAPTURE_DIR, ENTRIES_DIR), { recursive: true, mode: 0o755 });
      if (omitted === undefined) await writeExclusive(join(root, CAPTURE_DIR, name), bytes);
      await writeExclusive(join(root, CAPTURE_DIR, ENTRIES_DIR, `${name}.json`), `${JSON.stringify({ schemaVersion: "e2e-executor-capture-entry/v1", ...entry })}\n`);
      return entry;
    },
  });
}

/**
 * Settles a group's captures after every shard has run: reads what the recorders listed, drops a capture that now carries a credential, fits the rest in the budget
 * (counted as base64; one file at a time, strip frames before the screenshots of failed cases, then the largest first, the later case first among equals), writes `artifacts.json` and removes the recorders' working files.
 * It never throws for a capture and never touches a result file: a drop here is recorded, not a verdict. With screenshots not admitted it writes nothing at all.
 */
export async function finalizeCaptureArtifacts(input: { outDir: string; policy: CapturePolicy; caseIds: readonly string[]; redactor: CredentialRedactor;
  budgetBytes?: number }): Promise<CaptureEntry[]> {
  const { outDir, policy, caseIds, redactor } = input;
  const budget = input.budgetBytes ?? CAPTURE_GROUP_BUDGET_BYTES;
  const dir = join(outDir, CAPTURE_DIR);
  let names: string[] = [];
  try { names = await readdir(dir); } catch { /* nothing was captured */ }
  const listed: Array<{ entry: CaptureEntry; name: string; index: number; kept: boolean }> = [];
  const keptOf = new Map<string, number>();
  for (const name of names.filter((item) => item !== ENTRIES_DIR).sort()) {
    const shot = FILE_NAME.exec(name);
    const api = shot ? null : API_FILE_NAME.exec(name);
    const match = shot ?? api;
    const kind: CaptureKind = api ? "api-sample" : "screenshot";
    const index = match ? Number(match[1]) : -1;
    const step = api ? Number(api[2]) : shot?.[2] === undefined ? undefined : Number(shot[2]);
    // A file that is not a capture of an admitted kind for a case of the plan (a trace, say) is not kept, whoever put it there. A strip frame is kept only when the strip is admitted.
    if (!match || !admits(policy, kind) || caseIds[index] === undefined || (step !== undefined && (step > MAX_STEP || (kind === "screenshot" && policy.mode !== "all")))) { await rm(join(dir, name), { force: true }); continue; }
    const bytes = await readFile(join(dir, name));
    const entry: CaptureEntry = { caseId: caseIds[index], kind, sha256: sha(bytes), bytes: bytes.byteLength, ...(step === undefined ? {} : { step }) };
    const key = `${kind}:${index}`;
    const taken = step === undefined ? 0 : keptOf.get(key) ?? 0;
    if (step !== undefined) keptOf.set(key, taken + 1);
    // More than a case may hold (a recorder never writes them) are dropped, the later steps first.
    if (taken >= (kind === "api-sample" ? CAPTURE_API_SAMPLES_MAX : CAPTURE_STRIP_MAX_FRAMES)) { await rm(join(dir, name), { force: true }); listed.push({ name, index, kept: false, entry: { ...entry, omitted: "budget" } }); continue; }
    listed.push({ name, index, kept: true, entry });
  }
  const drop = async (item: { entry: CaptureEntry; name: string; kept: boolean }, omitted: CaptureOmitted) => {
    await rm(join(dir, item.name), { force: true });
    item.kept = false; item.entry = { ...item.entry, omitted };
  };
  for (const item of listed.filter((candidate) => candidate.kept)) {
    if (redactor.contains(await readFile(join(dir, item.name)))) await drop(item, "credential-match");
    else if (item.entry.bytes > (item.entry.kind === "api-sample" ? CAPTURE_API_SAMPLE_MAX_BYTES : CAPTURE_SCREENSHOT_MAX_BYTES)) await drop(item, "budget");
  }
  // What the recorders dropped already has no file; it is listed from their working files.
  const dropped: CaptureEntry[] = [];
  let entryNames: string[] = [];
  try { entryNames = (await readdir(join(dir, ENTRIES_DIR))).sort(); } catch { /* none */ }
  for (const name of entryNames) {
    try {
      const row = JSON.parse(await readFile(join(dir, ENTRIES_DIR, name), "utf8")) as Partial<CaptureEntry>;
      if (row.omitted !== undefined && (row.kind === "screenshot" || row.kind === "api-sample") && typeof row.caseId === "string" && caseIds.includes(row.caseId)
        && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes) && (row.omitted === "budget" || row.omitted === "credential-match")) {
        const step = Number.isInteger(row.step) && row.step! >= 0 && row.step! <= MAX_STEP ? row.step : undefined;
        dropped.push({ caseId: row.caseId, kind: row.kind, sha256: row.sha256, bytes: row.bytes!, omitted: row.omitted, ...(step === undefined ? {} : { step }) });
      }
    } catch { /* an unreadable working file lists nothing */ }
  }
  const live = () => listed.filter((item) => item.kept);
  const total = () => live().reduce((sum, item) => sum + encodedBytes(item.entry.bytes), 0);
  while (total() > budget) {
    // Shed API samples first (small, and the diff is in the pack), then strip frames, then the screenshot of a failed case, which a reader cannot do without.
    const rank = (item: { entry: CaptureEntry }) => (item.entry.kind === "api-sample" ? 0 : item.entry.step !== undefined ? 1 : 2);
    const victim = live().sort((a, b) => rank(a) - rank(b) || (b.entry.bytes - a.entry.bytes) || (b.index - a.index))[0];
    if (!victim) break;
    await drop(victim, "budget");
  }
  await rm(join(dir, ENTRIES_DIR), { recursive: true, force: true });
  if (!policy.screenshots && policy.apiSamples !== true) { await rm(dir, { recursive: true, force: true }); return []; }
  const entries = [...listed.map((item) => item.entry), ...dropped].sort((a, b) => caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId) || (a.kind === b.kind ? 0 : a.kind === "screenshot" ? -1 : 1) || (a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER));
  await writeFile(join(outDir, CAPTURE_ARTIFACTS_FILE), `${JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: entries }, null, 2)}\n`);
  return entries;
}
