// CI's plan (DEC 242). One small job runs this first and every other job reads its answers, so a pull request spends runner time only on what its change can
// affect, while a FULL run (everything, as before) stays available and is the one a merge needs.
//
// FULL mode: a push to code/next, a manual run, a pull request labelled `full-ci`, or one whose title starts with "Batch " or "Sync mainline". It runs every job
// in full: all test shards, the whole lint and the release check (the device emulator check only on a push or a "Batch " pull request; see DEVICE_PATTERNS). The `ci-mode (full)` check exists only then.
// AFFECTED mode (a pull request, the default): the typecheck stays full; the tests are the ones the change can reach (vitest --changed plus the tests that name a
// changed file or one of the packages it touches), in 2 shards; lint covers the lint shards that hold changed files; the Linux runtime, device emulator and release checks run only
// when files in their area change (the device emulator check: only device code, DEC 254zn); a Markdown-only change that no test reads runs nothing but the plan. Anything shared (vitest config, package.json, the lockfile,
// tests/support, the workflow) falls back to the whole test suite, and the lint settings to the whole lint.
//
// The Linux runtime check (#1185, #1192) is the slowest job (~26 min) and no longer runs in CI, for mainline or code/next: only a manual run's `linux` input
// runs it here. The production release runs it on a temporary EC2 machine instead (#1192).
//
// Node runs this file directly, before `npm ci`, so it imports only Node's own modules and uses only erasable syntax. (The docs-only rule that lived in
// scripts/ci-docs-only.ts is here now.)
import { spawnSync } from "node:child_process";
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
  /** Repository paths changed by the pull request; unused outside a pull request. */
  changed: readonly string[];
  /** Every test file's source, by repository path. */
  testSources: ReadonlyMap<string, string>;
  packages: readonly PackageInfo[];
  /** A manual run asked for the Linux runtime check (workflow_dispatch input `linux`). */
  forceLinux?: boolean;
  /** #1189: the pull request's base branch (github.base_ref); empty or absent outside a pull request. */
  baseRef?: string;
}

export const FULL_LABEL = "full-ci";
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
  if (input.event !== "pull_request") return `${input.event} runs everything`;
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
 * #1185, #1192: whether the Linux runtime check runs in CI: only for a manual run that asks for it (its `linux` input).
 */
export function linuxRuns(input: Pick<PlanInput, "event" | "forceLinux">): boolean {
  // #1192 (owner decision 2026-11-19): the Linux runtime check no longer runs in CI, for mainline or code/next: not on a pull request, a push, a label or the
  // nightly run. It runs in the production release instead (the release pipeline's build, before the deploy). Only a manual run that asks for it (the
  // workflow_dispatch input `linux`) still runs it here, for debugging.
  return input.event === "workflow_dispatch" && input.forceLinux === true;
}

