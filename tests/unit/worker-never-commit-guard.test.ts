// TE-B9 (O38): Rovara's own working files can never be committed, whatever the workspace layout. The one list is `ROVARA_NEVER_COMMIT` (contracts). The candidate snapshot, publish and PR maintenance leave
// the listed paths out of every `git add`, take force-added ones out of the index, and a final check on the commit about to be pushed fails closed with a fixed sentence. Real git throughout: the list is Git pathspecs.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ROVARA_NEVER_COMMIT, ROVARA_NEVER_COMMIT_EXCLUDE, neverCommitRefusal } from "@agentx/contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { snapshotTree, withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { runIsolatedGit } from "../../packages/worker/src/isolated-repository.js";
import { assertNoRovaraWorkingFiles, assertPushCarriesNoRovaraWorkingFiles, unstageRovaraWorkingFiles } from "../../packages/worker/src/never-commit-guard.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

async function repo(seed: Record<string, string> = { "README.md": "# project\n" }) {
  const dir = await mkdtemp(join(tmpdir(), "rovara-never-commit-"));
  dirs.push(dir);
  const git = async (args: string[]): Promise<string> => (await run("git", args, { cwd: dir, env: GIT_ENV })).stdout;
  const put = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  };
  await git(["init", "-q", "-b", "main"]);
  await put(seed);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  return { dir, git, put, base };
}

type RepoGit = (args: string[]) => Promise<string>;
/** A commit of `files` (force-added, so a listed path is in it whatever any ignore file says). */
async function commitFiles(git: RepoGit, put: (files: Record<string, string>) => Promise<void>, files: Record<string, string>, message = "task"): Promise<string> {
  await put(files);
  await git(["add", "-f", "-A"]);
  await git(["commit", "-q", "-m", message]);
  return (await git(["rev-parse", "HEAD"])).trim();
}

/** Every path a task or the verifier could leave behind, at the top and nested (a monorepo or a workspace one folder down). */
const WORKING_FILES = [
  ".agentx/x", ".agentx/preparation-manifest.json", ".agentx-tmp/y", ".agentx-tmp/deep/z", ".agentx-stray",
  ".rovara/state.db", ".rovara/state.db-wal", ".rovara/state.db-shm", ".rovara/audit.db", ".rovara/audit.db-journal",
  "svc/.agentx/last-checks.json", "svc/.agentx-runtime/tmp/a", "svc/.rovara/state.db",
  // Names are matched without regard to case (a case-insensitive file system, a tool that upper-cases).
  ".AGENTX/x", ".Agentx-foo/y", ".rovara/STATE.DB", "svc/.AgEnTx-runtime/a", ".AGENTX-file",
];
/** Paths that look close but are the customer's own, including their build reports (Rovara does not guess at those). */
const CUSTOMER_FILES = [
  "feature.py", ".rovara/rules/a.md", ".rovara/project.yaml", ".rovara/lessons.md", ".rovara/company-instructions.md", ".rovara/state.dbx/notes.md",
  "agentx/readme.md", "docs/agentx-notes.md", ".agentxrc", "src/target/Main.java", "build/libs/app.jar", "build/test-resources/a.txt",
  "src/test/resources/build/test-results/test/TEST-a.xml", "docs/target/site/jacoco/jacoco.xml", "target/surefire-reports/TEST-b.xml",
  "svc/target/failsafe-reports/TEST-c.xml", "build/test-results/test/TEST-d.xml", "build/reports/jacoco/test/jacocoTestReport.xml",
];

