import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";

export const TASK_AUTHORITY_MAX_MS = 6_000;
export const TASK_AUTHORITY_CONTEXT_RESERVE_MS = 2_000;
export const TASK_AUTHORITY_MAX_STATE_READS = 128;
export const TASK_AUTHORITY_MAX_SLACK_CALLS = 100;
export const TASK_AUTHORITY_MAX_IDENTITIES = 100;

const HEX64 = /^[a-f0-9]{64}$/;
const unavailable = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");

export interface TaskAuthorityAdmission {
  /** Correlates every remote proof issued under this one guard; never changes during retries. */
  readonly id: string;
  readonly deadlineAt: number;
  assertOpen(): void;
  remainingMs(): number;
  /** Counts a read before issuance and returns the SDK abort signal for its remaining budget. */
  admitStateRead(): AbortSignal;
  remainingStateReads(): number;
  admitIdentity(developerId: string): void;
  checkedIdentityCount(): number;
  remainingSlackCalls(): number;
  recordSlackUsage(calls: number): void;
  close(): void;
}

export function createTaskAuthorityAdmission(input: { now(): number; lambdaRemainingMs: number }): TaskAuthorityAdmission {
  const id = randomUUID();
  const startedAt = input.now();
  const safeLambdaRemaining = Number.isFinite(input.lambdaRemainingMs) ? Math.max(0, input.lambdaRemainingMs) : 0;
  const deadlineAt = Math.min(startedAt + TASK_AUTHORITY_MAX_MS, startedAt + safeLambdaRemaining - TASK_AUTHORITY_CONTEXT_RESERVE_MS);
  let stateReadsLeft = TASK_AUTHORITY_MAX_STATE_READS;
  let slackCallsLeft = TASK_AUTHORITY_MAX_SLACK_CALLS;
  const identities = new Set<string>();
  let closed = false;

  const assertOpen = () => {
    if (closed || input.now() >= deadlineAt) {
      closed = true;
      throw unavailable();
    }
  };
  const remainingMs = () => Math.max(0, Math.floor(deadlineAt - input.now()));
  const admitStateRead = () => {
    assertOpen();
    if (stateReadsLeft <= 0) {
      closed = true;
      throw unavailable();
    }
    stateReadsLeft -= 1;
    const remaining = remainingMs();
    if (remaining <= 0) {
      closed = true;
      throw unavailable();
    }
    return AbortSignal.timeout(remaining);
  };
  const admitIdentity = (developerId: string) => {
    assertOpen();
    if (!HEX64.test(developerId)) {
      closed = true;
      throw unavailable();
    }
    identities.add(developerId);
    if (identities.size > TASK_AUTHORITY_MAX_IDENTITIES) {
      closed = true;
      throw unavailable();
    }
  };
  const recordSlackUsage = (calls: number) => {
    assertOpen();
    if (!Number.isSafeInteger(calls) || calls < 0 || calls > slackCallsLeft) {
      closed = true;
      throw unavailable();
    }
    slackCallsLeft -= calls;
  };

  return {
    id,
    deadlineAt,
    assertOpen,
    remainingMs,
    admitStateRead,
    remainingStateReads: () => stateReadsLeft,
    admitIdentity,
    checkedIdentityCount: () => identities.size,
    remainingSlackCalls: () => slackCallsLeft,
    recordSlackUsage,
    close() { closed = true; },
  };
}
