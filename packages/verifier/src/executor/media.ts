import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRedactor } from "./redact.js";
import { scrubTrace, type ScrubStats } from "./trace-scrub.js";

/**
 * Proof and evidence B4: video and trace capture of a browser case, behind the gate. This recorder is the executor's half of the gate: it takes a file only when the policy it was made with says the media is
 * admitted, and the policy says so only when the host was given proof that the round's accounts are run-scoped (`admittedMediaPolicy`). Everything it does not take, it does not write. What it takes is held to
 * its kind (magic bytes, size cap), a trace is scrubbed (cookies, set-cookie and authorization blanked) and every inflated entry is scanned for the run's credentials, and a video's bytes are scanned too.
 *
 * Media never rides in the group evidence (its 8 MiB cap holds a few screenshots, not a video): it is left in its own directory with a listing, `media.json`, for a separate upload that the broker accepts
 * only against the evidence pack's gate. A drop is recorded with a fixed reason and never changes a verdict.
 */
export const MEDIA_DIR = "media";
export const MEDIA_LISTING_FILE = "media.json";
export const MEDIA_VIDEO_MAX_BYTES = 20 * 1_048_576;
export const MEDIA_TRACE_MAX_BYTES = 25 * 1_048_576;
/** Per round (one group's out directory): the most video bytes it keeps, as the design caps it. */
export const MEDIA_VIDEO_ROUND_MAX_BYTES = 20 * 1_048_576;
const MAGIC = { video: [0x1a, 0x45, 0xdf, 0xa3], trace: [0x50, 0x4b, 0x03, 0x04] } as const;

export type MediaKind = "video" | "trace";
/** Why a file that was offered is not kept. Fixed words. */
export type MediaOmitted = "size_over_cap" | "unsafe_content" | "not_that_kind";
/** `scrub` is what the trace scrub did (counts only), so a reviewer can see that a trace was altered. Absent on a video. */
export type MediaEntry = Readonly<{ caseId: string; kind: MediaKind; sha256: string; bytes: number; omitted?: MediaOmitted; scrub?: ScrubStats }>;
export type MediaPolicy = Readonly<{ video: boolean; trace: boolean }>;

/**
 * The media a host may take. Both are off unless `runScoped` is true, which the host may set only from the broker-signed plan's proof that every account of the round is run-scoped; a policy that asks for
 * media without that proof gets none, and says so by throwing, so a misconfigured round fails loudly instead of recording unsafely.
 */
