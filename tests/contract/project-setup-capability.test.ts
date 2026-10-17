import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueProjectSetupCapability, verifyProjectSetupCapability } from "../../packages/broker/src/aws/project-setup-capability.js";

describe("project setup callback capability domain", () => {
  it("authorizes only the exact unexpired setup result subject and rejects task callback tokens", () => {
    const key = "k".repeat(32);
    const claims = { domain: "PROJECT_SETUP" as const, setupExecutionId: randomUUID(), subjectId: randomUUID(), transportCorrelationId: randomUUID(),
      operationId: randomUUID(), approvalRevision: 2, fence: 1, expiresAt: 2_000, actions: ["result"] as ["result"] };
    const token = issueProjectSetupCapability(key, claims);
    expect(verifyProjectSetupCapability(key, token, 1_999)).toEqual(claims);
    expect(verifyProjectSetupCapability(key, token, 2_000)).toBeUndefined();
    expect(verifyProjectSetupCapability("x".repeat(32), token, 1_999)).toBeUndefined();
    expect(verifyProjectSetupCapability(key, `${token}.task`, 1_999)).toBeUndefined();
    expect(verifyProjectSetupCapability(key, "task.callback.capability", 1_999)).toBeUndefined();
  });
});
