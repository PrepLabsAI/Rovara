import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeP0Files = [
  "tests/e2e/m1-web-journey.test.ts",
  "tests/e2e/m1-3-journeys.test.ts",
  "tests/e2e/project-setup-terminal-authority-fix1.test.ts",
  "tests/e2e/p0-native-journey.test.ts",
  "tests/e2e/runtime-installation-qualification.native.test.ts",
  "tests/e2e/m1-4-journeys.test.ts",
];

// Tests too slow for every full run. `npm test` leaves them out, except in a pull request's "the ones this change can reach" run (ROVARA_NIGHTLY_TESTS=1 in
// ci.yml), which runs one only when the change reaches it. CI's nightly job and every release run them all (`npm run test:nightly`).
// eval-question-simulation: about 8 minutes of one-thread Monte Carlo that checks the eval check's false-alarm rate and power (packages/contracts/src/eval-check.ts).
// worker-env-detect-growth (#1236): about 7.5 minutes timing every environment detector on hostile files of growing size, so no pattern backtracks
// catastrophically (packages/worker/src/env-detect/).
// worker-env-detect-redos (#1256): about 160 s, the same detectors on every file kind filled to the 256 KiB read limit with hostile bodies. Split from
// worker-env-detect-hardening, whose fast security checks (userinfo, variable names, key-shaped resource names) still run in every run.
// local-up-flow: a whole task through `rovara up` on SQLite against a fake worker (243 tests, about 4 minutes).
// workflow-e2e/*: the hosted task lifecycle, suite by suite, against fakes (about 17 minutes in all). Every file in the folder, new ones included.
const WORKFLOW_E2E_DIR = "tests/integration/workflow-e2e";
const workflowE2eFiles = readdirSync(fileURLToPath(new URL(`../../${WORKFLOW_E2E_DIR}`, import.meta.url)))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `${WORKFLOW_E2E_DIR}/${name}`);

export const nightlyOnlyFiles = [
  "tests/unit/eval-question-simulation.test.ts",
  "tests/unit/worker-env-detect-growth.test.ts",
  "tests/unit/worker-env-detect-redos.test.ts",
  "tests/unit/local-up-flow.test.ts",
  ...workflowE2eFiles,
];

// #1242: integration journeys that belong after a deployed beta environment in the release pipeline, not on code merge. Until that stage exists they
// run only in CI's nightly job: unlike nightlyOnlyFiles, no pull request or push run includes them, not even when the change reaches them.
// slack-workflow-e2e: 32 Slack-to-draft-pull-request journeys in one process (about 115 s).
export const postDeployFiles = [
  "tests/integration/slack-workflow-e2e.test.ts",
  // #1272: more integration journeys, about 7.5 test-minutes in all: the real `rovara up` task flow under attack (stage-selection-adversarial), pull
  // request publication and maintenance against real local git remotes, the worker's real session rerunning checks, the install qualification web
  // journey, and the workflow-e2e harness's own self-tests (its suites are already nightly).
  "tests/unit/stage-selection-adversarial.test.ts",
  "tests/integration/pull-request-publication.test.ts",
  "tests/integration/worker-verification.test.ts",
  "tests/unit/install-qualification-web.test.ts",
  "tests/contract/workflow-e2e-harness.test.ts",
  "tests/integration/pull-request-maintenance.test.ts",
];

