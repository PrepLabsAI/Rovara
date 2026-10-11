import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { gitHardenedEnvironment } from "../git.js";

const execFile = promisify(execFileCallback);

const OBJECT_ID = /^[a-f0-9]{40}$/;

/**
 * Settings and options every AgentX diff on a workspace repository uses, so nothing the agent controls changes what
 * reviewers see or how findings are placed: no external diff or textconv driver, no nested repository, the user's
 * attributes file ignored, and `--text` so no `binary`/`-diff` attribute (from `.gitattributes`, `.git/info/attributes`
 * or a `diff.<driver>.binary` setting) can hide a file's patch. Git 2.39 cannot pin the attribute source
 * (`--attr-source` needs 2.42), so `--text` is what overrides those attributes.
 */
const SAFE_DIFF_CONFIG = ["-c", "core.attributesFile=/dev/null", "-c", "core.quotePath=false"] as const;
const SAFE_DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--text", "--no-color", "--ignore-submodules=dirty", "--find-renames"] as const;

/** The most of the zero-context patch AgentX reads to place findings; past it, unread files cannot be placed. */
export const CHANGE_PATCH_MAX_BYTES = 64 * 1024 * 1024;

function checkedObjects(input: { baseCommitSha: string; treeSha: string }): void {
  if (!OBJECT_ID.test(input.baseCommitSha) || !OBJECT_ID.test(input.treeSha)) throw new Error("diff objects are invalid");
}

/**
 * Runs Git and reads at most `maxBytes` of its output; past that it stops Git and reports the output as cut.
 * A Git failure (a nonzero exit before the limit) rejects.
 */
function readGitOutput(args: readonly string[], env: NodeJS.ProcessEnv, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes + 1 - length;
      chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      length += Math.min(chunk.byteLength, room);
      if (length > maxBytes) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!truncated && code !== 0) {
        reject(new Error(`git diff exited with status ${String(code)}`));
        return;
      }
      resolveOutput({ bytes: Buffer.concat(chunks), truncated });
    });
  });
}

/**
 * The change from the task's base commit to the checked tree, as `--stat` then the patch. Git's output is read
 * only up to `maxBytes` (a lockfile or generated code does not fail the review) and cut on a UTF-8 character
 * boundary, with a note that the rest is in the listed files.
 */
export async function candidateDiff(input: { directory: string; baseCommitSha: string; treeSha: string; maxBytes: number }): Promise<{ text: string; truncated: boolean }> {
  checkedObjects(input);
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("diff size limit is invalid");
  const { bytes } = await readGitOutput([
    "-C", input.directory, ...SAFE_DIFF_CONFIG, "diff", ...SAFE_DIFF_OPTIONS, "--stat", "--patch", input.baseCommitSha, input.treeSha, "--",
  ], await gitHardenedEnvironment(input.directory), input.maxBytes);
  if (bytes.byteLength <= input.maxBytes) return { text: bytes.toString("utf8"), truncated: false };
  let end = input.maxBytes;
  // Step back over UTF-8 continuation bytes (10xxxxxx) so the cut never splits a character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const kept = bytes.subarray(0, end).toString("utf8");
  const note = `[diff cut at ${Math.max(1, Math.floor(input.maxBytes / 1024))} KB; open the listed files to review the rest]`;
  return { text: `${kept}${kept.endsWith("\n") ? "" : "\n"}${note}\n`, truncated: true };
}

/**
 * One path the change touches, at its checked-tree path.
 * - ADDED: a new file. DELETED: a removed file.
 * - MODIFIED: an edit, a mode change, or a rename Git detects (at least 50% similar, `--find-renames`), whose
 *   hunks are against the old path's content. A file Git cannot pair as a rename reads as DELETED plus ADDED.
 * - UNPLACEABLE: AgentX cannot tell which lines changed: a type change (file, symlink or submodule), a patch Git
 *   still printed as binary, or a file past the patch limit.
 * `hunks` are the new-side line ranges the change wrote, inclusive; a pure deletion covers the new-side lines on
 * either side of where the removed lines were.
 */
export interface CandidateChange {
  path: string;
  status: "ADDED" | "MODIFIED" | "DELETED" | "UNPLACEABLE";
  hunks: Array<readonly [number, number]>;
}

/**
 * Pairs `git diff --name-status -z` with the same diff's `-U0` patch. Each record owns one patch file header, and a
 * type change owns two (Git prints it as a deletion and an addition). A line starting "diff --git " is always a
 * header, since every content line of a zero-context patch starts with "+", "-", "\" or is a header line Git writes.
 * If the headers do not pair up, or the patch was cut, the files AgentX could not read are UNPLACEABLE: placing
 * fails closed, never open.
 */
export function parseCandidateChanges(nameStatus: string, patch: string, patchTruncated: boolean): CandidateChange[] {
  const changes: CandidateChange[] = [];
  const owners: number[] = [];
  const fields = nameStatus.split("\0");
  for (let index = 0; index < fields.length && fields[index] !== "";) {
    const code = fields[index]!;
    // A rename (Rnnn) or copy (Cnnn) names its old and new path; every other status names one path.
    const paired = code.startsWith("R") || code.startsWith("C");
    const path = paired ? fields[index + 2] : fields[index + 1];
    index += paired ? 3 : 2;
    if (path === undefined || path === "") throw new Error("diff name status is malformed");
    const status = code.startsWith("A") || code.startsWith("C") ? "ADDED" : code.startsWith("D") ? "DELETED"
      : code.startsWith("T") ? "UNPLACEABLE" : "MODIFIED";
    owners.push(changes.length);
    if (code.startsWith("T")) owners.push(changes.length);
    changes.push({ path, status, hunks: [] });
  }
  let header = -1;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header += 1;
      continue;
    }
    const change = header < 0 ? undefined : changes[owners[header] ?? -1];
    if (change === undefined) continue;
    if (line.startsWith("Binary files ")) {
      change.status = "UNPLACEABLE";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    change.hunks.push(count === 0 ? [Math.max(1, start), start + 1] : [start, start + count - 1]);
  }
  const unread = patchTruncated ? owners[Math.max(0, header)] ?? 0 : header === owners.length - 1 ? changes.length : 0;
  // A cut patch leaves the file it stopped in (and every later one) unread; headers that do not pair leave all unread.
  for (const change of changes.slice(unread)) if (change.status === "MODIFIED") change.status = "UNPLACEABLE";
  return changes;
}

/** The paths and changed new-side lines from the base commit to the checked tree. */
export async function candidateChanges(input: { directory: string; baseCommitSha: string; treeSha: string }): Promise<CandidateChange[]> {
  checkedObjects(input);
  const env = await gitHardenedEnvironment(input.directory);
  const objects = [input.baseCommitSha, input.treeSha, "--"];
  const { stdout: names } = await execFile("git", ["-C", input.directory, ...SAFE_DIFF_CONFIG, "diff", ...SAFE_DIFF_OPTIONS, "--name-status", "-z", ...objects],
    { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const patch = await readGitOutput(["-C", input.directory, ...SAFE_DIFF_CONFIG, "diff", ...SAFE_DIFF_OPTIONS, "-U0", ...objects], env, CHANGE_PATCH_MAX_BYTES);
  return parseCandidateChanges(names, patch.bytes.subarray(0, CHANGE_PATCH_MAX_BYTES).toString("utf8"), patch.truncated);
}
