import { describe, expect, it } from "vitest";
import { expectedResults, gateVerdict } from "../../scripts/ci-gate.js";
import { findReuse, passedFullRuns, REUSE_REQUIRED_CHECKS, reusePlanOutputs, type ReuseCheckRun, type ReuseInput, type ReuseRun } from "../../scripts/ci-plan.js";

// #1181: a pull request whose code is byte-for-byte what an earlier FULL push run of this workflow tested and passed stands on that run instead of running the suite again.
const HEAD = "a".repeat(40);
const TREE = "1".repeat(40);
const CURRENT = 900;
const FULL = 700;
const job = (runId: number) => `https://github.com/o/r/actions/runs/${String(runId)}/job/${String(runId * 10)}`;
let nextId = 1;
const check = (name: string, runId: number, over: Partial<ReuseCheckRun> = {}): ReuseCheckRun => ({ id: nextId++, name, status: "completed", conclusion: "success", html_url: job(runId), app: { slug: "github-actions" }, ...over });
const fullRun = (runId: number, over: (name: string) => Partial<ReuseCheckRun> = () => ({})) => REUSE_REQUIRED_CHECKS.map((name) => check(name, runId, over(name)));
const pushRun = (id: number, over: Partial<ReuseRun> = {}): ReuseRun => ({ id, event: "push", head_sha: HEAD, path: ".github/workflows/ci.yml", ...over });

function input(over: Partial<ReuseInput> = {}): ReuseInput {
  return {
    event: "pull_request", labels: [], headSha: HEAD, currentRunId: CURRENT, repository: "o/r",
    treeOf: () => TREE,
    checkRuns: async () => fullRun(FULL),
    workflowRun: async (id) => pushRun(id),
    ...over,
  };
}

describe("which runs passed in full (passedFullRuns)", () => {
  it("takes a run whose own latest local, ci-mode (full) and eight test shards all succeeded", () => {
    expect(passedFullRuns(fullRun(FULL), CURRENT)).toEqual([FULL]);
  });
  it("never takes this run itself, nor anything not reported by GitHub Actions", () => {
    expect(passedFullRuns(fullRun(CURRENT), CURRENT)).toEqual([]);
    expect(passedFullRuns(fullRun(FULL, () => ({ app: { slug: "someone-else" } })), CURRENT)).toEqual([]);
  });
  it("does not need linux-runtime: CI no longer runs it (#1192), so a full push run skips it", () => {
    expect(passedFullRuns(fullRun(FULL).filter((run) => run.name !== "linux-runtime"), CURRENT)).toEqual([FULL]);
    expect(passedFullRuns(fullRun(FULL, (name) => (name === "linux-runtime" ? { conclusion: "skipped" } : {})), CURRENT)).toEqual([FULL]);
  });
  it("refuses an affected or reused run (no ci-mode (full), or no test shards)", () => {
    expect(passedFullRuns(fullRun(FULL).filter((run) => run.name !== "ci-mode (full)"), CURRENT)).toEqual([]);
    expect(passedFullRuns(fullRun(FULL).filter((run) => run.name !== "test (3/8)"), CURRENT)).toEqual([]);
  });
  it("refuses a failed, cancelled or unfinished check, and judges each check by its latest attempt", () => {
    for (const over of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress", conclusion: null }] as const) {
      expect(passedFullRuns(fullRun(FULL, (name) => (name === "test (5/8)" ? over : {})), CURRENT), JSON.stringify(over)).toEqual([]);
    }
    // a rerun that failed after a pass: the latest attempt decides
    expect(passedFullRuns([...fullRun(FULL), check("local", FULL, { conclusion: "failure" })], CURRENT)).toEqual([]);
    // a rerun that passed after a failure
    expect(passedFullRuns([check("local", FULL, { conclusion: "failure" }), ...fullRun(FULL)], CURRENT)).toEqual([FULL]);
  });
  it("does not mix checks of two runs into one pass", () => {
    const half = fullRun(FULL).filter((run) => !run.name.startsWith("test ("));
    const otherHalf = fullRun(FULL + 1).filter((run) => run.name.startsWith("test ("));
    expect(passedFullRuns([...half, ...otherHalf], CURRENT)).toEqual([]);
  });
});

