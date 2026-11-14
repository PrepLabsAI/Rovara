import { describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, ModelEgressFrameSchema, type ModelEgressClass } from "@agentx/contracts";
import { createDocumentBaseScoreCache, evalCommandFingerprint, type EvalBaseCacheKeyParts } from "../../packages/contracts/src/eval-base-cache.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { runEvalHealth, type EvalHealthInput } from "../../packages/worker/src/verification/eval-health.js";
import type { ModelEgressFrame } from "../../packages/contracts/src/model-egress/frame.js";
import type { EvalSpendApproval, MonthlyMeter } from "../../packages/contracts/src/ports/eval-health.js";

import { fakeModelEgressWorld, COMPANY_A, COMPANY_B } from "../../packages/testing/src/ports/model-egress-world.js";
import { validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
const frame = {} as ModelEgressFrame; // The fake meter makes no provider request.
const company = "org_aaaaaaaaaaaaaaaaaaaa";
const key: EvalBaseCacheKeyParts = { company, project: "p", baseCommit: "a".repeat(40), codeHash: "b".repeat(64), judgePin: "c".repeat(64), evalSetHash: "d".repeat(64), hiddenSetHash: "none", commandFingerprint: evalCommandFingerprint("eval"), catalogRowId: "model", model: "model", modelVersion: "version-1", settingsFingerprint: "e".repeat(64) };
function world() {
  const ledger: Array<{ company: string; provider: string }> = [];
  const cache = createDocumentBaseScoreCache(new MemoryDocumentStore(), { companyId: company });
  const grant = { company, project: "p", selection: "evals/refund", role: "maintainer" as const, provider: "customer" as const, connected: true, maxCalls: 200, maxCostMicros: 2_000_000 };
  const approval: EvalSpendApproval = { read: async () => grant };
  const meter: MonthlyMeter = { reserve: async (request) => ({
    // The fake is an adapter: the capability's payer comes from the trusted grant, never the repository.
    call: async () => { ledger.push({ company: request.approval.company, provider: request.approval.provider }); return { class: "ok" as const, calls: 1, costMicros: 10 }; },
    close: async () => {},
  }) };
  const input: EvalHealthInput = { key, selection: "evals/refund", questionIds: ["one", "two"], maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10, approval, meter, cache,
    run: async ({ run, call }) => {
      await call(frame); await call(frame);
      return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: key.baseCommit }), seconds: 2,
        measures: { schemaVersion: 1, source: "project_runner", eval_set_hash: key.evalSetHash, measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: [
          { id: "one", samples: [{ pass: true, answer: "steady" }] }, { id: "two", samples: [{ pass: run !== 2, answer: run === 2 ? "different" : "same" }] },
        ] } };
    } };
  return { input, ledger, grant, cache };
}

