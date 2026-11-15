// Lane EV: the per-company work-event read (events and usage out of Code). A reader polls with a cursor: oldest first, company-scoped, bounded.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, workEventPartition } from "@agentx/contracts";
import { COMPANY_EVENTS_SCAN_MAX, readCompanyEvents } from "../../packages/broker/src/core/work-events/read.js";
import { COMPANY_A, COMPANY_B, IMPLICIT_COMPANY_ID, TASK_IN_SHARD, countingReadOnly, newStore, seedEvent } from "../support/company-reads-fixtures.js";

const D = (day: number, minute = 0, month = 11) => `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse("2026-12-01T00:00:00.000Z");
const WIDE = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-30T23:59:59.999Z" };
const idsOf = (page: { events: Array<{ id: string }> }) => page.events.map((event) => event.id);

describe("the event read: the shape", () => {
  it("answers the events as the contract holds them, oldest first, with a cursor to poll from", async () => {
    const store = newStore();
    const second = await seedEvent(store, COMPANY_A, { at: D(2) });
    const first = await seedEvent(store, COMPANY_A, { at: D(1) });
    const page = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(idsOf(page)).toEqual([first, second]);
    expect(page.events[0]).toMatchObject({ version: 1, kind: "step_started", orgId: COMPANY_A, project: "billing-service", actor: { kind: "person", personId: "dev_ada" } });
    expect(page.hasMore).toBe(false);
    expect(page.unreadable).toBe(0);
    expect(typeof page.next).toBe("string");
  });

  it("carries usage: the settled costs are events like the rest", async () => {
    const store = newStore();
    await seedEvent(store, COMPANY_A, { at: D(1), kind: "cost_settled", micros: 2_500_000 });
    const page = await readCompanyEvents(store, COMPANY_A, { ...WIDE, kinds: ["cost_settled"] }, NOW);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ kind: "cost_settled", micros: 2_500_000, currency: "USD" });
  });

  it("merges the eight shards of a month into time order, and walks months in order", async () => {
    const store = newStore();
    const expected: string[] = [];
    for (let shard = 7; shard >= 0; shard -= 1) expected.push(await seedEvent(store, COMPANY_A, { at: D(3, shard), taskId: TASK_IN_SHARD(shard) }));
    const october = await seedEvent(store, COMPANY_A, { at: "2026-10-31T23:00:00.000Z", taskId: TASK_IN_SHARD(2) });
    const december = await seedEvent(store, COMPANY_A, { at: "2026-12-01T01:00:00.000Z", taskId: TASK_IN_SHARD(5) });
    const page = await readCompanyEvents(store, COMPANY_A, { from: "2026-10-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" }, NOW);
    expect(idsOf(page)).toEqual([october, ...expected.reverse(), december]);
  });
});

describe("the event read: one company only", () => {
  it("shows each company its own events and nobody else's", async () => {
    const store = newStore();
    const a = await seedEvent(store, COMPANY_A, { at: D(1), taskId: TASK_IN_SHARD(1) });
    const b = await seedEvent(store, COMPANY_B, { at: D(1), taskId: TASK_IN_SHARD(1) });
    expect(idsOf(await readCompanyEvents(store, COMPANY_A, WIDE, NOW))).toEqual([a]);
    expect(idsOf(await readCompanyEvents(store, COMPANY_B, WIDE, NOW))).toEqual([b]);
    expect((await readCompanyEvents(store, IMPLICIT_COMPANY_ID, WIDE, NOW)).events).toEqual([]);
  });

  it("drops a row of another company in this company's partition, counted as skipped", async () => {
    const store = newStore();
    const mine = await seedEvent(store, COMPANY_A, { at: D(1) });
    await seedEvent(store, COMPANY_B, { at: D(2), orgId: COMPANY_B }, COMPANY_A);
    const page = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(idsOf(page)).toEqual([mine]);
    expect(page.skipped).toBe(1);
  });

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

  it("asks the store only for this company's partitions", async () => {
    const store = newStore();
    const seen = new Set<string>();
    const spy = { async query(request: { pk: string }) { seen.add(request.pk); return store.query(request); } };
    await readCompanyEvents(spy, COMPANY_A, WIDE, NOW);
    expect(seen.size).toBe(8);
    for (const pk of seen) expect(pk.startsWith(`ORG#${COMPANY_A}#WORK_EVENTS#2026-11#`)).toBe(true);
  });

  it("refuses a cursor made for another company or other filters, with fixed words", async () => {
    const store = newStore();
    for (let day = 1; day <= 4; day += 1) { await seedEvent(store, COMPANY_A, { at: D(day) }); await seedEvent(store, COMPANY_B, { at: D(day) }); }
    const forA = await readCompanyEvents(store, COMPANY_A, { ...WIDE, limit: 2 }, NOW);
    expect(forA.hasMore).toBe(true);
    await expect(readCompanyEvents(store, COMPANY_B, { cursor: forA.next }, NOW)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
    await expect(readCompanyEvents(store, COMPANY_A, { cursor: forA.next, project: "other" }, NOW)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
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

  it("counts a row it cannot read instead of hiding it", async () => {
    const store = newStore();
    await seedEvent(store, COMPANY_A, { at: D(1) });
    await store.put({ item: { pk: workEventPartition(COMPANY_A, "2026-11", 3), sk: `${D(2)}#wev_${"b".repeat(32)}`, entityType: "WORK_EVENT", orgId: COMPANY_A, version: 9, kind: "step_started" } });
    const page = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(page.events).toHaveLength(1);
    expect(page.unreadable).toBe(1);
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

  it("pages: every event once, in order, none twice, and no more at the end", async () => {
    const store = await many(41);
    const seen: Array<{ at: string; id: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readCompanyEvents(store, COMPANY_A, cursor === undefined ? { ...WIDE, limit: 10 } : { cursor, limit: 10 }, NOW);
      expect(page.events.length).toBeLessThanOrEqual(10);
      seen.push(...page.events);
      cursor = page.hasMore ? page.next : undefined;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);
    expect(pages).toBe(5);
    expect(new Set(seen.map((event) => event.id)).size).toBe(41);
    expect(seen.map((event) => `${event.at}#${event.id}`)).toEqual(seen.map((event) => `${event.at}#${event.id}`).sort());
  });

  it("has a default page of 100 and a largest page of 500", async () => {
    const store = await many(120);
    expect((await readCompanyEvents(store, COMPANY_A, WIDE, NOW)).events).toHaveLength(100);
    expect((await readCompanyEvents(store, COMPANY_A, { ...WIDE, limit: 500 }, NOW)).events).toHaveLength(120);
  });

  it("gives the same cursor to poll with after the last event, and picks up what comes next", async () => {
    const store = newStore();
    await seedEvent(store, COMPANY_A, { at: D(1) });
    const first = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(first.hasMore).toBe(false);
    expect((await readCompanyEvents(store, COMPANY_A, { cursor: first.next }, NOW)).events).toEqual([]);
    const later = await seedEvent(store, COMPANY_A, { at: D(2), taskId: TASK_IN_SHARD(4) });
    const polled = await readCompanyEvents(store, COMPANY_A, { cursor: first.next }, NOW);
    expect(idsOf(polled)).toEqual([later]);
    expect(idsOf(await readCompanyEvents(store, COMPANY_A, { cursor: polled.next }, NOW))).toEqual([]);
  });

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

  it("gives a cursor to poll from even when there is nothing yet, and finds what comes after it", async () => {
    const store = newStore();
    const empty = await readCompanyEvents(store, COMPANY_A, WIDE, NOW);
    expect(empty).toMatchObject({ events: [], hasMore: false });
    const later = await seedEvent(store, COMPANY_A, { at: D(5) });
    expect(idsOf(await readCompanyEvents(store, COMPANY_A, { cursor: empty.next }, NOW))).toEqual([later]);
    // The cursor stands for "from the start of the window": an event at exactly `from` is in the first read, not lost between the two.
    const atFrom = await seedEvent(store, COMPANY_A, { at: WIDE.from, taskId: TASK_IN_SHARD(3) });
    expect(idsOf(await readCompanyEvents(store, COMPANY_A, WIDE, NOW))).toEqual([atFrom, later]);
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
