// tests/contract/mcp-wait.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import type { ToolCall } from "../../packages/mcp/src/tools.js";
import { ToolError, WAIT_POLL_DEADLINE_MS, waitForTask, type ControlPlaneClient } from "../../packages/mcp/src/index.js";

const view = (status: DeveloperTaskView["status"]): DeveloperTaskView => ({
  taskId: "44444444-4444-4444-8444-444444444444", title: "Fix", project: "payments", status, startingRevision: 1, client: "Claude Code", shared: false,
  createdAt: "t", updatedAt: "t", events: [{ at: "t", kind: "progress", text: "npm test" }],
});

function clock() {
  let now = 0;
  return {
    now: () => now,
    // Each sleep moves the fake clock and yields a real tick, so an abort can arrive in between.
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      now += ms;
      const timer = setTimeout(resolve, 2);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
  };
}

/** Real (faked) timers: the clock is Date.now and sleeps are setTimeout. */
const timers = {
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("waits (US2, R21)", () => {
  it("returns the finished task when it ends before the wait does, with progress after each poll", async () => {
    const getTask = vi.fn<ControlPlaneClient["getTask"]>().mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("SUCCEEDED"));
    const progress = vi.fn<NonNullable<ToolCall["progress"]>>(async () => undefined);
    const result = await waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 60, events: 10, signal: new AbortController().signal, progress, ...clock() });
    expect(result).toMatchObject({ timedOut: false, task: { status: "SUCCEEDED" } });
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(progress.mock.calls.every(([, total]) => total === 60)).toBe(true);
    expect(getTask).toHaveBeenCalledWith(view("RUNNING").taskId, 10, expect.objectContaining({ deadlineMs: WAIT_POLL_DEADLINE_MS }));
  });

});

describe("waits with slow polls (Task 15 fix round 1)", () => {
  it("passes the call's signal to each poll, so a cancel ends a poll in flight at once", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    // A poll that answers only when its signal is aborted.
    const getTask = vi.fn((_id: string, _events: number, options?: { signal?: AbortSignal }) => new Promise<DeveloperTaskView>((_resolve, reject) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      options?.signal?.addEventListener("abort", () => reject(new ToolError("CONTROL_PLANE_UNAVAILABLE", "cancelled")), { once: true });
    }));
    let settled = false;
    const waiting = waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, first: view("RUNNING"), waitSeconds: 600, events: 10, signal: controller.signal, ...timers })
      .then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(getTask).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    // A cancelled wait is not a failed check.
    expect((await waiting).failure).toBeUndefined();
  });

  it("keeps sending progress while a slow poll is in flight", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const times: number[] = [];
    const getTask = vi.fn(() => new Promise<DeveloperTaskView>((resolve) => setTimeout(() => resolve(view("RUNNING")), 30_000)));
    const waiting = waitForTask({
      client: { getTask }, taskId: view("RUNNING").taskId, first: view("RUNNING"), waitSeconds: 120, events: 10, signal: new AbortController().signal,
      progress: async () => { times.push(Date.now() - started); }, ...timers,
    });
    await vi.advanceTimersByTimeAsync(200_000);
    await waiting;
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(times.length).toBeGreaterThan(3);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(10_000);
  });

});