describe("setup eval health", () => {
  it("measures three runs, meters the customer and saves the old-code baseline", async () => {
    const w = world(); const result = await runEvalHealth(w.input);
    expect(result.status).toBe("measured");
    if (result.status !== "measured") return;
    expect(result.questionCount).toBe(2); expect(result.passRate).toBeCloseTo(5 / 6);
    expect(result.flaky).toEqual(["two"]); expect(result.callsPerRun).toEqual([2, 2, 2]); expect(result.secondsPerRun).toEqual([2, 2, 2]);
    expect(result.perQuestion).toBe(true);
    expect(w.ledger).toEqual(Array.from({ length: 6 }, () => ({ company, provider: "customer" })));
    expect((await w.cache.read(key))?.questions?.map(q => q.samples.length)).toEqual([3, 3]);
  });
  it.each(["approval", "meter"] as const)("refuses an unwired %s before spending", async field => {
    const w = world(); delete w.input[field];
    const result = await runEvalHealth(w.input); expect(result.status).toBe("not_run");
    if (result.status === "not_run") expect(result.message).toContain("not connected"); expect(w.ledger).toHaveLength(0);
  });
  it.each(["absent", "role", "company", "project", "provider", "connected", "selection", "estimate"])("refuses %s approval before spending", async kind => {
    const w = world();
    w.input.approval = { read: async () => kind === "absent" ? undefined : ({ ...w.grant, ...({ role: { role: "viewer" }, company: { company: "other" }, project: { project: "other" }, provider: { provider: "rovara" }, connected: { connected: false }, selection: { selection: "other" }, estimate: { maxCalls: 5 } }[kind]) } as typeof w.grant) };
    expect(await runEvalHealth(w.input)).toMatchObject({ status: "not_run" }); expect(w.ledger).toHaveLength(0);
  });
  it.each([{ maxCallsPerQuestion: 34 }, { maxCostMicrosPerQuestion: 400_000 }, { maxCallsPerQuestion: NaN }, { maxCostMicrosPerQuestion: -1 }])("refuses an invalid or over-cap estimate", async over => {
    const w = world(); expect(await runEvalHealth({ ...w.input, ...over })).toMatchObject({ status: "not_run" }); expect(w.ledger).toHaveLength(0);
  });
  it("refuses a monthly reservation denial with zero calls", async () => {
    const w = world(); w.input.meter = { reserve: async () => undefined };
    expect(await runEvalHealth(w.input)).toMatchObject({ status: "not_run" }); expect(w.ledger).toHaveLength(0);
  });
  it("uses configurable call caps and refuses before invoking a seventh call", async () => {
    const w = world(); w.input.limits = { maxCalls: 6, maxCostMicros: 60 };
    expect((await runEvalHealth(w.input)).status).toBe("measured");
    const extra = world(); extra.input.run = async ({ call }) => { for (let i = 0; i < 7; i++) await call(frame); throw new Error("must stop earlier"); };
    expect((await runEvalHealth(extra.input)).status).toBe("not_run"); expect(extra.ledger).toHaveLength(6);
  });
  it.each(["missing", "duplicate", "hash", "attestation", "numeric", "no_calls"])("does not cache incomplete or untrusted %s evidence", async kind => {
    const w = world(); const run = w.input.run.bind(w.input);
    w.input.run = async request => {
      const output = await run(kind === "no_calls" ? { ...request, call: async () => ({ class: "ok" as const, calls: 1, costMicros: 10 }) } : request);
      if (kind === "missing") output.measures.questions!.pop();
      if (kind === "duplicate") output.measures.questions![1]!.id = "one";
      if (kind === "hash") output.measures.eval_set_hash = "f".repeat(64);
      if (kind === "attestation") output.attestation = { ...output.attestation };
      if (kind === "numeric") output.seconds = Infinity;
      return output;
    };
    expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(await w.cache.read(key)).toBeUndefined();
  });
});

