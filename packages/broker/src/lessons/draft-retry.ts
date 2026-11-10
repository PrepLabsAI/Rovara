// One bounded retry of a draft's curate-and-settle step (`processDraft`) for a passing store fault. Before this, a draft whose step failed was lost: the reflection that made it is final (its model call was
// paid for and is never repeated), so nothing ever tried the draft again.
//
// The money rule comes first. The curate step can make a paid judge call of its own, and the customer pays for every call. So a draft is tried again only when ALL of these hold:
//   - the failed try started no paid judge call: the judge model handed to it is counted, and a call that was started (whatever came of it: an answer, a refusal, an error) means no retry. That is stricter than the
//     worker's lease rule on purpose: here a call that failed early cannot be told from one that reached the provider. (Our own embedder is not a paid call and may be asked again.);
//   - the fault is a passing one of the store: throttling, a 5xx, a transaction conflict, a timeout. A refused write, a validation fault or a bug is final;
//   - inside a worker attempt, the deadline has not passed (the signal is not aborted) and at least `DRAFT_RETRY_MIN_LEFT_MS` is left.
// Only one retry.
//
// A retry must not do again what the failed try already did. The two steps are kept apart, so a retry resumes where the failure was:
//   - a fault in the SETTLE step (the lesson was already added or merged by the curate step): only settle runs again, with the curate step's answer; the lesson is not curated (merged into itself) a second time;
//   - a fault in the CURATE step: it runs again only if nothing of it was written (no commit answered ok, and none of the lesson ids it made is in the store; the store failing to say counts as written). A step that wrote
//     and then failed is never run again: a repeat would curate the draft a second time, and two cards would reach people for one draft;
//   - audit lines the failed try already wrote (same action, same lesson) are not written again by the retry;
//   - the draft's sources and the project's volume are counted once: a retry of the curate step skips the count when the failed try already made it.
import { curateDraft, defaultLessonId, type CurateOutcome } from "./curate.js";
import { currentLearningAttempt } from "./learning-deadline.js";
import type { LessonAuditEvent, LessonAuditSink, PipelineModel } from "./ports.js";
import { settleLesson, settleOptionsOf, type ProcessDeps, type ProcessResult } from "./process.js";
import type { LessonDraft } from "./reflect.js";
import type { ScopeKey } from "./store.js";

/** In a worker attempt, a retry needs at least this much of the deadline left (a curate step with a judge call can take several seconds). */
export const DRAFT_RETRY_MIN_LEFT_MS = 5_000;
/** The wait before the retry: a throttled table is given a moment. */
export const DRAFT_RETRY_WAIT_MS = 250;

const PASSING_FAULTS: ReadonlySet<string> = new Set([
  "ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "TooManyRequestsException", "InternalServerError", "InternalFailure",
  "ServiceUnavailable", "ServiceUnavailableException", "TransactionConflictException", "TimeoutError", "RequestTimeout", "RequestTimeoutException",
]);

/** Whether a store fault is a passing one worth a second try. Names and statuses only: the fault's own words are never read. */
export function isPassingStoreFault(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const fault = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof fault.name === "string" && PASSING_FAULTS.has(fault.name)) return true;
  const status = fault.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

export interface DraftRetryOptions {
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
  /** The wait before the retry (default: a timer of `DRAFT_RETRY_WAIT_MS`). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** The curate step (default `curateDraft`). A seam for tests of the guard below. */
  curate?: ((deps: ProcessDeps, key: ScopeKey, draft: LessonDraft) => Promise<CurateOutcome>) | undefined;
}

/** The key an audit line is told apart by: what happened to which lesson. */
const auditKey = (event: LessonAuditEvent): string => `${event.action}|${event.lessonId ?? ""}`;

