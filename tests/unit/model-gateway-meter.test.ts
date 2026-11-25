import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { describe, expect, it } from "vitest";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { caps, scope, now } from "./model-gateway-fixture.js";

describe("all-or-nothing meter", () => {
  it("subtracts the estimate, reserves all items, never partially writes", async () => {
    const meter = new InMemoryMeter(() => now);
    const args = { scope, caps: { ...caps, companyMonth: 100 }, estimateMicros: 60 };
    expect((await meter.reserve(args)).ok).toBe(true);
    expect(await meter.reserve(args)).toMatchObject({ ok: false, reason: "cap", item: "company", held: true });
    expect((await meter.read(scope)).every((x) => x.reservedMicros === 60 && x.spentMicros === 0)).toBe(true);
  });
  it("always settles over cap, marks overrun, refuses the next task in the company", async () => {
    const meter = new InMemoryMeter(() => now);
    const r = await meter.reserve({ scope, caps: { ...caps, companyMonth: 100 }, estimateMicros: 50 });
    if (!r.ok) throw new Error("reservation failed");
    await meter.settle(r.reservation, 101);
    expect((await meter.read(scope)).find((x) => x.item === "company")).toMatchObject({ spentMicros: 101, reservedMicros: 0, committed: 101, overrun: true });
    expect(await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps: { ...caps, companyMonth: 1000 }, estimateMicros: 1 })).toMatchObject({ ok: false, reason: "overrun", item: "company" });
  });
  it("settle after close adds nothing and unsettled reservations remain", async () => {
    const meter = new InMemoryMeter(() => now);
    const r = await meter.reserve({ scope, caps, estimateMicros: 50 }); if (!r.ok) throw new Error("failed");
    await meter.settle(r.reservation, 20); await meter.settle(r.reservation, 40);
    expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 20, reservedMicros: 0 });
    await meter.reserve({ scope, caps, estimateMicros: 50 });
    expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 20, reservedMicros: 50 });
  });
  it("isolates same task across companies and installs; per absent means no person item", async () => {
    const meter = new InMemoryMeter(() => now);
    const withoutPerson = { iss: scope.iss, cid: scope.cid, pid: scope.pid, tid: scope.tid };
    await meter.reserve({ scope: withoutPerson, caps, estimateMicros: 10 });
    expect((await meter.read(withoutPerson)).map((x) => x.item)).toEqual(["task", "project", "company"]);
    for (const other of [{ ...scope, cid: `org_${"b".repeat(20)}` }, { ...scope, iss: "https://install-b.example/v1/auth" }]) {
      expect((await meter.read(other)).every((x) => x.spentMicros === 0 && x.reservedMicros === 0)).toBe(true);
      expect((await meter.reserve({ scope: other, caps, estimateMicros: 10 })).ok).toBe(true);
    }
    expect((await meter.read(withoutPerson))[0]?.reservedMicros).toBe(10);
  });
  it("two racing calls cannot both win; retries conflicts three times then busy", async () => {
    let tries = 0;
    const meter = new InMemoryMeter(() => now, () => ++tries <= 1);
    const results = await Promise.all([1, 2].map(() => meter.reserve({ scope, caps: { ...caps, task: 10 }, estimateMicros: 10 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    let conflicts = 0;
    const busy = new InMemoryMeter(() => now, () => { conflicts++; return true; });
    expect(await busy.reserve({ scope, caps, estimateMicros: 1 })).toEqual({ ok: false, reason: "busy" });
    expect(conflicts).toBe(3);
    expect((await busy.read(scope))[0]?.reservedMicros).toBe(0);
  });
  it("refuses invalid runtime scopes, caps and amounts with fixed words", async () => {
    const meter = new InMemoryMeter(() => now);
    for (const estimateMicros of [NaN, -1, Infinity, 1.1]) expect(await meter.reserve({ scope, caps, estimateMicros })).toEqual({ ok: false, reason: "busy" });
    expect(await meter.reserve({ scope, caps: { ...caps, task: NaN }, estimateMicros: 1 })).toEqual({ ok: false, reason: "busy" });
  });
});
it("settles into the reserved UTC month and returns independent snapshots", async () => {
  let clock = Date.UTC(2026, 0, 31, 23, 59, 59);
  const meter = new InMemoryMeter(() => clock);
  const r = await meter.reserve({ scope, caps, estimateMicros: 40 }); if (!r.ok) throw new Error("failed");
  clock = Date.UTC(2026, 1, 1); await meter.settle(r.reservation, 20);
  expect((await meter.read(scope)).find((x) => x.item === "company")?.spentMicros).toBe(0);
  clock = Date.UTC(2026, 0, 31);
  const rows = await meter.read(scope); expect(rows.find((x) => x.item === "company")?.spentMicros).toBe(20);
  rows[0]!.spentMicros = 500; expect((await meter.read(scope))[0]?.spentMicros).toBe(20);
});