describe("the list", () => {
  it("is one exported list of pathspecs, with an exclude form of every entry", () => {
    expect(ROVARA_NEVER_COMMIT).toHaveLength(6);
    expect(ROVARA_NEVER_COMMIT_EXCLUDE).toHaveLength(ROVARA_NEVER_COMMIT.length);
    for (const entry of ROVARA_NEVER_COMMIT) expect(entry).toMatch(/^:\(top,icase,glob\)/u);
    for (const entry of ROVARA_NEVER_COMMIT_EXCLUDE) expect(entry).toMatch(/^:\(top,exclude,icase,glob\)/u);
    const joined = ROVARA_NEVER_COMMIT.join("\n");
    for (const name of [".agentx", ".agentx-*", ".rovara/state.db*", ".rovara/audit.db*"]) expect(joined).toContain(name);
    // The customer's build reports are not on the list.
    for (const name of ["surefire", "failsafe", "jacoco", "test-results"]) expect(joined).not.toContain(name);
  });

  it("says the fixed sentence, with the path made safe to show", () => {
    expect(neverCommitRefusal(".agentx/x")).toBe("Rovara stopped: its own working files were about to be committed (.agentx/x). Not your code. Nothing was pushed. Next: run the task again.");
    const shown = neverCommitRefusal(`.agentx/${"\u001b[31m"}${"a".repeat(500)}`);
    expect(shown.includes(String.fromCharCode(27))).toBe(false);
    expect(shown.length).toBeLessThan(400);
    expect(shown.startsWith("Rovara stopped: its own working files were about to be committed (")).toBe(true);
    expect(shown.endsWith("). Not your code. Nothing was pushed. Next: run the task again.")).toBe(true);
  });
});

