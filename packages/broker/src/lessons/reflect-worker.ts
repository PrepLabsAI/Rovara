// The LessonsWorker's work. One queue message is one finished task (`reflect-queue.ts`). The worker:
//   1. reads the message (anything that is not exactly the four ids is dropped with one fixed log line: a poison message must never be retried or hold the queue);
//   2. takes the lease on `LEARN#<org>#<task>#<outcome>` (`reflect-claims.ts`): a redelivery, a second task-end call or the nightly re-send never runs the model twice. A fault from BEFORE the model call (a read, the mint,
//      the deadline) leaves the lease at `retry` and the next take runs the work again. Once the call has started (the lease carries `callStartedAt`, written just before it) the reflection is spent: never run again,
//      whatever the key settles at (re-check);
//   3. runs `learnFromEndedTaskTyped` as one attempt (`learning-deadline.ts`): no model call starts that could still be running at the deadline, the deadline's abort signal goes into the model call (it stops OUR WAIT;
//      the in-VPC function and the provider request may run on, so an aborted call counts as made), the lesson store stops writing once it is aborted, and a race gives up a little after it as the last guard;
//   4. ends the lease: `done` for every final outcome, `retry` for a typed retryable fault (or the deadline).
// A message that must come back (a retry, a lease it must wait for, a claim that could not be made) is answered as a batch item failure, with a visibility backoff of 60 s, 300 s, then 900 s instead of the queue's whole
// 1800 s; the queue sends it to its dead-letter queue (which alarms) after five receives. Five receives fit three attempts in the normal case (about two waits for the first attempt's key, one for each later one); an `exhausted` answer writes
// no final state and uses one or two more receives before the dead-letter queue, on purpose: the alarm on that queue is the signal. A sweep that cannot read a key's spend leaves the lease at `retry` and can run the
// receives out; the message is then in the dead-letter queue and can be redriven. The metric is the `lessons_worker.result` line, one per message, with a fixed class and a fixed kind (`reflection` or `human_edit`).
import { LESSONS_REFLECT_MAX_ATTEMPTS, LESSONS_REFLECT_RETRY_BACKOFF_SECONDS } from "@agentx/contracts";
import { withLearningAttempt, type LearningAttempt } from "./learning-deadline.js";
import { logRef } from "./log-ref.js";
import type { HumanEditJob } from "./capture-types.js";
import { CLAIM_TTL_SECONDS, type ClaimStore, type LeaseTarget } from "./reflect-claims.js";
import { humanEditJobOf, humanEditLeaseOutcome, parseHumanEditMessage, parseReflectMessage, type ReflectMessage, type ReflectVisibility } from "./reflect-queue.js";
import type { LearnResult, LearnStatus } from "./task-end.js";

export { CLAIM_TTL_SECONDS };
export type { ClaimStore };

/** The worker keeps this much of the invocation's time for ending the lease and answering (the deadline is the invocation's remaining time less this). */
export const WORKER_RESERVE_MS = 60_000;
/** The race gives up this long after the abort signal, so the work can stop by itself first. */
export const DEADLINE_GRACE_MS = 10_000;

export interface ReflectWorkerDeps {
  claims: ClaimStore;
  learn(input: { workspaceId: string; taskId: string; outcome: ReflectMessage["outcome"] }): Promise<LearnResult>;
  /**
   * Lessons capture: a human fix-up commit (a sibling message on the same queue). It runs under the same lease, deadline, attempt and model rules as a reflection (it is a learning model call: never paid twice). Without it a
   * human-edit message is a misconfiguration: it is not answered, so it comes back and ends in the dead-letter queue, which alarms.
   */
  humanEdit?(job: HumanEditJob): Promise<LearnResult>;
  now(): number;
  /** The reflection stops being started this long after the worker began it (default: the contracts' 240 s), or sooner when the invocation has less time left. */
  deadlineMs: number;
  graceMs?: number;
  /** Where a retry's backoff is set; without it a retry waits the queue's visibility timeout. */
  visibility?: ReflectVisibility;
  log(event: string, fields: Record<string, string | number>): void;
}

