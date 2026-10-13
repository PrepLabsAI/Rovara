import { describe, expect, it, vi } from "vitest";
import { runIsolatedE2E } from "../../packages/verifier/src/runtime.js";

const collection = () => ({ process: { exitCode: 0, timedOut: false, aborted: false }, rawReport: Uint8Array.from([1]), observedUpstreamRunId: "upstream-run", coverageByCase: new Map(), artifacts: [], modelReceiptIds: [], startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:00:01.000Z", cleanup: "confirmed" as const });
const input = { binding: { deadlineAt: new Date(Date.now() + 30_000).toISOString() } } as never;

describe("isolated E2E lease lifecycle", () => {
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
});
