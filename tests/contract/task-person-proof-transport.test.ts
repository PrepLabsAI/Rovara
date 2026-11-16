import { describe, expect, it } from "vitest";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { taskPersonProofInvokeCommand, taskPersonProofLambdaClient } from "../../packages/broker/src/aws/dispatcher.js";
import { taskPersonProofThroughLambda } from "../../packages/broker/src/aws/task-person-proof-transport.js";

const request = { kind: "task-person-proof" as const, slackUserId: "U123ABC", channelIds: ["C123ABC"] };
const positive = { ok: true as const, user: { id: "U123ABC", teamId: "T123ABC", name: "Person" }, memberOf: ["C123ABC"] };
const result = (admissionId: string, slackCallsUsed: number, completedAt = 1_100) => ({
  kind: "task-dispatch-person-proof-result", admissionId,
  usage: { slackCallsUsed, completedAt }, result: positive,
});
const response = (body: unknown) => ({ Payload: Buffer.from(JSON.stringify(body)) });

describe("task person proof transport", () => {
  it("uses a single-attempt synchronous Lambda invocation in the dispatcher composition", async () => {
    await expect(taskPersonProofLambdaClient.config.maxAttempts()).resolves.toBe(1);
    const command = taskPersonProofInvokeCommand("proof-function", new Uint8Array([1]));
    expect(command.input).toMatchObject({ FunctionName: "proof-function", InvocationType: "RequestResponse" });
  });

  it("shares the guard UUID and call budget with an accepted fresh proof", async () => {
    const now = 1_100;
    const admission = createTaskAuthorityAdmission({ now: () => now, lambdaRemainingMs: 20_000 });
    let sent: unknown;
    const check = taskPersonProofThroughLambda({
      admission, expectedTeamId: "T123ABC", now: () => now,
      async invoke(payload) {
        sent = JSON.parse(Buffer.from(payload).toString("utf8"));
        return response(result(admission.id, 3));
      },
    });
    await expect(check(request)).resolves.toEqual({ result: positive, slackCallsUsed: 3 });
    expect(sent).toMatchObject({ kind: "task-dispatch-person-proof", admission: { id: admission.id, slackCallsLimit: 100 } });
    admission.recordSlackUsage(3);
    expect(admission.remainingSlackCalls()).toBe(97);
  });

  it("does not invoke when calls are exhausted and seals zero-call authoritative replies", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    admission.recordSlackUsage(100);
    let invoked = false;
    const exhausted = taskPersonProofThroughLambda({ admission, expectedTeamId: "T123ABC", now: () => 1_000, async invoke() { invoked = true; return response({}); } });
    await expect(exhausted(request)).rejects.toThrow();
    expect(invoked).toBe(false);

    const second = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const zero = taskPersonProofThroughLambda({
      admission: second, expectedTeamId: "T123ABC", now: () => 1_000,
      async invoke() { return response(result(second.id, 0, 1_000)); },
    });
    await expect(zero(request)).rejects.toThrow();
    expect(() => second.assertOpen()).toThrow();
  });

  it("seals independent wrong-admission, future, late, and misbound replies", async () => {
    const badBodies = [
      (id: string, deadline: number) => { void id; void deadline; return result("123e4567-e89b-42d3-a456-426614174001", 1); },
      (id: string, deadline: number) => { void deadline; return result(id, 1, 1_101); },
      (id: string, deadline: number) => result(id, 1, deadline + 1),
      (id: string, deadline: number) => { void deadline; return { ...result(id, 1), result: { ...positive, user: { ...positive.user, teamId: "T999ABC" } } }; },
      (id: string, deadline: number) => { void deadline; return { ...result(id, 1), result: { ...positive, user: { ...positive.user, id: "U999ABC" } } }; },
      (id: string, deadline: number) => { void deadline; return { ...result(id, 1), result: { ...positive, memberOf: ["C123ABC", "C123ABC"] } }; },
      (id: string, deadline: number) => { void deadline; return { ...result(id, 1), result: { ...positive, memberOf: ["C999ABC"] } }; },
      (id: string, deadline: number) => { void id; void deadline; return { plain: positive }; },
    ];
    for (const makeBody of badBodies) {
      const admission = createTaskAuthorityAdmission({ now: () => 1_100, lambdaRemainingMs: 20_000 });
      const body = makeBody(admission.id, admission.deadlineAt);
      const check = taskPersonProofThroughLambda({ admission, expectedTeamId: "T123ABC", now: () => 1_100, async invoke() { return response(body); } });
      await expect(check(request)).rejects.toThrow();
      expect(() => admission.assertOpen()).toThrow();
    }
  });
});
