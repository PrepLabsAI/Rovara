import { describe, expect, it, vi } from "vitest";
import {
  SlackWorkflowStartError,
  WorkflowChoiceWaitingError,
  createDynamoWorkflowChoiceStore,
  handOffChosenWorkflow,
  isHandedOffWorkflowStart,
  offerWorkflowChoice,
  runHandedOffWorkflowStart,
  type HandedOffWorkflowStart,
  parseWorkflowPathReply,
  parseWorkflowStartRequest,
  startChosenWorkflow,
  workflowChoiceMessage,
  workflowChoiceRefusal,
  workflowStartFailureNotice,
  workflowStartedNotice,
} from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { StrictSlackWeb, visibleSlackText } from "../support/strict-slack.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const requester = "U0123456789";
const other = "U0OTHER0001";
/** Words user-facing copy never uses (global constraints). */
const JARGON = /candidate|revision|digest|operation|artifact|workflow|SUCCEEDED|FAILED|invalid json/i;

describe("starting a task from Slack", () => {
  it("reads loose Quick or Full answers and nothing else", () => {
    for (const [text, path] of [["quick", "QUICK"], ["Quick please", "QUICK"], ["FULL!", "FULL"], ["let's do full", "FULL"], ["full mode", "FULL"], ["let’s go quick.", "QUICK"]] as const) expect(parseWorkflowPathReply(text)).toBe(path);
    for (const text of ["quickly fix the login bug", "full stack rewrite please", "not quick", "quick: fix the typo", ""]) expect(parseWorkflowPathReply(text)).toBeUndefined();
  });

  it("starts a task from a plain request, and keeps the chat agent reachable with chat:", () => {
    expect(parseWorkflowStartRequest("Add password reset")).toEqual({ kind: "start", instructions: "Add password reset" });
    expect(parseWorkflowStartRequest("chat: what does retry.ts do?")).toEqual({ kind: "chat", text: "what does retry.ts do?" });
    expect(parseWorkflowStartRequest("Chat:what does retry.ts do?")).toEqual({ kind: "chat", text: "what does retry.ts do?" });
    expect(parseWorkflowStartRequest("quick: fix the typo")).toEqual({ kind: "start", path: "QUICK", instructions: "fix the typo" });
    expect(parseWorkflowStartRequest("FULL: add SSO")).toEqual({ kind: "start", path: "FULL", instructions: "add SSO" });
    expect(parseWorkflowStartRequest("workflow full: add SSO")).toEqual({ kind: "start", path: "FULL", instructions: "add SSO" });
    expect(parseWorkflowStartRequest("workflow quick: add SSO")).toEqual({ kind: "start", path: "QUICK", instructions: "add SSO" });
    expect(parseWorkflowStartRequest("workflow: add SSO")).toEqual({ kind: "start", instructions: "add SSO" });
    expect(parseWorkflowStartRequest("quickly fix the login bug")).toEqual({ kind: "start", instructions: "quickly fix the login bug" });
  });

  it("explains both paths briefly with buttons Slack accepts", () => {
    const message = workflowChoiceMessage({ choiceId: "11111111-1111-4111-8111-111111111111", requesterId: "U0123456789" });
    expect(message.text).toMatch(/Quick[\s\S]*coding plan[\s\S]*Full[\s\S]*requirements[\s\S]*design/);
    expect(message.text).not.toMatch(JARGON);
    expect(JSON.stringify(message.blocks)).toContain("agentx_workflow_path_quick");
    expect(JSON.stringify(message.blocks)).toContain("agentx_workflow_path_full");
    expect(JSON.stringify(message.blocks)).toContain("11111111-1111-4111-8111-111111111111");
    new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message });
  });

  it("gives a plain failure notice with a reference instead of syntax help", () => {
    const notice = workflowStartFailureNotice("UNKNOWN", "Ev0000000042");
    expect(notice).toContain("Ev0000000042");
    expect(notice).not.toContain("workflow:");
    expect(workflowStartFailureNotice("WORKSPACE_LIMIT", "Ev1")).toBe("You've reached your open-task limit. Close a finished AgentX task, then try again.");
    expect(workflowStartFailureNotice("WORKSPACE_BUSY", "Ev1")).toBe("This thread already has a task. Start a new request in the channel.");
    for (const code of ["FORBIDDEN", "CHANNEL_REQUIRED"]) {
      expect(workflowStartFailureNotice(code, "Ev1")).toBe("This channel isn't connected to an AgentX project you can use. Ask an AgentX admin to check the channel.");
    }
    for (const code of ["UNKNOWN", "WORKSPACE_LIMIT", "WORKSPACE_BUSY", "FORBIDDEN", "PROJECT_TASKS_DISABLED"]) {
      expect(workflowStartFailureNotice(code, "Ev0000000042")).not.toMatch(JARGON);
      // One apostrophe style throughout.
      expect(workflowStartFailureNotice(code, "Ev0000000042")).not.toContain("’");
    }
    for (const outcome of ["none", "not_requester", "other_path", "starting"] as const) expect(workflowChoiceRefusal(outcome)).not.toMatch(JARGON);
  });

  it("confirms the start in one plain line", () => {
    for (const path of ["QUICK", "FULL"] as const) {
      const notice = workflowStartedNotice(path);
      expect(notice).not.toMatch(JARGON);
      expect(notice).not.toContain("\n");
      expect(visibleSlackText(notice).length).toBeLessThanOrEqual(1_200);
    }
  });
});

