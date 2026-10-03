// Spec 051 D-16 (#290): AgentX runs the agent's test commands on the original code, then restores the agent's files.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentFilesRestoreError, git as runGit, gitOriginalCode, ORIGINAL_CODE_REF, recoverAgentFiles } from "../../packages/worker/src/verification/original-code.js";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], { env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("gitOriginalCode", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  /** A repository at its starting commit, then the agent's changes of every kind. */
  async function agentRepository() {
    const directory = realpathSync(await mkdtemp(join(tmpdir(), "agentx-original-")));
    cleanup.push(directory);
    git(directory, "init", "-q", "-b", "main");
    await writeFile(join(directory, ".gitignore"), "build/\n");
    await writeFile(join(directory, "kept.py"), "unchanged\n");
    await writeFile(join(directory, "changed.py"), "original\n");
    await writeFile(join(directory, "deleted.py"), "the agent deletes this\n");
    await mkdir(join(directory, "pkg"));
    await writeFile(join(directory, "pkg", "renamed.py"), "moved by the agent\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "start");
    const start = git(directory, "rev-parse", "HEAD");
    // The agent: a change, a deletion, a new file in a new directory, a rename, a staged edit and a build artifact.
    await writeFile(join(directory, "changed.py"), "the agent's version\n");
    await rm(join(directory, "deleted.py"));
    await mkdir(join(directory, "new", "deep"), { recursive: true });
    await writeFile(join(directory, "new", "deep", "added.py"), "added by the agent\n");
    git(directory, "mv", "pkg/renamed.py", "renamed.py");
    await writeFile(join(directory, "kept.py"), "staged edit\n");
    git(directory, "add", "kept.py");
    await mkdir(join(directory, "build"));
    await writeFile(join(directory, "build", "artifact.so"), "ignored, never touched\n");
    return { directory, start };
  }

  it("shows the starting commit's files while the work runs, and restores the agent's files exactly", async () => {
    const { directory, start } = await agentRepository();
    const statusBefore = git(directory, "status", "--porcelain", "--untracked-files=all");
    const headBefore = git(directory, "rev-parse", "HEAD");
    const seen = await gitOriginalCode([{ directory, commit: start }]).run(async () => ({
      changed: await readFile(join(directory, "changed.py"), "utf8"),
      kept: await readFile(join(directory, "kept.py"), "utf8"),
      deleted: await exists(join(directory, "deleted.py")),
      added: await exists(join(directory, "new", "deep", "added.py")),
      newDirectory: await exists(join(directory, "new")),
      renamedAtStart: await exists(join(directory, "pkg", "renamed.py")),
      renamedByAgent: await exists(join(directory, "renamed.py")),
      artifact: await readFile(join(directory, "build", "artifact.so"), "utf8"),
      ref: git(directory, "rev-parse", "--verify", ORIGINAL_CODE_REF),
    }));
    expect(seen).toMatchObject({
      changed: "original\n", kept: "unchanged\n", deleted: true, added: false, newDirectory: false,
      renamedAtStart: true, renamedByAgent: false, artifact: "ignored, never touched\n",
    });
    expect(seen.ref).toMatch(/^[0-9a-f]{40}$/);
    // Everything is back, the index and HEAD were never touched, and the private ref is gone.
    expect(await readFile(join(directory, "changed.py"), "utf8")).toBe("the agent's version\n");
    expect(await readFile(join(directory, "new", "deep", "added.py"), "utf8")).toBe("added by the agent\n");
    expect(await exists(join(directory, "deleted.py"))).toBe(false);
    expect(git(directory, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(git(directory, "rev-parse", "HEAD")).toBe(headBefore);
    expect(() => git(directory, "rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF)).toThrow();
  });

  it("shows the starting commit even when the agent committed its change, and keeps the agent's commit", async () => {
    const { directory, start } = await agentRepository();
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "the agent's commit");
    const agentHead = git(directory, "rev-parse", "HEAD");
    const changed = await gitOriginalCode([{ directory, commit: start }]).run(() => readFile(join(directory, "changed.py"), "utf8"));
    expect(changed).toBe("original\n");
    expect(git(directory, "rev-parse", "HEAD")).toBe(agentHead);
    expect(git(directory, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("removes files the work itself created, and restores the agent's files when the work fails", async () => {
    const { directory, start } = await agentRepository();
    const statusBefore = git(directory, "status", "--porcelain", "--untracked-files=all");
    await expect(gitOriginalCode([{ directory, commit: start }]).run(async () => {
      await writeFile(join(directory, "test-output.txt"), "written by a test run\n");
      throw new Error("the before run failed");
    })).rejects.toThrow("the before run failed");
    expect(await exists(join(directory, "test-output.txt"))).toBe(false);
    expect(git(directory, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
  });

  it("changes nothing when the agent changed nothing", async () => {
    const { directory, start } = await agentRepository();
    git(directory, "reset", "-q", "--hard", start);
    git(directory, "clean", "-q", "-fd");
    const ref = await gitOriginalCode([{ directory, commit: start }]).run(async () => {
      try { return git(directory, "rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF); } catch { return "none"; }
    });
    expect(ref).toBe("none");
  });

  it("puts back the agent's files a stopped worker left, before the next task", async () => {
    const { directory } = await agentRepository();
    const statusBefore = git(directory, "status", "--porcelain", "--untracked-files=all");
    // A worker that stopped mid-run: the ref holds the agent's files, and the working tree shows other files.
    const index = join(directory, ".git", "test-index");
    const agentFiles = execFileSync("sh", ["-c", `cp .git/index ${index} && GIT_INDEX_FILE=${index} git add -A && GIT_INDEX_FILE=${index} git write-tree`], { cwd: directory, encoding: "utf8" }).trim();
    await rm(index);
    git(directory, "update-ref", ORIGINAL_CODE_REF, agentFiles);
    await writeFile(join(directory, "changed.py"), "original\n");
    await writeFile(join(directory, "deleted.py"), "the agent deletes this\n");
    await rm(join(directory, "new"), { recursive: true });
    expect(await recoverAgentFiles([directory])).toEqual([directory]);
    expect(await readFile(join(directory, "changed.py"), "utf8")).toBe("the agent's version\n");
    expect(git(directory, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(() => git(directory, "rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF)).toThrow();
    // Nothing left to recover.
    expect(await recoverAgentFiles([directory])).toEqual([]);
  });

  it("survives Git exiting before its standard input is written (EPIPE), which would otherwise crash the worker", async () => {
    // `git --version` never reads its input: 10 MB cannot fit the pipe, so the write fails with EPIPE after Git exits.
    const { directory } = await agentRepository();
    await expect(runGit(directory, ["--version"], {}, true, "x".repeat(10_000_000))).resolves.toMatch(/^git version/);
    await expect(runGit(directory, ["rev-parse", "--is-inside-work-tree"])).resolves.toBe("true");
  });

  it("fails with AgentFilesRestoreError, keeping the ref, when a repository cannot be restored", async () => {
    const { directory, start } = await agentRepository();
    await expect(gitOriginalCode([{ directory, commit: start }]).run(async () => {
      // A work step that makes the repository unusable for Git: the restore cannot run.
      await rm(join(directory, ".git", "index"), { force: true });
      await writeFile(join(directory, ".git", "HEAD"), "not a ref\n");
    })).rejects.toBeInstanceOf(AgentFilesRestoreError);
  });
});
