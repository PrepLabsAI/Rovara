// Lead 4 J2: the answer's one button on the production choice store (a Dynamo table double). It is the existing Quick choice: only the person who asked can press it, the saved request carries the question
// and the framed answer, a press, a failed start and a finished start all keep the answer's own words (never a card question over them), and the choice never replaces a card question that waits.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANSWER_WORDS, WORKFLOW_PATH_QUICK_ACTION, workflowChoiceKey, type SlackAnswerResult, type SlackRequestMessage, type SlackThread } from "@agentx/contracts";
import { createChoiceOffer } from "../../packages/slack-service/src/request-routing.js";
import { createAnswerChoices, createAnswerDoor } from "../../packages/slack-service/src/slack-answer-door.js";
import {
  createDynamoWorkflowChoiceStore, handOffChosenWorkflow, isHandedOffWorkflowStart, offerWorkflowChoice, runHandedOffWorkflowStart, startChosenWorkflow, workflowChoiceCard, SlackWorkflowStartError,
  type HandedOffWorkflowStart, type SlackWorkflowStartInput,
} from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const THREAD: SlackThread = { teamId: "T0AAAAAAA", channelId: "C0BOUND000", threadTs: "1700000000.000100" };
const ASKER = "U0ASKER000";
const TEAMMATE = "U0MATE0000";
const FRAMED = '<source-result source="an answer Rovara gave earlier" untrusted="true">Question: q\nAnswer: Refunds last 30 days.</source-result>';
const CARD_TEXT = "Refunds last 30 days. [1]\nSources: [1] `web/src/refund.ts:3`";
const NOW = Date.parse("2026-11-17T10:00:00.000Z");

function world() {
  const db = new FakeDynamoDb();
  const answers = createAnswerChoices({ documentClient: db, tableName: "threads", log: () => undefined, now: () => NOW });
  const store = createDynamoWorkflowChoiceStore({ documentClient: db, tableName: "threads", now: () => NOW });
  const save = (over: { choiceId?: string; thread?: SlackThread; userId?: string } = {}) => answers.save({
    thread: over.thread ?? THREAD, userId: over.userId ?? ASKER, choiceId: over.choiceId ?? randomUUID(), instructions: `How long do refunds last?\n\n${FRAMED}`, cardText: CARD_TEXT,
  });
  return { db, answers, store, save };
}
const textOf = (message: { blocks: Array<Record<string, unknown>> }): string => JSON.stringify(message.blocks);

describe("saving the answer's choice", () => {
  it("saves a Quick choice for the asker with the instructions and the answer's words kept on it", async () => {
    const w = world();
    const choiceId = randomUUID();
    expect(await w.save({ choiceId })).toBe("saved");
    const item = w.db.get(workflowChoiceKey(THREAD).pk, "META") as Record<string, unknown>;
    expect(item).toMatchObject({ choiceId, userId: ASKER, requestId: choiceId, cardText: CARD_TEXT, fromAnswer: true, teamId: THREAD.teamId, channelId: THREAD.channelId, threadTs: THREAD.threadTs });
    expect(item["instructions"]).toBe(`How long do refunds last?\n\n${FRAMED}`);
    expect(item["suggestion"]).toBeUndefined();
    expect(await w.store.pending(THREAD)).toEqual({ choiceId, userId: ASKER });
  });

  it("never replaces a card question that waits in the thread, and never a choice that is starting", async () => {
    const w = world();
    await offerWorkflowChoice({ store: w.store, postMessage: async () => ({ ts: "1.1" }) }, { thread: THREAD, userId: ASKER, instructions: "fix the typo" });
    expect(await w.save()).toBe("taken");
    expect((w.db.get(workflowChoiceKey(THREAD).pk, "META") as Record<string, unknown>)["instructions"]).toBe("fix the typo");
    const other = world();
    const first = randomUUID();
    await other.save({ choiceId: first });
    await other.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId: first });
    expect(await other.save()).toBe("taken");
  });

  it("replaces an earlier answer's choice that nobody pressed, so the newest answer carries the button", async () => {
    const w = world();
    const first = randomUUID();
    const second = randomUUID();
    await w.save({ choiceId: first });
    expect(await w.save({ choiceId: second })).toBe("saved");
    expect(await w.store.pending(THREAD)).toEqual({ choiceId: second, userId: ASKER });
    expect(await w.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId: first })).toBe("none");
  });

  it("a redelivery after the message went out is 'posted', and one before it is saved again", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    expect(await w.save({ choiceId })).toBe("saved");
    await w.answers.attachMessage(THREAD, choiceId, "1700000001.000001");
    expect(await w.save({ choiceId })).toBe("posted");
  });

  it("keeps two threads and two workspaces apart", async () => {
    const w = world();
    const here = randomUUID();
    const there = randomUUID();
    await w.save({ choiceId: here });
    const elsewhere = { ...THREAD, teamId: "T0BBBBBBB" };
    expect(await w.save({ thread: elsewhere, choiceId: there })).toBe("saved");
    expect(await w.store.pending(THREAD)).toMatchObject({ choiceId: here });
    expect(await w.store.pending(elsewhere)).toMatchObject({ choiceId: there });
  });

  it("discards only its own choice", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    await w.answers.discard(THREAD, randomUUID());
    expect(await w.store.pending(THREAD)).toBeDefined();
    await w.answers.discard(THREAD, choiceId);
    expect(await w.store.pending(THREAD)).toBeUndefined();
  });
});

