import { describe, expect, it } from "vitest";
import { createTaskPersonProofHandler } from "../../packages/broker/src/aws/task-person-proof-handler.js";

const request = {
  kind: "task-dispatch-person-proof",
  request: { kind: "task-person-proof", slackUserId: "U123ABC", channelIds: ["C123ABC"] },
  admission: { version: 1, id: "123e4567-e89b-42d3-a456-426614174000", deadlineAt: 2_000, remainingMs: 1_000, slackCallsLimit: 20 },
};
const positive = { ok: true as const, user: { id: "U123ABC", teamId: "T123ABC", name: "Person" }, memberOf: ["C123ABC"] };

describe("task person proof handler", () => {
  it("narrows remote time and calls and returns measured, correlated proof", async () => {
    let options: { deadlineAt: number; slackCallsLimit: number; abortSignal: AbortSignal } | undefined;
    const handler = createTaskPersonProofHandler({
      now: () => 1_100,
      remainingTimeMs: () => 800,
      expectedTeamId: "T123ABC",
      async readProof(_request, admission) { options = admission; return { result: positive, slackCallsUsed: 1 }; },
    });
    await expect(handler(request)).resolves.toEqual({
      kind: "task-dispatch-person-proof-result", admissionId: request.admission.id,
      usage: { slackCallsUsed: 1, completedAt: 1_100 }, result: positive,
    });
    expect(options).toMatchObject({ deadlineAt: 1_650, slackCallsLimit: 20 });
    expect(options?.abortSignal.aborted).toBe(false);
  });

  it("refuses non-envelope requests and positive proof without measured calls", async () => {
    let calls = 0;
    const handler = createTaskPersonProofHandler({
      now: () => 1_100,
      remainingTimeMs: () => 5_000,
      expectedTeamId: "T123ABC",
      async readProof() { calls += 1; return { result: positive, slackCallsUsed: 0 }; },
    });
    await expect(handler(request.request)).rejects.toThrow();
    await expect(handler(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rejects a proof from a team other than the server-owned team", async () => {
    const handler = createTaskPersonProofHandler({
      now: () => 1_100,
      remainingTimeMs: () => 5_000,
      expectedTeamId: "T999ABC",
      async readProof() { return { result: positive, slackCallsUsed: 1 }; },
    });
    await expect(handler(request)).rejects.toThrow();
  });
});
