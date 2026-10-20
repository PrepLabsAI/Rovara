import { afterEach, describe, expect, it, vi } from "vitest";
import { runIsolatedE2E } from "../../packages/verifier/src/runtime.js";

const collection = () => ({ process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: Uint8Array.from([1]), observedUpstreamRunId: "upstream-run", coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:00:01.000Z", cleanup: "confirmed" as const });
const input = { binding: { deadlineAt: new Date(Date.now() + 30_000).toISOString() } } as never;

// The deadline and cancellation tests run on a fake clock (timers and Date), advanced by the test: a deadline 35 ms away on the real clock could pass before the
// run even started on a loaded machine, and a 5 ms cancel could land before or after the allocation it is meant to interrupt.
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

describe("isolated E2E lease lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("allocates once, executes, then closes in order", async () => {
    const order: string[] = [];
    const result = await runIsolatedE2E(input, { allocate: vi.fn(async () => ({ leaseId: "lease", execute: vi.fn(async () => { order.push("execute"); return collection(); }), close: vi.fn(async () => { order.push("close"); return { confirmed: true }; }) })) }, new AbortController().signal);
    expect(order).toEqual(["execute", "close"]);
    expect(result.cleanup).toBe("confirmed");
    expect(result.process.exitCode).toBe(0);
  });

  it("keeps cleanup failure visible after execution failure", async () => {
    const close = vi.fn(async () => ({ confirmed: false }));
    const result = await runIsolatedE2E(input, { allocate: async () => ({ leaseId: "lease", execute: async () => { throw new Error("runtime failed"); }, close }) }, new AbortController().signal);
    expect(close).toHaveBeenCalledOnce();
    expect(result.rawReport).toBeNull();
    expect(result.cleanup).toBe("pending");
    expect(result.process.exitCode).toBeNull();
  });

  it("discards an exit-zero collection resolved only after the absolute deadline", async () => {
    fakeClock();
    let sawExpired = false;
    const deadlineInput = { binding: { deadlineAt: new Date(Date.now() + 35).toISOString() } } as never;
    const run = runIsolatedE2E(deadlineInput, { allocate: async () => ({ leaseId: "late-lease", execute: async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { sawExpired = true; resolve(); }, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return collection();
    }, close: async () => ({ confirmed: true }) }) }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(35); // the deadline arrives; the execution then finishes 10 ms later, after it
    await vi.advanceTimersByTimeAsync(10);
    const result = await run;
    expect(sawExpired).toBe(true);
    expect(result.process).toMatchObject({ exitCode: null, timedOut: true, aborted: false });
    expect(result.rawReport).toBeNull();
  });

  it("discards late allocation and closes a lease that arrives after cancellation", async () => {
    const controller = new AbortController();
    fakeClock();
    let closed = false;
    const run = runIsolatedE2E({ binding: { deadlineAt: new Date(Date.now() + 5_000).toISOString() } } as never, { allocate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { leaseId: "late-allocation", execute: async () => collection(), close: async () => { closed = true; return { confirmed: true }; } };
    } }, controller.signal);
    setTimeout(() => controller.abort(new Error("cancel")), 5);
    await vi.advanceTimersByTimeAsync(5); // cancelled while the allocation (40 ms) is still under way
    const result = await run;
    await vi.advanceTimersByTimeAsync(70); // the allocation then arrives, late
    expect(result.process).toMatchObject({ exitCode: null, aborted: true });
    expect(closed).toBe(true);
    expect(result.cleanup).toBe("pending");
  });

  it("settles a never-resolving execute at the admitted deadline", async () => {
    fakeClock();
    const deadlineInput = { binding: { deadlineAt: new Date(Date.now() + 35).toISOString() } } as never;
    const run = runIsolatedE2E(deadlineInput, { allocate: async () => ({ leaseId: "stalled-lease", execute: async () => new Promise<ReturnType<typeof collection>>(() => undefined), close: async () => ({ confirmed: true }) }) }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(35);
    const result = await run;
    expect(result.process).toMatchObject({ exitCode: null, timedOut: true, aborted: false });
    expect(result.cleanup).toBe("confirmed");
    expect(result.rawReport).toBeNull();
  });
});
