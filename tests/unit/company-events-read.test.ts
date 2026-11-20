// Lane EV: the per-company work-event read (events and usage out of Code). A reader polls with a cursor: oldest first, company-scoped, bounded.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, workEventPartition } from "@agentx/contracts";
import { COMPANY_EVENTS_SCAN_MAX, readCompanyEvents } from "../../packages/broker/src/core/work-events/read.js";
import { COMPANY_A, IMPLICIT_COMPANY_ID, TASK_IN_SHARD, countingReadOnly, newStore, seedEvent } from "../support/company-reads-fixtures.js";

const D = (day: number, minute = 0, month = 11) => `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse("2026-12-01T00:00:00.000Z");
const WIDE = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" };
const idsOf = (page: { events: Array<{ id: string }> }) => page.events.map((event) => event.id);

describe("the event read: one company only", () => {

  it("gives an old row with no company to the implicit company only (and it cannot be read as an event)", async () => {
    const store = newStore();
    const key = { pk: workEventPartition(COMPANY_A, "2026-11", 0), sk: `${D(1)}#wev_${"a".repeat(32)}` };
    await store.put({ item: { ...key, entityType: "WORK_EVENT", version: 1, id: `wev_${"a".repeat(32)}`, at: D(1), kind: "step_started" } });
    const forA = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(forA.events).toEqual([]);
    expect(forA.skipped).toBe(1);
    const implicitKey = { pk: workEventPartition(IMPLICIT_COMPANY_ID, "2026-11", 0), sk: key.sk };
    await store.put({ item: { ...implicitKey, entityType: "WORK_EVENT", version: 1, id: `wev_${"a".repeat(32)}`, at: D(1), kind: "step_started" } });
    const forImplicit = await readCompanyEvents(store, IMPLICIT_COMPANY_ID, WIDE, NOW);
    expect(forImplicit.skipped).toBe(0);
    expect(forImplicit.unreadable).toBe(1);
  });
});

