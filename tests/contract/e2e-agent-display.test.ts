import { describe, expect, it } from "vitest";
import { E2EDisplayBaselineSchema, E2EDisplayScenarioSchema, E2EDisplayScenarioV2Schema, E2EDisplayBaselineV2Schema, E2EScenarioResultsSchema } from "@agentx/contracts";
import { row } from "../support/e2e-scenario-results.js";
import { agentNavigation, agentRow } from "../support/e2e-agent-display.js";

// M1.4 Tasks 4.4b and 4.4c: display schema v3. A row may say how the AI navigated (from the verified ledger only), and a baseline may say why it did not run or which AI-navigated
// scenarios it left out. Version 2 keeps its strict shape: a v2 reader refuses these fields, which is why they are a version.

describe("display schema v3 rows", () => {
  it("accepts a row with an agentNavigation block and refuses one that grows past its bounds, carries a value, or has an unknown field", () => {
    expect(E2EDisplayScenarioSchema.safeParse(agentRow()).success).toBe(true);
    const bad = [
      agentRow({ agentNavigation: agentNavigation({ steps: Array.from({ length: 4 }, () => agentNavigation().steps[0]) }) } as never),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "x".repeat(121), actedOn: [], stop: "concluded" }] }) } as never),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: Array.from({ length: 9 }, () => ({ role: "button", name: "a" })), stop: "concluded" }] }) } as never),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [{ role: "button", name: "x".repeat(61) }], stop: "concluded" }] }) } as never),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [{ role: "textbox", name: "Email", value: "hunter2" }], stop: "concluded" }] }) } as never),
      agentRow({ agentNavigation: agentNavigation({ steps: [{ goal: "g", actedOn: [], stop: "gave-up" }] }) } as never),
      agentRow({ agentNavigation: agentNavigation({ modelCalls: -1 }) } as never),
      agentRow({ agentNavigation: agentNavigation({ transcript: "the model said" }) } as never),
    ];
    for (const value of bad) expect(E2EDisplayScenarioSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("is not a v2 row: the v2 schema refuses agentNavigation, and still accepts a row without it", () => {
    expect(E2EDisplayScenarioV2Schema.safeParse(agentRow()).success).toBe(false);
    expect(E2EDisplayScenarioV2Schema.safeParse(row()).success).toBe(true);
    expect(E2EDisplayScenarioSchema.safeParse(row()).success).toBe(true);
  });
});

describe("display schema v3 baselines", () => {
  it("accepts the reason agent-steps-only on a baseline that did not run, and a list of skipped AI scenarios on one that did", () => {
    expect(E2EDisplayBaselineSchema.safeParse({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" }).success).toBe(true);
    expect(E2EDisplayBaselineSchema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "owner-export-ai", title: "Owner export ai" }] }).success).toBe(true);
    expect(E2EScenarioResultsSchema.safeParse({ scenarios: [agentRow()], baseline: { status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" } }).success).toBe(true);
  });

  it("refuses any other reason, a reason on a baseline that ran, a skipped list on one that did not run, rows beside a reason, and more than 64 skipped entries", () => {
    const skipped = (count: number) => Array.from({ length: count }, (_, index) => ({ scenarioId: `s-${index}`, title: `Scenario ${index}` }));
    const bad = [
      { status: "UNAVAILABLE", scenarios: [], reason: "timed-out" },
      { status: "PASSED", scenarios: [row()], reason: "agent-steps-only" },
      { status: "UNAVAILABLE", scenarios: [], skippedAiScenarios: skipped(1) },
      { status: "UNAVAILABLE", scenarios: [row()], reason: "agent-steps-only" },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: skipped(65) },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "a", title: "b", result: "PASSED" }] },
      { status: "PASSED", scenarios: [row()], skippedAiScenarios: [{ scenarioId: "a", title: "x".repeat(121) }] },
    ];
    for (const value of bad) expect(E2EDisplayBaselineSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(E2EDisplayBaselineSchema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: skipped(64) }).success).toBe(true);
  });

  it("is not a v2 baseline: the v2 schema refuses both fields, and still accepts an M1.3 baseline as it was", () => {
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "UNAVAILABLE", scenarios: [], reason: "agent-steps-only" }).success).toBe(false);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "PASSED", scenarios: [row()], skippedAiScenarios: [] }).success).toBe(false);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "FAILED", scenarios: [row({ status: "FAILED" })] }).success).toBe(true);
    expect(E2EDisplayBaselineV2Schema.safeParse({ status: "UNAVAILABLE", scenarios: [] }).success).toBe(true);
  });
});
