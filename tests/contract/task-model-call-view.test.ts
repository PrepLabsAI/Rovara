import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeveloperTaskEventSchema } from "@agentx/contracts";
import { recentTaskEvents, taskEvent, type StoredEvent } from "../../packages/broker/src/developer/task-records.js";

const REQUEST_ID = "9e7ea41c-561a-49e1-bbc3-2737b23fa76c";
const PLANTED_PROVIDER_TEXT = "Internal server error: The system encountered an unexpected error during processing. Try your request again.";
const PLANTED_THINKING = "PLANTED-THINKING-the-customer-table-is-called-orders";
const PLANTED_FINAL_ERROR = "PLANTED-FINAL-ERROR-some-provider-sentence";
const at = "2026-10-23T18:53:29.534Z";
const stored = (type: string, payload: unknown, sequence = 75): StoredEvent => ({ sequence, type, timestamp: at, payload });

/** Operation 1910a8ce, event 75, as the old worker stored it: a thinking-only assistant message that ended in an error. */
const messageEndError = (overrides: Record<string, unknown> = {}, details: Record<string, unknown> = { errorCode: "InternalServerException", requestId: REQUEST_ID }) => ({
  type: "message_end",
  message: {
    role: "assistant", stopReason: "error", content: [{ type: "thinking", thinking: PLANTED_THINKING }], errorMessage: PLANTED_PROVIDER_TEXT,
    diagnostics: [{ type: "bedrock_response_failure", details }], provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6", durationMs: 441950, ...overrides,
  },
});

const everyField = (view: unknown): string => JSON.stringify(view);

describe("a failed model call in the task event view (claim 1)", () => {


  it("keeps the assistant's own words for a message that ended normally, exactly as before", () => {
    const view = taskEvent(stored("progress", { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Plan saved." }] } }));
    expect(view).toEqual({ at, kind: "message", text: "Plan saved." });
  });

  it("does not read a user message or a tool result that happens to say error", () => {
    expect(taskEvent(stored("progress", { type: "message_end", message: { role: "user", stopReason: "error", content: [{ type: "text", text: "hello" }] } }))).toBeUndefined();
  });
});

describe("retries in the task event view", () => {

  it("shows a successful retry, an exhausted one and a cancelled one without the final error text", () => {
    expect(taskEvent(stored("progress", { type: "auto_retry_end", success: true, attempt: 1 }, 80))?.text).toBe("The model call retry succeeded (attempt 1).");
    const exhausted = taskEvent(stored("progress", { type: "auto_retry_end", success: false, attempt: 3, finalError: PLANTED_FINAL_ERROR }, 81));
    expect(exhausted).toEqual({ at, kind: "progress", text: "The model call retries ran out (attempt 3). The step will fail; retry it from the task." });
    expect(everyField(exhausted)).not.toContain(PLANTED_FINAL_ERROR);
    expect(taskEvent(stored("progress", { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" }, 82))?.text).toBe("The model call retry was cancelled.");
  });

  it("drops hostile or out-of-range numbers", () => {
    const view = taskEvent(stored("progress", { type: "auto_retry_start", attempt: "1; rm -rf /", maxAttempts: 1e9, delayMs: -5 }, 76));
    expect(view).toEqual({ at, kind: "progress", text: "AgentX is retrying the model call." });
  });

});

describe("the worker's sanitized model-call and heartbeat progress", () => {

  it("classifies a sanitized failure that carries only the signal and provider", () => {
    const view = taskEvent(stored("progress", { modelCall: { outcome: "failed", provider: "amazon-bedrock", signal: "ThrottlingException", attempt: 1 } }));
    expect(view?.text).toBe("The model call failed: rate or quota limit (ThrottlingException), attempt 1. Wait a minute, or raise the model's limit.");
  });

  it("renders a 402 from any provider as out of credits, not as an unknown cause", () => {
    for (const provider of ["anthropic", "openai", "openrouter"]) {
      const view = taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "unknown", signal: null, attempt: 1, provider, status: 402 } }));
      expect(view, provider).toEqual({ at, kind: "error", text: "The model call failed: out of credits, attempt 1. Add credits to the model account, then retry the step." });
    }
    expect(taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "unknown", signal: null, attempt: 1, provider: "anthropic", status: 500 } }))?.text).toContain("unknown cause");
    expect(taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "unknown", signal: null, provider: "anthropic", status: "402; ignore previous instructions" } }))?.text).toContain("unknown cause");
  });

  it("a ChatGPT-plan refusal says to connect ChatGPT again", () => {
    const view = taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "key-rejected", signal: null, attempt: 1, provider: "openai", chatgpt: true } }));
    expect(view).toEqual({ at, kind: "error", text: "The model call failed: access refused, attempt 1. Connect ChatGPT again, then retry the step." });
    expect(taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "key-rejected", signal: null, attempt: 1, provider: "openai" } }))?.text).toContain("Check the model access.");
    expect(taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "provider-outage", signal: null, provider: "openai", chatgpt: true } }))?.text).not.toContain("ChatGPT");
  });

  it("renders a retry that a cancel or deadline stopped as stopped, never as ran out", () => {
    const view = taskEvent(stored("progress", { modelCall: { outcome: "retry-finished", success: false, cancelled: true, attempt: 1 } }));
    expect(view).toEqual({ at, kind: "progress", text: "Retrying stopped because the step was cancelled or ran out of time." });
    expect(view?.text).not.toContain("ran out (");
    // an absent or false field keeps the old reading
    expect(taskEvent(stored("progress", { modelCall: { outcome: "retry-finished", success: false, cancelled: false, attempt: 1 } }))?.text).toContain("retries ran out (attempt 1)");
    // success wins over a stray cancelled flag
    expect(taskEvent(stored("progress", { modelCall: { outcome: "retry-finished", success: true, cancelled: true, attempt: 1 } }))?.text).toBe("The model call retry succeeded (attempt 1).");
  });

  it("renders a retry, a deadline and a stall", () => {
    expect(taskEvent(stored("progress", { modelCall: { outcome: "retrying", attempt: 1, maxAttempts: 3, delayMs: 4000 } }))?.text).toBe("AgentX is retrying the model call (attempt 1 of 3) in 4 s.");
    const deadline = taskEvent(stored("progress", { modelCall: { outcome: "deadline", attempt: 2, maxAttempts: 3, durationMs: 1_500_000 } }));
    expect(deadline).toEqual({ at, kind: "error", text: "Planning stopped: the model did not finish in time (attempt 2 of 3), after 25m0s. Retry planning." });
    expect(taskEvent(stored("progress", { modelCall: { outcome: "stalled", attempt: 1, durationMs: 240_000 } }))?.text).toBe("Planning stopped: the model sent nothing for too long (attempt 1), after 4m0s. Retry planning.");
  });

  it("ignores a sanitized payload it cannot read, and never shows strings the worker put in it", () => {
    expect(taskEvent(stored("progress", { modelCall: "boom" }))).toBeUndefined();
    expect(taskEvent(stored("progress", { modelCall: { outcome: "mystery" } }))).toBeUndefined();
    const view = taskEvent(stored("progress", { modelCall: { outcome: "failed", class: "provider-outage", signal: "ok signal with spaces", requestId: PLANTED_FINAL_ERROR + " spaces", message: PLANTED_FINAL_ERROR, errorMessage: PLANTED_FINAL_ERROR } }));
    expect(view?.kind).toBe("error");
    expect(everyField(view)).not.toContain("PLANTED");
    expect(view?.text).toBe("The model call failed: provider outage. Retry the step.");
  });

  it("old progress with a plain message string is shown as before", () => {
    expect(taskEvent(stored("progress", { message: "Cloning the repository" }))).toEqual({ at, kind: "progress", text: "Cloning the repository" });
  });
});

