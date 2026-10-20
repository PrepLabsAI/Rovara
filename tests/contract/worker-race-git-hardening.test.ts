import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCandidateWriteHookForTests, workTreeByDescriptor } from "../../packages/worker/src/candidate-fs.js";
import { withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import { runIsolatedGit } from "../../packages/worker/src/isolated-repository.js";
import { commitCandidateWorktree, readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";
import { gitOriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { installGitShim } from "../support/git-shim.js";

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
  vi.unstubAllEnvs();
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

describe.runIf(process.platform === "linux")("on Linux the swap tests above are not skipped and the descriptor paths are the ones in use", () => {
  it("holds directories by descriptor and starts Git in the held work tree", () => {
    expect(linux).toBe(true);
    expect(process.env.AGENTX_WORKTREE_BY_PATH).not.toBe("1");
    expect(workTreeByDescriptor()).toBe(true);
  });
});

/**
 * The work tree: Git's own writes. `git checkout`, `reset`, `merge`, `revert`, `checkout-index` and `add` name the work tree by path, so a directory swapped for a
 * symlink while the command starts redirects the files it writes, deletes or reads. On Linux the worker holds the work tree open and starts Git in it, so the
 * swap cannot. The git shim swaps the workspace directory for a symlink to a decoy the moment the command named by SHIM_ON starts (after the worker spawned it,
 * before Git looked at the path).
 */
describe.runIf(linux)("a workspace directory swapped for a symlink as a Git command starts redirects nothing", () => {
  async function workspace() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-wt-")));
    roots.push(root);
    const directory = join(root, "repo");
    await mkdir(directory);
    await git(directory, "init", "--quiet", "--initial-branch=main");
    await git(directory, "config", "user.email", "agentx@example.invalid");
    await git(directory, "config", "user.name", "AgentX Test");
    await writeFile(join(directory, "a.txt"), "1\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "--quiet", "-m", "one");
    const one = await git(directory, "rev-parse", "HEAD");
    await writeFile(join(directory, "a.txt"), "2\n");
    await writeFile(join(directory, "b.txt"), "b\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "--quiet", "-m", "two");
    const two = await git(directory, "rev-parse", "HEAD");
    const outside = join(root, "outside");
    await mkdir(join(outside, ".git"), { recursive: true });
    await cp(join(directory, ".git", "objects"), join(outside, ".git", "objects"), { recursive: true });
    const shim = await installGitShim(root);
    for (const [name, value] of Object.entries(shim.environment)) vi.stubEnv(name, value);
    return { root, directory, outside, one, two };
  }
  /**
   * Makes the decoy what an agent would plant: the work tree's files as they are now (so Git sees nothing in the way and goes ahead), one file only `add` would
   * pick up, and the object store copied in `workspace()` (so that a Git that follows the swapped path finds the commits it was asked about). Returns its contents.
   */
  async function planted(box: { directory: string; outside: string }): Promise<Record<string, string>> {
    for (const name of (await readdir(box.directory)).filter((entry) => entry !== ".git")) await cp(join(box.directory, name), join(box.outside, name), { recursive: true });
    await writeFile(join(box.outside, "secret.txt"), "outside secret\n");
    return decoy(box.outside);
  }
  async function decoy(outside: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const name of (await readdir(outside)).filter((entry) => entry !== ".git")) found[name] = await readFile(join(outside, name), "utf8");
    return found;
  }
  const swapOn = (box: { directory: string; outside: string }, subcommand: string) => {
    vi.stubEnv("SHIM_ON", subcommand);
    vi.stubEnv("SHIM_SWAP", `${box.directory}=${box.outside}`);
  };

  it("does not write files through the swapped directory on `git checkout --force -B`", async () => {
    const box = await workspace();
    await git(box.directory, "checkout", "--quiet", box.one);
    const untouched = await planted(box);
    swapOn(box, "checkout");
    await runIsolatedGit(box.directory, ["checkout", "--force", "-B", "next", box.two]).catch(() => undefined);
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(await decoy(box.outside)).toEqual(untouched);
  });

  it("does not write files through the swapped directory on `git reset --hard`", async () => {
    const box = await workspace();
    await git(box.directory, "checkout", "--quiet", box.one);
    const untouched = await planted(box);
    swapOn(box, "reset");
    await runIsolatedGit(box.directory, ["reset", "--hard", box.two]).catch(() => undefined);
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(await decoy(box.outside)).toEqual(untouched);
  });

  it("does not write files through the swapped directory on `git merge`", async () => {
    const box = await workspace();
    await git(box.directory, "branch", "topic");
    await git(box.directory, "checkout", "--quiet", "-B", "main", box.one);
    const untouched = await planted(box);
    swapOn(box, "merge");
    await runIsolatedGit(box.directory, ["merge", "--ff-only", "topic"]).catch(() => undefined);
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(await decoy(box.outside)).toEqual(untouched);
  });

  it("does not delete or rewrite files through the swapped directory on `git revert`", async () => {
    const box = await workspace();
    const untouched = await planted(box);
    swapOn(box, "revert");
    await runIsolatedGit(box.directory, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "revert", "--no-edit", box.two]).catch(() => undefined);
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(await decoy(box.outside)).toEqual(untouched);
  });

  it("does not write the starting files through the swapped directory on `git checkout-index` (original code, agent running)", async () => {
    const box = await workspace();
    await writeFile(join(box.directory, "a.txt"), "the agent's version\n");
    const untouched = await planted(box);
    swapOn(box, "checkout-index");
    await gitOriginalCode([{ directory: box.directory, commit: box.one }]).run(async () => undefined).catch(() => undefined);
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(await decoy(box.outside)).toEqual(untouched);
  });

  it("does not read the swapped directory's files on `git add`", async () => {
    const box = await workspace();
    const untouched = await planted(box);
    swapOn(box, "add");
    // `--dry-run` prints what Git would stage: the real directory has nothing new, the decoy has a secret.txt. (A read session: nothing path-based follows the
    // command, so its output comes back even though the directory is now a symlink.)
    const staged = await withIsolatedGit(box.directory, "read", async (session) => {
      await session.text(["read-tree", box.two]);
      return session.text(["add", "--all", "--dry-run", "--", "."]);
    });
    expect(existsSync(`${box.directory}.moved`)).toBe(true);
    expect(staged).toBe("");
    expect(await decoy(box.outside)).toEqual(untouched);
  });
});
