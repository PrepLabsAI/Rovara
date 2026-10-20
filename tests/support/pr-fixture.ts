import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";

const execFileAsync = promisify(execFileCallback);

export async function git(directory: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout;
}
export const commitAs = (directory: string, message: string) => git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message]);

export type FixtureMode = "maintain" | "publish";
export type FixtureOptions = {
  /** Files in the first commit, next to README.md. */
  seedFiles?: Record<string, string>;
  /** Files the pull request's head commit edits (maintain mode), next to the FEATURE.md it adds. */
  headEdits?: Record<string, string>;
  /** The call that makes `root` and its other directories; each is removed by the caller. */
  register?: (directory: string) => void;
};

/**
 * A local bare remote, a clone of it as the workspace repository (`repo/demo`), a look-alike remote with other history (`attacker.git`) and an empty one
 * (`empty-attacker.git`), the preparation manifest, and a maintain and a publish invocation for it.
 */
export async function createPrFixture(mode: FixtureMode, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentx-pr-")));
  options.register?.(root);
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "repo", "demo");
  await git(root, ["init", "--bare", "--initial-branch=main", bare]);
  await git(root, ["init", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "initial\n", "utf8");
  for (const [name, content] of Object.entries(options.seedFiles ?? {})) await writeFile(join(seed, name), content, "utf8");
  await git(seed, ["add", "README.md", ...Object.keys(options.seedFiles ?? {})]);
  await commitAs(seed, "initial");
  await git(seed, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(seed, ["push", "origin", "main"]);
  await mkdir(join(root, "repo"), { recursive: true });
  await git(root, ["clone", "--branch", "main", pathToFileURL(bare).href, checkout]);
  const preparedCommit = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const operationId = crypto.randomUUID();
  const headBranch = `agentx/${operationId}`;
  let pullRequestHead = preparedCommit;
  if (mode === "maintain") {
    await git(checkout, ["checkout", "-b", headBranch]);
    await writeFile(join(checkout, "FEATURE.md"), "feature\n", "utf8");
    for (const [name, content] of Object.entries(options.headEdits ?? {})) await writeFile(join(checkout, name), content, "utf8");
    await git(checkout, ["add", "FEATURE.md", ...Object.keys(options.headEdits ?? {})]);
    await commitAs(checkout, "feature");
    await git(checkout, ["push", "origin", headBranch]);
    pullRequestHead = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  }
  // A look-alike remote with other history on both branches: what a redirected fetch or ls-remote would answer with.
  const attacker = join(root, "attacker.git");
  await git(root, ["clone", "--bare", pathToFileURL(bare).href, attacker]);
  const scratch = join(root, "attacker-work");
  await git(root, ["clone", pathToFileURL(attacker).href, scratch]);
  await writeFile(join(scratch, "EVIL.md"), "attacker\n", "utf8");
  await git(scratch, ["add", "EVIL.md"]);
  await commitAs(scratch, "attacker commit");
  await git(scratch, ["push", "origin", "main"]);
  if (mode === "maintain") {
    await git(scratch, ["checkout", "--quiet", "-B", headBranch, `origin/${headBranch}`]);
    await writeFile(join(scratch, "EVIL-HEAD.md"), "attacker head\n", "utf8");
    await git(scratch, ["add", "EVIL-HEAD.md"]);
    await commitAs(scratch, "attacker head commit");
    await git(scratch, ["push", "origin", headBranch]);
  }
  const emptyAttacker = join(root, "empty-attacker.git");
  await git(root, ["init", "--bare", "--initial-branch=main", emptyAttacker]);
  const remoteUrl = pathToFileURL(bare).href;
  const project = {
    name: "demo", revision: 1,
    repositories: [{ name: "demo", url: remoteUrl, path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [],
    readiness: [{ cwd: "repo/demo", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutSeconds: 10 }],
    orchestratorInstructions: "Delegate coding work.",
  };
  await mkdir(join(root, ".agentx"), { recursive: true });
  await writeFile(join(root, ".agentx", "preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "demo", projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: preparedCommit,
      resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true, updatedAt: new Date().toISOString(),
  }), "utf8");
  const base = { protocolVersion: 1, operationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), projectRevision: 1, callbackCapability: "c".repeat(64) } as const;
  const maintainInvocation: Extract<WorkerInvocation, { kind: "maintain" }> = { ...base, kind: "maintain", fence: 3, payload: {
    action: "append", project, repository: "demo", pullRequestNumber: 7, headBranch, baseBranch: "main", expectedHeadCommit: pullRequestHead, repositoryGrant: "push-grant",
  } };
  const publishInvocation: Extract<WorkerInvocation, { kind: "publish" }> = { ...base, kind: "publish", fence: 2, payload: {
    mode: "create", project, repository: "demo", title: "Publish demo change", body: "Validated by AgentX.", headBranch, repositoryGrant: "push-grant",
  } };
  return { root, bare, seed, checkout, attacker, emptyAttacker, headBranch, pullRequestHead, preparedCommit, remoteUrl, maintainInvocation, publishInvocation };
}
export type PrFixture = Awaited<ReturnType<typeof createPrFixture>>;
