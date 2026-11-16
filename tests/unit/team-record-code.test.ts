// The Team record in Code (DEC 226), first slice: rows of decisions, review feedback and tasks per project, company-scoped keys, keyword search with no infrastructure, only members' words, one row per
// source, and the person erase. The context sources' search answers only for a task of the company and project asked about.
import { describe, expect, it } from "vitest";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createTeamRecord, RECORD_KEEP_DAYS, RECORD_SEARCH_WINDOW, TeamRecordCompanyError } from "../../packages/broker/src/team-record/record.js";
import { recordEndedTask, teamRecordSearchOver } from "../../packages/broker/src/team-record/capture.js";
import type { TaskSubjectSource } from "../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../packages/broker/src/lessons/task-outcome-rows.js";
import type { EvidenceSpan } from "../../packages/broker/src/lessons/reflect-input.js";

const A = "org_teamrecord000000000a" as OrgId;
const B = "org_teamrecord000000000b" as OrgId;
const T0 = Date.parse("2026-11-15T10:00:00.000Z");

function world() {
  const clock = { now: T0 };
  const store = new MemoryDocumentStore({ indexes: [], ttlAttribute: "indexExpiresAt", nowSeconds: () => Math.floor(clock.now / 1000) });
  return { clock, store, a: createTeamRecord({ store, companyId: A, now: () => clock.now }), b: createTeamRecord({ store, companyId: B, now: () => clock.now }) };
}

const draft = (over: Partial<Parameters<ReturnType<typeof createTeamRecord>["put"]>[0]> = {}) => ({
  project: "payments", kind: "decision" as const, text: "Sent the work back: retries must use the withRetry helper, never a hand loop", taskId: "task-1", authorId: "ann", sourceRef: "task:task-1:sendback:r1", occurredAt: new Date(T0).toISOString(), ...over,
});

describe("rows and keys", () => {
  it("keeps every row in its own company's project partition, never in another company's", async () => {
    const w = world();
    expect(await w.a.put(draft())).toBe(true);
    const aRows = await w.store.query({ pk: teamRecordPk(A, "payments") });
    expect(aRows.items.some((item) => item["entityType"] === "TEAM_RECORD_ROW")).toBe(true);
    expect((await w.store.query({ pk: teamRecordPk(B, "payments") })).items).toEqual([]);
    // No raw person id in a key: the author pointer is a hash.
    expect(aRows.items.every((item) => !item.sk.includes("ann"))).toBe(true);
  });

  it("writes one row per source, however often a task end is heard", async () => {
    const w = world();
    expect(await w.a.put(draft())).toBe(true);
    expect(await w.a.put(draft({ occurredAt: new Date(T0 + 1000).toISOString() }))).toBe(false);
    expect(await w.a.search("payments", "withRetry", 10)).toHaveLength(1);
  });

  it("refuses an empty text, an unknown kind or no author", async () => {
    const w = world();
    expect(await w.a.put(draft({ text: "   " }))).toBe(false);
    expect(await w.a.put(draft({ kind: "gossip" as never, sourceRef: "x1" }))).toBe(false);
    expect(await w.a.put(draft({ authorId: "", sourceRef: "x2" }))).toBe(false);
  });

  it("a row past its keep time is not found", async () => {
    const w = world();
    await w.a.put(draft());
    w.clock.now += (RECORD_KEEP_DAYS * 86_400 + 1) * 1000;
    expect(await w.a.search("payments", "withRetry", 10)).toEqual([]);
  });
});