export type ReflectResult = LearnStatus | "invalid" | "already" | "wait" | "exhausted" | "timed_out" | "failed" | "no_time";
/** `retry`: the message must come back (a batch item failure). */
export interface ReflectOutcome { result: ReflectResult; retry: boolean; retryAt?: number }

export interface WorkerContext { getRemainingTimeInMillis?: () => number }

export async function runReflectMessage(deps: ReflectWorkerDeps, body: string, context?: WorkerContext): Promise<ReflectOutcome> {
  const edit = parseHumanEditMessage(body);
  const reflection = edit === undefined ? parseReflectMessage(body) : undefined;
  if (edit === undefined && reflection === undefined) {
    deps.log("lessons_worker.invalid_message", {});
    return { result: "invalid", retry: false };
  }
  // Which kind of message this is, in the result line (fixed words: an operator reading the dead-letter alarm can tell a human edit from a reflection).
  const kind = edit !== undefined ? "human_edit" : "reflection";
  // What the lease is on (a reflection: the task's end; a human edit: the task's head commit) and the work it guards.
  const message: LeaseTarget = edit !== undefined ? { orgId: edit.orgId, taskId: edit.taskId, outcome: humanEditLeaseOutcome(edit) } : { orgId: reflection!.orgId, taskId: reflection!.taskId, outcome: reflection!.outcome };
  if (edit !== undefined && deps.humanEdit === undefined) {
    deps.log("lessons_worker.result", { class: "human_edit_unavailable", kind, task: logRef(edit.orgId, edit.taskId) });
    return { result: "failed", retry: true };
  }
  const remaining = context?.getRemainingTimeInMillis?.();
  const deadlineMs = remaining === undefined ? deps.deadlineMs : Math.min(deps.deadlineMs, remaining - WORKER_RESERVE_MS);
  if (deadlineMs <= 0) {
    deps.log("lessons_worker.result", { class: "no_time", kind });
    return { result: "no_time", retry: true };
  }
  const taken = await deps.claims.take(message, deps.now());
  if (taken.kind !== "taken") {
    deps.log("lessons_worker.result", { class: taken.kind, kind, task: logRef(message.orgId, message.taskId) });
    return taken.kind === "already" ? { result: "already", retry: false } : { result: taken.kind, retry: true };
  }
  const { lease } = taken;
  const startedAt = deps.now();
  const controller = new AbortController();
  // The reflector and the curator's judge share this one lease. The mark is a count of the calls this attempt started and did not take back: it is written by each call and removed only when the last one is taken
  // back, so a later call's "not forwarded" never erases the mark an earlier call (which did reach the provider) wrote. The steps run one at a time, so two calls cannot interleave their writes.
  let startedCalls = 0;
  let marking: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(step: () => Promise<T>): Promise<T> => { const run = marking.then(step, step); marking = run.catch(() => undefined); return run; };
  const attempt: LearningAttempt = {
    deadlineAt: startedAt + deadlineMs, signal: controller.signal, attemptId: lease.attemptId, leaseKey: lease.key, lastAttempt: lease.attempt >= LESSONS_REFLECT_MAX_ATTEMPTS,
    callStarting: () => inTurn(async () => {
      // Every call writes the mark (it is conditional on this attempt still holding the lease, so a lost lease stops the call). A write that fails means this call is not made (not counted); a mark an earlier call wrote stands.
      await deps.claims.markCallStarted(lease, deps.now());
      startedCalls += 1;
    }),
    callNotSent: () => inTurn(async () => {
      // Only this call's own share is undone. The lease's mark goes when no started call is left; a removal that fails leaves the call counted as made.
      if (startedCalls > 1) { startedCalls -= 1; return; }
      await deps.claims.clearCallStarted(lease);
      startedCalls = 0;
    }),
  };
  let abortTimer: ReturnType<typeof setTimeout> | undefined, raceTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome: LearnResult;
  let result: ReflectResult;
  try {
    abortTimer = setTimeout(() => controller.abort(), deadlineMs);
    const timedOut = new Promise<"timed_out">((resolve) => { raceTimer = setTimeout(() => resolve("timed_out"), deadlineMs + (deps.graceMs ?? DEADLINE_GRACE_MS)); });
    const done = withLearningAttempt(attempt, () => (edit !== undefined ? deps.humanEdit!(humanEditJobOf(edit)) : deps.learn({ workspaceId: reflection!.orgId, taskId: reflection!.taskId, outcome: reflection!.outcome })));
    // The loser of the race keeps running without anyone waiting for it; its own failure must not become an unhandled rejection.
    done.catch(() => undefined);
    const first = await Promise.race([done, timedOut]);
    if (first === "timed_out") {
      // The last guard: the work did not stop by itself. A fault, not a normal end (the lesson store refuses its writes once the signal is aborted).
      deps.log("lessons_worker.deadline", { task: logRef(message.orgId, message.taskId) });
      outcome = { status: "not_reflected", retry: true };
      result = "timed_out";
    } else {
      outcome = first;
      result = first.status;
    }
  } catch {
    deps.log("lessons_worker.failed", { task: logRef(message.orgId, message.taskId) });
    outcome = { status: "not_reflected", retry: true };
    result = "failed";
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (raceTimer !== undefined) clearTimeout(raceTimer);
    // Whatever is still running past this point finds the signal aborted.
    controller.abort();
  }
  try {
    await deps.claims.finish(lease, outcome.retry ? "retry" : "done", deps.now());
  } catch {
    // The lease stays `running`; once it lapses the next take decides by the model keys (nothing spent: tried again; spent: never).
    deps.log("lessons_worker.finish_failed", { task: logRef(message.orgId, message.taskId) });
  }
  deps.log("lessons_worker.result", { class: outcome.retry ? "retry" : result === "timed_out" || result === "failed" ? result : outcome.status, kind, task: logRef(message.orgId, message.taskId), attempt: lease.attempt });
  return { result, retry: outcome.retry, ...(outcome.retry && outcome.retryAt !== undefined ? { retryAt: outcome.retryAt } : {}) };
}

