import { describe, expect, it } from "vitest";
import { GATED_JOBS, expectedResults, gateVerdict, needsVerdict, type PlanOutputs } from "../../scripts/ci-gate.js";
import { planCi, planOutputs } from "../../scripts/ci-plan.js";

const FULL: PlanOutputs = { mode: "full", docs_only: "false", tests: "all", shards: "[1,2,3,4,5,6,7,8]", lint: "all", linux: "true", release: "true" };
const AFFECTED: PlanOutputs = { mode: "affected", docs_only: "false", tests: "changed", shards: "[1,2]", lint: "changed", linux: "false", release: "false" };
const AFFECTED_LINUX: PlanOutputs = { ...AFFECTED, linux: "true" };
const DOCS: PlanOutputs = { mode: "affected", docs_only: "true", tests: "none", shards: "[1]", lint: "none", linux: "false", release: "false" };

const fullRan = { plan: "success", quick: "success", build: "success", test: "success", "linux-runtime": "success", "ci-mode": "success" };
const affectedRan = { plan: "success", quick: "success", build: "success", test: "success", "linux-runtime": "skipped", "ci-mode": "skipped" };
const docsRan = { plan: "success", quick: "skipped", build: "skipped", test: "skipped", "linux-runtime": "skipped", "ci-mode": "skipped" };

