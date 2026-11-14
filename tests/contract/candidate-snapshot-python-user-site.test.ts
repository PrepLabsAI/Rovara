// C67: the Python user site (`.agentx-python`, at the workspace root) is the task's scratch for `pip install --user`, not part of the project. Its `.gitignore` of `*` keeps it out of a
// repository at the workspace root, but a task can delete that file or force-add the folder: the candidate snapshot leaves the folder out whatever the repository's own rules say.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC, snapshotTree, withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import { SANDBOX_PYTHON_USER_BASE_DIRECTORY } from "../../packages/worker/src/task-sandbox.js";

const execFile = promisify(execFileCallback);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const git = async (directory: string, ...args: string[]) =>
  (await execFile("git", ["-C", directory, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args])).stdout;

async function repository(): Promise<{ directory: string; base: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-snapshot-pyuser-"));
  cleanup.push(directory);
  await git(directory, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(directory, "README.md"), "# project\n");
  await git(directory, "add", "-A");
  await git(directory, "commit", "--quiet", "-m", "base");
  return { directory, base: (await git(directory, "rev-parse", "HEAD")).trim() };
}

const filesOf = async (directory: string, base: string): Promise<string[]> =>
  withIsolatedGit(directory, "read", async (session) => {
    const tree = await snapshotTree(session, base);
    return (await session.text(["ls-tree", "-r", "--name-only", tree])).split("\n").filter((line) => line !== "");
  });

describe("the candidate snapshot leaves the Python user site out (C67)", () => {
  it("excludes the folder the sandbox makes", () => {
    expect(CANDIDATE_EXCLUDE_PYTHON_USER_SITE_PATHSPEC).toBe(`:(top,exclude,literal)${SANDBOX_PYTHON_USER_BASE_DIRECTORY}`);
  });

  it("positive control: an ordinary new file is in the snapshot", async () => {
    const { directory, base } = await repository();
    await writeFile(join(directory, "feature.py"), "print(1)\n");
    expect(await filesOf(directory, base)).toEqual(["README.md", "feature.py"]);
  });

  it("does not take the folder in when the task deleted its .gitignore", async () => {
    const { directory, base } = await repository();
    await mkdir(join(directory, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin"), { recursive: true });
    await writeFile(join(directory, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin", "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(directory, "feature.py"), "print(1)\n");
    expect(await filesOf(directory, base)).toEqual(["README.md", "feature.py"]);
  });

  it("does not take the folder in when the task force-added it to the repository's index first", async () => {
    const { directory, base } = await repository();
    await mkdir(join(directory, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin"), { recursive: true });
    await writeFile(join(directory, SANDBOX_PYTHON_USER_BASE_DIRECTORY, "bin", "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await git(directory, "add", "-f", SANDBOX_PYTHON_USER_BASE_DIRECTORY);
    await git(directory, "commit", "--quiet", "-m", "forced");
    // The base the snapshot adds to is the task's start, which never held the folder.
    expect(await filesOf(directory, base)).toEqual(["README.md"]);
  });
});
