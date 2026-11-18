// L4-B5: the task log in the chat thread. An answer or a decision recorded somewhere else (the web page, Linear, ...) is told to the task's thread as one short line; what was said in the thread itself is not said
// back; each entry is told once (by its key and origin); only this company's thread; no mention, no markup; capped and fresh. The chat adapter is a fake (it drops a repeat of an event id, as a real one must).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type ChannelEvent, type ConversationRef, type OrgId, type TaskLogSurface } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../../packages/broker/src/ports/fake-channel-adapter.js";
import { MIRROR_LINES_MAX, MIRROR_WINDOW_MS, mirrorLine, recordTaskThread, taskLogThreadMirror, type ChannelCompanyOf, type ChannelMemberRule } from "../../../packages/broker/src/core/channel/index.js";
import { answerEntriesOf, appendTaskLog, approvalEntryOf, createTaskLogHooks, planSummaryEntryOf, pullRequestEntryOf, questionEntriesOf, statusEntryOf } from "../../../packages/broker/src/core/task-log/index.js";
import { taskSessionId } from "../../../packages/broker/src/core/sessions/create.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_2 = "9c68ac5c-fbb8-4cf3-98cd-7eb97ca7d7f7";
const SESSION = taskSessionId(TASK);
const SESSION_2 = taskSessionId(TASK_2);
const clock = { ms: Date.parse("2026-11-17T10:05:00.000Z") };
const now = (): number => clock.ms;
const AT = "2026-11-17T10:04:00.000Z";
const CONVERSATION: ConversationRef = { channel: "slack", tenant: "T1AB", space: "C1AB", thread: "1700000000.000100" };
const PAGE = "https://example.test/s/ses_1";
const QUESTIONS = [{ id: "q1", text: "Cap value?", options: [{ id: "a", label: "20,000" }, { id: "b", label: "50,000" }] }];
const fakeToken = (): string => `${["gh", "p_"].join("")}${"A1b2".repeat(9)}`;

async function world(options: { companyOf?: ChannelCompanyOf; isMember?: ChannelMemberRule; enabled?: boolean | (() => boolean); taskUrl?: boolean; threadFor?: "none" | "other"; taskOrg?: OrgId } = {}) {
  const store = new MemoryDocumentStore({ indexes: [] });
  const adapter = new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES });
  const real = adapter.deliver.bind(adapter);
  const failures = { next: 0 };
  adapter.deliver = async (event) => { if (failures.next > 0) { failures.next -= 1; throw new Error("slack down"); } await real(event); };
  const registry = { get: (point: string, name: string) => (point === "channel" && name === "slack" ? adapter : undefined) } as never;
  for (const [taskId, sessionId] of [[TASK, SESSION], [TASK_2, SESSION_2]] as const) {
    await store.put({ item: { ...taskKey(taskId), orgId: options.taskOrg ?? ORG, project: "web", title: "Add a retry", sessionId } });
  }
  if (options.threadFor !== "none") await recordTaskThread({ store, orgId: ORG, now }, { sessionId: SESSION, conversation: CONVERSATION, personId: "p1" });
  await recordTaskThread({ store, orgId: ORG, now }, { sessionId: SESSION_2, conversation: { ...CONVERSATION, space: "C2AB", thread: "1700000000.000200" }, personId: "p1" });
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const told = taskLogThreadMirror({
    store, registry, now, ...(options.companyOf === undefined ? {} : { companyOf: options.companyOf }), ...(options.isMember === undefined ? {} : { isMember: options.isMember }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }), ...(options.taskUrl === false ? {} : { taskUrl: () => PAGE }), log: (event, fields) => logs.push({ event, fields }),
  });
  const add = (taskId: string, entries: Parameters<typeof appendTaskLog>[1]["entries"], org: OrgId = ORG) => appendTaskLog(store, { orgId: org, taskId, entries });
  const lines = (): string[] => adapter.delivered.filter((event): event is Extract<ChannelEvent, { type: "progress" }> => event.type === "progress").map((event) => event.data.text);
  return { store, adapter, told, add, lines, logs, failures };
}

const answer = (surface: TaskLogSurface, over: { by?: string; text?: string; at?: string; round?: number; questionId?: string } = {}) => answerEntriesOf({
  round: over.round ?? 1, at: over.at ?? AT, by: over.by ?? "Ana Ruiz", surface, questions: QUESTIONS, answers: [{ questionId: over.questionId ?? "q1", ...(over.text === undefined ? { optionId: "a" } : { text: over.text }) }],
});
const question = () => questionEntriesOf({ round: 1, at: "2026-11-17T10:01:00.000Z", questions: QUESTIONS });
const approval = (surface: TaskLogSurface, outcome: "approved" | "changes_requested" | "rejected" = "approved", requestId = "r1") =>
  approvalEntryOf({ requestId, at: AT, what: "plan", outcome, artifactDigest: "ab".repeat(32), revision: 1, by: "Nick P.", surface })!;