describe("the candidate snapshot leaves the listed paths out", () => {
  const filesOf = async (dir: string, base: string): Promise<string[]> =>
    withIsolatedGit(dir, "read", async (session) => (await session.text(["ls-tree", "-r", "--name-only", await snapshotTree(session, base)])).split("\n").filter((line) => line !== ""));

  it("holds the customer's files and none of the working files (positive control: the customer's are there)", async () => {
    const { dir, put, base } = await repo();
    await put(Object.fromEntries([...WORKING_FILES, ...CUSTOMER_FILES].map((path) => [path, "x\n"])));
    const files = await filesOf(dir, base);
    expect(files).toEqual(["README.md", ...CUSTOMER_FILES].sort());
  });

  it("holds none of them in a repository with a submodule either (the snapshot's second form)", async () => {
    const { dir, git, put } = await repo();
    await git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`]);
    await git(["commit", "-q", "-m", "submodule"]);
    const base = (await git(["rev-parse", "HEAD"])).trim();
    await mkdir(join(dir, "vendor", "lib"), { recursive: true });
    await put({ ".agentx/x": "1\n", ".agentx-tmp/y": "2\n", "svc/.rovara/audit.db": "3\n", "feature.py": "print(1)\n" });
    expect(await filesOf(dir, base)).toEqual(["README.md", "feature.py", "vendor/lib"]);
  });

  it("holds none of them when the task wrote .agentx/x and .agentx-tmp/y and force-added them", async () => {
    const { dir, git, put, base } = await repo();
    await put({ ".agentx/x": "1\n", ".agentx-tmp/y": "2\n", "feature.py": "print(1)\n" });
    await git(["add", "-f", ".agentx", ".agentx-tmp"]);
    expect(await filesOf(dir, base)).toEqual(["README.md", "feature.py"]);
  });
});

describe("staging in the real index (publish and PR maintenance)", () => {
  const stage = async (git: (args: string[]) => Promise<string>) => git(["add", "--all", "--", ".", ...ROVARA_NEVER_COMMIT_EXCLUDE]);
  const staged = async (git: (args: string[]) => Promise<string>) => (await git(["ls-files", "--cached"])).split("\n").filter((line) => line !== "");

  it("an add with the exclude list stages the customer's files only", async () => {
    const { git, put } = await repo();
    await put(Object.fromEntries([...WORKING_FILES, ...CUSTOMER_FILES].map((path) => [path, "x\n"])));
    await stage(git);
    expect(await staged(git)).toEqual(["README.md", ...CUSTOMER_FILES].sort());
  });

  it("a force-added working file stays in the index through the add, and unstageRovaraWorkingFiles takes it out", async () => {
    const { git, put, base } = await repo();
    await put({ ".agentx/x": "1\n", ".agentx-tmp/y": "2\n", "svc/.rovara/state.db": "3\n", "feature.py": "print(1)\n" });
    await git(["add", "-f", ".agentx", ".agentx-tmp", "svc/.rovara"]);
    await stage(git);
    expect(await staged(git)).toEqual([".agentx-tmp/y", ".agentx/x", "README.md", "feature.py", "svc/.rovara/state.db"]);
    await unstageRovaraWorkingFiles(git, base);
    expect(await staged(git)).toEqual(["README.md", "feature.py"]);
    // The files are still in the work tree: nothing was deleted.
    expect((await git(["status", "--porcelain", "--untracked-files=all"])).split("\n").filter((l) => l.includes(".agentx"))).toHaveLength(2);
  });

  it("leaves a path the base already tracks alone (not Rovara's to remove)", async () => {
    const { git, put, base } = await repo({ "README.md": "x\n", ".agentx-fixture/data.json": "{}\n" });
    await put({ ".agentx-fixture/data.json": "{\"a\":1}\n" });
    await git(["add", "-f", ".agentx-fixture/data.json"]);
    await unstageRovaraWorkingFiles(git, base);
    expect(await staged(git)).toContain(".agentx-fixture/data.json");
  });
});

describe("the final check on a commit", () => {
  const commitOf = async (git: (args: string[]) => Promise<string>, put: (files: Record<string, string>) => Promise<void>, files: Record<string, string>, message = "task") => {
    await put(files);
    await git(["add", "-f", "-A"]);
    await git(["commit", "-q", "-m", message]);
    return (await git(["rev-parse", "HEAD"])).trim();
  };

  it("passes a commit of customer files (positive control: the diff was read), including near-misses", async () => {
    const { git, put, base } = await repo();
    const commit = await commitOf(git, put, Object.fromEntries(CUSTOMER_FILES.map((path) => [path, "x\n"])));
    await expect(assertNoRovaraWorkingFiles(git, commit, base)).resolves.toBeUndefined();
    await expect(assertNoRovaraWorkingFiles(git, commit)).resolves.toBeUndefined();
  });

  it.each(WORKING_FILES)("fires on a crafted commit whose tree holds %s, naming the path in the fixed sentence", async (path) => {
    const { git, put, base } = await repo();
    const commit = await commitOf(git, put, { "feature.py": "print(1)\n", [path]: "x\n" });
    await expect(assertNoRovaraWorkingFiles(git, commit, base)).rejects.toThrow(neverCommitRefusal(path));
    await expect(assertNoRovaraWorkingFiles(git, commit)).rejects.toThrow(neverCommitRefusal(path));
  });

  it("names the first path in a stable order when several are held", async () => {
    const { git, put, base } = await repo();
    const commit = await commitOf(git, put, { ".agentx-tmp/y": "1\n", ".agentx/x": "2\n" });
    await expect(assertNoRovaraWorkingFiles(git, commit, base)).rejects.toThrow(neverCommitRefusal(".agentx-tmp/y"));
  });

  it("is about what the commit introduces: a path the base already held and the commit leaves alone passes; deleting one passes", async () => {
    const { git, put, base } = await repo({ "README.md": "x\n", ".agentx-fixture/data.json": "{}\n", ".agentx-old/a": "1\n" });
    await git(["rm", "-q", "-r", ".agentx-old"]);
    const commit = await commitOf(git, put, { "feature.py": "print(1)\n" });
    await expect(assertNoRovaraWorkingFiles(git, commit, base)).resolves.toBeUndefined();
  });

  it("fails closed when the diff cannot be read", async () => {
    await expect(assertNoRovaraWorkingFiles(async () => { throw new Error("git failed"); }, "c".repeat(40), "b".repeat(40))).rejects.toThrow(/could not read the list of files/);
  });

  it("a push check flags what THIS commit introduces over every parent, and passes a clean merge of the base", async () => {
    const { git, put, base } = await repo();
    await git(["checkout", "-q", "-b", "pr"]);
    const leaked = await commitOf(git, put, { "feature.py": "print(1)\n", ".agentx/x": "1\n" });
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, leaked)).rejects.toThrow(neverCommitRefusal(".agentx/x"));
    // The leak is already on the branch; a later clean fix commit on top introduces nothing and passes.
    const fix = await commitOf(git, put, { "feature.py": "print(2)\n" });
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, fix)).resolves.toBeUndefined();
    // A root commit is compared with the empty tree.
    await git(["checkout", "-q", "--orphan", "fresh"]);
    await git(["rm", "-rf", "-q", "."]);
    const root = await commitOf(git, put, { "a.txt": "1\n", ".agentx-tmp/y": "2\n" });
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, root)).rejects.toThrow(neverCommitRefusal(".agentx-tmp/y"));
    expect(base).toHaveLength(40);
  });
});

describe("M1a: a working file the task COMMITTED never reaches the reviewed commit", () => {
  const filesOf = async (dir: string, commit: string, base?: string): Promise<string[]> =>
    withIsolatedGit(dir, "read", async (session) => (await session.text(["ls-tree", "-r", "--name-only", await snapshotTree(session, commit, base)])).split("\n").filter((line) => line !== ""));

  it("with the base, the snapshot drops a listed path the base does not hold and keeps one it does (positive control: the customer's file and the base's own are there)", async () => {
    const { dir, git, put, base } = await repo({ "README.md": "x\n", ".agentx-fixture/data.json": "{}\n" });
    const head = await commitFiles(git, put, { ".agentx/x": "1\n", ".AGENTX-new/y": "2\n", "svc/.rovara/state.db": "3\n", "feature.py": "print(1)\n" });
    expect(await filesOf(dir, head, base)).toEqual([".agentx-fixture/data.json", "README.md", "feature.py"]);
    // Without a base nothing says which listed path is the task's (unchanged behaviour for a caller that has none).
    expect(await filesOf(dir, head)).toContain(".agentx/x");
  });

  it("the snapshot is stable: a snapshot of a snapshot's own commit gives the same tree", async () => {
    const { dir, git, put, base } = await repo();
    const head = await commitFiles(git, put, { ".agentx/x": "1\n", "feature.py": "print(1)\n" });
    // "write": the tree's objects are exported to the repository, as candidate capture does before it commits.
    const first = await withIsolatedGit(dir, "write", async (session) => snapshotTree(session, head, base));
    const commit = (await git(["commit-tree", first, "-p", head, "-m", "snapshot"])).trim();
    expect(await withIsolatedGit(dir, "read", async (session) => snapshotTree(session, commit, base))).toBe(first);
  });
});

describe("M3: Git variables that change how a pathspec is read cannot hide a listed path", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const VARIABLES = ["GIT_LITERAL_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS"] as const;

  it.each(VARIABLES)("%s set in the worker's environment: the guard still flags, through the worker's own Git", async (name) => {
    const { dir, git, put, base } = await repo();
    const commit = await commitFiles(git, put, { "feature.py": "print(1)\n", ".agentx/x": "1\n", "svc/.rovara/audit.db": "2\n" });
    vi.stubEnv(name, "1");
    const workerGit: RepoGit = (args) => runIsolatedGit(dir, args);
    await expect(assertNoRovaraWorkingFiles(workerGit, commit, base)).rejects.toThrow(neverCommitRefusal(".agentx/x"));
    await expect(assertPushCarriesNoRovaraWorkingFiles(workerGit, commit)).rejects.toThrow(neverCommitRefusal(".agentx/x"));
  });

  it.each(VARIABLES)("%s is removed from the environment of every Git the worker runs", (name) => {
    vi.stubEnv(name, "1");
    expect(isolatedGitEnvironment("/work")[name]).toBeUndefined();
  });

  it.each(VARIABLES)("%s set: the candidate snapshot still leaves the listed paths out", async (name) => {
    const { dir, put, base } = await repo();
    await put({ ".agentx/x": "1\n", ".AGENTX-tmp/y": "2\n", "feature.py": "print(1)\n" });
    vi.stubEnv(name, "1");
    const files = await withIsolatedGit(dir, "read", async (session) => (await session.text(["ls-tree", "-r", "--name-only", await snapshotTree(session, base)])).split("\n").filter((line) => line !== ""));
    expect(files).toEqual(["README.md", "feature.py"]);
  });

  it("the case rule: .AGENTX, .Agentx-foo and .rovara/STATE.DB are flagged, and the customer's near-misses are not", async () => {
    const { git, put, base } = await repo();
    const ok = await commitFiles(git, put, Object.fromEntries(CUSTOMER_FILES.map((path) => [path, "x\n"])));
    await expect(assertNoRovaraWorkingFiles(git, ok, base)).resolves.toBeUndefined();
    let before = ok;
    for (const path of [".AGENTX/x", ".Agentx-foo/y", ".rovara/STATE.DB"]) {
      const bad = await commitFiles(git, put, { [path]: "x\n" }, path);
      await expect(assertNoRovaraWorkingFiles(git, bad, before)).rejects.toThrow(neverCommitRefusal(path));
      before = bad;
    }
  });
});

describe("M4: the final check on every kind of change (kills the diff-filter, submodule and parent-count mutants)", () => {
  it("flags a MODIFIED listed path the base tracks, and a TYPE-CHANGED one", async () => {
    const { dir, git, put, base } = await repo({ "README.md": "x\n", ".agentx-fixture/data.json": "{}\n", ".agentx-fixture/other.json": "{}\n" });
    const modified = await commitFiles(git, put, { ".agentx-fixture/data.json": "{\"a\":1}\n" });
    await expect(assertNoRovaraWorkingFiles(git, modified, base)).rejects.toThrow(neverCommitRefusal(".agentx-fixture/data.json"));
    await rm(join(dir, ".agentx-fixture", "other.json"));
    await symlink("README.md", join(dir, ".agentx-fixture", "other.json"));
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "type change"]);
    const typeChanged = (await git(["rev-parse", "HEAD"])).trim();
    expect((await git(["diff", "--name-status", modified, typeChanged])).trim()).toMatch(/^T\s+\.agentx-fixture\/other\.json$/u);
    await expect(assertNoRovaraWorkingFiles(git, typeChanged, modified)).rejects.toThrow(neverCommitRefusal(".agentx-fixture/other.json"));
  });

  it("flags a gitlink (submodule entry) at a listed path, even when the repository's config says to ignore submodules", async () => {
    const { git, put, base } = await repo();
    await put({ "feature.py": "print(1)\n" });
    await git(["add", "-A"]);
    await git(["update-index", "--add", "--cacheinfo", `160000,${base},.agentx-sub`]);
    await git(["commit", "-q", "-m", "gitlink"]);
    const commit = (await git(["rev-parse", "HEAD"])).trim();
    const ignoring: RepoGit = (args) => git(["-c", "diff.ignoreSubmodules=all", ...args]);
    expect((await ignoring(["diff", "--name-only", base, commit])).trim()).toBe("feature.py");
    await expect(assertNoRovaraWorkingFiles(ignoring, commit, base)).rejects.toThrow(neverCommitRefusal(".agentx-sub"));
    await expect(assertPushCarriesNoRovaraWorkingFiles(ignoring, commit)).rejects.toThrow(neverCommitRefusal(".agentx-sub"));
  });

  it("a REAL merge commit: no flag when the base brings a listed path in, or when the branch already held one; a flag when the merge itself adds one", async () => {
    const { git, put } = await repo();
    await git(["checkout", "-q", "-b", "pr"]);
    const onBranch = await commitFiles(git, put, { "feature.py": "print(1)\n", ".agentx-old/leak": "1\n" });
    await git(["checkout", "-q", "main"]);
    await commitFiles(git, put, { ".agentx-upstream/x": "2\n", "upstream.md": "u\n" }, "upstream");
    await git(["checkout", "-q", "pr"]);
    await git(["merge", "-q", "--no-ff", "-m", "merge the base", "main"]);
    const merged = (await git(["rev-parse", "HEAD"])).trim();
    expect((await git(["rev-list", "--parents", "-n", "1", merged])).trim().split(" ")).toHaveLength(3);
    // The base's own listed path is not this merge's doing; the branch's earlier leak is not new either.
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, merged)).resolves.toBeUndefined();
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, onBranch)).rejects.toThrow(neverCommitRefusal(".agentx-old/leak"));
    // A merge whose resolution adds a listed path that neither side had.
    await git(["checkout", "-q", "-b", "pr2", "main"]);
    await commitFiles(git, put, { "second.py": "2\n" });
    await git(["checkout", "-q", "main"]);
    await commitFiles(git, put, { "third.md": "3\n" }, "more upstream");
    await git(["checkout", "-q", "pr2"]);
    await git(["merge", "-q", "--no-commit", "--no-ff", "main"]);
    await put({ ".agentx-resolution/z": "4\n" });
    await git(["add", "-f", "-A"]);
    await git(["commit", "-q", "-m", "merge with a leak"]);
    const leaky = (await git(["rev-parse", "HEAD"])).trim();
    await expect(assertPushCarriesNoRovaraWorkingFiles(git, leaky)).rejects.toThrow(neverCommitRefusal(".agentx-resolution/z"));
  });
});

describe("every path that stages or pushes is wired to the rule", () => {
  const source = (file: string) => readFileSync(new URL(`../../packages/worker/src/${file}`, import.meta.url), "utf8");

  it.each(["isolated-git.ts", "publish.ts", "maintain-pull-request.ts"])("%s: no `git add` without the never-commit excludes", (file) => {
    const text = source(file);
    const adds = text.match(/\["add", "--all", "--"[^\]]*\]/gu) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    for (const add of adds) expect(add).toContain("ROVARA_NEVER_COMMIT_EXCLUDE");
    // The snapshot's second form reads its pathspecs from a file; the list is in that file too.
    if (file === "isolated-git.ts") expect(text.match(/\.\.\.ROVARA_NEVER_COMMIT_EXCLUDE/gu)).toHaveLength(2);
  });

  it("publication checks the commit before any check, credential or push", () => {
    const text = source("publish.ts");
    const check = text.indexOf("await assertNoRovaraWorkingFiles(git, commit, neverCommitBase)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(text.indexOf("runReadinessChecks(rootPath, invocation, manifest"));
    expect(check).toBeLessThan(text.indexOf("await pushCommitFromIsolatedRepository"));
    expect(text).toContain("await unstageRovaraWorkingFiles(input.git, input.preparationCommit)");
    // L2: a retry of a committed publication is checked against the commit preparation checked out, not its first parent.
    expect(text).toContain("retryingCommittedPublication ? manifestRepository.resolvedCommit : undefined");
  });

  it("every push of pull request maintenance goes through the one guarded function", () => {
    const text = source("maintain-pull-request.ts");
    const push = text.slice(text.indexOf("async function push("));
    expect(push.indexOf("assertPushCarriesNoRovaraWorkingFiles")).toBeGreaterThan(0);
    expect(push.indexOf("assertPushCarriesNoRovaraWorkingFiles")).toBeLessThan(push.indexOf("credentialedGit(directory"));
    expect(text.match(/unstageRovaraWorkingFiles\(/gu)?.length).toBe(2);
    expect(text.match(/\["push", "--porcelain"/gu)).toHaveLength(1);
  });
});
