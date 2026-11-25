import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { chargeReceipt } from "./model-gateway-charge-receipt-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { companyPartition, DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { neverConfirmedReceipt, provisionalEstimate } from "../../packages/model-gateway/src/provisional.js";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
beforeAll(denyNetwork);
const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
const caps = { task: 10_000, projectMonth: 10_000, companyMonth: 10_000 };
const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000, cacheReadMicrosPerMTok: 0, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 1_000_000, estimated: false };
const context = { requestBytes: 10, maxOutputTokens: 90, price };
it("24h clock settlement is explicitly estimated and never confirmed", () => {
  expect(neverConfirmedReceipt(chargeReceipt(), 40, Date.parse("2026-02-02T00:00:00.000Z"))).toMatchObject({ status: "estimated", reason: "missing_usage", neverConfirmed: true, revision: 2, replacesRevision: 1, amountMicros: { state: "available", value: 40 }, accountingDay: "2026-01-31", accountingMonth: "2026-01" });
});
it("uses nearest-rank p90, at least 20 samples, dearer applicable rates and caps at R", () => {
  const history = [...Array<number>(17).fill(1), 30, 80, 90];
  expect(provisionalEstimate(100, context, history)).toEqual({ amountMicros: 40, estimateBasis: "input_bytes_bound", outputEstimateBasis: "p90_history" });
  expect(provisionalEstimate(100, context, history, 2)).toMatchObject({ amountMicros: 32, estimateBasis: "input_actual" });
  expect(provisionalEstimate(100, context, history.slice(1))).toMatchObject({ amountMicros: 100, estimateBasis: "reservation" });
  expect(provisionalEstimate(20, context, history)).toMatchObject({ amountMicros: 20 });
  expect(provisionalEstimate(1_000_000, { ...context, requestBytes: 40_000, price: { ...price, longContext: [{ aboveTokens: 32_000, inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 1_000_000, cacheReadMicrosPerMTok: 0, cacheWrite5mMicrosPerMTok: 2_000_000, cacheWrite1hMicrosPerMTok: 2_000_000 }] } }, history)).toMatchObject({ amountMicros: 80_030 });
});
it("a synthetic stream-start zero is never actual input evidence; a nonzero provider start is", () => {
  const collector = new UsageCollector();
  collector.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n'));
  expect(collector.finish()).toBeUndefined();
  expect(collector.actualInputTokens()).toBeUndefined();
  expect(provisionalEstimate(100, context, Array<number>(20).fill(1), collector.actualInputTokens())).toMatchObject({ amountMicros: 11, estimateBasis: "input_bytes_bound" });
  const actual = new UsageCollector();
  actual.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2}}}\n\n'));
  expect(actual.actualInputTokens()).toBe(5);
});
for (const adapter of ["memory", "dynamo"]) for (const lateAfterSettle of [false, true]) it(`${adapter}: cutoff hold, 24h estimate, late revision (${lateAfterSettle}) preserve original periods`, async () => {
  let now = Date.parse("2026-01-31T23:59:00.000Z");
  const wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const meter = adapter === "memory" ? new InMemoryMeter(() => now) : new DynamoMeter({ db, tables, now: () => now });
  // Real, complete settled calls from this company and model supply output history.
  for (let n = 0; n < 20; n++) {
    const held = await meter.reserve({ scope, caps, estimateMicros: 100 }); if (!held.ok) throw new Error("reserve");
    await meter.settleV2({ reservationId: held.reservation.id, receipt: chargeReceipt({ callId: held.reservation.id, originalReservationMicros: { state: "available", value: 100 }, status: "final", reason: "reported_cost", providerCostMicros: { state: "available", value: 1 }, amountMicros: { state: "available", value: 1 }, usageComplete: true, usage: { state: "available", value: { input: 0, output: n < 17 ? 1 : n === 17 ? 30 : 90, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } } }) });
  }
  const first = chargeReceipt({ originalReservationMicros: { state: "available", value: 100 }, amountMicros: { state: "available", value: 100 } });
  const held = await meter.reserve({ scope, caps, estimateMicros: 100, charge: { receipt: first, requestFingerprint: "a".repeat(64) }, provisional: context }); if (!held.ok) throw new Error("reserve");
  await meter.settleV2({ reservationId: held.reservation.id, receipt: first });
  expect((await meter.read(scope)).every(r => r.committed === 60 && r.reservedMicros === 40 && r.spentMicros === 20)).toBe(true);
  expect((await meter.read(scope)).find(r => r.item === "company")).toMatchObject({ provisionalMicros: 40 });
  const atCutoff = now;
  const callKey = JSON.stringify([first.issuer, first.companyId, first.callId]);
  await meter.expire({ callKey, now, runId: "expiry-1" });
  const expiryCalls = wire.calls.length;
  await meter.expire({ callKey, now: now + 1, runId: "expiry-2" });
  if (adapter === "dynamo") expect(wire.calls.slice(expiryCalls).filter(c => c.operation === "UpdateItem")).toHaveLength(0);
  const unresolved = adapter === "dynamo" ? wire.items(tables.ledger).find(r => r.sk === `CALL#${first.callId}`) : meter instanceof InMemoryMeter ? meter.ledger(callKey) : undefined;
  expect(unresolved).toMatchObject({ unresolvedAt: now });

  now += 86_400_000 - 1;
  await meter.sweepOpenHolds(now, 100);
  expect((await meter.read(scope)).find(r => r.item === "task")).toMatchObject({ reservedMicros: 40 });
  let revision = 2;
  if (lateAfterSettle) {
    now++;
    await meter.sweepOpenHolds(now, 100);
    await meter.sweepOpenHolds(now, 100);
    expect((await meter.read(scope)).find(r => r.item === "task")).toMatchObject({ reservedMicros: 0, spentMicros: 60, estimatedMicros: 40 });
    revision = 3;
    expect(await meter.expire({ callKey, now, runId: "expiry-retained" })).toEqual({ status: "already" });
    expect(await meter.correct({ callKey, now, runId: "correction", realMicros: 10, caps, priceSource: { source: "override", fetchedAt: now } })).toEqual({ status: "already" });
    if (adapter === "dynamo") expect(wire.items(tables.ledger).find(r => r.sk === `CALL#${first.callId}`)).toMatchObject({ chargeStatus: "estimated", neverConfirmed: true, estimateBasis: "input_bytes_bound", receipt: { status: "estimated", revision: 2 } });
  }
  const final = { ...first, revision, replacesRevision: revision - 1, status: "final" as const, reason: "reported_cost" as const, amountMicros: { state: "available" as const, value: lateAfterSettle ? 70 : 25 }, providerCostMicros: { state: "available" as const, value: lateAfterSettle ? 70 : 25 }, recordedAt: new Date(now).toISOString() };
  expect(await meter.applyChargeReceipt(final)).toMatchObject({ deltaMicros: lateAfterSettle ? 30 : -15, appliedRevision: revision });
  await meter.sweepOpenHolds(now + 86_400_000, 100);
  expect(await meter.applyChargeReceipt(final)).toMatchObject({ result: "duplicate" });
  expect(await meter.applyChargeReceipt({ ...final, revision: revision + 1, replacesRevision: revision })).toMatchObject({ deltaMicros: 0 });
  expect((await meter.read(scope)).find(r => r.item === "company")?.provisionalMicros).toBeUndefined();
  now = atCutoff;
  expect((await meter.read(scope)).find(r => r.item === "company")).toMatchObject({ provisionalMicros: 0 });
  expect((await meter.read(scope)).every(r => r.spentMicros === 20 + (lateAfterSettle ? 70 : 25) && r.estimatedMicros === 0 && r.reservedMicros === 0)).toBe(true);
  if (adapter === "dynamo") expect(wire.items(tables.ledger).filter(r => String(r.sk).startsWith(`ADJUST#${first.callId}#`))).toHaveLength(revision + 1);
});

