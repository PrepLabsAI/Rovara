// TE-B9 (O38, L3): `rovara loop` publishes its own branch (packages/cli/src/loop/publish.ts). Rovara's working files are never pushed by it either: the branch is checked against the pull request's base just before `git push`.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { neverCommitRefusal } from "@agentx/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { realExec, type Exec } from "../../packages/cli/src/loop/exec.js";
import { publish, type PublishInput } from "../../packages/cli/src/loop/publish.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loop-never-commit-"));
  dirs.push(root);
  const g = async (cwd: string, args: string[]) => (await run("git", args, { cwd, env: ENV })).stdout;
  await g(root, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  await g(root, ["clone", "-q", "remote.git", "work"]);
  const work = join(root, "work");
  await writeFile(join(work, "README.md"), "x\n");
  await g(work, ["add", "-A"]);
  await g(work, ["commit", "-q", "-m", "base"]);
  await g(work, ["push", "-q", "origin", "main"]);
  await g(work, ["checkout", "-q", "-b", "loop/item"]);
  const commit = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(work, path)), { recursive: true }); await writeFile(join(work, path), content); }
    await g(work, ["add", "-f", "-A"]);
    await g(work, ["commit", "-q", "-m", "task"]);
  };
  const calls: string[][] = [];
  // git runs for real, except the push (nothing is sent); gh answers as if the pull request were opened.
  const exec: Exec = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "git" && args.includes("push")) return { code: 0, stdout: "", stderr: "" };
    if (command === "gh") return { code: 0, stdout: args[0] === "pr" && args[1] === "create" ? "https://github.com/o/r/pull/5\n" : args[0] === "api" ? "Title\n" : "", stderr: "" };
    return realExec(command, args, options);
  };
  const input = (): PublishInput => ({ repo: "o/r", issue: 1, worktree: work, branch: "loop/item", plan: "plan", checks: "ok", startedBy: "me", approvals: undefined, skipped: undefined, defaultBranch: "main", pullRequest: undefined, beforePush: vi.fn(async () => undefined) });
  return { work, commit, exec, calls, input };
}

describe("rovara loop never pushes Rovara's working files", () => {
  it("pushes a clean branch (positive control: the check ran and let it through)", async () => {
    const f = await fixture();
    await f.commit({ "feature.py": "print(1)\n", ".rovara/rules/a.md": "rule\n" });
    const result = await publish(f.exec, f.input());
    expect(result.created).toBe(true);
    expect(f.calls.some((call) => call[0] === "git" && call.includes("diff"))).toBe(true);
    expect(f.calls.some((call) => call.includes("push"))).toBe(true);
  });

  it("refuses with the fixed sentence before the push, and opens no pull request, when any task commit holds one (even a clean last commit)", async () => {
    const f = await fixture();
    await f.commit({ ".agentx/x": "state\n" });
    await f.commit({ "feature.py": "print(1)\n" });
    await expect(publish(f.exec, f.input())).rejects.toThrow(neverCommitRefusal(".agentx/x"));
    expect(f.calls.some((call) => call.includes("push"))).toBe(false);
    expect(f.calls.some((call) => call[0] === "gh")).toBe(false);
  });

  it("is case-blind, and stopped by the host's own check first when that holds the push", async () => {
    const f = await fixture();
    await f.commit({ ".Agentx-foo/y": "state\n" });
    await expect(publish(f.exec, f.input())).rejects.toThrow(neverCommitRefusal(".Agentx-foo/y"));
    const held = { ...f.input(), beforePush: vi.fn(async () => { throw new Error("hold"); }) };
    await expect(publish(f.exec, held)).rejects.toThrow("hold");
  });

  it("fails closed when the base cannot be read, and is not fooled by GIT_LITERAL_PATHSPECS", async () => {
    const f = await fixture();
    await f.commit({ ".agentx/x": "state\n" });
    await expect(publish(f.exec, { ...f.input(), defaultBranch: "nope" })).rejects.toThrow(/could not read the list of files/);
    vi.stubEnv("GIT_LITERAL_PATHSPECS", "1");
    try { await expect(publish(f.exec, f.input())).rejects.toThrow(neverCommitRefusal(".agentx/x")); } finally { vi.unstubAllEnvs(); }
  });
});