/** `processDraft`, with the one bounded retry above. Throws the last fault, as `processDraft` does. */
export async function processDraftRetrying(deps: ProcessDeps, key: ScopeKey, draft: LessonDraft, options: DraftRetryOptions = {}): Promise<ProcessResult> {
  let modelCalls = 0, committed = false;
  const noted = new Set<string>();
  const madeIds: string[] = [];
  /** Every lesson version a commit of this try was asked to write: a commit whose answer was lost may still have landed (a merge makes no new id, so the version is what shows it). */
  const asked: Array<{ id: string; version: number }> = [];
  const curate = options.curate ?? curateDraft;
  const written = new Set<string>();
  const judge: PipelineModel = deps.judgeModel;
  const store = new Proxy(deps.store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      // A commit's own answer is the fact: a commit that said ok landed. (Set after the call returned, so a commit that threw is not counted here; the lesson ids below cover an answer that was lost.)
      if (property === "commit") return async (...args: unknown[]) => { for (const lesson of (args[2] as Array<{ id: string; version: number }> | undefined) ?? []) asked.push({ id: lesson.id, version: lesson.version }); const result = await method(...args); if ((result as { ok?: boolean } | undefined)?.ok !== false) committed = true; return result; };
      // A count is "made" only once the write returned: a fault in it leaves it to the retry.
      if (property === "recordSourceEvent") return async (...args: unknown[]) => { const result = await method(...args); noted.add(String((args[1] as { source?: unknown } | undefined)?.source)); return result; };
      return method;
    },
  });
  const audit: LessonAuditSink = {
    emit: async (event, emitOptions) => { await deps.audit.emit(event, emitOptions); written.add(auditKey(event)); },
    ...(deps.audit.stage === undefined ? {} : { stage: (event: LessonAuditEvent) => deps.audit.stage!(event) }),
  };
  const first: ProcessDeps = {
    ...deps, store, audit,
    // The ids this try gave to new lessons: whether any of them is in the store says, from the store itself, whether the step's write landed.
    newId: () => { const id = (deps.newId ?? defaultLessonId)(); madeIds.push(id); return id; },
    judgeModel: {
      ...(judge.quote === undefined ? {} : { quote: (request) => judge.quote!(request) }),
      complete: (request) => { modelCalls += 1; return judge.complete(request); },
    },
  };
  let step: "curate" | "settle" = "curate";
  let retrying = false;
  let outcome: CurateOutcome | undefined;
  const settle = async (using: ProcessDeps): Promise<ProcessResult> => {
    step = "settle";
    if (outcome === undefined || outcome.outcome === "dropped") return { outcome: outcome! };
    const lesson = await settleLesson(using, key, outcome.lesson.id, { ...settleOptionsOf(outcome), ...(retrying ? { resume: true } : {}) });
    return lesson === undefined ? { outcome } : { outcome, lesson };
  };
  try {
    outcome = await curate(first, key, draft);
    step = "settle";
    return await settle(first);
  } catch (error) {
    if (modelCalls > 0 || !isPassingStoreFault(error)) throw error;
    // A curate step that wrote something and then failed is never run again: its repeat would curate the draft a second time (a second card for one draft). The writes are known from the commits' own answers and
    // from the store (a lesson this try made, whose commit's answer may have been lost).
    if (step === "curate" && (committed || await anyStored(deps, key, madeIds, asked))) throw error;
    const attempt = currentLearningAttempt();
    if (attempt !== undefined && (attempt.signal?.aborted === true || (attempt.deadlineAt - (options.now ?? Date.now)()) < DRAFT_RETRY_MIN_LEFT_MS)) throw error;
    options.log?.("learning.draft_retried", {});
    retrying = true;
    await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(DRAFT_RETRY_WAIT_MS);
    if (attempt?.signal?.aborted === true) throw error;
    const again: ProcessDeps = {
      ...deps, ...(noted.size === 0 ? {} : { alreadyNoted: noted }),
      // A line the failed try wrote is not written again (the retry is told it succeeded).
      audit: { emit: async (event, emitOptions) => { if (!written.has(auditKey(event))) await deps.audit.emit(event, emitOptions); }, ...(deps.audit.stage === undefined ? {} : { stage: (event: LessonAuditEvent) => deps.audit.stage!(event) }) },
    };
    if (step === "curate") {
      outcome = await curate(again, key, draft);
    }
    return settle(again);
  }
}

/**
 * True when the store holds a lesson this try made, or a version a commit of this try asked it to write (the answer of that commit may have been lost), or when the store cannot say (then the step is not repeated:
 * never on doubt).
 */
async function anyStored(deps: ProcessDeps, key: ScopeKey, ids: readonly string[], asked: ReadonlyArray<{ id: string; version: number }>): Promise<boolean> {
  try {
    for (const id of ids) if (await deps.store.get(key, id) !== undefined) return true;
    for (const { id, version } of asked) { const stored = await deps.store.get(key, id); if (stored !== undefined && stored.version >= version) return true; }
  } catch { return true; }
  return false;
}
