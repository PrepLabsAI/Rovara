import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoriesFingerprint } from "../../packages/worker/src/artifacts.js";
import { inspectWorkspaceForClose } from "../../packages/worker/src/close-workspace.js";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import { gitOriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { installGitShim, type GitShim } from "../support/git-shim.js";
import { commitAs, createPrFixture, git, type FixtureMode, type FixtureOptions, type PrFixture } from "../support/pr-fixture.js";

const directories: string[] = [];
let disallowFileTransport: () => void = () => undefined;

beforeEach(async () => {
  disallowFileTransport = allowGitFileTransportForTests();
  const home = await mkdtemp(join(tmpdir(), "agentx-ws-home-"));
  directories.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});

afterEach(async () => {
  disallowFileTransport();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const markersIn = async (directory: string) => (await readdir(directory)).filter((name) => name.startsWith("agentx-ran-")).sort();
const command = (root: string, name: string) => `sh -c 'touch ${join(root, `agentx-ran-${name}`)}; cat'`;
async function withShim(root: string, candidate: string): Promise<GitShim> {
  const shim = await installGitShim(root);
  for (const [name, value] of Object.entries(shim.environment)) vi.stubEnv(name, value);
  vi.stubEnv("SHIM_CANDIDATE", candidate);
  return shim;
}
function plant(on: string, entries: ReadonlyArray<readonly [string, string]>): void {
  vi.stubEnv("SHIM_ON", on);
  vi.stubEnv("SHIM_RESTORE", "1");
  vi.stubEnv("SHIM_CONFIG_SET", entries.map(([key, value]) => `${key}=${value}`).join("\n"));
}
/** The file's modification time is moved, so Git sees it as changed and must hash it (through any filter) even when its size is the same. */
async function touchLater(path: string): Promise<void> {
  const later = new Date(Date.now() + 3_600_000);
  await utimes(path, later, later);
}

/** A repository with a committed `.gitattributes` that names a filter no config defines, and a manifest, for the calls that read a workspace. */
async function simpleWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-ws-")));
  directories.push(root);
  const directory = join(root, "repo", "demo");
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(directory, ".gitattributes"), "*.txt filter=y\n", "utf8");
  await writeFile(join(directory, "tracked.txt"), "1\n", "utf8");
  await git(directory, ["add", "."]);
  await commitAs(directory, "base");
  const commit = (await git(directory, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "demo", projectRevision: 1, complete: true,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: commit, resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
  }), "utf8");
  return { root, directory, commit };
}

describe("class A: reads of the workspace's files", () => {
  it("runs no filter planted right before `git status` while fingerprinting (repositoriesFingerprint)", async () => {
    const box = await simpleWorkspace();
    await withShim(box.root, box.directory);
    await writeFile(join(box.directory, "tracked.txt"), "2\n", "utf8");
    await touchLater(join(box.directory, "tracked.txt"));
    plant("status", [["filter.y.clean", command(box.root, "status")]]);
    await repositoriesFingerprint([{ name: "demo", directory: box.directory }]);
    expect(await markersIn(box.root)).toEqual([]);
  });

  it("runs no filter planted right before `git status` while inspecting a workspace to close it (inspectWorkspaceForClose)", async () => {
    const box = await simpleWorkspace();
    await withShim(box.root, box.directory);
    await writeFile(join(box.directory, "tracked.txt"), "2\n", "utf8");
    await touchLater(join(box.directory, "tracked.txt"));
    plant("status", [["filter.y.clean", command(box.root, "close")]]);
    const result = await inspectWorkspaceForClose(box.root);
    expect(result.safeToClose).toBe(false);
    expect(await markersIn(box.root)).toEqual([]);
  });
});

describe("class A: original code (swap the work tree to the starting commit and back)", () => {
  async function agentChanges() {
    const box = await simpleWorkspace();
    await withShim(box.root, box.directory);
    await writeFile(join(box.directory, "tracked.txt"), "2\n", "utf8");
    await writeFile(join(box.directory, "new.txt"), "new\n", "utf8");
    await touchLater(join(box.directory, "tracked.txt"));
    return box;
  }

  it("runs no filter planted right before the `git add` that captures the agent's files", async () => {
    const box = await agentChanges();
    plant("add", [["filter.y.clean", command(box.root, "add")]]);
    const seen = await gitOriginalCode([{ directory: box.directory, commit: box.commit }]).run(() => readFile(join(box.directory, "tracked.txt"), "utf8"));
    expect(seen).toBe("1\n");
    expect(await readFile(join(box.directory, "tracked.txt"), "utf8")).toBe("2\n");
    expect(await markersIn(box.root)).toEqual([]);
  });

});

describe("class A: publication writes the workspace", () => {
  const gate = { stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) } as const;
  const publish = (fixture: PrFixture, invocation = fixture.publishInvocation) => publishWorkspace({
    rootPath: fixture.root, invocation, credentialProvider: async () => ({}),
    pullRequestSink: async () => ({ number: 12, url: "https://github.com/example/demo/pull/12", reconciled: false }), ...gate,
  });
  const fixtureOf = (mode: FixtureMode, options: FixtureOptions = {}) => createPrFixture(mode, { ...options, register: (directory) => directories.push(directory) });

  it("runs no smudge filter planted right before the `git revert` of a merged pull request", async () => {
    const fixture = await fixtureOf("publish", { seedFiles: { ".gitattributes": "*.md filter=y\n" } });
    await writeFile(join(fixture.seed, "README.md"), "squashed\n", "utf8");
    await git(fixture.seed, ["add", "README.md"]);
    await commitAs(fixture.seed, "squashed feature");
    const revertCommit = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    await git(fixture.seed, ["push", "origin", "main"]);
    await withShim(fixture.root, fixture.checkout);
    plant("revert", [["filter.y.smudge", command(fixture.root, "revert")]]);
    const result = await publish(fixture, { ...fixture.publishInvocation, payload: { ...fixture.publishInvocation.payload, mode: "revert", targetPullRequestNumber: 5, revertCommit } });
    expect(result).toMatchObject({ action: "revert" });
    expect(await git(fixture.bare, ["show", `${result.commit}:README.md`])).toBe("initial\n");
    expect(await markersIn(fixture.root)).toEqual([]);
  });
});

