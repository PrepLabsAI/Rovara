import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { chargeReceipt } from "./model-gateway-charge-receipt-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter, companyPartition } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { caps, scope } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
const credentials = async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" });
function world(durable: boolean) {
  let now = Date.parse("2026-11-30T23:59:59Z");
  const wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
  const fresh = () => new DynamoMeter({ db, tables, now: () => now });
  const meter = durable ? fresh() : new InMemoryMeter(() => now);
  const reserve = (source: "bedrock_byo" | "openrouter" = "bedrock_byo", tid = "task_fresh") => meter.reserve({ scope: { ...scope, tid }, caps, estimateMicros: 10, customerSource: source, routeClass: "agent" });
  async function overage(source: "bedrock_byo" | "openrouter", above = true) {
    const held = await reserve(source, "task_over"); if (!held.ok) throw new Error("hold");
    const receipt = chargeReceipt({ issuer: scope.iss, companyId: scope.cid, project: scope.pid, taskId: "task_over", callId: held.reservation.id, model: { provider: source === "bedrock_byo" ? "bedrock" : "openrouter", modelId: "claude-x" }, billing: "external_provider", billableMicros: { state: "available", value: 0 }, providerCostMicros: { state: "available", value: 100002 }, originalReservationMicros: { state: "available", value: 10 }, amountMicros: { state: "available", value: above ? 100002 : 5 }, status: "final", reason: "reported_cost", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), accountingMonth: "2026-11", accountingDay: "2026-11-30" });
    await meter.settleV2({ reservationId: held.reservation.id, receipt }); return receipt;
  }
  return { meter, wire, db, fresh, reserve, overage, now: () => now, december: () => { now += 2000; } };
}
for (const durable of [false, true]) for (const source of ["bedrock_byo", "openrouter"] as const) {
  it(`source stop survives unrelated correction and month rollover (${durable}, ${source})`, async () => {
    const w = world(durable);
    const prior = await w.meter.reserve({ scope: { ...scope, tid: "task_prior" }, caps, estimateMicros: 10 }); if (!prior.ok) throw new Error("hold");
    await w.meter.settle(prior.reservation, 5, { provider: "anthropic", model: "claude-x", kind: "chat", priceVersion: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: w.now() });
    await w.overage(source);
    const blocked = { ok: false, reason: "overrun" };
    expect(await w.reserve(source)).toMatchObject(blocked);
    expect(await w.meter.correct({ callKey: JSON.stringify([scope.iss, scope.cid, prior.reservation.id]), realMicros: 5, priceVersion: 2, estimated: false, caps, priceSource: { source: "litellm", fetchedAt: w.now() }, runId: "normal-correction", now: w.now() })).toMatchObject({ status: "corrected", deltaMicros: 0 });
    expect(await w.reserve(source)).toMatchObject(blocked);
    w.december(); expect(await w.reserve(source)).toMatchObject(blocked);
    // A different source, company and issuer stay independent.
    expect((await w.reserve(source === "bedrock_byo" ? "openrouter" : "bedrock_byo")).ok).toBe(true);
    expect((await w.meter.reserve({ scope: { ...scope, cid: `org_${"b".repeat(20)}` }, caps, estimateMicros: 1, customerSource: source, routeClass: "agent" })).ok).toBe(true);
    if (durable) {
      expect(await w.fresh().reserve({ scope: { ...scope, tid: "task_restart" }, caps, estimateMicros: 1, customerSource: source, routeClass: "agent" })).toMatchObject(blocked);
      expect(w.wire.items(tables.meter).filter(row => String(row.sk).startsWith("SOURCESTOP#"))).toHaveLength(6);
    }
  });
  it(`one in-flight customer call, including across month/restart; settlement releases only its slot (${durable}, ${source})`, async () => {
    const w = world(durable), first = await w.reserve(source, "task_first"); if (!first.ok) throw new Error("hold");
    expect(await w.reserve(source, "task_second")).toMatchObject({ ok: false, reason: "busy", overrunInFlight: true });
    w.december();
    expect(await w.reserve(source, "task_december")).toMatchObject({ ok: false, reason: "busy", overrunInFlight: true });
    if (durable) expect(await w.fresh().reserve({ scope: { ...scope, tid: "task_restart" }, caps, estimateMicros: 1, customerSource: source, routeClass: "agent" })).toMatchObject({ ok: false, reason: "busy" });
    await w.meter.settle(first.reservation, 0);
    expect((await w.reserve(source, "task_released")).ok).toBe(true);
    await w.meter.settle(first.reservation, 0);
    expect(await w.reserve(source, "task_duplicate")).toMatchObject({ ok: false, reason: "busy" });
  });
  it(`receipt revision atomically stops the source and cannot auto-clear it (${durable}, ${source})`, async () => {
    const w = world(durable), receipt = await w.overage(source, false);
    const revised = { ...receipt, revision: 2, replacesRevision: 1, amountMicros: { state: "available" as const, value: 100002 } };
    expect(await w.meter.applyChargeReceipt(revised)).toMatchObject({ result: "applied" });
    expect(await w.reserve(source)).toMatchObject({ ok: false, reason: "overrun" });
    expect(await w.meter.applyChargeReceipt({ ...revised, revision: 3, replacesRevision: 2, amountMicros: { state: "available", value: 5 } })).toMatchObject({ result: "applied" });
    expect(await w.reserve(source)).toMatchObject({ ok: false, reason: "overrun" });
  });
}
it("Dynamo reserve transaction fences a stop set after its pre-read", async () => {
  const w = world(true); const held = await w.reserve(); if (!held.ok) throw new Error("hold");
  await w.meter.settle(held.reservation, 0);
  const transact = w.db.transact.bind(w.db); let raced = false;
  vi.spyOn(w.db, "transact").mockImplementation(async (...args) => {
    if (!raced) { raced = true; await w.db.put(tables.meter, { pk: companyPartition(scope.iss, scope.cid), sk: "SOURCESTOP#bedrock_byo", stopped: true, stopId: "raced", stoppedAt: w.now(), source: "bedrock_byo" }); }
    return transact(...args);
  });
  expect(await w.reserve()).toMatchObject({ ok: false, reason: "overrun" });
  expect((await w.meter.read({ ...scope, tid: "task_fresh" }))[0]?.reservedMicros).toBe(0);
});
for (const durable of [false, true]) it(`unrelated correction cannot unset a cap latch it did not cause (${durable})`, async () => {
  const w = world(durable);
  const a = await w.meter.reserve({ scope: { ...scope, tid: "task_estimated" }, caps, estimateMicros: 5 }); if (!a.ok) throw new Error("hold");
  await w.meter.settle(a.reservation, 5, { provider: "anthropic", model: "claude-x", kind: "chat", priceVersion: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, settledAt: w.now() });
  const b = await w.meter.reserve({ scope, caps: { ...caps, companyMonth: 20 }, estimateMicros: 10 }); if (!b.ok) throw new Error("hold"); await w.meter.settle(b.reservation, 30);
  expect(await w.meter.correct({ callKey: JSON.stringify([scope.iss, scope.cid, a.reservation.id]), realMicros: 5, caps, priceVersion: 2, estimated: false, priceSource: { source: "litellm", fetchedAt: w.now() }, runId: "unrelated", now: w.now() })).toMatchObject({ status: "corrected" });
  expect((await w.meter.read(scope)).find(row => row.item === "company")?.overrun).toBe(true);
});
