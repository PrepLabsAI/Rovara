// CI's plan (DEC 242). One small job runs this first and every other job reads its answers, so a pull request spends runner time only on what its change can
// affect, while a FULL run (everything, as before) stays available and is the one a merge needs.
//
// FULL mode: a manual run (#1295: code/next has a merge queue, so no push runs CI), a pull request labelled `full-ci`, or one whose title starts with "Batch " or "Sync mainline". It runs every job
// in full: all test shards, the whole lint (a "Batch " or "Sync mainline" pull request lints only its changed files, as any pull request does; see fullLint) and the release check (the device emulator check only on a push or a "Batch " pull request; see DEVICE_PATTERNS). The `ci-mode (full)` check exists only then.
// AFFECTED mode (a pull request, the default): the typecheck stays full; the tests are the ones the change can reach (vitest --changed plus the tests that name a
// changed file or one of the packages it touches), in 2 shards; lint covers the lint shards that hold changed files; the Linux runtime, device emulator and release checks run only
// when files in their area change (the device emulator check: only device code, DEC 254zn); a Markdown-only change that no test reads runs nothing but the plan. Anything shared (vitest config, package.json, the lockfile,
// tests/support, the workflow) falls back to the whole test suite, and the lint settings to the whole lint.
//
// The Linux runtime check (#1185) is the slowest job (~26 min) and runs in neither mode by default: it runs when its area changes (LINUX_PATTERNS), once per batch
// (each push to code/next), every night (the scheduled run, which runs it and nothing else heavy), and on request (the `linux-ci` or `full-ci` label, or a manual
// run's `linux` input). A FULL pull request ("Batch ...", "Sync mainline ...") whose change does not reach its area does not run it: that tree is checked on
// code/next's push or that night.
//
// Node runs this file directly, before `npm ci`, so it imports only Node's own modules and uses only erasable syntax. (The docs-only rule that lived in
// scripts/ci-docs-only.ts is here now.)
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DocsOnlyResult { docsOnly: boolean; reason: string }

const DOCS_PATH = /^(?:(?:specs|docs)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|README)\.md$/;

/**
 * Whether a change to these repository paths is Markdown only: every file is Markdown under specs/ or docs/ (or the root README) and no test mentions it,
 * since some tests read a guide or the constitution and those must still run.
 */
export function docsOnlyChange(changed: readonly string[], testSources: ReadonlyMap<string, string>): DocsOnlyResult {
  if (changed.length === 0) return { docsOnly: false, reason: "no changed files" };
  for (const path of changed) {
    if (!DOCS_PATH.test(path) || path.split("/").some((part) => part === "..")) {
      return { docsOnly: false, reason: `${path} is not a Markdown file under specs/ or docs/` };
    }
    for (const [testPath, source] of testSources) {
      if (source.includes(path)) return { docsOnly: false, reason: `${path} is mentioned in ${testPath}` };
    }
  }
  return { docsOnly: true, reason: `${changed.length} Markdown file${changed.length === 1 ? "" : "s"}, none read by a test` };
}

export type Mode = "full" | "affected";
export type Scope = "all" | "changed" | "none";

export interface Plan {
  mode: Mode;
  /** Why this mode, for the log. */
  modeReason: string;
  /** Affected mode only: a Markdown-only change that no test reads, so nothing but the plan runs. */
  docsOnly: boolean;
  tests: Scope;
  testsReason: string;
  /** How many test shards; the shard list is [1..shards]. At least 1 even when no test runs, so the matrix is never empty. */
  shards: number;
  lint: Scope;
  linux: boolean;
  /**
   * The device emulator check (`device-runtime`) runs (DEC 254zn quarantine): when device or emulator code changes (DEVICE_PATTERNS), and once in each batch or scheduled full run (DEVICE_FULL_EVENTS,
   * DEVICE_FULL_TITLE_PREFIX) so indirect breakage is still seen; never in other runs. Not part of the `local` gate.
   */
  device: boolean;
  /**
   * The change itself touches device or emulator code, so a red `device-runtime` must fail the run. When the job runs for any other reason (a batch, a scheduled or code/next run) the workflow
   * marks it `continue-on-error`: the emulator test is flaky and a flake must not block changes that cannot affect it. False when no changed-file list exists (push, schedule, manual run).
   */
  deviceRequired: boolean;
  release: boolean;
  /** Test files to run in addition to vitest's own --changed selection (they name a changed file or a changed package); only when tests is "changed". */
  extraTests: string[];
}