describe("the reuse proof (findReuse)", () => {
  it("reuses a full push run of exactly the pull request's head when the tested tree is the head's", async () => {
    expect(await findReuse(input())).toEqual({ runId: FULL, runUrl: `https://github.com/o/r/actions/runs/${String(FULL)}` });
  });
  it("plans as before when the pull request is behind its base (the merge tree is not the head's)", async () => {
    expect(await findReuse(input({ treeOf: (rev) => (rev === "HEAD" ? "2".repeat(40) : TREE) }))).toBeUndefined();
  });
  it("never reuses for a push, a manual run, the nightly schedule, or a pull request labelled full-ci", async () => {
    expect(await findReuse(input({ event: "push" }))).toBeUndefined();
    expect(await findReuse(input({ event: "workflow_dispatch" }))).toBeUndefined();
    expect(await findReuse(input({ event: "schedule" }))).toBeUndefined();
    expect(await findReuse(input({ labels: ["full-ci"] }))).toBeUndefined();
  });
  it("reuses only a push run of this workflow on exactly the head commit", async () => {
    for (const over of [{ event: "pull_request" }, { head_sha: "b".repeat(40) }, { path: ".github/workflows/other.yml" }, { id: FULL + 1 }]) {
      expect(await findReuse(input({ workflowRun: async (id) => pushRun(id, over) })), JSON.stringify(over)).toBeUndefined();
    }
  });
  it("plans as before when GitHub can't be read, refuses, or throws", async () => {
    expect(await findReuse(input({ checkRuns: async () => undefined }))).toBeUndefined();
    expect(await findReuse(input({ checkRuns: async () => { throw new Error("rate limited"); } }))).toBeUndefined();
    expect(await findReuse(input({ workflowRun: async () => undefined }))).toBeUndefined();
    expect(await findReuse(input({ workflowRun: async () => { throw new Error("timeout"); } }))).toBeUndefined();
    expect(await findReuse(input({ treeOf: () => undefined }))).toBeUndefined();
  });
  it("refuses malformed inputs", async () => {
    expect(await findReuse(input({ headSha: "not-a-sha" }))).toBeUndefined();
    expect(await findReuse(input({ currentRunId: 0 }))).toBeUndefined();
    expect(await findReuse(input({ repository: "o/r; rm -rf /" }))).toBeUndefined();
  });
});

describe("the gate on a reuse", () => {
  const plan = reusePlanOutputs({ runId: FULL, runUrl: `https://github.com/o/r/actions/runs/${String(FULL)}` });
  const results = { plan: "success", quick: "skipped", build: "skipped", test: "skipped", "linux-runtime": "skipped", "ci-mode": "success" };
  it("passes when only the plan and ci-mode (full) ran, and names the reused run", () => {
    const verdict = gateVerdict({ plan, results });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain(`https://github.com/o/r/actions/runs/${String(FULL)}`);
  });
  it("fails a reuse whose ci-mode (full) did not succeed, or that still ran part of the suite", () => {
    expect(gateVerdict({ plan, results: { ...results, "ci-mode": "skipped" } }).ok).toBe(false);
    expect(gateVerdict({ plan, results: { ...results, quick: "success" } }).ok).toBe(false);
  });
  it("does not trust a reuse plan that runs part of the suite or names no run", () => {
    expect("problem" in expectedResults({ ...plan, tests: "all" })).toBe(true);
    expect("problem" in expectedResults({ ...plan, linux: "true" })).toBe(true);
    expect("problem" in expectedResults({ ...plan, reuse_run: undefined })).toBe(true);
    expect("problem" in expectedResults({ ...plan, reuse_run: "https://example.com/actions/runs/1" })).toBe(true);
  });
});