// Test files that mock modules (vi.mock, vi.doMock, vi.unmock, vi.importMock, vi.resetModules), or import a helper under tests/ that does (directly or through
// other helpers), need a fresh module graph: with shared modules an earlier file has already loaded the real module, so the mock would not take effect, and a
// mock a file sets up would stay for the files after it. They run in the "fresh-modules" project (vitest.config.ts); every other file runs in "shared-modules",
// where one worker loads each module once for all its files. Found from the files' own source, so a new file is placed without a list to edit.
// The files that time work against itself (tests/support/scaling.ts: N against 8N) also keep a fresh worker: a heap that holds every module the worker has
// loaded makes garbage collection pauses longer, and a pause in the 8N run reads as work that grew faster than linear.
const TIMING_HELPER = "tests/support/scaling.ts";
// A file can also ask for one itself, with this comment line, when what it tests is how modules load or it reads state no other rule here finds.
const ASKS_FOR_FRESH_MODULES = /^\/\/ vitest: fresh-modules\b/mu;
const MOCKS_MODULES = /\bvi\.(?:mock|doMock|unmock|importMock|resetModules)\(/;
const LOCAL_IMPORT = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
function filesUnder(directory: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(`${REPOSITORY_ROOT}${relative}`, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (keep(entry.name)) found.push(path);
    }
  };
  walk(directory);
  return found;
}
const sourceOf = (file: string): string => readFileSync(`${REPOSITORY_ROOT}${file}`, "utf8");
/** The files under tests/ that `file` imports by a relative path (".js" in an import names the ".ts" beside it). */
function localImports(file: string): string[] {
  const directory = posix.dirname(file);
  return [...sourceOf(file).matchAll(LOCAL_IMPORT)]
    .map((match) => posix.normalize(posix.join(directory, (match[1] ?? match[2])!)).replace(/\.js$/u, ".ts"))
    .filter((path) => path.startsWith("tests/"));
}
function moduleMockingTestFiles(): string[] {
  const helpers = filesUnder("tests", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const helperSet = new Set(helpers);
  // A helper mocks when it calls a mock itself or imports a helper that does: repeat until no helper is added.
  const mocking = new Set(helpers.filter((file) => MOCKS_MODULES.test(sourceOf(file))));
  for (let added = true; added;) {
    added = false;
    for (const helper of helpers) {
      if (!mocking.has(helper) && localImports(helper).some((path) => helperSet.has(path) && mocking.has(path))) { mocking.add(helper); added = true; }
    }
  }
  return ["tests", "packages"].flatMap((directory) => filesUnder(directory, (name) => name.endsWith(".test.ts")))
    .filter((file) => MOCKS_MODULES.test(sourceOf(file)) || ASKS_FOR_FRESH_MODULES.test(sourceOf(file)) || localImports(file).some((path) => mocking.has(path) || path === TIMING_HELPER))
    .sort();
}
export const moduleMockingFiles = moduleMockingTestFiles();

// A worker that shares modules keeps every module its files load, so one group for every shared file grew a worker past CI's heap. The shared files are
// split into groups by the package they load (vitest gives each group its own workers and stops them when the group ends), so each worker holds only its
// group's modules. A file goes to the first group below whose package it imports; the broker's files split further by area (the start of the file name).
const PACKAGE_IMPORT = /(?:packages\/|@agentx\/)([a-z0-9-]+)/gu;
const BROKER_WORKFLOWS_AND_SLACK = /^(?:e2e|workflow|test|task|plan|loop|design|change|action|ticket|rule|mutation|review|fix|spec|pull|evidence|baseline|stage|slack|channel|github|hosted|gateway|connector|signin|chatgpt|web|device|linear|access)-/u;
function sharedGroupOf(file: string): string {
  const packages = new Set([...sourceOf(file).matchAll(PACKAGE_IMPORT)].map((match) => match[1]!));
  const own = /^packages\/([^/]+)\//u.exec(file)?.[1];
  if (own) packages.add(own);
  if (packages.has("broker")) return BROKER_WORKFLOWS_AND_SLACK.test(posix.basename(file)) ? "broker-workflows-and-slack" : "broker-core";
  if (["worker", "model-runtime", "verifier", "mcp", "orchestrator"].some((name) => packages.has(name))) return "worker";
  if (["cli", "aws-adapters", "local-adapters", "gateway", "slack-service"].some((name) => packages.has(name))) return "cli-and-install";
  return "contracts-and-tools";
}
export const sharedGroupNames = ["broker-core", "broker-workflows-and-slack", "worker", "cli-and-install", "contracts-and-tools"] as const;
const mockingSet = new Set(moduleMockingFiles);
/** Each shared group's test files (every test file that is not in moduleMockingFiles lands in exactly one). */
export const sharedModuleGroups: Record<(typeof sharedGroupNames)[number], string[]> = Object.fromEntries(sharedGroupNames.map((name) => [name, [] as string[]])) as never;
for (const file of ["tests", "packages"].flatMap((directory) => filesUnder(directory, (name) => name.endsWith(".test.ts"))).sort()) {
  if (!mockingSet.has(file)) sharedModuleGroups[sharedGroupOf(file) as (typeof sharedGroupNames)[number]].push(file);
}

export const sharedVitestSettings = {
  coverage: { enabled: false },
  globalSetup: ["tests/support/test-temp-dir.ts"] as string[],
  passWithNoTests: false,
  testTimeout: 60_000,
  // #1263: setup and teardown hooks do the same heavy work as tests (a large import, a synth), so they get the same 60 s, not vitest's 10 s default.
  hookTimeout: 60_000,
} as const;
