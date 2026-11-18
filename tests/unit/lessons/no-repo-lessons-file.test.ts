// Owner decision 2026-11-17: everything Rovara learns stays inside Rovara. There is no repository lessons file (no `.rovara/lessons.md` written by Rovara, no weekly pull request, no pointer line, no switch, no route,
// no job, no code-host write for it) and no "all lessons" read. This guard reads the sources and fails when any of it comes back. It reads files only (no git history, no network).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalLessonsBodySchema, LocalLessonSchema, LocalLessonsResponseSchema } from "@agentx/contracts";

const ROOT = join(import.meta.dirname, "../../..");
const sourcesOf = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  if (name === "node_modules" || name === "dist" || name.endsWith(".tsbuildinfo")) return [];
  return statSync(path).isDirectory() ? sourcesOf(path) : /\.(ts|tsx|json|md)$/u.test(name) ? [path] : [];
});
const packages = readdirSync(join(ROOT, "packages")).filter((name) => statSync(join(ROOT, "packages", name)).isDirectory());
const files = packages.flatMap((name) => sourcesOf(join(ROOT, "packages", name, "src")).map((path) => ({ path, rel: relative(ROOT, path), text: readFileSync(path, "utf8") })));

/** Names that only the repository lessons file (or the bulk read) ever had. */
const GONE = /repoFileAction|repoFileStatus|RepoFileRuntime|RepoFileState|RepoFileStore|RepoFileTarget|lessonsRepoFile|closeOpenPullRequestFor|setLessonGoneListener|notifyLessonGone|repoSwitch|lessonRepoAction|listLessonRepos|LessonReposView|LessonsRepoFile|LESSON_FILE_|COMMIT_FILES_MAX|CommitFilesInput|CommitFilesResult|\bcommitFiles\b|commitFilesToBranch|findLessonsPullRequest|deleteLessonsBranch|changeRequestForBranch|authoredByRovara|baseRepositoryId|skipRepoFile|inRepoFile|repoFileIds|isRepoFileEligible|repoFileBlockers|textFingerprints|goneOf|markGoneFingerprint|goneFingerprintsOf|clearGoneFingerprint|lesson\.repo_file|rovara\/lessons-|lessons\/repo(?![\w-])|LOCAL_ALL_MAX|LOCAL_LESSONS_REPO_FILE|assertLessonsFileUntouched|assertPushCarriesNoLessonsFile|touchesLessonsFile|lessonsFileUnreadable|REPOFILE|LESSON_GONE_TEXT/u;
/** The only files that may still name the path: the replay copy's "file arm" (a test harness for how lessons are delivered, not a write into a customer's repository). */
const REPLAY_FILE_ARM = new Set([
  "packages/contracts/src/eval-files.ts", "packages/worker/src/eval-files.ts", "packages/contracts/src/learned-context.ts", "packages/contracts/src/protocol.ts", "packages/contracts/src/never-commit.ts",
]);

describe("no repository lessons file, no bulk read of lessons", () => {
  it("the walk really reads the sources (sentinel files are in it)", () => {
    const rels = new Set(files.map((file) => file.rel));
    for (const rel of ["packages/broker/src/lessons/store.ts", "packages/broker/src/local/app/lessons-routes.ts", "packages/worker/src/publish.ts", "packages/contracts/src/plugins/code-host.ts", "packages/broker/src/plugins/code-host/github/client.ts"]) expect(rels.has(rel), rel).toBe(true);
  });

  it("no source file is named for the lessons file, its guard, or its code-host write", () => {
    const named = files.filter((file) => /repo-file|lessons-file-guard|commit-files|repo-eligibility-report|document-repo-file/u.test(file.rel)).map((file) => file.rel);
    expect(named).toEqual([]);
  });

  it("no source names a route, setting, job, audit action, contract field, store method or code-host method of the lessons file", () => {
    const hits = files.flatMap((file) => file.text.split("\n").flatMap((line, index) => (GONE.test(line) ? [`${file.rel}:${String(index + 1)}: ${line.trim().slice(0, 120)}`] : [])));
    expect(hits).toEqual([]);
  });

  it("only the replay copy's file arm still names .rovara/lessons.md, and Rovara writes it to no repository of a customer", () => {
    const named = files.filter((file) => /\.rovara\/lessons\.md/u.test(file.text)).map((file) => file.rel).filter((rel) => !REPLAY_FILE_ARM.has(rel));
    expect(named).toEqual([]);
    // The one place that writes a file for it never reaches a customer's repository: the worker's replay arm reads `evalFiles`, which no broker module of this code base builds.
    // The replay path constant is used by the worker's replay arm alone.
    expect(files.filter((file) => /EVAL_FILES_LESSONS_PATH/u.test(file.text)).map((file) => file.rel).sort()).toEqual(["packages/contracts/src/eval-files.ts", "packages/worker/src/eval-files.ts"]);
    const builders = files.filter((file) => /\bevalFiles\b/u.test(file.text) && file.rel.startsWith("packages/broker/")).map((file) => file.rel);
    expect(builders).toEqual([]);
  });

  it("the local tool's request has no `all` and no `skipRepoFile`, and its answer carries no `inRepoFile` and at most 50 lessons", () => {
    expect(Object.keys(LocalLessonsBodySchema.shape).sort()).toEqual(["files", "repo", "stage", "task"]);
    expect(Object.keys(LocalLessonSchema.shape).sort()).toEqual(["advice", "citation", "id", "why"]);
    const lesson = { id: "les_aaaa1111", advice: "a" };
    expect(LocalLessonsResponseSchema.safeParse({ status: "ok", message: "", project: "p", lessons: Array.from({ length: 50 }, () => lesson), markdown: "", complete: true }).success).toBe(true);
    expect(LocalLessonsResponseSchema.safeParse({ status: "ok", message: "", project: "p", lessons: Array.from({ length: 51 }, () => lesson), markdown: "", complete: true }).success).toBe(false);
    expect(LocalLessonsBodySchema.safeParse({ all: true }).success).toBe(false);
    expect(LocalLessonsBodySchema.safeParse({ skipRepoFile: true }).success).toBe(false);
  });

  it("the guard itself would catch each kind of comeback (mutants)", () => {
    for (const text of ["export function repoFileStatus() {}", "const branch = 'rovara/lessons-0123456789ab'", "audit('lesson.repo_file_switched')", "GET /v1/app/projects/{p}/lessons/repo", "const LOCAL_ALL_MAX_LESSONS = 300", "host.commitFilesToBranch()"]) expect(GONE.test(text), text).toBe(true);
    for (const text of ["readRepoFile", "kind: 'repo_file'", "the replay copy's lessons file"]) expect(GONE.test(text), text).toBe(false);
  });
});