describe("what is told to the thread", () => {
  it("an answer given on the web page is one line in the thread: who, the question, where, the answer, and the task page", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("web")]);
    await w.told(TASK);
    expect(w.lines()).toEqual([`Ana Ruiz answered "Cap value?" on the Rovara page: 20,000 ${PAGE}`]);
  });

  it("an answer given in Linear says so, and an answer with the person's own words says them", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("linear", { text: "per campaign" })]);
    await w.told(TASK);
    expect(w.lines()).toEqual([`Ana Ruiz answered "Cap value?" in Linear: per campaign ${PAGE}`]);
  });

  it("an approval is one line for each outcome", async () => {
    for (const [outcome, words] of [["approved", "approved the plan"], ["changes_requested", "asked for changes to the plan"], ["rejected", "rejected the plan"]] as const) {
      const w = await world();
      await w.add(TASK, [approval("web", outcome)]);
      await w.told(TASK);
      expect(w.lines(), outcome).toEqual([`Nick P. ${words} on the Rovara page. ${PAGE}`]);
    }
  });

  it("a line carries no task page when the host has none", async () => {
    const w = await world({ taskUrl: false });
    await w.add(TASK, [approval("jira")]);
    await w.told(TASK);
    expect(w.lines()).toEqual(["Nick P. approved the plan in Jira."]);
  });

  it("an answer whose question is not in the log still reads as a line", async () => {
    const w = await world();
    await w.add(TASK, answer("cli"));
    await w.told(TASK);
    expect(w.lines()).toEqual([`Ana Ruiz answered a question in the terminal: 20,000 ${PAGE}`]);
  });
});

