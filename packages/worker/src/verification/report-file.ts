// Proof and evidence (P3, P4): how the worker reads a report file a project's own check already wrote (a coverage file, a SARIF file). The path comes from the check's own command line (no default names are guessed: EV-2), so it is data the repository influences: it is read only through a path that stays inside the workspace, is a plain file (never a link, at any step of the path) and is within a size cap, and
// only when the check wrote it during this round (a file left by an earlier run, or put there by the agent before the checks ran, says nothing about this code: both its modification and its change time must lie in the round, and neither in the future). Nothing is written, moved or run.
//
// The file is opened with O_NOFOLLOW and measured through the open handle, so a link swapped in after the path was checked is refused by the system, and a file that grows while it is read is cut at the cap
// and refused. A failure is a fixed code, never a message: callers say "not measured".
//
// The inherent limit (EV-2): a report proves what the project's tooling wrote, not that it measured the real code. The check's command runs the agent's own tests and configuration in the round, and code there can write
// a report with every changed line hit (or a scan with no findings) with a fresh modification and change time; no freshness rule can see that. Naming the file in the check's own command line is the least a report must do.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ReportFileFailure = "missing" | "unsafe_path" | "too_large" | "stale" | "unreadable";
export type ReportFileRead = { ok: true; bytes: Buffer; path: string } | { ok: false; reason: ReportFileFailure };

/** The most a file's modification time may precede the round's start and still count as written in it (file systems keep time in whole seconds). */
export const REPORT_FRESHNESS_SLACK_MS = 2_000;

/** The real path of a file under `root`: its directory must exist, resolve inside the real root, and the file itself must not be a link (unless `allowLink`: see below). Undefined when the path is unsafe. `missing` when the file is not there. */
export async function containedReportPath(root: string, cwd: string, argument: string, options: { allowLink?: boolean } = {}): Promise<{ path: string } | "missing" | undefined> {
  try {
    if (argument === "" || argument.includes("\0")) return undefined;
    const realRoot = await realpath(root);
    const target = resolve(root, cwd, argument);
    const path = join(await realpath(dirname(target)), basename(target));
    const fromRoot = relative(realRoot, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || resolve(realRoot, fromRoot) !== path) return undefined;
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "missing" as const : null));
    if (existing === "missing") return "missing";
    // `allowLink` is for putting a file back: a link in its place is then the caller's to replace (never to follow); the directory part was resolved above and is inside the root either way.
    if (existing === null || (existing.isSymbolicLink() ? options.allowLink !== true : !existing.isFile())) return undefined;
    return { path };
  } catch {
    return undefined;
  }
}

/**
 * The bytes of the report at `argument` (relative to the check's `cwd` under `root`), within `maxBytes`, written at or after `notBeforeMs` (less the slack). Without `notBeforeMs` nothing is read: a caller that cannot say
 * when its round began must not trust a file that may be old.
 */
export async function readContainedReport(input: { root: string; cwd: string; argument: string; maxBytes: number; notBeforeMs: number | undefined; /** The time now, for tests (default `Date.now()`). */ nowMs?: number }): Promise<ReportFileRead> {
  if (input.notBeforeMs === undefined || !Number.isFinite(input.notBeforeMs)) return { ok: false, reason: "stale" };
  const contained = await containedReportPath(input.root, input.cwd, input.argument);
  if (contained === undefined) return { ok: false, reason: "unsafe_path" };
  if (contained === "missing") return { ok: false, reason: "missing" };
  const { path } = contained;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "unsafe_path" };
    if (info.size > input.maxBytes) return { ok: false, reason: "too_large" };
    // Written in this round: the modification time can be set by hand (the agent ran before the round and may date a file anything), but the change time cannot be set from user space and setting the
    // modification time moves it to now, so a file planted before the round has an older change time whatever its modification time says. Neither time may be in the future either.
    const now = input.nowMs ?? Date.now();
    const earliest = input.notBeforeMs - REPORT_FRESHNESS_SLACK_MS;
    const latest = now + REPORT_FRESHNESS_SLACK_MS;
    if (info.mtimeMs < earliest || info.ctimeMs < earliest || info.mtimeMs > latest || info.ctimeMs > latest) return { ok: false, reason: "stale" };
    // One byte more than the file had when it was measured: a file that grew while it is read does not fit, and is refused.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > info.size || length > input.maxBytes ? { ok: false, reason: "too_large" } : { ok: true, bytes: buffer.subarray(0, length), path };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
