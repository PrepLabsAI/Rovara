import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
import { maintainPullRequest } from "../../packages/worker/src/maintain-pull-request.js";
import { publishWorkspace } from "../../packages/worker/src/publish.js";
import { installGitShim, type GitShim } from "../support/git-shim.js";
import { createPrFixture, git, type FixtureMode, type PrFixture } from "../support/pr-fixture.js";

// Class C: every call that carries (or could carry) the push token. The agent controls the workspace repository's config and keeps running, so a setting it
// writes after the worker looked at the config, such as a URL rewrite, must not redirect the call or reach the process that holds the token. Real git, local
// bare repositories as remotes (file transport through the worker's test seam), a `git` shim that plants the setting right before the command runs.
const execFileAsync = promisify(execFileCallback);
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
const markersIn = async (directory: string) => (await readdir(directory)).filter((name) => name.startsWith("agentx-ran-"));

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

  it("pushes to the registered URL even when a push rewrite appears right before the push (maintain)", async () => {
    const fixture = await createFixture("maintain");
    await withShim(fixture);
    await writeFile(join(fixture.checkout, "APPEND.md"), "review update\n", "utf8");
    plant("push", [[`url.${pathToFileURL(fixture.emptyAttacker).href}.pushInsteadOf`, fixture.remoteUrl], ["remote.origin.pushurl", pathToFileURL(fixture.emptyAttacker).href]]);
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation: fixture.maintainInvocation, credentialProvider: async () => token, pullRequestUpdateSink: sink() });
    expect((await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim()).toBe(result.commit);
    expect(await git(fixture.emptyAttacker, ["for-each-ref"])).toBe("");
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

  it("starts every credentialed git process outside the workspace repository's git directory", async () => {
    const fixture = await createFixture("maintain");
    const shim = await withShim(fixture);
    await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
    const reviewedTree = await workspaceTree(fixture.checkout);
    await shim.clear();
    const invocation = { ...fixture.maintainInvocation, payload: { ...fixture.maintainInvocation.payload, workflowCandidateTreeSha: reviewedTree, workflowBaseCommit: fixture.preparedCommit } } as typeof fixture.maintainInvocation;
    await maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => token, pullRequestUpdateSink: sink(),
      stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) });
    const credentialed = (await shim.invocations()).filter((call) => call.askpass);
    expect(credentialed.map((call) => call.args.find((arg) => ["fetch", "push", "ls-remote"].includes(arg))).sort()).toEqual(["fetch", "ls-remote", "push"]);
    const own = join(fixture.checkout, ".git");
    for (const call of credentialed) {
      expect(call.args, call.args.join(" ")).not.toContain("-C");
      expect(call.cwd, call.args.join(" ")).not.toBe(fixture.checkout);
      expect(call.gitDir).not.toBe(own);
      expect(call.args.some((arg) => arg.startsWith("--git-dir=") && arg !== `--git-dir=${own}`), call.args.join(" ")).toBe(true);
    }
  });

  it("runs no planted helper, ssh command, proxy or include while it fetches, pushes and asks", async () => {
    const fixture = await createFixture("maintain");
    const marker = join(fixture.root, `agentx-ran-${crypto.randomUUID()}`);
    // The reviewed tree is computed before the settings are planted: this test's own git would run the planted fsmonitor.
    await writeFile(join(fixture.checkout, "FIX.md"), "address feedback\n", "utf8");
    const reviewedTree = await workspaceTree(fixture.checkout);
    const helper = join(fixture.root, "helper.sh");
    await writeFile(helper, `#!/bin/sh\ntouch '${marker}.helper'\n`);
    await chmod(helper, 0o755);
    await writeFile(join(fixture.root, "included.cfg"), `[credential]\n\thelper = "${helper}"\n[core]\n\tsshCommand = "${helper}"\n`);
    for (const [key, value] of [["credential.helper", helper], ["core.sshCommand", helper], ["core.askPass", helper], ["include.path", join(fixture.root, "included.cfg")], ["core.fsmonitor", helper]] as const) {
      await execFileAsync("git", ["config", "--file", join(fixture.checkout, ".git", "config"), key, value]);
    }
    const invocation = { ...fixture.maintainInvocation, payload: { ...fixture.maintainInvocation.payload, workflowCandidateTreeSha: reviewedTree, workflowBaseCommit: fixture.preparedCommit } } as typeof fixture.maintainInvocation;
    const result = await maintainPullRequest({ rootPath: fixture.root, invocation, credentialProvider: async () => token, pullRequestUpdateSink: sink(),
      stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) });
    expect((await git(fixture.bare, ["rev-parse", `refs/heads/${fixture.headBranch}`])).trim()).toBe(result.commit);
    expect(await markersIn(fixture.root)).toEqual([]);
  });
});
