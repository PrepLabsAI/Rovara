import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  TaskPersonInviteClaimRequestSchema,
  TaskPersonInviteOutcomeSchema,
  type TaskPersonInviteClaimRequest,
  type TaskPersonInviteOutcome,
} from "@agentx/contracts";

export interface TaskPersonInviteInvokeReply { FunctionError?: string; Payload?: Uint8Array }
export type TaskPersonInviteInvoker = (input: {
  invocationType: "RequestResponse";
  maxAttempts: 1;
  payload: Uint8Array;
  abortSignal: AbortSignal;
}) => Promise<TaskPersonInviteInvokeReply>;

function unknown(request: TaskPersonInviteClaimRequest, reason: TaskPersonInviteOutcome["reason"] = "transport_unknown"): TaskPersonInviteOutcome {
  return { taskId: request.taskId, requestId: request.requestId, claimDigest: request.claimDigest,
    admissionId: request.admission.id, status: "unknown", reason };
}

/** Single-attempt transport for the separate invitation endpoint; every ambiguous invoke stays UNKNOWN. */
export function taskPersonInviteThroughLambda(input: { invoke: TaskPersonInviteInvoker; now(): number }) {
  return async (rawRequest: TaskPersonInviteClaimRequest): Promise<TaskPersonInviteOutcome> => {
    const request = TaskPersonInviteClaimRequestSchema.safeParse(rawRequest);
    if (!request.success) {
      return {
        taskId: rawRequest.taskId, requestId: rawRequest.requestId, claimDigest: rawRequest.claimDigest,
        admissionId: rawRequest.admission.id, status: "unknown", reason: "transport_unknown",
      };
    }
    const value = request.data;
    const remaining = Math.min(value.admission.deadlineAt - input.now(), value.admission.remainingMs);
    if (remaining <= 0) return unknown(value);
    try {
      const reply = await input.invoke({ invocationType: "RequestResponse", maxAttempts: 1, payload: Buffer.from(JSON.stringify(value), "utf8"),
        abortSignal: AbortSignal.timeout(remaining) });
      if (input.now() >= value.admission.deadlineAt || reply.FunctionError !== undefined || reply.Payload === undefined) return unknown(value);
      const decoded: unknown = JSON.parse(Buffer.from(reply.Payload).toString("utf8"));
      const outcome = TaskPersonInviteOutcomeSchema.safeParse(decoded);
      if (!outcome.success || outcome.data.taskId !== value.taskId || outcome.data.requestId !== value.requestId
        || outcome.data.claimDigest !== value.claimDigest || outcome.data.admissionId !== value.admission.id
        || input.now() >= value.admission.deadlineAt) return unknown(value);
      return outcome.data;
    } catch {
      return unknown(value);
    }
  };
}

/** Creates a distinct one-attempt Lambda client for the optional invitation endpoint. */
export function createTaskPersonInviteLambdaInvoker(functionName: string, region?: string): TaskPersonInviteInvoker {
  const client = new LambdaClient({ ...(region === undefined ? {} : { region }), maxAttempts: 1 });
  return async ({ invocationType, maxAttempts, payload, abortSignal }) => {
    if (functionName.trim() === "" || invocationType !== "RequestResponse" || maxAttempts !== 1) throw new Error("invite endpoint is not configured");
    const response = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: invocationType, Payload: payload }), { abortSignal });
    return { ...(response.FunctionError === undefined ? {} : { FunctionError: response.FunctionError }),
      ...(response.Payload === undefined ? {} : { Payload: response.Payload }) };
  };
}