export interface PackageInfo { dir: string; name: string; dependencies: readonly string[] }

export interface PlanInput {
  event: string;
  labels: readonly string[];
  title: string;
  /** Repository paths changed by the pull request, or by the merge queue's group against its base (#1259); unused for any other event. */
  changed: readonly string[];
  /** Every test file's source, by repository path. */
  testSources: ReadonlyMap<string, string>;
  packages: readonly PackageInfo[];
  /** A manual run asked for the Linux runtime check (workflow_dispatch input `linux`). */
  forceLinux?: boolean;
  /** #1189: the pull request's base branch (github.base_ref), or the merge queue's (merge_group.base_ref, without `refs/heads/`); empty or absent otherwise. */
  baseRef?: string;
}

/**
 * #1259: the events that judge a change before it lands on mainline: a pull request, and the merge queue's run of a pull request merged onto the latest mainline
 * (`merge_group`). A merge-queue run has no labels and no title, so only the changed files decide its plan, the same way as a pull request's.
 */
export const CHANGE_EVENTS: readonly string[] = ["pull_request", "merge_group"];
export const isChangeEvent = (event: string): boolean => CHANGE_EVENTS.includes(event);

export const FULL_LABEL = "full-ci";
/** #1185: a pull request labelled like this runs the Linux runtime check whatever it changes. */
export const LINUX_LABEL = "linux-ci";
/** #1185, #1189: runs that always run the Linux runtime check: the nightly scheduled run on mainline. Not a push: CI's pushes are code/next's, and the owner
 * decided (2026-11-19) the check guards what goes into mainline (which deploys), not code/next. */
export const LINUX_EVENTS: readonly string[] = [];
/** #1189: the branch whose pull requests run the Linux runtime check when they reach its area. */
export const LINUX_BASE_BRANCH = "mainline";
export const FULL_TITLE_PREFIXES = ["Batch ", "Sync mainline"] as const;
export const FULL_SHARDS = 8;
export const AFFECTED_SHARDS = 2;
/** More related tests than this and the selection saves little: run the whole suite. */
export const MAX_EXTRA_TESTS = 300;

/** Why a run is FULL, or undefined when it is not. (The scheduled run is neither: it is the nightly Linux runtime run, see planCi.) */
export function fullReason(input: Pick<PlanInput, "event" | "labels" | "title">): string | undefined {
  if (!isChangeEvent(input.event)) return `${input.event} runs everything`;
  if (input.labels.includes(FULL_LABEL)) return `the pull request has the ${FULL_LABEL} label`;
  const prefix = FULL_TITLE_PREFIXES.find((candidate) => input.title.startsWith(candidate));
  if (prefix !== undefined) return `the title starts with "${prefix.trim()}"`;
  return undefined;
}

const anyMatch = (path: string, patterns: readonly RegExp[]): boolean => patterns.some((pattern) => pattern.test(path));

/** Files every test shares: a change to one means the whole suite. */
export const SHARED_TEST_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.node-version$/,
  /^vitest[^/]*\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^tests\/support\//,
  /^tests\/\.timings\//,
  /^\.github\//,
  /^scripts\/ci-[^/]*\.ts$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/tsconfig[^/]*\.json$/,
  /^infra\/package\.json$/,
  /^eslint\.config\.[cm]?js$/,
];

/** Files whose change means the whole lint (its rules, its shards, the compiler settings and the toolchain). */
export const SHARED_LINT_PATTERNS: readonly RegExp[] = [
  /^eslint\.config\.[cm]?js$/,
  /^scripts\/lint-shards\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.node-version$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/tsconfig[^/]*\.json$/,
];

/** The Linux runtime check's area: the worker, the verifier and the executor, Docker images, the Linux tests and the workflow itself. */
export const LINUX_PATTERNS: readonly RegExp[] = [
  /^packages\/worker\//,
  /^packages\/verifier\//,
  /^environments\//,
  /^tests\/linux\//,
  /^tests\/e2e\/m1-/,
  /^tests\/support\/(linux-|e2e-|docker)/,
  /^scripts\/(executor-smoke|ci-images|ci-plan|ci-gate)\.ts$/,
  /^\.github\/ci-images\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^vitest\.native-p0\.config\.ts$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.node-version$/,
  /^tsconfig[^/]*\.json$/,
];

