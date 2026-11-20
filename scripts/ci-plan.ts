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
// The Linux runtime check (#1185) is the slowest job (~26 min) and runs in neither mode by default: it runs when its area changes (LINUX_PATTERNS), once per batch
// (each push to code/next), every night (the scheduled run, which runs it and nothing else heavy), and on request (the `linux-ci` or `full-ci` label, or a manual
// run's `linux` input). A FULL pull request ("Batch ...", "Sync mainline ...") whose change does not reach its area does not run it: that tree is checked on
// code/next's push or that night.
//
// Node runs this file directly, before `npm ci`, so it imports only Node's own modules and uses only erasable syntax. (The docs-only rule that lived in
// scripts/ci-docs-only.ts is here now.)
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
/** #1185: a pull request labelled like this runs the Linux runtime check whatever it changes. */
export const LINUX_LABEL = "linux-ci";
/** #1185, #1189: runs that always run the Linux runtime check: the nightly scheduled run on mainline. Not a push: CI's pushes are code/next's, and the owner
 * decided (2026-11-19) the check guards what goes into mainline (which deploys), not code/next. */
export const LINUX_EVENTS: readonly string[] = ["schedule"];
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
 * #1185: whether the Linux runtime check runs: once per batch and every night (LINUX_EVENTS), on request (the `linux-ci` or `full-ci` label, a manual run's
 * input), and when the change reaches its area (LINUX_PATTERNS), including a pull request whose changed-file list is empty (unknown, so it runs).
 */
export function linuxRuns(input: Pick<PlanInput, "event" | "labels" | "changed" | "forceLinux" | "baseRef">): boolean {
  if (LINUX_EVENTS.includes(input.event) || input.forceLinux === true) return true;
  if (input.labels.includes(LINUX_LABEL) || input.labels.includes(FULL_LABEL)) return true;
  if (input.event !== "pull_request") return false;
  // #1189: only a pull request into mainline (an unknown base runs it: never skip on doubt), never one into code/next.
  if (input.baseRef !== undefined && input.baseRef !== "" && input.baseRef !== LINUX_BASE_BRANCH) return false;
  return input.changed.length === 0 || input.changed.some((file) => anyMatch(file, LINUX_PATTERNS));
}

export function planCi(input: PlanInput): Plan {
  const deviceRequired = input.changed.some((file) => anyMatch(file, DEVICE_PATTERNS));
  const deviceFull = DEVICE_FULL_EVENTS.includes(input.event) || (input.event === "pull_request" && input.title.startsWith(DEVICE_FULL_TITLE_PREFIX));
  // #1185: the nightly run is the Linux runtime check (and the device emulator check, non-blocking, as DEC 254zn had it for a scheduled run), not a second full suite:
  // the typecheck still runs in `quick`, but no tests, lint or release check. Mainline's merges were tested by their own runs.
  if (input.event === "schedule") {
    return { mode: "affected", modeReason: "the nightly Linux runtime run", docsOnly: false, tests: "none", testsReason: "the nightly run checks the Linux runtime only", shards: 1, lint: "none", linux: true, device: true, deviceRequired: false, release: false, extraTests: [] };
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
  const changed = readFileSync(listed, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const plan = planCi({ event, labels, title: process.env.CI_TITLE ?? "", changed, testSources: new Map([...testFiles("tests"), ...testFiles("packages")]), packages: readPackages("."), forceLinux: process.env.CI_FORCE_LINUX === "true" , baseRef: process.env.CI_BASE_REF ?? "" });
  console.log(`CI mode: ${plan.mode} (${plan.modeReason}).`);
  console.log(plan.docsOnly
    ? `Markdown-only change: ${plan.testsReason}; nothing but this plan runs.`
    : `tests: ${plan.tests} (${plan.testsReason}), ${plan.shards} shard(s); lint: ${plan.lint}; linux-runtime: ${plan.linux}; device-runtime: ${plan.device} (${plan.deviceRequired ? "required: device code changed" : "non-blocking"}); release: ${plan.release}; ${plan.extraTests.length} extra test file(s).`);
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(planOutputs(plan)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  if (process.env.CI_EXTRA_TESTS !== undefined) writeFileSync(process.env.CI_EXTRA_TESTS, plan.extraTests.map((file) => `${file}\n`).join(""));
}
