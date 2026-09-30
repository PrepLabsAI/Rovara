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
import {
  CONTINUE_TEXT, HANDOFF_FINAL_TEXT, HANDOFF_TASK_TEXT, HANDOFF_TEXT, TurnHandedOffError, type ActiveTurn,
} from "../../packages/slack-service/src/interrupted-turn.js";
import { processSlackRequest, type ProcessorDependencies, type ThreadState, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
const requester = "U0123456789";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";
const start = Date.parse("2026-09-29T19:30:00.000Z");
const OPERATION = "55555555-5555-4555-8555-555555555555";
const close = { tool: "tracker__close_item", input: { id: "TRK-9" } };

function slackMessage(eventId: string, text: string, overrides: Partial<SlackRequestMessage> = {}): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: requester, text, receivedAt: new Date(start).toISOString(), ...overrides };
}

/** The processor over a real confirmation store and an in-memory thread META row. */
function harness(turn: (input: TurnInput) => Promise<string>, options: {
  taskResult?: (workspaceId: string, operationId: string, signal?: AbortSignal) => Promise<{ status: string; response?: string; error?: string }>;
} = {}) {
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
  const taskResult = vi.fn(options.taskResult ?? (async (_workspace: string, operationId: string) => ({ status: "SUCCEEDED", response: `finished ${operationId}` })));
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const saveActiveTurn = vi.fn(async (_subject: string, active: ActiveTurn) => {
    meta.activeTurn = active;
  });
  const clearActiveTurn = vi.fn(async (_subject: string, eventId: string) => {
    if (meta.activeTurn?.eventId === eventId) delete meta.activeTurn;
  });
  const confirmations = createDynamoConfirmationStore(db, "threads", () => now);
  const dependencies: ProcessorDependencies = {
    api: () => ({ ensureWorkspace, createConversation: async () => conversationId, waitForOperation, taskResult, startClose: vi.fn(), completeClose: vi.fn() }),
    threads: { load: async () => structuredClone(meta), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish, saveActiveTurn, clearActiveTurn },
    runTurn: async (input) => { turns.push(input); return turn(input); },
    post: async (_thread, text) => { posts.push(text); },
    postConfirmation: async () => undefined,
    confirmations,
    now: () => now,
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  return {
    db, posts, turns, logs, meta, ensureWorkspace, finish, confirmations, dependencies, taskResult, waitForOperation, saveActiveTurn, clearActiveTurn,
    advance: (ms: number) => { now += ms; },
  };
}

/** A turn that accepts one worker operation, then waits on it until the host stops the model. */
function blockedTurn(started: () => void = () => undefined) {
  return async (input: TurnInput) => {
    await input.onOperationAccepted!(OPERATION);
    started();
    return new Promise<string>((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  };
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

describe("remembering the turn's worker operation", () => {
  it("writes the accepted operation to the thread before the turn waits on it, and forgets it once the reply is posted", async () => {
    let during: ThreadState | undefined;
    const { posts, meta, dependencies } = harness(async (input) => {
      await input.onOperationAccepted!(OPERATION);
      during = structuredClone(meta);
      return "Fixed it.";
    });
    await processSlackRequest(slackMessage("EvWORK000001", "fix the bug"), dependencies, { finalAttempt: false });
    expect(during?.activeTurn).toEqual({ eventId: "EvWORK000001", workspaceId, operationId: OPERATION });
    expect(posts.at(-1)).toBe("Fixed it.");
    expect(meta.activeTurn).toBeUndefined();
  });

  it("keeps the turn going, and logs it, when the thread cannot save the operation", async () => {
    const { posts, logs, dependencies, saveActiveTurn } = harness(async (input) => {
      await input.onOperationAccepted!(OPERATION);
      return "Fixed it.";
    });
    saveActiveTurn.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }));
    await processSlackRequest(slackMessage("EvWORK000002", "fix the bug"), dependencies, { finalAttempt: false });
    expect(posts.at(-1)).toBe("Fixed it.");
    expect(logs).toContainEqual({ event: "turn.active_save_failed", fields: { eventId: "EvWORK000002", errorName: "ProvisionedThroughputExceededException" } });
  });

  it("logs a failure to forget the operation, and still finishes the request", async () => {
    const { logs, finish, dependencies, clearActiveTurn } = harness(async (input) => {
      await input.onOperationAccepted!(OPERATION);
      return "Fixed it.";
    });
    clearActiveTurn.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }));
    await processSlackRequest(slackMessage("EvWORK000003", "fix the bug"), dependencies, { finalAttempt: false });
    expect(logs).toContainEqual({ event: "turn.active_clear_failed", fields: { eventId: "EvWORK000003", errorName: "ProvisionedThroughputExceededException" } });
    expect(finish).toHaveBeenCalledOnce();
  });
});

