// The time and the identity of one reflection attempt. The worker runs a reflection inside `withLearningAttempt`:
//   - `deadlineAt` / `signal`: the model path (`local/app/lessons-model.ts`) asks `learningCallMayStart` before it mints a key, and a call that could still be running at the deadline is refused (nothing is
//     reserved, nothing is charged), and asks again right before the call itself. The signal is aborted at the deadline and goes into the model call, which stops OUR WAIT for it: the in-VPC function and its request to the
//     provider are not stopped and may run on for up to ~100 s (and be billed), so an aborted call counts as made. The lesson store's writes are refused once it is aborted (`deadlineGuardedClient`);
//   - `attemptId` / `leaseKey`: every model key the attempt mints is tagged with the attempt and noted on the reflection's lease item, so a later worker can tell, from the spend ledger, whether the earlier attempt
//     spent anything before it decides whether the work may run again;
//   - `callStarting` / `callNotSent` (re-check): right before the model call the path marks the lease ("a call may now reach the provider"); from then on the reflection is never run again, whatever the key settles at,
//     unless the in-VPC client says it sent nothing (`callNotSent` takes the mark back);
//   - `fault`: how the attempt's model path failed (retryable: the failure came before the call started, so nothing was sent; final: a refusal, or any failure after the call started). The reflector turns every model
//     failure into a fixed reason, so this is how the worker learns whether a "dropped" reflection is worth another try;
//   - `lastAttempt`: a retryable fault of the last attempt is the reflection's end, so only then does it count toward the project's failure pause (`reflect.ts`): one task's retries cannot trip it.
// Outside the worker (the broker, tests) there is no attempt and no deadline.
import { AsyncLocalStorage } from "node:async_hooks";

export interface LearningAttempt {
  /** Epoch milliseconds. */
  deadlineAt: number;
  /** Aborted at the deadline. */
  signal?: AbortSignal;
  /** This attempt's id; the model keys it mints carry it in their operation id. */
  attemptId?: string;
  /** The lease item the attempt's model keys are noted on (`modelKeyIds`). */
  leaseKey?: { pk: string; sk: string };
  /** How the attempt's model path failed, when it did: the most severe fault it was told (final beats retryable). */
  fault?: "retryable" | "final";
  /** Writes the lease's `callStartedAt` (conditional on this attempt). Throws when it cannot: the call is then not made. */
  callStarting?: () => Promise<void>;
  /** Takes `callStartedAt` back after the in-VPC client refused before sending anything. Throws when it cannot: the call then stays counted as made. */
  callNotSent?: () => Promise<void>;
  /** This is the last attempt the lease allows. */
  lastAttempt?: boolean;
}

const storage = new AsyncLocalStorage<LearningAttempt>();

/** Runs `work` with a deadline (epoch milliseconds). */
export const withLearningDeadline = <T>(deadlineAt: number, work: () => Promise<T>): Promise<T> => storage.run({ deadlineAt }, work);

/** Runs `work` as one attempt (the worker). The attempt object is the caller's, so it can read `fault` afterwards. */
export const withLearningAttempt = <T>(attempt: LearningAttempt, work: () => Promise<T>): Promise<T> => storage.run(attempt, work);

/** The attempt in progress, if the code runs inside one. */
export const currentLearningAttempt = (): LearningAttempt | undefined => storage.getStore();

/** Whether a model call that may take `waitMs` can start now and be over by the deadline. True where there is no deadline; false once the signal is aborted. */
export function learningCallMayStart(now: number, waitMs: number): boolean {
  const attempt = storage.getStore();
  if (attempt === undefined) return true;
  if (attempt.signal?.aborted === true) return false;
  return now + waitMs <= attempt.deadlineAt;
}

/** The model path says how its failure should be read. A no-op outside an attempt. The attempt keeps the MOST SEVERE fault it was told (final beats retryable): a later call's retryable fault never hides an earlier call's final one. */
export function noteLearningFault(fault: "retryable" | "final"): void {
  const attempt = storage.getStore();
  if (attempt !== undefined && attempt.fault !== "final") attempt.fault = fault;
}
