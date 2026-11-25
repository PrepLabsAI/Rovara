import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoEndedTasks, DynamoMeter, HOLD_SWEEP_AGE_MS, companyPartition } from "../../packages/model-gateway/src/dynamo-meter.js";
import { runMeterConformance, runMeterDeadlineConformance, type MeterRow } from "../../packages/model-gateway/src/meter.js";
import { DAY_MS } from "../../packages/model-gateway/src/price-constants.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";

const TABLES = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" };
const ALL = [...Object.values(TABLES), "gw-prices"];
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
function table() {
  const wire = new WireDynamo(ALL);
  const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
  return { wire, db };
}
const scope = { iss: "https://install.example/v1/auth", cid: `org_${"a".repeat(20)}`, pid: "web", tid: "task_1" };
const caps = { task: 100, projectMonth: 100, companyMonth: 100 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const T0 = Date.UTC(2026, 0, 1);

describe("DynamoMeter at the wire", () => {
  it("passes the meter contract InMemoryMeter passes (holds, caps, overrun, isolation, corrections)", async () => {
    const names = await runMeterConformance((clock) => new DynamoMeter({ db: table().db, tables: TABLES, now: clock }));
    expect(names).toContain("atomic hold");
    expect(names).toContain("partial versioned correction");
  });

  it("passes the deadline contract: an aborted correction or expiry writes nothing and answers unknown", async () => {
    const names = await runMeterDeadlineConformance((clock, beforeWrite) => new DynamoMeter({ db: table().db, tables: TABLES, now: clock, beforeWrite }));
    expect(names).toEqual(["bounded correction transaction", "no late correction write", "bounded expiry transaction", "no late expiry write"]);
  });

  it("keeps every company key under CO#, never deletes a meter or ledger row, and keeps the settled hold", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const r = await meter.reserve({ scope, caps, estimateMicros: 40, overrun: { deadlineSeconds: T0 / 1000 + 60, tokenExpiresSeconds: T0 / 1000 + 900 } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const marker = wire.items(TABLES.markers)[0]!;
    expect(marker).toMatchObject({ pk: companyPartition(scope.iss, scope.cid), sk: "INFLIGHT", expiresAt: T0 / 1000 + 60 });
    await meter.settle(r.reservation, 30, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
    for (const call of wire.calls.filter((c) => c.table !== "gw-prices")) for (const key of call.keys) expect(key.pk.startsWith("CO#")).toBe(true);
    const deletes = wire.calls.filter((c) => c.operation === "DeleteItem");
    expect(deletes.map((c) => c.table)).toEqual([TABLES.markers]);
    expect(wire.items(TABLES.markers)).toEqual([]);
    expect(wire.items(TABLES.meter).find((item) => String(item.sk).startsWith("HOLD#"))).toMatchObject({ status: "settled", actualMicros: 30, estimateMicros: 40 });
    expect(wire.items(TABLES.ledger)).toEqual([expect.objectContaining({ status: "pending", settledMicros: 30, pendingAll: "PENDING" })]);
    expect(new Set(wire.calls.map((c) => c.operation))).toEqual(new Set(["GetItem", "TransactWriteItems", "DeleteItem"]));
  });

  it("two servers racing for the last room in a cap: exactly one hold is taken", async () => {
    const { db } = table();
    const a = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const b = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    // Twice: once while the rows do not exist yet (the create condition decides), once with rows in place (the cap condition decides).
    const results = await Promise.all([a.reserve({ scope, caps, estimateMicros: 60 }), b.reserve({ scope: { ...scope }, caps, estimateMicros: 60 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "cap", item: "task", held: true });
    expect((await a.read(scope)).every((row) => row.reservedMicros === 60 && row.committed === 60)).toBe(true);
    const winner = results.find((r) => r.ok)!; if (!winner.ok) return;
    await (results[0]?.ok === true ? a : b).settle(winner.reservation, 0);
    const again = await Promise.all([a.reserve({ scope, caps, estimateMicros: 60 }), b.reserve({ scope: { ...scope }, caps, estimateMicros: 60 })]);
    expect(again.filter((r) => r.ok)).toHaveLength(1);
    expect((await a.read(scope)).every((row) => row.reservedMicros === 60 && row.committed === 60 && row.spentMicros === 0)).toBe(true);
  });

  it("two settles racing past the cap still set the overrun flag (neither sees the other's spend)", async () => {
    const { db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const first = await meter.reserve({ scope, caps, estimateMicros: 50 }); const second = await meter.reserve({ scope: { ...scope, tid: "task_1" }, caps, estimateMicros: 50 });
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    await Promise.all([meter.settle(first.reservation, 60), meter.settle(second.reservation, 60)]);
    expect((await meter.read(scope)).map((row) => [row.spentMicros, row.reservedMicros, row.overrun])).toEqual([[120, 0, true], [120, 0, true], [120, 0, true]]);
  });

  it("settles a reservation once even when two settles race", async () => {
    const { db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const r = await meter.reserve({ scope, caps, estimateMicros: 50 }); if (!r.ok) throw new Error("reserve");
    await Promise.all([meter.settle(r.reservation, 20), meter.settle(r.reservation, 20)]);
    expect((await meter.read(scope)).every((row) => row.spentMicros === 20 && row.reservedMicros === 0 && row.committed === 20)).toBe(true);
  });

  it("a reservation whose answer was lost is retried with the same token and applied once", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "lost-after-apply" });
    const r = await meter.reserve({ scope, caps, estimateMicros: 30 });
    expect(r.ok).toBe(true);
    expect((await meter.read(scope)).every((row) => row.reservedMicros === 30)).toBe(true);
    expect(wire.items(TABLES.meter).filter((item) => String(item.sk).startsWith("HOLD#"))).toHaveLength(1);
  });

  it("a reservation that applied but whose answer was lost twice still goes ahead on its hold (no ownerless hold)", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "lost-after-apply" }, 2);
    const r = await meter.reserve({ scope, caps, estimateMicros: 30 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    await meter.settle(r.reservation, 10);
    expect((await meter.read(scope)).every((row) => row.reservedMicros === 0 && row.spentMicros === 10)).toBe(true);
    expect(wire.items(TABLES.meter).filter((item) => String(item.sk).startsWith("HOLD#")).map((item) => item.status)).toEqual(["settled"]);
  });

  it("a correction that meets a concurrent settle on the company row re-reads and applies", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const r = await meter.reserve({ scope, caps, estimateMicros: 90 }); if (!r.ok) throw new Error("reserve");
    await meter.settle(r.reservation, 80, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
    const [call] = (await meter.pendingFor({ provider: "anthropic", model: "claude-x" }, 10)).items;
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "error", status: 400, type: "TransactionCanceledException", reasons: ["None", "ConditionalCheckFailed", "None", "None"] }, 2);
    expect(await meter.correct({ callKey: call!.callKey, realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: T0 }, runId: "r", now: T0 })).toEqual({ status: "corrected", deltaMicros: -60 });
    const r2 = await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps, estimateMicros: 10 }); if (!r2.ok) throw new Error("reserve");
    await meter.settle(r2.reservation, 5, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
    const [second] = (await meter.pendingFor({ provider: "anthropic", model: "claude-x" }, 10)).items;
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "error", status: 400, type: "TransactionCanceledException", reasons: ["None", "None", "None", "ConditionalCheckFailed"] }, 1);
    // The ledger row itself moved: busy at once (a later run re-reads it), no row retried.
    expect(await meter.correct({ callKey: second!.callKey, realMicros: 2, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm", fetchedAt: T0 }, runId: "r", now: T0 })).toEqual({ status: "busy" });
  });

  it("a reservation whose outcome stays unknown is refused busy (the call is never forwarded on a guess)", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "lost-before-apply" }, 2);
    expect(await meter.reserve({ scope, caps, estimateMicros: 30 })).toEqual({ ok: false, reason: "busy" });
  });

  it("a settle that cannot commit throws and keeps the hold open (settle_failed; nothing half-written)", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const r = await meter.reserve({ scope, caps, estimateMicros: 30 }); if (!r.ok) throw new Error("reserve");
    wire.fault((c) => c.operation === "TransactWriteItems", { kind: "error", status: 400, type: "TransactionCanceledException", reasons: ["TransactionConflict", "None", "None", "None", "None"] }, 6);
    await expect(meter.settle(r.reservation, 10)).rejects.toThrow("settlement unavailable");
    expect(wire.items(TABLES.meter).find((item) => String(item.sk).startsWith("HOLD#"))).toMatchObject({ status: "open" });
    expect((await meter.read(scope)).every((row) => row.reservedMicros === 30 && row.spentMicros === 0)).toBe(true);
    await meter.settle(r.reservation, 10);
    expect((await meter.read(scope)).every((row) => row.reservedMicros === 0 && row.spentMicros === 10)).toBe(true);
  });

  it("a live in-flight marker on another server makes an estimated call busy; an expired one does not", async () => {
    let clock = T0;
    const { db } = table();
    const a = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    const b = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    const overrun = () => ({ deadlineSeconds: clock / 1000 + 10, tokenExpiresSeconds: clock / 1000 + 900 });
    expect((await a.reserve({ scope, caps, estimateMicros: 10, overrun: overrun() })).ok).toBe(true);
    expect(await b.reserve({ scope, caps, estimateMicros: 10, overrun: overrun() })).toEqual({ ok: false, reason: "busy", overrunInFlight: true });
    clock += 11_000;
    expect((await b.reserve({ scope, caps, estimateMicros: 10, overrun: overrun() })).ok).toBe(true);
  });

  it("two corrections of one call race: the spend moves once", async () => {
    const { db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const r = await meter.reserve({ scope, caps, estimateMicros: 90 }); if (!r.ok) throw new Error("reserve");
    await meter.settle(r.reservation, 80, { provider: "anthropic", model: "claude-x", kind: "chat", usage, settledAt: T0 });
    const [call] = (await meter.pendingFor({ provider: "anthropic", model: "claude-x" }, 10)).items;
    const input = { callKey: call!.callKey, realMicros: 20, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: T0 }, runId: "run", now: T0 };
    const results = await Promise.all([meter.correct(input), meter.correct({ ...input, runId: "other" })]);
    expect(results.filter((x) => x.status === "corrected")).toEqual([{ status: "corrected", deltaMicros: -60 }]);
    expect(results.map((x) => x.status).sort()).toEqual(expect.arrayContaining(["corrected"]));
    expect(results.some((x) => x.status === "already" || x.status === "busy")).toBe(true);
    expect((await meter.read(scope)).every((row: MeterRow) => row.spentMicros === 20 && row.estimatedMicros === 0)).toBe(true);
    expect((await meter.pendingKeys(5)).items).toEqual([]);
    // A correction upward (the real price was dearer) racing itself: still applied once.
    const up = await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps: { task: 1000, projectMonth: 1000, companyMonth: 1000 }, estimateMicros: 50 }); if (!up.ok) throw new Error("reserve");
    await meter.settle(up.reservation, 40, { provider: "anthropic", model: "claude-y", kind: "chat", usage, settledAt: T0 });
    const [dear] = (await meter.pendingFor({ provider: "anthropic", model: "claude-y" }, 10)).items;
    const raise = { ...input, callKey: dear!.callKey, realMicros: 70, caps: { task: 1000, projectMonth: 1000, companyMonth: 1000 } };
    // Two servers, held at the commit seam until both have read the call as pending, then released together.
    let arrived = 0; let open!: () => void; const barrier = new Promise<void>((resolve) => { open = resolve; });
    const held = () => new DynamoMeter({ db, tables: TABLES, now: () => T0, beforeWrite: async (operation) => { if (operation === "correct") { if (++arrived === 2) open(); await barrier; } } });
    const raised = await Promise.all([held().correct(raise), held().correct({ ...raise, runId: "other" })]);
    expect(raised.filter((x) => x.status === "corrected")).toEqual([{ status: "corrected", deltaMicros: 30 }]);
    expect((await meter.read({ ...scope, tid: "task_2" }))[0]).toMatchObject({ spentMicros: 70, estimatedMicros: 0 });
  });

  it("pages pending price keys, one key's calls oldest first, and only expired calls for the sweep", async () => {
    const { db } = table();
    let clock = T0;
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    const big = { task: 10_000, projectMonth: 10_000, companyMonth: 10_000 };
    const settled: Array<[string, number]> = [["claude-b", T0 + 3], ["claude-a", T0 + 2], ["claude-b", T0 + 1], ["claude-a", T0 - 70 * DAY_MS], ["claude-b", T0 + 5]];
    for (const [i, [model, at]] of settled.entries()) {
      const r = await meter.reserve({ scope: { ...scope, tid: `task_${String(i)}` }, caps: big, estimateMicros: 10 }); if (!r.ok) throw new Error("reserve");
      await meter.settle(r.reservation, 10, { provider: "anthropic", model, kind: "chat", usage, settledAt: at });
    }
    const first = await meter.pendingKeys(1);
    expect(first.items).toEqual([{ provider: "anthropic", model: "claude-a" }]);
    const second = await meter.pendingKeys(1, first.cursor);
    expect(second).toEqual({ items: [{ provider: "anthropic", model: "claude-b" }] });
    const pageOne = await meter.pendingFor({ provider: "anthropic", model: "claude-b" }, 2);
    expect(pageOne.items.map((c) => c.settledAt)).toEqual([T0 + 1, T0 + 3]);
    const pageTwo = await meter.pendingFor({ provider: "anthropic", model: "claude-b" }, 2, pageOne.cursor);
    expect(pageTwo).toEqual({ items: [expect.objectContaining({ settledAt: T0 + 5, status: "pending", tid: "task_4" })] });
    expect((await meter.pendingFor({ provider: "anthropic", model: "claude-a" }, 5)).items.map((c) => c.settledAt)).toEqual([T0 - 70 * DAY_MS, T0 + 2]);
    clock = T0;
    const expired = await meter.pendingExpired(T0, 5);
    expect(expired.items.map((c) => c.model)).toEqual(["claude-a"]);
    expect(await meter.expire({ callKey: expired.items[0]!.callKey, now: T0, runId: "sweep" })).toEqual({ status: "expired" });
    expect((await meter.pendingExpired(T0, 5)).items).toEqual([]);
    await expect(meter.pendingFor({ provider: "anthropic", model: "claude-b" }, 2, JSON.stringify(["other", 1, "x"]))).rejects.toThrow("pending unavailable");
    await expect(meter.pendingKeys(0)).rejects.toThrow("pending unavailable");
  });

  it("refuses a malformed call key as missing and malformed input as busy, with no write", async () => {
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
    const base = { realMicros: 1, caps, priceVersion: 1, estimated: false, priceSource: { source: "litellm" as const, fetchedAt: T0 }, runId: "r", now: T0 };
    expect(await meter.correct({ ...base, callKey: "not json" })).toEqual({ status: "missing" });
    expect(await meter.correct({ ...base, callKey: JSON.stringify([scope.iss, "org_bad", "x"]) })).toEqual({ status: "missing" });
    expect(await meter.correct({ ...base, callKey: "k", realMicros: 0 })).toEqual({ status: "busy" });
    expect(await meter.reserve({ scope: { ...scope, cid: "nope" }, caps, estimateMicros: 1 })).toEqual({ ok: false, reason: "busy" });
    expect(wire.calls.filter((c) => c.operation !== "GetItem")).toEqual([]);
  });
});

