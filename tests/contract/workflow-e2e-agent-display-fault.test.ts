import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AgentDisplay from "../../packages/broker/src/e2e/application-agent-display.js";
import { agentRunnable, runAgentCase, type AgentRun } from "../support/agent-executor-run.js";
import { asLinuxRun, assembleAgentRun, brokerRoundFor } from "../support/agent-collection.js";

// Fix round 1 (finding m6): the navigation block is display data. If deriving it throws, the verdict stays what the verifier decided and the row only loses its badge.
vi.mock("../../packages/broker/src/e2e/application-agent-display.js", async (importOriginal) => {
  const original = await importOriginal<typeof AgentDisplay>();
  return { ...original, agentNavigationOf: () => { throw new Error("password=hunter2-secret derivation fault"); } };
});

describe.runIf(agentRunnable)("a fault while deriving the navigation block", () => {
  let run: AgentRun;
  beforeAll(async () => { run = await runAgentCase({ script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] }); }, 600_000);
  afterAll(async () => { await run.cleanup(); });

  it("leaves a PASS round PASS and the row PASSED, drops the badge, and logs a code only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const verdict = brokerRoundFor(asLinuxRun(await assembleAgentRun(run))).verify();
      expect(verdict.reason).toBe("every admitted application group was independently re-collected as passing");
      expect(verdict.verdict).toBe("PASS");
      expect(verdict.results[0]!.status).toBe("passed");
      expect(verdict.display!.scenarios[0]).toMatchObject({ scenarioId: "agent-export", status: "PASSED" });
      expect(verdict.display!.scenarios[0]).not.toHaveProperty("agentNavigation");
      const lines = log.mock.calls.map((call) => String(call[0]));
      const dropped = lines.filter((line) => line.includes("workflow.e2e_agent_navigation_dropped"));
      expect(dropped).toHaveLength(1);
      expect(JSON.parse(dropped[0]!)).toEqual({ component: "broker", event: "workflow.e2e_agent_navigation_dropped", errorName: "Error" });
      expect(lines.join("\n")).not.toContain("hunter2-secret");
    } finally { log.mockRestore(); }
  });
});
