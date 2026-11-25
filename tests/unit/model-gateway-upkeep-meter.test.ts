// Lead 4 L4-E: the meter's "upkeep" row (a project's monthly row for nightly upkeep spend) at the DynamoDB wire and in memory. It is present only on a call
// whose caps carry `upkeepMonth`, refuses at its own cap before anything is held, is settled, corrected and swept like every other row, and is per project
// and per company. A combined meter (the answers/learning/product shape) carries it beside the combined company row.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter, HOLD_SWEEP_AGE_MS } from "../../packages/model-gateway/src/dynamo-meter.js";
import { InMemoryMeter, type Meter, type MeterScope } from "../../packages/model-gateway/src/meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const AGENT = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" };
const OTHER = { meter: "gw-o-meter", ledger: "gw-o-ledger", markers: "gw-o-markers" };
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
const T0 = Date.UTC(2026, 0, 1);
const A = `org_${"a".repeat(20)}`;
const B = `org_${"b".repeat(20)}`;
const scope = (cid = A, pid = "web"): MeterScope => ({ iss: "https://install.example/v1/auth", cid, pid, tid: "task_1" });
const caps = (upkeepMonth?: number) => ({ task: 1000, projectMonth: 1000, companyMonth: 1000, combinedCompanyMonth: 1000, ...(upkeepMonth === undefined ? {} : { upkeepMonth }) });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const meters: Array<[string, () => { make: (clock?: () => number) => Meter }]> = [
  ["InMemoryMeter", () => ({ make: (clock = () => T0) => new InMemoryMeter(clock) })],
  ["DynamoMeter", () => { const wire = new WireDynamo([...Object.values(AGENT), "gw-prices"]); const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport }); return { make: (clock = () => T0) => new DynamoMeter({ db, tables: AGENT, now: clock }) }; }],
];

for (const [name, build] of meters) {
  describe(`${name}: the upkeep row`, () => {
    it("is there only when the caps name an upkeep cap, and counts every settled call of the project", async () => {
      const meter = build().make();
      const plain = await meter.reserve({ scope: scope(), caps: caps(), estimateMicros: 10 });
      expect(plain.ok).toBe(true);
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ committed: 0 });
      const held = await meter.reserve({ scope: scope(), caps: caps(100), estimateMicros: 40 });
      expect(held.ok).toBe(true); if (!held.ok) return;
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ reservedMicros: 40, committed: 40 });
      await meter.settle(held.reservation, 25);
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ spentMicros: 25, committed: 25, reservedMicros: 0 });
      // The default read (no upkeep option) is unchanged: no upkeep row among them.
      expect((await meter.read(scope())).map((r) => r.item)).not.toContain("upkeep");
    });

    it("refuses at its own cap, before anything is held, naming the upkeep row; the project and company rows are untouched by the refusal", async () => {
      const meter = build().make();
      const first = await meter.reserve({ scope: scope(), caps: caps(50), estimateMicros: 40 });
      expect(first.ok).toBe(true); if (!first.ok) return;
      await meter.settle(first.reservation, 40);
      const refused = await meter.reserve({ scope: scope(), caps: caps(50), estimateMicros: 20 });
      expect(refused).toEqual({ ok: false, reason: "cap", item: "upkeep", held: false });
      const rows = await meter.read(scope(), { upkeep: true });
      for (const item of ["project", "company", "task"]) expect(rows.find((r) => r.item === item), item).toMatchObject({ spentMicros: 40, committed: 40 });
      // A call of the same project with no upkeep cap (attended work) is still allowed: the cap is only on upkeep calls.
      expect((await meter.reserve({ scope: scope(), caps: caps(), estimateMicros: 20 })).ok).toBe(true);
    });

    it("a cap of 0 refuses every call (no upkeep spend)", async () => {
      const meter = build().make();
      expect(await meter.reserve({ scope: scope(), caps: caps(0), estimateMicros: 1 })).toMatchObject({ ok: false, reason: "cap", item: "upkeep" });
    });

    it("is per project and per company: one project's full row never blocks another's, nor another company's", async () => {
      const meter = build().make();
      const full = await meter.reserve({ scope: scope(A, "web"), caps: caps(30), estimateMicros: 30 });
      expect(full.ok).toBe(true); if (!full.ok) return;
      await meter.settle(full.reservation, 30);
      expect(await meter.reserve({ scope: scope(A, "web"), caps: caps(30), estimateMicros: 1 })).toMatchObject({ ok: false, item: "upkeep" });
      expect((await meter.reserve({ scope: scope(A, "api"), caps: caps(30), estimateMicros: 30 })).ok).toBe(true);
      expect((await meter.reserve({ scope: scope(B, "web"), caps: caps(30), estimateMicros: 30 })).ok).toBe(true);
      expect((await meter.read(scope(B, "web"), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ committed: 30, spentMicros: 0 });
    });

    it("a correction that brings an over-cap upkeep row back under its cap clears the overrun (the cap stored with the hold applies)", async () => {
      const meter = build().make();
      const held = await meter.reserve({ scope: scope(), caps: caps(50), estimateMicros: 40 });
      expect(held.ok).toBe(true); if (!held.ok) return;
      await meter.settle(held.reservation, 70, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ spentMicros: 70, overrun: true });
      const call = (await meter.pendingFor((await meter.pendingKeys(10)).items[0]!, 10)).items[0]!;
      // The corrections' caps carry no upkeep cap (no origin): the stored one is used.
      const done = await meter.correct({ callKey: call.callKey, realMicros: 20, caps: caps(), priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: T0 }, runId: "r", now: T0 });
      expect(done).toEqual({ status: "corrected", deltaMicros: -50 });
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ spentMicros: 20, overrun: false });
      expect((await meter.reserve({ scope: scope(), caps: caps(50), estimateMicros: 10 })).ok).toBe(true);
    });

    it("moves with a price correction like the other rows", async () => {
      const meter = build().make();
      const held = await meter.reserve({ scope: scope(), caps: caps(100), estimateMicros: 40 });
      expect(held.ok).toBe(true); if (!held.ok) return;
      await meter.settle(held.reservation, 30, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
      const pending = await meter.pendingKeys(10);
      const call = (await meter.pendingFor(pending.items[0]!, 10)).items[0]!;
      const done = await meter.correct({ callKey: call.callKey, realMicros: 10, caps: caps(100), priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: T0 }, runId: "r", now: T0 });
      expect(done).toEqual({ status: "corrected", deltaMicros: -20 });
      expect((await meter.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ spentMicros: 10, committed: 10 });
    });
  });
}

describe("DynamoMeter: a combined meter carries the upkeep row beside the combined company row, and the sweep reads such a hold", () => {
  it("reserve, sweep an old open hold at its estimate, and read the six targets back", async () => {
    const wire = new WireDynamo([...Object.values(AGENT), ...Object.values(OTHER), "gw-prices"], { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    let clock = T0;
    const combined = new DynamoMeter({ db, tables: OTHER, now: () => clock, combinedCompany: { meter: AGENT.meter, markers: AGENT.markers } });
    const held = await combined.reserve({ scope: scope(), caps: caps(100), estimateMicros: 40 });
    expect(held.ok).toBe(true);
    expect((await combined.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ committed: 40 });
    clock = T0 + HOLD_SWEEP_AGE_MS + 60_000;
    expect(await combined.sweepOpenHolds(clock, 10)).toEqual({ swept: 1, already: 0, failed: 0, more: false });
    expect((await combined.read(scope(), { upkeep: true })).find((r) => r.item === "upkeep")).toMatchObject({ spentMicros: 40, committed: 40, reservedMicros: 0 });
  });
});
