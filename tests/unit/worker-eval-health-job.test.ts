// L4-EVH (DEC 254zzz20 D5): the worker's health job. It measures one claim's evals on main three times through the broker's own plan, grant and meter, and hands the made baseline back; it writes no baseline and says
// nothing about a key, company, project, cost or payer. Every guard has a named mutant in briefs/lead4/L4-EVH-MUTANTS-20261118.md.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EvalHealthResultBodySchema } from "@agentx/contracts";
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
  it("runs the old side three times, holds the whole estimate once, and returns the baseline it made (never writes one)", async () => {
    const w = await world(2); let writes = 0;
    const cache = { read: async () => w.record, write: async () => { writes += 1; return "stored" as const; } };
    const j = job();
    const answer = await runEvalHealthJob(j, { ...portsOf(w), ...({ cache } as object) }, signal());
    expect(EvalHealthResultBodySchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({ requestId: j.requestId, claimId: j.claimId, result: { status: "measured" } });
    if (answer.result.status !== "measured") throw new Error("not measured");
    expect(answer.result.record.questions?.map(q => [q.id, q.samples.length])).toEqual([["q0", 3], ["q1", 3]]);
    expect(answer.result.record.caseCount).toBe(2);
    expect(w.stages).toEqual([{ side: "old", ids: ["q0", "q1"], runs: 1 }, { side: "old", ids: ["q0", "q1"], runs: 1 }, { side: "old", ids: ["q0", "q1"], runs: 1 }]);
    expect(w.holds).toEqual([{ calls: 6, costMicros: 60, company: "company-a" }]);
    expect(w.calls).toHaveLength(6); expect(w.closed).toHaveLength(1);
    expect(writes).toBe(0);
  });
  it("uses the prepared stand-in version and sends it with the measured result", async () => {
    const w = await world(2); const version = "c".repeat(64); let asked = 0;
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), standInSetVersion: async () => { asked += 1; return version; } }, signal());
    expect(answer.result).toMatchObject({ status: "measured", standInSetVersion: version });
    expect(EvalHealthResultBodySchema.safeParse(answer).success).toBe(true);
    expect(asked).toBe(1); expect(w.holds).toHaveLength(1);
  });
  it("refuses an invalid prepared version before any hold", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), standInSetVersion: async () => "BAD" }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "not_connected" });
    expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
  });
  it("says nothing about a key, company, project, cost or payer: the body is exactly the contract", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), portsOf(w), signal());
    expect(Object.keys(answer).sort()).toEqual(["claimId", "requestId", "result"]);
    expect(Object.keys(answer.result).sort()).toEqual(["record", "status"]);
    expect(JSON.stringify(answer)).not.toMatch(/company-a|project-a|costMicros|payer|customer/u);
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
  it.each([undefined, null, {}, "ports"])("malformed ports %j never throw", async ports => {
    const answer = await runEvalHealthJob(job(), ports as never, signal());
    expect(answer.result).toMatchObject({ status: "not_run" });
  });
  it("no plan, a plan that is not whole, or one that is not an eval is not connected", async () => {
    const w = await world(2);
    for (const plan of [undefined, null, {}, { ...w.plan, questions: "x" }, { ...w.plan, evalConfigured: false }]) {
      const answer = await runEvalHealthJob(job(), { ...portsOf(w), plan: async () => plan as never }, signal());
      expect(answer.result).toEqual({ status: "not_run", reason: "not_connected" });
    }
    expect(w.holds).toEqual([]);
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
  it("a monthly cap that cannot fit the runs refuses with no call", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), meter: { reserve: async () => undefined } }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "monthly_cap" }); expect(w.calls).toEqual([]);
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
  it("an already stopped job does nothing", async () => {
    const w = await world(2); const stop = new AbortController(); stop.abort();
    expect((await runEvalHealthJob(job(), portsOf(w), stop.signal)).result).toEqual({ status: "not_run", reason: "stopped" });
    expect(w.holds).toEqual([]); expect(w.stages).toEqual([]);
  });
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
  it("a plan read that throws never throws out of the job", async () => {
    const w = await world(2);
    const answer = await runEvalHealthJob(job(), { ...portsOf(w), plan: async () => { throw new Error("x"); } }, signal());
    expect(answer.result).toEqual({ status: "not_run", reason: "unavailable" });
  });
});
