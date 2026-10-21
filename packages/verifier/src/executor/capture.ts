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
/** What a group's captures may total, counted as the base64 text that is stored in the group evidence (inside its 8 MiB cap, Ruling BV). */
export const CAPTURE_GROUP_BUDGET_BYTES = 6 * 1024 * 1024;

export type CaptureKind = "screenshot";
export type CapturePolicy = Readonly<{ screenshots: boolean }>;
export type CaptureOmitted = "budget" | "credential-match";
/** One line of `artifacts.json`. `omitted` says why a capture that was taken is not kept; no file exists for it then. */
export type CaptureEntry = Readonly<{ caseId: string; kind: CaptureKind; sha256: string; bytes: number; omitted?: CaptureOmitted }>;

/** The size of `bytes` bytes once base64 encoded, which is what they cost in the group evidence. */
export const encodedBytes = (bytes: number) => 4 * Math.ceil(bytes / 3);

/** The capture an admitted policy approves. A policy that asks for traces is refused: there is nothing that could honour it safely. */
export function admittedCapturePolicy(capture: Readonly<{ screenshots: boolean; traces: boolean }>): CapturePolicy {
  if (capture.traces) throw new Error("trace capture is not supported: a trace keeps session tokens that cannot be scrubbed (deferred past M1.3)");
  return Object.freeze({ screenshots: capture.screenshots });
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The names a capture is stored under: the case's index in the compiled suite, never scenario text, a case id or an account name. */
export const captureFileName = (caseIndex: number) => `case-${caseIndex}-screenshot.jpg`;
const FILE_NAME = /^case-(\d{1,4})-screenshot\.jpg$/;

export type CaptureRecorder = Readonly<{
  /** Whether this kind is admitted. When it is not, `record` writes nothing. */
  enabled(kind: CaptureKind): boolean;
  /**
   * Stores one capture of one case. Resolves to its `artifacts.json` entry (with `omitted` when it was dropped and no file kept) or to null when the kind is not admitted.
   * A capture that carries an account credential (or the run's session secret) in any spelling is dropped. Any kind but a screenshot is refused.
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
    enabled: (kind: CaptureKind) => kind === "screenshot" && policy.screenshots,
    async record({ caseId, kind, bytes }: { caseId: string; kind: CaptureKind; bytes: Uint8Array }): Promise<CaptureEntry | null> {
      if ((kind as string) !== "screenshot") throw new Error("trace capture is not supported");
      if (!policy.screenshots) return null;
      const index = caseIndex.get(caseId);
      if (index === undefined) throw new Error("unknown case: it is not in the compiled plan");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
      const omitted: CaptureOmitted | undefined = redactor.contains(bytes) ? "credential-match" : bytes.byteLength > CAPTURE_SCREENSHOT_MAX_BYTES ? "budget" : undefined;
      const entry: CaptureEntry = Object.freeze({ caseId, kind, sha256: sha(bytes), bytes: bytes.byteLength, ...(omitted === undefined ? {} : { omitted }) });
      const name = captureFileName(index);
      await mkdir(join(root, CAPTURE_DIR, ENTRIES_DIR), { recursive: true, mode: 0o755 });
      if (omitted === undefined) await writeExclusive(join(root, CAPTURE_DIR, name), bytes);
      await writeExclusive(join(root, CAPTURE_DIR, ENTRIES_DIR, `${name}.json`), `${JSON.stringify({ schemaVersion: "e2e-executor-capture-entry/v1", ...entry })}\n`);
      return entry;
    },
  });
}

/**
 * Settles a group's captures after every shard has run: reads what the recorders listed, drops a capture that now carries a credential, fits the rest in the budget
 * (counted as base64; one file at a time, the largest first, the later case first among equals), writes `artifacts.json` and removes the recorders' working files.
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
  for (const name of names.filter((item) => item !== ENTRIES_DIR).sort()) {
    const match = FILE_NAME.exec(name);
    const index = match ? Number(match[1]) : -1;
    // A file that is not a screenshot of an admitted case (a trace, say) is not kept, whoever put it there.
    if (!match || !policy.screenshots || caseIds[index] === undefined) { await rm(join(dir, name), { force: true }); continue; }
    const bytes = await readFile(join(dir, name));
    listed.push({ name, index, kept: true, entry: { caseId: caseIds[index], kind: "screenshot", sha256: sha(bytes), bytes: bytes.byteLength } });
  }
  const drop = async (item: { entry: CaptureEntry; name: string; kept: boolean }, omitted: CaptureOmitted) => {
    await rm(join(dir, item.name), { force: true });
    item.kept = false; item.entry = { ...item.entry, omitted };
  };
  for (const item of listed) {
    if (redactor.contains(await readFile(join(dir, item.name)))) await drop(item, "credential-match");
    else if (item.entry.bytes > CAPTURE_SCREENSHOT_MAX_BYTES) await drop(item, "budget");
  }
  // What the recorders dropped already has no file; it is listed from their working files.
  const dropped: CaptureEntry[] = [];
  let entryNames: string[] = [];
  try { entryNames = (await readdir(join(dir, ENTRIES_DIR))).sort(); } catch { /* none */ }
  for (const name of entryNames) {
    try {
      const row = JSON.parse(await readFile(join(dir, ENTRIES_DIR, name), "utf8")) as Partial<CaptureEntry>;
      if (row.omitted !== undefined && row.kind === "screenshot" && typeof row.caseId === "string" && caseIds.includes(row.caseId)
        && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes) && (row.omitted === "budget" || row.omitted === "credential-match")) {
        dropped.push({ caseId: row.caseId, kind: "screenshot", sha256: row.sha256, bytes: row.bytes!, omitted: row.omitted });
      }
    } catch { /* an unreadable working file lists nothing */ }
  }
  const live = () => listed.filter((item) => item.kept);
  const total = () => live().reduce((sum, item) => sum + encodedBytes(item.entry.bytes), 0);
  while (total() > budget) {
    const victim = live().sort((a, b) => (b.entry.bytes - a.entry.bytes) || (b.index - a.index))[0];
    if (!victim) break;
    await drop(victim, "budget");
  }
  await rm(join(dir, ENTRIES_DIR), { recursive: true, force: true });
  if (!policy.screenshots) { await rm(dir, { recursive: true, force: true }); return []; }
  const entries = [...listed.map((item) => item.entry), ...dropped].sort((a, b) => caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId));
  await writeFile(join(outDir, CAPTURE_ARTIFACTS_FILE), `${JSON.stringify({ schemaVersion: "e2e-executor-artifacts/v1", artifacts: entries }, null, 2)}\n`);
  return entries;
}
