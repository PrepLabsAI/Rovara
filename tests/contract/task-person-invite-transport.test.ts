import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TaskPersonInviteClaimRequest, TaskPersonInviteOutcome } from "../../packages/contracts/src/developer.js";
import { taskPersonInviteThroughLambda, type TaskPersonInviteInvoker } from "../../packages/broker/src/aws/task-person-invite-transport.js";

const request = (): TaskPersonInviteClaimRequest => ({ kind: "task-person-invite-claimed", taskId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222", claimDigest: "a".repeat(64), admission: { version: 1, id: randomUUID(),
    deadlineAt: 20_000, remainingMs: 12_000, authorityRemainingMs: 6_000, slackCallsLimit: 100, stateReadsLimit: 128 } });
const accepted = (value: TaskPersonInviteClaimRequest): TaskPersonInviteOutcome => ({ taskId: value.taskId, requestId: value.requestId,
  claimDigest: value.claimDigest, admissionId: value.admission.id, status: "accepted", executionReceiptId: randomUUID() });

describe("Task Person invite transport", () => {
  it("makes one correlated RequestResponse invocation and validates its receipt", async () => {
    const value = request();
    const invoke = vi.fn(async (input: Parameters<TaskPersonInviteInvoker>[0]) => {
      expect(input.invocationType).toBe("RequestResponse");
      expect(input.maxAttempts).toBe(1);
      return { Payload: Buffer.from(JSON.stringify(accepted(value))) };
    });
    const transport = taskPersonInviteThroughLambda({ invoke, now: () => 10_000 });
    const result = await transport(value);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0].invocationType).toBe("RequestResponse");
    expect(invoke.mock.calls[0]?.[0].maxAttempts).toBe(1);
    expect(result.status).toBe("accepted");
  });

  it.each([
    ["function error", async (input: Parameters<TaskPersonInviteInvoker>[0]) => {
      expect(input.maxAttempts).toBe(1);
      return { FunctionError: "Unhandled", Payload: Buffer.from("{}") };
    }],
    ["malformed body", async (input: Parameters<TaskPersonInviteInvoker>[0]) => {
      expect(input.invocationType).toBe("RequestResponse");
      expect(input.maxAttempts).toBe(1);
      return { Payload: Buffer.from("not-json") };
    }],
    ["misbound response", async (input: Parameters<TaskPersonInviteInvoker>[0], value: TaskPersonInviteClaimRequest) => {
      expect(input.maxAttempts).toBe(1);
      return { Payload: Buffer.from(JSON.stringify({ ...accepted(value), requestId: randomUUID() })) };
    }],
  ])("maps %s to UNKNOWN without throwing", async (_label, reply) => {
    const value = request();
    const invoke = vi.fn((input: Parameters<TaskPersonInviteInvoker>[0]) => reply(input, value));
    const result = await taskPersonInviteThroughLambda({ invoke, now: () => 10_000 })(value);
    expect(result).toMatchObject({ status: "unknown", taskId: value.taskId, requestId: value.requestId,
      claimDigest: value.claimDigest, admissionId: value.admission.id, reason: "transport_unknown" });
  });

  it("does not invoke after the whole admission deadline", async () => {
    const value = request();
    const invoke = vi.fn(async (input: Parameters<TaskPersonInviteInvoker>[0]) => {
      expect(input.abortSignal.aborted).toBe(true);
      return { Payload: Buffer.from(JSON.stringify(accepted(value))) };
    });
    const result = await taskPersonInviteThroughLambda({ invoke, now: () => value.admission.deadlineAt })(value);
    expect(result.status).toBe("unknown");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not trust a response that completes after the deadline", async () => {
    const value = request();
    let clock = 10_000;
    const invoke = vi.fn(async (input: Parameters<TaskPersonInviteInvoker>[0]) => {
      expect(input.invocationType).toBe("RequestResponse");
      clock = value.admission.deadlineAt;
      return { Payload: Buffer.from(JSON.stringify(accepted(value))) };
    });
    const result = await taskPersonInviteThroughLambda({ invoke, now: () => clock })(value);
    expect(result.status).toBe("unknown");
  });
});
