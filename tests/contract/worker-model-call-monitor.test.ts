// PLANINC-3a: the sanitizer, heartbeat clock and deadline/stall watchdog that PLANINC-3b wires into the task run (packages/worker/src/model-call-monitor.ts).
// The sanitized payload shapes are pinned by tests/fixtures/planinc/model-call-events.json, which PLANINC-1's task view reads too.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CALL_HEARTBEAT_MS, MODEL_CALL_MAX_HEARTBEATS, ModelCallMonitor, PLANNING_DEADLINE_DEFAULT_MS, PLANNING_STALL_MS,
  describeModelCallNote, expiryNote, planningDeadlineMs, sanitizeModelCallEvent,
  type HeartbeatPayload, type ModelCallExpiryInfo,
} from "../../packages/worker/src/model-call-monitor.js";

interface FixtureCase { name: string; attempt: number; input: unknown; output: unknown; mustNotAppear: string[] }
const fixture = JSON.parse(readFileSync(new URL("../fixtures/planinc/model-call-events.json", import.meta.url), "utf8")) as { cases: FixtureCase[]; payloads: Record<string, unknown> };

describe("sanitizeModelCallEvent", () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.name}: the pinned payload, and none of the provider's text`, () => {
      const output = sanitizeModelCallEvent(testCase.input, testCase.attempt);
      expect(output).toEqual(testCase.output);
      const raw = JSON.stringify(testCase.input);
      for (const text of testCase.mustNotAppear) {
        // positive control: the raw event really carried the text, so its absence from the payload is the sanitizer's doing
        expect(raw).toContain(text);
        expect(JSON.stringify(output)).not.toContain(text);
      }
    });
  }

  it("ignores events that are not a model failure or a retry", () => {
    expect(sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "message_end", message: { role: "user", stopReason: "error" } })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "message_end", message: "error" })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "tool_execution_start" })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "auto_retry_start", attempt: "1", maxAttempts: 3, delayMs: 2000 })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 })).toBeUndefined();
    expect(sanitizeModelCallEvent({ type: "auto_retry_end", success: "no", attempt: 1 })).toBeUndefined();
    for (const value of [null, undefined, "message_end", 7, [], { type: 5 }]) expect(sanitizeModelCallEvent(value)).toBeUndefined();
  });

  it("drops hostile or malformed tokens instead of cleaning them", () => {
    const hostile = {
      type: "message_end",
      message: {
        role: "assistant", stopReason: "error", provider: "evil-provider\nSECRET", durationMs: "441950",
        diagnostics: [{ details: { errorCode: "Bad Code; token=SECRET", requestId: "id with spaces SECRET", status: "503" } }],
      },
    };
    const output = sanitizeModelCallEvent(hostile, 1);
    expect(output).toEqual({ modelCall: { outcome: "failed", class: "unknown", signal: null, attempt: 1 } });
    expect(JSON.stringify(output)).not.toContain("SECRET");
    // a long or odd request id is dropped, a valid one is kept
    const idCase = (requestId: string) => sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", provider: "amazon-bedrock", diagnostics: [{ details: { requestId } }] } });
    expect((idCase("a".repeat(65)) as { modelCall: { requestId?: string } }).modelCall.requestId).toBeUndefined();
    expect((idCase("../etc/passwd") as { modelCall: { requestId?: string } }).modelCall.requestId).toBeUndefined();
    expect((idCase("abc-123") as { modelCall: { requestId?: string } }).modelCall.requestId).toBe("abc-123");
    // numbers must be finite, non-negative and bounded
    const duration = (durationMs: unknown) => (sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "aborted", durationMs } }) as { modelCall: { durationMs?: number } }).modelCall.durationMs;
    expect(duration(-1)).toBeUndefined();
    expect(duration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(duration(Number.NaN)).toBeUndefined();
    expect(duration(1e15)).toBeUndefined();
    expect(duration(1200.4)).toBe(1200);
  });

  it("classifies a keyed provider's failure by its own tokens", () => {
    const output = sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", provider: "anthropic", diagnostics: [{ details: { errorCode: "overloaded_error" } }] } }, 2);
    expect(output).toEqual({ modelCall: { outcome: "failed", class: "provider-outage", signal: "overloaded_error", attempt: 2, provider: "anthropic" } });
  });

  it("never reads free text: a rate-limit sentence with no tokens stays unknown", () => {
    const output = sanitizeModelCallEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", provider: "amazon-bedrock", errorMessage: "ThrottlingException: Too many requests" } });
    expect(output).toEqual({ modelCall: { outcome: "failed", class: "unknown", signal: null, attempt: 1, provider: "amazon-bedrock" } });
  });

  it("writes the same fixed sentences the task error and the log will use", () => {
    const failed = sanitizeModelCallEvent(fixture.cases[0]!.input, 4)!.modelCall;
    expect(describeModelCallNote(failed)).toBe("the model call failed: provider-outage InternalServerException request 9e7ea41c-561a-49e1-bbc3-2737b23fa76c attempt 4");
    expect(describeModelCallNote(sanitizeModelCallEvent(fixture.cases[2]!.input)!.modelCall)).toBe("the model call failed: unknown attempt 1");
    expect(describeModelCallNote(sanitizeModelCallEvent(fixture.cases[3]!.input)!.modelCall)).toBe("the model call was stopped: attempt 1");
    expect(describeModelCallNote(sanitizeModelCallEvent(fixture.cases[4]!.input)!.modelCall)).toBe("the model call is retried: retry 1 of 3");
    expect(describeModelCallNote(sanitizeModelCallEvent(fixture.cases[5]!.input)!.modelCall)).toBe("the model call retries ended: retry 3");
    expect(describeModelCallNote(sanitizeModelCallEvent(fixture.cases[6]!.input)!.modelCall)).toBe("the model call succeeded after retry 1");
    expect(describeModelCallNote(expiryNote({ reason: "deadline", limitMs: 1_500_000, elapsedMs: 1_500_000, sinceActivityMs: 5_000, attempt: 3 }).modelCall)).toBe("the model did not finish: time limit after 1500 s, attempt 3");
    expect(describeModelCallNote(expiryNote({ reason: "stall", limitMs: 240_000, elapsedMs: 300_000, sinceActivityMs: 240_000, attempt: 1 }).modelCall)).toBe("the model did not finish: no activity after 300 s, attempt 1");
  });
});

