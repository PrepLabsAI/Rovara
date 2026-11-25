import { beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { denyNetwork } from "./model-gateway-no-network.js";
import { chargeReceipt } from "./model-gateway-charge-receipt-fixture.js";
import { InMemoryMeter, type ReserveInput } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter, companyPartition } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
import { runOperatorClear } from "../../packages/model-gateway/src/source-stop-cli.js";
beforeAll(denyNetwork);
const actor = "arn:aws:iam::111111111111:user/operator";
type RouteClass = "product" | "agent";
function world(durable: boolean) {
  const a = { meter: "agent", ledger: "agent-ledger", markers: "agent-markers" }, p = { meter: "product", ledger: "product-ledger", markers: "product-markers" };
  const wire = new WireDynamo([...Object.values(a), ...Object.values(p)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const agent = durable ? new DynamoMeter({ db, tables: a, now: () => now }) : new InMemoryMeter(() => now);
  const product = durable ? new DynamoMeter({ db, tables: p, now: () => now, combinedCompany: { meter: a.meter, markers: a.markers } }) : new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent as InMemoryMeter });
  const meter = (routeClass: RouteClass) => routeClass === "product" ? product : agent;
  const reserve = (routeClass: RouteClass, source: "bedrock_byo" | "openrouter" = "bedrock_byo") => meter(routeClass).reserve({ scope: { ...scope, tid: `task_${randomUUID()}` }, caps: { ...caps, combinedCompanyMonth: caps.companyMonth }, estimateMicros: 10, customerSource: source, routeClass });
  return { a, p, wire, db, agent, product, meter, reserve };
}
// The class lives on the admitted hold, never on the provider-supplied receipt.
async function latch(w: ReturnType<typeof world>, routeClass?: RouteClass, amount = 100002) {
  const m = routeClass === "product" ? w.product : w.agent;
  const h = await m.reserve({ scope, caps: { ...caps, combinedCompanyMonth: caps.companyMonth }, estimateMicros: 10, ...(routeClass === undefined ? {} : { customerSource: "bedrock_byo", routeClass }) });
  if (!h.ok) throw new Error("hold refused");
  const r = chargeReceipt({ issuer: scope.iss, companyId: scope.cid, project: scope.pid, taskId: scope.tid, callId: h.reservation.id, model: { provider: "bedrock", modelId: "claude-x" }, billing: "external_provider", billableMicros: { state: "available", value: 0 }, providerCostMicros: { state: "available", value: amount }, originalReservationMicros: { state: "available", value: 10 }, amountMicros: { state: "available", value: amount }, status: "final", reason: "reported_cost", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), accountingMonth: new Date(now).toISOString().slice(0, 7), accountingDay: new Date(now).toISOString().slice(0, 10) });
  await m.settleV2({ reservationId: h.reservation.id, receipt: r }); return r;
}
for (const durable of [false, true]) {
  for (const routeClass of ["product", "agent"] as const) it(`overage and later revisions latch only admitted ${routeClass} class (${durable})`, async () => {
    const w = world(durable), other = routeClass === "product" ? "agent" : "product";
    const r = await latch(w, routeClass, 5);
    await w.meter(routeClass).applyChargeReceipt({ ...r, revision: 2, replacesRevision: 1, amountMicros: { state: "available", value: 100002 } });
    expect(await w.reserve(routeClass)).toMatchObject({ ok: false, reason: "overrun" });
    const h = await w.reserve(other); expect(h.ok).toBe(true);
    if (h.ok) await w.meter(other).settle(h.reservation, 0);
    await w.meter(routeClass).applyChargeReceipt({ ...r, revision: 3, replacesRevision: 2, amountMicros: { state: "available", value: 5 } });
    expect(await w.reserve(routeClass)).toMatchObject({ ok: false, reason: "overrun" });
  });
  it(`a legacy-only stop independently blocks both classes (${durable})`, async () => {
    const w = world(durable); await latch(w);
    expect(await w.reserve("product")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await w.reserve("agent")).toMatchObject({ ok: false, reason: "overrun" });
  });
  it(`legacy stop blocks both; clearing one class preserves other and legacy (${durable})`, async () => {
    const w = world(durable), product = await latch(w, "product"), agent = await latch(w, "agent"), legacy = await latch(w);
    const clear = (routeClass: RouteClass | "legacy", stopId: string) => w.agent.clearSourceStop({ iss: scope.iss, cid: scope.cid, source: "bedrock_byo", routeClass, expectedStopId: stopId, actor, reason: "Invoice reviewed" });
    expect(await w.reserve("product")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await w.reserve("agent")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await clear("product", `${product.callId}:1`)).toBe(true);
    expect(await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo", "product")).toMatchObject({ stopped: false });
    expect(await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo", "agent")).toMatchObject({ stopped: true, stopId: `${agent.callId}:1` });
    expect(await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo")).toMatchObject({ stopped: true, stopId: `${legacy.callId}:1` });
    expect(await clear("product", `${product.callId}:1`)).toBe(false);
    expect(await clear("agent", `${product.callId}:1`)).toBe(false);
    expect(await w.reserve("product")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await w.reserve("agent")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await clear("legacy", `${legacy.callId}:1`)).toBe(true);
    const h = await w.reserve("product"); expect(h.ok).toBe(true);
    expect(await clear("agent", `${agent.callId}:1`)).toBe(false); // shared live slot makes clear stale
    if (h.ok) await w.product.settle(h.reservation, 0);
    expect(await w.reserve("agent")).toMatchObject({ ok: false, reason: "overrun" });
    expect(await clear("agent", `${agent.callId}:1`)).toBe(true);
    if (durable) expect(w.wire.items(w.a.ledger).filter(row => String(row.sk).startsWith("SOURCESTOPCLEAR#")).map(row => row.routeClass).sort()).toEqual(["agent", "legacy", "product"]);
  });
  for (const routeClass of [undefined, "other", "", null]) it(`unknown/missing class ${String(routeClass)} refuses with no hold (${durable})`, async () => {
    const w = world(durable);
    expect(await w.agent.reserve({ scope, caps, estimateMicros: 1, customerSource: "bedrock_byo", routeClass } as unknown as ReserveInput)).toEqual({ ok: false, reason: "busy" });
    expect((await w.agent.read(scope)).every(row => row.reservedMicros === 0)).toBe(true);
  });
}
it.each(["product", "agent"] as const)("Dynamo %s clear refuses an absent shared record without writing a broken slot or audit", async (routeClass) => {
  const w = world(true), pk = companyPartition(scope.iss, scope.cid);
  const key = { pk, sk: `SOURCESTOP#bedrock_byo#${routeClass}` };
  const stop = { ...key, source: "bedrock_byo", routeClass, stopped: true, stopId: "call:1", stoppedAt: now };
  await w.db.put(w.a.meter, stop);
  expect(await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo")).toBeUndefined();
  expect(await w.agent.clearSourceStop({ iss: scope.iss, cid: scope.cid, source: "bedrock_byo", routeClass, expectedStopId: "call:1", actor, reason: "Invoice reviewed" })).toBe(false);
  expect(w.wire.items(w.a.meter)).toEqual([stop]);
  expect(w.wire.items(w.a.ledger)).toEqual([]);
  expect(await w.agent.sourceStop(scope.iss, scope.cid, "bedrock_byo")).toBeUndefined();
  expect(await w.reserve(routeClass)).toMatchObject({ ok: false, reason: "overrun" });
  const other = routeClass === "product" ? "agent" : "product";
  const h = await w.reserve(other); expect(h.ok).toBe(true);
  if (h.ok) await w.meter(other).settle(h.reservation, 0);
});
for (const routeClass of ["product", "agent", "legacy"] as const) it(`transaction fences raced ${routeClass} stop without acquiring hold/slot`, async () => {
  const w = world(true), transact = w.db.transact.bind(w.db); let raced = false;
  vi.spyOn(w.db, "transact").mockImplementation(async (...args) => {
    if (!raced) {
      raced = true;
      await w.db.put(w.a.meter, { pk: companyPartition(scope.iss, scope.cid), sk: `SOURCESTOP#bedrock_byo${routeClass === "legacy" ? "" : `#${routeClass}`}`, source: "bedrock_byo", ...(routeClass === "legacy" ? {} : { routeClass }), stopped: true, stopId: "raced", stoppedAt: now });
    }
    return transact(...args);
  });
  expect(await w.reserve(routeClass === "legacy" ? "product" : routeClass)).toMatchObject({ ok: false, reason: "overrun" });
  expect(w.wire.items(w.p.meter).filter(row => String(row.sk).startsWith("HOLD#"))).toHaveLength(0);
  expect(w.wire.items(w.a.meter).filter(row => String(row.sk).startsWith("HOLD#"))).toHaveLength(0);
  expect(w.wire.items(w.a.meter).some(row => row.inFlight !== undefined)).toBe(false);
});
for (const routeClass of ["product", "agent", "legacy"] as const) it(`CLI preview and confirmation name exact ${routeClass} record`, async () => {
  const input = { iss: scope.iss, cid: scope.cid, source: "bedrock_byo" as const, routeClass, reason: "Invoice reviewed" };
  const preview = vi.fn(), confirm = vi.fn(async () => true), clearSourceStop = vi.fn(async () => true);
  const sourceStop = vi.fn(async () => ({ source: "bedrock_byo" as const, ...(routeClass === "legacy" ? {} : { routeClass }), stopped: true, stopId: "call:1", stoppedAt: now }));
  expect(await runOperatorClear(input, { meter: { sourceStop, clearSourceStop }, interactive: true, identity: async () => actor, preview, confirm })).toBe(true);
  expect(sourceStop).toHaveBeenCalledWith(scope.iss, scope.cid, "bedrock_byo", routeClass === "legacy" ? undefined : routeClass);
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ routeClass, recordKey: `SOURCESTOP#bedrock_byo${routeClass === "legacy" ? "" : `#${routeClass}`}` }));
  expect(confirm).toHaveBeenCalledWith(`CLEAR ${scope.cid} bedrock_byo ${routeClass} call:1`);
  expect(clearSourceStop).toHaveBeenCalledWith(expect.objectContaining({ routeClass, expectedStopId: "call:1" }));
});
