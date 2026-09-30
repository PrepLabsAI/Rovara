// Issue 157: a deploy that stops the Slack service mid-turn. The old task hands the turn off, and
// the redelivered message re-attaches to the worker operation instead of running the model again.
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  type PendingConfirmation,
  type SlackRequestMessage,
  type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { argumentsHash } from "../../packages/orchestrator/src/action-gate.js";
import { createDynamoConfirmationStore } from "../../packages/slack-service/src/confirmation-store.js";
import { ALREADY_USED_BY_THIS_REQUEST_TEXT } from "../../packages/slack-service/src/confirmations.js";
import { processSlackRequest, type ProcessorDependencies, type ThreadState, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const requester = "U0123456789";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const start = Date.parse("2026-09-29T19:30:00.000Z");
const close = { tool: "tracker__close_item", input: { id: "TRK-9" } };

function slackMessage(eventId: string, text: string, overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: requester, text, receivedAt: new Date(start).toISOString(), ...overrides };
}

/** The processor over a real confirmation store and an in-memory thread META row. */
function harness(turn: (input: TurnInput) => Promise<string>) {
  const db = new FakeDynamoDb();
  let now = start;
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
  const meta: ThreadState = { workspaceId, conversationId };
  const ensureWorkspace = vi.fn(async (): Promise<SlackThreadWorkspaceResult> => ({
    outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate.",
  }));
  const finish = vi.fn(async () => undefined);
  const confirmations = createDynamoConfirmationStore(db, "threads", () => now);
  const dependencies: ProcessorDependencies = {
    api: () => ({ ensureWorkspace, createConversation: async () => conversationId, waitForOperation: vi.fn(), startClose: vi.fn(), completeClose: vi.fn() }),
    threads: { load: async () => structuredClone(meta), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish },
    runTurn: async (input) => { turns.push(input); return turn(input); },
    post: async (_thread, text) => { posts.push(text); },
    postConfirmation: async () => undefined,
    confirmations,
    now: () => now,
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  return { db, posts, turns, logs, meta, ensureWorkspace, finish, confirmations, dependencies, advance: (ms: number) => { now += ms; } };
}

function pendingClose(): PendingConfirmation {
  return {
    confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester, postedAt: new Date(start - 60_000).toISOString(),
    expiresAt: new Date(start - 60_000 + CONFIRMATION_TTL_MS).toISOString(),
    calls: [{ tool: close.tool, argumentsHash: argumentsHash(close.tool, close.input), summary: "tracker__close_item: id=TRK-9", kind: "destructive" }],
  };
}

describe("a redelivered approval today (characterization)", () => {
  it("refuses with already_used_by_this_request before the workspace, and runs nothing, when the thread remembers no interrupted turn", async () => {
    const { posts, turns, logs, ensureWorkspace, finish, confirmations, dependencies } = harness(async () => "unused");
    await confirmations.save(subject, pendingClose());
    // The first attempt claimed the confirmation, then the task was stopped before it answered.
    expect(await confirmations.claim(subject, pendingClose().confirmationId, "EvYES0000157")).toBe(true);
    await processSlackRequest(slackMessage("EvYES0000157", "yes"), dependencies, { finalAttempt: false, redelivered: true });
    expect(turns).toEqual([]);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(posts).toEqual([ALREADY_USED_BY_THIS_REQUEST_TEXT]);
    expect(logs).toContainEqual({ event: "gate.confirmation_refused", fields: { eventId: "EvYES0000157", reason: "already_used_by_this_request" } });
    expect(finish).toHaveBeenCalledOnce();
  });
});
