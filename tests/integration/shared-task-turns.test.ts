// tests/integration/shared-task-turns.test.ts
// Spec 025 FR-054, C10, C12, C13: how the Slack service handles a shared task's thread.
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CLOSED_SHARED_NOTICE, VIEW_ONLY_NOTICE, sharedNoticeClaim, type SlackRequestMessage, type SlackThreadWorkspaceResult, type TurnRecord } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SHARED_CLOSE_REFUSED_MESSAGE, TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE } from "../../packages/slack-service/src/shared-task.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000100" };
const TASK = "44444444-4444-4444-8444-444444444444";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUNNING = "22222222-2222-4222-8222-222222222222";
const message = (text = "run the linter"): SlackRequestMessage => ({ version: 1, eventId: "Ev0000000201", thread, userId: "U0PRIYA001", text, receivedAt: "2026-09-29T10:00:00.000Z" });
const workspace = (operationId: string | null): SlackThreadWorkspaceResult => ({
  outcome: "WORKSPACE", workspaceId: WORKSPACE, status: operationId === null ? "READY" : "BUSY", operationId, created: false,
  orchestratorInstructions: "Delegate work.", sharedTask: { taskId: TASK, developerName: "Maya Chen" },
});

function harness(answers: SlackThreadWorkspaceResult[], options: { claim?: boolean; claimThrows?: boolean; waitForever?: boolean; startClose?: "REFUSED" } = {}) {
  const posts: string[] = [];
  const order: string[] = [];
  const records: TurnRecord[] = [];
  const claims: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let answer = 0;
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => answers[Math.min(answer++, answers.length - 1)]!,
      startClose: async () => (options.startClose === "REFUSED" ? { outcome: "REFUSED" as const, reason: "shared_task" as const } : { outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation: async (_workspace, operationId) => {
        order.push(`wait:${operationId}`);
        if (options.waitForever) await new Promise(() => undefined);
        return { status: "SUCCEEDED" };
      },
      createConversation: async () => "33333333-3333-4333-8333-333333333333",
    }),
    threads: {
      load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined,
      close: async () => undefined, finish: async () => undefined,
      claimSharedNotice: async (subject) => {
        claims.push(subject);
        if (options.claimThrows) throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" });
        return options.claim ?? true;
      },
    },
    runTurn: async () => { order.push("turn"); return "done"; },
    post: async (_thread, text) => { posts.push(text); },
    userName: async () => "Priya",
    log: (event, fields) => { logs.push({ event, fields }); },
    turnRecords: { write: async (record) => { records.push(record); return "written"; } },
  };
  return { dependencies, posts, order, records, claims, logs };
}

afterEach(() => { vi.useRealTimers(); });

