import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ProjectDefinition } from "@agentx/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishWorkspaceDiff, repositoriesFingerprint } from "../../packages/worker/src/artifacts.js";
import { inspectWorkspaceForClose } from "../../packages/worker/src/close-workspace.js";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import { candidateChanges, candidateDiff } from "../../packages/worker/src/verification/diff.js";
import { gitOriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { installGitShim, type GitShim } from "../support/git-shim.js";
import { commitAs, createPrFixture, git, type FixtureMode, type FixtureOptions, type PrFixture } from "../support/pr-fixture.js";

// Classes A and B: every Git call that reads or writes a workspace repository's files, refs or index. The agent controls the repository's config and keeps
// running, so a filter, merge driver or hook it writes after the worker looked at the config (or while a call runs) must not run in any of them. Real git;
// a `git` shim plants the setting right before the command named by SHIM_ON runs, and takes it away when that command ends.
const execFileAsync = promisify(execFileCallback);
const directories: string[] = [];
let disallowFileTransport: () => void = () => undefined;
const sources = new URL("../../packages/worker/src/", import.meta.url).pathname;

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

  it("runs no filter planted right before `git diff` while publishing the workspace diff (publishWorkspaceDiff)", async () => {
    const box = await simpleWorkspace();
    await withShim(box.root, box.directory);
    await writeFile(join(box.directory, "tracked.txt"), "2\n", "utf8");
    await touchLater(join(box.directory, "tracked.txt"));
    plant("diff", [["filter.y.clean", command(box.root, "diff")]]);
    const published: string[] = [];
    const { changed } = await publishWorkspaceDiff(box.root, async (artifact) => { published.push(artifact.content); });
    expect(changed).toBe(true);
    expect(published[0]).toContain("+2");
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

  it("runs no smudge filter planted right before `git checkout-index` writes the starting files", async () => {
    const box = await agentChanges();
    plant("checkout-index", [["filter.y.smudge", command(box.root, "smudge")]]);
    const seen = await gitOriginalCode([{ directory: box.directory, commit: box.commit }]).run(() => readFile(join(box.directory, "tracked.txt"), "utf8"));
    expect(seen).toBe("1\n");
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
  const lines = "1\n2\n3\n4\n5\n6\n7\n8\n";

  it("runs no filter planted right before the `git add` that stages the workspace", async () => {
    const fixture = await fixtureOf("publish", { seedFiles: { ".gitattributes": "*.md filter=y\n" } });
    await withShim(fixture.root, fixture.checkout);
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    await touchLater(join(fixture.checkout, "README.md"));
    plant("add", [["filter.y.clean", command(fixture.root, "add")]]);
    const result = await publish(fixture);
    expect(await git(fixture.bare, ["show", `${result.commit}:README.md`])).toBe("changed\n");
    expect(await markersIn(fixture.root)).toEqual([]);
  });

  it("runs no smudge filter planted right before the `git checkout` that moves the workspace onto the commit", async () => {
    const fixture = await fixtureOf("publish", { seedFiles: { ".gitattributes": "*.md filter=y\n" } });
    await withShim(fixture.root, fixture.checkout);
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    plant("checkout", [["filter.y.smudge", command(fixture.root, "checkout")]]);
    await publish(fixture);
    expect(await markersIn(fixture.root)).toEqual([]);
  });

  it("runs no merge driver planted right before the `git merge-tree` that merges the latest base", async () => {
    const fixture = await fixtureOf("publish", { seedFiles: { ".gitattributes": "lines.txt merge=y\n", "lines.txt": lines } });
    await writeFile(join(fixture.seed, "lines.txt"), "1\n2\n3\n4\n5\n6\n7\nEIGHT\n", "utf8");
    await git(fixture.seed, ["add", "lines.txt"]);
    await commitAs(fixture.seed, "base change");
    await git(fixture.seed, ["push", "origin", "main"]);
    await withShim(fixture.root, fixture.checkout);
    await writeFile(join(fixture.checkout, "lines.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n", "utf8");
    plant("merge-tree", [["merge.y.driver", `touch ${join(fixture.root, "agentx-ran-merge")}; exit 0`]]);
    const result = await publish(fixture);
    expect(await git(fixture.bare, ["show", `${result.commit}:lines.txt`])).toBe("ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n");
    expect(await markersIn(fixture.root)).toEqual([]);
  });

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

  it("runs no filter planted right before the `git add` that stages the workspace for an append", async () => {
    const fixture = await fixtureOf({ seedFiles: { ".gitattributes": "*.md filter=y\n" } });
    await withShim(fixture.root, fixture.checkout);
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    plant("add", [["filter.y.clean", command(fixture.root, "add")]]);
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: fixture.maintainInvocation, credentialProvider: async () => ({}), pullRequestUpdateSink: sink() });
    expect(await git(fixture.bare, ["show", `${result.commit}:APPEND.md`])).toBe("review update\n");
    expect(await markersIn(fixture.root)).toEqual([]);
  });

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

describe("class A: preparation checks the resolved commit out", () => {
  it("runs no smudge filter planted right before the `git checkout --detach --force` that fills a fresh clone", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-prep-")));
    directories.push(root);
    const source = join(root, "source");
    await mkdir(source);
    await git(source, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(source, ".gitattributes"), "*.md filter=y\n", "utf8");
    await writeFile(join(source, "README.md"), "# demo\n", "utf8");
    await git(source, ["add", "."]);
    await commitAs(source, "fixture");
    const workspace = join(root, "workspace");
    const destination = join(workspace, "repo", "demo");
    await mkdir(workspace);
    await withShim(root, destination);
    plant("checkout", [["filter.y.smudge", command(root, "prepare")]]);
    const project: ProjectDefinition = {
      name: "demo", revision: 1,
      repositories: [{ name: "demo", url: "http://127.0.0.1/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "demo-readwrite" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker.",
    };
    await prepareWorkspace({
      rootPath: workspace, project,
      // As the worker clones: no checkout, so the `git checkout` after it is what writes the files.
      materializer: async (_repository, target) => { await execFileAsync("git", ["clone", "--quiet", "--no-checkout", pathToFileURL(source).href, target]); },
    });
    expect(await markersIn(root)).toEqual([]);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# demo\n");
  });
});

describe("class B: tree-only reads", () => {
  it("run in a throwaway repository, not in the workspace repository (candidateDiff, candidateChanges)", async () => {
    const box = await simpleWorkspace();
    await writeFile(join(box.directory, "tracked.txt"), "2\n", "utf8");
    await git(box.directory, ["add", "."]);
    const tree = (await git(box.directory, ["write-tree"])).trim();
    const shim = await withShim(box.root, box.directory);
    await shim.clear();
    const diff = await candidateDiff({ directory: box.directory, baseCommitSha: box.commit, treeSha: tree, maxBytes: 1_000_000 });
    expect(diff.text).toContain("+2");
    expect(await candidateChanges({ directory: box.directory, baseCommitSha: box.commit, treeSha: tree })).toHaveLength(1);
    const calls = await shim.invocations();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const own = join(box.directory, ".git");
    for (const call of calls) {
      expect(call.args, call.args.join(" ")).not.toContain("-C");
      expect(call.cwd, call.args.join(" ")).not.toBe(box.directory);
      expect(call.args.some((arg) => arg.startsWith("--git-dir=") && arg !== `--git-dir=${own}`) || call.args[0] === "init", call.args.join(" ")).toBe(true);
    }
  });
});

describe("no worker module starts Git in a workspace repository's own git directory", () => {
  async function workerSources(directory = sources): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await workerSources(path));
      else if (entry.name.endsWith(".ts")) found.push(path);
    }
    return found;
  }

  it("uses `-C <directory>` only where the repository is not a workspace's (the config probe in git.ts, the SWE-bench harness)", async () => {
    const offenders: string[] = [];
    for (const path of await workerSources()) {
      const name = relative(sources, path);
      if (name === "git.ts" || name.startsWith("swebench/")) continue;
      if ((await readFile(path, "utf8")).includes('"-C"')) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("passes no workspace directory to gitHardenedEnvironment, which reads a config once: only git-auth.ts, for worker-owned repositories", async () => {
    const offenders: string[] = [];
    for (const path of await workerSources()) {
      const name = relative(sources, path);
      if (name === "git.ts" || name === "git-auth.ts") continue;
      if ((await readFile(path, "utf8")).includes("gitHardenedEnvironment(")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