export function planCi(input: PlanInput): Plan {
  const deviceRequired = input.changed.some((file) => anyMatch(file, DEVICE_PATTERNS));
  const deviceFull = DEVICE_FULL_EVENTS.includes(input.event) || (input.event === "pull_request" && input.title.startsWith(DEVICE_FULL_TITLE_PREFIX));
  // #1185: the nightly run is the device emulator check (non-blocking, as DEC 254zn had it for a scheduled run), not a second full suite: the typecheck still runs in
  // `quick`, but no tests, lint or release check. #1192: no Linux runtime check either (the production release runs it).
  if (input.event === "schedule") {
    return { mode: "affected", modeReason: "the nightly run", docsOnly: false, tests: "none", testsReason: "the nightly run checks the device emulator only", shards: 1, lint: "none", linux: linuxRuns(input), device: true, deviceRequired: false, release: false, extraTests: [] };
  }
  const reason = fullReason(input);
  if (reason !== undefined) {
    return { mode: "full", modeReason: reason, docsOnly: false, tests: "all", testsReason: "FULL mode", shards: FULL_SHARDS, lint: "all", linux: linuxRuns(input), device: deviceRequired || deviceFull, deviceRequired, release: true, extraTests: [] };
  }
  const { changed } = input;
  const docs = docsOnlyChange(changed, input.testSources);
  if (docs.docsOnly) {
    return { mode: "affected", modeReason: "a pull request", docsOnly: true, tests: "none", testsReason: docs.reason, shards: 1, lint: "none", linux: false, device: false, deviceRequired: false, release: false, extraTests: [] };
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
  const lint: Scope = changed.length === 0 || changed.some((file) => anyMatch(file, SHARED_LINT_PATTERNS)) ? "all" : changed.some((file) => /\.ts$/.test(file)) ? "changed" : "none";
  return {
    mode: "affected",
    modeReason: "a pull request",
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

// ---- #1181: reuse a full pass of byte-identical code -------------------------------------------------------------------------------------------------------
//
// A pull request whose code is exactly what an earlier FULL push run of this workflow tested and passed (a pinned code/next -> mainline pull request, a sync) does not
// run the suite again. The proof, all of it required, everything else plans as before:
//   - this is a pull request (never a push, a manual run or the nightly schedule) without the `full-ci` label, and the tree this run tests (the merge commit) is byte-for-byte the pull request head's tree (the pull request is up to date);
//   - a DIFFERENT run of this workflow (.github/workflows/ci.yml), triggered by a push of exactly that head commit (so it tested exactly that tree), has, among its own
//     GitHub Actions check runs on that commit, the latest `local`, `ci-mode (full)` and every `test (n/8)` completed with success: a full run that passed as a whole
//     (a run that itself reused something has no test shards, so a reuse is never reused);
//   - GitHub answers every read in time. Any refusal, rate limit, timeout or doubt: no reuse.
// Reuse runs the plan, `ci-mode (full)`, port-guard and the gate; quick, build, the test shards and the runtime checks are skipped. The gate names the reused run.

export interface ReuseCheckRun { id: number; name: string; status: string; conclusion: string | null; html_url?: string | null; app?: { slug?: string } | null }
export interface ReuseRun { id: number; event: string; head_sha: string; path: string }
export type Reuse = { runUrl: string; runId: number } | undefined;
const RUN_OF_JOB = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/\d+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
// Not `linux-runtime`: CI no longer runs it (#1192, it runs on manual request only), so a push run skips it and there is no result to stand on.
export const REUSE_REQUIRED_CHECKS = ["local", "ci-mode (full)", ...Array.from({ length: FULL_SHARDS }, (_, index) => `test (${index + 1}/${FULL_SHARDS})`)];

/** The runs (ids) among these check runs whose own latest `local`, `ci-mode (full)` and test shards all completed with success; never `currentRunId`. Newest first. */
export function passedFullRuns(runs: readonly ReuseCheckRun[], currentRunId: number): number[] {
  const byRun = new Map<number, Map<string, ReuseCheckRun>>();
  for (const run of runs) {
    if (run.app?.slug !== "github-actions") continue;
    const match = RUN_OF_JOB.exec(run.html_url ?? "");
    if (match === null) continue;
    const runId = Number(match[1]);
    if (!Number.isSafeInteger(runId) || runId === currentRunId) continue;
    const latest = byRun.get(runId) ?? new Map<string, ReuseCheckRun>();
    const seen = latest.get(run.name);
    if (seen === undefined || run.id > seen.id) latest.set(run.name, run);
    byRun.set(runId, latest);
  }
  return [...byRun.entries()]
    .filter(([, latest]) => REUSE_REQUIRED_CHECKS.every((name) => { const run = latest.get(name); return run !== undefined && run.status === "completed" && run.conclusion === "success"; }))
    .map(([runId]) => runId)
    .sort((a, b) => b - a);
}

export interface ReuseInput {
  event: string;
  labels: readonly string[];
  headSha: string;
  currentRunId: number;
  repository: string;
  treeOf: (rev: string) => string | undefined;
  checkRuns: (sha: string) => Promise<ReuseCheckRun[] | undefined>;
  workflowRun: (runId: number) => Promise<ReuseRun | undefined>;
}

/** A full pass of byte-identical code this pull request's run may stand on, or undefined (then the run plans as before). Never throws. */
export async function findReuse(input: ReuseInput): Promise<Reuse> {
  try {
    // A pull request only: never a push, a manual run, or the nightly schedule. The `full-ci` label asks for a real run.
    if (input.event !== "pull_request" || input.labels.includes(FULL_LABEL)) return undefined;
    if (!SHA_PATTERN.test(input.headSha) || !Number.isSafeInteger(input.currentRunId) || input.currentRunId <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)) return undefined;
    const tested = input.treeOf("HEAD"); const head = input.treeOf(input.headSha);
    if (tested === undefined || head === undefined || tested !== head) return undefined;
    const runs = await input.checkRuns(input.headSha);
    if (runs === undefined) return undefined;
    for (const runId of passedFullRuns(runs, input.currentRunId)) {
      const run = await input.workflowRun(runId);
      if (run !== undefined && run.id === runId && run.event === "push" && run.head_sha === input.headSha && run.path === ".github/workflows/ci.yml") {
        return { runId, runUrl: `https://github.com/${input.repository}/actions/runs/${runId}` };
      }
    }
    return undefined;
  } catch { return undefined; }
}

/** The plan of a reuse: only the plan, `ci-mode (full)`, port-guard and the gate run. */
export function reusePlanOutputs(reuse: NonNullable<Reuse>): Record<string, string> {
  return { mode: "reuse", docs_only: "false", tests: "none", shards: "[1]", lint: "none", linux: "false", device: "false", device_required: "false", release: "false", reuse_run: reuse.runUrl };
}

/** GitHub's REST API with the run's own token; ten seconds a read, then unknown. */
function githubReads(repository: string, token: string): Pick<ReuseInput, "checkRuns" | "workflowRun"> {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rovara-ci-plan", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return await response.json();
  };
  return {
    checkRuns: async (sha) => {
      const runs: ReuseCheckRun[] = [];
      for (let page = 1; page <= 3; page++) {
        const body = await read(`commits/${sha}/check-runs?per_page=100&page=${page}`) as { check_runs?: unknown; total_count?: unknown };
        if (!Array.isArray(body.check_runs)) return undefined;
        runs.push(...body.check_runs as ReuseCheckRun[]);
        if (typeof body.total_count !== "number" || runs.length >= body.total_count) return runs;
      }
      return undefined;
    },
    workflowRun: async (runId) => {
      const body = await read(`actions/runs/${runId}`) as Partial<ReuseRun>;
      return typeof body.id === "number" && typeof body.event === "string" && typeof body.head_sha === "string" && typeof body.path === "string" ? body as ReuseRun : undefined;
    },
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
  // #1181: a pull request whose exact code already passed a full push run stands on that run.
  const token = process.env.GH_TOKEN ?? "", repository = process.env.GITHUB_REPOSITORY ?? "";
  const reuse = token === "" ? undefined : await findReuse({
    event, labels, headSha: process.env.CI_HEAD_SHA ?? "", currentRunId: Number(process.env.GITHUB_RUN_ID ?? "0"), repository,
    treeOf: (rev) => { const out = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], { encoding: "utf8" }); return out.status === 0 ? out.stdout.trim() : undefined; },
    ...githubReads(repository, token),
  });
  if (reuse !== undefined) {
    console.log(`CI mode: reuse (this code is byte-for-byte what ${reuse.runUrl} tested in full and passed; only the plan, ci-mode (full), port-guard and the gate run).`);
    if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(reusePlanOutputs(reuse)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
    if (process.env.CI_EXTRA_TESTS !== undefined) writeFileSync(process.env.CI_EXTRA_TESTS, "");
    process.exit(0);
  }
  const changed = readFileSync(listed, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const plan = planCi({ event, labels, title: process.env.CI_TITLE ?? "", changed, testSources: new Map([...testFiles("tests"), ...testFiles("packages")]), packages: readPackages("."), forceLinux: process.env.CI_FORCE_LINUX === "true" , baseRef: process.env.CI_BASE_REF ?? "" });
  console.log(`CI mode: ${plan.mode} (${plan.modeReason}).`);
  console.log(plan.docsOnly
    ? `Markdown-only change: ${plan.testsReason}; nothing but this plan runs.`
    : `tests: ${plan.tests} (${plan.testsReason}), ${plan.shards} shard(s); lint: ${plan.lint}; linux-runtime: ${plan.linux}; device-runtime: ${plan.device} (${plan.deviceRequired ? "required: device code changed" : "non-blocking"}); release: ${plan.release}; ${plan.extraTests.length} extra test file(s).`);
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(planOutputs(plan)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  if (process.env.CI_EXTRA_TESTS !== undefined) writeFileSync(process.env.CI_EXTRA_TESTS, plan.extraTests.map((file) => `${file}\n`).join(""));
}