describe("the event read: filters", () => {
  async function mixed() {
    const store = newStore();
    await seedEvent(store, COMPANY_A, { at: D(1), kind: "task_started", project: "payments", taskId: TASK_IN_SHARD(0), personId: "dev_ada" });
    await seedEvent(store, COMPANY_A, { at: D(2), kind: "step_started", project: "payments", taskId: TASK_IN_SHARD(0), personId: "dev_bob" });
    await seedEvent(store, COMPANY_A, { at: D(3), kind: "step_started", project: "ledger", taskId: TASK_IN_SHARD(1), personId: "dev_ada" });
    await seedEvent(store, COMPANY_A, { at: D(4), kind: "task_closed", project: "ledger", taskId: TASK_IN_SHARD(1), personId: "dev_ada" });
    return store;
  }
  const kinds = async (store: Awaited<ReturnType<typeof mixed>>, query: Record<string, unknown>) => (await readCompanyEvents(store, COMPANY_A, { ...WIDE, ...query }, NOW)).events.map((event) => event.kind);

  it("filters by kind, project, task and person", async () => {
    const store = await mixed();
    expect(await kinds(store, { kinds: ["step_started"] })).toEqual(["step_started", "step_started"]);
    expect(await kinds(store, { project: "ledger" })).toEqual(["step_started", "task_closed"]);
    expect(await kinds(store, { taskId: TASK_IN_SHARD(0) })).toEqual(["task_started", "step_started"]);
    expect(await kinds(store, { person: "dev_bob" })).toEqual(["step_started"]);
    expect(await kinds(store, { project: "ledger", kinds: ["task_closed", "task_started"], person: "dev_ada" })).toEqual(["task_closed"]);
  });

  it("holds the time window, both ends inclusive", async () => {
    const store = await mixed();
    expect(await kinds(store, { from: D(2), to: D(3) })).toEqual(["step_started", "step_started"]);
    expect(await kinds(store, { from: D(4), to: D(4) })).toEqual(["task_closed"]);
  });

  it("does not return an event past its expiry, even if the store has not swept it", async () => {
    const store = newStore();
    const id = await seedEvent(store, COMPANY_A, { at: D(1) });
    const row = (await store.query({ pk: workEventPartition(COMPANY_A, "2026-11", 0) })).items[0]!;
    await store.put({ item: { ...row, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) - 1 } });
    expect((await readCompanyEvents(store, COMPANY_A, WIDE, NOW)).events).toEqual([]);
    expect(id).toBeDefined();
  });

  it("refuses a query it does not understand by runtime check, with fixed words that echo nothing", async () => {
    const store = newStore();
    const bad: unknown[] = [
      {}, { from: "yesterday" }, { ...WIDE, to: "2026-11-30" }, { from: WIDE.to, to: WIDE.from }, { ...WIDE, limit: 0 }, { ...WIDE, limit: 501 }, { ...WIDE, limit: "5" }, { ...WIDE, kinds: ["not_a_kind"] }, { ...WIDE, kinds: "step_started" },
      { ...WIDE, kinds: Array.from({ length: 40 }, () => "step_started") }, { ...WIDE, project: "has space" }, { ...WIDE, taskId: "not-a-uuid" }, { ...WIDE, person: "a b" }, { ...WIDE, extra: 1 },
      { cursor: "x", from: WIDE.from }, { cursor: 7 }, null, "text",
    ];
    for (const query of bad) {
      const failure = await readCompanyEvents(store, COMPANY_A, query as never, NOW).catch((error: Error & { code?: string }) => error);
      expect(failure, JSON.stringify(query)).toBeInstanceOf(Error);
      expect((failure as { code: string }).code, JSON.stringify(query)).toMatch(/^(CONFIG_INVALID|AUDIT_RANGE_INVALID)$/u);
      expect((failure as Error).message).not.toContain("yesterday");
      expect((failure as Error).message).not.toContain("not_a_kind");
    }
  });

  it("refuses a range that spans more months than the store keeps events for", async () => {
    const store = newStore();
    const probe = countingReadOnly(store);
    await expect(readCompanyEvents(probe.store, COMPANY_A, { from: "2025-01-01T00:00:00.000Z", to: "2026-11-30T00:00:00.000Z" }, NOW)).rejects.toMatchObject({ code: "AUDIT_RANGE_INVALID" });
    expect(probe.queries()).toBe(0);
  });
});

