import { describe, expect, it } from "vitest";
import { TaskDispatchProofRequestSchema, TaskDispatchProofResponseSchema } from "@agentx/contracts";

const request = {
  kind: "task-dispatch-person-proof",
  request: { kind: "task-person-proof", slackUserId: "U123ABC", channelIds: ["C123ABC"] },
  admission: { version: 1, id: "123e4567-e89b-42d3-a456-426614174000", deadlineAt: 2_000, remainingMs: 1_000, slackCallsLimit: 20 },
};

describe("task dispatch proof envelope", () => {
  it("accepts only proof requests with a bounded correlated admission", () => {
    expect(TaskDispatchProofRequestSchema.parse(request)).toEqual(request);
    expect(TaskDispatchProofRequestSchema.safeParse(request.request).success).toBe(false);
    expect(TaskDispatchProofRequestSchema.safeParse({ ...request, administration: "admin" }).success).toBe(false);
    expect(TaskDispatchProofRequestSchema.safeParse({ ...request, admission: { ...request.admission, slackCallsLimit: 101 } }).success).toBe(false);
  });

  it("requires strict measured results correlated to that admission", () => {
    const response = {
      kind: "task-dispatch-person-proof-result",
      admissionId: request.admission.id,
      usage: { slackCallsUsed: 1, completedAt: 1_500 },
      result: { ok: true, user: { id: "U123ABC", teamId: "T123ABC", name: "Person" }, memberOf: ["C123ABC"] },
    };
    expect(TaskDispatchProofResponseSchema.parse(response)).toEqual(response);
    expect(TaskDispatchProofResponseSchema.safeParse({ ...response, usage: undefined }).success).toBe(false);
    expect(TaskDispatchProofResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });
});