describe("handing a turn off when the service stops", () => {
  it("posts a notice, logs turn.interrupted, stops the model and throws for release once the hand-off deadline passes", async () => {
    const handoff = new AbortController();
    const { posts, logs, turns, meta, finish, dependencies } = harness(blockedTurn(() => handoff.abort()));
    const attempt = processSlackRequest(slackMessage("EvWORK000011", "fix the bug"), dependencies, { finalAttempt: false, handoff: handoff.signal });
    await expect(attempt).rejects.toBeInstanceOf(TurnHandedOffError);
    expect(posts.at(-1)).toBe("AgentX restarted while working on this. The task is still running; I'll post its result here.");
    expect(HANDOFF_TASK_TEXT).toBe(posts.at(-1));
    expect(logs).toContainEqual({ event: "turn.interrupted", fields: { eventId: "EvWORK000011", workspaceId, operationId: OPERATION } });
    expect(turns[0]!.signal!.aborted).toBe(true);
    // The operation stays remembered for the redelivery, and the request is not finished.
    expect(meta.activeTurn).toEqual({ eventId: "EvWORK000011", workspaceId, operationId: OPERATION });
    expect(finish).not.toHaveBeenCalled();
  });

  it("says it will try again when no worker operation was remembered", async () => {
    const handoff = new AbortController();
    const { posts, logs, dependencies } = harness(async (input) => {
      handoff.abort();
      return new Promise<string>((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    await expect(processSlackRequest(slackMessage("EvWORK000012", "what is open?"), dependencies, { finalAttempt: false, handoff: handoff.signal }))
      .rejects.toBeInstanceOf(TurnHandedOffError);
    expect(posts.at(-1)).toBe(HANDOFF_TEXT);
    expect(logs).toContainEqual({ event: "turn.interrupted", fields: { eventId: "EvWORK000012", workspaceId } });
  });

  it("ignores an operation accepted after the hand-off, so the redelivery waits on the one it was told about", async () => {
    const handoff = new AbortController();
    let late: (() => Promise<void>) | undefined;
    const { meta, dependencies } = harness(async (input) => {
      await input.onOperationAccepted!(OPERATION);
      late = () => input.onOperationAccepted!("66666666-6666-4666-8666-666666666666");
      handoff.abort();
      return new Promise<string>(() => undefined);
    });
    await expect(processSlackRequest(slackMessage("EvWORK000013", "fix the bug"), dependencies, { finalAttempt: false, handoff: handoff.signal }))
      .rejects.toBeInstanceOf(TurnHandedOffError);
    await late!();
    expect(meta.activeTurn?.operationId).toBe(OPERATION);
  });

  it("does not start or claim anything when the deadline already passed before the turn", async () => {
    const handoff = new AbortController();
    handoff.abort();
    const { turns, confirmations, dependencies } = harness(async () => "unused");
    await confirmations.save(subject, pendingClose());
    await expect(processSlackRequest(slackMessage("EvYES0000014", "yes"), dependencies, { finalAttempt: false, handoff: handoff.signal }))
      .rejects.toBeInstanceOf(TurnHandedOffError);
    expect(turns).toEqual([]);
    // Still pending, so the redelivered yes can use it.
    expect(await confirmations.load(subject)).not.toHaveProperty("retiredAt");
  });

  it("finishes with a final notice on the last allowed delivery, which has no redelivery to hand off to", async () => {
    const handoff = new AbortController();
    const { posts, finish, dependencies } = harness(blockedTurn(() => handoff.abort()));
    await processSlackRequest(slackMessage("EvWORK000015", "fix the bug"), dependencies, { finalAttempt: true, handoff: handoff.signal });
    expect(posts.at(-1)).toBe(HANDOFF_FINAL_TEXT);
    expect(finish).toHaveBeenCalledOnce();
  });
});

describe("a hand-off notice Slack refuses", () => {
  for (const finalAttempt of [false, true]) {
    it(`is logged, and ${finalAttempt ? "the last delivery still finishes" : "the message is still released"}`, async () => {
      const handoff = new AbortController();
      const { logs, finish, dependencies } = harness(blockedTurn(() => handoff.abort()));
      dependencies.post = async (_thread, text) => {
        if (text === HANDOFF_TASK_TEXT || text === HANDOFF_FINAL_TEXT) throw new Error("Slack chat.postMessage failed: HTTP 500");
      };
      const attempt = processSlackRequest(slackMessage("EvWORK000016", "fix the bug"), dependencies, { finalAttempt, handoff: handoff.signal });
      if (finalAttempt) await attempt;
      else await expect(attempt).rejects.toBeInstanceOf(TurnHandedOffError);
      expect(logs).toContainEqual({ event: "turn.interrupted_notice_failed", fields: { eventId: "EvWORK000016", errorName: "Error" } });
      expect(finish).toHaveBeenCalledTimes(finalAttempt ? 1 : 0);
    });
  }
});

describe("resuming a redelivered turn", () => {
  const remembered = (eventId: string): ActiveTurn => ({ eventId, workspaceId, operationId: OPERATION });

  it("waits on the remembered operation and posts its result without running the model, the gate or the workspace", async () => {
    const { posts, turns, ensureWorkspace, taskResult, meta, finish, logs, dependencies } = harness(async () => "unused", {
      taskResult: async () => ({ status: "SUCCEEDED", response: "Pushed the fix to the branch." }),
    });
    meta.activeTurn = remembered("EvWORK000021");
    await processSlackRequest(slackMessage("EvWORK000021", "fix the bug"), dependencies, { finalAttempt: false, redelivered: true });
    expect(turns).toEqual([]);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(taskResult).toHaveBeenCalledOnce();
    expect(taskResult.mock.calls[0]!.slice(0, 2)).toEqual([workspaceId, OPERATION]);
    expect(posts).toEqual([
      "The task that was running when AgentX restarted has finished:\nPushed the fix to the branch.\n\nAsk me to continue for any step after this one (for example the pull request).",
    ]);
    expect(CONTINUE_TEXT).toBe("Ask me to continue for any step after this one (for example the pull request).");
    expect(logs).toContainEqual({ event: "turn.resumed", fields: { eventId: "EvWORK000021", workspaceId, operationId: OPERATION, status: "SUCCEEDED" } });
    expect(meta.activeTurn).toBeUndefined();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("posts the failure reason of a failed operation", async () => {
    const { posts, dependencies, meta } = harness(async () => "unused", {
      taskResult: async () => ({ status: "FAILED", error: "the loop guard stopped the task after <many> repeats" }),
    });
    meta.activeTurn = remembered("EvWORK000022");
    await processSlackRequest(slackMessage("EvWORK000022", "fix the bug"), dependencies, { finalAttempt: false, redelivered: true });
    expect(posts).toEqual([
      `The task that was running when AgentX restarted ended as failed: the loop guard stopped the task after &lt;many&gt; repeats\n\n${CONTINUE_TEXT}`,
    ]);
  });

  it("resumes a redelivered approval instead of refusing it, so the approved call never runs twice", async () => {
    const { posts, turns, confirmations, meta, dependencies } = harness(async () => "unused");
    await confirmations.save(subject, pendingClose());
    expect(await confirmations.claim(subject, pendingClose().confirmationId, "EvYES0000023")).toBe(true);
    meta.activeTurn = remembered("EvYES0000023");
    await processSlackRequest(slackMessage("EvYES0000023", "yes"), dependencies, { finalAttempt: false, redelivered: true });
    expect(turns).toEqual([]);
    expect(posts).toEqual([`The task that was running when AgentX restarted has finished:\nfinished ${OPERATION}\n\n${CONTINUE_TEXT}`]);
    expect(await confirmations.load(subject)).toMatchObject({ usedBy: "EvYES0000023" });
  });

  it("uses the operation's status alone when the thread API cannot read task results", async () => {
    const { posts, dependencies, meta, waitForOperation } = harness(async () => "unused");
    const api = dependencies.api;
    dependencies.api = (message) => ({ ...api(message), taskResult: undefined });
    waitForOperation.mockResolvedValueOnce({ status: "SUCCEEDED" });
    meta.activeTurn = remembered("EvWORK000024");
    await processSlackRequest(slackMessage("EvWORK000024", "fix the bug"), dependencies, { finalAttempt: false, redelivered: true });
    expect(waitForOperation).toHaveBeenCalledWith(workspaceId, OPERATION, expect.anything());
    expect(posts).toEqual([`The task that was running when AgentX restarted has finished, without a final message.\n\n${CONTINUE_TEXT}`]);
  });

  it("runs normally when the remembered turn belongs to another event, or the message was not redelivered", async () => {
    const { turns, taskResult, meta, dependencies } = harness(async () => "Done.");
    meta.activeTurn = remembered("EvWORK000000");
    await processSlackRequest(slackMessage("EvWORK000025", "fix the bug"), dependencies, { finalAttempt: false, redelivered: true });
    meta.activeTurn = remembered("EvWORK000026");
    await processSlackRequest(slackMessage("EvWORK000026", "fix the bug"), dependencies, { finalAttempt: false });
    expect(turns).toHaveLength(2);
    expect(taskResult).not.toHaveBeenCalled();
  });

  it("hands the resume off again when a second deploy stops it mid-wait", async () => {
    const handoff = new AbortController();
    const { posts, meta, finish, logs, dependencies } = harness(async () => "unused", {
      taskResult: (_workspace, _operation, signal) => {
        handoff.abort();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    meta.activeTurn = remembered("EvWORK000027");
    await expect(processSlackRequest(slackMessage("EvWORK000027", "fix the bug"), dependencies, { finalAttempt: false, redelivered: true, handoff: handoff.signal }))
      .rejects.toBeInstanceOf(TurnHandedOffError);
    expect(posts).toEqual([HANDOFF_TASK_TEXT]);
    expect(logs).toContainEqual({ event: "turn.interrupted", fields: { eventId: "EvWORK000027", workspaceId, operationId: OPERATION } });
    expect(meta.activeTurn).toEqual(remembered("EvWORK000027"));
    expect(finish).not.toHaveBeenCalled();
  });

  it("end to end: an approved turn handed off mid-task, then redelivered, runs the model once and posts the task's result", async () => {
    const handoff = new AbortController();
    const approvedRuns = vi.fn();
    const { posts, turns, confirmations, dependencies, meta } = harness(async (input) => {
      if (input.gate!.approvals.length > 0) approvedRuns();
      return blockedTurn(() => handoff.abort())(input);
    });
    await confirmations.save(subject, pendingClose());
    const yes = slackMessage("EvYES0000028", "yes");
    await expect(processSlackRequest(yes, dependencies, { finalAttempt: false, handoff: handoff.signal })).rejects.toBeInstanceOf(TurnHandedOffError);
    expect(meta.activeTurn).toEqual(remembered("EvYES0000028"));
    await processSlackRequest(yes, dependencies, { finalAttempt: false, redelivered: true, handoff: new AbortController().signal });
    expect(approvedRuns).toHaveBeenCalledOnce();
    expect(turns).toHaveLength(1);
    expect(posts.slice(-2)).toEqual([HANDOFF_TASK_TEXT, `The task that was running when AgentX restarted has finished:\nfinished ${OPERATION}\n\n${CONTINUE_TEXT}`]);
    expect(await confirmations.load(subject)).toMatchObject({ usedBy: "EvYES0000028" });
  });
});
