// Recording failures are named in the record by fixed category, so a broken recorder never fails silently.
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TURN_OBSERVATION, TurnObservationSchema, TurnRecordSchema } from "../../packages/contracts/src/turns.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";

const now = "2026-09-24T12:00:00.000Z";
const record = {
  ...EMPTY_TURN_OBSERVATION,
  eventId: "Ev0123456789", subject: "T1:C1:1.2", receivedAt: now,
  requestedBy: { teamId: "T0123456", userId: "U0123456" },
  disposition: "answered", startedAt: now, finishedAt: now, durationMs: 0, requestText: "", responseText: "",
};

type Handler = (event: unknown) => void;
function handlersOf(recorder: TurnRecorder): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const factory = recorder.extension().factory as unknown as (pi: { on: (event: string, handler: Handler) => void }) => void;
  factory({ on: (event, handler) => { handlers.set(event, handler); } });
  return handlers;
}

describe("recordingErrors in the turn contract", () => {
  it("accepts up to 8 categories of 1 to 64 characters in an observation and a record", () => {
    const eight = Array.from({ length: 8 }, (_, index) => `category_${index}`);
    expect(TurnObservationSchema.safeParse({ ...EMPTY_TURN_OBSERVATION, recordingErrors: eight }).success).toBe(true);
    expect(TurnRecordSchema.safeParse({ ...record, recordingErrors: ["x".repeat(64)] }).success).toBe(true);
    expect(TurnObservationSchema.safeParse({ ...EMPTY_TURN_OBSERVATION, recordingErrors: [...eight, "ninth"] }).success).toBe(false);
    expect(TurnObservationSchema.safeParse({ ...EMPTY_TURN_OBSERVATION, recordingErrors: [""] }).success).toBe(false);
    expect(TurnRecordSchema.safeParse({ ...record, recordingErrors: ["x".repeat(65)] }).success).toBe(false);
  });
});

describe("TurnRecorder.recordingFailed", () => {
  it("records each category once, at most 8, and omits the field when nothing failed", () => {
    const recorder = new TurnRecorder();
    expect(recorder.observation()).not.toHaveProperty("recordingErrors");
    recorder.recordingFailed("offer_failed");
    recorder.recordingFailed("offer_failed");
    for (let index = 0; index < 10; index += 1) recorder.recordingFailed(`category_${index}`);
    const observation = TurnObservationSchema.parse(recorder.observation());
    expect(observation.recordingErrors).toHaveLength(8);
    expect(observation.recordingErrors?.[0]).toBe("offer_failed");
    expect(new Set(observation.recordingErrors).size).toBe(8);
  });

  it("names a failing Pi handler by its event instead of throwing into Pi", () => {
    const recorder = new TurnRecorder();
    const handlers = handlersOf(recorder);
    vi.spyOn(recorder, "toolStarted").mockImplementation(() => { throw new Error("start broke"); });
    vi.spyOn(recorder, "toolEnded").mockImplementation(() => { throw new Error("end broke"); });
    vi.spyOn(recorder, "agentEnded").mockImplementation(() => { throw new Error("agent broke"); });
    expect(() => handlers.get("tool_execution_start")!({ toolCallId: "1", toolName: "x", args: {} })).not.toThrow();
    expect(() => handlers.get("tool_execution_end")!({ toolCallId: "1", toolName: "x", result: {}, isError: false })).not.toThrow();
    expect(() => handlers.get("agent_end")!({ messages: [] })).not.toThrow();
    expect(recorder.observation().recordingErrors).toEqual([
      "handler_failed:tool_execution_start", "handler_failed:tool_execution_end", "handler_failed:agent_end",
    ]);
  });

  it("reports a failing connector observer as observer_failed instead of throwing", () => {
    const recorder = new TurnRecorder();
    const broken = new Map<string, string>();
    vi.spyOn(broken, "set").mockImplementation(() => { throw new Error("map broke"); });
    Object.defineProperty(recorder, "errorCodes", { value: broken });
    expect(() => recorder.connectorFailed("1", "FORBIDDEN")).not.toThrow();
    expect(recorder.observation().recordingErrors).toEqual(["observer_failed"]);
  });
});