it.each([
  ["empty", { questionIds: [] }], ["duplicate", { questionIds: ["one", "one"] }], ["oversize", { questionIds: Array.from({ length: 1001 }, (_, i) => String(i)) }],
  ["bad id", { questionIds: [""] }], ["bad key", { key: { ...key, modelVersion: "" } }], ["legacy key", { key: { ...key, codeHash: undefined, judgePin: undefined } }], ["private set", { key: { ...key, hiddenSetHash: "a".repeat(64) } }],
] as const)("refuses %s inputs before reserving", async (_name, over) => {
  const w = world(); let reserved = false;
  w.input.meter = { reserve: async () => { reserved = true; return undefined; } };
  expect((await runEvalHealth({ ...w.input, ...over } as EvalHealthInput)).status).toBe("not_run"); expect(reserved).toBe(false);
});
it.each([NaN, -1, 61])("stops after invalid or excessive actual cost %s", async costMicros => {
  const w = world(); let calls = 0;
  w.input.meter = { reserve: async () => ({ call: async () => { calls++; return { class: "ok" as const, calls: 1, costMicros }; }, close: async () => {} }) };
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(calls).toBe(1); expect(await w.cache.read(key)).toBeUndefined();
});
it("joins pending calls and closes the reservation before saving; late calls are refused", async () => {
  const w = world(); w.input.maxCallsPerQuestion = 2; w.input.maxCostMicrosPerQuestion = 20; let closed = false; let late: (() => Promise<unknown>) | undefined;
  const run = w.input.run.bind(w.input);
  const meter = w.input.meter!;
  w.input.meter = { reserve: async request => { const reservation = (await meter.reserve(request))!; return { ...reservation, close: async () => { closed = true; } }; } };
  w.input.run = async request => { late = () => request.call(frame); return run(request); };
  const write = w.cache.write.bind(w.cache);
  w.input.cache = { ...w.cache, write: async (...args) => { expect(closed).toBe(true); return write(...args); } };
  expect((await runEvalHealth(w.input)).status).toBe("measured");
  await expect(late!()).rejects.toThrow(); expect(w.ledger).toHaveLength(6);
});
it("retains an honest measured result if only saving the baseline is refused", async () => {
  const w = world(); w.input.cache = { ...w.cache, write: async () => "refused" };
  expect(await runEvalHealth(w.input)).toMatchObject({ status: "measured", baseline: "refused", passRate: 5 / 6 });
});
it("fits the closest whole three-run estimate under the default caps", async () => {
  const w = world(); w.input.questionIds = ["one"]; w.input.maxCallsPerQuestion = 66; w.input.maxCostMicrosPerQuestion = 666_666;
  let request: unknown;
  w.input.meter = { reserve: async r => { request = r; return undefined; } };
  await runEvalHealth(w.input);
  expect(request).toMatchObject({ calls: 198, costMicros: 1_999_998 });
});
it("accepts 1,000 questions with an explicitly approved larger cap", async () => {
  const w = world(); w.input.questionIds = Array.from({ length: 1000 }, (_, i) => `q${i}`);
  w.input.limits = { maxCalls: 3000, maxCostMicros: 30_000 }; w.grant.maxCalls = 3000;
  let request: unknown;
  w.input.meter = { reserve: async r => { request = r; return undefined; } };
  await runEvalHealth(w.input); expect(request).toMatchObject({ calls: 3000, costMicros: 30_000 });
});
it("requires the main commit's own branded attestation", async () => {
  const w = world(); const run = w.input.run.bind(w.input);
  w.input.run = async r => ({ ...await run(r), attestation: attestRovaraOnlyBaseCheckout({ baseCommit: "b".repeat(40) }) });
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(await w.cache.read(key)).toBeUndefined();
});
it("does not save when joining the metered provider capability fails", async () => {
  const w = world(); const meter = w.input.meter!;
  w.input.meter = { reserve: async r => ({ ...(await meter.reserve(r))!, close: async () => { throw new Error("private provider error"); } }) };
  const result = await runEvalHealth(w.input);
  expect(result.status).toBe("not_run"); expect(JSON.stringify(result)).not.toContain("private provider"); expect(await w.cache.read(key)).toBeUndefined();
});
it.each(["calls", "cost"])("keeps default %s caps even with a larger approved estimate", async field => {
  const w = world(); w.grant.maxCalls = 1000; w.grant.maxCostMicros = 10_000_000;
  if (field === "calls") w.input.maxCallsPerQuestion = 34; else w.input.maxCostMicrosPerQuestion = 400_000;
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(w.ledger).toHaveLength(0);
});
it("measures and saves all 1,000 questions with the configured cap", async () => {
  const w = world(); const ids = Array.from({ length: 1000 }, (_, i) => `q${i}`);
  w.input.questionIds = ids; w.input.limits = { maxCalls: 3000, maxCostMicros: 30_000 }; w.grant.maxCalls = 3000;
  w.input.run = async ({ call }) => {
    for (let i = 0; i < ids.length; i++) await call(frame);
    return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: key.baseCommit }), seconds: 1,
      measures: { schemaVersion: 1, source: "project_runner", eval_set_hash: key.evalSetHash, measures: [{ name: "score", unit: "fraction", direction: "up_good", value: 0 }], questions: ids.map(id => ({ id, samples: [{ pass: false, answer: "failed" }] })) } };
  };
  expect(await runEvalHealth(w.input)).toMatchObject({ status: "measured", questionCount: 1000, passRate: 0, baseline: "stored", sensitivity: { smallestDropPoints: null, additionalQuestionsFor20: null, powerAt20: 0 } });
  expect(w.ledger).toHaveLength(3000); expect((await w.cache.read(key))?.questions).toHaveLength(1000);
}, 60_000);
it("uses fake ModelEgress's customer capability and charges only its company", async () => {
  const w = world(); const egress = fakeModelEgressWorld(); const row = egress.rows.gemini!;
  const scope = egress.scope(COMPANY_A, row.id);
  const beforeB = await egress.meterOf(COMPANY_B);
  w.grant.company = COMPANY_A.orgId; w.input.key = { ...key, company: COMPANY_A.orgId };
  w.input.cache = createDocumentBaseScoreCache(new MemoryDocumentStore(), { companyId: COMPANY_A.orgId });
  w.input.maxCostMicrosPerQuestion = 100_000;
  w.input.meter = { reserve: async request => {
    if (request.approval.company !== COMPANY_A.orgId || request.approval.provider !== "customer") return undefined;
    return { call: async f => {
      let costMicros = 0; let outcome: ModelEgressClass = "provider_error";
      for await (const event of egress.adapter.forward(scope, f)) if (event.kind === "settle") { outcome = event.class; costMicros += event.costMicros; }
      return { class: outcome, calls: 1, costMicros };
    }, close: async () => {} };
  } };
  const run = w.input.run.bind(w.input);
  w.input.run = r => run({ ...r, call: () => r.call(ModelEgressFrameSchema.parse(validFrame(row, egress.connection))) });
  expect((await runEvalHealth(w.input)).status).toBe("measured");
  expect(egress.provider.calls).toHaveLength(6);
  expect(await egress.meterOf(COMPANY_B)).toEqual(beforeB);
  expect(await egress.meterOf(COMPANY_A)).not.toEqual(beforeB);
  egress.provider.script({ status: 500, body: "{}" });
  expect((await runEvalHealth(w.input)).status).toBe("not_run");
  expect(egress.provider.calls).toHaveLength(7);
  expect(await egress.meterOf(COMPANY_B)).toEqual(beforeB);
});
it("keeps completed failed answers visible even if the cache throws", async () => {
  const w = world(); w.input.cache = { ...w.cache, write: async () => { throw new Error("storage unavailable"); } };
  expect(await runEvalHealth(w.input)).toMatchObject({ status: "measured", baseline: "refused", passRate: 5 / 6 });
});
it("requires an explicit true connection state from the approval reader", async () => {
  const w = world(); w.input.approval = { read: async () => ({ ...w.grant, connected: "connected" as unknown as boolean }) };
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(w.ledger).toHaveLength(0);
});
it.each([{ maxCalls: NaN }, { maxCostMicros: NaN }, { maxCostMicros: 5 }])("requires a finite sufficient approved estimate", async over => {
  const w = world(); w.input.approval = { read: async () => ({ ...w.grant, ...over }) };
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(w.ledger).toHaveLength(0);
});
it("never saves apparently passing answers after a metered provider error", async () => {
  const w = world(); let calls = 0;
  w.input.meter = { reserve: async () => ({ call: async () => { calls++; return { calls: 1, costMicros: 10, class: "provider_error" as const }; }, close: async () => {} }) };
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(calls).toBe(1); expect(await w.cache.read(key)).toBeUndefined();
});
it("does not dispatch another call after an overrun even if the runner catches it", async () => {
  const w = world(); let calls = 0;
  w.input.meter = { reserve: async () => ({ call: async () => { calls++; return { class: "ok", calls: 1, costMicros: 61 }; }, close: async () => {} }) };
  w.input.run = async ({ call }) => { await call(frame).catch(() => {}); await call(frame).catch(() => {}); throw new Error("stopped"); };
  expect((await runEvalHealth(w.input)).status).toBe("not_run"); expect(calls).toBe(1);
});
it.each([false, true])("joins in-flight calls before closing, including a throwing runner (%s)", async throws => {
  const w = world(); let release!: () => void; let started!: () => void; let closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; }); const began = new Promise<void>(resolve => { started = resolve; });
  w.input.meter = { reserve: async () => ({ call: async () => { started(); await gate; return { class: "ok", calls: 1, costMicros: 10 }; }, close: async () => { closed = true; } }) };
  w.input.run = async ({ call }) => {
    void call(frame).catch(() => {});
    if (throws) throw new Error("runner stopped before call settled");
    return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: key.baseCommit }), seconds: 1,
      measures: { schemaVersion: 1, source: "project_runner", eval_set_hash: key.evalSetHash, measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: ["one", "two"].map(id => ({ id, samples: [{ pass: true, answer: "a" }] })) } };
  };
  const result = runEvalHealth(w.input); await began;
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(false); expect(await w.cache.read(key)).toBeUndefined();
  release(); expect((await result).status).toBe(throws ? "not_run" : "measured"); expect(closed).toBe(true);
});
