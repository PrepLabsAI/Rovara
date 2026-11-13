import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_PATH_REQUIRED } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

// The contracts (lane L1) now accept three start-request shapes this broker has no path for. The start handler keeps refusing them, as the old request schema did.
describe("starting a task: shapes the contracts accept and this broker refuses", () => {
  const base = () => ({ requestId: randomUUID(), project: "payments", instructions: "Fix retry handling", client: "test-client" });

  it("refuses a workflow request with no Quick or Full choice, in the old words", async () => {
    const harness = await createDeveloperTaskBroker({});
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { ...base(), workflow: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toContain(WORKFLOW_PATH_REQUIRED);
  });

  it("refuses a named agent and an agent input", async () => {
    const harness = await createDeveloperTaskBroker({});
    const agent = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { ...base(), workflow: true, workflowPath: "QUICK", agent: { agentId: "rovara-code" } });
    expect(agent.status).toBeGreaterThanOrEqual(400);
    const input = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { ...base(), workflow: true, workflowPath: "QUICK", input: { text: "Fix retry handling" } });
    expect(input.status).toBeGreaterThanOrEqual(400);
  });
});
