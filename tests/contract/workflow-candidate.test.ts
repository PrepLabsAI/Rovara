import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE } from "@agentx/contracts";
import { preparedBaseResult, type PreparationManifest } from "../../packages/worker/src/prepare.js";
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

  it("records the task's base commit and refuses a base that is not an ancestor of HEAD", async () => {
    const directory = await repository();
    const base = await git(directory, "rev-parse", "HEAD");
    await writeFile(join(directory, "tracked.txt"), "next\n");
    await git(directory, "commit", "--quiet", "-am", "next");
    const [candidate] = await readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
    expect(candidate).toMatchObject({ repositoryId: "payments", baseCommitSha: base });
    await git(directory, "checkout", "--quiet", "--orphan", "unrelated");
    await git(directory, "commit", "--quiet", "-m", "unrelated");
    // History rewritten past the base: the owner is told so in plain words.
    const rewritten = readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: base }]);
    await expect(rewritten).rejects.toBeInstanceOf(AgentXError);
    await expect(rewritten).rejects.toThrow(WORKFLOW_HISTORY_REWRITTEN_MESSAGE);
    // A base the repository does not have at all leaves the candidate unreadable.
    await expect(readCandidateRepositories([{ repositoryId: "payments", directory, baseCommitSha: "1".repeat(40) }])).rejects.toThrow(/candidate repository/);
  });

  it("reports where preparation checked out each repository only when every commit is a full SHA-1", () => {
    const repository = (name: string, resolvedCommit: string) => ({ name, path: `repo/${name}`, defaultBranch: "main", resolvedCommit, resolvedAt: "", completedAt: "" });
    const manifest = (repositories: ReturnType<typeof repository>[]) => ({ repositories }) as unknown as PreparationManifest;
    expect(preparedBaseResult(manifest([repository("demo", "e".repeat(40)), repository("api", "f".repeat(40))])))
      .toEqual({ preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }, { repositoryId: "api", baseCommitSha: "f".repeat(40) }] });
    expect(preparedBaseResult(manifest([repository("demo", "e".repeat(40)), repository("api", "f".repeat(64))]))).toEqual({});
    expect(preparedBaseResult(manifest([]))).toEqual({});
  });

  it("refuses a path that is not a git worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentx-no-git-"));
    roots.push(directory);
    await mkdir(join(directory, "nested"));
    await expect(readCandidateRepositories([{ repositoryId: "payments", directory: join(directory, "nested") }])).rejects.toThrow(/candidate repository/);
  });

  it("never runs repository-controlled clean filters, fsmonitor or credential helpers while capturing the candidate", async () => {
    const directory = await repository();
    const marker = join(directory, "..", `agentx-filter-ran-${randomUUID()}`);
    await git(directory, "config", "filter.evil.clean", `sh -c 'touch ${marker}.clean; cat'`);
    await git(directory, "config", "filter.evil.process", `sh -c 'touch ${marker}.process'`);
    await git(directory, "config", "filter.evil.required", "true");
    await git(directory, "config", "core.fsmonitor", `sh -c 'touch ${marker}.fsmonitor'`);
    await writeFile(join(directory, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(join(directory, "tracked.txt"), "changed\n");
    const [candidate] = await readCandidateRepositories([{ repositoryId: "payments", directory }]);
    expect(candidate?.treeSha).toMatch(/^[a-f0-9]{40}$/);
    for (const suffix of [".clean", ".process", ".fsmonitor"]) await expect(access(`${marker}${suffix}`)).rejects.toThrow();
    // The tree holds the raw worktree bytes, not anything a filter produced.
    expect(await git(directory, "cat-file", "-p", `${candidate?.treeSha}:tracked.txt`)).toBe("changed");
  });

  it("captures the repository's own files even when its config points core.worktree at host files", async () => {
    const directory = await repository();
    const host = await mkdtemp(join(tmpdir(), "agentx-host-"));
    roots.push(host);
    await writeFile(join(host, "host-secret.txt"), "secret\n");
    await git(directory, "config", "core.worktree", host);
    await writeFile(join(directory, "new.txt"), "new\n");
    const [candidate] = await readCandidateRepositories([{ repositoryId: "payments", directory }]);
    const files = (await git(directory, "ls-tree", "--name-only", candidate?.treeSha ?? "")).split("\n");
    expect(files.sort()).toEqual(["new.txt", "tracked.txt"]);
  });

  it("refuses a nested repository recorded in the tree, and never runs Git under the nested repository's config", async () => {
    const directory = await repository();
    const nested = join(directory, "nested");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await writeFile(join(nested, "inner.txt"), "s\n");
    await git(nested, "add", "inner.txt");
    await git(nested, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "commit", "--quiet", "-m", "inner");
    await git(directory, "add", "nested");
    await git(directory, "commit", "--quiet", "-m", "nested");
    const marker = join(directory, "..", `agentx-nested-filter-ran-${randomUUID()}`);
    await git(nested, "config", "filter.inner.clean", `sh -c 'touch ${marker}; cat'`);
    await writeFile(join(nested, ".gitattributes"), "*.txt filter=inner\n");
    // The same size as before, so Git must hash the file (through the filter) to see it changed.
    await writeFile(join(nested, "inner.txt"), "t\n");
    const refusal = await readCandidateRepositories([{ repositoryId: "payments", directory }]).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(AgentXError);
    expect((refusal as AgentXError).code).toBe("CONFIG_INVALID");
    expect((refusal as AgentXError).message).toBe(
      "CONFIG_INVALID: the repository has a nested Git repository (a submodule) checked out at nested. AgentX tasks do not yet " +
        "support projects whose setup initialises Git submodules, or nested repositories the agent creates.",
    );
    await expect(access(marker)).rejects.toThrow();
  });
});
