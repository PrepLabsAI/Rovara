// The worker's event log batches (packages/worker/src/events.ts): an event the control plane stores as one table item is
// kept far below DynamoDB's 400 KB item limit, whatever a model or tool put in it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_BATCH_MAX_DELAY_MS, EventBatcher, WORKER_EVENT_PAYLOAD_MAX_BYTES, isUrgentWorkerEvent, type WorkerEvent } from "../../packages/worker/src/events.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function appended(payload: unknown): Promise<WorkerEvent> {
  const sent: WorkerEvent[] = [];
  const batcher = new EventBatcher(async (events) => { sent.push(...events); }, 1);
  await batcher.append("tool_start", payload);
  return sent[0]!;
}

describe("worker event payloads", () => {
  it("keeps a small event as it is", async () => {
    const payload = { type: "tool_execution_start", toolName: "write", args: { path: "a.ts", content: "export const a = 1;\n" } };
    expect((await appended(payload)).payload).toEqual(payload);
  });

  it("cuts a whole large file write in a tool call's arguments, and says so", async () => {
    const content = "x".repeat(500_000);
    const event = await appended({ type: "tool_execution_start", toolName: "write", args: { path: "big.ts", content } });
    expect(bytes(event)).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES + 1_024);
    const args = (event.payload as { toolName: string; args: { path: string; content: string } }).args;
    expect((event.payload as { toolName: string }).toolName).toBe("write");
    expect(args.path).toBe("big.ts");
    expect(args.content.startsWith("x".repeat(1_000))).toBe(true);
    expect(args.content).toMatch(/… \[AgentX cut \d+ more characters\]$/);
  });

  it("drops the details of an event that is still too large after cutting its long strings, keeping its type", async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => `line ${index} ${"y".repeat(40)}`);
    const event = await appended({ type: "message_end", message: { content: many } });
    expect(bytes(event)).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES + 1_024);
    expect(event.payload).toEqual({ type: "message_end", truncated: true, note: "This event was too large to keep, so AgentX dropped its details." });
  });
});

