// Lessons in the repo (owner decision 50.4): the WORKER half of the guard. A task's pull request may not touch `.rovara/lessons.md`: the worker refuses a push whose diff touches it.
// (The merge check and the code host's branch delete are tested with the code that owns them.)
import { describe, expect, it } from "vitest";
import { LESSONS_FILE_REFUSAL, assertLessonsFileUntouched, isLessonsFilePath } from "../../packages/worker/src/lessons-file-guard.js";

describe("which paths count", () => {
  it.each([
    [".rovara/lessons.md", true], [".Rovara/Lessons.MD", true], ["./.rovara/lessons.md", true], [".rovara\\lessons.md", true], [".rovara/lessons.md/", true], [".rovara", true], [".rovara/lessons.md/x", true],
    [".rovara/project.yaml", false], [".rovara/rules/a.md", false], ["docs/.rovara/lessons.md", false], [".rovara/lessons.md.bak", false], ["lessons.md", false], ["", false],
  ])("%s -> %s", (path, expected) => {
    expect(isLessonsFilePath(path)).toBe(expected);
  });
  it("compares as NFC", () => { expect(isLessonsFilePath(".rovara/lessons.md".normalize("NFD"))).toBe(true); });
});


describe("the worker's check on a diff", () => {
  const gitReturning = (out: string) => async () => out;
  it("passes a clean diff, refuses a touched one with the fixed sentence, and fails closed when the diff cannot be read", async () => {
    await expect(assertLessonsFileUntouched(gitReturning("src/a.ts\0.rovara/project.yaml\0"), "c".repeat(40), "b".repeat(40))).resolves.toBeUndefined();
    await expect(assertLessonsFileUntouched(gitReturning("src/a.ts\0.rovara/lessons.md\0"), "c".repeat(40), "b".repeat(40))).rejects.toThrow(LESSONS_FILE_REFUSAL);
    await expect(assertLessonsFileUntouched(async () => { throw new Error("git failed"); }, "c".repeat(40), "b".repeat(40))).rejects.toThrow(/could not read the list of files/);
  });
  it("without a base uses the commit's first parent, or the empty tree for a root commit", async () => {
    const seen: string[][] = [];
    await assertLessonsFileUntouched(async (args) => { seen.push(args); return args[0] === "rev-parse" ? "a".repeat(40) : ""; }, "c".repeat(40));
    expect(seen[1]!.slice(-2)).toEqual(["a".repeat(40), "c".repeat(40)]);
    seen.length = 0;
    await assertLessonsFileUntouched(async (args) => { seen.push(args); if (args[0] === "rev-parse") throw new Error("no parent"); return ""; }, "c".repeat(40));
    expect(seen[1]!.slice(-2)).toEqual(["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "c".repeat(40)]);
  });
});

// ---- review M2: EVERY worker push goes through one guarded function (real git) ----
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { LESSONS_FILE_MERGE_REFUSAL, assertPushCarriesNoLessonsFile } from "../../packages/worker/src/lessons-file-guard.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "rovara-guard-"));
  dirs.push(dir);
  const git = async (args: string[]): Promise<string> => (await run("git", args, { cwd: dir, env: GIT_ENV })).stdout;
  await git(["init", "-q", "--initial-branch=main"]);
  await mkdir(join(dir, ".rovara"), { recursive: true });
  await writeFile(join(dir, ".rovara/lessons.md"), "base\n");
  await writeFile(join(dir, "a.txt"), "a\n");
  await git(["add", "-A"]); await git(["commit", "-q", "-m", "base"]);
  return { dir, git, write: (path: string, text: string) => writeFile(join(dir, path), text), commit: async (message: string) => { await git(["add", "-A"]); await git(["commit", "-q", "-m", message]); return (await git(["rev-parse", "HEAD"])).trim(); } };
}

describe("the guard on a push that adds a commit to an existing pull request", () => {
  it("refuses a commit that edits or deletes the file, and passes one that does not (positive control)", async () => {
    const r = await repo();
    await r.write("a.txt", "b\n");
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("clean"))).resolves.toBeUndefined();
    await r.write(".rovara/lessons.md", "sneaky\n");
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("edit"))).rejects.toThrow(LESSONS_FILE_REFUSAL);
    await rm(join(r.dir, ".rovara/lessons.md"));
    await expect(assertPushCarriesNoLessonsFile(r.git, await r.commit("delete"))).rejects.toThrow(LESSONS_FILE_REFUSAL);
  });

  it("a merge of the base that changed the file is not flagged; a person's earlier change on the branch is not flagged; a conflict resolution that differs from both parents is", async () => {
    const r = await repo();
    await r.git(["checkout", "-q", "-b", "pr"]);
    await r.write(".rovara/lessons.md", "a person's change on the pull request\n");
    await r.write("a.txt", "pr\n");
    await r.commit("person");
    await r.git(["checkout", "-q", "main"]);
    await r.write("b.txt", "main\n");
    await r.commit("main moves");
    // The base moves the lessons file; the pull request branch also holds the person's version of it.
    await r.git(["checkout", "-q", "pr"]);
    await r.git(["merge", "-q", "--no-edit", "main"]);
    await expect(assertPushCarriesNoLessonsFile(r.git, "HEAD")).resolves.toBeUndefined();
    // A merge commit whose tree takes the lessons file from neither parent.
    await r.write(".rovara/lessons.md", "third version\n");
    await r.git(["add", "-A"]); await r.git(["commit", "-q", "--amend", "--no-edit"]);
    await expect(assertPushCarriesNoLessonsFile(r.git, "HEAD")).rejects.toThrow(LESSONS_FILE_MERGE_REFUSAL);
    expect((await readFile(join(r.dir, ".rovara/lessons.md"), "utf8"))).toBe("third version\n");
  });

  it("every push of maintain-pull-request.ts goes through the one guarded function", async () => {
    const text = await readFile("packages/worker/src/maintain-pull-request.ts", "utf8");
    expect((text.match(/credentialedGit\([^\n]*\["push"/gu) ?? []).length).toBe(1);
    expect(text).toMatch(/async function push\([^\n]*\n[^\n]*\n[^\n]*\n\s*await assertPushCarriesNoLessonsFile\(/u);
    expect((text.match(/"push"/gu) ?? []).length).toBe(1);
  });
});
