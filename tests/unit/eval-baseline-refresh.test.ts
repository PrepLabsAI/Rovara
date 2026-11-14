import { expect, it } from "vitest";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { evaluateReadiness } from "../../packages/worker/src/readiness.js";
import type { EvalHealthInput } from "../../packages/worker/src/verification/eval-health.js";
const key = { company: "org_aaaaaaaaaaaaaaaaaaaa", project: "p", baseCommit: "a".repeat(40), codeHash: "b".repeat(64), judgePin: "c".repeat(64), evalSetHash: "d".repeat(64), hiddenSetHash: "none", commandFingerprint: "e".repeat(64), catalogRowId: "model", model: "model", modelVersion: "version", settingsFingerprint: "f".repeat(64) };
it("lets the first task proceed while main is measured and joins the refresh", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); let reads = 0;
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => { reads++; await gate; return undefined; } } } as unknown as EvalHealthInput;
  const service = createEvalBaselines();
  const refreshing = service.afterMerge(input);
  let state: string | undefined;
  const task = service.forTask({ ...input, cache: { ...input.cache, read: async () => undefined } }).then(result => { state = result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state).toBe("measuring"); expect(reads).toBe(1);
  } finally { finish(); await Promise.all([refreshing, task]); }
  expect((await refreshing).status).toBe("not_run");
  expect(await service.forTask(input)).toBe("unavailable");
});
it("uses the existing readiness path and refuses unwired eval capabilities without affecting readiness", async () => {
  const result = await evaluateReadiness({ rootPath: process.cwd(), commands: [], evalSetup: {} }, async () => { throw new Error("no commands"); });
  expect(result.ready).toBe(true);
  const measurement = await result.eval!.measurement; expect(measurement.status).toBe("not_run");
  if (measurement.status === "not_run") expect(measurement.message).toContain("not connected");
});
it("reuses complete cached questions and isolates in-flight work by company", async () => {
  const record = { schemaVersion: 1, measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: [{ id: "q", samples: Array.from({ length: 3 }, () => ({ pass: true, answer: "a" })) }], caseCount: 1, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1 };
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => record } } as unknown as EvalHealthInput;
  const service = createEvalBaselines();
  expect(await service.afterMerge(input)).toEqual({ status: "cached" });
  expect(await service.forTask(input)).toBe("ready");
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = service.afterMerge({ ...input, key: { ...key, codeHash: "1".repeat(64) }, cache: { ...input.cache, read: async () => { await pending; return undefined; } } });
  expect(await service.forTask({ ...input, key: { ...key, company: "org_bbbbbbbbbbbbbbbbbbbb", codeHash: "1".repeat(64) } })).toBe("ready");
  finish(); await first;
});

it("does not share an in-flight baseline across different runner settings", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const input = { key, settings: { imageDigest: "image", route: "customer" }, cache: { read: async () => { await gate; return undefined; } } } as unknown as EvalHealthInput;
  const service = createEvalBaselines(); const first = service.afterMerge(input);
  let otherRead = false;
  const other = service.afterMerge({ ...input, settings: { ...input.settings, route: "different" }, cache: { ...input.cache, read: async () => { otherRead = true; return undefined; } } });
  try {
    expect(other).not.toBe(first); expect(otherRead).toBe(true);
    expect((await other).status).toBe("not_run");
  } finally { finish(); await Promise.all([first, other]); }
});

