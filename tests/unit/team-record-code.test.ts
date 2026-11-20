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

  it("a kind of evidence a person stopped on Where Rovara learns from is not read or kept (L4-LP3Wc): no comment, no close reason, no send-back row; the rest is recorded as before", async () => {
    const w = world();
    const seen: string[][] = [];
    const inner = sourceWith([
      span({ kind: "intent", text: "Add a /health endpoint", authorId: "ann" }),
      span({ kind: "close_reason", text: "STOPPED-WORDS closing it", authorId: "ann" }),
      span({ kind: "pr_comment", text: "STOPPED-WORDS name the route healthz", authorId: "bob", eventId: "github:repo/1#pr7:review_comment1" }),
    ], ["r1"]);
    const source: TaskSubjectSource = { projectOf: async () => "payments", read: async (input) => { seen.push([...(input.skip ?? [])].sort()); return inner.read(input); } };
    const stopped = new Set(["pr_comment", "review_finding", "send_back", "close_reason"] as const);
    let rowsRead = 0;
    const counting: OutcomeRowReader = { async sendBack() { rowsRead += 1; return { id: "task:task-7:sendback:r1", origin: "human", actorDeveloperId: "bob", actorTrust: "member", reasonText: "STOPPED-WORDS add a test" }; }, async revertedBy() { return undefined; } };
    const result = await recordEndedTask({ record: w.a, source, rows: counting, companyId: A, taskId: "task-7", now: () => w.clock.now, origin: "app", paused: async () => stopped, projectOf: async () => "payments" });
    expect(result.written).toBe(1);
    expect(rowsRead).toBe(0);
    expect(seen).toEqual([["close_reason", "pr_comment", "review_finding", "send_back"]]);
    expect(JSON.stringify((await w.store.query({ pk: teamRecordPk(A, "payments") })).items)).not.toContain("STOPPED-WORDS");
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

});
