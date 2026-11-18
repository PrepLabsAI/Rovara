// The task log (design B1): entries are made safe once when they are written, keyed by what happened, written in the transaction of the change that caused them, and read back for the company that owns the task only.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, TASK_LOG_ENTRIES_MAX, TASK_LOG_TEXT_MAX, TaskLogEntrySchema, taskLogKey, type CodeMilestone, type OrgId, type TaskLogEntry } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import {
  answerEntriesOf, approvalEntryOf, appendTaskLog, cleanLogText, createTaskLogHooks, planSummaryEntryOf, pullRequestEntryOf, questionEntriesOf, readTaskLog, recordMilestoneInLog, statusEntryOf, surfaceOfMethod, taskLogItems,
  taskLogMilestoneHandler,
} from "../../../packages/broker/src/core/task-log/index.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const OTHER = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const AT = "2026-11-17T14:10:00.000Z";
const QUESTIONS = [{ id: "q1", text: "Cap value?", options: [{ id: "a", label: "20,000" }, { id: "b", label: "50,000" }] }];
const fakeToken = (): string => `${["gh", "p_"].join("")}${"A1b2".repeat(9)}`;

function store() {
  return new MemoryDocumentStore({ indexes: [] });
}

describe("what an entry is made of", () => {
  it("redacts credentials, makes control characters spaces, keeps one line, and cuts at the bound by characters", () => {
    const token = fakeToken();
    expect(cleanLogText(`use ${token} now\u0007\nthen\r\n  go`, 500)).toBe("use [REDACTED] now then go");
    expect(cleanLogText("x".repeat(600), TASK_LOG_TEXT_MAX)).toHaveLength(TASK_LOG_TEXT_MAX);
    expect(cleanLogText("é".repeat(600), 10)).toBe("é".repeat(10));
    expect(cleanLogText("​\u0007 ", 10)).toBe("");
  });

  it("makes a question entry per question, with its choices, and none for a question that says nothing", () => {
    const entries = questionEntriesOf({ round: 1, at: AT, questions: [...QUESTIONS, { id: "q2", text: "\u0007 ", options: undefined }] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "question", key: "question:r1:q1", questionId: "q1", round: 1, text: "Cap value?", choices: ["20,000", "50,000"] });
  });

  it("makes an answer entry that says who and where, from the option's words and what the person said", () => {
    const entries = answerEntriesOf({ round: 1, at: AT, by: "Ana Ruiz", surface: "slack", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a", text: "per campaign" }] });
    expect(entries).toEqual([{ key: "answer:r1:q1", at: AT, kind: "answer", questionId: "q1", round: 1, text: "20,000: per campaign", by: "Ana Ruiz", surface: "slack" }]);
    expect(answerEntriesOf({ round: 1, at: AT, by: "\u0007", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a" }] })).toEqual([]);
  });

  it("redacts an answer's secret and cuts its length to the log's bound", () => {
    const token = fakeToken();
    const [entry] = answerEntriesOf({ round: 1, at: AT, by: "Ana", surface: "web", questions: QUESTIONS, answers: [{ questionId: "q1", text: `${token} ${"y".repeat(900)}` }] });
    const text = (entry as { text: string }).text;
    expect(text).not.toContain(token);
    expect([...text].length).toBeLessThanOrEqual(TASK_LOG_TEXT_MAX);
  });

  it("keys an approval by the decision's request id and carries the first characters of the digest it was made on", () => {
    const digest = "ab".repeat(32);
    const entry = approvalEntryOf({ requestId: "r-1", at: AT, what: "plan", outcome: "approved", artifactDigest: digest, revision: 4, by: "Nick P.", surface: "web" })!;
    expect(entry).toMatchObject({ kind: "approval", what: "plan", outcome: "approved", code: "abababab", revision: 4, by: "Nick P.", surface: "web" });
    expect(approvalEntryOf({ requestId: "r-1", at: AT, what: "plan", outcome: "approved", artifactDigest: digest, by: "Nick P.", surface: "web" })!.key).toBe(entry.key);
    expect(approvalEntryOf({ requestId: "r-2", at: AT, what: "plan", outcome: "approved", artifactDigest: digest, by: "Nick P.", surface: "web" })!.key).not.toBe(entry.key);
    expect(approvalEntryOf({ requestId: "r-1", at: AT, what: "plan", outcome: "approved", artifactDigest: "not a digest", by: "Nick P.", surface: "web" })).not.toHaveProperty("code");
  });

  it("names the surface from the method a proof came through, and nothing from a body", () => {
    expect(surfaceOfMethod("chat-slack")).toBe("slack");
    expect(surfaceOfMethod("code-host-comment")).toBe("github");
    expect(surfaceOfMethod("local-session")).toBe("web");
    expect(surfaceOfMethod(undefined)).toBe("web");
  });

  it("keeps a plan's summary to the card's bounds and drops one that says nothing", () => {
    const entry = planSummaryEntryOf({ revision: 2, at: AT, needed: "Add a cap", lines: ["one", "two", "three", "four", "five", "six"], risk: "medium", estimate: "$4 to $10" })!;
    expect(entry).toMatchObject({ kind: "plan_summary", key: "plan:r2", revision: 2, risk: "medium", estimate: "$4 to $10" });
    expect((entry as { lines: string[] }).lines).toHaveLength(5);
    expect(planSummaryEntryOf({ revision: 2, at: AT, needed: " ", lines: ["a"], risk: "low" })).toBeUndefined();
    expect(planSummaryEntryOf({ revision: 2, at: AT, needed: "x", lines: [], risk: "low" })).toBeUndefined();
    // An unknown risk is read as the highest, never as low.
    expect(planSummaryEntryOf({ revision: 2, at: AT, needed: "x", lines: ["a"], risk: "whatever" })).toMatchObject({ risk: "high" });
  });

  it("keeps only plain https links for the pull request and a status entry for each moment, once per set", () => {
    const base = { at: AT, pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }, { repository: "demo", number: 8, url: "http://insecure.example/8" }, { repository: "demo", number: 9, url: "https://user:pw@host.example/9" }] };
    expect(pullRequestEntryOf(base)).toMatchObject({ kind: "pr", urls: ["https://github.com/example/demo/pull/7"] });
    expect(pullRequestEntryOf({ at: AT, pullRequests: [{ repository: "demo", number: 8, url: "http://insecure.example/8" }] })).toBeUndefined();
    expect(statusEntryOf({ kind: "started", at: AT })).toMatchObject({ key: "status:started", moment: "started" });
    expect(statusEntryOf({ kind: "pr_ready", at: AT, pullRequests: base.pullRequests })!.key).toMatch(/^status:pr_opened#[0-9a-f]{12}$/u);
    expect(statusEntryOf({ kind: "questions", at: AT })).toBeUndefined();
    for (const entry of [statusEntryOf({ kind: "plan_ready", at: AT })!, planSummaryEntryOf({ revision: 1, at: AT, needed: "n", lines: ["l"], risk: "low" })!]) expect(TaskLogEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe("the log's rows", () => {
  const entries = (): TaskLogEntry[] => [
    ...answerEntriesOf({ round: 1, at: "2026-11-17T14:11:00.000Z", by: "Ana Ruiz", surface: "slack", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a" }] }),
    ...questionEntriesOf({ round: 1, at: AT, questions: QUESTIONS }),
    statusEntryOf({ kind: "started", at: "2026-11-17T14:00:00.000Z" })!,
  ];

  it("reads back oldest first, and an entry written again (the same event) is the same row", async () => {
    const s = store();
    expect(await appendTaskLog(s, { orgId: COMPANY, taskId: TASK, entries: entries() })).toBe(3);
    expect(await appendTaskLog(s, { orgId: COMPANY, taskId: TASK, entries: entries() })).toBe(0);
    const read = await readTaskLog(s, COMPANY, TASK);
    expect(read.map((entry) => entry.key)).toEqual(["status:started", "question:r1:q1", "answer:r1:q1"]);
    expect((await s.query({ pk: `DEVTASK#${TASK}` })).items).toHaveLength(3);
  });

  it("is written in the transaction of the change: the items go with it, and a repeat does not make the change fail", async () => {
    const s = store();
    const items = taskLogItems({ orgId: COMPANY, taskId: TASK, entries: entries() });
    expect((await s.transact(items)).applied).toBe(true);
    expect((await s.transact(items)).applied).toBe(true);
    expect(await readTaskLog(s, COMPANY, TASK)).toHaveLength(3);
  });

  it("reads one company's log for that company only (two companies, the same store)", async () => {
    const s = store();
    await appendTaskLog(s, { orgId: COMPANY, taskId: TASK, entries: entries() });
    await appendTaskLog(s, { orgId: OTHER, taskId: OTHER_TASK, entries: [statusEntryOf({ kind: "closed", at: AT })!] });
    expect(await readTaskLog(s, OTHER, TASK)).toEqual([]);
    expect(await readTaskLog(s, COMPANY, OTHER_TASK)).toEqual([]);
    expect((await readTaskLog(s, OTHER, OTHER_TASK)).map((entry) => entry.key)).toEqual(["status:closed"]);
    // A row in the task's partition that names another company is not read, even where the partition is the right one.
    const forged = (await s.get(taskLogKey(TASK, "status:started")))!;
    await s.put({ item: { ...forged, orgId: OTHER } });
    expect((await readTaskLog(s, COMPANY, TASK)).map((entry) => entry.key)).not.toContain("status:started");
  });

  it("does not read a row that no longer parses, or whose key is not the entry's", async () => {
    const s = store();
    await appendTaskLog(s, { orgId: COMPANY, taskId: TASK, entries: entries() });
    await s.put({ item: { pk: `DEVTASK#${TASK}`, sk: "TASKLOG#status:closed", entityType: "TASK_LOG", orgId: COMPANY, taskId: TASK, entry: { kind: "status", key: "status:closed", at: "x", moment: "closed" } } });
    await s.put({ item: { pk: `DEVTASK#${TASK}`, sk: "TASKLOG#status:merged", entityType: "TASK_LOG", orgId: COMPANY, taskId: TASK, entry: JSON.parse(JSON.stringify({ ...statusEntryOf({ kind: "merged", at: AT })!, key: "status:other" })) as never } });
    expect((await readTaskLog(s, COMPANY, TASK)).map((entry) => entry.key)).toEqual(["status:started", "question:r1:q1", "answer:r1:q1"]);
  });

  it("holds the schema's bounds: a text over the bound, a control character, an unknown kind and an unknown field are refused", () => {
    const good = { key: "answer:r1:q1", at: AT, kind: "answer", questionId: "q1", round: 1, text: "x", by: "Ana", surface: "web" };
    expect(TaskLogEntrySchema.safeParse(good).success).toBe(true);
    expect(TaskLogEntrySchema.safeParse({ ...good, text: "x".repeat(TASK_LOG_TEXT_MAX + 1) }).success).toBe(false);
    expect(TaskLogEntrySchema.safeParse({ ...good, text: "a\u0007b" }).success).toBe(false);
    expect(TaskLogEntrySchema.safeParse({ ...good, kind: "diff" }).success).toBe(false);
    expect(TaskLogEntrySchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(TaskLogEntrySchema.safeParse({ ...good, surface: "fax" }).success).toBe(false);
    expect(() => taskLogKey("not-a-uuid", "status:started")).toThrow();
  });

  it("holds at most the bound a reader reads", async () => {
    const s = store();
    const many = Array.from({ length: TASK_LOG_ENTRIES_MAX + 20 }, (_, n) => TaskLogEntrySchema.parse({ key: `status:n${String(n)}`, at: new Date(Date.parse(AT) + n * 1000).toISOString(), kind: "status", moment: "started" }));
    await appendTaskLog(s, { orgId: COMPANY, taskId: TASK, entries: many });
    expect(await readTaskLog(s, COMPANY, TASK)).toHaveLength(TASK_LOG_ENTRIES_MAX);
  });
});

describe("what the milestone hook adds", () => {
  const milestone = (over: Partial<CodeMilestone> = {}): CodeMilestone => ({ kind: "pr_ready", orgId: COMPANY, taskId: TASK, at: AT, text: "ready", pullRequests: [{ repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" }], ...over });
  async function withTask(orgId: OrgId = COMPANY) {
    const s = store();
    await s.put({ item: { ...taskKey(TASK), orgId, companyId: orgId, project: "payments", title: "T" } });
    return s;
  }

  it("writes a status entry, the pull request and (when the plan waits) its summary, once", async () => {
    const s = await withTask();
    const handler = taskLogMilestoneHandler({ store: s, planSummaryOf: async () => ({ revision: 3, needed: "Add a cap", lines: ["a"], risk: "low", estimate: "$1 to $2" }) });
    await handler.on(milestone());
    await handler.on(milestone());
    await handler.on(milestone({ kind: "plan_ready" }));
    const keys = (await readTaskLog(s, COMPANY, TASK)).map((entry) => entry.key);
    expect(keys).toContain("pr:" + keys.find((key) => key.startsWith("pr:"))!.slice(3));
    expect(keys.filter((key) => key.startsWith("status:pr_opened"))).toHaveLength(1);
    expect(keys).toContain("plan:r3");
  });

  it("writes nothing for a milestone of another company's task, and nothing for a task that is not there", async () => {
    const s = await withTask(OTHER);
    expect(await recordMilestoneInLog({ store: s }, milestone())).toEqual([]);
    expect(await readTaskLog(s, COMPANY, TASK)).toEqual([]);
    expect(await readTaskLog(s, OTHER, TASK)).toEqual([]);
    const empty = store();
    expect(await recordMilestoneInLog({ store: empty }, milestone())).toEqual([]);
  });

  it("keeps the log when the plan summary cannot be read: a failure there never stops the status entry", async () => {
    const s = await withTask();
    const events: string[] = [];
    await recordMilestoneInLog({ store: s, planSummaryOf: async () => { throw new Error("boom"); }, log: (event) => events.push(event) }, milestone({ kind: "plan_ready" }));
    expect((await readTaskLog(s, COMPANY, TASK)).map((entry) => entry.kind)).toEqual(["status"]);
    expect(events).toEqual(["task_log.plan_summary_failed"]);
  });

  it("ignores the milestones the log does not keep", async () => {
    const s = await withTask();
    expect(await recordMilestoneInLog({ store: s }, milestone({ kind: "review_nudge" }))).toEqual([]);
  });
});

describe("the log's hook", () => {
  it("tells each surface once, and a surface that throws neither stops the others nor fails the change", async () => {
    const seen: string[] = [];
    const logged: string[] = [];
    const hooks = createTaskLogHooks((event) => logged.push(event));
    hooks.subscribe(async () => { throw new Error("boom"); });
    const off = hooks.subscribe(async (taskId) => { seen.push(taskId); });
    await hooks.changed(TASK);
    expect(seen).toEqual([TASK]);
    expect(logged).toEqual(["task_log.subscriber_failed"]);
    off();
    await hooks.changed(TASK);
    expect(seen).toEqual([TASK]);
  });
});