describe("the pending Quick or Full choice", () => {
  const store = (db: FakeDynamoDb, now = { ms: 1_758_657_600_000 }) => createDynamoWorkflowChoiceStore({ documentClient: db, tableName: "threads", now: () => now.ms });

  it("keeps the request for its requester, and starts it once with the chosen path", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    expect(await choices.pending(thread)).toEqual({ choiceId, userId: requester });
    expect(await choices.choose({ thread, userId: other, workflowPath: "QUICK", choiceId })).toBe("not_requester");
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK", choiceId: "22222222-2222-4222-8222-222222222222" })).toBe("none");
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK", choiceId })).toEqual({ choiceId, instructions: "Add password reset", requestId: choiceId });
    // While it starts, a second answer starts nothing; once a path is chosen, the other is no longer on offer.
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK" })).toBe("starting");
    expect(await choices.choose({ thread, userId: requester, workflowPath: "FULL" })).toBe("other_path");
    await choices.release(thread, choiceId);
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK" })).toEqual({ choiceId, instructions: "Add password reset", requestId: choiceId });
    await choices.complete(thread, "QUICK");
    expect(await choices.pending(thread)).toBeUndefined();
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK" })).toBe("none");
  });

  it("refuses a second request in the same thread, and forgets an expired one", async () => {
    const db = new FakeDynamoDb();
    const now = { ms: 1_758_657_600_000 };
    const choices = store(db, now);
    await choices.save({ thread, userId: requester, instructions: "first" });
    await expect(choices.save({ thread, userId: requester, instructions: "second" })).rejects.toThrow(WorkflowChoiceWaitingError);
    now.ms += 25 * 60 * 60 * 1_000;
    expect(await choices.pending(thread)).toBeUndefined();
    expect(await choices.choose({ thread, userId: requester, workflowPath: "QUICK" })).toBe("none");
    await choices.save({ thread, userId: requester, instructions: "third" });
    expect(await choices.pending(thread)).toEqual(expect.objectContaining({ userId: requester }));
  });

  it("starts the chosen path through the broker and clears the choice; a refused start keeps it for another try", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    const starts: Array<Record<string, unknown>> = [];
    let refuse = true;
    const startWorkflow = async (input: Record<string, unknown>) => {
      starts.push(input);
      if (refuse) throw new SlackWorkflowStartError("WORKSPACE_LIMIT");
    };
    await expect(startChosenWorkflow({ store: choices, startWorkflow }, { thread, userId: requester, workflowPath: "FULL", choiceId })).rejects.toThrow(SlackWorkflowStartError);
    refuse = false;
    expect(await startChosenWorkflow({ store: choices, startWorkflow }, { thread, userId: requester, workflowPath: "FULL", choiceId })).toBe("started");
    expect(starts).toEqual([1, 2].map(() => ({ thread, userId: requester, instructions: "Add password reset", workflowPath: "FULL", requestId: choiceId })));
    expect(await choices.pending(thread)).toBeUndefined();
    expect(await startChosenWorkflow({ store: choices, startWorkflow }, { thread, userId: requester, workflowPath: "FULL", choiceId })).toBe("none");
  });

  it("starts once when the requester answers twice at the same time, on the same path or on both", async () => {
    for (const paths of [["QUICK", "QUICK"], ["QUICK", "FULL"]] as const) {
      const db = new FakeDynamoDb();
      const choices = store(db);
      const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
      const starts: Array<Record<string, unknown>> = [];
      const startWorkflow = async (input: Record<string, unknown>) => { starts.push(input); };
      // A button click (with the choice ID) and a typed answer (without), together.
      const outcomes = await Promise.all([
        startChosenWorkflow({ store: choices, startWorkflow }, { thread, userId: requester, workflowPath: paths[0], choiceId }),
        startChosenWorkflow({ store: choices, startWorkflow }, { thread, userId: requester, workflowPath: paths[1] }),
      ]);
      expect(starts).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "started")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== "started")).toMatch(/^(starting|other_path|none)$/);
    }
  });

  it("drops the choice when the start is refused for good, and still reports a start whose cleanup failed", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    await expect(startChosenWorkflow({ store: choices, startWorkflow: async () => { throw new SlackWorkflowStartError("FORBIDDEN"); } },
      { thread, userId: requester, workflowPath: "QUICK", choiceId })).rejects.toThrow(SlackWorkflowStartError);
    expect(await choices.pending(thread)).toBeUndefined();

    await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    db.injectFault({ command: "DeleteCommand", error: { name: "InternalServerError" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await startChosenWorkflow({ store: choices, startWorkflow: async () => undefined }, { thread, userId: requester, workflowPath: "FULL" })).toBe("started");
      expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain("workflow.choice_complete_failed");
    } finally {
      log.mockRestore();
    }
  });

  it("posts the choice with its buttons, and drops the saved request when Slack refuses the post", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    await offerWorkflowChoice({ store: choices, postMessage: async (input) => { slack.post(input); } }, { thread, userId: requester, instructions: "Add password reset" });
    const pending = await choices.pending(thread);
    expect(JSON.stringify(slack.lastPostWithAction("agentx_workflow_path_quick").blocks)).toContain(pending!.choiceId);

    const other = { ...thread, threadTs: "1695500000.000009" };
    slack.failNext("chat.postMessage", "channel_not_found");
    await expect(offerWorkflowChoice({ store: choices, postMessage: async (input) => { slack.post(input); } }, { thread: other, userId: requester, instructions: "x" })).rejects.toThrow();
    expect(await choices.pending(other)).toBeUndefined();
  });

  it("takes the buttons off the question once a typed answer started its task (Task 19)", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    await offerWorkflowChoice({ store: choices, postMessage: async (input) => slack.post(input) }, { thread, userId: requester, instructions: "Add password reset" });
    const question = slack.lastPostWithAction("agentx_workflow_path_quick");
    expect(await startChosenWorkflow({ store: choices, startWorkflow: async () => undefined, updateQuestion: async (input) => { slack.update(input); } },
      { thread, userId: requester, workflowPath: "QUICK" })).toBe("started");
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({ channel: thread.channelId, ts: question.ts, text: expect.stringContaining(`<@${requester}> chose Quick.`) as unknown });
    expect(slack.updates[0]!.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    expect(slack.updates[0]!.blocks.at(-1)).toMatchObject({ type: "context", elements: [{ text: expect.stringContaining(`<@${requester}> chose Quick.`) as unknown }] });
    // A refused start leaves the question as it was.
    const other = { ...thread, threadTs: "1695500000.000009" };
    await offerWorkflowChoice({ store: choices, postMessage: async (input) => slack.post(input) }, { thread: other, userId: requester, instructions: "x" });
    await expect(startChosenWorkflow({ store: choices, startWorkflow: async () => { throw new SlackWorkflowStartError("WORKSPACE_LIMIT"); },
      updateQuestion: async (input) => { slack.update(input); } }, { thread: other, userId: requester, workflowPath: "QUICK" })).rejects.toThrow(SlackWorkflowStartError);
    expect(slack.updates).toHaveLength(1);
  });

  it("takes a button's choice while Slack waits and starts it later, telling the member privately when the start fails (Task 19)", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    const handed: HandedOffWorkflowStart[] = [];
    const responseUrl = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc";
    // Another member's press is refused at once, and nothing is handed over.
    expect(await handOffChosenWorkflow({ store: choices, handOff: async (event) => { handed.push(event); } }, { thread, userId: other, workflowPath: "QUICK", choiceId, responseUrl })).toBe("not_requester");
    expect(await handOffChosenWorkflow({ store: choices, handOff: async (event) => { handed.push(event); } }, { thread, userId: requester, workflowPath: "QUICK", choiceId, responseUrl })).toBe("started");
    expect(handed).toEqual([{ source: "agentx.slack-interactivity", action: "start-chosen-workflow", thread, userId: requester, workflowPath: "QUICK", choiceId, responseUrl }]);
    expect(isHandedOffWorkflowStart(handed[0])).toBe(true);
    // An HTTP request can never pass for one.
    expect(isHandedOffWorkflowStart({ ...handed[0], requestContext: {} })).toBe(false);
    // The start, after Slack has its answer: the broker is slow and then refuses.
    const told: string[] = [];
    const starts: Array<Record<string, unknown>> = [];
    let refusal: string | undefined = "UNKNOWN";
    const deps = { store: choices, respondEphemeral: async (_url: string, text: string) => { told.push(text); },
      startWorkflow: async (input: Record<string, unknown>) => { starts.push(input); if (refusal !== undefined) throw new SlackWorkflowStartError(refusal); } };
    expect(await runHandedOffWorkflowStart(deps, handed[0]!)).toBe("failed");
    expect(told).toEqual([workflowStartFailureNotice("UNKNOWN", choiceId)]);
    // The hold was given back, so the same answer can be given again.
    expect(await handOffChosenWorkflow({ store: choices, handOff: async (event) => { handed.push(event); } }, { thread, userId: requester, workflowPath: "QUICK", choiceId, responseUrl })).toBe("started");
    refusal = undefined;
    expect(await runHandedOffWorkflowStart(deps, handed[1]!)).toBe("started");
    expect(starts.at(-1)).toEqual({ thread, userId: requester, instructions: "Add password reset", workflowPath: "QUICK", requestId: choiceId });
    expect(await choices.pending(thread)).toBeUndefined();
    // A repeated invoke finds nothing held, and starts nothing again.
    expect(await runHandedOffWorkflowStart(deps, handed[1]!)).toBe("none");
    expect(starts).toHaveLength(2);
    expect(told).toHaveLength(1);
  });

  it("keeps the question's buttons after a Quick press whose start failed, and marks it answered only once the task started (Task 19 fix)", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    // The question's ts was never recorded with the request (its write failed): the press itself names it.
    await offerWorkflowChoice({ store: choices, postMessage: async (input) => { slack.post(input); } }, { thread, userId: requester, instructions: "Add password reset" });
    const question = slack.lastPostWithAction("agentx_workflow_path_quick");
    const { choiceId } = (await choices.pending(thread))!;
    const responseUrl = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc";
    const handed: HandedOffWorkflowStart[] = [];
    const press = () => handOffChosenWorkflow({ store: choices, handOff: async (event) => { handed.push(event); } },
      { thread, userId: requester, workflowPath: "QUICK", choiceId, responseUrl, messageTs: question.ts });
    expect(await press()).toBe("started");
    expect(handed[0]).toMatchObject({ messageTs: question.ts });
    const told: string[] = [];
    let fail = true;
    const deps = { store: choices, respondEphemeral: async (_url: string, text: string) => { told.push(text); },
      updateQuestion: async (input: { channel: string; ts: string; text: string; blocks: Array<Record<string, unknown>> }) => { slack.update(input); },
      startWorkflow: async () => { if (fail) throw new SlackWorkflowStartError("UNKNOWN"); } };
    expect(await runHandedOffWorkflowStart(deps, handed[0]!)).toBe("failed");
    expect(told).toHaveLength(1);
    // Nothing edited the question: Quick and Full, and the "reply quick or full" hint, are still there.
    expect(slack.updates).toEqual([]);
    expect(slack.lastPostWithAction("agentx_workflow_path_full").ts).toBe(question.ts);
    expect(question.text).toContain("reply `quick` or `full`");
    fail = false;
    expect(await press()).toBe("started");
    expect(await runHandedOffWorkflowStart(deps, handed[1]!)).toBe("started");
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({ ts: question.ts, text: expect.stringContaining(`<@${requester}> chose Quick.`) as unknown });
    expect(slack.updates[0]!.blocks.some((block) => (block as { type: string }).type === "actions")).toBe(false);
  });

  it("accepts a handed-off start only with a real thread, user, choice and Slack response URL (Task 19 fix)", () => {
    const event = { source: "agentx.slack-interactivity", action: "start-chosen-workflow", thread, userId: requester, workflowPath: "QUICK",
      choiceId: "22222222-2222-4222-8222-222222222222", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", messageTs: "1695500001.000002" };
    expect(isHandedOffWorkflowStart(event)).toBe(true);
    expect(isHandedOffWorkflowStart({ ...event, thread: { ...thread, channelId: "not a channel" } })).toBe(false);
    expect(isHandedOffWorkflowStart({ ...event, userId: "nobody" })).toBe(false);
    expect(isHandedOffWorkflowStart({ ...event, choiceId: "nope" })).toBe(false);
    expect(isHandedOffWorkflowStart({ ...event, responseUrl: "https://attacker.example/hooks.slack.com/" })).toBe(false);
    expect(isHandedOffWorkflowStart({ ...event, messageTs: "soon" })).toBe(false);
  });

  it("gives the hold back when the start cannot be handed over (Task 19)", async () => {
    const db = new FakeDynamoDb();
    const choices = store(db);
    const { choiceId } = await choices.save({ thread, userId: requester, instructions: "Add password reset" });
    await expect(handOffChosenWorkflow({ store: choices, handOff: async () => { throw new Error("TooManyRequestsException"); } },
      { thread, userId: requester, workflowPath: "FULL", choiceId, responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc" })).rejects.toThrow();
    expect(await choices.choose({ thread, userId: requester, workflowPath: "FULL", choiceId })).toEqual(expect.objectContaining({ choiceId }));
  });
});
