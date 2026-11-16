import {
  TaskDispatchProofRequestSchema,
  TaskDispatchProofResponseSchema,
  SlackTeamIdSchema,
  agentXError,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";
import type { TaskAuthorityAdmission } from "./task-authority-admission.js";

export interface TaskPersonProofInvokeResponse {
  FunctionError?: string;
  Payload?: Uint8Array;
}

export type TaskPersonProofInvoker = (payload: Uint8Array, options: { abortSignal: AbortSignal }) => Promise<TaskPersonProofInvokeResponse>;

const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");

/** Invokes only the dedicated proof Lambda. Every malformed, late, unmetered, or misbound result seals this guard. */
export function taskPersonProofThroughLambda(input: {
  invoke: TaskPersonProofInvoker;
  admission: TaskAuthorityAdmission;
  now(): number;
  expectedTeamId: string;
}): (request: TaskPersonProofRequest) => Promise<{ result: TaskPersonProofResponse; slackCallsUsed: number }> {
  return async (request) => {
    const fail = (): never => {
      input.admission.close();
      throw unavailable();
    };
    try {
      input.admission.assertOpen();
      if (!SlackTeamIdSchema.safeParse(input.expectedTeamId).success) return fail();
      const remainingMs = input.admission.remainingMs();
      const slackCallsLimit = input.admission.remainingSlackCalls();
      if (remainingMs < 1 || slackCallsLimit < 1) return fail();
      const envelope = TaskDispatchProofRequestSchema.parse({
        kind: "task-dispatch-person-proof",
        request,
        admission: {
          version: 1,
          id: input.admission.id,
          deadlineAt: input.admission.deadlineAt,
          remainingMs: Math.min(6_000, remainingMs),
          slackCallsLimit: Math.min(100, slackCallsLimit),
        },
      });
      const reply = await input.invoke(Buffer.from(JSON.stringify(envelope), "utf8"), { abortSignal: AbortSignal.timeout(remainingMs) });
      input.admission.assertOpen();
      if (reply.FunctionError !== undefined || reply.Payload === undefined) return fail();
      const decoded: unknown = JSON.parse(Buffer.from(reply.Payload).toString("utf8"));
      const parsed = TaskDispatchProofResponseSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.admissionId !== input.admission.id
        || parsed.data.usage.completedAt > input.admission.deadlineAt
        || parsed.data.usage.completedAt > input.now()
        || parsed.data.usage.slackCallsUsed > slackCallsLimit
        || parsed.data.usage.slackCallsUsed === 0 && (parsed.data.result.ok
          || (!parsed.data.result.ok && parsed.data.result.error === "ineligible"))) return fail();
      if (parsed.data.result.ok && (parsed.data.result.user.id !== request.slackUserId
        || parsed.data.result.user.teamId !== input.expectedTeamId
        || new Set(parsed.data.result.memberOf).size !== parsed.data.result.memberOf.length
        || parsed.data.result.memberOf.some((channelId) => !request.channelIds.includes(channelId)))) return fail();
      input.admission.assertOpen();
      return { result: parsed.data.result, slackCallsUsed: parsed.data.usage.slackCallsUsed };
    } catch {
      return fail();
    }
  };
}