for (const adapter of ["memory", "dynamo"]) it(`${adapter}: no history retains R; admin total sums holds and never-confirmed estimates once`, async () => {
  let now = Date.parse("2026-01-31T23:59:00.000Z");
  const wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const meter = adapter === "memory" ? new InMemoryMeter(() => now) : new DynamoMeter({ db, tables, now: () => now });
  const first = chargeReceipt({ amountMicros: { state: "available", value: 100 }, originalReservationMicros: { state: "available", value: 100 } });
  const second = { ...first, callId: "00000000-0000-4000-8000-000000000002" };
  for (const receipt of [first, second]) {
    const r = await meter.reserve({ scope, caps, estimateMicros: 100, charge: { receipt, requestFingerprint: "a".repeat(64) }, provisional: context }); if (!r.ok) throw new Error("reserve");
    await meter.settleV2({ reservationId: r.reservation.id, receipt });
    now += 1000;
  }
  const cutoff = now - 2000;
  expect((await meter.read(scope)).find(r => r.item === "company")).toMatchObject({ provisionalMicros: 200, reservedMicros: 200, spentMicros: 0, committed: 200 });
  expect((await meter.pendingFor({ provider: first.model.provider, model: first.model.modelId }, 100)).items).toEqual(expect.arrayContaining([expect.objectContaining({ estimateBasis: "reservation", outputEstimateBasis: "max_output", settledMicros: 100 })]));
  now = cutoff + 86_400_000;
  await meter.sweepOpenHolds(now, 100);
  expect((await meter.pendingFor({ provider: first.model.provider, model: first.model.modelId }, 100)).items.filter(c => c.neverConfirmed)).toHaveLength(1);
  now = cutoff;
  expect((await meter.read(scope)).find(r => r.item === "company")).toMatchObject({ provisionalMicros: 200, reservedMicros: 100, spentMicros: 100, estimatedMicros: 100, committed: 200 });
  const noRoom = await meter.reserve({ scope, caps: { task: 200, projectMonth: 200, companyMonth: 200 }, estimateMicros: 1 });
  expect(noRoom.ok).toBe(false);
});