describe("search", () => {
  it("ranks the project's rows by keyword (best passage), answers nothing for a query with no words, and never another company's or project's rows", async () => {
    const w = world();
    await w.a.put(draft());
    await w.a.put(draft({ kind: "review_feedback", text: "Please log the request id on every error path", sourceRef: "github:repo/1#pr2:review_comment9" }));
    await w.a.put(draft({ project: "billing", text: "withRetry is banned in billing", sourceRef: "s-billing" }));
    await w.b.put(draft({ text: "withRetry everywhere at company B", sourceRef: "s-b" }));
    const hits = await w.a.search("payments", "how should retries use withRetry", 10);
    expect(hits.map((hit) => hit.row.sourceRef)).toEqual(["task:task-1:sendback:r1"]);
    expect(await w.a.search("payments", "!!", 10)).toEqual([]);
    expect((await w.a.search("payments", "request id error", 10))[0]!.row.kind).toBe("review_feedback");
  });
});

describe("erase", () => {
  it("removes every row the person wrote in the company, and nothing of anyone else's or of another company", async () => {
    const w = world();
    await w.a.put(draft());
    await w.a.put(draft({ authorId: "bob", text: "Use withRetry for the payment webhook too", sourceRef: "s-bob" }));
    await w.b.put(draft({ sourceRef: "s-b-ann" }));
    expect(await w.a.erasePerson(["payments"], "ann")).toBe(1);
    expect((await w.a.search("payments", "withRetry", 10)).map((hit) => hit.row.authorId)).toEqual(["bob"]);
    expect(await w.b.search("payments", "withRetry", 10)).toHaveLength(1);
    // Nothing of the person is left in the partition (row, pointer, source mark), and a second call finds nothing.
    const left = (await w.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] !== "TEAM_RECORD_FENCE");
    expect(left.filter((item) => item["authorId"] === "ann")).toEqual([]);
    expect(left).toHaveLength(3);
    expect(await w.a.erasePerson(["payments"], "ann")).toBe(0);
    // What is left of the person is only the erase fence (a hash), which keeps their words from being written again.
  });
});

describe("capture of a finished task", () => {
  const span = (over: Partial<EvidenceSpan>): EvidenceSpan => ({ kind: "pr_comment", text: "x", trust: "member", ...over });
  function sourceWith(spans: EvidenceSpan[], sendBacks: string[] = []): TaskSubjectSource {
    return {
      async read(input) {
        if (input.workspaceId !== A) return undefined;
        return { facts: { workspaceId: A, project: "payments", taskId: input.taskId, repositories: ["demo"], outcome: "merged", task: { developerId: "ann" }, rest: { spans, links: ["https://github.com/example/demo/pull/7"] } } as never, sendBackRequestIds: sendBacks };
      },
    };
  }
  const rows = (facts: Record<string, Awaited<ReturnType<OutcomeRowReader["sendBack"]>>>): OutcomeRowReader => ({ async sendBack(input) { return facts[input.requestId]; }, async revertedBy() { return undefined; } });

  it("keeps only members' words: the request, a close reason, members' review comments and members' send-backs; never an outsider's, an agent's or an automatic send-back", async () => {
    const w = world();
    const source = sourceWith([
      span({ kind: "intent", text: "Add a /health endpoint", authorId: "ann" }),
      span({ kind: "plan", text: "The agent's plan", trust: "system" }),
      span({ kind: "review_finding", text: "An agent finding", trust: "system" }),
      span({ kind: "pr_comment", text: "Name the route healthz, like the others", authorId: "bob", eventId: "github:repo/1#pr7:review_comment1" }),
      span({ kind: "pr_comment", text: "Outsider spam about crypto", trust: "outsider", authorId: "github_stranger", eventId: "github:repo/1#pr7:review_comment2" }),
    ], ["r1", "r2", "r3"]);
    const result = await recordEndedTask({
      record: w.a, source, companyId: A, taskId: "task-7", now: () => w.clock.now, origin: "app",
      rows: rows({ r1: { id: "task:task-7:sendback:r1", origin: "human", actorDeveloperId: "bob", actorTrust: "member", reasonText: "Add a test for the 503 case" }, r2: { id: "task:task-7:sendback:r2", origin: "automatic" }, r3: { id: "task:task-7:sendback:r3", origin: "human", actorDeveloperId: "eve", actorTrust: "outsider", reasonText: "outsider reason" } }),
    });
    expect(result.written).toBe(3);
    const all = (await w.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] === "TEAM_RECORD_ROW");
    expect(all.map((item) => item["kind"]).sort()).toEqual(["decision", "review_feedback", "task"]);
    const text = JSON.stringify(all);
    for (const never of ["agent's plan", "agent finding", "crypto", "outsider reason"]) expect(text).not.toContain(never);
    // Heard again: nothing new.
    expect((await recordEndedTask({ record: w.a, source, companyId: A, taskId: "task-7", now: () => w.clock.now, rows: rows({}), origin: "app" })).written).toBe(0);
  });

  it("refuses to capture for another company than the record's", async () => {
    const w = world();
    await expect(recordEndedTask({ record: w.a, source: sourceWith([]), rows: rows({}), companyId: B, taskId: "t", now: () => w.clock.now, origin: "app" })).rejects.toBeInstanceOf(TeamRecordCompanyError);
  });
});

