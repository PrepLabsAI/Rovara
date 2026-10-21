import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRedactor } from "./redact.js";

/**
 * Screenshots and traces of failed cases (owner decision D3), kept inside a fixed budget. The executor passes the capture policy the admission approved and
 * nothing else decides what is captured: with a kind off, no file of it is written. A dropped capture is a recorded drop and never changes a verdict.
 */
export const CAPTURE_DIR = "captures";
export const CAPTURE_ARTIFACTS_FILE = "artifacts.json";
/** The recorder's own working listing, one file per capture (or dropped capture); removed when the group's captures are finalized. */
const ENTRIES_DIR = "entries";
export const CAPTURE_SCREENSHOT_MAX_BYTES = 524_288;
export const CAPTURE_TRACE_MAX_BYTES = 4_194_304;
/** What a group's captures may total, inside the 8 MiB group evidence cap (Ruling BV). */
export const CAPTURE_GROUP_BUDGET_BYTES = 6 * 1024 * 1024;
export const CAPTURE_MAX_TRACES_PER_GROUP = 1;

export type CaptureKind = "screenshot" | "trace";
export type CapturePolicy = Readonly<{ screenshots: boolean; traces: boolean }>;
export type CaptureOmitted = "budget" | "credential-match";
/** One line of `artifacts.json`. `omitted` says why a capture that was taken is not kept; no file exists for it then. */
export type CaptureEntry = Readonly<{ caseId: string; kind: CaptureKind; sha256: string; bytes: number; omitted?: CaptureOmitted }>;

const extensionOf: Readonly<Record<CaptureKind, string>> = { screenshot: "jpg", trace: "zip" };
const maxBytesOf: Readonly<Record<CaptureKind, number>> = { screenshot: CAPTURE_SCREENSHOT_MAX_BYTES, trace: CAPTURE_TRACE_MAX_BYTES };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isKind = (value: unknown): value is CaptureKind => value === "screenshot" || value === "trace";
const policyAllows = (policy: CapturePolicy, kind: CaptureKind) => (kind === "screenshot" ? policy.screenshots : policy.traces);

/** The names a capture is stored under: the case's index in the compiled suite, never scenario text, a case id or an account name. */
export const captureFileName = (caseIndex: number, kind: CaptureKind) => `case-${caseIndex}-${kind}.${extensionOf[kind]}`;
const FILE_NAME = /^case-(\d{1,4})-(screenshot|trace)\.(?:jpg|zip)$/;

export type CaptureRecorder = Readonly<{
  /** Whether this kind is admitted. When it is not, `record` writes nothing. */
  enabled(kind: CaptureKind): boolean;
  /**
   * Stores one capture of one case. Resolves to its `artifacts.json` entry (with `omitted` when it was dropped and no file kept) or to null when the kind is not admitted.
   * A trace has its session secrets scrubbed first; a capture that carries an account credential, or an archive that cannot be opened to show it does not, is dropped.
   */
  record(input: { caseId: string; kind: CaptureKind; bytes: Uint8Array }): Promise<CaptureEntry | null>;
}>;

async function writeExclusive(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export function createCaptureRecorder(input: { root: string; policy: CapturePolicy; caseIds: readonly string[]; redactor: CredentialRedactor }): CaptureRecorder {
  const { root, policy, redactor } = input;
  const caseIndex = new Map(input.caseIds.map((caseId, index) => [caseId, index] as const));
  return Object.freeze({
    enabled: (kind: CaptureKind) => policyAllows(policy, kind),
    async record({ caseId, kind, bytes }: { caseId: string; kind: CaptureKind; bytes: Uint8Array }): Promise<CaptureEntry | null> {
      if (!policyAllows(policy, kind)) return null;
      const index = caseIndex.get(caseId);
      if (index === undefined) throw new Error("unknown case: it is not in the compiled plan");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
      // A trace carries the run's network traffic, so its session secrets are replaced before anything else is decided; an account credential is never replaced, it drops the trace.
      let kept: Uint8Array = bytes;
      let omitted: CaptureOmitted | undefined;
      if (kind === "trace" && redactor.containsDeep(bytes, "accounts")) omitted = "credential-match";
      else {
        kept = kind === "trace" ? redactor.scrubSession(bytes) : bytes;
        if (redactor.containsDeep(kept)) omitted = "credential-match";
        else if (kept.byteLength > maxBytesOf[kind]) omitted = "budget";
      }
      const entry: CaptureEntry = Object.freeze({ caseId, kind, sha256: sha(kept), bytes: kept.byteLength, ...(omitted === undefined ? {} : { omitted }) });
      const name = captureFileName(index, kind);
      await mkdir(join(root, CAPTURE_DIR, ENTRIES_DIR), { recursive: true, mode: 0o755 });
      if (omitted === undefined) await writeExclusive(join(root, CAPTURE_DIR, name), kept);
      await writeExclusive(join(root, CAPTURE_DIR, ENTRIES_DIR, `${name}.json`), `${JSON.stringify({ schemaVersion: "e2e-executor-capture-entry/v1", ...entry })}\n`);
      return entry;
    },
  });
}

const entryOrder = (caseIds: readonly string[]) => (a: CaptureEntry, b: CaptureEntry) =>
  (caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId)) || (a.kind === b.kind ? 0 : a.kind === "screenshot" ? -1 : 1);

