import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-candidate-"));
  roots.push(directory);
  await git(directory, "init", "--quiet");
  await git(directory, "config", "user.email", "agentx@example.invalid");
  await git(directory, "config", "user.name", "AgentX Test");
  await writeFile(join(directory, "tracked.txt"), "baseline\n");
  await git(directory, "add", "tracked.txt");
  await git(directory, "commit", "--quiet", "-m", "baseline");
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("candidate repository capture", () => {
  it("returns immutable HEAD and a tree hash that includes tracked edits and untracked files without changing the index", async () => {
    const directory = await repository();
    const head = await git(directory, "rev-parse", "HEAD");
    const index = await readFile(join(directory, ".git", "index")).catch(() => Buffer.from(""));
    await writeFile(join(directory, "tracked.txt"), "changed\n");
    await writeFile(join(directory, "new.txt"), "new\n");

    const candidate = await readCandidateRepositories([{ repositoryId: "payments", directory }]);

    expect(candidate).toHaveLength(1);
    expect(candidate[0]).toMatchObject({ repositoryId: "payments", commitSha: head });
    expect(candidate[0]?.treeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe("changed\n");
    expect(await readFile(join(directory, "new.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(directory, ".git", "index")).catch(() => Buffer.from(""))).toEqual(index);
    expect(await git(directory, "status", "--porcelain")).toContain("?? new.txt");
  });

  it("refuses a path that is not a git worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-no-git-"));
    roots.push(directory);
    await mkdir(join(directory, "nested"));
    await expect(readCandidateRepositories([{ repositoryId: "payments", directory: join(directory, "nested") }])).rejects.toThrow(/candidate repository/);
  });
});
