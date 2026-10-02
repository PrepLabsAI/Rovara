import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { gateVerdict, needsVerdict } from "../../scripts/ci-gate.js";

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string> }>;
}
interface Workflow {
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
}

const workflow = async () => YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as Workflow;

describe("CI runs its checks side by side (a Markdown-only change skips them all)", () => {
  it("splits the tests across shards that each run on their own machine, and a failing shard does not hide the others", async () => {
    const test = (await workflow()).jobs.test!;
    expect(test.strategy?.["fail-fast"]).toBe(false);
    expect(test.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(test.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }} --maxWorkers=2")).toBe(true);
  });

  it("keeps checks, tests and the release check in jobs of their own, none waiting on another", async () => {
    const { jobs } = await workflow();
    for (const name of ["checks", "test", "release"]) expect(jobs[name]!.needs, name).toBe("scope");
  });

  it("gives every job but the manual live-AWS one a time limit, so a hung runner fails in minutes and not after six hours", async () => {
    const { jobs } = await workflow();
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "live-aws") expect(job["timeout-minutes"], name).toBeGreaterThan(0);
    }
  });

  it("supersedes a pull request's run in progress when it is pushed again, and never cancels a mainline run", async () => {
    const { concurrency } = await workflow();
    expect(concurrency?.group).toContain("github.ref");
    expect(concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("reports one check called local that waits for every other job, so it cannot go green while one is missing", async () => {
    const { jobs } = await workflow();
    const gate = jobs.local!;
    expect(gate.name).toBeUndefined();
    expect(gate.if).toBe("always()");
    const others = Object.keys(jobs).filter((name) => name !== "local" && name !== "live-aws").sort();
    expect([...(gate.needs as string[])].sort()).toEqual(others);
    const run = gate.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("node scripts/ci-gate.ts");
    expect(gate.steps.some((step) => step.env?.NEEDS === "${{ toJSON(needs) }}")).toBe(true);
  });
});

describe("the gate behind the local check", () => {
  const ran = { scope: "success", checks: "success", "test": "success", release: "success" };

  it("passes when every job succeeded", () => {
    expect(gateVerdict({ docsOnly: false, results: ran }).ok).toBe(true);
  });

  it("fails when any job failed, was cancelled or was skipped", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const verdict = gateVerdict({ docsOnly: false, results: { ...ran, test: result } });
      expect(verdict, result).toEqual({ ok: false, reason: `test was ${result}, not success` });
    }
  });

  it("fails when the scope job did not succeed, even though every job it feeds was skipped", () => {
    const skipped = { scope: "failure", checks: "skipped", test: "skipped", release: "skipped" };
    expect(gateVerdict({ docsOnly: false, results: skipped })).toEqual({ ok: false, reason: "scope was failure, not success" });
    expect(gateVerdict({ docsOnly: true, results: skipped }).ok).toBe(false);
  });

  it("passes a Markdown-only change only when every heavy job was skipped", () => {
    const skipped = { scope: "success", checks: "skipped", test: "skipped", release: "skipped" };
    expect(gateVerdict({ docsOnly: true, results: skipped }).ok).toBe(true);
    expect(gateVerdict({ docsOnly: true, results: { ...skipped, test: "success" } })).toEqual({ ok: false, reason: "test was success, not skipped" });
    expect(gateVerdict({ docsOnly: true, results: { ...skipped, release: "failure" } }).ok).toBe(false);
  });

  it("fails a gate that was given no jobs to judge", () => {
    expect(gateVerdict({ docsOnly: false, results: { scope: "success" } }).ok).toBe(false);
    expect(gateVerdict({ docsOnly: false, results: {} }).ok).toBe(false);
  });

  it("reads the needs context GitHub provides", () => {
    const needs = JSON.stringify({
      scope: { result: "success", outputs: { docs_only: "false" } },
      checks: { result: "success", outputs: {} },
      test: { result: "success", outputs: {} },
      release: { result: "success", outputs: {} },
    });
    expect(needsVerdict(needs).ok).toBe(true);
    const skippedOnPush = JSON.stringify({
      scope: { result: "success", outputs: {} },
      checks: { result: "success", outputs: {} },
    });
    expect(needsVerdict(skippedOnPush).ok).toBe(true);
    expect(needsVerdict("not json").ok).toBe(false);
    expect(needsVerdict(JSON.stringify({ checks: { result: "success", outputs: {} } })).ok).toBe(false);
  });
});
