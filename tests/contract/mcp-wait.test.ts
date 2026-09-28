// tests/contract/mcp-wait.test.ts
import { describe, expect, it, vi } from "vitest";
import type { DeveloperTaskView } from "@agentx/contracts";
import { waitForTask } from "../../packages/mcp/src/index.js";

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

describe("waits (US2, R21)", () => {
  it("returns the finished task when it ends before the wait does, with progress after each poll", async () => {
    const getTask = vi.fn().mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("RUNNING")).mockResolvedValueOnce(view("SUCCEEDED"));
    const progress = vi.fn(async () => undefined);
    const result = await waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 60, events: 10, signal: new AbortController().signal, progress, ...clock() });
    expect(result).toMatchObject({ timedOut: false, task: { status: "SUCCEEDED" } });
    expect(progress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(progress.mock.calls.every(([, total]) => total === 60)).toBe(true);
    expect(getTask).toHaveBeenCalledWith(view("RUNNING").taskId, 10);
  });

  it("is not an error when the wait ends first: timed_out, and the task keeps running", async () => {
    const getTask = vi.fn(async () => view("RUNNING"));
    const result = await waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 60, events: 10, signal: new AbortController().signal, ...clock() });
    expect(result).toMatchObject({ timedOut: true, task: { status: "RUNNING" } });
  });

  it("never lets the gap between progress notifications reach 15 seconds", async () => {
    const times: number[] = [];
    const fake = clock();
    const getTask = vi.fn(async () => view("RUNNING"));
    await waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 120, events: 10, signal: new AbortController().signal, progress: async () => { times.push(fake.now()); }, ...fake });
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(Math.max(...gaps)).toBeLessThan(15_000);
  });

  it("polls every 2 seconds, growing to 5, and reports progress that only grows, within the total", async () => {
    const fake = clock();
    const polls: number[] = [];
    const getTask = vi.fn(async () => { polls.push(fake.now()); return view("RUNNING"); });
    const values: number[] = [];
    await waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 30, events: 10, signal: new AbortController().signal, progress: async (elapsed) => { values.push(elapsed); }, ...fake });
    expect(polls.slice(0, 5)).toEqual([0, 2_000, 5_000, 9_000, 14_000]);
    expect(values.every((value, index) => index === 0 || value > values[index - 1]!)).toBe(true);
    expect(Math.max(...values)).toBeLessThanOrEqual(30);
  });

  it("stops polling when the call is cancelled (Review Focus 2)", async () => {
    const controller = new AbortController();
    const getTask = vi.fn(async () => view("RUNNING"));
    const waiting = waitForTask({ client: { getTask }, taskId: view("RUNNING").taskId, waitSeconds: 600, events: 10, signal: controller.signal, ...clock() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await waiting;
    const calls = getTask.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getTask.mock.calls.length).toBe(calls);
  });
});
