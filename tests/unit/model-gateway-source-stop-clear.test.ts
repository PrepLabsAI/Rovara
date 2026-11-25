import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { chargeReceipt } from "./model-gateway-charge-receipt-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
const actor = "arn:aws:iam::111111111111:user/operator";
async function world(durable: boolean) {
  const tables = { meter: "meter", ledger: "ledger", markers: "markers" }, wire = new WireDynamo(Object.values(tables));
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const meter = durable ? new DynamoMeter({ db, tables, now: () => now }) : new InMemoryMeter(() => now);
  const hold = await meter.reserve({ scope, caps, estimateMicros: 10 }); if (!hold.ok) throw new Error("hold");
  const receipt = chargeReceipt({ issuer: scope.iss, companyId: scope.cid, project: scope.pid, taskId: scope.tid, callId: hold.reservation.id, model: { provider: "bedrock", modelId: "claude-x" }, billing: "external_provider", billableMicros: { state: "available", value: 0 }, providerCostMicros: { state: "available", value: 100002 }, originalReservationMicros: { state: "available", value: 10 }, amountMicros: { state: "available", value: 100002 }, status: "final", reason: "reported_cost", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), accountingDay: new Date(now).toISOString().slice(0, 10), accountingMonth: new Date(now).toISOString().slice(0, 7) });
  await meter.settleV2({ reservationId: hold.reservation.id, receipt });
  const input = { iss: scope.iss, cid: scope.cid, source: "bedrock_byo" as const, routeClass: "legacy" as const, expectedStopId: `${hold.reservation.id}:1`, actor, reason: "Reviewed provider invoice and corrected source configuration" };
  return { meter, wire, tables, input, receipt };
}
for (const durable of [false, true]) it(`only audited operator clear reopens source, preserving spend and other cap latches (${durable})`, async () => {
  const w = await world(durable);
  const run = () => w.meter.reserve({ scope: { ...scope, tid: "task_after_clear" }, caps, estimateMicros: 1, customerSource: "bedrock_byo", routeClass: "agent" });
  expect(await run()).toMatchObject({ ok: false, reason: "overrun" });
  for (const actor of ["agent", "arn:aws:sts::111111111111:assumed-role/Gateway/task", "arn:aws:iam::111111111111:root"]) await expect(w.meter.clearSourceStop({ ...w.input, actor })).rejects.toThrow();
  await expect(w.meter.clearSourceStop({ ...w.input, reason: "" })).rejects.toThrow();
  expect(await w.meter.clearSourceStop({ ...w.input, expectedStopId: "stale" })).toBe(false);
  expect(await w.meter.clearSourceStop({ ...w.input, cid: `org_${"b".repeat(20)}` })).toBe(false);
  expect(await w.meter.clearSourceStop(w.input)).toBe(true);
  expect(await w.meter.sourceStop(scope.iss, scope.cid, "bedrock_byo")).toMatchObject({ stopped: false, clearedBy: actor, clearedAt: now, clearReason: w.input.reason });
  expect((await w.meter.read(scope)).every(row => row.spentMicros === 100002)).toBe(true);
  expect((await run()).ok).toBe(true);
  expect(await w.meter.clearSourceStop(w.input)).toBe(false);
  if (durable) expect(w.wire.items(w.tables.ledger).filter(row => String(row.sk).startsWith("SOURCESTOPCLEAR#"))).toEqual([expect.objectContaining({ actor, at: now, reason: w.input.reason })]);
});
