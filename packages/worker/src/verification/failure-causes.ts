// TE-A6 Part B (DEC 254zt), the worker's half: for a failed check, joins each failing test of its own report to the change (file, and commit when it can be told) that most likely broke it, through contracts' pure
// `attributeFailures`, and says "unknown" when it cannot be sure. The result is written as `failure-causes.json` beside `evidence-raw.json` (evidence-raw.ts); the broker reads it as untrusted input.
//
// What leaves this module: test ids (already in the evidence), the changed file paths the change itself touched, commit ids from the candidate's own history and fixed reason words. A failure's text is read here to look
// for changed file names and is never kept or copied. Multi-repository tasks are joined only when the test's own report path identifies its repository; otherwise its result stays unknown, never a guessed path. Every doubt is "no result", so the
// check keeps its per-check line. Never throws.
import { isAbsolute, posix, relative, resolve } from "node:path";
import {
  FAILURE_ATTRIBUTION_LIMITS, FailureCausesSchema, attributeFailures, testIdOf,
  type EvidenceTest, type FailureCauses, type FailureChange,
} from "@agentx/contracts";
import { withIsolatedGit } from "../isolated-git.js";
import type { CandidateChange } from "./diff.js";
import { printedTestId, type ParsedTestReport, type ReportedTest } from "./test-report.js";

const COMMIT = /^[a-f0-9]{40}$/u;
/** The most commits looked at, and the most bytes of their file lists read. Past either, no commit is named (the files still are). */
export const COMMITS_MAX = 200;
export const COMMIT_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Each git read is stopped after this long. */
export const GIT_TIMEOUT_MS = 10_000;

/**
 * The commit that changed each file, for the files that exactly one commit of the task's range touched. Only when the candidate's history IS the candidate: the head commit's tree must be the checked tree, else the
 * files of the working tree are not those of any commit and nothing is named. Reads through the isolated git (never the candidate's own config) and only commit ids and file names, never a message. The tree check anchors the
 * CONTENT; the commit ids themselves are what the candidate's history says (a replace ref or a merge could blur them), so they are informational and the file names, not the ids, carry the claim. Any fault, a timeout, or a range
 * longer than `COMMITS_MAX` gives an empty map.
 */
export async function commitsOfChanges(repository: { directory: string; startCommit: string; candidateTreeSha: string }, paths: ReadonlySet<string>): Promise<Map<string, string>> {
  const none = new Map<string, string>();
  try {
    if (!COMMIT.test(repository.startCommit) || paths.size === 0) return none;
    return await withIsolatedGit(repository.directory, "read", async (git) => {
      const head = (await git.headCommit()).trim();
      if (!COMMIT.test(head)) return none;
      if ((await git.text(["rev-parse", `${head}^{tree}`], { index: "none", maxBuffer: 4096, timeout: GIT_TIMEOUT_MS })).trim() !== repository.candidateTreeSha) return none;
      const log = await git.text(["-c", "core.quotePath=false", "log", "--no-merges", "--no-renames", "-z", "--name-only", "--format=%x01%H", "-n", String(COMMITS_MAX + 1), `${repository.startCommit}..${head}`, "--"], { index: "none", maxBuffer: COMMIT_LOG_MAX_BYTES, timeout: GIT_TIMEOUT_MS });
      // Records are "\u0001<sha>" followed by the commit's file names, all separated by NUL.
      const touched = new Map<string, Set<string>>();
      let commits = 0;
      let current: string | undefined;
      for (const field of log.split("\0")) {
        if (field.startsWith("\u0001")) {
          current = field.slice(1).replace(/^\n+/u, "").slice(0, 40);
          commits += 1;
          if (!COMMIT.test(current)) return none;
          continue;
        }
        const path = field.replace(/^\n+/u, "");
        if (path === "" || current === undefined || !paths.has(path)) continue;
        touched.set(path, (touched.get(path) ?? new Set<string>()).add(current));
      }
      if (commits > COMMITS_MAX) return none;
      return new Map([...touched].flatMap(([path, set]) => (set.size === 1 ? [[path, [...set][0]!] as [string, string]] : [])));
    });
  } catch {
    return none;
  }
}

export interface FailureCauseInput {
  report: ParsedTestReport;
  /** The check's test names as the evidence keeps them (`evidenceTests`): a cause is only given for a failing test named here. */
  names: readonly EvidenceTest[];
  changes: readonly CandidateChange[];
  /** The commit of each changed file, where exactly one commit changed it (`commitsOfChanges`). */
  commits?: ReadonlyMap<string, string> | undefined;
}