/**
 * The device emulator check's area (device testing, DEC 244; narrowed by DEC 254zn): the device executor image, the device code and tests, and the CI image list that pins its base image.
 * The shared files (the workflow, the plan and gate scripts, the manifests, tsconfig, the Node version) are NOT here: the emulator test is flaky, and a change to them does not touch device code.
 */
export const DEVICE_PATTERNS: readonly RegExp[] = [
  /^environments\/device-executor\//,
  /^packages\/contracts\/src\/device-/,
  /^packages\/verifier\/src\/(executor|host)\/device-/,
  /^tests\/linux\/device-/,
  /^tests\/fixtures\/device-/,
  /^tests\/support\/device-/,
  /^scripts\/ci-images\.ts$/,
  /^\.github\/ci-images\.json$/,
];
/** Runs that are not a pull request but run the emulator once anyway: a merge to code/next (the batch landing) and a scheduled full run. A manual run does not. */
export const DEVICE_FULL_EVENTS: readonly string[] = ["push", "schedule"];
/** A pull request titled like this (a batch) runs the emulator once too, without making it required. */
export const DEVICE_FULL_TITLE_PREFIX = "Batch ";

/** The release check's area: the release scripts and the infrastructure, plus the manifests and the workflow. */
export const RELEASE_PATTERNS: readonly RegExp[] = [
  /^scripts\/release\//,
  /^scripts\/release-[^/]*\.ts$/,
  /^infra\//,
  /^environments\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.node-version$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-(plan|gate)\.ts$/,
];

/** The packages a change reaches: the ones with changed files and everything that depends on them, directly or not. */
export function affectedPackages(changed: readonly string[], packages: readonly PackageInfo[]): PackageInfo[] {
  const touched = new Set(packages.filter((pkg) => changed.some((file) => file.startsWith(`${pkg.dir}/`))).map((pkg) => pkg.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!touched.has(pkg.name) && pkg.dependencies.some((dependency) => touched.has(dependency))) {
        touched.add(pkg.name);
        grew = true;
      }
    }
  }
  return packages.filter((pkg) => touched.has(pkg.name));
}

/**
 * The test files that name a changed file or one of the affected packages. Vitest's --changed follows imports, but a package's tests import its built output,
 * not its source, and many contract tests read a file's text without importing it; both are caught here by the path or the package name in the test's source.
 */
export function relatedTests(changed: readonly string[], packages: readonly PackageInfo[], testSources: ReadonlyMap<string, string>): string[] {
  const needles = new Set<string>(changed);
  for (const pkg of affectedPackages(changed, packages)) {
    needles.add(pkg.name);
    needles.add(`${pkg.dir}/`);
  }
  const found: string[] = [];
  for (const [testPath, source] of testSources) {
    if (changed.includes(testPath) || [...needles].some((needle) => source.includes(needle))) found.push(testPath);
  }
  return found.sort();
}

/**
 * #1185: whether the Linux runtime check runs: once per batch and every night (LINUX_EVENTS), on request (the `linux-ci` or `full-ci` label, a manual run's
 * input), and when the change reaches its area (LINUX_PATTERNS), including a pull request whose changed-file list is empty (unknown, so it runs).
 */
export function linuxRuns(input: Pick<PlanInput, "event" | "forceLinux">): boolean {
  // #1192 (owner decision 2026-11-19): the Linux runtime check no longer runs in CI, for mainline or code/next: not on a pull request, a push, a label or the
  // nightly run. It runs in the production release instead (the release pipeline's build, before the deploy). Only a manual run that asks for it (the
  // workflow_dispatch input `linux`) still runs it here, for debugging.
  return input.event === "workflow_dispatch" && input.forceLinux === true;
}

/** The lint of an ordinary pull request: the whole lint when its settings change (or no changed-file list exists), its changed TypeScript files otherwise. */
export function changedLint(changed: readonly string[]): Scope {
  return changed.length === 0 || changed.some((file) => anyMatch(file, SHARED_LINT_PATTERNS)) ? "all" : changed.some((file) => /\.ts$/.test(file)) ? "changed" : "none";
}

/**
 * The lint of a FULL run. The whole lint takes about 10 minutes (22 shards, each with its own TypeScript program), and every file it checks was linted when
 * it last changed, so a "Batch " or "Sync mainline" pull request lints its changed files like any pull request. A push to code/next, a manual run and the
 * `full-ci` label (a request for everything) still lint everything, and so does the nightly run.
 */
