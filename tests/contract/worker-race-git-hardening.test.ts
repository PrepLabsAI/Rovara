import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { setCandidateWriteHookForTests } from "../../packages/worker/src/candidate-fs.js";
import { commitCandidateWorktree, readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

// The agent can rename or replace any directory of its repository at any moment. Each test makes that happen between the worker's last check of a path and the
// write it was checking for (the worker reports the step to a test hook), and then asserts that nothing was created outside the repository. On Linux the worker
// opens each directory once without following a symlink and writes through that descriptor, so the swap cannot redirect the write. Elsewhere (macOS) the
// worker only checks with lstat/realpath, which narrows the window and does not close it, so these tests run on Linux.
const execFile = promisify(execFileCallback);
const roots: string[] = [];
// AGENTX_RACE_TESTS=1 forces them on elsewhere, to see what the path-checking fallback does under the same swaps.
const linux = process.platform === "linux" || process.env.AGENTX_RACE_TESTS === "1";

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
}

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-race-")));
  roots.push(root);
  const directory = join(root, "repo");
  await mkdir(directory);
  await git(directory, "init", "--quiet");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await writeFile(join(directory, "tracked.txt"), "baseline\n");
  await git(directory, "add", "tracked.txt");
  await git(directory, "commit", "--quiet", "-m", "baseline");
  await writeFile(join(directory, "tracked.txt"), "changed\n");
  await writeFile(join(directory, "new.txt"), "new\n");
  const outside = join(root, "outside");
  await mkdir(join(outside, "refs", "heads"), { recursive: true });
  await mkdir(join(outside, "objects"), { recursive: true });
  return { root, directory, outside, dotGit: join(directory, ".git") };
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesUnder(root, path));
    else found.push(path);
  }
  return found.sort();
}

/** Replaces `path` by a symlink to `target`, keeping the original next to it, the way an agent's process would swap a directory. */
async function swapForSymlink(path: string, target: string): Promise<void> {
  await rename(path, `${path}.moved`);
  await symlink(target, path);
}

afterEach(async () => {
  setCandidateWriteHookForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(linux)("a directory swapped between the worker's check and its write redirects nothing", () => {
  /** What the swap target holds before the worker runs: a file the agent planted where a path-following rename would pick it up as the worker's own lock. */
  async function plant(box: Awaited<ReturnType<typeof repository>>, relative: string): Promise<string[]> {
    await mkdir(join(box.outside, relative, ".."), { recursive: true });
    await writeFile(join(box.outside, relative), "planted\n");
    return [relative];
  }

  it("does not rename the branch ref's lock through a swapped refs/heads", async () => {
    const box = await repository();
    const branch = await git(box.directory, "symbolic-ref", "--short", "HEAD");
    const planted = await plant(box, `refs/heads/${branch}.lock`);
    let swapped = false;
    setCandidateWriteHookForTests(async (step) => {
      if (step === `rename ${branch}` && !swapped) { swapped = true; await swapForSymlink(join(box.dotGit, "refs", "heads"), join(box.outside, "refs", "heads")); }
    });
    await commitCandidateWorktree([{ repositoryId: "payments", directory: box.directory }]).catch(() => undefined);
    expect(swapped).toBe(true);
    expect(await filesUnder(box.outside)).toEqual(planted);
  });

  it("does not rename the index lock through a .git swapped for a symlink", async () => {
    const box = await repository();
    const planted = await plant(box, "index.lock");
    let swapped = false;
    setCandidateWriteHookForTests(async (step) => {
      if (step === "rename index" && !swapped) { swapped = true; await swapForSymlink(box.dotGit, box.outside); }
    });
    await commitCandidateWorktree([{ repositoryId: "payments", directory: box.directory }]).catch(() => undefined);
    expect(swapped).toBe(true);
    expect(await filesUnder(box.outside)).toEqual(planted);
  });

  it("does not rename HEAD's lock over a detached HEAD through a .git swapped for a symlink", async () => {
    const box = await repository();
    await git(box.directory, "checkout", "--quiet", "--detach");
    const planted = await plant(box, "HEAD.lock");
    let swapped = false;
    setCandidateWriteHookForTests(async (step) => {
      if (step === "rename HEAD" && !swapped) { swapped = true; await swapForSymlink(box.dotGit, box.outside); }
    });
    await commitCandidateWorktree([{ repositoryId: "payments", directory: box.directory }]).catch(() => undefined);
    expect(swapped).toBe(true);
    expect(await filesUnder(box.outside)).toEqual(planted);
  });

  it("does not copy an object through an objects/<xx> directory swapped for a symlink", async () => {
    const box = await repository();
    let swapped = false;
    setCandidateWriteHookForTests(async (step) => {
      const match = /^object ([0-9a-f]{2})\//u.exec(step);
      if (match?.[1] !== undefined && !swapped) { swapped = true; await swapForSymlink(join(box.dotGit, "objects", match[1]), box.outside); }
    });
    await readCandidateRepositories([{ repositoryId: "payments", directory: box.directory }]).catch(() => undefined);
    expect(swapped).toBe(true);
    expect(await filesUnder(box.outside)).toEqual([]);
  });
});
