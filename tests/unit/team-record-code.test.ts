// The Team record in Code (DEC 226), first slice: rows of decisions, review feedback and tasks per project, company-scoped keys, keyword search with no infrastructure, only members' words, one row per
// source, and the person erase. The context sources' search answers only for a task of the company and project asked about.
import { describe, expect, it } from "vitest";
import { teamRecordPk, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createTeamRecord, RECORD_KEEP_DAYS, TeamRecordCompanyError } from "../../packages/broker/src/team-record/record.js";
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
    const left = (await w.store.query({ pk: teamRecordPk(A, "payments") })).items;
    expect(left.filter((item) => item["authorId"] === "ann")).toEqual([]);
    expect(left).toHaveLength(3);
    expect(await w.a.erasePerson(["payments"], "ann")).toBe(0);
    // Once erased, the same source can be written again only by a new task end of a person who is not erased (the capture's rule); the record itself holds no mark of the person.
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
      record: w.a, source, companyId: A, taskId: "task-7", now: () => w.clock.now,
      rows: rows({ r1: { id: "task:task-7:sendback:r1", origin: "human", actorDeveloperId: "bob", actorTrust: "member", reasonText: "Add a test for the 503 case" }, r2: { id: "task:task-7:sendback:r2", origin: "automatic" }, r3: { id: "task:task-7:sendback:r3", origin: "human", actorDeveloperId: "eve", actorTrust: "outsider", reasonText: "outsider reason" } }),
    });
    expect(result.written).toBe(3);
    const all = (await w.store.query({ pk: teamRecordPk(A, "payments") })).items.filter((item) => item["entityType"] === "TEAM_RECORD_ROW");
    expect(all.map((item) => item["kind"]).sort()).toEqual(["decision", "review_feedback", "task"]);
    const text = JSON.stringify(all);
    for (const never of ["agent's plan", "agent finding", "crypto", "outsider reason"]) expect(text).not.toContain(never);
    // Heard again: nothing new.
    expect((await recordEndedTask({ record: w.a, source, companyId: A, taskId: "task-7", now: () => w.clock.now, rows: rows({}) })).written).toBe(0);
  });

  it("refuses to capture for another company than the record's", async () => {
    const w = world();
    await expect(recordEndedTask({ record: w.a, source: sourceWith([]), rows: rows({}), companyId: B, taskId: "t", now: () => w.clock.now })).rejects.toBeInstanceOf(TeamRecordCompanyError);
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