export interface QueueBatch { Records: Array<{ messageId: string; body: string; receiptHandle?: string; attributes?: { ApproximateReceiveCount?: string } }> }

/** The wait before a message that must come back is visible again, by how many times it has been received. */
export const retryDelaySeconds = (receiveCount: number): number => LESSONS_REFLECT_RETRY_BACKOFF_SECONDS[Math.min(Math.max(receiveCount, 1), LESSONS_REFLECT_RETRY_BACKOFF_SECONDS.length) - 1]!;

/** The longest a host's own retry time may hold a message back (the last of the backoff steps): a longer wait is left to the queue's receive count and the dead-letter queue. */
const HOST_RETRY_WAIT_MAX_SECONDS = 900;

/** The wait before a retry: the backoff of its receive count, or the time the host gave when that is later (whole seconds, capped). */
export function retryDelayFor(receiveCount: number, retryAt: number | undefined, now: number): number {
  const backoff = retryDelaySeconds(receiveCount);
  if (retryAt === undefined) return backoff;
  return Math.max(backoff, Math.min(HOST_RETRY_WAIT_MAX_SECONDS, Math.ceil((retryAt - now) / 1000)));
}

/** The partial-batch answer a queue consumer reads: a message comes back when it must be tried again, when it waits for the ledger, or when its lease could not be taken. */
export async function handleReflectBatch(deps: ReflectWorkerDeps, event: QueueBatch, context?: WorkerContext): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    let comeBack: boolean;
    let retryAt: number | undefined;
    try {
      const ran = await runReflectMessage(deps, record.body, context);
      comeBack = ran.retry;
      retryAt = ran.retryAt;
    } catch {
      deps.log("lessons_worker.claim_failed", {});
      deps.log("lessons_worker.result", { class: "claim_failed" });
      comeBack = true;
    }
    if (!comeBack) continue;
    batchItemFailures.push({ itemIdentifier: record.messageId });
    if (deps.visibility !== undefined && record.receiptHandle !== undefined) {
      try { await deps.visibility.delay(record.receiptHandle, retryDelayFor(Number(record.attributes?.ApproximateReceiveCount ?? "1") || 1, retryAt, deps.now())); } catch { deps.log("lessons_worker.backoff_failed", {}); }
    }
  }
  return { batchItemFailures };
}
