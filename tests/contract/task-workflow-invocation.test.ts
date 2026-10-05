import { describe, expect, it } from "vitest";
import { WorkerInvocationSchema } from "@agentx/contracts";

const base = {
  protocolVersion: 1,
  kind: "task",
  operationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  fence: 1,
  projectRevision: 1,
  callbackCapability: "c".repeat(32),
  payload: {
    conversationId: "33333333-3333-4333-8333-333333333333",
    prompt: "Plan the requested change.",
  },
};

describe("workflow-mode worker invocation", () => {
  it("accepts the broker-selected read-only planning mode and the post-approval coding mode", () => {
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "PLAN" } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "IMPLEMENT" } }).success).toBe(true);
  });

  it("keeps legacy task payloads valid and rejects unknown modes", () => {
    expect(WorkerInvocationSchema.parse(base)).not.toHaveProperty("payload.workflowMode");
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, workflowMode: "ADMIN" } }).success).toBe(false);
  });
});
