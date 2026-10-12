import {
  TaskDispatchProofRequestSchema,
  TaskDispatchProofResponseSchema,
  TaskPersonProofResponseSchema,
  SlackTeamIdSchema,
  agentXError,
  type TaskDispatchProofResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
} from "@agentx/contracts";

export interface TaskPersonProofReadAdmission {
  readonly deadlineAt: number;
  readonly slackCallsLimit: number;
  readonly abortSignal: AbortSignal;
}

export interface TaskPersonProofHandlerPorts {
  now(): number;
  remainingTimeMs(): number;
  /** Server-owned expected team; never accepted from the request. */
  expectedTeamId: string;
  /** Fresh, metered Slack users.info plus complete conversations.members reads only. */
  readProof(request: TaskPersonProofRequest, admission: TaskPersonProofReadAdmission): Promise<{ result: TaskPersonProofResponse; slackCallsUsed: number }>;
}

const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");

/** Internal Lambda handler factory. It accepts only the correlated proof envelope and never resolves credentials itself. */
export function createTaskPersonProofHandler(ports: TaskPersonProofHandlerPorts) {
  return async (event: unknown): Promise<TaskDispatchProofResponse> => {
    const parsed = TaskDispatchProofRequestSchema.safeParse(event);
    if (!parsed.success || !SlackTeamIdSchema.safeParse(ports.expectedTeamId).success) throw unavailable();
    const request = parsed.data;
    const now = ports.now();
    const lambdaDeadline = now + Math.max(0, ports.remainingTimeMs() - 250);
    const requestedDeadline = Math.min(request.admission.deadlineAt, now + request.admission.remainingMs);
    const deadlineAt = Math.min(requestedDeadline, lambdaDeadline);
    const slackCallsLimit = Math.min(request.admission.slackCallsLimit, 100);
    if (deadlineAt <= now || slackCallsLimit <= 0) throw unavailable();

    let measured: { result: TaskPersonProofResponse; slackCallsUsed: number };
    try {
      measured = await ports.readProof(request.request, { deadlineAt, slackCallsLimit, abortSignal: AbortSignal.timeout(deadlineAt - now) });
    } catch {
      throw unavailable();
    }
    const completedAt = ports.now();
    const result = TaskPersonProofResponseSchema.safeParse(measured.result);
    if (!result.success || !Number.isSafeInteger(measured.slackCallsUsed) || measured.slackCallsUsed < 0
      || measured.slackCallsUsed > slackCallsLimit || completedAt > deadlineAt
      || ((result.data.ok || (!result.data.ok && result.data.error === "ineligible")) && measured.slackCallsUsed === 0)) throw unavailable();
    if (result.data.ok && (result.data.user.id !== request.request.slackUserId
      || result.data.user.teamId !== ports.expectedTeamId
      || new Set(result.data.memberOf).size !== result.data.memberOf.length
      || result.data.memberOf.some((channelId) => !request.request.channelIds.includes(channelId)))) throw unavailable();
    const response: TaskDispatchProofResponse = {
      kind: "task-dispatch-person-proof-result",
      admissionId: request.admission.id,
      usage: { slackCallsUsed: measured.slackCallsUsed, completedAt },
      result: result.data,
    };
    const strictResponse = TaskDispatchProofResponseSchema.safeParse(response);
    if (!strictResponse.success) throw unavailable();
    return strictResponse.data;
  };
}