/**
 * Settles a group's captures after every shard has run: reads what the recorders listed, drops a capture that now carries an account credential, keeps at most one
 * trace, fits the rest in the budget (traces first, then screenshots from the last case back), writes `artifacts.json` and removes the recorders' working files.
 * It never throws for a capture and never touches a result file: a drop here is recorded, not a verdict. With no kind admitted it writes nothing at all.
 */
export async function finalizeCaptureArtifacts(input: { outDir: string; policy: CapturePolicy; caseIds: readonly string[]; redactor: CredentialRedactor;
  budgetBytes?: number }): Promise<CaptureEntry[]> {
  const { outDir, policy, caseIds, redactor } = input;
  const budget = input.budgetBytes ?? CAPTURE_GROUP_BUDGET_BYTES;
  const dir = join(outDir, CAPTURE_DIR);
  const anyAdmitted = policy.screenshots || policy.traces;
  let names: string[] = [];
  try { names = await readdir(dir); } catch { /* nothing was captured */ }
  const listed: Array<{ entry: CaptureEntry; name: string; kept: boolean }> = [];
  for (const name of names.filter((item) => item !== ENTRIES_DIR).sort()) {
    const match = FILE_NAME.exec(name);
    const kind = match?.[2];
    // A file of a kind that was not admitted (or that is not one of ours) is not kept, whoever put it there.
    if (!match || !isKind(kind) || !policyAllows(policy, kind) || caseIds[Number(match[1])] === undefined) { await rm(join(dir, name), { force: true }); continue; }
    const bytes = await readFile(join(dir, name));
    listed.push({ name, kept: true, entry: { caseId: caseIds[Number(match[1])]!, kind, sha256: sha(bytes), bytes: bytes.byteLength } });
  }
  const drop = async (item: { entry: CaptureEntry; name: string; kept: boolean }, omitted: CaptureOmitted) => {
    await rm(join(dir, item.name), { force: true });
    item.kept = false; item.entry = { ...item.entry, omitted };
  };
  for (const item of listed) {
    if (redactor.containsDeep(await readFile(join(dir, item.name)))) await drop(item, "credential-match");
    else if (item.entry.bytes > maxBytesOf[item.entry.kind]) await drop(item, "budget");
  }
  // What the recorders dropped already has no file; it is listed from their working files.
  const dropped: CaptureEntry[] = [];
  let entryNames: string[] = [];
  try { entryNames = (await readdir(join(dir, ENTRIES_DIR))).sort(); } catch { /* none */ }
  for (const name of entryNames) {
    try {
      const row = JSON.parse(await readFile(join(dir, ENTRIES_DIR, name), "utf8")) as Partial<CaptureEntry> & { schemaVersion?: string };
      if (row.omitted !== undefined && isKind(row.kind) && policyAllows(policy, row.kind) && typeof row.caseId === "string" && caseIds.includes(row.caseId)
        && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes) && (row.omitted === "budget" || row.omitted === "credential-match")) {
        dropped.push({ caseId: row.caseId, kind: row.kind, sha256: row.sha256, bytes: row.bytes!, omitted: row.omitted });
      }
    } catch { /* an unreadable working file lists nothing */ }
  }
  const order = entryOrder(caseIds);
  const live = () => listed.filter((item) => item.kept);
  const traces = live().filter((item) => item.entry.kind === "trace").sort((a, b) => order(a.entry, b.entry));
  for (const extra of traces.slice(CAPTURE_MAX_TRACES_PER_GROUP)) await drop(extra, "budget");
  const total = () => live().reduce((sum, item) => sum + item.entry.bytes, 0);
  while (total() > budget) {
    const victim = live().filter((item) => item.entry.kind === "trace").sort((a, b) => order(b.entry, a.entry))[0]
      ?? live().sort((a, b) => order(b.entry, a.entry))[0];
    if (!victim) break;
    await drop(victim, "budget");
  }
  await rm(join(dir, ENTRIES_DIR), { recursive: true, force: true });
  if (!anyAdmitted) { await rm(dir, { recursive: true, force: true }); return []; }
  const entries = [...listed.map((item) => item.entry), ...dropped].sort(order);
  await writeFile(join(outDir, CAPTURE_ARTIFACTS_FILE), `${JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: entries }, null, 2)}\n`);
  return entries;
}