export function fullLint(input: Pick<PlanInput, "event" | "labels" | "changed">): Scope {
  if (!isChangeEvent(input.event) || input.labels.includes(FULL_LABEL)) return "all";
  return changedLint(input.changed);
}

const changeReason = (event: string): string => (event === "merge_group" ? "the merge queue's run of a pull request on the latest base branch" : "a pull request");

export function planCi(input: PlanInput): Plan {
  const deviceRequired = input.changed.some((file) => anyMatch(file, DEVICE_PATTERNS));
  const deviceFull = DEVICE_FULL_EVENTS.includes(input.event) || (input.event === "pull_request" && input.title.startsWith(DEVICE_FULL_TITLE_PREFIX));
  // #1185: the nightly run is the device emulator check (non-blocking, as DEC 254zn had it for a scheduled run), not a second full suite: the typecheck still runs in
  // `quick`, but no tests or release check (the slow tests run in their own nightly job). #1192: no Linux runtime check either (the production release runs it).
  // The whole lint runs here: a "Batch " or "Sync mainline" pull request lints only its changed files (fullLint).
  if (input.event === "schedule") {
    return { mode: "affected", modeReason: "the nightly run", docsOnly: false, tests: "none", testsReason: "the nightly run checks the device emulator only", shards: 1, lint: "all", linux: linuxRuns(input), device: true, deviceRequired: false, release: false, extraTests: [] };
  }
  const reason = fullReason(input);
  if (reason !== undefined) {
    return { mode: "full", modeReason: reason, docsOnly: false, tests: "all", testsReason: "FULL mode", shards: FULL_SHARDS, lint: fullLint(input), linux: linuxRuns(input), device: deviceRequired || deviceFull, deviceRequired, release: true, extraTests: [] };
  }
  const { changed } = input;
  const docs = docsOnlyChange(changed, input.testSources);
  if (docs.docsOnly) {
    return { mode: "affected", modeReason: changeReason(input.event), docsOnly: true, tests: "none", testsReason: docs.reason, shards: 1, lint: "none", linux: false, device: false, deviceRequired: false, release: false, extraTests: [] };
  }
  const shared = changed.find((file) => anyMatch(file, SHARED_TEST_PATTERNS));
  const extraTests = shared === undefined && changed.length > 0 ? relatedTests(changed, input.packages, input.testSources) : [];
  const tooMany = extraTests.length > MAX_EXTRA_TESTS;
  const tests: Scope = changed.length === 0 || shared !== undefined || tooMany ? "all" : "changed";
  const testsReason = changed.length === 0
    ? "no changed files were listed, so the whole suite"
    : shared !== undefined
      ? `${shared} is shared by every test, so the whole suite`
      : tooMany
        ? `${extraTests.length} tests name the change, so the whole suite`
        : "the tests the change can reach";
  const lint = changedLint(changed);
  return {
    mode: "affected",
    modeReason: changeReason(input.event),
    docsOnly: false,
    tests,
    testsReason,
    shards: tests === "all" ? FULL_SHARDS : AFFECTED_SHARDS,
    lint,
    linux: linuxRuns(input),
    device: deviceRequired || deviceFull || changed.length === 0,
    deviceRequired,
    release: changed.length === 0 || changed.some((file) => anyMatch(file, RELEASE_PATTERNS)),
    extraTests: tests === "changed" ? extraTests : [],
  };
}

/** The values the workflow reads, as `needs.plan.outputs.*`. Strings only: that is all a job output holds. */
export function planOutputs(plan: Plan): Record<string, string> {
  return {
    mode: plan.mode,
    docs_only: String(plan.docsOnly),
    tests: plan.tests,
    shards: JSON.stringify(Array.from({ length: plan.shards }, (_, index) => index + 1)),
    lint: plan.lint,
    linux: String(plan.linux),
    device: String(plan.device),
    device_required: String(plan.deviceRequired),
    release: String(plan.release),
  };
}

