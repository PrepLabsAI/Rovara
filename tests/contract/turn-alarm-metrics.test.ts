import { describe, expect, it } from "vitest";
import { emitTurnMetrics } from "../../packages/slack-service/src/turn-records.js";

const call = (source?: string) => ({
  name: "t", arguments: "{}", argumentsFingerprint: "0".repeat(32), validation: "ok", outcome: "SUCCEEDED", durationMs: 1,
  ...(source === undefined ? {} : { gate: { outcome: "deny", source, reason: "x" } }),
});
const record = (overrides: Record<string, unknown>) => ({ disposition: "answered", emptyResponse: false, calls: [], durationMs: 420_000, ...overrides }) as never;

describe("metric lines the FR-045 alarms read", () => {
  it("reports every answered or failed turn's duration", () => {
    const lines: Array<[string, unknown]> = [];
    emitTurnMetrics(record({}), (event, fields) => { lines.push([event, fields]); });
    expect(lines).toContainEqual(["metric", { metric: "TurnDurationMs", count: 420_000 }]);
  });

  it("counts calls the action gate could not check (it failed closed)", () => {
    const lines: Array<[string, unknown]> = [];
    emitTurnMetrics(record({ calls: [call("gate_error"), call("classifier_unavailable"), call("classifier"), call()] }), (event, fields) => { lines.push([event, fields]); });
    expect(lines).toContainEqual(["metric", { metric: "GateCheckerFailed", count: 2 }]);
  });

  it("reports nothing for a turn that never ran the orchestrator", () => {
    const lines: unknown[] = [];
    emitTurnMetrics(record({ disposition: "workspace_limit" }), (...args) => { lines.push(args); });
    expect(lines).toEqual([]);
  });
});