describe("the gate behind the local check: what each job must have done, from the plan", () => {
  it("passes a full run only when every job succeeded, ci-mode (full) included", () => {
    expect(gateVerdict({ plan: FULL, results: fullRan })).toEqual({ ok: true, reason: "FULL run; 5 jobs succeeded" });
    for (const job of GATED_JOBS) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const verdict = gateVerdict({ plan: FULL, results: { ...fullRan, [job]: result } });
        expect(verdict.ok, `${job} ${result}`).toBe(false);
      }
    }
    expect(gateVerdict({ plan: FULL, results: { ...fullRan, test: "skipped" } }).reason).toBe("test was skipped, but the plan needs it to succeed");
    expect(gateVerdict({ plan: FULL, results: { ...fullRan, "ci-mode": "skipped" } }).reason).toBe("ci-mode was skipped, but the plan needs it to succeed");
    expect(gateVerdict({ plan: FULL, results: { ...fullRan, "linux-runtime": "failure" } }).reason).toBe("linux-runtime was failure, not success");
  });

  it("passes an affected run when the jobs the plan skipped by design were skipped and the rest succeeded", () => {
    expect(gateVerdict({ plan: AFFECTED, results: affectedRan })).toEqual({ ok: true, reason: "affected run; 3 jobs succeeded, 2 skipped by design (linux-runtime, ci-mode)" });
    expect(gateVerdict({ plan: AFFECTED_LINUX, results: { ...affectedRan, "linux-runtime": "success" } }).ok).toBe(true);
  });

  it("fails an affected run when a job the plan needed was skipped, missing or failed (the heart of it: skipped by design is a pass, skipped by accident is not)", () => {
    for (const job of ["quick", "build", "test"]) {
      expect(gateVerdict({ plan: AFFECTED, results: { ...affectedRan, [job]: "skipped" } }).reason, job).toBe(`${job} was skipped, but the plan needs it to succeed`);
      expect(gateVerdict({ plan: AFFECTED, results: { ...affectedRan, [job]: "failure" } }).ok, job).toBe(false);
      const without = Object.fromEntries(Object.entries(affectedRan).filter(([name]) => name !== job));
      expect(gateVerdict({ plan: AFFECTED, results: without }).reason, job).toBe(`${job} was missing`);
    }
    // The Linux job is needed when the plan says its area changed.
    expect(gateVerdict({ plan: AFFECTED_LINUX, results: affectedRan }).reason).toBe("linux-runtime was skipped, but the plan needs it to succeed");
  });

  it("fails a job that ran although the plan skipped it, so a plan and a workflow that disagree cannot pass", () => {
    expect(gateVerdict({ plan: AFFECTED, results: { ...affectedRan, "linux-runtime": "success" } }).reason).toBe("linux-runtime was success, but the plan skipped it");
    // An affected run cannot stand in for a full one: ci-mode must be skipped there
    expect(gateVerdict({ plan: AFFECTED, results: { ...affectedRan, "ci-mode": "success" } }).ok).toBe(false);
  });

  it("passes a Markdown-only change only when every heavy job was skipped", () => {
    expect(gateVerdict({ plan: DOCS, results: docsRan })).toEqual({ ok: true, reason: "Markdown-only change; 0 jobs succeeded, 5 skipped by design (quick, build, test, linux-runtime, ci-mode)" });
    expect(gateVerdict({ plan: DOCS, results: { ...docsRan, test: "success" } }).reason).toBe("test was success, but the plan skipped it");
    expect(gateVerdict({ plan: DOCS, results: { ...docsRan, quick: "failure" } }).ok).toBe(false);
  });

  it("fails when the plan itself did not succeed, even though every job it feeds was skipped", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(gateVerdict({ plan: DOCS, results: { ...docsRan, plan: result } }).reason).toBe(`plan was ${result}, not success`);
    }
    expect(gateVerdict({ plan: DOCS, results: {} }).reason).toBe("plan was missing, not success");
  });

  it("does not trust a plan that is malformed, or that says full yet skips part of the run", () => {
    expect(expectedResults({})).toHaveProperty("problem");
    expect(gateVerdict({ plan: { ...AFFECTED, mode: "sometimes" }, results: affectedRan }).ok).toBe(false);
    expect(gateVerdict({ plan: { ...AFFECTED, tests: "most" }, results: affectedRan }).ok).toBe(false);
    expect(gateVerdict({ plan: { ...AFFECTED, linux: "maybe" }, results: affectedRan }).ok).toBe(false);
    for (const thinner of [{ tests: "changed" }, { lint: "changed" }, { linux: "false" }, { release: "false" }, { docs_only: "true" }]) {
      const verdict = gateVerdict({ plan: { ...FULL, ...thinner }, results: fullRan });
      expect(verdict.ok, JSON.stringify(thinner)).toBe(false);
      expect(verdict.reason).toMatch(/the plan says full but also skips|says Markdown-only/);
    }
    expect(gateVerdict({ plan: { ...DOCS, tests: "changed" }, results: docsRan }).ok).toBe(false);
  });

  it("fails a plan that runs the whole suite in fewer than eight shards", () => {
    for (const shards of ["[1]", "[1,2]", "[1,2,3,4,5,6,7]", "[]", "", "[1,2,3,4,5,6,7,8,9]"]) {
      const verdict = gateVerdict({ plan: { ...FULL, shards }, results: fullRan });
      expect(verdict.ok, shards).toBe(false);
      expect(verdict.reason).toMatch(/shard list/);
    }
    expect(gateVerdict({ plan: { ...AFFECTED, tests: "all", shards: "[1,2]" }, results: affectedRan }).ok).toBe(false);
    expect(gateVerdict({ plan: { ...AFFECTED, tests: "all", shards: "[1,2,3,4,5,6,7,8]" }, results: affectedRan }).ok).toBe(true);
  });

  it("holds every plan the planner can make to the same jobs the workflow gives them", () => {
    const changes = [["docs/sample/guide.md"], ["packages/other-d/src/x.ts"], ["package.json"], ["packages/worker/src/x.ts"], []];
    for (const changed of changes) {
      for (const [event, labels] of [["pull_request", []], ["pull_request", ["full-ci"]], ["push", []], ["workflow_dispatch", []]] as const) {
        const outputs = planOutputs(planCi({ event, labels, title: "x", changed, testSources: new Map(), packages: [] }));
        const decided = expectedResults(outputs);
        expect(decided, `${event} ${labels.join()} ${changed.join()}`).toHaveProperty("expected");
        // A run where every job does what the plan expects passes.
        const results = { plan: "success", ...Object.fromEntries(Object.entries((decided as { expected: Record<string, string> }).expected)) };
        expect(gateVerdict({ plan: outputs, results }).ok, `${event} ${labels.join()} ${changed.join()}`).toBe(true);
        // and any push or manual run, or a labelled pull request, is a full run
        if (event !== "pull_request" || labels.length > 0) expect(outputs.mode).toBe("full");
      }
    }
  });

  it("reads the needs context GitHub provides", () => {
    const needs = (plan: PlanOutputs, results: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: job === "plan" ? plan : {} }])));
    expect(needsVerdict(needs(FULL, fullRan)).ok).toBe(true);
    expect(needsVerdict(needs(AFFECTED, affectedRan)).ok).toBe(true);
    expect(needsVerdict(needs(DOCS, docsRan)).ok).toBe(true);
    expect(needsVerdict(needs(AFFECTED, { ...affectedRan, test: "skipped" })).ok).toBe(false);
    expect(needsVerdict("not json").ok).toBe(false);
    expect(needsVerdict("[]").ok).toBe(false);
    expect(needsVerdict(JSON.stringify({ quick: { result: "success", outputs: {} } })).ok).toBe(false);
    // a plan whose outputs are empty (the job failed before writing them) is not trusted
    expect(needsVerdict(JSON.stringify({ plan: { result: "success", outputs: {} }, ...Object.fromEntries(GATED_JOBS.map((job) => [job, { result: "success", outputs: {} }])) })).ok).toBe(false);
  });
});
