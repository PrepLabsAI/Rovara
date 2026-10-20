import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessCandidateGit, enforceApprovedBuildSource, stageCandidateSource } from "../../packages/worker/src/e2e-candidate-source.js";
import { runWithConcurrency } from "../../packages/worker/src/bounded-concurrency.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function repository(files: Record<string, string>, executable: string[] = []) {
  const root = await temp("candidate-repo-");
  git(root, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    if (executable.includes(path)) await chmod(join(root, path), 0o755);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "candidate");
  return { root, commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}
type Manifest = Parameters<typeof enforceApprovedBuildSource>[1];
const manifestFor = (files: Record<string, string>, executable: string[] = [], omissions: Manifest["omissions"] = []): Manifest => ({
  files: Object.entries(files).map(([path, content]) => ({ path, mode: executable.includes(path) ? "100755" : "100644", sha256: sha256(Buffer.from(content)) })), omissions });

describe("candidate git", () => {
  it("reads the tree of a commit and extracts exactly that commit, not the working tree", async () => {
    const files = { "package.json": "{\"name\":\"app\"}", "src/server.js": "console.log(1)", "bin/run.sh": "#!/bin/sh\n" };
    const repo = await repository(files, ["bin/run.sh"]);
    await writeFile(join(repo.root, "src/server.js"), "console.log('uncommitted edit')");
    await writeFile(join(repo.root, "untracked.txt"), "never committed");
    const candidate = createProcessCandidateGit();
    const signal = new AbortController().signal;
    expect(await candidate.treeOf(repo.root, repo.commit, signal)).toBe(repo.tree);

    const destination = await temp("candidate-stage-");
    await candidate.archiveInto(repo.root, repo.commit, destination, signal);
    expect(await readFile(join(destination, "src/server.js"), "utf8")).toBe("console.log(1)");
    expect(await lstat(join(destination, "untracked.txt")).then(() => true, () => false)).toBe(false);
    expect((await lstat(join(destination, "bin/run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("rejects a commit the repository does not have and a non-hex answer", async () => {
    const repo = await repository({ "package.json": "{}" });
    const candidate = createProcessCandidateGit();
    await expect(candidate.treeOf(repo.root, "0".repeat(40), new AbortController().signal)).rejects.toThrow();
    await expect(candidate.archiveInto(repo.root, "0".repeat(40), await temp("candidate-stage-"), new AbortController().signal)).rejects.toThrow();
  });

  it("stops git when the operation is aborted", async () => {
    const repo = await repository({ "package.json": "{}" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createProcessCandidateGit().treeOf(repo.root, repo.commit, controller.signal)).rejects.toThrow();
  });
});

describe("approved build source enforcement", () => {
  const files = { "package.json": "{}", "src/a.js": "a", "bin/run.sh": "#!/bin/sh\n" };

  async function staged(extra?: (dir: string) => Promise<void>) {
    const dir = await temp("staged-");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await chmod(join(dir, "bin/run.sh"), 0o755);
    await extra?.(dir);
    return dir;
  }

  it("accepts exactly the manifest's files, with their executable bits", async () => {
    await expect(enforceApprovedBuildSource(await staged(), manifestFor(files, ["bin/run.sh"]))).resolves.toBeUndefined();
  });

  it("removes explicitly omitted symlinks and blocked paths and then accepts the tree", async () => {
    const dir = await staged(async (root) => { await symlink("/etc/passwd", join(root, "link")); await mkdir(join(root, ".env.d")); await writeFile(join(root, ".env.d/x"), "secret"); });
    await enforceApprovedBuildSource(dir, manifestFor(files, ["bin/run.sh"], [{ path: "link" }, { path: ".env.d" }]));
    expect(await lstat(join(dir, "link")).then(() => true, () => false)).toBe(false);
    expect(await lstat(join(dir, ".env.d")).then(() => true, () => false)).toBe(false);
  });

  it.each([
    ["an extra file", async (dir: string) => { await writeFile(join(dir, "extra.js"), "x"); }],
    ["a changed file", async (dir: string) => { await writeFile(join(dir, "src/a.js"), "changed"); }],
    ["a missing file", async (dir: string) => { await rm(join(dir, "src/a.js")); }],
    ["a symlink the manifest does not omit", async (dir: string) => { await symlink("package.json", join(dir, "alias")); }],
    ["a changed executable bit", async (dir: string) => { await chmod(join(dir, "bin/run.sh"), 0o644); }],
  ])("refuses %s", async (_name, change) => {
    const dir = await staged(change);
    await expect(enforceApprovedBuildSource(dir, manifestFor(files, ["bin/run.sh"]))).rejects.toThrow(/approved build source/);
  });
});

describe("stageCandidateSource", () => {
  it("checks the tree before it creates anything", async () => {
    const repo = await repository({ "package.json": "{}" });
    const parent = await temp("stage-parent-");
    const destination = join(parent, "candidate");
    await expect(stageCandidateSource({ git: createProcessCandidateGit(), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: "e".repeat(40),
      destination, manifests: [manifestFor({ "package.json": "{}" })], signal: new AbortController().signal })).rejects.toThrow("candidate tree does not match admission");
    expect(await lstat(destination).then(() => true, () => false)).toBe(false);
  });

  it("extracts the real commit into a fresh directory that passes the manifest", async () => {
    const files = { "package.json": "{\"name\":\"app\"}", "src/server.js": "x" };
    const repo = await repository(files);
    const parent = await temp("stage-parent-");
    const destination = join(parent, "candidate");
    await stageCandidateSource({ git: createProcessCandidateGit(), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: repo.tree,
      destination, manifests: [manifestFor(files)], signal: new AbortController().signal });
    expect(await readFile(join(destination, "src/server.js"), "utf8")).toBe("x");
    expect((await lstat(destination)).mode & 0o755).toBe(0o755);
  });
});

describe("runWithConcurrency", () => {
  it("never runs more than the limit at once and returns results in order", async () => {
    let live = 0; let peak = 0;
    const results = await runWithConcurrency(7, 2, async (index) => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5 + (index % 3) * 3));
      live -= 1;
      return index * 10;
    }, () => undefined);
    expect(peak).toBe(2);
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("starts nothing new after a failure, lets the running ones settle and rethrows the first error", async () => {
    const started: number[] = []; const settled: number[] = [];
    const failures: unknown[] = [];
    await expect(runWithConcurrency(6, 2, async (index) => {
      started.push(index);
      // Group 1 fails while group 0 is still running; the failure, not a free slot, is what must stop group 2 from starting.
      await new Promise((resolve) => setTimeout(resolve, index === 1 ? 5 : 40));
      settled.push(index);
      if (index === 1) throw new Error("group 1 failed");
      return index;
    }, (error) => failures.push(error))).rejects.toThrow("group 1 failed");
    expect(started).toEqual([0, 1]);
    expect(settled.sort()).toEqual([0, 1]);
    expect(failures).toHaveLength(1);
  });
});