describe("planningDeadlineMs", () => {
  it("is 25 minutes unless AGENTX_PLAN_DEADLINE_MS is a whole number from 5 to 60 minutes", () => {
    expect(PLANNING_DEADLINE_DEFAULT_MS).toBe(25 * 60_000);
    expect(planningDeadlineMs({})).toBe(25 * 60_000);
    expect(planningDeadlineMs({ AGENTX_PLAN_DEADLINE_MS: "600000" })).toBe(600_000);
    expect(planningDeadlineMs({ AGENTX_PLAN_DEADLINE_MS: "300000" })).toBe(300_000);
    expect(planningDeadlineMs({ AGENTX_PLAN_DEADLINE_MS: "3600000" })).toBe(3_600_000);
    for (const bad of ["299999", "3600001", "0", "-1", "abc", "", "1e6", "600000.5", " 600000", "99999999999"]) expect(planningDeadlineMs({ AGENTX_PLAN_DEADLINE_MS: bad })).toBe(PLANNING_DEADLINE_DEFAULT_MS);
  });
});

describe("ModelCallMonitor", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const run = (options: ConstructorParameters<typeof ModelCallMonitor>[0] = {}) => {
    const heartbeats: HeartbeatPayload[] = [];
    const expiries: ModelCallExpiryInfo[] = [];
    const monitor = new ModelCallMonitor({ onHeartbeat: (payload) => heartbeats.push(payload), onExpire: (info) => expiries.push(info), ...options });
    return { monitor, heartbeats, expiries };
  };

  it("sends a numbers-only heartbeat after 60 s without an event while a call is in flight, matching the pinned shape", async () => {
    const { monitor, heartbeats } = run();
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(MODEL_CALL_HEARTBEAT_MS - 1_000);
    expect(heartbeats).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeats).toEqual([{ heartbeat: { phase: "model", attempt: 1, elapsedMs: 60_000, sinceActivityMs: 60_000 } }]);
    for (const value of Object.values(heartbeats[0]!.heartbeat)) expect(typeof value === "number" || value === "model").toBe(true);
    // the pinned fixture has the same keys
    expect(Object.keys((fixture.payloads.heartbeat as HeartbeatPayload).heartbeat).sort()).toEqual(Object.keys(heartbeats[0]!.heartbeat).sort());
    monitor.stop();
  });

  it("sends no heartbeat while events keep arriving, or when no call is in flight", async () => {
    const { monitor, heartbeats } = run();
    monitor.start();
    monitor.beginCall();
    for (let step = 0; step < 6; step += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      monitor.observe({ type: "message_update" });
    }
    expect(heartbeats).toHaveLength(0);
    monitor.endCall();
    await vi.advanceTimersByTimeAsync(5 * MODEL_CALL_HEARTBEAT_MS);
    expect(heartbeats).toHaveLength(0);
    monitor.stop();
  });

  it("sends one heartbeat per quiet minute and at most 60 in a run", async () => {
    const { monitor, heartbeats } = run();
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(3 * MODEL_CALL_HEARTBEAT_MS);
    expect(heartbeats.map((beat) => beat.heartbeat.sinceActivityMs)).toEqual([60_000, 120_000, 180_000]);
    await vi.advanceTimersByTimeAsync((MODEL_CALL_MAX_HEARTBEATS + 10) * MODEL_CALL_HEARTBEAT_MS);
    expect(heartbeats).toHaveLength(MODEL_CALL_MAX_HEARTBEATS);
    monitor.stop();
  });

  it("trips the stall bound once after 240 s of silence during a call, and reports the attempt", async () => {
    const { monitor, expiries, heartbeats } = run({ stallMs: PLANNING_STALL_MS, deadlineMs: 25 * 60_000 });
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(PLANNING_STALL_MS - 5_000);
    expect(expiries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(expiries).toEqual([{ reason: "stall", limitMs: PLANNING_STALL_MS, elapsedMs: PLANNING_STALL_MS, sinceActivityMs: PLANNING_STALL_MS, attempt: 1 }]);
    expect(monitor.expired).toBe("stall");
    expect(heartbeats.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(expiries).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an event resets the stall bound, and a call that is not in flight cannot stall", async () => {
    const { monitor, expiries } = run({ stallMs: PLANNING_STALL_MS });
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(200_000);
    monitor.observe({ type: "message_update" });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(expiries).toHaveLength(0);
    monitor.endCall();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(expiries).toHaveLength(0);
    monitor.stop();
  });

  it("trips the deadline across two prompts that share it, even while events keep arriving", async () => {
    const { monitor, expiries } = run({ deadlineMs: 600_000, stallMs: PLANNING_STALL_MS });
    monitor.start();
    monitor.beginCall();
    for (let elapsed = 0; elapsed < 300_000; elapsed += 30_000) { await vi.advanceTimersByTimeAsync(30_000); monitor.observe({ type: "message_update" }); }
    monitor.endCall();
    monitor.beginCall(); // the format-retry prompt: same clock, second attempt
    for (let elapsed = 0; elapsed < 295_000; elapsed += 5_000) { await vi.advanceTimersByTimeAsync(5_000); monitor.observe({ type: "message_update" }); }
    expect(expiries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({ reason: "deadline", limitMs: 600_000, elapsedMs: 600_000, attempt: 2 });
    expect(Object.keys(expiryNote(expiries[0]!).modelCall).sort()).toEqual(Object.keys((fixture.payloads.deadline as { modelCall: object }).modelCall).sort());
  });

  it("names the expiry outcomes as PLANINC-1's task view reads them: deadline and stalled, with durationMs", () => {
    expect(expiryNote({ reason: "deadline", limitMs: 1_500_000, elapsedMs: 1_500_000, sinceActivityMs: 1, attempt: 3 })).toEqual(fixture.payloads.deadline);
    expect(expiryNote({ reason: "stall", limitMs: 240_000, elapsedMs: 300_000, sinceActivityMs: 240_000, attempt: 1 })).toEqual(fixture.payloads.stall);
  });

  it("counts each Pi retry as another attempt", () => {
    const { monitor } = run();
    monitor.start();
    monitor.beginCall();
    expect(monitor.attempt).toBe(1);
    monitor.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2_000, errorMessage: "x" });
    expect(monitor.attempt).toBe(2);
    monitor.observe({ type: "message_update" });
    expect(monitor.attempt).toBe(2);
    monitor.observe({ type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 4_000, errorMessage: "x" });
    expect(monitor.attempt).toBe(3);
    monitor.stop();
  });

  it("a retried call that hangs trips the stall bound from the retry event", async () => {
    const { monitor, expiries } = run({ stallMs: PLANNING_STALL_MS });
    monitor.start();
    monitor.beginCall();
    monitor.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "x" });
    await vi.advanceTimersByTimeAsync(PLANNING_STALL_MS);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({ reason: "stall", attempt: 2 });
  });

  it("stop() disarms the clock: no expiry, heartbeat or timer after it, so a cancel or loop-guard stop wins over the deadline", async () => {
    const { monitor, expiries, heartbeats } = run({ stallMs: PLANNING_STALL_MS, deadlineMs: 600_000 });
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(100_000);
    const beats = heartbeats.length;
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(expiries).toHaveLength(0);
    expect(heartbeats).toHaveLength(beats);
    expect(monitor.expired).toBeUndefined();
    monitor.start(); // a stopped monitor does not restart
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows a throwing callback, so a timer never raises an unhandled exception", async () => {
    const monitor = new ModelCallMonitor({ stallMs: 10_000, onHeartbeat: () => { throw new Error("sink down"); }, onExpire: () => { throw new Error("abort failed"); }, heartbeatMs: 5_000, tickMs: 1_000 });
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.expired).toBe("stall");
  });

  it("has no limits unless they are set", async () => {
    const { monitor, expiries } = run();
    monitor.start();
    monitor.beginCall();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(expiries).toHaveLength(0);
    monitor.stop();
  });

  it("rejects limits that are not positive whole milliseconds", () => {
    for (const options of [{ deadlineMs: 0 }, { stallMs: -1 }, { deadlineMs: 1.5 }, { tickMs: 0 }, { heartbeatMs: Number.NaN }]) expect(() => new ModelCallMonitor(options)).toThrow("model call");
  });
});