// Two hosts, one persisted cache: setup's measurement must be visible to the task.
import { attestRovaraOnlyBaseCheckout, createDocumentBaseScoreCache, evalSpendInputsDigest, type ModelEgressFrame, type EvalBaseRecord } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { evalHealthKey } from "../../packages/worker/src/verification/eval-health.js";
function approvalInputsDigest(input: Pick<EvalHealthInput, "key" | "settings">) {
  const { evalSetHash, judgePin, modelVersion, model, catalogRowId, commandFingerprint, settingsFingerprint } = evalHealthKey(input);
  return evalSpendInputsDigest({ evalSetHash, judgePin: judgePin!, modelVersion, model, catalogRowId, commandFingerprint, settingsFingerprint });
}
function persistedWorld() {
  const store = new MemoryDocumentStore(); let time = 1_800_000_000_000; let reservations = 0; let calls = 0;
  const cache = () => createDocumentBaseScoreCache(store, { companyId: key.company, now: () => time });
  const input: EvalHealthInput = { key, settings: { imageDigest: "image", route: "customer" }, cache: cache(), selection: "eval", questionIds: ["q"], maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 10,
    approval: { read: async () => ({ company: key.company, project: key.project, selection: "eval", inputsDigest: approvalInputsDigest(input), role: "maintainer", provider: "customer", connected: true, maxCalls: 3, maxCostMicros: 30 }) },
    meter: { reserve: async () => { reservations++; return { call: async () => { calls++; return { class: "ok", calls: 1, costMicros: 10 }; }, close: async () => {} }; } },
    run: async ({ call }) => { await call({} as ModelEgressFrame); return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: key.baseCommit }), seconds: 1,
      measures: { schemaVersion: 1, source: "project_runner", eval_set_hash: key.evalSetHash, measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: [{ id: "q", samples: [{ pass: true, answer: "a" }] }] } }; },
  };
  return { input, store, cache, advance: (ms: number) => { time += ms; }, usage: () => ({ reservations, calls }) };
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
it("persists measuring across hosts before reserving, then permits a new round after completion", async () => {
  const w = persistedWorld(); const entered = latch(); const gate = latch(); const run = w.input.run.bind(w.input);
  w.input.run = async r => { entered.release(); await gate.promise; return run(r); };
  const setup = createEvalBaselines().afterMerge(w.input); await entered.promise;
  const before = w.usage(); let claims = 0; let cacheReads = 0; let markReads = 0;
  const taskCache = w.cache();
  try {
    const task = createEvalBaselines().forTask({ ...w.input, cache: { ...taskCache, read: async parts => { cacheReads++; return taskCache.read(parts); }, readMeasurement: async parts => { markReads++; return taskCache.readMeasurement!(parts); }, startMeasurement: async parts => { claims++; return taskCache.startMeasurement!(parts); } } });
    expect(await Promise.race([task, new Promise(resolve => setImmediate(() => resolve("still waiting")))])).toBe("measuring");
    expect(w.usage()).toEqual(before); expect(claims).toBe(0); expect(cacheReads).toBe(1); expect(markReads).toBe(1);
  } finally { gate.release(); await setup; }
  expect(w.usage()).toEqual({ reservations: 1, calls: 3 });
  expect(await createEvalBaselines().forTask({ ...w.input, cache: w.cache() })).toBe("ready");
});
it("conditionally claims simultaneous starts so only one host reserves", async () => {
  const w = persistedWorld();
  const results = await Promise.all([createEvalBaselines().afterMerge(w.input), createEvalBaselines().afterMerge({ ...w.input, cache: w.cache() })]);
  expect(results.map(r => r.status).sort()).toEqual(["measured", "measuring"]);
  expect(w.usage()).toEqual({ reservations: 1, calls: 3 });
});
it("reclaims at sixty minutes and an old finisher cannot release its successor", async () => {
  const w = persistedWorld(); const a = await w.input.cache.startMeasurement!(evalHealthKey(w.input));
  expect(a.status).toBe("started");
  w.advance(3_599_000); expect(await createEvalBaselines().forTask(w.input)).toBe("measuring");
  w.advance(1_000);
  const b = await w.input.cache.startMeasurement!(evalHealthKey(w.input)); expect(b.status).toBe("started");
  if (a.status !== "started" || b.status !== "started") throw new Error("missing mark");
  await w.input.cache.finishMeasurement!(evalHealthKey(w.input), a.mark);
  expect(await createEvalBaselines().forTask(w.input)).toBe("measuring");
  w.advance(3_600_001);
  expect(await createEvalBaselines().forTask(w.input)).toBe("ready"); expect(w.usage()).toEqual({ reservations: 1, calls: 3 });
});
it.each(["measured", "refused", "thrown"])("finishes the mark on the %s ending", async ending => {
  const w = persistedWorld();
  if (ending === "refused") w.input.approval = { read: async () => undefined };
  if (ending === "thrown") w.input.run = async () => { throw new Error("private canary"); };
  const result = await createEvalBaselines().afterMerge(w.input);
  expect(result.status).toBe(ending === "measured" ? "measured" : "not_run");
  expect(w.usage()).toEqual({ reservations: ending === "refused" ? 0 : 1, calls: ending === "measured" ? 3 : 0 });
  expect(JSON.stringify(result)).not.toContain("private canary");
  const docs = (await w.store.query({ pk: `ORG#${key.company}#EVALBASE` })).items.filter(d => d.sk.startsWith("M#"));
  expect(docs).toHaveLength(1); expect(docs[0]).toMatchObject({ state: "finished", startedAt: 1_800_000_000, expiresAt: 1_800_003_600 });
});
it("maps unconfirmed health to awaiting_confirmation without a reservation", async () => {
  const w = persistedWorld(); w.input.approval = { read: async () => undefined };
  expect(await createEvalBaselines().forTask(w.input)).toBe("awaiting_confirmation");
  expect(w.usage()).toEqual({ reservations: 0, calls: 0 });
});
it.each([{ company: "org_bbbbbbbbbbbbbbbbbbbb" }, { codeHash: "1".repeat(64) }, { evalSetHash: "2".repeat(64) }, { modelVersion: "other" }])("does not share measuring across identity %j", async over => {
  const w = persistedWorld(); await w.input.cache.startMeasurement!(evalHealthKey(w.input));
  const otherKey = { ...key, ...over }; const grant = await w.input.approval!.read();
  const other = { ...w.input, key: otherKey, cache: createDocumentBaseScoreCache(w.store, { companyId: otherKey.company, now: () => 1_800_000_000_000 }), approval: { read: async () => ({ ...grant!, company: otherKey.company, inputsDigest: approvalInputsDigest({ ...w.input, key: otherKey }) }) } };
  expect(await createEvalBaselines().forTask(other)).not.toBe("measuring");
  expect(w.usage().reservations).toBe(1);
});
it("uses a saved record before a fresh measuring mark", async () => {
  const w = persistedWorld(); expect((await createEvalBaselines().afterMerge(w.input)).status).toBe("measured");
  await w.input.cache.startMeasurement!(evalHealthKey(w.input));
  expect(await createEvalBaselines().forTask(w.input)).toBe("ready"); expect(w.usage().reservations).toBe(1);
});
it("rechecks a saved baseline after acquiring a delayed claim", async () => {
  const w = persistedWorld(); const entered = latch(); const gate = latch(); const cache = w.cache();
  const delayed = createEvalBaselines().afterMerge({ ...w.input, cache: { ...cache, startMeasurement: async parts => { entered.release(); await gate.promise; return cache.startMeasurement!(parts); } } });
  await entered.promise;
  try { expect((await createEvalBaselines().afterMerge(w.input)).status).toBe("measured"); }
  finally { gate.release(); }
  expect((await delayed).status).toBe("cached"); expect(w.usage()).toEqual({ reservations: 1, calls: 3 });
});
it("does not spend through score-only caches or unknown measuring states", async () => {
  const w = persistedWorld();
  expect(await createEvalBaselines().afterMerge({ ...w.input, cache: { read: w.input.cache.read.bind(w.input.cache), write: w.input.cache.write.bind(w.input.cache) } })).toEqual({ status: "not_run", reason: "unavailable", message: "Not run: baseline could not be read." });
  for (const state of [undefined, "private canary", null, 9]) {
    expect(await createEvalBaselines().forTask({ ...w.input, cache: { ...w.input.cache, readMeasurement: async () => state as never } })).toBe("unavailable");
  }
  expect(w.usage()).toEqual({ reservations: 0, calls: 0 });
});
it("keeps saved cache hits ahead of a same-host measurement and preserves ordinary readiness bytes", async () => {
  const w = persistedWorld(); const gate = latch(); const entered = latch(); const original = w.input.run.bind(w.input);
  const service = createEvalBaselines();
  w.input.run = async r => { entered.release(); await gate.promise; return original(r); };
  const measuring = service.afterMerge(w.input); await entered.promise;
  try {
    const saved: EvalBaseRecord = { schemaVersion: 1, runnerSchemaVersion: 1, roundKind: "check_unsealed", recordedOn: "2026-11-13", measures: [{ name: "pass", unit: "fraction", value: 1, direction: "up_good" }], questions: [{ id: "q", samples: Array.from({ length: 3 }, () => ({ pass: true, answer: "a" })) }], caseCount: 1 };
    expect(await service.forTask({ ...w.input, cache: { ...w.input.cache, read: async () => saved } })).toBe("ready");
  } finally { gate.release(); await measuring; }
  expect(JSON.stringify(await evaluateReadiness({ rootPath: process.cwd(), commands: [] }, async () => { throw new Error("unused"); }))).toBe('{"ready":true,"results":[]}');
});
