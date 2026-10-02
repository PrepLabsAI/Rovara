// tests/contract/slack-progress-note.test.ts
// Issue 219: a long Slack task says it started on the worker and then edits ONE message at a steady
// interval with how long it has run, instead of staying silent for many minutes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { PROGRESS_INTERVAL_MS, createProgressNote, progressSubject } from "../../packages/slack-service/src/progress-note.js";

const START = Date.parse("2026-10-02T10:00:00.000Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => { vi.useRealTimers(); });

function note(overrides: Partial<Parameters<typeof createProgressNote>[0]> = {}) {
  const posts: string[] = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const log = vi.fn();
  const progress = createProgressNote({
    what: "running sleep 2400", eventId: "Ev0000000001", log, now: Date.now,
    post: async (text) => { posts.push(text); return "1695500000.000900"; },
    update: async (ts, text) => { updates.push({ ts, text }); },
    ...overrides,
  });
  return { progress, posts, updates, log };
}

describe("the progress note (#219)", () => {
  it("posts once when the worker starts, then edits that one message every few minutes with the time so far", async () => {
    const { progress, posts, updates } = note();
    await progress.start();
    await progress.start();
    expect(posts).toEqual(["Started on the worker: running sleep 2400. I'll update this message while it runs."]);
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(updates).toEqual([{ ts: "1695500000.000900", text: "Still working: running sleep 2400, 3 minutes so far." }]);
    await vi.advanceTimersByTimeAsync(12 * 60_000 - PROGRESS_INTERVAL_MS);
    expect(updates.at(-1)).toEqual({ ts: "1695500000.000900", text: "Still working: running sleep 2400, 12 minutes so far." });
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await progress.finish("finished");
    expect(updates.at(-1)?.text).toBe("Finished: running sleep 2400, after 13 minutes.");
    const count = updates.length;
    await vi.advanceTimersByTimeAsync(10 * PROGRESS_INTERVAL_MS);
    expect(updates).toHaveLength(count);
  });

  it("says a task that stopped early stopped, and edits nothing for a note never started", async () => {
    const stopped = note();
    await stopped.progress.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped.progress.finish("stopped");
    expect(stopped.updates).toEqual([{ ts: "1695500000.000900", text: "Stopped: running sleep 2400, after less than a minute." }]);
    const idle = note();
    await idle.progress.finish("finished");
    idle.progress.dispose();
    expect([...idle.posts, ...idle.updates]).toEqual([]);
  });

  it("never throws: a failed post starts no timer, and a failed edit is logged and the next one tried", async () => {
    const failing = note({ post: async () => { throw new Error("rate_limited"); } });
    await expect(failing.progress.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * PROGRESS_INTERVAL_MS);
    expect(failing.updates).toEqual([]);
    expect(failing.log).toHaveBeenCalledWith("progress.post_failed", { eventId: "Ev0000000001", errorName: "Error" });
    let calls = 0;
    const flaky = note({ update: async () => { calls += 1; if (calls === 1) throw new Error("ratelimited"); } });
    await flaky.progress.start();
    await vi.advanceTimersByTimeAsync(2 * PROGRESS_INTERVAL_MS);
    expect(calls).toBe(2);
    expect(flaky.log).toHaveBeenCalledWith("progress.update_failed", { eventId: "Ev0000000001", errorName: "Error" });
    await expect(flaky.progress.finish("finished")).resolves.toBeUndefined();
  });

  it("dispose stops the edits without a last one, for a turn handed off", async () => {
    const { progress, updates } = note();
    await progress.start();
    progress.dispose();
    await vi.advanceTimersByTimeAsync(10 * PROGRESS_INTERVAL_MS);
    expect(updates).toEqual([]);
  });

  it("names the task by the member's words or what they approved, Slack-safe and short", () => {
    expect(progressSubject("<@U0BOT00001> run `sleep 2400` & tell me <!channel>")).toBe("run sleep 2400 &amp; tell me");
    expect(progressSubject("  ", 'Start a coding task: "list files"')).toBe('Start a coding task: "list files"');
    const long = progressSubject(`<@U0BOT00001> ${"word ".repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("a long Slack task's progress in the processor (#219)", () => {
  const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
  const message: SlackRequestMessage = { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "<@U0BOT00001> run sleep 2400", receivedAt: "2026-10-02T10:00:00.000Z" };

  function harness(minutes: number) {
    const posts: string[] = [];
    const progressPosts: string[] = [];
    const updates: Array<{ ts: string; text: string }> = [];
    const turns: TurnInput[] = [];
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: async () => ({ outcome: "WORKSPACE", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work." }),
        startClose: async () => ({ outcome: "NOT_FOUND" as const }),
        completeClose: vi.fn(),
        waitForOperation: vi.fn(async () => ({ status: "SUCCEEDED" })),
        createConversation: async () => "33333333-3333-4333-8333-333333333333",
      }),
      threads: { load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined, close: async () => undefined, finish: async () => undefined },
      runTurn: async (input) => {
        turns.push(input);
        await input.onOperationAccepted?.("22222222-2222-4222-8222-222222222222");
        await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
        return "All done.";
      },
      post: async (_thread, text) => { posts.push(text); },
      postProgress: async (_thread, text) => { progressPosts.push(text); return "1695500000.000900"; },
      updateMessage: async (_thread, ts, text) => { updates.push({ ts, text }); },
    };
    return { dependencies, posts, progressPosts, updates, turns };
  }

  it("posts a progress note when the worker accepts the task and edits it while a task runs past a few minutes", async () => {
    const h = harness(13);
    const done = processSlackRequest(message, h.dependencies, { finalAttempt: false });
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    await done;
    expect(h.progressPosts).toEqual(["Started on the worker: run sleep 2400. I'll update this message while it runs."]);
    expect(h.updates.map((update) => update.text)).toContain("Still working: run sleep 2400, 12 minutes so far.");
    expect(new Set(h.updates.map((update) => update.ts))).toEqual(new Set(["1695500000.000900"]));
    expect(h.updates.at(-1)?.text).toBe("Finished: run sleep 2400, after 13 minutes.");
    expect(h.posts.at(-1)).toBe("All done.");
  });

  it("runs a turn exactly as before without the progress dependencies", async () => {
    const h = harness(1);
    delete h.dependencies.postProgress;
    delete h.dependencies.updateMessage;
    const done = processSlackRequest(message, h.dependencies, { finalAttempt: false });
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(h.turns[0]).not.toHaveProperty("onOperationAccepted");
    expect([...h.progressPosts, ...h.updates]).toEqual([]);
    expect(h.posts.at(-1)).toBe("All done.");
  });
});