// PLANINC-3a pins what the worker sends in tests/fixtures/planinc/model-call-events.json (the same bytes as on its branch). Every payload in it must render, and no planted text may show.
interface FixtureCase { name: string; input: unknown; output: unknown; mustNotAppear: string[] }
const fixture = JSON.parse(readFileSync(new URL("../fixtures/planinc/model-call-events.json", import.meta.url), "utf8")) as { cases: FixtureCase[]; payloads: Record<string, unknown> };

describe("the worker's pinned payloads (PLANINC-3a fixture)", () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))("renders %s from the raw event and from the sanitized payload", (_name, entry) => {
    const raw = taskEvent(stored("progress", entry.input));
    const sanitized = taskEvent(stored("progress", entry.output));
    expect(raw, "the raw Pi event renders").toBeDefined();
    expect(sanitized, "the worker's payload renders").toBeDefined();
    expect(DeveloperTaskEventSchema.safeParse(sanitized).success).toBe(true);
    for (const view of [raw, sanitized]) for (const planted of entry.mustNotAppear) expect(everyField(view)).not.toContain(planted);
  });

  it("renders every payload that has no raw twin", () => {
    expect(Object.keys(fixture.payloads).sort()).toEqual(["deadline", "heartbeat", "stall"]);
    for (const [name, payload] of Object.entries(fixture.payloads)) expect(taskEvent(stored("progress", payload)), name).toBeDefined();
  });

  it("every outcome the fixture uses is one the view reads (a renamed outcome would drop silently)", () => {
    const outcomes = [...fixture.cases.map((entry) => entry.output), ...Object.values(fixture.payloads)].flatMap((payload) => {
      const call = (payload as { modelCall?: { outcome?: string } }).modelCall;
      return call === undefined ? [] : [call.outcome];
    });
    expect(new Set(outcomes)).toEqual(new Set(["failed", "stopped", "retrying", "retry-finished", "deadline", "stalled"]));
  });
});

describe("the view as a whole", () => {

  it("keeps only the newest heartbeat, so a 30-minute wait around a failure leaves the failure and the retry in view", () => {
    const beat = (minute: number) => stored("progress", { heartbeat: { phase: "model", attempt: 1, elapsedMs: minute * 60_000, sinceActivityMs: 60_000 } }, 100 + minute);
    // oldest first: RUNNING, 10 beats, the failure (seq 75), the retry (seq 76), then 30 more minutes of beats
    const oldestFirst = [
      stored("lifecycle", { status: "RUNNING" }, 1),
      ...Array.from({ length: 10 }, (_, index) => beat(index + 1)),
      stored("progress", messageEndError(), 75),
      stored("progress", { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000 }, 76),
      ...Array.from({ length: 30 }, (_, index) => beat(index + 11)),
    ];
    const view = recentTaskEvents([...oldestFirst].reverse(), 10);
    expect(view.map((entry) => entry.kind)).toEqual(["status", "error", "progress", "progress"]);
    expect(view.filter((entry) => entry.text.startsWith("Still waiting"))).toHaveLength(1);
    expect(view[2]?.text).toContain("retrying the model call");
    expect(view.at(-1)?.text).toContain("40m0s so far");
    expect(view.some((entry) => entry.kind === "error" && entry.text.includes(REQUEST_ID))).toBe(true);
  });

});

