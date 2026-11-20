// L4-EVH (DEC 254zzz20 D5): the worker's health job. It measures one claim's evals on main three times through the broker's own plan, grant and meter, and hands the made baseline back; it writes no baseline and says
// nothing about a key, company, project, cost or payer. Every guard has a named mutant in briefs/lead4/L4-EVH-MUTANTS-20261118.md.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_PLAN_QUESTIONS_CHANGED } from "../../packages/worker/src/verification/eval-final-check.js";
import { runEvalHealthJob, type EvalHealthJobPorts } from "../../packages/worker/src/verification/eval-health-job.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const job = () => ({ requestId: randomUUID(), claimId: randomUUID() });
async function world(n = 2) { const w = await createEvalFinalCheckWorld(true, n); roots.push(w.root); return w; }
const portsOf = (w: Awaited<ReturnType<typeof world>>): EvalHealthJobPorts => ({ plan: () => w.ports.plan(), approval: w.ports.approval, meter: w.ports.meter, runner: (r) => w.ports.runner(r) });
const signal = () => new AbortController().signal;

describe("the health job measures the evals on main", () => {
  it("refuses an invalid prepared version before any hold", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), standInSetVersion: async () => "BAD" }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "not_connected" });
    expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
  });
  it("a record that is not a measurement is not returned: a runner that wrote nothing", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), runner: async () => { throw new Error("sandbox gone"); } }, signal());
    expect(answer.result).toMatchObject({ status: "not_run" });
  });
});

describe("the health job spends nothing it was not given", () => {
  it.each(["plan", "approval", "meter", "runner"] as const)("a missing %s is not connected, with no hold and no call", async field => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), [field]: undefined }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "not_connected" });
    expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
  });
  it.each([null])("malformed ports %j never throw", async ports => {
    const answer = await runEvalHealthJob(job(), ports as never, signal());
    expect(answer.result).toMatchObject({ status: "not_run" });
  });
  it("questions that changed since approval say so, with no hold", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), plan: async () => EVAL_PLAN_QUESTIONS_CHANGED }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "questions_changed" }); expect(w.holds).toEqual([]);
  });
  it("no standing grant (nothing approved now, no adapter, the approver gone) is not confirmed, with no hold", async () => {
    const w = await world(2);
    for (const read of [async () => undefined, async () => { throw new Error("down"); }]) {
      const answer = await runEvalHealthJob(job(), { ...portsOf(w), approval: { read } }, signal());
      expect(answer.result).toEqual({ status: "not_run", reason: "not_confirmed" });
    }
    expect(w.holds).toEqual([]);
  });
  it("the grant's limits hold: three runs that would pass the approved calls or cost are refused before any hold", async () => {
    const w = await world(4);
    for (const over of [{ maxCalls: 11 }, { maxCostMicros: 119 }]) {
      const answer = await runEvalHealthJob(job(), { ...portsOf(w), approval: { read: async () => ({ ...w.grant, ...over }) } }, signal());
      expect(answer.result).toEqual({ status: "not_run", reason: "over_cap" });
    }
    expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
    // At the limit it runs.
    const ok = await runEvalHealthJob(job(), { ...portsOf(w), approval: { read: async () => ({ ...w.grant, maxCalls: 12, maxCostMicros: 120 }) } }, signal());
    expect(ok.result.status).toBe("measured");
  });
  it("a grant for another selection or inputs is not confirmed, with no hold", async () => {
    const w = await world(2);
    for (const over of [{ selection: "other" }, { inputsDigest: "f".repeat(64) }, { company: "company-b" }, { provider: "rovara" }]) {
      const answer = await runEvalHealthJob(job(), { ...portsOf(w), approval: { read: async () => ({ ...w.grant, ...over }) as never } }, signal());
      expect(answer.result, JSON.stringify(over)).toEqual({ status: "not_run", reason: "not_confirmed" });
    }
    expect(w.holds).toEqual([]);
  });
});

describe("the health job stops when told", () => {
  it("a stop during the runs is reported, and the hold is closed", async () => {
    const w = await world(2); const stop = new AbortController();
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), runner: async r => { stop.abort(); return await w.ports.runner(r); } }, stop.signal);
    expect(answer.result).toEqual({ status: "not_run", reason: "stopped" });
    expect(w.closed).toHaveLength(1);
  });
  it("a signal that is not a signal is unavailable", async () => {
    const w = await world(2);
    expect((await runEvalHealthJob(job(), portsOf(w), undefined as never)).result).toEqual({ status: "not_run", reason: "unavailable" });
  });
});
