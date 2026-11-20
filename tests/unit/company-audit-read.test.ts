// Lane AU: the engine audit read. A company administrator lists the audit records of their own company: filtered by time, project, person and
// action, a bounded page at a time. Every row is checked against the company; the read never writes; nothing but the record's facts leaves.
import { describe, expect, it } from "vitest";
import { type AuditEvent, type AuditSink } from "@agentx/contracts";
import { COMPANY_AUDIT_SCAN_MAX, auditViaCaller, readCompanyAudit } from "../../packages/broker/src/core/audit-read/index.js";
import { COMPANY_A, COMPANY_B, countingReadOnly, newStore, plantAuditRow, seedAudit } from "../support/company-reads-fixtures.js";

const T = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (page: { records: Array<{ eventId: string }> }) => page.records.map((record) => record.eventId).sort();

describe("the audit read: what a record looks like", () => {
  it("answers the contract's record shape: when, who, what, on what, outcome, and the caller it came via", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), actor: { type: "person", id: "dev_ada" }, action: "task.approved", subject: { type: "task", id: "t-1" }, details: { via: "client:web-app", note: "hidden" } });
    const page = await readCompanyAudit(store, COMPANY_A, {});
    expect(page).toEqual({ records: [{ eventId: "evt_1", at: T(1), actor: { developerId: "dev_ada", name: "dev_ada", type: "person" }, action: "task.approved", subject: "task:t-1", outcome: "ok", via: "client:web-app" }], skipped: 0 });
  });

  it("calls a refusal a refusal", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), action: "lesson.refused" });
    await seedAudit(store, COMPANY_A, { eventId: "evt_2", at: T(2), action: "task.approved" });
    const { records } = await readCompanyAudit(store, COMPANY_A, {});
    expect(Object.fromEntries(records.map((record) => [record.eventId, record.outcome]))).toEqual({ evt_1: "refused", evt_2: "ok" });
  });
});

describe("the audit read: one company only", () => {

  it("shows no row that names two different companies", async () => {
    const store = newStore();
    await plantAuditRow(store, COMPANY_A, "evt_two", { companyId: COMPANY_A, orgId: COMPANY_B });
    await plantAuditRow(store, COMPANY_A, "evt_same", { companyId: COMPANY_A, orgId: COMPANY_A });
    const page = await readCompanyAudit(store, COMPANY_A, {});
    expect(ids(page)).toEqual(["evt_same"]);
    expect(page.skipped).toBe(1);
  });

  it("refuses a company id that is not a company id, before it reads anything", async () => {
    const probe = countingReadOnly(newStore());
    for (const bad of ["", "ORG#x", "org_a b", "org_", "*"]) await expect(readCompanyAudit(probe.store, bad, {}), bad).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(probe.queries()).toBe(0);
  });
});

describe("the audit read: filters", () => {
  async function mixed() {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), actor: { type: "person", id: "dev_ada" }, action: "task.approved", subject: { type: "task", id: "t-1" }, details: { project: "payments" } });
    await seedAudit(store, COMPANY_A, { eventId: "evt_2", at: T(2), actor: { type: "person", id: "dev_bob" }, action: "task.rejected", subject: { type: "project", id: "payments" } });
    await seedAudit(store, COMPANY_A, { eventId: "evt_3", at: T(3), actor: { type: "agent", id: "dev_ada" }, action: "agent.created", subject: { type: "agent", id: "a-1" } });
    await seedAudit(store, COMPANY_A, { eventId: "evt_4", at: T(4), actor: { type: "system", id: "rovara" }, action: "automatic_runs.paused", subject: { type: "project", id: "ledger" } });
    return store;
  }

  it("combines the filters (all must hold)", async () => {
    const store = await mixed();
    expect(ids(await readCompanyAudit(store, COMPANY_A, { project: "payments", person: "dev_bob", from: T(1), to: T(2), action: "task.*" }))).toEqual(["evt_2"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { project: "payments", person: "dev_ada", action: "task.rejected" }))).toEqual([]);
  });

  it("refuses a query it does not understand, by runtime check, with fixed words that echo nothing", async () => {
    const store = newStore();
    const bad: unknown[] = [
      { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "10" }, { from: "yesterday" }, { to: "2026-11-10" }, { from: T(5), to: T(1) }, { action: "Task.Approved" }, { action: "task..x" },
      { person: "a b" }, { person: "x".repeat(300) }, { project: "has space" }, { unknown: "x" }, { cursor: 7 }, { cursor: "x".repeat(2_000) }, null, "string",
    ];
    for (const query of bad) {
      const failure = await readCompanyAudit(store, COMPANY_A, query as never).catch((error: Error & { code?: string }) => error);
      expect(failure, JSON.stringify(query)).toBeInstanceOf(Error);
      expect((failure as { code: string }).code, JSON.stringify(query)).toMatch(/^(CONFIG_INVALID|AUDIT_RANGE_INVALID)$/u);
      expect((failure as Error).message).not.toContain("x".repeat(20));
      expect((failure as Error).message).not.toContain("yesterday");
    }
  });
});

