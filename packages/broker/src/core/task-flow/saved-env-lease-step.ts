// Saved project images: the dispatcher's two steps around a rebuild's lease token (in their own file: dispatch.ts's complexity is ratcheted).
//   savedEnvPrecheck     read only, BEFORE admission and before any machine is started: the lease can be handed over (a seam is wired, the job is the project's current one, its lease is live and not another run's).
//                        A refusal ends the operation in words with no machine started; a registry that cannot be read now is a retry, not an end.
//   savedEnvBuildFields  after the machine is ready and the claim holds: TAKES the token and returns the build field with it for this one invocation. The authoritative check (the registry can change between the two).
//                        A refusal ends the operation in words. A lost write race (tried a few times with a short pause) or a registry that cannot be read is NOT an end: it throws a retryable fault, the delivery
//                        comes back, and the stale claim is taken over (the same recovery as any fault after the claim).
// The job is the one the BROKER stored with the operation (`dispatch.payload.savedEnvBuild.jobId`); the project and the company are the workspace's and the dispatcher's own; nothing comes from a request or a worker.
import { PREPARE_SAVED_ENV_BUILD_FEATURE, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord, WorkspaceRecord } from "./records.js";
import { log } from "./support.js";

const SAVED_ENV_LEASE_TRIES = 3;
const SAVED_ENV_LEASE_PAUSE_MS = 50;
const SAVED_ENV_BUILD_NOT_SENT = {
  unavailable: "This install cannot hand a saved image build its lease, so the build was not sent to a worker.",
  ended: "The saved image build's lease has ended or belongs to another run, so the build was not sent to a worker.",
  busy: "The saved image build's lease could not be read or taken just now, so the build was not sent to a worker yet.",
  gaveUp: "The saved image build's lease could not be read after several tries, so the build was not sent to a worker.",
  old: "This worker is too old to build a saved image; upgrade it.",
} as const;
type RefusalWords = (typeof SAVED_ENV_BUILD_NOT_SENT)[keyof typeof SAVED_ENV_BUILD_NOT_SENT];

/** The job id the broker stored with a rebuild's operation, or undefined when the stored build field has none (or is not an object). */
function storedJobId(operation: OperationRecord): string | undefined {
  const stored = operation.dispatch.payload["savedEnvBuild"];
  const jobId = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as { jobId?: unknown }).jobId : undefined;
  return typeof jobId === "string" && jobId !== "" ? jobId : undefined;
}

const wordsOf = (reason: "disabled" | "nothing_to_dispatch" | "stale_write"): RefusalWords => (reason === "disabled" ? SAVED_ENV_BUILD_NOT_SENT.unavailable : SAVED_ENV_BUILD_NOT_SENT.ended);

/**
 * Before anything is started for a rebuild's preparation: nothing for any other operation; for a rebuild, the sentence that ends it (`retry` false), or the sentence of a fault that is tried again (`retry` true), or
 * nothing when the lease can be handed over. Reads only: the token is not taken and nothing is marked.
 */
export async function savedEnvPrecheck(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, mayRetry: boolean): Promise<{ error: string; retry: boolean } | undefined> {
  if (operation.dispatch.payload["savedEnvBuild"] === undefined) return undefined;
  const jobId = storedJobId(operation);
  if (jobId === undefined) return { error: SAVED_ENV_BUILD_NOT_SENT.ended, retry: false };
  if (deps.savedEnvLease === undefined) return { error: SAVED_ENV_BUILD_NOT_SENT.unavailable, retry: false };
  try {
    const answer = await deps.savedEnvLease.check({ projectId: workspace.projectName, jobId, operationId: operation.id });
    if (answer.ok) return undefined;
    log(deps, { event: "task_flow.saved_env_lease_refused", step: "before_start", reason: answer.reason });
    return { error: wordsOf(answer.reason), retry: false };
  } catch {
    log(deps, { event: "task_flow.saved_env_lease_unreadable", step: "before_start" });
    // Tried again later while the delivery's tries last (as the standing-instruction read is); then the operation ends in words, with no machine ever started.
    return mayRetry ? { error: SAVED_ENV_BUILD_NOT_SENT.busy, retry: true } : { error: SAVED_ENV_BUILD_NOT_SENT.gaveUp, retry: false };
  }
}

/** The dispatcher's checks that need no machine: a rebuild's lease first, then whatever `next` reads (the standing instructions). The first sentence that ends or delays the operation wins. */
export async function beforeMachine<T extends { error?: string; retry?: boolean }>(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, mayRetry: boolean, next: () => Promise<T>): Promise<T> {
  return ((await savedEnvPrecheck(deps, operation, workspace, mayRetry)) as T | undefined) ?? next();
}

/**
 * The saved image build of a rebuild's preparation, with its lease token, or the sentence that ends the operation; `{}` for any other preparation. The registry answers only for exactly the stored job, to exactly
 * this operation, while the job's lease is live. Any token the stored payload carried is dropped and replaced by the one the registry gave. Only a worker that lists the build feature is given it.
 */
export async function savedEnvBuildFields(deps: TaskFlowDeps, operation: OperationRecord, workspace: WorkspaceRecord, features: readonly string[]): Promise<{ savedEnvBuild: Record<string, unknown> } | Record<string, never> | string> {
  if (operation.dispatch.payload["savedEnvBuild"] === undefined) return {};
  const jobId = storedJobId(operation);
  if (jobId === undefined) return SAVED_ENV_BUILD_NOT_SENT.ended;
  if (!features.includes(PREPARE_SAVED_ENV_BUILD_FEATURE)) return SAVED_ENV_BUILD_NOT_SENT.old;
  if (deps.savedEnvLease === undefined) return SAVED_ENV_BUILD_NOT_SENT.unavailable;
  for (let attempt = 0; attempt < SAVED_ENV_LEASE_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SAVED_ENV_LEASE_PAUSE_MS * attempt));
    let given: Awaited<ReturnType<NonNullable<TaskFlowDeps["savedEnvLease"]>["take"]>>;
    try {
      given = await deps.savedEnvLease.take({ projectId: workspace.projectName, jobId, operationId: operation.id });
    } catch {
      // A registry that cannot be read now: a fixed word is logged (never what the registry held), and the delivery comes back.
      log(deps, { event: "task_flow.saved_env_lease_unreadable", step: "take" });
      throw agentXError("RUNTIME_UNAVAILABLE", SAVED_ENV_BUILD_NOT_SENT.busy);
    }
    if (given.ok) {
      const { leaseToken: _dropped, ...build } = operation.dispatch.payload["savedEnvBuild"] as Record<string, unknown>;
      void _dropped;
      return { savedEnvBuild: { ...build, leaseToken: given.leaseToken } };
    }
    log(deps, { event: "task_flow.saved_env_lease_refused", step: "take", reason: given.reason });
    if (given.reason !== "stale_write") return wordsOf(given.reason);
  }
  // Only contention: nothing was taken, so the operation is not ended; the delivery comes back.
  throw agentXError("RUNTIME_UNAVAILABLE", SAVED_ENV_BUILD_NOT_SENT.busy);
}