describe("the context sources' search", () => {
  it("answers only for a task of the company and project asked about", async () => {
    const w = world();
    await w.a.put(draft());
    const tasks: Record<string, { companyId: string; project: string }> = { "task-a": { companyId: A, project: "payments" }, "task-b": { companyId: B, project: "payments" }, "task-other": { companyId: A, project: "billing" } };
    const search = teamRecordSearchOver({ record: w.a, readTask: async (id) => tasks[id] });
    const ask = (orgId: string, task: string, project = "payments") => search.search({ orgId, projectId: project, query: "withRetry", asAgentForTask: task, limit: 5 });
    expect((await ask(A, "task-a")).map((hit) => hit.system)).toEqual(["team-record"]);
    expect(await ask(B, "task-b")).toEqual([]);
    expect(await ask(A, "task-b")).toEqual([]);
    expect(await ask(A, "task-other")).toEqual([]);
    expect(await ask(A, "task-missing")).toEqual([]);
  });
});

describe("review round 1", () => {
  const span = (over: Partial<EvidenceSpan>): EvidenceSpan => ({ kind: "pr_comment", text: "x", trust: "member", ...over });
  const source = (spans: EvidenceSpan[], links: string[] = []): TaskSubjectSource => ({ async read(input) { return { facts: { workspaceId: A, project: "payments", taskId: input.taskId, repositories: [], outcome: "merged", task: { developerId: "ann" }, rest: { spans, links } } as never, sendBackRequestIds: [] }; } });
  const noRows: OutcomeRowReader = { async sendBack() { return undefined; }, async revertedBy() { return undefined; } };

  it("a request that came from a ticket, an issue, a chat or an unknown way is not recorded as the task person's words; a typed one is", async () => {
    for (const origin of ["tracker", "linear", "jira", "github_issue", "slack", "schedule", "event", "chain", undefined]) {
      const w = world();
      const written = await recordEndedTask({ record: w.a, source: source([span({ kind: "intent", text: "Ticket body by someone else", authorId: "ann" })]), rows: noRows, companyId: A, taskId: "t1", now: () => w.clock.now, origin });
      expect(written.written, String(origin)).toBe(0);
    }
    for (const origin of ["app", "cli", "mcp"]) {
      const w = world();
      expect((await recordEndedTask({ record: w.a, source: source([span({ kind: "intent", text: "Typed request", authorId: "ann" })]), rows: noRows, companyId: A, taskId: "t1", now: () => w.clock.now, origin })).written, origin).toBe(1);
    }
  });

  it("an erase fences the person first: a capture that read them before the erase cannot write their words after it (also under the lessons' own person fence)", async () => {
    const w = world();
    await w.a.erasePerson(["payments"], "ann");
    expect(await w.a.put(draft())).toBe(false);
    expect(await w.a.put(draft({ authorId: "bob", sourceRef: "s-bob" }))).toBe(true);
    // The lessons' fence for a person (written by the lessons erase) stops the record too.
    const { createHash } = await import("node:crypto");
    await w.store.put({ item: { pk: teamRecordPk(A, "payments"), sk: `LESSONSET#FENCE#P#${createHash("sha256").update("cy").digest("hex")}`, entityType: "LESSON_FENCE" } });
    expect(await w.a.put(draft({ authorId: "Cy", sourceRef: "s-cy" }))).toBe(false);
  });

  it("rows expire after the keep time even on a store that names no expiry attribute, and every item of a write carries the same expiry", async () => {
    const clock = { now: T0 };
    const store = new MemoryDocumentStore({ indexes: [], nowSeconds: () => Math.floor(clock.now / 1000) });
    const record = createTeamRecord({ store, companyId: A, now: () => clock.now });
    await record.put(draft());
    const items = (await store.query({ pk: teamRecordPk(A, "payments") })).items;
    const expiries = new Set(items.map((item) => item["indexExpiresAt"]));
    expect(expiries.size).toBe(1);
    expect([...expiries][0]).toBe(Math.floor(T0 / 1000) + RECORD_KEEP_DAYS * 86_400);
    expect(await record.search("payments", "withRetry", 5)).toHaveLength(1);
    clock.now += (RECORD_KEEP_DAYS * 86_400 + 1) * 1000;
    expect(await record.search("payments", "withRetry", 5)).toEqual([]);
  });

  it("search reads past one store page, up to the window, newest first", async () => {
    const w = world();
    // The oldest row is the only match; 1,100 newer rows push it onto the second page.
    await w.a.put(draft({ text: "The zebra rule applies", sourceRef: "old", occurredAt: new Date(T0 - 10_000_000).toISOString() }));
    for (let i = 0; i < 1_100; i += 1) await w.a.put(draft({ text: `Filler row ${String(i)}`, sourceRef: `f${String(i)}`, occurredAt: new Date(T0 - i * 1000).toISOString() }));
    expect((await w.a.search("payments", "zebra", 5)).map((hit) => hit.row.sourceRef)).toEqual(["old"]);
    expect(RECORD_SEARCH_WINDOW).toBeGreaterThan(1_100);
  });

  it("erase removes the person's decisions and review feedback written by capture, and a comment links to its own pull request", async () => {
    const w = world();
    const links = ["https://github.com/example/demo/pull/7", "https://github.com/example/demo/pull/8"];
    await recordEndedTask({
      record: w.a, companyId: A, taskId: "t8", now: () => w.clock.now, origin: "app", rows: noRows,
      source: source([span({ kind: "close_reason", text: "Closing: wrong approach", authorId: "ann" }), span({ kind: "pr_comment", text: "Use the cache here", authorId: "ann", eventId: "github:repo/1#pr8:review_comment5" })], links),
    });
    const rows = (await w.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] === "TEAM_RECORD_ROW");
    expect(rows.map((item) => item["kind"]).sort()).toEqual(["decision", "review_feedback"]);
    expect(rows.find((item) => item["kind"] === "review_feedback")?.["url"]).toBe(links[1]);
    expect(await w.a.erasePerson(["payments"], "ann")).toBe(2);
    expect((await w.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] !== "TEAM_RECORD_FENCE")).toEqual([]);
  });

  it("a search narrowed to named sources that leave out the record gets nothing from it", async () => {
    const w = world();
    await w.a.put(draft());
    const search = teamRecordSearchOver({ record: w.a, readTask: async () => ({ companyId: A, project: "payments" }) });
    expect(await search.search({ orgId: A, projectId: "payments", query: "withRetry", asAgentForTask: "t", limit: 5, sources: ["src_slack"] })).toEqual([]);
    expect(await search.search({ orgId: A, projectId: "payments", query: "withRetry", asAgentForTask: "t", limit: 5, sources: ["team-record"] })).toHaveLength(1);
  });

  it("erase finds a person's rows whatever the case of the id they were written under", async () => {
    const w = world();
    await w.a.put(draft({ authorId: "Ann" }));
    expect(await w.a.erasePerson(["payments"], "ann")).toBe(1);
  });
});
