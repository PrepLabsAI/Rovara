// Recording failures are named in the record by fixed category, so a broken recorder never fails silently.
import { describe, expect, it, vi } from "vitest";
import { TurnObservationSchema } from "../../packages/contracts/src/turns.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";

type Handler = (event: unknown) => void;
function handlersOf(recorder: TurnRecorder): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const extension = recorder.extension();
  const on = (event: string, handler: Handler) => { handlers.set(event, handler); };
  if (typeof extension === "function") void extension({ on } as unknown as Parameters<typeof extension>[0]);
  else if ("factory" in extension) void extension.factory({ on } as unknown as Parameters<typeof extension.factory>[0]);
  return handlers;
}

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
