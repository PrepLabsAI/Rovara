import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectWorkspaceForClose } from "../../packages/worker/src/close-workspace.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace close preflight", () => {
  it("redacts a Git error before it is cut (#170 review)", async () => {
    const token = `ghp_${"C1l2O3s4E5".repeat(4)}`;
    const fixture = await createFixture();
    // A stand-in git, first on PATH, fails with a token that the 16 KiB cut would split, so the
    // test does not depend on what the machine's own git prints.
    const bin = await mkdtemp(join(tmpdir(), "agentx-fake-git-"));
    temporaryDirectories.push(bin);
    const filler = 16_384 + 20 - token.length - 1 - "\nfatal: bad object\n".length;
    await writeFile(join(bin, "git"), [
      "#!/bin/sh",
      `printf '%s\\n' '${token}' >&2`,
      `head -c ${filler} /dev/zero | tr '\\0' r >&2`,
      "printf '\\nfatal: bad object\\n' >&2",
      "exit 128",
      "",
    ].join("\n"), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    let failure: Error | undefined;
    try {
      failure = await inspectWorkspaceForClose(fixture.root).then(() => undefined, (error: unknown) => error as Error);
    } finally {
      process.env.PATH = path;
    }
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).toMatch(/fatal: bad object\n?$/);
    expect(failure?.message).not.toContain(token.slice(-16));
    expect(failure?.message).not.toContain(token.slice(4));
  });

  it("allows a clean workspace whose commits are reachable from a remote", async () => {
    const fixture = await createFixture();
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toEqual({ safeToClose: true, repositories: [] });
  });

  it("reports worktree changes and untracked files without including file contents", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed secret value\n", "utf8");
    await writeFile(join(fixture.checkout, "SECRET.txt"), "do-not-return-this\n", "utf8");
    const result = await inspectWorkspaceForClose(fixture.root);
    expect(result).toEqual({
      safeToClose: false,
      repositories: [{ name: "demo", reasons: ["worktree_changes", "untracked_files"] }],
    });
    expect(JSON.stringify(result)).not.toContain("do-not-return-this");
  });

  it("reports an unpushed HEAD and a local branch with commits absent from all remotes", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "LOCAL.md"), "local\n", "utf8");
    await git(fixture.checkout, ["add", "LOCAL.md"]);
    await git(fixture.checkout, ["-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "-m", "local"]);
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toEqual({
      safeToClose: false,
      repositories: [{ name: "demo", reasons: ["unpushed_head", "unpushed_branch"] }],
    });

    await git(fixture.checkout, ["checkout", "--detach", "origin/main"]);
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toEqual({
      safeToClose: false,
      repositories: [{ name: "demo", reasons: ["unpushed_branch"] }],
    });
  });

  it("rejects a repository path that resolves outside the workspace", async () => {
    const fixture = await createFixture();
    const manifest = {
      schemaVersion: 2,
      projectName: "payments",
      projectRevision: 1,
      repositories: [{ name: "demo", path: "../outside", defaultBranch: "main", resolvedCommit: "a".repeat(40), resolvedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true, updatedAt: new Date().toISOString(),
    };
    await writeFile(join(fixture.root, ".agentx/preparation-manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(inspectWorkspaceForClose(fixture.root)).rejects.toThrow(/escapes the workspace root/);
  });
});

async function createFixture(): Promise<{ root: string; checkout: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentx-close-"));
  temporaryDirectories.push(root);
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "repo/demo");
  await git(root, ["init", "--bare", bare]);
  await git(root, ["init", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "initial\n", "utf8");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(seed, ["remote", "add", "origin", bare]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await mkdir(join(root, "repo"), { recursive: true });
  await git(root, ["clone", "--branch", "main", bare, checkout]);
  const commit = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(root, ".agentx"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(root, ".agentx/preparation-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    projectName: "payments",
    projectRevision: 1,
    repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: commit, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "test", complete: true, updatedAt: now,
  })}\n`, "utf8");
  return { root, checkout };
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...args], { encoding: "utf8" });
  return result.stdout;
}
