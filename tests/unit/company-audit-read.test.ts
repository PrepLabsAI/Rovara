// Lane AU: the engine audit read. A company administrator lists the audit records of their own company: filtered by time, project, person and
// action, a bounded page at a time. Every row is checked against the company; the read never writes; nothing but the record's facts leaves.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped, type AuditEvent, type AuditSink } from "@agentx/contracts";
import { DocumentAuditSink } from "../../packages/broker/src/plugins/audit-sink/document/sink.js";
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

  it("never returns the record's details, only the one fact `via`", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), details: { secretish: "sk-not-for-the-reader", via: "cli" } });
    const text = JSON.stringify(await readCompanyAudit(store, COMPANY_A, {}));
    expect(text).not.toContain("sk-not-for-the-reader");
    expect(text).not.toContain("secretish");
  });

  it("calls a refusal a refusal", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), action: "lesson.refused" });
    await seedAudit(store, COMPANY_A, { eventId: "evt_2", at: T(2), action: "task.approved" });
    const { records } = await readCompanyAudit(store, COMPANY_A, {});
    expect(Object.fromEntries(records.map((record) => [record.eventId, record.outcome]))).toEqual({ evt_1: "refused", evt_2: "ok" });
  });

  it("projects the fixed sign-in method and cause only when the sign-in filter is selected", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "signin_1", at: T(3), action: "signin.refused", details: { method: "slack", cause: "not_invited", token: "never-return-this" } });
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(2), action: "task.approved" });
    const signIns = await readCompanyAudit(store, COMPANY_A, { kind: "sign-in" });
    expect(signIns.records).toEqual([expect.objectContaining({ eventId: "signin_1", method: "slack", cause: "not_invited" })]);
    expect(JSON.stringify(signIns)).not.toContain("never-return-this");
    expect((await readCompanyAudit(store, COMPANY_A, {})).records.some((record) => record.eventId === "signin_1")).toBe(false);
  });

  it("lists a page newest first", async () => {
    const store = newStore();
    for (const [index, minute] of [[1, 5], [2, 9], [3, 1]] as const) await seedAudit(store, COMPANY_A, { eventId: `evt_${String(index)}`, at: T(minute) });
    expect((await readCompanyAudit(store, COMPANY_A, {})).records.map((record) => record.at)).toEqual([T(9), T(5), T(1)]);
  });
});

