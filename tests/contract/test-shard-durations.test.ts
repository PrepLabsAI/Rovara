// CI's eight test shards (a full run) are balanced by recorded run time, not by file count (owner decision "CI cost", 2026-11-02). These tests pin the split: every
// test file lands in exactly one shard, the split is the same on every machine, the checked-in timings keep the shards close to equal, and the
// vitest config and the workflow use it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import config from "../../vitest.config.js";
import { durationsFromReport, median, renderTimings } from "../../scripts/test-shard-timings.js";
import { DurationSequencer } from "../support/duration-sequencer.js";
import { MIN_WEIGHT_SECONDS, TIMINGS_PATH, loadTimings, parseTimings, planShards, shardTotals, weightOf } from "../support/duration-shards.js";
import { FULL_SHARDS } from "../../scripts/ci-plan.js";
import { nativeP0Files, nightlyOnlyFiles } from "../support/vitest-shared-config.js";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "cypress", ".git", ".test-build"]);

/** Every file the root vitest config includes: tests/**\/*.test.ts and packages/**\/*.test.ts, minus node_modules, dist and the native journeys. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (SKIPPED_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".test.ts")) found.push(relative(".", path).replaceAll("\\", "/"));
    }
  };
  walk("tests");
  walk("packages");
  return found.filter((file) => !nativeP0Files.includes(file) && !nightlyOnlyFiles.includes(file)).sort();
}

const SHARDS = 8;
const files = testFiles();
const timings = loadTimings(TIMINGS_PATH);

describe("the duration-balanced test shards", () => {
  it("find the test files the root vitest config runs", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("tests/contract/test-shard-durations.test.ts");
    expect(files).not.toContain("tests/e2e/m1-web-journey.test.ts");
  });

  it("give every test file to exactly one of the eight shards", () => {
    const plan = planShards(files, timings, SHARDS);
    expect(plan).toHaveLength(SHARDS);
    expect(plan.flat().sort()).toEqual(files);
    expect(new Set(plan.flat()).size).toBe(files.length);
    for (const shard of plan) expect(shard.length).toBeGreaterThan(0);
  });

  it("make the same split for the same input, whatever order the files come in", () => {
    const plan = planShards(files, timings, SHARDS);
    expect(planShards([...files].reverse(), timings, SHARDS)).toEqual(plan);
    expect(planShards(files, { ...timings, files: { ...timings.files } }, SHARDS)).toEqual(plan);
  });

  it("keep the slowest shard within 5 percent of the mean, by the checked-in timings", () => {
    const totals = shardTotals(planShards(files, timings, SHARDS), timings);
    const mean = totals.reduce((sum, total) => sum + total, 0) / SHARDS;
    expect(Math.max(...totals) / mean).toBeLessThan(1.05);
    expect(Math.min(...totals) / mean).toBeGreaterThan(0.95);
  });

  it("weigh a file the timings do not list at the default, and never below the floor", () => {
    expect(weightOf("tests/unit/new-file.test.ts", timings)).toBe(Math.max(MIN_WEIGHT_SECONDS, timings.defaultSeconds));
    expect(weightOf("a.test.ts", { defaultSeconds: 3, files: { "a.test.ts": 0 } })).toBe(MIN_WEIGHT_SECONDS);
    const plan = planShards([...files, "tests/unit/new-file-a.test.ts", "tests/unit/new-file-b.test.ts"], timings, SHARDS);
    expect(plan.flat()).toHaveLength(files.length + 2);
  });

  it("split a short list by weight: the heaviest file gets a shard to itself", () => {
    const small = { defaultSeconds: 1, files: { "big.test.ts": 100, "a.test.ts": 30, "b.test.ts": 30, "c.test.ts": 30, "d.test.ts": 10 } };
    expect(planShards(Object.keys(small.files), small, 2)).toEqual([["big.test.ts"], ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]]);
    expect(planShards(["x.test.ts", "y.test.ts"], { defaultSeconds: 1, files: {} }, 1)).toEqual([["x.test.ts", "y.test.ts"]]);
    expect(() => planShards(files, timings, 0)).toThrow(/positive integer/);
  });

  it("are what vitest's --shard takes: the sequencer returns one share per shard, and the eight shares are the whole list once", async () => {
    const specs = files.map((file) => ({ moduleId: join(process.cwd(), file) }));
    const shares: string[][] = [];
    for (let index = 1; index <= SHARDS; index++) {
      const sequencer = new DurationSequencer({ config: { root: process.cwd(), shard: { index, count: SHARDS } } } as never);
      const share = await sequencer.shard(specs as never);
      shares.push(share.map((spec) => relative(".", (spec as { moduleId: string }).moduleId)));
    }
    expect(shares.flat().sort()).toEqual(files);
    expect(shares.map((share) => share.length)).toEqual(planShards(files, timings, SHARDS).map((shard) => shard.length));
  });

  it("is the sequencer of the root vitest config, which is the one `npm test` runs", () => {
    expect(config.test?.sequence?.sequencer).toBe(DurationSequencer);
  });

  it("matches the full run's eight shards of the CI workflow, whose matrix comes from the plan, and `npm test` takes its shard from that matrix", () => {
    const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: { test: { strategy: { matrix: { shard: string } }; steps: { run?: string }[] } } };
    expect(workflow.jobs.test.strategy.matrix.shard).toBe("${{ fromJSON(needs.plan.outputs.shards) }}");
    expect(FULL_SHARDS).toBe(SHARDS);
    expect(workflow.jobs.test.steps.some((step) => (step.run ?? "").includes("--shard=${{ matrix.shard }}/${{ strategy.job-total }}"))).toBe(true);
  });
});

describe("the checked-in timings", () => {
  it("are well formed and cover almost every test file (regenerate with scripts/test-shard-timings.ts when many files are new)", () => {
    const parsed = parseTimings(readFileSync(TIMINGS_PATH, "utf8"));
    expect(parsed.defaultSeconds).toBeGreaterThan(0);
    const listed = files.filter((file) => file in parsed.files);
    // The file began as Cloud's timings cut down to the tests this repository has; the rest get the median until it is regenerated here.
    expect(listed.length / files.length).toBeGreaterThan(0.6);
    expect(readFileSync(TIMINGS_PATH, "utf8")).toBe(renderTimings(parsed.files));
  });

  it("is rejected when malformed", () => {
    expect(() => parseTimings("[]")).toThrow();
    expect(() => parseTimings('{"defaultSeconds": 0, "files": {}}')).toThrow(/defaultSeconds/);
    expect(() => parseTimings('{"defaultSeconds": 1, "files": {"a": -1}}')).toThrow(/bad duration/);
  });

  it("fall back to equal weights when the file is missing", () => {
    expect(loadTimings("tests/.timings/does-not-exist.json").files).toEqual({});
  });
});

describe("scripts/test-shard-timings.ts", () => {
  const root = "/repo";
  const report = {
    testResults: [
      { name: "/repo/tests/unit/b.test.ts", startTime: 1000, endTime: 3500, assertionResults: [{ duration: 100 }] },
      { name: "/repo/tests/unit/a.test.ts", startTime: 0, endTime: 0, assertionResults: [{ duration: 400 }, { duration: 600.4 }] },
      { name: "/elsewhere/c.test.ts", startTime: 0, endTime: 9000, assertionResults: [] },
    ],
  };

  it("turns a vitest JSON report into seconds per repository-relative file, using the longer of the file's span and its tests' sum", () => {
    expect(durationsFromReport(report, root)).toEqual({ "tests/unit/b.test.ts": 2.5, "tests/unit/a.test.ts": 1 });
    expect(() => durationsFromReport({}, root)).toThrow(/testResults/);
  });

  it("writes sorted keys, one file per line, and the median as the default weight", () => {
    const text = renderTimings({ "z.test.ts": 9, "a.test.ts": 1, "m.test.ts": 3 });
    expect(text).toBe('{\n  "defaultSeconds": 3,\n  "files": {\n    "a.test.ts": 1,\n    "m.test.ts": 3,\n    "z.test.ts": 9\n  }\n}\n');
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
