import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE } from "@agentx/contracts";
import { preparedBaseResult, type PreparationManifest } from "../../packages/worker/src/prepare.js";
import { afterEach, describe, expect, it } from "vitest";
import { candidateUnchangedSinceBase, readCandidateRepositories } from "../../packages/worker/src/verification/candidate.js";

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

  it("says a candidate is unchanged only when every repository has a recorded base and still holds its tree", async () => {
    const unchanged = await repository();
    const other = await repository();
    const base = await git(unchanged, "rev-parse", "HEAD");
    const otherBase = await git(other, "rev-parse", "HEAD");
    const inputs = [{ repositoryId: "payments", directory: unchanged, baseCommitSha: base }, { repositoryId: "ledger", directory: other, baseCommitSha: otherBase }];
    const candidates = await readCandidateRepositories(inputs);
    expect(await candidateUnchangedSinceBase(inputs, candidates)).toBe(true);
    // A repository with no recorded base can't be shown unchanged, so the candidate isn't refused as "no code changed".
    const withoutBase = candidates.map((candidate) => {
      if (candidate.repositoryId !== "ledger") return candidate;
      const { baseCommitSha: _base, ...rest } = candidate;
      void _base;
      return rest;
    });
    expect(await candidateUnchangedSinceBase(inputs, withoutBase)).toBe(false);
  });
});