describe("a continue thread's turn (FR-054, C12)", () => {
  it("waits for the developer's running operation before the turn starts (Review Focus 1)", async () => {
    const h = harness([workspace(RUNNING), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.order).toEqual([`wait:${RUNNING}`, "turn"]);
    expect(h.posts[0]).toBe(TASK_BUSY_WAIT_MESSAGE);
  });

  it("waits again when a new operation took the workspace meanwhile", async () => {
    const next = "55555555-5555-4555-8555-555555555555";
    const h = harness([workspace(RUNNING), workspace(next), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.order).toEqual([`wait:${RUNNING}`, `wait:${next}`, "turn"]);
  });

  it("pauses, never spins, when the workspace still names the operation it already waited for", async () => {
    vi.useFakeTimers();
    const h = harness([workspace(RUNNING), workspace(RUNNING), workspace(null)]);
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(h.order).toEqual([`wait:${RUNNING}`, "turn"]);
  });

  it("waits while the developer's own run is active, which the broker names by no ID (D22)", async () => {
    vi.useFakeTimers();
    const hidden: SlackThreadWorkspaceResult = { ...workspace(null), status: "BUSY", activeOperation: "developer" };
    const h = harness([hidden, hidden, workspace(null)]);
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(h.order).toEqual(["turn"]);
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, "Working on it now. I'll post the result in this thread when it's done.", "<@U0PRIYA001> done"]);
  });

  it("gives up on a hidden run that stays busy for 30 minutes", async () => {
    vi.useFakeTimers();
    const h = harness([{ ...workspace(null), status: "BUSY", activeOperation: "developer" }]);
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    await done;
    expect(h.order).toEqual([]);
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE]);
  });

  it("asks the broker about a hidden run at most every 15 seconds, not every 5", async () => {
    vi.useFakeTimers();
    const h = harness([{ ...workspace(null), status: "BUSY", activeOperation: "developer" }]);
    const api = h.dependencies.api;
    let asked = 0;
    h.dependencies.api = (queued) => {
      const inner = api(queued);
      return { ...inner, ensureWorkspace: async (requestId) => { asked += 1; return inner.ensureWorkspace(requestId); } };
    };
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    await done;
    // One first ask, then one per 15-second pause over the 30 minutes.
    expect(asked).toBeLessThanOrEqual(1 + (30 * 60) / 15);
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE]);
  });

  it("is still only waiting 1 ms before the 30 minutes are up", async () => {
    vi.useFakeTimers();
    const h = harness([workspace(RUNNING)], { waitForever: true });
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE]);
    expect(h.records).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE]);
  });

  it("does not say the wait again on an SQS redelivery", async () => {
    const h = harness([workspace(RUNNING), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0, redelivered: true });
    expect(h.order).toEqual([`wait:${RUNNING}`, "turn"]);
    expect(h.posts).toEqual(["Working on it now. I'll post the result in this thread when it's done.", "<@U0PRIYA001> done"]);
  });

  it("answers that the task is still busy after 30 minutes, and runs nothing", async () => {
    vi.useFakeTimers();
    const h = harness([workspace(RUNNING)], { waitForever: true });
    const done = processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    await done;
    expect(h.order).not.toContain("turn");
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, TASK_STILL_BUSY_MESSAGE]);
    expect(h.records[0]).toMatchObject({ disposition: "workspace_unavailable", taskId: TASK });
  });

  it("tells teammates the task could not be set up, and who can start it again, instead of to retry (final review M5)", async () => {
    const h = harness([{ ...workspace(null), status: "PREPARATION_FAILED" }]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: true, queuedBehind: 0 });
    expect(h.posts).toEqual(["This task's workspace could not be set up, so I can't run requests in this thread. The developer who started the task can close it and start a new one from their AI tool."]);
    expect(h.order).toEqual([]);
    expect(h.records).toEqual([expect.objectContaining({ disposition: "workspace_unavailable", taskId: TASK })]);
  });

  it("names the teammate in the reply, and records the task and the teammate's name (C13, US3 scenario 5)", async () => {
    const h = harness([workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts.at(-1)).toBe("<@U0PRIYA001> done");
    expect(h.records[0]).toMatchObject({ taskId: TASK, requesterName: "Priya", requestedBy: { userId: "U0PRIYA001" }, disposition: "answered" });
  });

  it("says the start again after waiting, as it does after setup (spec 014 FR-026)", async () => {
    const h = harness([workspace(RUNNING), workspace(null)]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual([TASK_BUSY_WAIT_MESSAGE, "Working on it now. I'll post the result in this thread when it's done.", "<@U0PRIYA001> done"]);
  });

  it("never logs the message's text", async () => {
    const secret = "PLANTED-REQUEST-TEXT-9b2c";
    const h = harness([workspace(RUNNING), workspace(null)]);
    await processSlackRequest(message(`run ${secret}`), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    expect(h.logs).toContainEqual({ event: "shared_task.waiting", fields: { eventId: "Ev0000000201" } });
  });
});

describe("a thread that is not open to the channel (C10, Review Focus 2)", () => {
  it("posts the notice for a message queued before the switch, and runs nothing", async () => {
    const h = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: false }]);
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 1 });
    expect(h.posts).toEqual([VIEW_ONLY_NOTICE]);
    expect(h.order).toEqual([]);
    expect(h.records[0]).toMatchObject({ disposition: "workspace_unavailable", taskId: TASK });
  });

  it("keeps to one notice an hour, shared with the ingress's marker", async () => {
    const h = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: true }], { claim: false });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([]);
    expect(h.claims).toEqual(["T0BSHLLUGBD/C0123456789/1695500000.000100"]);
    const closed = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: true }]);
    await processSlackRequest(message(), closed.dependencies, { finalAttempt: false });
    expect(closed.posts).toEqual([CLOSED_SHARED_NOTICE]);
  });

  it("claims the closed notice apart from the view-only one, so a close is still said within the hour (live check)", async () => {
    const table = new FakeDynamoDb();
    const kinds: string[] = [];
    let clock = 1_000_000_000;
    const turn = async (answer: SlackThreadWorkspaceResult) => {
      const h = harness([answer]);
      h.dependencies.now = () => clock;
      h.dependencies.threads.claimSharedNotice = async (subject, nowSeconds, kind) => {
        kinds.push(kind);
        try {
          await table.send(new UpdateCommand({ TableName: "threads", ...sharedNoticeClaim(subject, nowSeconds, kind) }));
          return true;
        } catch (error) {
          if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
          throw error;
        }
      };
      await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
      return h.posts;
    };
    expect(await turn({ outcome: "VIEW_ONLY", taskId: TASK, closed: false })).toEqual([VIEW_ONLY_NOTICE]);
    clock += 18 * 60_000;
    expect(await turn({ outcome: "VIEW_ONLY", taskId: TASK, closed: true })).toEqual([CLOSED_SHARED_NOTICE]);
    clock += 30 * 60_000;
    expect(await turn({ outcome: "VIEW_ONLY", taskId: TASK, closed: true })).toEqual([]);
    expect(kinds).toEqual(["view", "closed", "closed"]);
  });

  it("stays silent and logs the error name when the notice claim throws", async () => {
    const h = harness([{ outcome: "VIEW_ONLY", taskId: TASK, closed: false }], { claimThrows: true });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([]);
    expect(h.order).toEqual([]);
    expect(h.logs).toContainEqual({ event: "shared_task.notice_claim_failed", fields: { eventId: "Ev0000000201", errorName: "InternalServerError" } });
  });

  it("refuses to close the task from the thread", async () => {
    const h = harness([workspace(null)], { startClose: "REFUSED" });
    await processSlackRequest(message("close this workspace"), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SHARED_CLOSE_REFUSED_MESSAGE]);
  });
});