/**
 * The causes of one failed check's failing tests, or undefined (more failing tests than the limit, a test id or path the contract refuses, nothing failed, the result does not fit its schema): the check then keeps its
 * per-check line. Every failing test of the check is answered or none is.
 */
export function failureCausesOf(input: FailureCauseInput): FailureCauses | undefined {
  try {
    const byId = new Map<string, { file: string | undefined; text: string | undefined }>();
    for (const test of input.report.tests) {
      if (test.status !== "failed" && test.status !== "errored") continue;
      const id = printedTestId(input.report.format, testIdOf(test));
      if (!byId.has(id)) byId.set(id, { file: test.file === undefined ? undefined : posix.normalize(test.file.replaceAll("\\", "/")), text: test.failureText });
    }
    const failing = input.names.filter((name) => name.status === "failed" || name.status === "errored");
    if (failing.length === 0 || failing.length > FAILURE_ATTRIBUTION_LIMITS.failuresMax) return undefined;
    const failures = failing.map((name) => {
      const found = byId.get(name.name);
      const file = found?.file;
      return { id: name.name, ...(file === undefined || file === "" || file.startsWith("/") || file.startsWith("..") ? {} : { file }), ...(found?.text === undefined || found.text === "" ? {} : { text: found.text }) };
    });
    const changes: FailureChange[] = input.changes.map((change) => {
      const commit = input.commits?.get(change.path);
      return { path: change.path, status: change.status, ...(commit === undefined || !COMMIT.test(commit) ? {} : { commit }) };
    });
    const result = attributeFailures({ failures, changes });
    if (result.mode !== "per_test") return undefined;
    const causes = FailureCausesSchema.safeParse(result.results.map((row) => ({ testId: row.testId, cause: row.cause })));
    return causes.success && causes.data.length > 0 ? causes.data : undefined;
  } catch {
    return undefined;
  }
}

/** Multi-repository variant: every failure is attributed against only the changed files of the repository named by its report path. */
export function failureCausesAcrossRepositories(input: {
  report: ParsedTestReport;
  names: readonly EvidenceTest[];
  workspaceRoot: string;
  checkDirectory?: string;
  repositories: readonly { directory: string; changes: readonly CandidateChange[]; commits?: ReadonlyMap<string, string> }[];
}): FailureCauses | undefined {
  try {
    const failing = input.names.filter((name) => name.status === "failed" || name.status === "errored");
    if (failing.length === 0 || failing.length > FAILURE_ATTRIBUTION_LIMITS.failuresMax
      || new Set(failing.map((name) => name.name)).size !== failing.length
      || input.repositories.reduce((sum, repository) => sum + repository.changes.length, 0) > FAILURE_ATTRIBUTION_LIMITS.changesMax) return undefined;
    let totalText = 0;
    const testsById = new Map<string, ReportedTest>();
    for (const test of input.report.tests) {
      if (test.status !== "failed" && test.status !== "errored") continue;
      const id = printedTestId(input.report.format, testIdOf(test));
      if (!testsById.has(id)) testsById.set(id, test);
      totalText += test.failureText?.length ?? 0;
    }
    if (totalText > FAILURE_ATTRIBUTION_LIMITS.totalTextMax) return undefined;
    const roots = input.repositories.map((repository) => ({ ...repository, absolute: resolve(repository.directory) }))
      .sort((a, b) => b.absolute.length - a.absolute.length);
    const checkPath = input.checkDirectory === undefined ? undefined : resolve(input.checkDirectory);
    const byTestId = new Map<string, FailureCauses[number]>();
    for (const name of failing) {
      const test = testsById.get(name.name);
      const file = test?.file?.replaceAll("\\", "/");
      const absolute = file === undefined ? undefined : isAbsolute(file) ? resolve(file) : checkPath === undefined ? undefined : resolve(checkPath, file);
      const repository = roots.find((candidate) => {
        if (absolute === undefined) return false;
        const inside = relative(candidate.absolute, absolute);
        return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
      });
      const result = failureCausesOf({ report: input.report, names: [name], changes: repository?.changes ?? [], commits: repository?.commits });
      if (result === undefined || result.length !== 1) return undefined;
      byTestId.set(name.name, result[0]!);
    }
    return failing.map((name) => byTestId.get(name.name)!);
  } catch {
    return undefined;
  }
}
