import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { evalResultFromArtifact, type EvalBaseRecord, type EvalRequest } from "@agentx/contracts";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";
import { runFinalCheckEval, type EvalFinalCheckPorts } from "../../packages/worker/src/verification/eval-final-check.js";
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
  it.each([null, {}, { roundKind: "private-secret" }])("handles malformed runtime ports without throwing %j", async ports => {
    const a = await runFinalCheckEval(request, ports as never, facts()); expect(reasonOf(a)).toMatch(/not_connected|needs_fresh_sandbox/); expect(JSON.stringify(a)).not.toContain("private-secret");
  });
  it.each([null, {}, { ...facts(), signal: null }])("handles malformed runtime facts without throwing %j", async input => {
    await expect(runFinalCheckEval(request, undefined, input as never)).resolves.toBeUndefined();
  });
  it.each(["questions", "subsetSupported", "evalConfigured", "judgePin", "maxCallsPerQuestion"])("refuses malformed plan %s before approval or spend", async field => {
    const w = await world(); w.ports.plan = async () => ({ ...w.plan, [field]: "private-plan-secret" });
    const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(w.approvals()).toBe(0); expect(w.holds).toEqual([]); expect(JSON.stringify(a)).not.toContain("private-plan-secret");
  });
  it("does nothing at all without a request", async () => { const w = await world(); expect(await runFinalCheckEval(undefined, w.ports, facts())).toBeUndefined(); expect(w.planned()).toBe(0); expect(w.calls).toEqual([]); });
  it("unwired ports produce not_connected with no made-up comparisons", async () => { const a = await runFinalCheckEval(request, undefined, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(a).not.toHaveProperty("questions"); });
  it.each([undefined, "working", "unknown"]) ("requires a fresh sandbox for %s", async roundKind => { const w = await world(); const a = await runFinalCheckEval(request, { ...w.ports, roundKind } as EvalFinalCheckPorts, facts()); expect(reasonOf(a)).toBe("needs_fresh_sandbox"); expect(w.planned()).toBe(0); expect(w.holds).toEqual([]); });
  it.each(["not_verified", "regression", "unknown", undefined])("does not spend when checks are %s", async status => { const w = await world(); expect(reasonOf(await runFinalCheckEval(request, w.ports, { ...facts(), status } as never))).toBe("checks_failed"); expect(w.planned()).toBe(0); expect(w.calls).toEqual([]); });
  it.each(["undefined", "throws"])("refuses an unreadable plan %s without leaking", async kind => { const w = await world(); w.ports.plan = async () => { if (kind === "throws") throw new Error("secret-cause"); return undefined; }; const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(JSON.stringify(a)).not.toContain("secret-cause"); expect(w.approvals()).toBe(0); });
  it.each(["absent", "company", "project", "selection", "role", "provider", "connected", "inputsDigest", "maxCalls", "maxCostMicros"])("rejects the %s grant before reserving", async field => {
    const w = await world(); const value = field === "connected" ? false : field === "maxCalls" ? NaN : field === "maxCostMicros" ? -1 : field === "inputsDigest" ? "d".repeat(64) : "secret-invalid";
    w.ports.approval = { read: async () => field === "absent" ? undefined : ({ ...w.grant, [field]: value }) };
    const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("spend_not_approved"); expect(w.holds).toEqual([]); expect(w.stages).toEqual([]); expect(JSON.stringify(a)).not.toContain("secret-invalid");
  });
  it("DEC 200 needs no grant and never reserves", async () => { const w = await world(); w.plan.evalConfigured = false; const a = await runFinalCheckEval(request, w.ports, facts()); expect(evalResultFromArtifact(a).summary).toContain("Prompt changed. No eval found"); expect(w.approvals()).toBe(0); expect(w.holds).toEqual([]); });
  it("returns measuring immediately with no task-stage hold", async () => { const w = await world(); w.ports.cache.read = async () => undefined; w.ports.baselines.forTask = async () => "measuring"; const a = await runFinalCheckEval(request, w.ports, facts()); expect(evalResultFromArtifact(a)).toMatchObject({ outcome: "not_run", notices: ["baseline still being measured"], disposition: { check: "neutral" } }); expect(w.holds).toEqual([]); });
  it.each([null, {}, { ...request, evalPass: 3 }, { ...request, callsAlreadyUsed: -1 }, { ...request, reason: "secret-invalid" }])("refuses malformed runtime request without calls", async malformed => { const w = await world(); const a = await runFinalCheckEval(malformed as never, w.ports, facts()); expect(reasonOf(a)).toBe("invalid_question_data"); expect(w.planned()).toBe(0); expect(w.holds).toEqual([]); expect(JSON.stringify(a)).not.toContain("secret-invalid"); });
});
describe("metered eval round", () => {
  it("does not trust comparison facts fabricated after a failed metered call", async () => {
    const w = await world(false); const runner = w.ports.runner;
    w.ports.meter.reserve = async () => ({ call: async () => ({ class: "provider_error", calls: 1, costMicros: 10 }), close: async () => {} });
    w.ports.runner = async r => {
      await r.call({} as ModelEgressFrame).catch(() => undefined);
      const output = await runner({ ...r, call: async () => ({ class: "ok", calls: 1, costMicros: 10 }) });
      return { ...output, changedPromptCalls: 1 };
    };
    const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("provider_error"); expect(a?.usage?.calls).toBe(1);
  });
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
  it("reserves each stage separately and records meter usage instead of runner claims", async () => {
    const w = await world(false); const a = await runFinalCheckEval(request, w.ports, facts());
    expect(a).toMatchObject({ candidateDigest: "a".repeat(64), outcome: "done", usage: { calls: 28, costMicros: 280 } });
    expect(evalResultFromArtifact(a).label).toBe("Worse on eval");
    expect(w.holds.map(h => [h.calls, h.costMicros])).toEqual([[4, 40], [12, 120], [12, 120]]); expect(w.closed).toHaveLength(3);
  });
  it("a refused hold maps to cap with no runner call", async () => { const w = await world(); w.ports.meter.reserve = async () => undefined; const a = await runFinalCheckEval(request, w.ports, facts()); expect(evalResultFromArtifact(a).notRun).toEqual({ reason: "cap", sentence: "Not run: over the eval budget" }); expect(w.stages).toEqual([]); });
  it("pass two includes pass one's spend before reserving", async () => { const w = await world(); const a = await runFinalCheckEval({ ...request, evalPass: 2, callsAlreadyUsed: 399 }, w.ports, facts()); expect(reasonOf(a)).toBe("cap"); expect(w.holds).toEqual([]); });
  it("a thrown runner still closes and accounts attempted calls with fixed refusal words", async () => { const w = await world(); w.ports.runner = async r => { await r.call({} as ModelEgressFrame); throw new Error("private-provider-error"); }; const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("provider_error"); expect(a).toMatchObject({ usage: { calls: 1, costMicros: 10 } }); expect(w.closed).toHaveLength(1); expect(JSON.stringify(a)).not.toContain("private-provider-error"); });
  it("joins an aborted runner and closes before returning stopped", async () => { const w = await world(); const stop = new AbortController(); w.ports.runner = async r => { await r.call({} as ModelEgressFrame); stop.abort(); throw new Error("abort-secret"); }; const a = await runFinalCheckEval(request, w.ports, { ...facts(), signal: stop.signal }); expect(reasonOf(a)).toBe("stopped"); expect(w.closed).toHaveLength(1); expect(a).toMatchObject({ usage: { calls: 1, costMicros: 10 } }); });
  it("keeps a completed Worse result when cancellation stops later work", async () => { const w = await world(false); const run = w.ports.runner; const stop = new AbortController(); w.ports.runner = async r => { if (r.side === "old") { stop.abort(); throw new Error("stop"); } return run(r); }; const a = await runFinalCheckEval(request, w.ports, { ...facts(), signal: stop.signal }); expect(evalResultFromArtifact(a).label).toBe("Worse on eval"); expect(w.closed).toHaveLength(2); });
  it("does not cross company data, approval or metering", async () => { const w = await world(); w.plan.key = { ...w.plan.key, company: "company-b" }; const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("not_connected"); expect(w.holds).toEqual([]); });
});