// ---- #1262: the merge queue reuses a pull request's passing run of byte-identical code ----------------------------------------------------------------------
// A pull request into mainline marks the merge commit its CI tested: the `local` job sets the commit status `ci/local` (success or failure, as the gate decided)
// on `github.sha`, with the run's address. When the merge queue then builds its commit for that pull request, the queue run reuses that pass instead of running
// the suite again, but only when ALL of these hold (anything else, a missing token or any git or GitHub error included, plans the run as usual):
//   - the pull request number parses from merge_group.head_ref (refs/heads/gh-readonly-queue/mainline/pr-<N>-<sha>);
//   - refs/pull/<N>/merge fetches, and its tree is byte-for-byte the queue commit's tree;
//   - the merge commit's first parent and the queue commit's first parent are both merge_group.base_sha (the group is this one pull request, on the same base);
//   - the merge commit's newest `ci/local` status is `success`, was created by github-actions[bot] (never a person's status) and names a run of this repository.
// A reuse runs the plan and the gate only; the gate (scripts/ci-gate.ts) accepts it only in a merge_group run, and names the reused run.

export const QUEUE_STATUS_CONTEXT = "ci/local";
export const QUEUE_STATUS_CREATOR = "github-actions[bot]";
const SHA = /^[0-9a-f]{40}$/u;
// #1295: the queues of mainline and code/next.
const QUEUE_HEAD_REF = /^refs\/heads\/gh-readonly-queue\/(?:mainline|code\/next)\/pr-([1-9][0-9]{0,8})-[0-9a-f]{40}$/u;

export interface QueueStatus { id?: number; context?: string; state?: string; target_url?: string | null; creator?: { login?: string } | null }
export interface QueueReuseInput {
  repository: string;
  /** merge_group.head_ref. */
  headRef: string;
  /** merge_group.base_sha. */
  baseSha: string;
  /** Runs git with these arguments: its trimmed output, or undefined when it fails. */
  git: (...args: string[]) => string | undefined;
  /** The commit statuses of a commit, or undefined when GitHub can't be read. */
  statuses: (sha: string) => Promise<readonly QueueStatus[] | undefined>;
}
export type QueueReuse = { reused: true; pullRequest: number; mergeCommit: string; runUrl: string } | { reused: false; reason: string };

/** The pull request a merge-queue branch holds, from merge_group.head_ref; undefined when it is not the queue's branch for mainline or code/next. */
export function queuePullRequest(headRef: string): number | undefined {
  const match = QUEUE_HEAD_REF.exec(headRef);
  return match === null ? undefined : Number(match[1]);
}

export async function findQueueReuse(input: QueueReuseInput): Promise<QueueReuse> {
  const no = (reason: string): QueueReuse => ({ reused: false, reason });
  const pullRequest = queuePullRequest(input.headRef);
  if (pullRequest === undefined) return no(`the queue's branch (${JSON.stringify(input.headRef)}) names no single pull request`);
  if (!SHA.test(input.baseSha)) return no("the queue's base is not a commit");
  if (input.git("fetch", "--no-tags", "--depth=2", "origin", `+refs/pull/${String(pullRequest)}/merge:refs/ci/queue-reuse`) === undefined) return no(`refs/pull/${String(pullRequest)}/merge could not be fetched`);
  const mergeCommit = input.git("rev-parse", "--verify", "refs/ci/queue-reuse^{commit}");
  if (mergeCommit === undefined || !SHA.test(mergeCommit)) return no("the pull request's merge commit could not be read");
  const mergeTree = input.git("rev-parse", `${mergeCommit}^{tree}`), queueTree = input.git("rev-parse", "HEAD^{tree}");
  if (mergeTree === undefined || queueTree === undefined || !SHA.test(mergeTree) || mergeTree !== queueTree) return no("the queue's code differs from what the pull request's run tested");
  if (input.git("rev-parse", `${mergeCommit}^1`) !== input.baseSha) return no("the pull request's run tested it on another base");
  if (input.git("rev-parse", "HEAD^1") !== input.baseSha) return no("the queue commit is not this pull request alone on the queue's base");
  const statuses = await input.statuses(mergeCommit);
  if (statuses === undefined) return no("GitHub's commit statuses could not be read");
  const ours = statuses.filter((status) => status.context === QUEUE_STATUS_CONTEXT).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  const latest = ours[0];
  if (latest === undefined) return no(`the merge commit has no ${QUEUE_STATUS_CONTEXT} status`);
  if (latest.creator?.login !== QUEUE_STATUS_CREATOR) return no(`the newest ${QUEUE_STATUS_CONTEXT} status was not set by ${QUEUE_STATUS_CREATOR}`);
  if (latest.state !== "success") return no(`the newest ${QUEUE_STATUS_CONTEXT} status is ${JSON.stringify(latest.state)}, not success`);
  const runUrl = latest.target_url ?? "";
  if (!new RegExp(`^https://github\\.com/${input.repository.replace(/[.]/gu, "\\.")}/actions/runs/[0-9]+$`, "u").test(runUrl)) return no("the status names no run of this repository");
  return { reused: true, pullRequest, mergeCommit, runUrl };
}