describe("pressing the button", () => {
  it("only the person who asked can press it: a teammate's press starts nothing and the choice keeps waiting", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    const started: SlackWorkflowStartInput[] = [];
    const outcome = await startChosenWorkflow({ store: w.store, startWorkflow: async (input) => { started.push(input); } }, { thread: THREAD, userId: TEAMMATE, workflowPath: "QUICK", choiceId });
    expect(outcome).toBe("not_requester");
    expect(started).toEqual([]);
    expect(await w.store.pending(THREAD)).toMatchObject({ choiceId, userId: ASKER });
  });

  it("the asker's press starts Quick with the question and the framed answer, once, and the answer stays in the message", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    await w.answers.attachMessage(THREAD, choiceId, "1700000001.000001");
    const started: SlackWorkflowStartInput[] = [];
    const edits: Array<{ ts: string; text: string; blocks: Array<Record<string, unknown>> }> = [];
    const deps = { store: w.store, startWorkflow: async (input: SlackWorkflowStartInput) => { started.push(input); }, updateQuestion: async (edit: { channel: string; ts: string; text: string; blocks: Array<Record<string, unknown>> }) => { edits.push(edit); } };
    expect(await startChosenWorkflow(deps, { thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId })).toBe("started");
    expect(started).toEqual([{ thread: THREAD, userId: ASKER, workflowPath: "QUICK", requestId: choiceId, instructions: `How long do refunds last?\n\n${FRAMED}` }]);
    expect(edits).toHaveLength(1);
    expect(textOf(edits[0]!)).toContain("Refunds last 30 days. [1]");
    expect(textOf(edits[0]!)).toContain("chose Quick");
    expect(textOf(edits[0]!)).not.toContain("small, clear change");
    expect(textOf(edits[0]!)).not.toContain("How should I handle this");
    expect(textOf(edits[0]!)).not.toContain(WORKFLOW_PATH_QUICK_ACTION);
    // A second press starts nothing more.
    expect(await startChosenWorkflow(deps, { thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId })).toBe("none");
    expect(started).toHaveLength(1);
  });

  it("a press that hands the start off keeps the answer while it starts, and puts the answer back with its button when the hand-off fails", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    const replaced: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];
    const events: HandedOffWorkflowStart[] = [];
    const ok = await handOffChosenWorkflow({ store: w.store, handOff: async (event) => { events.push(event); }, replaceCard: async (card) => { replaced.push(card); } },
      { thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId, responseUrl: "https://hooks.slack.com/actions/x" });
    expect(ok).toBe("started");
    expect(textOf(replaced[0]!)).toContain("Refunds last 30 days. [1]");
    expect(textOf(replaced[0]!)).toContain("Starting this on Quick");
    expect(events[0]).toMatchObject({ choiceId, cardText: CARD_TEXT });
    expect(isHandedOffWorkflowStart(JSON.parse(JSON.stringify(events[0])))).toBe(true);

    const failing = world();
    const failingId = randomUUID();
    await failing.save({ choiceId: failingId });
    const restored: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];
    await expect(handOffChosenWorkflow({ store: failing.store, handOff: async () => { throw new Error("lambda down"); }, replaceCard: async (card) => { restored.push(card); } },
      { thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId: failingId, responseUrl: "https://hooks.slack.com/actions/x" })).rejects.toThrow("lambda down");
    const back = restored.at(-1)!;
    expect(textOf(back)).toContain("Refunds last 30 days. [1]");
    expect(textOf(back)).toContain(WORKFLOW_PATH_QUICK_ACTION);
    expect(textOf(back)).toContain(ANSWER_WORDS.taskButton);
    expect(textOf(back)).not.toContain("How should I handle this");
  });

  it("a handed-off start that fails puts the answer back with its button, or without it when the choice is dropped for good, and tells the asker", async () => {
    for (const [code, expectButton] of [["WORKSPACE_LIMIT", true], ["FORBIDDEN", false]] as const) {
      const w = world();
      const choiceId = randomUUID();
      await w.save({ choiceId });
      const held = await w.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId });
      expect(typeof held).toBe("object");
      const replaced: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];
      const told: string[] = [];
      const event: HandedOffWorkflowStart = { source: "agentx.slack-interactivity", action: "start-chosen-workflow", thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId,
        responseUrl: "https://hooks.slack.com/actions/x", cardText: CARD_TEXT };
      const outcome = await runHandedOffWorkflowStart({ store: w.store, startWorkflow: async () => { throw new SlackWorkflowStartError(code); },
        respondEphemeral: async (_url, text) => { told.push(text); }, replaceCard: async (_url, card) => { replaced.push(card); } }, event);
      expect(outcome).toBe("failed");
      expect(told).toHaveLength(1);
      const card = replaced.at(-1)!;
      expect(textOf(card)).toContain("Refunds last 30 days. [1]");
      expect(textOf(card).includes(WORKFLOW_PATH_QUICK_ACTION)).toBe(expectButton);
      expect(textOf(card)).not.toContain("How should I handle this");
    }
  });

  it("a card question's own messages are unchanged (golden): the plain Quick or Full question and a routed card", () => {
    const plain = workflowChoiceCard({ choiceId: randomUUID(), requesterId: ASKER });
    expect(plain.text).toContain("How should I handle this?");
    expect(textOf(plain)).toContain("agentx_workflow_path_full");
    const routed = workflowChoiceCard({ choiceId: randomUUID(), requesterId: ASKER, suggestion: "small_change" });
    expect(routed.text).toContain("small, clear change");
  });

  it("an answer's choice starts only Quick: a typed full or answer on it is not a choice it has", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    const started: SlackWorkflowStartInput[] = [];
    const deps = { store: w.store, startWorkflow: async (input: SlackWorkflowStartInput) => { started.push(input); } };
    expect(await startChosenWorkflow(deps, { thread: THREAD, userId: ASKER, workflowPath: "FULL" })).toBe("none");
    expect(await w.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "ANSWER" })).toBe("none");
    expect(started).toEqual([]);
    expect(await startChosenWorkflow(deps, { thread: THREAD, userId: ASKER, workflowPath: "QUICK" })).toBe("started");
    expect(started).toHaveLength(1);
  });

  it("a stored card text that is empty or far too long is not used", async () => {
    const w = world();
    const choiceId = randomUUID();
    await w.save({ choiceId });
    const item = w.db.get(workflowChoiceKey(THREAD).pk, "META") as Record<string, unknown>;
    w.db.set({ ...item, cardText: "x".repeat(20_000) });
    const held = await w.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId });
    expect(typeof held === "object" ? held.cardText : "refused").toBeUndefined();
  });
});

