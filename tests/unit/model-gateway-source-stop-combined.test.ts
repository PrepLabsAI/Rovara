import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { chargeReceipt } from "./model-gateway-charge-receipt-fixture.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { caps, scope, now } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
for (const durable of [false, true]) it(`combined meters share ONE company/source slot with independent stops (${durable})`, async () => {
  const tables = { meter: "agent-meter", ledger: "agent-ledger", markers: "agent-markers" }, productTables = { meter: "product-meter", ledger: "product-ledger", markers: "product-markers" };
  const wire = new WireDynamo([...Object.values(tables), ...Object.values(productTables)], { namespaceTables: true });
  const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "TEST", secretAccessKey: "not-real" }), transport: wire.transport });
  const agent = durable ? new DynamoMeter({ db, tables, now: () => now }) : new InMemoryMeter(() => now);
  const product = durable ? new DynamoMeter({ db, tables: productTables, now: () => now, combinedCompany: { meter: tables.meter, markers: tables.markers } }) : new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent as InMemoryMeter });
  const hold = await product.reserve({ scope, caps: { ...caps, combinedCompanyMonth: caps.companyMonth }, estimateMicros: 10, customerSource: "bedrock_byo", routeClass: "product" }); if (!hold.ok) throw new Error("hold");
  expect(await agent.reserve({ scope: { ...scope, tid: "task_agent" }, caps, estimateMicros: 1, customerSource: "bedrock_byo", routeClass: "agent" })).toMatchObject({ ok: false, reason: "busy", overrunInFlight: true });
  const receipt = chargeReceipt({ issuer: scope.iss, companyId: scope.cid, project: scope.pid, taskId: scope.tid, callId: hold.reservation.id, model: { provider: "bedrock", modelId: "claude-x" }, billing: "external_provider", billableMicros: { state: "available", value: 0 }, providerCostMicros: { state: "available", value: 100002 }, originalReservationMicros: { state: "available", value: 10 }, amountMicros: { state: "available", value: 100002 }, status: "final", reason: "reported_cost", occurredAt: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), accountingDay: new Date(now).toISOString().slice(0, 10), accountingMonth: new Date(now).toISOString().slice(0, 7) });
  await product.settleV2({ reservationId: hold.reservation.id, receipt });
  expect(await product.reserve({ scope: { ...scope, tid: "task_stopped" }, caps: { ...caps, combinedCompanyMonth: caps.companyMonth }, estimateMicros: 1, customerSource: "bedrock_byo", routeClass: "product" })).toMatchObject({ ok: false, reason: "overrun" });
  expect((await agent.reserve({ scope: { ...scope, tid: "task_unaffected" }, caps, estimateMicros: 1, customerSource: "bedrock_byo", routeClass: "agent" })).ok).toBe(true);
  if (durable) { expect(wire.items(tables.meter).filter(row => String(row.sk).startsWith("SOURCESTOP#"))).toHaveLength(3); expect(wire.items(productTables.meter).filter(row => String(row.sk).startsWith("SOURCESTOP#"))).toHaveLength(0); }
});