/** The plan of a reuse: only the plan and the gate run. */
export function queueReuseOutputs(runUrl: string): Record<string, string> {
  return { mode: "reuse", docs_only: "false", tests: "none", shards: "[1]", lint: "none", linux: "false", device: "false", device_required: "false", release: "false", reuse_run: runUrl };
}

function gitOutput(...args: string[]): string | undefined {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).trim(); } catch { return undefined; }
}

/**
 * #1278: where a run's test shards run. CodeBuild (faster, paid) only for a pull request into mainline from this repository that carries the `urgent` label,
 * or mainline's merge-queue run whose pull request carries it (#1295: never code/next's); every other run uses GitHub's free runners. The labels are the ones the run starts with: adding
 * the label starts a run (the `labeled` event) on CodeBuild, removing it sends later runs back. A fork never gets CodeBuild (`sameRepo`), and a
 * merge-queue run whose labels cannot be read uses GitHub's runners.
 */
export const URGENT_LABEL = "urgent";
export type TestRunner = "codebuild" | "github";
export function testRunner(input: { event: string; baseRef: string; sameRepo: boolean; labels: readonly string[] }): TestRunner {
  const urgent = input.labels.includes(URGENT_LABEL);
  const mainline = input.baseRef.replace(/^refs\/heads\//u, "") === "mainline";
  if (input.event === "pull_request") return urgent && input.sameRepo && mainline ? "codebuild" : "github";
  if (input.event === "merge_group") return urgent && mainline ? "codebuild" : "github";
  return "github";
}
/** #1278: the labels of a merge-queue run's pull request, or undefined when they cannot be read (the run then uses GitHub's runners). */
export function githubIssueLabels(repository: string, token: string, fetchFn: typeof fetch = fetch): (pullRequest: number) => Promise<string[] | undefined> {
  return async (pullRequest) => {
    try {
      const answer = await fetchFn(`https://api.github.com/repos/${repository}/issues/${String(pullRequest)}/labels?per_page=100`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!answer.ok) return undefined;
      const body: unknown = await answer.json();
      if (!Array.isArray(body)) return undefined;
      return body.map((label: unknown) => (label !== null && typeof label === "object" ? (label as { name?: unknown }).name : undefined)).filter((name): name is string => typeof name === "string");
    } catch {
      return undefined;
    }
  };
}
/** #1278: the runner for this run, with the labels a merge-queue run reads from its pull request. */
export async function chooseTestRunner(input: { event: string; baseRef: string; sameRepo: boolean; labels: readonly string[]; queueHeadRef: string; queueLabels: (pullRequest: number) => Promise<string[] | undefined> }): Promise<{ runner: TestRunner; reason: string }> {
  if (input.event === "merge_group") {
    const pullRequest = queuePullRequest(input.queueHeadRef);
    const labels = pullRequest === undefined ? undefined : await input.queueLabels(pullRequest).catch(() => undefined);
    if (labels === undefined) return { runner: "github", reason: "the merge queue's pull request or its labels could not be read" };
    const runner = testRunner({ ...input, labels });
    return { runner, reason: `the merge queue's pull request #${String(pullRequest)} ${runner === "codebuild" ? "is" : "is not"} labelled ${URGENT_LABEL}` };
  }
  const runner = testRunner(input);
  return { runner, reason: runner === "codebuild" ? `a pull request into mainline labelled ${URGENT_LABEL}` : `not an ${URGENT_LABEL} pull request into mainline from this repository` };
}

function githubStatuses(repository: string, token: string): (sha: string) => Promise<readonly QueueStatus[] | undefined> {
  return async (sha) => {
    try {
      const answer = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/statuses?per_page=100`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!answer.ok) return undefined;
      const body: unknown = await answer.json();
      return Array.isArray(body) ? (body as QueueStatus[]) : undefined;
    } catch {
      return undefined;
    }
  };
}

function testFiles(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [nested, source] of testFiles(path)) sources.set(nested, source);
    else if (entry.name.endsWith(".test.ts")) sources.set(path.replaceAll("\\", "/"), readFileSync(path, "utf8"));
  }
  return sources;
}

/** The workspace packages under packages/, with the workspace packages each depends on. */
export function readPackages(root: string): PackageInfo[] {
  interface Manifest { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const manifests = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: `packages/${entry.name}`, manifest: JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) as Manifest }));
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map(({ dir, manifest }) => ({
    dir,
    name: manifest.name,
    dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((dependency) => names.has(dependency)),
  }));
}

// Usage: CI_EVENT=<event> [CI_LABELS=<JSON array>] [CI_TITLE=<title>] node scripts/ci-plan.ts <file listing the changed paths, one per line>
// Writes the outputs to $GITHUB_OUTPUT and, when CI_EXTRA_TESTS names a file, the extra test files (one per line) to it.
if (process.argv[1]?.endsWith("ci-plan.ts")) {
  const listed = process.argv[2];
  const event = process.env.CI_EVENT ?? "";
  if (listed === undefined || event === "") throw new Error("usage: CI_EVENT=<event> node scripts/ci-plan.ts <changed-files list>");
  const labels = ((): string[] => {
    try { return (JSON.parse(process.env.CI_LABELS || "[]") as unknown[]).filter((label): label is string => typeof label === "string"); } catch { return []; }
  })();
  // #1262: a merge-queue run of byte-identical code stands on the pull request's own pass.
  const token = process.env.GH_TOKEN ?? "", repository = process.env.CI_REPOSITORY ?? "";
  // #1278: CodeBuild only for an urgent pull request into mainline (or its merge-queue run); written before any early exit, so every plan names its runner.
  const baseRefPlain = (process.env.CI_BASE_REF ?? "").replace(/^refs\/heads\//u, "");
  const chosen = await chooseTestRunner({ event, baseRef: baseRefPlain, sameRepo: process.env.CI_SAME_REPO === "true", labels, queueHeadRef: process.env.CI_QUEUE_HEAD_REF ?? "",
    queueLabels: token === "" || repository === "" ? async () => undefined : githubIssueLabels(repository, token) });
  console.log(`Test runner: ${chosen.runner} (${chosen.reason}).`);
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `runner=${chosen.runner}\n`);
  if (event === "merge_group") {
    const reuse = token === "" || repository === "" ? { reused: false as const, reason: "no GitHub token for this run" }
      : await findQueueReuse({ repository, headRef: process.env.CI_QUEUE_HEAD_REF ?? "", baseSha: process.env.BASE_SHA ?? "", git: gitOutput, statuses: githubStatuses(repository, token) }).catch((): QueueReuse => ({ reused: false, reason: "the reuse check failed" }));
    if (reuse.reused) {
      console.log(`CI mode: reuse (the queue's code is byte-for-byte pull request #${String(reuse.pullRequest)}'s merge commit ${reuse.mergeCommit}, which ${reuse.runUrl} tested and passed; only the plan and the gate run).`);
      if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(queueReuseOutputs(reuse.runUrl)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
      if (process.env.CI_EXTRA_TESTS !== undefined) writeFileSync(process.env.CI_EXTRA_TESTS, "");
      process.exit(0);
    }
    console.log(`No reuse: ${reuse.reason}.`);
  }
  const changed = readFileSync(listed, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const plan = planCi({ event, labels, title: process.env.CI_TITLE ?? "", changed, testSources: new Map([...testFiles("tests"), ...testFiles("packages")]), packages: readPackages("."), forceLinux: process.env.CI_FORCE_LINUX === "true" , baseRef: (process.env.CI_BASE_REF ?? "").replace(/^refs\/heads\//u, "") });
  console.log(`CI mode: ${plan.mode} (${plan.modeReason}).`);
  console.log(plan.docsOnly
    ? `Markdown-only change: ${plan.testsReason}; nothing but this plan runs.`
    : `tests: ${plan.tests} (${plan.testsReason}), ${plan.shards} shard(s); lint: ${plan.lint}; linux-runtime: ${plan.linux}; device-runtime: ${plan.device} (${plan.deviceRequired ? "required: device code changed" : "non-blocking"}); release: ${plan.release}; ${plan.extraTests.length} extra test file(s).`);
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(planOutputs(plan)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  if (process.env.CI_EXTRA_TESTS !== undefined) writeFileSync(process.env.CI_EXTRA_TESTS, plan.extraTests.map((file) => `${file}\n`).join(""));
}
