import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, rename, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { allowGitFileTransportForTests } from "../../packages/worker/src/git.js";
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
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toMatchObject({ safeToClose: true, repositories: [] });
  });

  for (const annotated of [false, true]) it(`allows cloned published ${annotated ? "annotated" : "lightweight"} tags but refuses local-only and moved tags`, async () => {
    const f = await createFixture();
    const bare = join(f.root, "remote.git");
    const tag = "release/v1";
    await git(f.checkout, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "tag", ...(annotated ? ["-a", "-m", "release"] : []), tag]);
    await git(f.checkout, ["push", "origin", `refs/tags/${tag}`]);
    const prepared = join(f.root, "prepared"), undo = allowGitFileTransportForTests();
    // Keep the production clone path and refspec; replace only its remote transport with this local fixture.
    const bin = join(f.root, "bin"); await mkdir(bin);
    const realGit = (await execFileAsync("/usr/bin/which", ["git"])).stdout.trim();
    await writeFile(join(bin, "git"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2).map((arg) => arg === "https://example.test/demo.git" ? ${JSON.stringify(pathToFileURL(bare).href)} : arg);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      await prepareWorkspace({ rootPath: prepared, project: {
        name: "payments", revision: 1, repositories: [{ name: "demo", path: "repo/demo", url: "https://example.test/demo.git", defaultBranch: "main", credentialRef: "test" }],
        setup: [], readiness: [], orchestratorInstructions: "test",
      } });
    } finally { process.env.PATH = previousPath; undo(); }
    const checkout = join(prepared, "repo/demo");
    const published = await inspectWorkspaceForClose(prepared);
    expect(published).toMatchObject({ safeToClose: true, repositories: [] });
    // Same target as a remote commit still does not publish a new tag NAME.
    await git(checkout, ["tag", "local-only"]);
    expect(await inspectWorkspaceForClose(prepared)).toMatchObject({ safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] });
    await git(checkout, ["tag", "-d", "local-only"]);
    expect(await inspectWorkspaceForClose(prepared)).toEqual(published);
    // A different tag object pointing at the SAME commit is still an unpublished move.
    await git(checkout, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "tag", "-f", "-a", "-m", "replacement", tag]);
    const moved = await inspectWorkspaceForClose(prepared);
    expect(moved).toMatchObject({ safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] });
    expect(moved.contentDigest).not.toBe(published.contentDigest);
  });

  it("reports worktree changes and untracked files without including file contents", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.checkout, "README.md"), "changed secret value\n", "utf8");
    await writeFile(join(fixture.checkout, "SECRET.txt"), "do-not-return-this\n", "utf8");
    const result = await inspectWorkspaceForClose(fixture.root);
    expect(result).toMatchObject({
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
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toMatchObject({
      safeToClose: false,
      repositories: [{ name: "demo", reasons: ["unpushed_head", "unpushed_branch"] }],
    });

    await git(fixture.checkout, ["checkout", "--detach", "origin/main"]);
    await expect(inspectWorkspaceForClose(fixture.root)).resolves.toMatchObject({
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
  it("fingerprints identical labels with different tracked, staged and untracked bytes", async () => {
    const f = await createFixture();
    const seen = new Set<string>();
    for (const [name, bytes, stage] of [["README.md", "one", false], ["README.md", "two", false], ["README.md", "two", true], ["loose", "one", false], ["loose", "two", false]] as const) {
      await writeFile(join(f.checkout, name), bytes);
      if (stage) await git(f.checkout, ["add", name]);
      const result = await inspectWorkspaceForClose(f.root);
      expect(result).toHaveProperty("contentDigest", expect.stringMatching(/^[a-f0-9]{64}$/));
      seen.add((result as typeof result & { contentDigest: string }).contentDigest);
    }
    expect(seen.size).toBe(5);
  });

  it("fingerprints branch tips, deletions, rename destinations and symlink targets", async () => {
    const f = await createFixture();
    const digests = new Set<unknown>();
    const capture = async () => { const r = await inspectWorkspaceForClose(f.root); expect(r).toHaveProperty("contentDigest"); digests.add((r as typeof r & { contentDigest: string }).contentDigest); };
    await capture();
    await git(f.checkout, ["branch", "local"]); await capture();
    await rename(join(f.checkout, "README.md"), join(f.checkout, "renamed")); await capture();
    await unlink(join(f.checkout, "renamed")); await capture();
    await symlink("first", join(f.checkout, "link")); await capture();
    await unlink(join(f.checkout, "link")); await symlink("second", join(f.checkout, "link")); await capture();
    expect(digests.size).toBe(6);
  });

  it("is deterministic and excludes ignored transient output", async () => {
    const f = await createFixture();
    await writeFile(join(f.checkout, ".gitignore"), "transient\n");
    const a = await inspectWorkspaceForClose(f.root);
    await writeFile(join(f.checkout, "transient"), "temporary output");
    expect(await inspectWorkspaceForClose(f.root)).toEqual(a);
    expect(a).toHaveProperty("contentDigest");
  });

  it("sees stashes in reasons and content identity even with a clean worktree", async () => {
    const f = await createFixture(), before = await inspectWorkspaceForClose(f.root);
    await writeFile(join(f.checkout, "README.md"), "stashed work");
    await git(f.checkout, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "stash", "push"]);
    const result = await inspectWorkspaceForClose(f.root);
    expect(result.safeToClose).toBe(false);
    expect(result.repositories).toEqual([{ name: "demo", reasons: ["worktree_changes"] }]);
    expect(result.contentDigest).not.toBe(before.contentDigest);
  });
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) it(`sees ${flag} entries in reasons and fingerprints flags and hidden bytes`, async () => {
    const f = await createFixture(), before = await inspectWorkspaceForClose(f.root);
    await git(f.checkout, ["update-index", flag, "README.md"]);
    const flagged = await inspectWorkspaceForClose(f.root);
    expect(flagged.safeToClose).toBe(false);
    expect(flagged.repositories).toEqual([{ name: "demo", reasons: ["worktree_changes"] }]);
    expect(flagged.contentDigest).not.toBe(before.contentDigest);
    await writeFile(join(f.checkout, "README.md"), "hidden work");
    expect((await inspectWorkspaceForClose(f.root)).contentDigest).not.toBe(flagged.contentDigest);
  });
  it("N1 gitignored changes neither block nor alter an authoritative plain Close preview", async () => {
    const f = await createFixture();
    await writeFile(join(f.checkout, ".gitignore"), "transient\n");
    await git(f.checkout, ["add", ".gitignore"]);
    await git(f.checkout, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "ignore transient output"]);
    await git(f.checkout, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const before = await inspectWorkspaceForClose(f.root);
    expect(before.safeToClose).toBe(true);
    await writeFile(join(f.checkout, "transient"), "ignored output");
    expect(await inspectWorkspaceForClose(f.root)).toEqual(before);
    await unlink(join(f.checkout, "transient")); await symlink("ignored-target", join(f.checkout, "transient"));
    expect(await inspectWorkspaceForClose(f.root)).toEqual(before);
  });

  it("refuses oversized content rather than certifying a partial fingerprint", async () => {
    const f = await createFixture();
    await writeFile(join(f.checkout, "large"), Buffer.alloc(1_048_577));
    await expect(inspectWorkspaceForClose(f.root)).rejects.toThrow();
  });

  it("refuses duplicate repository identities and incomplete or empty manifests", async () => {
    const f = await createFixture();
    const { readFile } = await import("node:fs/promises");
    const path = join(f.root, ".agentx/preparation-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as { repositories: unknown[]; complete: boolean };
    for (const patch of [{ repositories: [...manifest.repositories, ...manifest.repositories] }, { repositories: [] }, { repositories: [{ name: "demo", path: "repo/demo" }] }, { complete: false }]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...patch }));
      await expect(inspectWorkspaceForClose(f.root)).rejects.toThrow();
    }
  });

  it("refuses missing manifests, repositories and unsupported filesystem entries", async () => {
    const f = await createFixture();
    await rm(join(f.root, ".agentx/preparation-manifest.json"));
    await expect(inspectWorkspaceForClose(f.root)).rejects.toThrow();
    const second = await createFixture();
    await rm(second.checkout, { recursive: true });
    await expect(inspectWorkspaceForClose(second.root)).rejects.toThrow();
    const third = await createFixture();
    await execFileAsync("mkfifo", [join(third.checkout, "pipe")]);
    await expect(inspectWorkspaceForClose(third.root)).rejects.toThrow(/unsupported file type/);
  });

  it("refuses total byte and file-count overflow without returning partial findings", async () => {
    const f = await createFixture();
    for (let i = 0; i < 9; i++) await writeFile(join(f.checkout, `large-${i}`), Buffer.alloc(1_048_576));
    await expect(inspectWorkspaceForClose(f.root)).rejects.toThrow(/byte limit/);
    const second = await createFixture();
    for (let i = 0; i < 4097; i++) await writeFile(join(second.checkout, `small-${i}`), "");
    await expect(inspectWorkspaceForClose(second.root)).rejects.toThrow(/file limit/);
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
