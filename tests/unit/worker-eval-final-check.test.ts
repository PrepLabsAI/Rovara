import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { evalResultFromArtifact, type EvalRequest } from "@agentx/contracts";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request: EvalRequest = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
const facts = () => ({ status: "verified", candidateDigest: "a".repeat(64), signal: new AbortController().signal });
async function world(newPass = true, n = 4) {
  const w = await createEvalFinalCheckWorld(newPass, n); roots.push(w.root); return w;
}

const reasonOf = (a: unknown) => evalResultFromArtifact(a).notRun?.reason;
describe("final-check guard order", () => {
  it.each(["approval", "meter", "cache", "baselines", "runner"] as const)("a missing runtime %s capability is not_connected before a hold", async field => {
    const w = await world(); const a = await runFinalCheckEval(request, { ...w.ports, [field]: undefined }, facts());
    expect(reasonOf(a)).toBe("not_connected"); expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
  });
  it.each([null])("handles malformed runtime facts without throwing %j", async input => {
    await expect(runFinalCheckEval(request, undefined, input as never)).resolves.toBeUndefined();
  });
  it.each(["subsetSupported"])("refuses malformed plan %s before approval or spend", async field => {
    const w = await world(); w.ports.plan = async () => ({ ...w.plan, [field]: "private-plan-secret" });
    const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(w.approvals()).toBe(0); expect(w.holds).toEqual([]); expect(JSON.stringify(a)).not.toContain("private-plan-secret");
  });
  it("does nothing at all without a request", async () => { const w = await world(); expect(await runFinalCheckEval(undefined, w.ports, facts())).toBeUndefined(); expect(w.planned()).toBe(0); expect(w.calls).toEqual([]); });
  it.each(["not_verified"])("does not spend when checks are %s", async status => { const w = await world(); expect(reasonOf(await runFinalCheckEval(request, w.ports, { ...facts(), status }))).toBe("checks_failed"); expect(w.planned()).toBe(0); expect(w.calls).toEqual([]); });
  it.each(["throws"])("refuses an unreadable plan %s without leaking", async kind => { const w = await world(); w.ports.plan = async () => { if (kind === "throws") throw new Error("secret-cause"); return undefined; }; const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(JSON.stringify(a)).not.toContain("secret-cause"); expect(w.approvals()).toBe(0); });
  // L4-T3 (G2): an approval that stands for this eval but whose AI provider is not connected reads as that, never as "not approved".
  it("an approved grant whose provider is not connected reads provider_not_connected, with no hold, no stage and no call, and never 'not approved'", async () => {
    const w = await world(); w.ports.approval = { read: async () => ({ ...w.grant, connected: false }) };
    const a = await runFinalCheckEval(request, w.ports, facts());
    expect(reasonOf(a)).toBe("provider_not_connected"); expect(w.holds).toEqual([]); expect(w.stages).toEqual([]); expect(w.calls).toEqual([]);
    expect(evalResultFromArtifact(a).summary).toContain("the AI your evals call is not connected for this project"); expect(JSON.stringify(a)).not.toMatch(/spend_not_approved|confirm the eval's call estimate/u);
  });
  it.each([null])("refuses malformed runtime request without calls", async malformed => { const w = await world(); const a = await runFinalCheckEval(malformed as never, w.ports, facts()); expect(reasonOf(a)).toBe("invalid_question_data"); expect(w.planned()).toBe(0); expect(w.holds).toEqual([]); expect(JSON.stringify(a)).not.toContain("secret-invalid"); });
});
describe("metered eval round", () => {
  it.each([true, false])("a failed close preserves complete Worse facts and refuses unknown-cost success: pass=%s", async pass => {
    const w = await world(pass); const reserve = w.ports.meter.reserve.bind(w.ports.meter);
    w.ports.meter.reserve = async r => { const held = (await reserve(r))!; return { call: held.call.bind(held), close: async () => { await held.close(); throw new Error("private-close-cause"); } }; };
    const a = await runFinalCheckEval(request, w.ports, facts());
    expect(evalResultFromArtifact(a).label).toBe(pass ? "Not run" : "Worse on eval");
    if (pass) expect(reasonOf(a)).toBe("provider_error");
    expect(a?.usage).toEqual({ calls: 4 }); expect(w.holds).toHaveLength(1); expect(w.closed).toHaveLength(1); expect(JSON.stringify(a)).not.toContain("private-close-cause");
  });
  it.each(["approval", "reserve", "cache", "baseline"] as const)("keeps %s failures fixed and makes no model calls", async boundary => {
    const w = await world(); const fail = async (): Promise<never> => { throw new Error("private-boundary-cause"); };
    if (boundary === "approval") w.ports.approval.read = fail;
    if (boundary === "reserve") w.ports.meter.reserve = fail;
    if (boundary === "cache") w.ports.cache.read = fail;
    if (boundary === "baseline") { w.ports.cache.read = async () => undefined; w.ports.baselines.forTask = fail; }
    const a = await runFinalCheckEval(request, w.ports, facts());
    expect(reasonOf(a)).toBe(boundary === "approval" ? "spend_not_approved" : boundary === "reserve" ? "cap" : "no_base_score");
    expect(w.calls).toEqual([]); expect(JSON.stringify(a)).not.toContain("private-boundary-cause");
  });
  it("does not cross company data, approval or metering", async () => { const w = await world(); w.plan.key = { ...w.plan.key, company: "company-b" }; const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(w.holds).toEqual([]); });
});

it("prior task spend leaves no room for a cold baseline and makes zero calls", async () => {
  const { createEvalBaselines } = await import("../../packages/worker/src/verification/eval-baseline-refresh.js");
  const w = await world(true, 1); w.ports.cache.read = async () => undefined; w.ports.baselines = createEvalBaselines();
  const a = await runFinalCheckEval({ ...request, evalPass: 2, callsAlreadyUsed: 398 }, w.ports, facts());
  expect(reasonOf(a)).toBe("cap"); expect(w.calls).toEqual([]);
});

it("advertises eval only when the final-check hook is implemented", async () => {
  const { WORKER_IMPLEMENTED_FEATURES } = await import("../../packages/worker/src/implemented-features.js");
  expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.evalRound.v1");
});