describe("DynamoMeter: the sweep of holds whose settle never landed", () => {
  const holds = (wire: WireDynamo) => wire.items(TABLES.meter).filter((item) => String(item.sk).startsWith("HOLD#"));
  it("closes an old open hold at its own estimate (estimated, swept), once, and never touches a young or settled one", async () => {
    let clock = T0;
    const { wire, db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    const lost = await meter.reserve({ scope, caps, estimateMicros: 40 }); if (!lost.ok) throw new Error("reserve");
    const settled = await meter.reserve({ scope: { ...scope, tid: "task_2" }, caps, estimateMicros: 10 }); if (!settled.ok) throw new Error("reserve");
    await meter.settle(settled.reservation, 5);
    expect(holds(wire).find((h) => h.status === "settled")).not.toHaveProperty("openAll");
    clock = T0 + HOLD_SWEEP_AGE_MS - 1;
    expect(await meter.sweepOpenHolds(clock, 10)).toEqual({ swept: 0, already: 0, failed: 0, more: false });
    clock = T0 + HOLD_SWEEP_AGE_MS + 1;
    const young = await meter.reserve({ scope: { ...scope, tid: "task_3" }, caps, estimateMicros: 7 }); if (!young.ok) throw new Error("reserve");
    expect(await meter.sweepOpenHolds(clock, 10)).toEqual({ swept: 1, already: 0, failed: 0, more: false });
    const task1 = (await meter.read(scope))[0]!;
    expect(task1).toMatchObject({ spentMicros: 40, estimatedMicros: 40, reservedMicros: 0, committed: 40 });
    expect(holds(wire).filter((h) => h.swept === true)).toHaveLength(1);
    expect(wire.items(TABLES.ledger).find((item) => item.swept === true)).toMatchObject({ settledMicros: 40, estimated: true });
    expect(await meter.sweepOpenHolds(clock, 10)).toEqual({ swept: 0, already: 0, failed: 0, more: false });
    // A settle that finally arrives after the sweep changes nothing.
    await meter.settle(lost.reservation, 3);
    expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 40 });
    expect((await meter.read({ ...scope, tid: "task_3" }))[0]).toMatchObject({ reservedMicros: 7, spentMicros: 0 });
  });

  it("never settles at $0: a zero-estimate hold is swept at one micro-dollar", async () => {
    let clock = T0;
    const { db } = table();
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    expect((await meter.reserve({ scope, caps, estimateMicros: 0 })).ok).toBe(true);
    clock += HOLD_SWEEP_AGE_MS + 1;
    expect((await meter.sweepOpenHolds(clock, 5)).swept).toBe(1);
    expect((await meter.read(scope))[0]).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
  });

  it("is bounded per run (oldest first, `more` when holds remain), and a sweep racing a settle applies once", async () => {
    let clock = T0;
    const { db } = table();
    const big = { task: 10_000, projectMonth: 10_000, companyMonth: 10_000 };
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    const made = [];
    for (let i = 0; i < 3; i++) { clock = T0 + i; const r = await meter.reserve({ scope: { ...scope, tid: `task_${String(i)}` }, caps: big, estimateMicros: 10 }); if (!r.ok) throw new Error("reserve"); made.push(r.reservation); }
    clock = T0 + HOLD_SWEEP_AGE_MS + 10;
    expect(await meter.sweepOpenHolds(clock, 1)).toEqual({ swept: 1, already: 0, failed: 0, more: true });
    expect((await meter.read({ ...scope, tid: "task_0" }))[0]).toMatchObject({ spentMicros: 10 });
    await Promise.all([meter.settle(made[1]!, 4), meter.sweepOpenHolds(clock, 1)]);
    const row = (await meter.read({ ...scope, tid: "task_1" }))[0]!;
    expect([4, 10]).toContain(row.spentMicros);
    expect(row.reservedMicros).toBe(0);
    expect((await meter.read({ ...scope, tid: "task_0" }))[0]!.spentMicros + row.spentMicros).toBeLessThanOrEqual(20);
    await expect(meter.sweepOpenHolds(clock, 0)).rejects.toThrow("sweep unavailable");
  });

  it("a hold it cannot close does not block the ones after it: the next run resumes past it", async () => {
    let clock = T0;
    const { wire, db } = table();
    const big = { task: 10_000, projectMonth: 10_000, companyMonth: 10_000 };
    const meter = new DynamoMeter({ db, tables: TABLES, now: () => clock });
    for (let i = 0; i < 3; i++) { clock = T0 + i; const r = await meter.reserve({ scope: { ...scope, tid: `task_${String(i)}` }, caps: big, estimateMicros: 10 }); if (!r.ok) throw new Error("reserve"); }
    // The oldest hold is unreadable (its targets are gone), but still in the open-holds index.
    const oldest = holds(wire).sort((a, b) => Number(a.createdAt) - Number(b.createdAt))[0]!;
    await db.put(TABLES.meter, { ...(oldest as unknown as Record<string, string>), targets: [] });
    clock = T0 + HOLD_SWEEP_AGE_MS + 10;
    expect(await meter.sweepOpenHolds(clock, 1)).toEqual({ swept: 0, already: 0, failed: 1, more: true });
    expect(await meter.sweepOpenHolds(clock, 1)).toEqual({ swept: 1, already: 0, failed: 0, more: true });
    expect(await meter.sweepOpenHolds(clock, 1)).toEqual({ swept: 1, already: 0, failed: 0, more: false });
    expect((await meter.read({ ...scope, tid: "task_2" }))[0]).toMatchObject({ spentMicros: 10, reservedMicros: 0 });
    // From the oldest again: the stuck hold is reported (and keeps `more` set), never settled at $0 or guessed.
    expect(await meter.sweepOpenHolds(clock, 5)).toEqual({ swept: 0, already: 0, failed: 1, more: true });
  });
});

