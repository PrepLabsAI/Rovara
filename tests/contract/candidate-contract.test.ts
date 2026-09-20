import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OperationRequestSchema } from "@agentx/contracts";

describe("governed candidate admission", () => {
  it("retains exact job and base bindings instead of accepting only a prompt", () => {
    const candidate = { jobId: randomUUID(), attempt: 1, repository: "demo", baseCommit: "a".repeat(40) };
    const parsed = OperationRequestSchema.parse({ requestId: randomUUID(), conversationId: randomUUID(), prompt: "Edit", candidate });
    expect(parsed).toHaveProperty("candidate", candidate);
  });
  it("rejects abbreviated commits and caller-invented approval", () => {
    for (const extra of [{ baseCommit: "abc123" }, { approved: true }]) {
      expect(() => OperationRequestSchema.parse({ requestId: randomUUID(), conversationId: randomUUID(), prompt: "Edit", candidate: {
        jobId: randomUUID(), attempt: 1, repository: "demo", baseCommit: "a".repeat(40), ...extra,
      } })).toThrow();
    }
  });
});
