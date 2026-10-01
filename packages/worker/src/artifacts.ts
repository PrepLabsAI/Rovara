import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PreparationManifest } from "./prepare.js";
import { redactCredentials } from "./events.js";
import { gitSafeEnvironment } from "./git.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 67_108_864;
// The control plane accepts artifacts up to 5 MB. Leave room for the
// truncation notice and any JSON/HTTP framing added by the callback client.
export const MAX_WORKSPACE_DIFF_BYTES = 4_500_000;
export const MISSING_BASE_NOTE =
  "[the commit this workspace was prepared at is not in this repository: the diff shows uncommitted changes only, not commits]";
const TRUNCATION_NOTICE = "\n\n[workspace diff truncated to fit the AgentX artifact limit]\n";

export interface WorkerArtifact {
  name: string;
  mediaType: string;
  content: string;
}

export type ArtifactSink = (artifact: WorkerArtifact) => Promise<void>;

/**
 * Publishes every repository's status and its diff against the commit the workspace was prepared
 * at, so changes the agent committed show with the ones it did not (#208). `changed` is true when
 * any repository's `git status` lists a change, including an untracked file (#158), or its HEAD has
 * moved from that commit (#208), as publication judges it. So a `git pull` or a checkout of another
 * branch counts too, and its upstream commits show in the diff, as they would in a publication.
 */
export async function publishWorkspaceDiff(rootPath: string, sink: ArtifactSink): Promise<{ changed: boolean }> {
  const manifest = JSON.parse(
    await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  const sections: string[] = [];
  let changed = false;
  for (const repository of manifest.repositories) {
    const directory = resolve(rootPath, repository.path);
    const head = await gitHead(directory);
    const base = await startingCommit(directory, repository.resolvedCommit);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "diff", "--no-ext-diff", "--binary", base ?? "HEAD", "--"],
      { timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", directory, "status", "--short", "--untracked-files=all"],
      { timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    // The same rule as publication: a HEAD that is not the recorded commit is a change.
    if (status.trim() !== "" || head !== repository.resolvedCommit) changed = true;
    // Never silent: a diff that cannot show committed changes says so, before the sections diffStat reads.
    const note = base === undefined ? `${MISSING_BASE_NOTE}\n` : "";
    sections.push(`## ${repository.name}\n\n${note}### status\n${status}\n### diff\n${stdout}`);
  }
  await sink({
    name: "workspace.diff",
    mediaType: "text/plain; charset=utf-8",
    content: boundWorkspaceDiff(String(redactCredentials(sections.join("\n")))),
  });
  return { changed };
}

/** The repository's HEAD commit. */
async function gitHead(directory: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", directory, "rev-parse", "HEAD"],
    { timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
  );
  return stdout.trim();
}

/**
 * The commit the workspace was prepared at, when the repository still has it. Without it (it was
 * pruned, or an old manifest holds no commit ID) the diff falls back to HEAD, shows only
 * uncommitted changes and says so; `changed` still counts the moved HEAD.
 */
async function startingCommit(directory: string, resolvedCommit: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(resolvedCommit)) return undefined;
  try {
    await execFileAsync(
      "git",
      ["-C", directory, "cat-file", "-e", `${resolvedCommit}^{commit}`],
      { timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    return resolvedCommit;
  } catch {
    return undefined;
  }
}

/**
 * A digest of every repository's state: its HEAD commit, so a commit counts as a change (#208), its
 * status, its diff against HEAD, and the size and modification time of each untracked file. Two
 * equal digests mean a task changed nothing, even when an earlier turn left the tree changed
 * (#158). An untracked directory that git lists as one entry (such as a nested repository) is
 * covered only by its own size and time.
 */
export async function workspaceFingerprint(rootPath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8"),
  ) as PreparationManifest;
  const hash = createHash("sha256");
  for (const repository of manifest.repositories) {
    const directory = resolve(rootPath, repository.path);
    const head = await gitHead(directory);
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", directory, "status", "--porcelain", "-z", "--untracked-files=all"],
      { timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    const { stdout: diff } = await execFileAsync(
      "git",
      ["-C", directory, "diff", "--no-ext-diff", "--binary", "HEAD", "--"],
      { timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, env: gitSafeEnvironment(directory) },
    );
    hash.update(`${repository.name}\u0000${head}\u0000${status}\u0000${diff}\u0000`);
    for (const entry of status.split("\u0000")) {
      if (!entry.startsWith("?? ")) continue;
      const file = await stat(resolve(directory, entry.slice(3))).catch(() => undefined);
      hash.update(`${entry}\u0000${file?.size ?? -1}\u0000${file?.mtimeMs ?? -1}\u0000`);
    }
  }
  return hash.digest("hex");
}

export function boundWorkspaceDiff(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_WORKSPACE_DIFF_BYTES) return content;
  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const prefix = Buffer.from(content, "utf8")
    .subarray(0, MAX_WORKSPACE_DIFF_BYTES - noticeBytes - 4)
    .toString("utf8");
  return `${prefix}${TRUNCATION_NOTICE}`;
}