describe("the door on the production choice store", () => {
  const request: SlackRequestMessage = { version: 1, eventId: "Ev0ABCDEF123", thread: THREAD, userId: ASKER, text: "How long do refunds last?", receivedAt: "2026-11-17T10:00:00.000Z" };
  const ANSWERED: SlackAnswerResult = { status: "answered", attach: FRAMED, answer: { answerId: "a" + "b".repeat(30), threadId: "t", outcome: "answered", text: "Refunds last 30 days. [1]", unconfirmed: [], sources: [], wikiPages: [],
    action: { kind: "quick_task", label: ANSWER_WORDS.taskButton, title: "Change refunds" } } };

  it("a redelivered message posts no second answer, and the first answer's button still works", async () => {
    const w = world();
    const posts: string[] = [];
    let n = 0;
    const door = createAnswerDoor({
      api: () => ({ askAnswer: async () => ANSWERED }), post: async (_thread, text) => { posts.push(text); return `1700000001.00000${String(++n)}`; }, choices: w.answers, lookingDelayMs: 600_000, log: () => undefined,
    });
    expect(await door(request)).toBe("handled");
    expect(await door(request)).toBe("handled");
    expect(posts).toHaveLength(1);
    expect(await w.store.pending(THREAD)).toMatchObject({ userId: ASKER });
  });

  it("a follow-up answer in the same thread carries the button and retires the earlier one", async () => {
    const w = world();
    let n = 0;
    const door = createAnswerDoor({
      api: () => ({ askAnswer: async () => ANSWERED }), post: async () => `1700000001.00000${String(++n)}`, choices: w.answers, lookingDelayMs: 600_000, log: () => undefined,
    });
    await door(request);
    const first = await w.store.pending(THREAD);
    await door({ ...request, eventId: "Ev0SECOND0001", text: "and partial refunds?" });
    const second = await w.store.pending(THREAD);
    expect(second!.choiceId).not.toBe(first!.choiceId);
  });
});

describe("a routed card and an answer's choice share the thread", () => {
  it("a card for a later request replaces an answer's unpressed choice, and never one that was pressed", async () => {
    const w = world();
    const offer = createChoiceOffer({ documentClient: w.db, tableName: "threads", log: () => undefined, post: async () => "1700000009.000001", now: () => NOW });
    const input = { thread: THREAD, userId: ASKER, instructions: "fix the typo", choiceId: randomUUID(), suggestion: "small_change" as const };
    await w.save();
    await offer(input);
    expect(await w.store.pending(THREAD)).toMatchObject({ choiceId: input.choiceId, suggested: true });
    const pressed = world();
    const first = randomUUID();
    await pressed.save({ choiceId: first });
    await pressed.store.choose({ thread: THREAD, userId: ASKER, workflowPath: "QUICK", choiceId: first });
    const offer2 = createChoiceOffer({ documentClient: pressed.db, tableName: "threads", log: () => undefined, post: async () => "1700000009.000002", now: () => NOW });
    await offer2({ ...input, choiceId: randomUUID() });
    expect(await pressed.store.pending(THREAD)).toMatchObject({ choiceId: first });
  });
});