describe("the event read: a bounded page at a time, polled with a cursor", () => {
  async function many(count: number) {
    const store = newStore();
    for (let index = 0; index < count; index += 1) await seedEvent(store, COMPANY_A, { at: D(1 + (index % 28), index % 60), taskId: TASK_IN_SHARD(index % 8, index), source: `s${String(index)}` });
    return store;
  }

  it("reads at most COMPANY_EVENTS_SCAN_MAX rows in one call, whatever the filters, and says where to go on", async () => {
    const store = newStore();
    const total = COMPANY_EVENTS_SCAN_MAX + 200;
    for (let index = 0; index < total; index += 1) {
      await seedEvent(store, COMPANY_A, { at: new Date(Date.parse("2026-11-01T00:00:00.000Z") + index * 1_000).toISOString(), taskId: TASK_IN_SHARD(0, index), source: `s${String(index).padStart(5, "0")}`, project: index === total - 1 ? "wanted" : "other" });
    }
    const probe = countingReadOnly(store);
    const first = await readCompanyEvents(probe.store, COMPANY_A, { ...WIDE, project: "wanted" }, NOW);
    expect(first.events).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(probe.rows()).toBeLessThanOrEqual(COMPANY_EVENTS_SCAN_MAX + 8 * 100);
    let cursor = first.next;
    let found: string[] = [];
    for (let round = 0; round < 5 && found.length === 0; round += 1) {
      const page = await readCompanyEvents(probe.store, COMPANY_A, { cursor, project: "wanted" }, NOW);
      found = idsOf(page);
      cursor = page.next;
    }
    expect(found).toHaveLength(1);
  });

  it("refuses a cursor it did not give out, with fixed words: rubbish, and a real cursor changed in any one part", async () => {
    const store = await many(3);
    const real = (await readCompanyEvents(store, COMPANY_A, { ...WIDE, limit: 1 }, NOW)).next;
    const tamper = (change: (body: Record<string, unknown>) => void) => {
      const body = JSON.parse(Buffer.from(real, "base64url").toString("utf8")) as Record<string, unknown>;
      change(body);
      return Buffer.from(JSON.stringify(body)).toString("base64url");
    };
    const forged = [
      "not-base64!", Buffer.from("{}").toString("base64url"), Buffer.from("[]").toString("base64url"),
      tamper((body) => { body["v"] = 2; }), tamper((body) => { body["h"] = 7; }), tamper((body) => { body["extra"] = 1; }), tamper((body) => { delete body["v"]; }),
      tamper((body) => { body["p"] = "not a position"; }), tamper((body) => { body["p"] = 5; }), tamper((body) => { body["p"] = `${D(1)}#wev_x`; }),
    ];
    for (const cursor of forged) await expect(readCompanyEvents(store, COMPANY_A, { cursor }, NOW), cursor).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
    await expect(readCompanyEvents(store, COMPANY_A, { cursor: real }, NOW)).resolves.toBeDefined();
  });

  it("stops, and says where to go on, when a store keeps answering empty pages that carry a cursor", async () => {
    let queries = 0;
    const stubborn = { async query(): Promise<{ items: never[]; cursor: string }> { queries += 1; return { items: [], cursor: "more" }; } };
    const page = await readCompanyEvents(stubborn, COMPANY_A, WIDE, NOW);
    expect(page).toMatchObject({ events: [], hasMore: true });
    expect(queries).toBeLessThan(60);
  });

  it("does not move the cursor onto a row whose key a cursor cannot carry, and counts it as unreadable", async () => {
    const store = newStore();
    const good = await seedEvent(store, COMPANY_A, { at: D(1) });
    await store.put({ item: { pk: workEventPartition(COMPANY_A, "2026-11", 2), sk: `${D(2)}#odd`, entityType: "WORK_EVENT", orgId: COMPANY_A } });
    const page = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(idsOf(page)).toEqual([good]);
    expect(page.unreadable).toBe(1);
    await expect(readCompanyEvents(store, COMPANY_A, { cursor: page.next }, NOW)).resolves.toBeDefined();
  });

  it("answers a store failure with fixed words, no cause, and never writes", async () => {
    const failing = { async query(): Promise<never> { throw new Error("dynamodb said: secret-table-name"); } };
    const failure = await readCompanyEvents(failing, COMPANY_A, WIDE, NOW).catch((error: Error & { code?: string }) => error) as Error & { code?: string };
    expect(failure.code).toBe("AUDIT_UNAVAILABLE");
    expect(failure.message).toBe("AUDIT_UNAVAILABLE: the events could not be read");
    expect(JSON.stringify(failure)).not.toContain("secret-table-name");
    const store = newStore();
    await seedEvent(store, COMPANY_A, { at: D(1) });
    await readCompanyEvents(countingReadOnly(store).store, COMPANY_A, WIDE, NOW);
  });
});

it("company change feeds never return a workspace discovery pointer", async () => {
  const store = newStore();
  await seedEvent(store, COMPANY_A, { at: D(2) });
  const row = (await store.scanPage()).items[0]!;
  await store.put({ item: { ...row, entityType: "WORKSPACE_COMPANY_POINTER" } });
  expect((await readCompanyEvents(store, COMPANY_A, WIDE, NOW)).events).toEqual([]);
});
