// Test services, slice 1 (done-criterion 3): the working sandbox reaches the dependencies while the agent codes, so a coding (IMPLEMENT) invocation carries the pinned plan too. The payload contract allows it only with
// dependencies; the broker sends it only with `tx` on and only when the task's environment has dependencies; with `tx` off the coding payload is what it always was.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkerInvocationSchema } from "../../packages/contracts/src/index.js";

const dependency = { id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: "b".repeat(64), config: {}, aliases: ["postgres"], connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [], reset: "fresh_per_round" };
const plan = (dependencies?: unknown[]) => ({ revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], ...(dependencies === undefined ? {} : { dependencies }) });
const invocation = (payload: Record<string, unknown>) => ({
  protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "capability-value-0123456789-0123456789",
  payload: { conversationId: randomUUID(), prompt: "do it", ...payload },
});
const parses = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse(invocation(payload)).success;

describe("which runs may carry a test environment plan", () => {
  it("a coding run may carry one WITH dependencies, and nothing else changes", () => {
    expect(parses({ workflowMode: "IMPLEMENT", testEnvironment: plan([dependency]) })).toBe(true);
    expect(parses({ workflowMode: "IMPLEMENT" })).toBe(true);
    expect(parses({ workflowMode: "CHECKS", testEnvironment: plan() })).toBe(true);
    expect(parses({ workflowMode: "CHECKS", testEnvironment: plan([dependency]) })).toBe(true);
  });

  it("a coding run's plan without dependencies, and any other mode's plan, are still refused (golden)", () => {
    expect(parses({ workflowMode: "IMPLEMENT", testEnvironment: plan() })).toBe(false);
    for (const workflowMode of ["PLAN", "REVIEW", "UNDERSTAND", "FEEDBACK_REVIEW", "PLAN_CRITIQUE"]) {
      expect(parses({ workflowMode, testEnvironment: plan([dependency]) }), workflowMode).toBe(false);
    }
  });
});
