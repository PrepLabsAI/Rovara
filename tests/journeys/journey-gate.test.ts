// journey-gate: gate
// The journeys' own gate (A1, plan check changes 1 and 2). It lives inside tests/journeys/ so it runs with them in every affected run, and it fails when a journey could be dropped, skipped or weakened
// without a reviewer seeing it: a missing journey, a skip, a conditional run, a bare expected failure, an exclusion from the pull request runs, a journey no plan would select, a journey missing from
// the pinned registry, a journey that never proves the core answered, or a direct import of the old engine.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { journeyTests, planCi, readTestSources } from "../../scripts/ci-plan.js";
import { moduleMockingFiles, nativeP0Files, nightlyOnlyFiles, postDeployFiles, sharedModuleGroups } from "../support/vitest-shared-config.js";
import { countRunnableTests } from "../support/pinned-tests.js";

const ROOT = join(import.meta.dirname, "../..");
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
const journeyFiles = files("tests/journeys").filter((path) => path.endsWith(".ts"));
const testFiles = journeyFiles.filter((path) => path.endsWith(".test.ts"));
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");
/** The source without its `//` comment lines, so a sentence that names a skip is not one. */
const code = (path: string): string => source(path).split("\n").filter((line) => !/^\s*\/\//u.test(line)).join("\n");

/** The ten journeys of the brief (A1), plus the three the plan check requires before D1 (11 to 13) and journey 14 (reviews in depth, D1-PLAN 5.3 G-B). D1 took journey 15 (Code's own task page, G-E) off the list with the page itself (owner DEC 254zzz511); what outlives the page is proved by A1-12's tests on the surfaces that stay. */
const JOURNEYS = ["1", "2", "3a", "3b", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"] as const;
/**
 * Journeys with no file yet, each with the reason and the lane that adds it. A row here is a known gap, visible in review; it is not a skipped test. A journey is taken off this table when its file lands, and
 * this test fails if a journey is both on the table and in a file.
 */
const KNOWN_GAPS: ReadonlyArray<{ journey: (typeof JOURNEYS)[number]; reason: string; lane: string }> = [
  { journey: "2", reason: "Slack: start, progress in the thread, a button press, merge. S1's press tests are these journeys; they move into tests/journeys/ when S1 merges (D2's release needs them here and green).", lane: "S1" },
  { journey: "5", reason: "Stop from Slack through the real interactivity handler (the web half is journey 5 in web-task.test.ts, as the file's header says). S1's S1-T0 test.", lane: "S1" },
];

const declared = (path: string): string[] => {
  const header = /^\/\/ journey-gate: (.+)$/mu.exec(source(path))?.[1];
  return header === undefined ? [] : header.split(",").map((part) => part.trim()).filter((part) => part !== "");
};
const declaredJourneys = new Set(testFiles.flatMap(declared));

describe("the journeys' gate", () => {
  it("has a file for every journey, or a named known gap for it: no journey is silently missing, and none is both", () => {
    // A header names a journey by its number: "5" in the Slack row of the table is the web half's number too, which the web file declares.
    const missing = JOURNEYS.filter((journey) => !declaredJourneys.has(journey) && !declaredJourneys.has(journey.replace(/[ab]$/u, "")) && !KNOWN_GAPS.some((gap) => gap.journey === journey));
    expect(missing, "journeys with neither a file nor a known gap").toEqual([]);
    for (const gap of KNOWN_GAPS) {
      expect(gap.reason.length, `${gap.journey}: the known gap says why`).toBeGreaterThan(40);
      if (!["2", "5"].includes(gap.journey)) expect(declaredJourneys.has(gap.journey), `${gap.journey} has a file, so it leaves the known gaps`).toBe(false);
    }
  });

  it("never skips, conditionally runs, or expects the failure of a journey: a skipped test counts as a pass", () => {
    for (const path of testFiles) {
      expect(code(path), path).not.toMatch(/\.(?:skip|only|todo|skipIf|runIf)\b|\b(?:it|test|describe)\.fails\b|\bxit\(|\bxdescribe\(|\bfit\(|\bfdescribe\(/u);
    }
  });

  it("is in the pull request runs: no journey file is in the native, nightly or post-deploy lists", () => {
    const left = new Set([...nativeP0Files, ...nightlyOnlyFiles, ...postDeployFiles]);
    expect(testFiles.filter((path) => left.has(path))).toEqual([]);
    expect(testFiles.length, "the journeys are there").toBeGreaterThanOrEqual(6);
  });

  it("is selected by the plan of any affected run, even one whose change reaches no journey", () => {
    const sources = new Map<string, string>(testFiles.map((path) => [path, source(path)]));
    sources.set("tests/unit/unrelated.test.ts", "expect(1).toBe(1);");
    const plan = planCi({ event: "pull_request", labels: [], title: "An unrelated change", changed: ["scripts/an-unrelated-tool.ts"], testSources: sources, packages: [] });
    expect(plan).toMatchObject({ mode: "affected", tests: "changed" });
    expect(plan.extraTests).toEqual(expect.arrayContaining(testFiles));
    expect(journeyTests(sources)).toEqual([...testFiles].sort());
  });

  it("the plan's own reading of the checkout (what CI builds, not a list this test made) holds exactly the journey files on disk, and is never empty", () => {
    // `readTestSources` is what ci-plan's main builds `testSources` with, from the working directory: the repository root, as `npm test` and CI run it.
    expect(process.cwd(), "the test runs from the repository root, as CI does").toBe(ROOT);
    const fromCheckout = journeyTests(readTestSources());
    expect(fromCheckout.length, "the gate is never silently empty").toBeGreaterThanOrEqual(7);
    expect(fromCheckout).toEqual([...testFiles].sort());
    const plan = planCi({ event: "pull_request", labels: [], title: "An unrelated change", changed: ["scripts/an-unrelated-tool.ts"], testSources: readTestSources(), packages: [] });
    expect(plan.extraTests).toEqual(expect.arrayContaining(fromCheckout));
  });

  it("is inside vitest's run in a whole-suite run: in a project's include, in no exclude, in no nightly or post-deploy list, and nothing under tests/journeys/ is left to the native config", () => {
    const included = new Set([...moduleMockingFiles, ...Object.values(sharedModuleGroups).flat()]);
    const excluded = new Set([...nativeP0Files, ...postDeployFiles, ...nightlyOnlyFiles]);
    for (const path of testFiles) {
      expect(included.has(path), `${path} is in a vitest project's include (vitest.config.ts: fresh-modules or a shared group)`).toBe(true);
      expect(excluded.has(path), `${path} is in none of the exclude lists`).toBe(false);
      // vitest's own default excludes are by directory name; none names a part of this path.
      expect(configDefaults.exclude.some((pattern) => pattern.includes("journeys")), "vitest's default excludes do not name journeys").toBe(false);
    }
    expect(readFileSync(join(ROOT, "vitest.config.ts"), "utf8"), "vitest.config.ts does not exclude the journeys by name").not.toMatch(/journeys/u);
    // Every journey file is in exactly one project.
    for (const path of testFiles) {
      const groups = [moduleMockingFiles.includes(path), ...Object.values(sharedModuleGroups).map((group) => group.includes(path))].filter(Boolean);
      expect(groups, `${path} is in exactly one project`).toHaveLength(1);
    }
  });

  it("is registered in the pinned test registry with a floor at its test count, so deleting or trimming a journey is a reviewed edit", () => {
    const pins = new Map((JSON.parse(source("tests/pinned-tests.json")) as { tests: Array<{ path: string; minimumTests: number }> }).tests.map((pin) => [pin.path, pin.minimumTests]));
    for (const path of testFiles) {
      expect(pins.has(path), `${path} is in tests/pinned-tests.json`).toBe(true);
      expect(pins.get(path)!, `${path}: the floor is the file's test count`).toBe(countRunnableTests(source(path), path));
    }
  });

  it("proves in every journey that the core answered: each test ends with the real-core check", () => {
    for (const path of testFiles.filter((file) => !file.endsWith("journey-gate.test.ts"))) {
      const tests = countRunnableTests(source(path), path);
      const checks = code(path).match(/\bassertAllCore\(/gu)?.length ?? 0;
      expect(checks, `${path}: ${String(tests)} tests, ${String(checks)} real-core checks`).toBe(tests);
    }
  });

  it("never imports the old workflow engine's files directly (the broker's HTTP front, which holds both engines, is the one shared door)", () => {
    for (const path of journeyFiles) {
      expect(code(path), path).not.toMatch(/from\s+["'][^"']*(?:aws\/workflow-|aws\/slack-workflow|support\/workflow-e2e)/u);
    }
  });
});