it("tool allowance augments only the unknown-input bytes bound", () => {
  const toolContext = { ...context, toolInputAllowanceTokens: 4096 };
  expect(provisionalEstimate(5000, toolContext, Array<number>(20).fill(30))).toMatchObject({ amountMicros: 4136 });
  expect(provisionalEstimate(5000, toolContext, Array<number>(20).fill(30), 2)).toMatchObject({ amountMicros: 32 });
});
it("history is one reverse-key query of at most 200 CALL rows; other models cannot supply p90", async () => {
  const wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const meter = new DynamoMeter({ db, tables, now: () => Date.parse("2026-01-31T23:59:00Z") });
  const receipt = chargeReceipt({ originalReservationMicros: { state: "available", value: 100 }, amountMicros: { state: "available", value: 100 } });
  for (let n = 0; n < 220; n++) await db.put(tables.ledger, { pk: companyPartition(scope.iss, scope.cid), sk: `CALL#z${String(n).padStart(4, "0")}`, iss: scope.iss, cid: scope.cid, provider: receipt.model.provider, model: n >= 201 ? receipt.model.modelId : "other-model", chargeStatus: "final", usage: { input: 1, output: 30, cacheRead: 0, cacheWrite: 0 } });
  const held = await meter.reserve({ scope, caps, estimateMicros: 100, charge: { receipt, requestFingerprint: "a".repeat(64) }, provisional: context }); if (!held.ok) throw new Error("reserve");
  const start = wire.calls.length;
  await meter.settleV2({ reservationId: held.reservation.id, receipt });
  const reads = wire.calls.slice(start).filter(c => c.operation === "Query" && c.table === tables.ledger);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.input).toMatchObject({ Limit: 200, ScanIndexForward: false });
  expect((await meter.read(scope)).find(r => r.item === "company")).toMatchObject({ reservedMicros: 100 });
});
// A call that failed after it was sent, with no usage, is settled at once at an estimate below the hold (failed-call.ts): a never-confirmed receipt at revision 1.
for (const adapter of ["memory", "dynamo"]) it(`${adapter}: a failed-call estimate spends at once, is flagged never-confirmed, and leaves nothing for the 24h sweep or a price correction`, async () => {
  let now = Date.parse("2026-01-10T12:00:00.000Z");
  const wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const meter = adapter === "memory" ? new InMemoryMeter(() => now) : new DynamoMeter({ db, tables, now: () => now });
  const first = chargeReceipt({ originalReservationMicros: { state: "available", value: 100 }, amountMicros: { state: "available", value: 100 } });
  const held = await meter.reserve({ scope, caps, estimateMicros: 100, charge: { receipt: first, requestFingerprint: "a".repeat(64) }, provisional: context }); if (!held.ok) throw new Error("reserve");
  await meter.settleV2({ reservationId: held.reservation.id, receipt: { ...first, status: "estimated", reason: "missing_usage", neverConfirmed: true, usageComplete: false, amountMicros: { state: "available", value: 30 } } });
  expect((await meter.read(scope)).every(r => r.committed === 30 && r.reservedMicros === 0 && r.spentMicros === 30 && r.estimatedMicros === 30)).toBe(true);
  expect((await meter.read(scope)).find(r => r.item === "company")?.provisionalMicros ?? 0).toBe(0);
  const callKey = JSON.stringify([first.issuer, first.companyId, first.callId]);
  const row = adapter === "dynamo" ? wire.items(tables.ledger).find(r => r.sk === `CALL#${first.callId}`) : (meter as InMemoryMeter).ledger(callKey);
  expect(row).toMatchObject({ settledMicros: 30, neverConfirmed: true });
  now += 2 * 86_400_000;
  expect(await meter.sweepOpenHolds(now, 100)).toMatchObject({ swept: 0, failed: 0 });
  expect(await meter.correct({ callKey, realMicros: 1, caps: { task: 10_000, projectMonth: 10_000, companyMonth: 10_000, personMonth: 10_000 }, priceSource: { source: "aws", fetchedAt: now }, priceVersion: 9, estimated: false, now, runId: "run-1" })).toMatchObject({ status: "already" });
  expect((await meter.read(scope)).every(r => r.spentMicros === 30)).toBe(true);
});