describe("the audit read: one company only", () => {
  async function twoCompanies() {
    const store = newStore();
    for (let index = 0; index < 4; index += 1) {
      await seedAudit(store, COMPANY_A, { eventId: `evt_a${String(index)}`, at: T(index) });
      await seedAudit(store, COMPANY_B, { eventId: `evt_b${String(index)}`, at: T(index) });
    }
    return store;
  }

  it("shows each company its own records and nobody else's", async () => {
    const store = await twoCompanies();
    expect(ids(await readCompanyAudit(store, COMPANY_A, {}))).toEqual(["evt_a0", "evt_a1", "evt_a2", "evt_a3"]);
    expect(ids(await readCompanyAudit(store, COMPANY_B, {}))).toEqual(["evt_b0", "evt_b1", "evt_b2", "evt_b3"]);
    expect((await readCompanyAudit(store, IMPLICIT_COMPANY_ID, {})).records).toEqual([]);
  });

  it("drops a row of another company that sits in this company's partition, and counts it as skipped", async () => {
    const store = await twoCompanies();
    await plantAuditRow(store, COMPANY_A, "evt_planted", { companyId: COMPANY_B });
    const page = await readCompanyAudit(store, COMPANY_A, {});
    expect(ids(page)).toEqual(["evt_a0", "evt_a1", "evt_a2", "evt_a3"]);
    expect(page.skipped).toBe(1);
  });

  it("fails closed if the store's company query returns another company's sign-in row", async () => {
    const store = await twoCompanies();
    const mutant = { query: async (request: { pk: string; limit: number; [key: string]: unknown }) => {
      const page = await store.query(request);
      const foreign = await store.query({ ...request, pk: companyScoped(COMPANY_B, "AUDIT") });
      return { ...page, items: [...page.items, ...foreign.items] };
    } };
    const page = await readCompanyAudit(mutant, COMPANY_A, { kind: "sign-in" });
    expect(page.records.every((record) => record.eventId.startsWith("evt_a"))).toBe(true);
    expect(page.skipped).toBe(4);
  });

  it("gives an old row with no company to the implicit company only", async () => {
    const store = newStore();
    await plantAuditRow(store, COMPANY_A, "evt_old_a", {});
    await plantAuditRow(store, IMPLICIT_COMPANY_ID, "evt_old_implicit", {});
    expect(ids(await readCompanyAudit(store, COMPANY_A, {}))).toEqual([]);
    expect(ids(await readCompanyAudit(store, IMPLICIT_COMPANY_ID, {}))).toEqual(["evt_old_implicit"]);
  });

  it("reads a company named `orgId` on a row the hosted product wrote, the same way", async () => {
    const store = newStore();
    await plantAuditRow(store, COMPANY_A, "evt_org", { orgId: COMPANY_A });
    await plantAuditRow(store, COMPANY_A, "evt_org_b", { orgId: COMPANY_B });
    expect(ids(await readCompanyAudit(store, COMPANY_A, {}))).toEqual(["evt_org"]);
  });

  it("shows no row that names two different companies", async () => {
    const store = newStore();
    await plantAuditRow(store, COMPANY_A, "evt_two", { companyId: COMPANY_A, orgId: COMPANY_B });
    await plantAuditRow(store, COMPANY_A, "evt_same", { companyId: COMPANY_A, orgId: COMPANY_A });
    const page = await readCompanyAudit(store, COMPANY_A, {});
    expect(ids(page)).toEqual(["evt_same"]);
    expect(page.skipped).toBe(1);
  });

  it("never reads a stored company that is not a company id as the implicit one", async () => {
    const store = newStore();
    for (const [index, bad] of ["", "implicit", 7, null, { id: COMPANY_A }, "org_short"].entries()) await plantAuditRow(store, IMPLICIT_COMPANY_ID, `evt_bad${String(index)}`, { companyId: bad });
    const page = await readCompanyAudit(store, IMPLICIT_COMPANY_ID, {});
    expect(page.records).toEqual([]);
    expect(page.skipped).toBe(6);
  });

  it("refuses a company id that is not a company id, before it reads anything", async () => {
    const probe = countingReadOnly(newStore());
    for (const bad of ["", "ORG#x", "org_a b", "org_", "*"]) await expect(readCompanyAudit(probe.store, bad, {}), bad).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(probe.queries()).toBe(0);
  });

  it("asks the store for this company's partition and no other", async () => {
    const seen: string[] = [];
    const store = newStore();
    const spy = { async query(request: { pk: string }) { seen.push(request.pk); return store.query(request); } };
    await readCompanyAudit(spy, COMPANY_A, {});
    expect(seen).toEqual([companyScoped(COMPANY_A, "AUDIT")]);
  });

  it("refuses a cursor made for another company or for other filters, with the same fixed words", async () => {
    const store = await twoCompanies();
    const forA = await readCompanyAudit(store, COMPANY_A, { limit: 2 });
    expect(forA.next).toBeDefined();
    await expect(readCompanyAudit(store, COMPANY_B, { limit: 2, cursor: forA.next! })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
    await expect(readCompanyAudit(store, COMPANY_A, { limit: 2, person: "dev_bob", cursor: forA.next! })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
    const text = (await readCompanyAudit(store, COMPANY_B, { cursor: forA.next! }).catch((error: Error) => error.message));
    expect(text).not.toContain(COMPANY_A);
    expect(text).not.toContain(COMPANY_B);
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

  it("filters by time, both ends inclusive", async () => {
    const store = await mixed();
    expect(ids(await readCompanyAudit(store, COMPANY_A, { from: T(2), to: T(3) }))).toEqual(["evt_2", "evt_3"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { from: T(4) }))).toEqual(["evt_4"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { to: T(1) }))).toEqual(["evt_1"]);
  });

  it("filters by person (a person, an agent of that name too)", async () => {
    const store = await mixed();
    expect(ids(await readCompanyAudit(store, COMPANY_A, { person: "dev_bob" }))).toEqual(["evt_2"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { person: "dev_ada" }))).toEqual(["evt_1", "evt_3"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { person: "dev_nobody" }))).toEqual([]);
  });

  it("filters by action: exactly, or by a dotted family ending in `.*`", async () => {
    const store = await mixed();
    expect(ids(await readCompanyAudit(store, COMPANY_A, { action: "task.approved" }))).toEqual(["evt_1"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { action: "task.*" }))).toEqual(["evt_1", "evt_2"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { action: "task" }))).toEqual([]);
  });

  it("filters by project: the record's project subject, or the project named in its facts", async () => {
    const store = await mixed();
    expect(ids(await readCompanyAudit(store, COMPANY_A, { project: "payments" }))).toEqual(["evt_1", "evt_2"]);
    expect(ids(await readCompanyAudit(store, COMPANY_A, { project: "ledger" }))).toEqual(["evt_4"]);
  });

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

  it("pages with a cursor: every record once, none twice, and no cursor on the last page", async () => {
    const store = await many(23);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readCompanyAudit(store, COMPANY_A, { limit: 5, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.records.length).toBeLessThanOrEqual(5);
      seen.push(...page.records.map((record) => record.eventId));
      cursor = page.next;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toHaveLength(23);
  });

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

  it("answers a large company in bounded time", async () => {
    const store = newStore();
    for (let index = 0; index < 3_000; index += 1) await plantAuditRow(store, COMPANY_A, `evt_${String(index).padStart(5, "0")}`, { companyId: COMPANY_A });
    const started = Date.now();
    await readCompanyAudit(store, COMPANY_A, { person: "dev_nobody" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a cursor it did not give out, with fixed words: rubbish, and a real cursor changed in any one part", async () => {
    const store = await many(3);
    const real = (await readCompanyAudit(store, COMPANY_A, { limit: 1 })).next!;
    const tamper = (change: (body: Record<string, unknown>) => void) => {
      const body = JSON.parse(Buffer.from(real, "base64url").toString("utf8")) as Record<string, unknown>;
      change(body);
      return Buffer.from(JSON.stringify(body)).toString("base64url");
    };
    const forged = [
      "not-base64!", Buffer.from("{}").toString("base64url"), Buffer.from("[]").toString("base64url"),
      tamper((body) => { body["v"] = 2; }), tamper((body) => { body["h"] = 7; }), tamper((body) => { body["extra"] = 1; }), tamper((body) => { delete body["v"]; }),
      tamper((body) => { body["k"] = "OTHER#a"; }), tamper((body) => { body["k"] = 5; }), tamper((body) => { body["k"] = `EVENT#${"x".repeat(500)}`; }),
    ];
    for (const cursor of forged) await expect(readCompanyAudit(store, COMPANY_A, { limit: 1, cursor }), cursor).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID: that cursor is not valid" });
    await expect(readCompanyAudit(store, COMPANY_A, { limit: 1, cursor: real })).resolves.toBeDefined();
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

  it("never makes a row with a key a cursor cannot carry the place to resume from", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1) });
    await store.put({ item: { pk: companyScoped(COMPANY_A, "AUDIT"), sk: "ZZZ-odd-key", entityType: "AUDIT", companyId: COMPANY_A } });
    const first = await readCompanyAudit(store, COMPANY_A, { limit: 1 });
    expect(ids(first)).toEqual(["evt_1"]);
    const rest = await readCompanyAudit(store, COMPANY_A, { limit: 1, cursor: first.next! });
    expect(rest.records).toEqual([]);
    expect(rest.skipped).toBe(1);
    expect(rest.next).toBeUndefined();
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

  it("never writes: it works with a store that has only `query`, and a read leaves the rows exactly as they were", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1) });
    const before = JSON.stringify((await store.query({ pk: companyScoped(COMPANY_A, "AUDIT") })).items);
    const probe = countingReadOnly(store);
    await readCompanyAudit(probe.store, COMPANY_A, {});
    expect(JSON.stringify((await store.query({ pk: companyScoped(COMPANY_A, "AUDIT") })).items)).toBe(before);
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

  it("does not let an event's own details say who the caller was: the engine's word wins", () => {
    const { sink, staged } = collect();
    auditViaCaller(sink, "slack").stage({ ...event, details: { via: "client:someone-else" } });
    expect(staged[0]?.details).toEqual({ via: "slack" });
  });

  it("returns the staged steps of the sink it wraps, untouched", () => {
    const steps = [{ kind: "check", key: { pk: "p", sk: "s" }, condition: { op: "absent" } }] as never;
    const via = auditViaCaller({ stage: () => steps, async record() {} }, "cli");
    expect(via.stage(event)).toBe(steps);
  });

  it("refuses a caller name that is not a short lower-case word", () => {
    for (const bad of ["", "Web App", "client:WEB", "x".repeat(65), "a b", "client:ünï", undefined as never, 7 as never]) expect(() => auditViaCaller(collect().sink, bad), String(bad)).toThrow();
  });

  it("is what the reader shows: a record written through the wrapper, with Code's own sink, reads back with its caller", async () => {
    const store = newStore();
    const sink = auditViaCaller(new DocumentAuditSink({ store: () => store }), "client:web-app");
    await sink.record({ ...event, details: { note: "n" } });
    const { records } = await readCompanyAudit(store, COMPANY_A, {});
    expect(records[0]).toMatchObject({ eventId: "evt_1", actor: { developerId: "dev_ada" }, via: "client:web-app" });
  });

  it("is read back as no caller when the stored word is not a caller name (a row written some other way)", async () => {
    const store = newStore();
    await seedAudit(store, COMPANY_A, { eventId: "evt_1", at: T(1), details: { via: "NOT A CALLER!" } });
    const { records } = await readCompanyAudit(store, COMPANY_A, {});
    expect(records[0]).not.toHaveProperty("via");
  });
});

it("company audit lists never return a workspace discovery pointer", async () => {
  const store = newStore();
  await plantAuditRow(store, COMPANY_A, "pointer-canary", { companyId: COMPANY_A, entityType: "WORKSPACE_COMPANY_POINTER" });
  expect((await readCompanyAudit(store, COMPANY_A, {})).records).toEqual([]);
});