it("charges a cold baseline and task comparison to one total call budget", async () => {
  const { createEvalBaselines } = await import("../../packages/worker/src/verification/eval-baseline-refresh.js");
  const w = await world(true, 1); let saved: EvalBaseRecord | undefined;
  w.ports.cache = { read: async () => saved, write: async (_key, value) => { saved = value; return "stored"; } };
  w.ports.baselines = createEvalBaselines();
  const a = await runFinalCheckEval(request, w.ports, facts());
  expect(w.calls).toHaveLength(4); expect(a).toMatchObject({ outcome: "done", usage: { calls: 4, costMicros: 40 } });
});
it("prior task spend leaves no room for a cold baseline and makes zero calls", async () => {
  const { createEvalBaselines } = await import("../../packages/worker/src/verification/eval-baseline-refresh.js");
  const w = await world(true, 1); w.ports.cache.read = async () => undefined; w.ports.baselines = createEvalBaselines();
  const a = await runFinalCheckEval({ ...request, evalPass: 2, callsAlreadyUsed: 398 }, w.ports, facts());
  expect(reasonOf(a)).toBe("cap"); expect(w.calls).toEqual([]);
});
it("a whole cold baseline above the grant is a cap refusal with zero calls", async () => {
  const { createEvalBaselines } = await import("../../packages/worker/src/verification/eval-baseline-refresh.js");
  const w = await world(true, 135); w.ports.cache.read = async () => undefined; w.ports.baselines = createEvalBaselines();
  const a = await runFinalCheckEval(request, w.ports, facts()); expect(reasonOf(a)).toBe("cap"); expect(w.calls).toEqual([]); expect(w.holds).toEqual([]);
});
it("a refused re-ask reservation reports cap without inventing an old-code attestation", async () => {
  const w = await world(false, 1); const reserve = w.ports.meter.reserve.bind(w.ports.meter); let holds = 0;
  w.ports.meter.reserve = r => ++holds === 1 ? reserve(r) : Promise.resolve(undefined);
  const a = await runFinalCheckEval(request, w.ports, facts());
  expect(reasonOf(a)).toBe("cap"); expect(w.stages).toHaveLength(1);
});

it("captures bounded agent feedback and the fix request in the artifact", async () => {
  const w = await world(false); const a = await runFinalCheckEval(request, w.ports, facts());
  expect(a).toMatchObject({ fixRequested: true, feedback: { questions: [{ id: "q0", change: "broke", oldAnswers: ["old", "old", "old"], newAnswers: ["new", "new", "new"] }, {}, {}, {}] } });
});

it("advertises eval only when the final-check hook is implemented", async () => {
  const { WORKER_IMPLEMENTED_FEATURES } = await import("../../packages/worker/src/implemented-features.js");
  expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.evalRound.v1");
});
