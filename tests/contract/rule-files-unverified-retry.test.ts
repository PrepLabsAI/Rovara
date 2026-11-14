// #569: when the base commit's rule file cannot be read, the worker says why (the step and an error code, never a path or
// a file's contents), and a read whose git process could not start or ran out of time is tried once more with the same
// checks. A read that did not verify is never retried.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TrustedBaseObjects from "../../packages/worker/src/trusted-base-objects.js";

const plan = vi.hoisted(() => ({ failures: [] as Array<{ reason: string; transient: boolean }> }));

vi.mock("../../packages/worker/src/trusted-base-objects.js", async (importOriginal) => {
  const original = await importOriginal<typeof TrustedBaseObjects>();
  return {
    ...original,
    readVerifiedBaseRuleFile: async (...args: Parameters<typeof original.readVerifiedBaseRuleFile>) => {
      const next = plan.failures.shift();
      if (next !== undefined) throw new original.BaseObjectsUnverified(next.reason, next.transient);
      return original.readVerifiedBaseRuleFile(...args);
    },
  };
});

const { loadRepositoryContextFiles, readPreparedRepositories } = await import("../../packages/worker/src/repository-context.js");
const { BaseObjectsUnverified, unverifiedFrom } = await import("../../packages/worker/src/trusted-base-objects.js");

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

async function workspaceWithRule(rule: string) {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-rulefile-retry-")));
  const directory = join(rootPath, "repo/payments");
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(directory, "AGENTS.md"), rule);
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: 1,
    repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: base, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  const repositories = (await readPreparedRepositories(rootPath)).map((repository) => ({ ...repository, baseCommit: base }));
  return { rootPath, repositories };
}

let logged: Array<Record<string, unknown>>;
beforeEach(() => {
  plan.failures = [];
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(JSON.parse(String(line)) as Record<string, unknown>); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("reading the base commit's rule file when git could not run (#569)", () => {
  it("tries once more after a git process that could not start, and loads the rule file", async () => {
    const { rootPath, repositories } = await workspaceWithRule("Flag every TODO.\n");
    plan.failures = [{ reason: "git cat-file blob: start: EAGAIN", transient: true }];
    const { files } = await loadRepositoryContextFiles(rootPath, repositories, { at: "base-commit" });
    expect(files.map((file) => file.content)).toEqual([expect.stringContaining("Flag every TODO.")]);
    expect(logged).toEqual([{ component: "worker", event: "rule_files.unverified", repository: "payments", attempt: 1, reason: "git cat-file blob: start: EAGAIN", retrying: true }]);
  });

  it("stops with the fixed reason after a second temporary failure", async () => {
    const { rootPath, repositories } = await workspaceWithRule("Flag every TODO.\n");
    plan.failures = [{ reason: "git cat-file tree: timed out", transient: true }, { reason: "git cat-file tree: timed out", transient: true }];
    await expect(loadRepositoryContextFiles(rootPath, repositories, { at: "base-commit" })).rejects.toThrow("couldn't verify the base rule files");
    expect(logged.map((line) => [line.attempt, line.retrying])).toEqual([[1, true], [2, false]]);
  });

  it("never retries a read that did not verify", async () => {
    const { rootPath, repositories } = await workspaceWithRule("Flag every TODO.\n");
    plan.failures = [{ reason: "git cat-file blob: did not verify", transient: false }];
    await expect(loadRepositoryContextFiles(rootPath, repositories, { at: "base-commit" })).rejects.toThrow("couldn't verify the base rule files");
    expect(logged).toEqual([expect.objectContaining({ attempt: 1, reason: "git cat-file blob: did not verify", retrying: false })]);
  });
});

describe("the reason a verified read failed", () => {
  it("names the step and an error code, and marks only what a second try may pass as temporary", () => {
    expect(unverifiedFrom(Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" }), "git cat-file blob: start")).toMatchObject({ reason: "git cat-file blob: start: EAGAIN", transient: true });
    expect(unverifiedFrom(Object.assign(new Error("too many files"), { code: "EMFILE" }), "open the base commit")).toMatchObject({ transient: true });
    expect(unverifiedFrom(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "git cat-file -s tree")).toMatchObject({ reason: "git cat-file -s tree: timed out", transient: true });
    expect(unverifiedFrom(Object.assign(new Error("exit"), { code: 128 }), "git cat-file -s commit")).toMatchObject({ reason: "git cat-file -s commit: exit 128", transient: false });
    expect(unverifiedFrom(Object.assign(new Error("gone"), { code: "ENOENT" }), "read blob")).toMatchObject({ reason: "read blob: ENOENT", transient: false });
    const kept = new BaseObjectsUnverified("git cat-file blob: did not verify");
    expect(unverifiedFrom(kept, "read blob")).toBe(kept);
  });

  it("never carries a path or a message: an error code that is not a plain code is left out", () => {
    const leaky = Object.assign(new Error("/home/worker/secret/path failed"), { code: "/home/worker/secret/path" });
    expect(unverifiedFrom(leaky, "open the base commit").reason).toBe("open the base commit: error");
    expect(unverifiedFrom(new Error("/workspace/repo/AGENTS.md"), "read blob").reason).toBe("read blob: error");
  });
});