// PLANINC-3a: the batcher used to send only at 25 events or an explicit flush, so a sparse run (the TEST planning incident: 75 events in 13 minutes) held its
// model error in memory, and a refused teardown flush lost it. These tests fail on that batcher.
describe("worker event batching", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const collect = () => {
    const batches: WorkerEvent[][] = [];
    const sink = async (events: readonly WorkerEvent[]) => { batches.push([...events]); };
    return { batches, sink, flat: () => batches.flat().map((event) => (event.payload as { n?: number }).n ?? event.payload) };
  };

  it("sends the first event at once, because the control plane starts the operation when it receives it", async () => {
    const { batches, sink } = collect();
    const batcher = new EventBatcher(sink);
    await batcher.append("progress", { n: 1 });
    expect(batches).toHaveLength(1);
    batcher.close();
  });

  it("sends a sparse event after the delay with no explicit flush, and not before", async () => {
    const { flat, sink } = collect();
    const batcher = new EventBatcher(sink);
    await batcher.append("progress", { n: 1 });
    await batcher.append("progress", { n: 2 });
    expect(flat()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH_MAX_DELAY_MS - 1);
    expect(flat()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flat()).toEqual([1, 2]);
    // the timer arms again for the next sparse event
    await batcher.append("progress", { n: 3 });
    await vi.advanceTimersByTimeAsync(EVENT_BATCH_MAX_DELAY_MS);
    expect(flat()).toEqual([1, 2, 3]);
    batcher.close();
  });

  it("keeps the 25-event batch size and the explicit flush", async () => {
    const { batches, sink } = collect();
    const batcher = new EventBatcher(sink, 25, { maxDelayMs: false });
    for (let n = 1; n <= 25; n += 1) await batcher.append("progress", { n });
    expect(batches.map((batch) => batch.length)).toEqual([1]); // the first event, then 24 pending
    await batcher.append("progress", { n: 26 });
    expect(batches.map((batch) => batch.length)).toEqual([1, 25]);
    await batcher.append("progress", { n: 27 });
    await batcher.flush();
    expect(batches.map((batch) => batch.length)).toEqual([1, 25, 1]);
    await batcher.flush();
    expect(batches).toHaveLength(3);
  });

  it("sends urgent events at once with everything pending before them, in order", async () => {
    const { flat, sink } = collect();
    const batcher = new EventBatcher(sink, 25, { maxDelayMs: false });
    await batcher.append("progress", { n: 1 });
    await batcher.append("progress", { n: 2 });
    await batcher.append("lifecycle", { n: 3 });
    expect(flat()).toEqual([1, 2, 3]);
    await batcher.append("progress", { n: 4 });
    await batcher.append("progress", { n: 5 }, { urgent: true });
    expect(flat()).toEqual([1, 2, 3, 4, 5]);
    await batcher.append("error", { n: 6 });
    await batcher.append("progress", { n: 7 });
    await batcher.append("progress", { modelCall: { event: "retry" }, n: 8 });
    expect(flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("knows which events are urgent: lifecycle, error, model-call notes, Pi retries and failed or aborted model messages", () => {
    expect(isUrgentWorkerEvent("lifecycle", { status: "RUNNING" })).toBe(true);
    expect(isUrgentWorkerEvent("error", { message: "x" })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { modelCall: { event: "deadline" } })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { type: "auto_retry_start", attempt: 1 })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { type: "auto_retry_end", success: false })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { type: "message_end", message: { role: "assistant", stopReason: "error" } })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { type: "message_end", message: { role: "assistant", stopReason: "aborted" } })).toBe(true);
    expect(isUrgentWorkerEvent("progress", { type: "message_end", message: { role: "assistant", stopReason: "stop" } })).toBe(false);
    expect(isUrgentWorkerEvent("progress", { heartbeat: { phase: "model" } })).toBe(false);
    expect(isUrgentWorkerEvent("tool_start", { type: "tool_execution_start" })).toBe(false);
    expect(isUrgentWorkerEvent("progress", null)).toBe(false);
    expect(isUrgentWorkerEvent("progress", "text")).toBe(false);
  });

  it("never reorders batches or overlaps sink calls when appends run concurrently with a slow sink", async () => {
    const received: number[] = [];
    let active = 0;
    let overlapped = false;
    let calls = 0;
    const sink = async (events: readonly WorkerEvent[]) => {
      active += 1;
      if (active > 1) overlapped = true;
      calls += 1;
      // the first send is the slowest, so an unserialized batcher would let a later batch overtake it
      await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 500 : 10));
      received.push(...events.map((event) => (event.payload as { n: number }).n));
      active -= 1;
    };
    const batcher = new EventBatcher(sink, 2, { maxDelayMs: false });
    const appends: Array<Promise<void>> = [];
    for (let n = 1; n <= 9; n += 1) appends.push(batcher.append("progress", { n }));
    appends.push(batcher.append("lifecycle", { n: 10 }));
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(appends);
    await batcher.flush();
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(overlapped).toBe(false);
  });

  it("keeps a refused batch pending in order, sends it on the next flush, and sends at most one batch size at a time", async () => {
    const sentSizes: number[] = [];
    const received: number[] = [];
    let refuse = true;
    const sink = async (events: readonly WorkerEvent[]) => {
      if (refuse) throw new Error("STALE_FENCE terminal operations cannot publish more output");
      sentSizes.push(events.length);
      received.push(...events.map((event) => (event.payload as { n: number }).n));
    };
    const batcher = new EventBatcher(sink, 2, { maxDelayMs: false });
    await expect(batcher.append("progress", { n: 1 })).rejects.toThrow("STALE_FENCE");
    await expect(batcher.append("progress", { n: 2 })).rejects.toThrow("STALE_FENCE");
    await expect(batcher.append("progress", { n: 3 })).rejects.toThrow("STALE_FENCE");
    await expect(batcher.append("progress", { n: 4 })).rejects.toThrow("STALE_FENCE");
    await expect(batcher.append("progress", { n: 5 })).rejects.toThrow("STALE_FENCE");
    refuse = false;
    await batcher.flush();
    expect(received).toEqual([1, 2, 3, 4, 5]);
    expect(Math.max(...sentSizes)).toBeLessThanOrEqual(2);
  });

  it("does not raise an unhandled rejection when the timer's flush is refused, and sends the events at the next flush", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const received: number[] = [];
      let refuse = false;
      const sink = async (events: readonly WorkerEvent[]) => {
        if (refuse) throw new Error("refused");
        received.push(...events.map((event) => (event.payload as { n: number }).n));
      };
      const batcher = new EventBatcher(sink);
      await batcher.append("progress", { n: 1 });
      refuse = true;
      await batcher.append("progress", { n: 2 });
      await vi.advanceTimersByTimeAsync(EVENT_BATCH_MAX_DELAY_MS * 3);
      expect(received).toEqual([1]);
      refuse = false;
      await batcher.flush();
      expect(received).toEqual([1, 2]);
      batcher.close();
      // Node reports an unhandled rejection after the microtask queue drains on a real event-loop turn, so leave the fake clock first.
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("close() stops the timer and sends nothing more", async () => {
    const { flat, sink } = collect();
    const batcher = new EventBatcher(sink);
    await batcher.append("progress", { n: 1 });
    await batcher.append("progress", { n: 2 });
    batcher.close();
    await vi.advanceTimersByTimeAsync(EVENT_BATCH_MAX_DELAY_MS * 4);
    expect(flat()).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
    await batcher.flush();
    expect(flat()).toEqual([1, 2]);
  });

  it("can run without a timer, and rejects a delay outside 10 to 60,000 ms", async () => {
    const { flat, sink } = collect();
    const batcher = new EventBatcher(sink, 25, { maxDelayMs: false });
    await batcher.append("progress", { n: 1 });
    await batcher.append("progress", { n: 2 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(flat()).toEqual([1]);
    for (const maxDelayMs of [0, 9, 60_001, 1.5, Number.NaN]) expect(() => new EventBatcher(sink, 25, { maxDelayMs })).toThrow("event batch delay");
    expect(() => new EventBatcher(sink, 0)).toThrow("event batch size");
  });

  it("still redacts credentials in an urgent event", async () => {
    const { batches, sink } = collect();
    const batcher = new EventBatcher(sink);
    await batcher.append("lifecycle", { status: "RUNNING", authToken: "SECRET-VALUE" });
    expect(JSON.stringify(batches)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(batches)).toContain("[REDACTED]");
    batcher.close();
  });
});
