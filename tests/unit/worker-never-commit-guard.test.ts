// TE-B9 (O38): Rovara's own working files can never be committed, whatever the workspace layout. The one list is `ROVARA_NEVER_COMMIT` (contracts). The candidate snapshot, publish and PR maintenance leave
// the listed paths out of every `git add`, take force-added ones out of the index, and a final check on the commit about to be pushed fails closed with a fixed sentence. Real git throughout: the list is Git pathspecs.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ROVARA_NEVER_COMMIT, ROVARA_NEVER_COMMIT_EXCLUDE, neverCommitRefusal } from "@agentx/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { snapshotTree, withIsolatedGit } from "../../packages/worker/src/isolated-git.js";
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

/** Every path a task or the verifier could leave behind, at the top and nested (a monorepo or a workspace one folder down). */
const WORKING_FILES = [
  ".agentx/x", ".agentx/preparation-manifest.json", ".agentx-tmp/y", ".agentx-tmp/deep/z", ".agentx-stray",
  ".rovara/state.db", ".rovara/state.db-wal", ".rovara/state.db-shm", ".rovara/audit.db", ".rovara/audit.db-journal",
  "svc/.agentx/last-checks.json", "svc/.agentx-runtime/tmp/a", "svc/.rovara/state.db",
  "target/surefire-reports/TEST-a.xml", "svc/target/failsafe-reports/TEST-b.xml", "target/site/jacoco/jacoco.xml",
  "build/test-results/test/TEST-c.xml", "svc/build/reports/jacoco/test/jacocoTestReport.xml",
];
/** Paths that look close but are the customer's own. */
const CUSTOMER_FILES = [
  "feature.py", ".rovara/rules/a.md", ".rovara/project.yaml", ".rovara/lessons.md", ".rovara/company-instructions.md", ".rovara/state.dbx/notes.md",
  "agentx/readme.md", "docs/agentx-notes.md", ".agentxrc", "src/target/Main.java", "build/libs/app.jar", "build/test-resources/a.txt",
];

describe("the list", () => {
  it("is one exported list of pathspecs, with an exclude form of every entry", () => {
    expect(ROVARA_NEVER_COMMIT.length).toBeGreaterThan(5);
    expect(ROVARA_NEVER_COMMIT_EXCLUDE).toHaveLength(ROVARA_NEVER_COMMIT.length);
    for (const entry of ROVARA_NEVER_COMMIT) expect(entry).toMatch(/^:\(top,(literal|glob)\)/u);
    for (const entry of ROVARA_NEVER_COMMIT_EXCLUDE) expect(entry).toMatch(/^:\(top,exclude,(literal|glob)\)/u);
    const joined = ROVARA_NEVER_COMMIT.join("\n");
    for (const name of [".agentx", ".agentx-*", ".rovara/state.db*", ".rovara/audit.db*", "surefire-reports", "failsafe-reports", "build/test-results"]) expect(joined).toContain(name);
  });

  it("says the fixed sentence, with the path made safe to show", () => {
    expect(neverCommitRefusal(".agentx/x")).toBe("Rovara stopped: its own working files were about to be committed (.agentx/x). Not your code. Next: retrying without them");
    const shown = neverCommitRefusal(`.agentx/${"\u001b[31m"}${"a".repeat(500)}`);
    expect(shown.includes(String.fromCharCode(27))).toBe(false);
    expect(shown.length).toBeLessThan(400);
    expect(shown.startsWith("Rovara stopped: its own working files were about to be committed (")).toBe(true);
    expect(shown.endsWith("). Not your code. Next: retrying without them")).toBe(true);
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
    const check = text.indexOf("await assertNoRovaraWorkingFiles(git, commit, publicationBase)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(text.indexOf("runReadinessChecks(rootPath, invocation, manifest"));
    expect(check).toBeLessThan(text.indexOf("await pushCommitFromIsolatedRepository"));
    expect(text).toContain("await unstageRovaraWorkingFiles(input.git, input.preparationCommit)");
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