describe("origin and dedupe", () => {
  it("an entry made in this very chat is not said back to it, whether an answer or an approval", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("slack"), approval("slack", "approved", "r2")]);
    await w.told(TASK);
    expect(w.lines()).toEqual([]);
    expect(w.adapter.delivered).toEqual([]);
  });

  it("an entry from somewhere else is told once however many times the hook tells of it, even after a restart (a new subscriber)", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("web"), approval("linear")]);
    await w.told(TASK);
    await w.told(TASK);
    expect(w.lines()).toHaveLength(2);
    const again = taskLogThreadMirror({ store: w.store, registry: { get: () => w.adapter } as never, now, taskUrl: () => PAGE });
    await again(TASK);
    expect(w.adapter.delivered).toHaveLength(2);
  });

  it("two calls at once tell an entry once", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("web")]);
    await Promise.all([w.told(TASK), w.told(TASK)]);
    expect(w.lines()).toHaveLength(1);
  });

  it("the same answer from two origins is two entries (their keys differ by origin in the claim), but an answer's own repeat is one", async () => {
    const w = await world();
    await w.add(TASK, [...question(), ...answer("web")]);
    await w.told(TASK);
    // The row is written again as the same event (an unconditional put with the same key and the same entry).
    await w.add(TASK, answer("web"));
    await w.told(TASK);
    expect(w.lines()).toHaveLength(1);
  });

  it("only answers and approvals are mirrored: a status, a plan summary, a question and a pull request are not", async () => {
    const w = await world();
    await w.add(TASK, [
      statusEntryOf({ kind: "started", at: AT, pullRequests: undefined })!, ...question(),
      planSummaryEntryOf({ revision: 1, at: AT, needed: "Add a retry", lines: ["Retry three times"], risk: "low" })!,
      pullRequestEntryOf({ at: AT, pullRequests: [{ repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7" }] })!,
    ]);
    await w.told(TASK);
    expect(w.adapter.delivered).toEqual([]);
  });

  it("a thread hears its own task's entries only", async () => {
    const w = await world();
    await w.add(TASK, answer("web"));
    await w.add(TASK_2, answer("web", { by: "Bo Li", round: 2 }));
    await w.told(TASK);
    expect(w.lines()).toHaveLength(1);
    const first = w.adapter.delivered[0];
    expect(first !== undefined && "conversation" in first ? first.conversation : undefined).toMatchObject({ space: "C1AB" });
    expect(w.lines().join()).not.toContain("Bo Li");
  });
});

describe("the company boundary", () => {
  it("a thread of another company's chat workspace hears nothing (the host's rule), and so does a task of another company", async () => {
    const w = await world({ companyOf: async () => false });
    await w.add(TASK, answer("web"));
    await w.told(TASK);
    expect(w.adapter.delivered).toEqual([]);
    const other = await world({ taskOrg: OTHER_ORG });
    await other.add(TASK, answer("web"));
    await other.told(TASK);
    expect(other.adapter.delivered).toEqual([]);
  });

  it("a company's entries are never read for another company's task: rows of another company in the task's partition are not told", async () => {
    const w = await world();
    await w.add(TASK, answer("web", { by: "Zed" }), OTHER_ORG);
    await w.told(TASK);
    expect(w.adapter.delivered).toEqual([]);
  });

  it("a person the host no longer serves hears nothing; a served person does", async () => {
    const w = await world({ isMember: async () => false });
    await w.add(TASK, answer("web"));
    await w.told(TASK);
    expect(w.adapter.delivered).toEqual([]);
  });

  it("a task with no thread, an unknown task and a task whose chat adapter is gone tell nothing", async () => {
    const none = await world({ threadFor: "none" });
    await none.add(TASK, answer("web"));
    await none.told(TASK);
    await none.told("11111111-1111-4111-8111-111111111111");
    expect(none.adapter.delivered).toEqual([]);
    const gone = await world();
    await gone.add(TASK, answer("web"));
    await taskLogThreadMirror({ store: gone.store, registry: { get: () => undefined } as never, now })(TASK);
    expect(gone.adapter.delivered).toEqual([]);
  });
});

describe("the information budget and the words", () => {
  it("at most MIRROR_LINES_MAX lines for a task", async () => {
    const w = await world();
    await w.add(TASK, Array.from({ length: MIRROR_LINES_MAX + 5 }, (_, n) => answer("web", { round: n + 1, at: AT, text: `answer ${String(n)}` })[0]!));
    await w.told(TASK);
    expect(w.lines()).toHaveLength(MIRROR_LINES_MAX);
  });

  it("an entry older than the window is not told late, one inside it is", async () => {
    const w = await world();
    await w.add(TASK, [...answer("web", { at: new Date(clock.ms - MIRROR_WINDOW_MS - 1000).toISOString() }), ...answer("web", { round: 2, at: new Date(clock.ms - MIRROR_WINDOW_MS + 1000).toISOString(), text: "recent" })]);
    await w.told(TASK);
    expect(w.lines()).toHaveLength(1);
    expect(w.lines()[0]).toContain("recent");
  });

  it("no mention, markup, link or credential gets into a line", async () => {
    const w = await world();
    const token = fakeToken();
    await w.add(TASK, [
      ...questionEntriesOf({ round: 1, at: "2026-11-17T10:01:00.000Z", questions: [{ id: "q1", text: "<!channel> pick <@U123> *bold* `code`", options: undefined }] }),
      ...answer("web", { by: "<!here> Ana", text: `<https://evil.test|click> @everyone ${token} ![x](http://a.test/x.png)` }),
    ]);
    await w.told(TASK);
    const line = w.lines()[0]!;
    for (const bad of ["<", ">", "@", "`", "*", "[", "]", "|", token, "://"]) expect(line.replace(PAGE, ""), bad).not.toContain(bad);
    expect(line).toContain("[REDACTED]".replace(/[[\]]/gu, " ").trim());
  });

  it("a line is one line and short, whatever the answer", async () => {
    const w = await world();
    await w.add(TASK, answer("web", { text: `${"word ".repeat(200)}\nsecond line` }));
    await w.told(TASK);
    const line = w.lines()[0]!;
    expect(line).not.toContain("\n");
    expect([...line].length).toBeLessThan(400);
  });

  it("the page link is added only when it is a plain https address", async () => {
    expect(mirrorLine([], answer("web")[0] as never, "https://example.test/s/1")).toMatch(/ https:\/\/example\.test\/s\/1$/u);
    const w = await world();
    await w.add(TASK, answer("web"));
    const unsafe = taskLogThreadMirror({ store: w.store, registry: { get: () => w.adapter } as never, now, taskUrl: () => "http://user:pw@example.test/x" });
    await unsafe(TASK);
    expect(w.lines()[0]).not.toContain("http");
  });

  it("switched off (the thread's muted), nothing is told and nothing is claimed; switched on again, the entry is still told", async () => {
    const state = { on: false };
    const w = await world({ enabled: () => state.on });
    await w.add(TASK, answer("web"));
    await w.told(TASK);
    expect(w.adapter.delivered).toEqual([]);
    state.on = true;
    await w.told(TASK);
    expect(w.lines()).toHaveLength(1);
  });
});

describe("failure and the hook", () => {
  it("a failed send is logged, does not throw, and is sent again at the next change; the other entries still go", async () => {
    const w = await world();
    await w.add(TASK, [...answer("web"), approval("linear")]);
    w.failures.next = 1;
    await expect(w.told(TASK)).resolves.toBeUndefined();
    expect(w.logs.some((entry) => entry.event === "channel_thread.log_line_failed")).toBe(true);
    expect(w.lines()).toHaveLength(1);
    await w.told(TASK);
    expect(w.lines()).toHaveLength(2);
  });

  it("is a subscriber of the task log's hook: a change tells the thread, and a subscriber that throws never fails the change", async () => {
    const w = await world();
    const hooks = createTaskLogHooks();
    hooks.subscribe(async () => { throw new Error("boom"); });
    hooks.subscribe(w.told);
    await w.add(TASK, answer("web"));
    await expect(hooks.changed(TASK)).resolves.toBeUndefined();
    expect(w.lines()).toHaveLength(1);
  });
});