describe("DynamoEndedTasks", () => {
  it("reads the ended-task list from the markers table by install, company and task, and fails closed", async () => {
    const { wire, db } = table();
    const ended = new DynamoEndedTasks(db, TABLES.markers);
    // Seeded through the wire, so the row belongs to the markers table.
    await db.put(TABLES.markers, { pk: companyPartition(scope.iss, scope.cid), sk: "ENDED#task_9" });
    expect(await ended.isEnded(scope.iss, scope.cid, "task_9")).toBe(true);
    expect(await ended.isEnded(scope.iss, scope.cid, "task_1")).toBe(false);
    expect(await ended.isEnded(scope.iss, `org_${"b".repeat(20)}`, "task_9")).toBe(false);
    wire.fault(() => true, { kind: "error", status: 400, type: "AccessDeniedException" }, 1);
    await expect(ended.isEnded(scope.iss, scope.cid, "task_9")).rejects.toThrow();
  });
});

it("retains missing usage durably, never re-prices it from zero tokens or finalizes it by age", async () => {
  const { db } = table();
  const meter = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
  const r = await meter.reserve({ scope, caps, estimateMicros: 80 }); if (!r.ok) throw new Error("reserve");
  await meter.settle(r.reservation, 80, { provider: "anthropic", model: "claude-x", kind: "chat", settledAt: T0 });
  const restarted = new DynamoMeter({ db, tables: TABLES, now: () => T0 });
  const call = (await restarted.pendingFor({ provider: "anthropic", model: "claude-x" }, 10)).items[0];
  expect(call).toMatchObject({ settledMicros: 80, chargeStatus: "awaiting_usage" });
  if (!call) return;
  expect((await restarted.correct({ callKey: call.callKey, realMicros: 1, caps, priceVersion: 1, estimated: false, priceSource: { source: "aws", fetchedAt: T0 }, runId: "price-only", now: T0 })).status).toBe("busy");
  await restarted.expire({ callKey: call.callKey, runId: "age", now: T0 + 100 * DAY_MS });
  expect((await restarted.pendingFor({ provider: "anthropic", model: "claude-x" }, 10)).items).toHaveLength(1);
  expect((await restarted.read(scope)).every(r => r.spentMicros === 80 && r.estimatedMicros === 80 && r.reservedMicros === 0 && r.committed === 80)).toBe(true);
});