export function admittedMediaPolicy(capture: Readonly<{ video: boolean; traces: boolean }>, options: Readonly<{ runScoped?: boolean }> = {}): MediaPolicy {
  if ((capture.video || capture.traces) && options.runScoped !== true) throw new Error("video and trace capture need every account of the round to be run-scoped");
  return Object.freeze({ video: capture.video, trace: capture.traces });
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hasMagic = (bytes: Uint8Array, kind: MediaKind) => MAGIC[kind].every((byte, index) => bytes[index] === byte);
/** The names a media file is stored under: the case's index in the compiled suite, never scenario text or an account name. */
export const mediaFileName = (caseIndex: number, kind: MediaKind) => `case-${caseIndex}-${kind === "video" ? "video.webm" : "trace.zip"}`;
const FILE_NAME = /^case-(\d{1,4})-(video\.webm|trace\.zip)$/u;

async function writeExclusive(path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export type MediaRecorder = Readonly<{
  enabled(kind: MediaKind): boolean;
  /** Keeps one video or trace of one case, or records why not. Null when the kind is not admitted. One file per case and kind: a second is refused. */
  record(input: { caseId: string; kind: MediaKind; bytes: Uint8Array }): Promise<MediaEntry | null>;
}>;

export function createMediaRecorder(input: { root: string; policy: MediaPolicy; caseIds: readonly string[]; redactor: CredentialRedactor }): MediaRecorder {
  const { root, policy, redactor } = input;
  const caseIndex = new Map(input.caseIds.map((caseId, index) => [caseId, index] as const));
  const taken = new Set<string>();
  let videoBytes = 0;
  return Object.freeze({
    enabled: (kind: MediaKind) => (kind === "video" ? policy.video : kind === "trace" ? policy.trace : false),
    async record({ caseId, kind, bytes }: { caseId: string; kind: MediaKind; bytes: Uint8Array }): Promise<MediaEntry | null> {
      if (kind !== "video" && kind !== "trace") throw new Error("unknown media kind");
      if (!(kind === "video" ? policy.video : policy.trace)) return null;
      const index = caseIndex.get(caseId);
      if (index === undefined) throw new Error("unknown case: it is not in the compiled plan");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
      if (taken.has(`${caseId}:${kind}`)) throw new Error("one file of each media kind a case");
      taken.add(`${caseId}:${kind}`);
      const entry = (data: Uint8Array, omitted?: MediaOmitted, scrub?: ScrubStats): MediaEntry => Object.freeze({ caseId, kind, sha256: sha(data), bytes: data.byteLength, ...(omitted === undefined ? {} : { omitted }), ...(scrub === undefined ? {} : { scrub }) });
      const name = mediaFileName(index, kind);
      const list = async (row: MediaEntry) => {
        await mkdir(join(root, MEDIA_DIR, "entries"), { recursive: true, mode: 0o755 });
        await writeExclusive(join(root, MEDIA_DIR, "entries", `${name}.json`), Buffer.from(`${JSON.stringify({ schemaVersion: "e2e-executor-media-entry/v1", ...row })}\n`));
        return row;
      };
      if (!hasMagic(bytes, kind)) return list(entry(bytes, "not_that_kind"));
      if (bytes.byteLength > (kind === "video" ? MEDIA_VIDEO_MAX_BYTES : MEDIA_TRACE_MAX_BYTES)) return list(entry(bytes, "size_over_cap"));
      if (kind === "video" && videoBytes + bytes.byteLength > MEDIA_VIDEO_ROUND_MAX_BYTES) return list(entry(bytes, "size_over_cap"));
      // A trace is scrubbed and scanned inflated; a video can only be scanned as the bytes it is.
      // The redactor holds every account credential AND every cookie and localStorage value of the round (host.ts registers them); its "accounts" scope separates the account's own credentials, which a
      // snapshot may legitimately hold (a password input), from the session secrets, which mean the page rendered one.
      const scrubbed = kind === "trace" ? scrubTrace(bytes, (data) => redactor.contains(data), { accountContains: (data) => redactor.contains(data, "accounts") }) : undefined;
      const kept = kind === "trace" ? scrubbed?.zip ?? null : redactor.contains(bytes) ? null : bytes;
      if (kept === null) return list(entry(bytes, "unsafe_content"));
      if (kept.byteLength > MEDIA_TRACE_MAX_BYTES) return list(entry(kept, "size_over_cap", scrubbed?.stats));
      if (kind === "video") videoBytes += kept.byteLength;
      await mkdir(join(root, MEDIA_DIR), { recursive: true, mode: 0o755 });
      await writeExclusive(join(root, MEDIA_DIR, name), kept);
      return list(entry(kept, undefined, scrubbed?.stats));
    },
  });
}

const SCRUB_KEYS = ["droppedSnapshots", "droppedFrames", "droppedEntries", "blankedValues", "blankedResources", "secrets"] as const;
/** The scrub counts of a working file, or undefined when they are not exactly six bounded counts. */
function scrubStatsOf(value: unknown): ScrubStats | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const out: Partial<Record<(typeof SCRUB_KEYS)[number], number>> = {};
  for (const key of SCRUB_KEYS) {
    const count = record[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 100_000_000) return undefined;
    out[key] = count;
  }
  return out as ScrubStats;
}

/**
 * Settles a group's media after every shard has run: lists what the recorder kept and dropped in `media.json`, removes the recorder's working files, and removes any file that is not a listed, admitted,
 * well-formed media file of a case of the plan (whoever put it there). With no media admitted it writes nothing at all.
 */
export async function finalizeMedia(input: { outDir: string; policy: MediaPolicy; caseIds: readonly string[] }): Promise<MediaEntry[]> {
  const { outDir, policy, caseIds } = input;
  const dir = join(outDir, MEDIA_DIR);
  if (!policy.video && !policy.trace) { await rm(dir, { recursive: true, force: true }); return []; }
  const entries: MediaEntry[] = [];
  let working: string[] = [];
  try { working = (await readdir(join(dir, "entries"))).sort(); } catch { /* nothing was recorded */ }
  for (const name of working) {
    try {
      const row = JSON.parse(await readFile(join(dir, "entries", name), "utf8")) as Partial<MediaEntry>;
      if ((row.kind === "video" || row.kind === "trace") && (row.kind === "video" ? policy.video : policy.trace) && typeof row.caseId === "string" && caseIds.includes(row.caseId)
        && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/u.test(row.sha256) && Number.isSafeInteger(row.bytes) && (row.omitted === undefined || ["size_over_cap", "unsafe_content", "not_that_kind"].includes(row.omitted))) {
        const scrub = scrubStatsOf(row.scrub);
        entries.push({ caseId: row.caseId, kind: row.kind, sha256: row.sha256, bytes: row.bytes!, ...(row.omitted === undefined ? {} : { omitted: row.omitted }), ...(scrub === undefined ? {} : { scrub }) });
      }
    } catch { /* an unreadable working file lists nothing */ }
  }
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((name) => name !== "entries"); } catch { /* none */ }
  for (const name of files) {
    const match = FILE_NAME.exec(name);
    const kind: MediaKind | undefined = match === null ? undefined : match[2] === "video.webm" ? "video" : "trace";
    const caseId = match === null ? undefined : caseIds[Number(match[1])];
    const listed = kind === undefined || caseId === undefined ? undefined : entries.find((row) => row.caseId === caseId && row.kind === kind && row.omitted === undefined);
    // A kept file is the one that was listed: same case, same kind, same digest. Anything else is removed.
    if (listed === undefined || (kind === "video" ? !policy.video : !policy.trace) || sha(await readFile(join(dir, name))) !== listed.sha256) { await rm(join(dir, name), { force: true }); continue; }
  }
  const stillThere = new Set<string>();
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter((item) => item !== "entries")) {
    const match = FILE_NAME.exec(name);
    if (match !== null) stillThere.add(`${caseIds[Number(match[1])]}:${match[2] === "video.webm" ? "video" : "trace"}`);
  }
  // A listed file that is no longer on disk is a drop, not a keep.
  const settled = entries.map((row): MediaEntry => (row.omitted === undefined && !stillThere.has(`${row.caseId}:${row.kind}`) ? { ...row, omitted: "unsafe_content" } : row))
    .sort((a, b) => caseIds.indexOf(a.caseId) - caseIds.indexOf(b.caseId) || (a.kind < b.kind ? -1 : 1));
  await rm(join(dir, "entries"), { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(join(outDir, MEDIA_LISTING_FILE), `${JSON.stringify({ schemaVersion: "e2e-executor-media/v1", media: settled }, null, 2)}\n`);
  return settled;
}
