import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import { installGitShim, type GitShim } from "../support/git-shim.js";
import { createPrFixture, git, type FixtureMode, type PrFixture } from "../support/pr-fixture.js";

const directories: string[] = [];
let disallowFileTransport: () => void = () => undefined;

beforeEach(async () => {
  disallowFileTransport = allowGitFileTransportForTests();
  const home = await mkdtemp(join(tmpdir(), "agentx-net-home-"));
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

const createFixture = (mode: FixtureMode) => createPrFixture(mode, { register: (directory) => directories.push(directory) });
type Fixture = PrFixture;

async function withShim(fixture: Fixture): Promise<GitShim> {
  const shim = await installGitShim(fixture.root);
  for (const [name, value] of Object.entries(shim.environment)) vi.stubEnv(name, value);
  vi.stubEnv("SHIM_CANDIDATE", fixture.checkout);
  return shim;
}
function plant(on: string, entries: ReadonlyArray<readonly [string, string]>): void {
  vi.stubEnv("SHIM_ON", on);
  // The setting is there for that one call only, as a background process's write would be, so the call after it is not refused for it.
  vi.stubEnv("SHIM_RESTORE", "1");
  vi.stubEnv("SHIM_CONFIG_SET", entries.map(([key, value]) => `${key}=${value}`).join("\n"));
}

const sink = () => vi.fn(async () => ({ url: "https://github.com/example/demo/pull/7", state: "open" as const, reconciled: false }));
const token = { token: "push-token" };

async function workspaceTree(directory: string): Promise<string> {
  await git(directory, ["add", "--all"]);
  const tree = (await git(directory, ["write-tree"])).trim();
  await git(directory, ["reset", "--quiet"]);
  return tree;
}

describe("class C: token-carrying git calls never read the workspace repository's config", () => {
  it("fetches from the registered URL even when a URL rewrite appears right before the fetch (maintain)", async () => {
    const fixture = await createFixture("maintain");
    await withShim(fixture);
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    plant("fetch", [[`url.${pathToFileURL(fixture.attacker).href}.insteadOf`, fixture.remoteUrl]]);
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: fixture.maintainInvocation, credentialProvider: async () => token, pullRequestUpdateSink: sink() });
    expect(result).toMatchObject({ action: "append", previousCommit: fixture.pullRequestHead });
    expect((await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim()).toBe(result.commit);
  });

  it("asks the registered URL for the branch right before the push even when a rewrite appears right before the ls-remote (maintain, reviewed fix)", async () => {
    const fixture = await createFixture("maintain");
    await withShim(fixture);
    await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
    const reviewedTree = await workspaceTree(fixture.checkout);
    plant("ls-remote", [[`url.${pathToFileURL(fixture.attacker).href}.insteadOf`, fixture.remoteUrl]]);
    const invocation = { ...fixture.maintainInvocation, payload: { ...fixture.maintainInvocation.payload, workflowCandidateTreeSha: reviewedTree, workflowBaseCommit: fixture.preparedCommit } } as typeof fixture.maintainInvocation;
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => token, pullRequestUpdateSink: sink(),
      stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) });
    expect((await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim()).toBe(result.commit);
  });

  it("fetches the latest base from the registered URL even when a URL rewrite appears right before the fetch (publish)", async () => {
    const fixture = await createFixture("publish");
    await withShim(fixture);
    await writeFile(join(fixture.checkout, "README.md"), "changed\n", "utf8");
    plant("fetch", [[`url.${pathToFileURL(fixture.attacker).href}.insteadOf`, fixture.remoteUrl]]);
    const result = await publishWorkspace({ rootPath: fixture.root, invocation: fixture.publishInvocation, credentialProvider: async () => token,
      pullRequestSink: async () => ({ number: 12, url: "https://github.com/example/demo/pull/12", reconciled: false }),
      stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) });
    const parents = (await git(fixture.bare, ["rev-list", "--parents", "-n", "1", result.commit])).trim().split(" ");
    expect(parents.slice(1)).toEqual([fixture.preparedCommit]);
  });

});