describe("the audit read: a bounded page at a time", () => {
  async function many(count: number) {
    const store = newStore();
    for (let index = 0; index < count; index += 1) await seedAudit(store, COMPANY_A, { eventId: `evt_${String(index).padStart(4, "0")}`, at: T(index % 60) });
    return store;
  }

  it("gives a full page and no cursor when the records end exactly at the page", async () => {
    const store = await many(5);
    const page = await readCompanyAudit(store, COMPANY_A, { limit: 5 });
    expect(page.records).toHaveLength(5);
    expect(page.next).toBeUndefined();
  });

  it("has a default page of 50 and a largest page of 200", async () => {
    const store = await many(260);
    expect((await readCompanyAudit(store, COMPANY_A, {})).records).toHaveLength(50);
    expect((await readCompanyAudit(store, COMPANY_A, { limit: 200 })).records).toHaveLength(200);
  });

  it("reads at most COMPANY_AUDIT_SCAN_MAX rows in one call, whatever the filters, and says where to go on", async () => {
    const store = newStore();
    const total = COMPANY_AUDIT_SCAN_MAX + 300;
    for (let index = 0; index < total; index += 1) await plantAuditRow(store, COMPANY_A, `evt_${String(index).padStart(5, "0")}`, { companyId: COMPANY_A, actor: { type: "person", id: index === total - 1 ? "dev_late" : "dev_other" } });
    const probe = countingReadOnly(store);
    const first = await readCompanyAudit(probe.store, COMPANY_A, { person: "dev_late" });
    expect(first.records).toEqual([]);
    expect(first.next).toBeDefined();
    expect(probe.rows()).toBeLessThanOrEqual(COMPANY_AUDIT_SCAN_MAX);
    const second = await readCompanyAudit(probe.store, COMPANY_A, { person: "dev_late", cursor: first.next! });
    expect(ids(second)).toEqual([`evt_${String(total - 1).padStart(5, "0")}`]);
    expect(second.next).toBeUndefined();
  });
});

describe("the audit read: a store that misbehaves", () => {
  it("stops, and says where to go on, when a store keeps answering empty pages that carry a cursor", async () => {
    let queries = 0;
    const stubborn = { async query(): Promise<{ items: never[]; cursor: string }> { queries += 1; return { items: [], cursor: "more" }; } };
    const first = await readCompanyAudit(stubborn, COMPANY_A, {});
    expect(first.records).toEqual([]);
    expect(queries).toBeLessThan(40);
  });
});

describe("the audit read: failures and writes", () => {
  it("answers a store failure with fixed words, no cause", async () => {
    const failing = { async query(): Promise<never> { throw new Error("dynamodb said: secret-table-name arn:aws:123"); } };
    const failure = await readCompanyAudit(failing, COMPANY_A, {}).catch((error: Error & { code?: string }) => error) as Error & { code?: string };
    expect(failure.code).toBe("AUDIT_UNAVAILABLE");
    expect(failure.message).toBe("AUDIT_UNAVAILABLE: the audit records could not be read");
    expect(JSON.stringify(failure)).not.toContain("secret-table-name");
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("person via caller: every engine action names the caller it came through", () => {
  const collect = (): { sink: AuditSink; staged: AuditEvent[]; recorded: AuditEvent[] } => {
    const staged: AuditEvent[] = [];
    const recorded: AuditEvent[] = [];
    return { staged, recorded, sink: { stage(event) { staged.push(event); return []; }, async record(event) { recorded.push(event); } } };
  };
  const event: AuditEvent = { eventId: "evt_1", companyId: COMPANY_A, at: T(1), actor: { type: "person", id: "dev_ada" }, action: "task.approved" };

  it("stamps `via` on every staged and recorded event, keeping the other facts", async () => {
    const { sink, staged, recorded } = collect();
    const via = auditViaCaller(sink, "client:web-app");
    via.stage({ ...event, details: { digest: "d1" } });
    await via.record({ ...event, eventId: "evt_2" });
    expect(staged[0]).toMatchObject({ eventId: "evt_1", details: { digest: "d1", via: "client:web-app" } });
    expect(recorded[0]).toMatchObject({ eventId: "evt_2", details: { via: "client:web-app" } });
  });

  it("refuses a caller name that is not a short lower-case word", () => {
    for (const bad of ["", "Web App", "client:WEB", "x".repeat(65), "a b", "client:ünï", undefined as never, 7 as never]) expect(() => auditViaCaller(collect().sink, bad), String(bad)).toThrow();
  });
});
