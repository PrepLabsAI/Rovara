// Spec 025 phase 25c, Task 11 (C23): pins how an ordinary thread, one whose workspace answer has no
// sharedTask, is processed, written before the shared-thread branches were added and unchanged by them.
import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadWorkspaceResult, TurnRecord } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUNNING = "22222222-2222-4222-8222-222222222222";
const message = (text = "fix the navigation bug"): SlackRequestMessage => ({ version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text, receivedAt: "2026-09-25T10:00:00.000Z" });

function harness(result: SlackThreadWorkspaceResult) {
  const posts: string[] = [];
  const records: TurnRecord[] = [];
  const turns: string[] = [];
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const ensureWorkspace = vi.fn(async () => result);
  const userName = vi.fn(async () => "Priya");
  // Every optional dependency a shared thread uses is present, so the test shows they change nothing here.
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation,
      createConversation: async () => "33333333-3333-4333-8333-333333333333",
    }),
    threads: {
      load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined,
      close: async () => undefined, finish: async () => undefined,
      claimSharedNotice: vi.fn(async () => true),
    },
    runTurn: async () => { turns.push("turn"); return "done"; },
    post: async (_thread, text) => { posts.push(text); },
    userName,
    turnRecords: { write: async (record) => { records.push(record); return "written"; } },
  };
  return { dependencies, posts, records, turns, waitForOperation, ensureWorkspace, userName };
}

describe("an ordinary thread (characterization, C23)", () => {
  it("runs at once on a BUSY workspace with a running operation: no wait, no mention, no task on the record", async () => {
    const h = harness({ outcome: "WORKSPACE", workspaceId: WORKSPACE, status: "BUSY", operationId: RUNNING, created: false, orchestratorInstructions: "Delegate work." });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.turns).toEqual(["turn"]);
    expect(h.waitForOperation).not.toHaveBeenCalled();
    expect(h.ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(h.posts).toEqual(["done"]);
    expect(h.userName).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ disposition: "answered", requestedBy: { userId: "U0123456789" } });
    expect(h.records[0]).not.toHaveProperty("taskId");
    expect(h.records[0]).not.toHaveProperty("requesterName");
  });

  it("answers a close request with no workspace as before", async () => {
    const h = harness({ outcome: "WORKSPACE", workspaceId: WORKSPACE, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work." });
    await processSlackRequest(message("close this workspace"), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual(["This thread does not have a workspace to close."]);
  });
});