describe("class A: maintenance writes the workspace", () => {
  const sink = () => vi.fn(async () => ({ url: "https://github.com/example/demo/pull/7", state: "open" as const, reconciled: false }));
  const fixtureOf = (options: FixtureOptions = {}) => createPrFixture("maintain", { ...options, register: (directory) => directories.push(directory) });

  it("runs no merge driver planted right before the `git merge` of the latest base into the branch (sync)", async () => {
    const fixture = await fixtureOf({ seedFiles: { ".gitattributes": "lines.txt merge=y\n", "lines.txt": "1\n2\n3\n4\n5\n6\n7\n8\n" }, headEdits: { "lines.txt": "ONE\n2\n3\n4\n5\n6\n7\n8\n" } });
    await writeFile(join(fixture.seed, "lines.txt"), "1\n2\n3\n4\n5\n6\n7\nEIGHT\n", "utf8");
    await git(fixture.seed, ["add", "lines.txt"]);
    await commitAs(fixture.seed, "base change");
    await git(fixture.seed, ["push", "origin", "main"]);
    await withShim(fixture.root, fixture.checkout);
    plant("merge", [["merge.y.driver", `touch ${join(fixture.root, "agentx-ran-merge")}; exit 0`]]);
    const invocation = { ...fixture.maintainInvocation, payload: { ...fixture.maintainInvocation.payload, action: "sync" as const } };
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => ({}), pullRequestUpdateSink: sink() });
    expect(result).toMatchObject({ action: "sync" });
    expect(await git(fixture.bare, ["show", `${result.commit}:lines.txt`])).toBe("ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n");
    expect(await markersIn(fixture.root)).toEqual([]);
  });
});

describe("a command that fails part-way leaves the workspace as it was", () => {
  it("restores the files and the index after a sync's merge conflicts (nothing from the merge stays)", async () => {
    const fixture = await createPrFixture("maintain", { register: (directory) => directories.push(directory),
      seedFiles: { "lines.txt": "1\n2\n3\n" }, headEdits: { "lines.txt": "ONE\n2\n3\n" } });
    await writeFile(join(fixture.seed, "lines.txt"), "UNO\n2\n3\n", "utf8");
    await writeFile(join(fixture.seed, "BASE-ONLY.md"), "arrived with the base\n", "utf8");
    await git(fixture.seed, ["add", "."]);
    await commitAs(fixture.seed, "base change");
    await git(fixture.seed, ["push", "origin", "main"]);
    const invocation = { ...fixture.maintainInvocation, payload: { ...fixture.maintainInvocation.payload, action: "sync" as const } };
    await expect(maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => ({}),
      pullRequestUpdateSink: vi.fn() })).rejects.toThrow(/conflicts with the latest base/);
    expect(await git(fixture.checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(await readFile(join(fixture.checkout, "lines.txt"), "utf8")).toBe("ONE\n2\n3\n");
    expect((await git(fixture.checkout, ["rev-parse", "HEAD"])).trim()).toBe(fixture.pullRequestHead);
  });
});

describe("a revert that conflicts leaves the workspace on the latest base", () => {
  it("restores the files and the index after the merged commit cannot be reverted cleanly", async () => {
    const fixture = await createPrFixture("publish", { register: (directory) => directories.push(directory), seedFiles: { "lines.txt": "1\n2\n3\n" } });
    await writeFile(join(fixture.seed, "lines.txt"), "ONE\n2\n3\n", "utf8");
    await git(fixture.seed, ["add", "lines.txt"]);
    await commitAs(fixture.seed, "the merged change");
    const revertCommit = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(fixture.seed, "lines.txt"), "UNO\n2\n3\n", "utf8");
    await writeFile(join(fixture.seed, "LATER.md"), "later\n", "utf8");
    await git(fixture.seed, ["add", "."]);
    await commitAs(fixture.seed, "a later change on the same line");
    await git(fixture.seed, ["push", "origin", "main"]);
    const latest = (await git(fixture.seed, ["rev-parse", "HEAD"])).trim();
    await expect(publishWorkspace({
      rootPath: fixture.root, credentialProvider: async () => ({}),
      invocation: { ...fixture.publishInvocation, payload: { ...fixture.publishInvocation.payload, mode: "revert", targetPullRequestNumber: 5, revertCommit } },
      pullRequestSink: async () => ({ number: 12, url: "https://github.com/example/demo/pull/12", reconciled: false }),
      stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }),
    })).rejects.toThrow(/cannot be reverted cleanly/);
    expect(await git(fixture.checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(await readFile(join(fixture.checkout, "lines.txt"), "utf8")).toBe("UNO\n2\n3\n");
    expect((await git(fixture.checkout, ["rev-parse", "HEAD"])).trim()).toBe(latest);
  });
});

