import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admittedRepositoryOf, assertBuildSourceBelongsToCandidate, candidateGitEnvironment, createProcessCandidateGit, enforceApprovedBuildSource, removeWithoutFollowing,
  stageCandidateSource } from "../../packages/worker/src/e2e-candidate-source.js";
import { utf8Tail } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { runWithConcurrency } from "../../packages/worker/src/bounded-concurrency.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string) { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); roots.push(dir); return dir; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.safecrlf=false", "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const processGit = async () => createProcessCandidateGit(await temp("git-scratch-"));
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
    const candidate = (await processGit());
    const signal = new AbortController().signal;
    expect(await candidate.treeOf(repo.root, repo.commit, signal)).toBe(repo.tree);

    const destination = await temp("candidate-stage-");
    await candidate.materializeInto(repo.root, repo.commit, destination, signal);
    expect(await readFile(join(destination, "src/server.js"), "utf8")).toBe("console.log(1)");
    expect(await lstat(join(destination, "untracked.txt")).then(() => true, () => false)).toBe(false);
    expect((await lstat(join(destination, "bin/run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("rejects a commit the repository does not have and a non-hex answer", async () => {
    const repo = await repository({ "package.json": "{}" });
    const candidate = (await processGit());
    await expect(candidate.treeOf(repo.root, "0".repeat(40), new AbortController().signal)).rejects.toThrow();
    await expect(candidate.materializeInto(repo.root, "0".repeat(40), await temp("candidate-stage-"), new AbortController().signal)).rejects.toThrow();
  });

  it("stops git when the operation is aborted", async () => {
    const repo = await repository({ "package.json": "{}" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect((await processGit()).treeOf(repo.root, repo.commit, controller.signal)).rejects.toThrow();
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
    await enforceApprovedBuildSource(dir, manifestFor(files, ["bin/run.sh"], [{ path: "link", mode: "120000" }, { path: ".env.d", mode: "100644" }]));
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
    await expect(stageCandidateSource({ git: (await processGit()), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: "e".repeat(40),
      destination, manifests: [manifestFor({ "package.json": "{}" })], signal: new AbortController().signal })).rejects.toThrow("candidate tree does not match admission");
    expect(await lstat(destination).then(() => true, () => false)).toBe(false);
  });

  it("extracts the real commit into a fresh directory that passes the manifest", async () => {
    const files = { "package.json": "{\"name\":\"app\"}", "src/server.js": "x" };
    const repo = await repository(files);
    const parent = await temp("stage-parent-");
    const destination = join(parent, "candidate");
    await stageCandidateSource({ git: (await processGit()), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: repo.tree,
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

describe("git runs without trusting the repository or the process environment", () => {
  it("ignores replace refs: the tree and the extracted files are the commit's own", async () => {
    const repo = await repository({ "package.json": "{\"name\":\"real\"}" });
    await writeFile(join(repo.root, "package.json"), "{\"name\":\"swapped\"}");
    git(repo.root, "commit", "-q", "-a", "-m", "other");
    const other = git(repo.root, "rev-parse", "HEAD");
    const otherTree = git(repo.root, "rev-parse", "HEAD^{tree}");
    git(repo.root, "replace", repo.commit, other);
    // Plain git is fooled by the replace ref; that is the attack.
    expect(git(repo.root, "rev-parse", `${repo.commit}^{tree}`)).toBe(otherTree);
    const candidate = (await processGit());
    const signal = new AbortController().signal;
    expect(await candidate.treeOf(repo.root, repo.commit, signal)).toBe(repo.tree);
    const destination = await temp("candidate-stage-");
    await candidate.materializeInto(repo.root, repo.commit, destination, signal);
    expect(await readFile(join(destination, "package.json"), "utf8")).toBe("{\"name\":\"real\"}");
  });

  it("gives git no home, no system or global config and no replace objects", () => {
    const environment = candidateGitEnvironment();
    expect(environment).toMatchObject({ GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
    expect(environment).not.toHaveProperty("HOME");
    expect(Object.keys(environment).filter((name) => /^(?:AWS_|AGENTX_|PI_)/.test(name))).toEqual([]);
  });
});

describe("removal that never follows a symlink", () => {
  async function stageWithOutside() {
    const staged = await temp("staged-");
    const outside = await temp("outside-");
    await writeFile(join(outside, ".env"), "must survive");
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "keep"), "must survive");
    return { staged, outside };
  }

  it("refuses a nested omission whose parent folder is a symlink, and deletes nothing outside staging", async () => {
    const { staged, outside } = await stageWithOutside();
    await symlink(outside, join(staged, "config"));
    await expect(removeWithoutFollowing(staged, "config/.env")).rejects.toThrow(/approved build source/);
    await expect(enforceApprovedBuildSource(staged, { files: [], omissions: [{ path: "config/.env", mode: "100644" }, { path: "config/nested", mode: "100644" }] })).rejects.toThrow(/approved build source/);
    expect(await readFile(join(outside, ".env"), "utf8")).toBe("must survive");
    expect(await readFile(join(outside, "nested", "keep"), "utf8")).toBe("must survive");
  });

  it("refuses a symlink anywhere along a deeper path too", async () => {
    const { staged, outside } = await stageWithOutside();
    await mkdir(join(staged, "a"));
    await symlink(outside, join(staged, "a", "b"));
    await expect(removeWithoutFollowing(staged, "a/b/nested/keep")).rejects.toThrow(/approved build source/);
    expect(await readFile(join(outside, "nested", "keep"), "utf8")).toBe("must survive");
  });

  it("removes a symlink leaf itself, never its target, and a real directory tree", async () => {
    const { staged, outside } = await stageWithOutside();
    await symlink(outside, join(staged, "link"));
    await mkdir(join(staged, "blocked", "inner"), { recursive: true });
    await writeFile(join(staged, "blocked", "inner", "x"), "x");
    await removeWithoutFollowing(staged, "link");
    await removeWithoutFollowing(staged, "blocked");
    expect(await readdir(staged)).toEqual([]);
    expect(await readFile(join(outside, ".env"), "utf8")).toBe("must survive");
  });

  it("treats a missing path as already removed and refuses unsafe paths", async () => {
    const { staged } = await stageWithOutside();
    await expect(removeWithoutFollowing(staged, "nope/deeper")).resolves.toBeUndefined();
    for (const path of ["", "/etc", "../x", "a/../b", "a//b", "./a"]) await expect(removeWithoutFollowing(staged, path)).rejects.toThrow(/unsafe/);
  });
});

describe("a staging directory left behind by a crash", () => {
  it("is removed, never followed, and recreated from the commit", async () => {
    const files = { "package.json": "{\"name\":\"app\"}" };
    const repo = await repository(files);
    const parent = await temp("stage-parent-");
    const outside = await temp("outside-");
    await writeFile(join(outside, "keep"), "must survive");
    const destination = join(parent, "candidate-round");
    await mkdir(destination);
    await writeFile(join(destination, "stale.js"), "left by the crashed attempt");
    await symlink(outside, join(destination, "escape"));
    await stageCandidateSource({ git: (await processGit()), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: repo.tree,
      destination, manifests: [manifestFor(files)], signal: new AbortController().signal });
    expect(await readdir(destination)).toEqual(["package.json"]);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("must survive");
  });

  it("removes a leftover that is itself a symlink without touching its target", async () => {
    const files = { "package.json": "{}" };
    const repo = await repository(files);
    const parent = await temp("stage-parent-");
    const outside = await temp("outside-");
    await writeFile(join(outside, "keep"), "must survive");
    const destination = join(parent, "candidate-round");
    await symlink(outside, destination);
    await stageCandidateSource({ git: (await processGit()), repositoryRoot: repo.root, commitSha: repo.commit, treeSha: repo.tree,
      destination, manifests: [manifestFor(files)], signal: new AbortController().signal });
    expect((await lstat(destination)).isDirectory()).toBe(true);
    expect(await readdir(outside)).toEqual(["keep"]);
  });
});

describe("the admitted candidate repository", () => {
  const commitSha = "a".repeat(40); const treeSha = "b".repeat(40);
  const one = { repositories: [{ repositoryId: "acme/app", commitSha, treeSha }] };

  it("is the one repository whose commit and tree the admission names", () => {
    expect(admittedRepositoryOf(one, commitSha, treeSha)).toBe("acme/app");
  });

  it.each([
    ["none", { repositories: [] }, commitSha, treeSha],
    ["two", { repositories: [one.repositories[0]!, { repositoryId: "acme/other", commitSha, treeSha }] }, commitSha, treeSha],
    ["another commit", one, "c".repeat(40), treeSha],
    ["another tree", one, commitSha, "c".repeat(40)],
  ])("refuses %s", (_name, candidate, commit, tree) => {
    expect(() => admittedRepositoryOf(candidate, commit, tree)).toThrow(/candidate repository/);
  });

  it("holds every build source manifest to the admitted repository, commit and tree", () => {
    const manifest = (overrides: Record<string, string> = {}) => ({ repository: { repositoryId: "acme/app", commitSha, treeSha, ...overrides }, files: [], omissions: [] });
    expect(() => assertBuildSourceBelongsToCandidate([manifest()], { repositoryId: "acme/app", commitSha, treeSha })).not.toThrow();
    for (const override of [{ repositoryId: "acme/other" }, { commitSha: "c".repeat(40) }, { treeSha: "c".repeat(40) }]) {
      expect(() => assertBuildSourceBelongsToCandidate([manifest(), manifest(override)], { repositoryId: "acme/app", commitSha, treeSha })).toThrow(/build source.*admitted candidate/);
    }
  });
});

describe("utf8Tail", () => {
  it("keeps at most the byte budget and never starts inside a character", () => {
    const text = "é".repeat(100) + "tail-é";
    for (const max of [7, 8, 9, 50, 51]) {
      const kept = utf8Tail(text, max);
      expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(max);
      expect(kept).not.toContain("\uFFFD");
      expect(text.endsWith(kept)).toBe(true);
    }
    expect(utf8Tail("short", 100)).toBe("short");
    expect(utf8Tail("😀😀😀", 5)).toBe("😀");
  });
});

/** A repository the candidate's own code has booby-trapped: every command here would create a marker file if git ever ran it. */
async function boobyTrapped(options: { tree?: Record<string, string | Buffer>; infoAttributes?: string } = {}) {
  const root = await temp("candidate-trapped-");
  const markers = await temp("markers-");
  const marker = (name: string) => join(markers, name);
  git(root, "init", "-q");
  const tree: Record<string, string | Buffer> = options.tree ?? { "a.txt": "hello\n" };
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "candidate");
  const touch = (name: string) => `sh -c 'touch ${marker(name)}; cat'`;
  git(root, "config", "filter.x.smudge", touch("smudge"));
  git(root, "config", "filter.x.clean", touch("clean"));
  git(root, "config", "filter.x.process", touch("process"));
  git(root, "config", "core.fsmonitor", `sh -c 'touch ${marker("fsmonitor")}'`);
  git(root, "config", "core.pager", touch("pager"));
  git(root, "config", "core.attributesFile", join(root, "elsewhere-attributes"));
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-auto-gc", "post-index-change"]) {
    await writeFile(join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker(hook)}\n`, { mode: 0o755 });
  }
  git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
  appendFileSync(join(root, ".git", "info", "attributes"), options.infoAttributes ?? "* filter=x\n* export-subst\n");
  return { root, marker, markers, commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}
const markersLeft = (markers: string) => readdir(markers);

describe("the candidate repository is never run as a repository", () => {
  it("never runs a repo-local filter, fsmonitor, pager or hook, in .git/config or .git/info/attributes", async () => {
    const trap = await boobyTrapped();
    const scratch = await temp("git-scratch-");
    const candidate = createProcessCandidateGit(scratch);
    const signal = new AbortController().signal;
    expect(await candidate.treeOf(trap.root, trap.commit, signal)).toBe(trap.tree);
    const destination = await temp("candidate-stage-");
    await candidate.materializeInto(trap.root, trap.commit, destination, signal);
    expect(await markersLeft(trap.markers)).toEqual([]);
    expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("applies no in-tree filter or export-subst either: the files are the blobs", async () => {
    const trap = await boobyTrapped({ infoAttributes: "# nothing here\n", tree: {
      ".gitattributes": "* filter=x\n*.txt export-subst\n*.txt text eol=crlf\n",
      "version.txt": "commit $Format:%H$ and $Format:%an$\n", "unix.txt": "line one\nline two\n" } });
    const candidate = createProcessCandidateGit(await temp("git-scratch-"));
    const destination = await temp("candidate-stage-");
    await candidate.materializeInto(trap.root, trap.commit, destination, new AbortController().signal);
    expect(await markersLeft(trap.markers)).toEqual([]);
    expect(await readFile(join(destination, "version.txt"), "utf8")).toBe("commit $Format:%H$ and $Format:%an$\n");
    expect(await readFile(join(destination, "unix.txt"), "utf8")).toBe("line one\nline two\n");
  });

  it("stages the commit's blobs byte for byte, with modes and awkward names", async () => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10, 13, 10, 0]);
    const big = Buffer.alloc(1_500_000, "abc\r\n");
    const tree: Record<string, string | Buffer> = { "bin/blob.dat": binary, "empty.txt": "", "crlf.txt": "a\r\nb\r\n", "-dash.js": "x", "dir with space/\u00e9t\u00e9.txt": "ok",
      "deep/a/b/c/d.txt": "deep", "big.bin": big, "run.sh": "#!/bin/sh\n" };
    const repo = await repository(Object.fromEntries(Object.entries(tree).map(([path, content]) => [path, content.toString("latin1")])), []);
    // Rewrite with exact bytes (the helper above takes strings): commit a second state with the binary files.
    for (const [path, content] of Object.entries(tree)) { await mkdir(dirname(join(repo.root, path)), { recursive: true }); await writeFile(join(repo.root, path), content); }
    await chmod(join(repo.root, "run.sh"), 0o755);
    git(repo.root, "add", "-A"); git(repo.root, "commit", "-q", "-m", "exact bytes");
    const commit = git(repo.root, "rev-parse", "HEAD");
    const candidate = createProcessCandidateGit(await temp("git-scratch-"));
    const destination = await temp("candidate-stage-");
    const skipped = await candidate.materializeInto(repo.root, commit, destination, new AbortController().signal);
    expect(skipped).toEqual([]);
    for (const [path, content] of Object.entries(tree)) expect(Buffer.compare(await readFile(join(destination, path)), Buffer.from(content)), path).toBe(0);
    expect((await lstat(join(destination, "run.sh"))).mode & 0o111).not.toBe(0);
    expect((await lstat(join(destination, "big.bin"))).mode & 0o111).toBe(0);
    expect((await lstat(join(destination, "bin/blob.dat"))).mode & 0o022).toBe(0);
  });

  it("leaves no throwaway repository behind, on success or on failure, and never writes into the candidate's git directory", async () => {
    const trap = await boobyTrapped();
    const scratch = await temp("git-scratch-");
    const candidate = createProcessCandidateGit(scratch);
    const signal = new AbortController().signal;
    const before = (await readdir(join(trap.root, ".git"))).sort();
    await candidate.treeOf(trap.root, trap.commit, signal);
    await candidate.materializeInto(trap.root, trap.commit, await temp("candidate-stage-"), signal);
    await expect(candidate.treeOf(trap.root, "0".repeat(40), signal)).rejects.toThrow();
    await expect(candidate.materializeInto(trap.root, "0".repeat(40), await temp("candidate-stage-"), signal)).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await expect(candidate.materializeInto(trap.root, trap.commit, await temp("candidate-stage-"), aborted.signal)).rejects.toThrow();
    expect(await readdir(scratch)).toEqual([]);
    expect((await readdir(join(trap.root, ".git"))).sort()).toEqual(before);
  });

  it("refuses a candidate whose .git or objects directory is a symlink or not a directory", async () => {
    const repo = await repository({ "package.json": "{}" });
    const scratch = await temp("git-scratch-");
    const candidate = createProcessCandidateGit(scratch);
    const signal = new AbortController().signal;
    const elsewhere = await temp("elsewhere-");
    await rm(join(elsewhere, "x"), { force: true });
    const linkedGit = await temp("linked-git-");
    await symlink(join(repo.root, ".git"), join(linkedGit, ".git"));
    await expect(candidate.treeOf(linkedGit, repo.commit, signal)).rejects.toThrow(/candidate repository/);
    const fileGit = await temp("file-git-");
    await writeFile(join(fileGit, ".git"), `gitdir: ${join(repo.root, ".git")}\n`);
    await expect(candidate.treeOf(fileGit, repo.commit, signal)).rejects.toThrow(/candidate repository/);
    const linkedObjects = await temp("linked-objects-");
    await mkdir(join(linkedObjects, ".git"));
    await symlink(join(repo.root, ".git", "objects"), join(linkedObjects, ".git", "objects"));
    await expect(candidate.treeOf(linkedObjects, repo.commit, signal)).rejects.toThrow(/candidate repository/);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("skips symlinks and submodules only where the approved build source omits them, and refuses them otherwise", async () => {
    const files = { "package.json": "{}", "src/a.js": "a" };
    const repo = await repository(files);
    await symlink("/etc/passwd", join(repo.root, "passwd-link"));
    git(repo.root, "add", "passwd-link");
    git(repo.root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendored`);
    git(repo.root, "commit", "-q", "-m", "link and gitlink");
    const commit = git(repo.root, "rev-parse", "HEAD"); const tree = git(repo.root, "rev-parse", "HEAD^{tree}");
    const candidate = createProcessCandidateGit(await temp("git-scratch-"));
    const signal = new AbortController().signal;
    const skipped = await candidate.materializeInto(repo.root, commit, await temp("candidate-stage-"), signal);
    expect([...skipped].sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: "passwd-link", mode: "120000" }, { path: "vendored", mode: "160000" }]);

    const omitting = manifestFor(files, [], [{ path: "passwd-link", mode: "120000" }, { path: "vendored", mode: "160000" }]);
    const parent = await temp("stage-parent-");
    await stageCandidateSource({ git: candidate, repositoryRoot: repo.root, commitSha: commit, treeSha: tree, destination: join(parent, "ok"), manifests: [omitting], signal });
    expect((await readdir(join(parent, "ok"))).sort()).toEqual(["package.json", "src"]);
    for (const manifests of [[manifestFor(files)], [manifestFor(files, [], [{ path: "passwd-link", mode: "120000" }])],
      [manifestFor(files, [], [{ path: "passwd-link", mode: "100644" }, { path: "vendored", mode: "160000" }])]]) {
      await expect(stageCandidateSource({ git: candidate, repositoryRoot: repo.root, commitSha: commit, treeSha: tree, destination: join(parent, "refused"), manifests, signal }))
        .rejects.toThrow(/symlink or submodule the approved build source does not omit/);
      expect(await lstat(join(parent, "refused")).then(() => true, () => false)).toBe(false);
    }
  });
});
