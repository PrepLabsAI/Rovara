// The terminal-task hook. When a task ends (the one place every end goes through), and only when the project's learning mode allows
// reflection, the finished task becomes a reflector subject built from the REAL sources of who did what (`task-subject.ts`): the task record says who started it, the Team record's
// rows say who sent it back and who reverted it. The subject goes to the reflector, and each draft to the curate-and-settle pipeline (`processDraft`, with one bounded retry for a passing store fault before any model call: `draft-retry.ts`).
//
//  - Behind the switch: the project's learning mode is read first (`resolveLearning`, which fails closed to Off); Off and Collect reflect nothing and read nothing more.
//  - Absent unless wired: the handler exists only where the broker was given `learning` dependencies (the model, store, vectors, spend, directory and the task-side facts). Where it
//    was not, nothing is registered and the end of a task is exactly what it was.
//  - Never in the way: the hook never throws and never delays an end beyond its own awaited work; a failure is a fixed log line and the task has ended all the same.
//  - The task-side facts come from a `TaskSubjectSource` (intent, plan and review spans, trusts, links, the commits, the start fields). Where it gives nothing the hook does nothing.
import { randomUUID } from "node:crypto";
import { LESSONS_BROKER_MODEL_WAIT_SECONDS } from "@agentx/contracts";
import { learningCaps, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { currentLearningAttempt, learningCallMayStart, withLearningAttempt } from "./learning-deadline.js";
import { looksLikeCorrection } from "./correction-filter.js";
import { looksQuoted } from "./guards.js";
import { logRef } from "./log-ref.js";
import { recordTaskOutcome, type CounterDeps, type TaskCorrection } from "./counters.js";
import { processDraftRetrying } from "./draft-retry.js";
import { newTaskFailureTally, withFailuresCountedOnce, type TaskFailureTally } from "./pause.js";
import type { ProcessDeps } from "./process.js";
import { isEvalRunMark } from "./eval-run.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";
import type { ReflectQueue } from "./reflect-queue.js";
import { attachCapLadder, noteTaskHeld, readTaskHeld, reflectRepoOnly, type RepoChangeRequest } from "./repo-reflect.js";
import type { OutcomeRowReader } from "./task-outcome-rows.js";
import { lessonTaskRefs } from "./live-visibility.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { sameId } from "./types.js";
import { buildTaskReflectSubject, type SendBackFact, type TaskSubjectFacts } from "./task-subject.js";

/** How a task ended, as lessons hear of it. */
export type TaskEndOutcome = "succeeded" | "failed" | "cancelled" | "creator_removed" | "merged" | "closed" | "answered";
/** What a task's end tells learning: the company, the task and how it ended. */
export interface TaskEndEvent { orgId: string; taskId: string; outcome: TaskEndOutcome }
export type TaskEndHandler = (event: TaskEndEvent) => Promise<void>;

/** What the task record side knows: the subject's facts without the parts that live in the Team record, and the requests of the task's human send-backs. */
export interface TaskSubjectBase {
  facts: Omit<TaskSubjectFacts, "sendBacks" | "revert">;
  /** The request ids of the task's human send-backs (the task's own decision history); each one's row is read for who and what. */
  sendBackRequestIds: readonly string[];
  /**
   * The task's merged change requests, each described without naming a code host (`repo-reflect.ts`), produced by the code host's adapter. The repo-only reflection runs on the ones with a
   * repository-visible correction. Absent or empty: no second reflection.
   */
  repoChanges?: readonly RepoChangeRequest[];
}
export interface TaskSubjectSource {
  /**
   * the task's project from the task record alone (one read), so the learning mode can be checked BEFORE `read` fetches plans, standing and erasure state. Undefined: no such task in the workspace, or one that
   * teaches nothing. A source without it is read first (the old order); the production source has it.
   */
  projectOf?(input: { workspaceId: string; taskId: string }): Promise<string | undefined>;
  /** `context: "human_edit"`: only the task's own facts and steering are wanted (a human edit's reflection keeps the intent and plan); the pull request's comments are not read from the host. */
  read(input: { workspaceId: string; taskId: string; context?: "human_edit" }): Promise<TaskSubjectBase | undefined>;
}

export interface TaskLearningDeps {
  source: TaskSubjectSource;
  rows: OutcomeRowReader;
  settings: LearningSettingsReader;
  reflect: ReflectDeps;
  process: ProcessDeps;
  /**
   * what counts a finished task's outcome for the lessons it loaded (`recordTaskOutcome`: a helpful mark for a clean merge, taken back by a revert). Its judge is whatever the runtime holds
   * (today the refusing one: no model call, so any correction in a lesson's scope leaves it unjudged and no harmful mark is made). Absent: nothing is counted.
   */
  counters?: CounterDeps;
  log?: (event: string, fields: Record<string, string | number>) => void;
  /** The checks a human-edit read makes on its authors now (the same readers the subject source uses). Absent: human edits are not learned from. */
  humanEdit?: { standing: (orgId: string, developerId: string, project: string) => Promise<"member" | "outsider">; isErased: (orgId: string, developerId: string, project: string) => Promise<boolean> };
}

const MAX_SEND_BACKS = 50;

/** The reflector's outcome word for how a task ended; undefined for an end that teaches nothing (an agent step that succeeded, a question answered). */
export function reflectOutcomeOf(outcome: TaskEndOutcome): ReflectSubject["outcome"] | undefined {
  switch (outcome) {
    case "merged": return "merged";
    case "closed": return "closed";
    case "failed": case "cancelled": case "creator_removed": return "abandoned";
    default: return undefined;
  }
}

/**
 * /: the tasks behind every lesson that was loaded INTO the task. A lesson learned from the task's plan may restate them, so it is also gated on them. Each load record names, per lesson, the tasks it was learned
 * from AS THEY WERE AT LOAD TIME (`taskIds`), so an edit, scrub or purge of the lesson afterwards takes nothing away; the lesson's CURRENT tasks are added too (an older record without `taskIds` has only these). Throws
 * when a record cannot be read or a lesson names a task that cannot be read (the task is then not reflected: fail closed). A lesson that is gone adds only what its record kept.
 */
export async function inheritedTasksOf(store: Pick<LessonStore, "manifests" | "get">, key: ScopeKey, taskId: string): Promise<string[]> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const manifest of await store.manifests(key, taskId)) {
    for (const entry of manifest.lessons) {
      for (const id of entry.taskIds ?? []) if (id !== taskId) out.add(id);
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const lesson = await store.get(key, entry.id);
      if (lesson === undefined) continue;
      const refs = lessonTaskRefs(lesson);
      if (refs.unreadable) throw new Error("lessons: a loaded lesson names a task that can't be read");
      for (const id of refs.taskIds) if (id !== taskId) out.add(id);
    }
  }
  return [...out];
}

/** Builds the subject from the task-side facts and the record's rows. The workspace is the caller's, never the source's claim. */
async function subjectFrom(deps: TaskLearningDeps, base: TaskSubjectBase, workspaceId: string, outcome: ReflectSubject["outcome"] | undefined): Promise<ReflectSubject | undefined> {
  if (base.facts.workspaceId !== workspaceId) return undefined;
  const facts = { ...base.facts, ...(outcome === undefined ? {} : { outcome }) };
  const where = { workspaceId, project: facts.project, taskId: facts.taskId };
  const sendBacks: SendBackFact[] = [];
  for (const requestId of base.sendBackRequestIds.slice(0, MAX_SEND_BACKS)) {
    const fact = await deps.rows.sendBack({ ...where, requestId });
    if (fact !== undefined) sendBacks.push(fact);
  }
  const revert = facts.outcome === "reverted" ? await deps.rows.revertedBy(where) : undefined;
  const inheritedTasks = await inheritedTasksOf(deps.process.store, { workspaceId, project: facts.project }, facts.taskId);
  return { ...buildTaskReflectSubject({ ...facts, sendBacks, ...(revert === undefined ? {} : { revert }) }), ...(inheritedTasks.length === 0 ? {} : { inheritedTasks }) };
}

/** The subject of one task (also for the nightly work source, which re-reflects a task whose change was later reverted: pass `outcome: "reverted"`). Undefined when there are no facts. */
export async function subjectForTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<ReflectSubject | undefined> {
  const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
  return base === undefined ? undefined : subjectFrom(deps, base, input.workspaceId, input.outcome);
}

/** The fixed text of a correction whose words the record does not give (an erased sender's send-back, a revert): it is counted, never read. */
const NO_TEXT = "The task was corrected.";

/** How long a task's outcome judging may take, from its first call: the judge never holds the worker up past this, whatever time the attempt has left. */
export const OUTCOME_JUDGE_BUDGET_MS = 60_000;

/**
 * The task's corrections as the counters take them, from the subject this call already holds (nothing is read from the code host again):
 *  - the task's human send-backs (counted from the task's own decision list, so an erased sender's still counts; one whose words are code's is `fixed`: counted, never rated);
 *  - a reviewer's pull request comment, only when it is a member's own words (not an outsider's, not code's fixed text, not text that looks quoted or forwarded), reads as a correction (`correction-filter.ts`: praise, nits and
 *    bare questions are not), was not made by the person who started the task (their own comments on their own task are unmeasured), and names its file (a lesson that does not reach the file is not judged against it);
 *  - a "remember this" note, on the same terms;
 *  - for a revert, the revert alone (the merge's own end already judged the comments, and a revert never pays for them again); its words are code's.
 */
function correctionsOf(base: TaskSubjectBase, subject: ReflectSubject, at: number): TaskCorrection[] {
  if (subject.outcome === "reverted") return [{ kind: "revert", paths: [], text: NO_TEXT, at, fixed: true }];
  const sendBacks = subject.spans.filter((span) => span.kind === "send_back");
  const total = Math.max(sendBacks.length, base.sendBackRequestIds.length);
  const corrections: TaskCorrection[] = Array.from({ length: total }, (_, index) => {
    const back = sendBacks[index];
    const fixed = back === undefined || back.fixedText === true || back.trust !== "member" || back.authorId === undefined;
    return { kind: "send_back" as const, paths: [], text: fixed ? NO_TEXT : back.text, at, ...(fixed ? { fixed: true as const } : { authorId: back.authorId! }) };
  });
  for (const span of subject.spans) {
    if (span.kind !== "pr_comment" && span.kind !== "remembered") continue;
    if (span.trust !== "member" || span.fixedText === true || span.authorId === undefined || (subject.initiatorId !== undefined && sameId(span.authorId, subject.initiatorId)) || looksQuoted(span.text)) continue;
    if (span.kind === "pr_comment" && !looksLikeCorrection(span.text)) continue;
    corrections.push({ kind: "review_comment", paths: span.paths ?? [], text: span.text, at, authorId: span.authorId });
  }
  return corrections;
}

/**
 * Lessons connect and lessons outcomes: counts the finished task for the lessons it loaded. Never throws: a fault is one fixed log line and the reflection's result stands.
 * It runs in two places around the reflection, which always comes first for anything that costs a model call:
 *  - `before` the reflection: only what needs no judge (a revert taking its queued helpful mark back, a merged task with nothing to rate), on every attempt, so the reflection's ending (a refusal, a deadline, a failed model)
 *    never loses it. The counters are idempotent per task and lesson;
 *  - `after` the reflection: the corrections that need the judge, in the judge's own time budget (`OUTCOME_JUDGE_BUDGET_MS`, and never into the model-wait margin the attempt's deadline needs) and outside the reflection's lease:
 *    the judge's keys are not noted on it and its calls never mark it "a call was made", so judging can neither spend the reflection's retry nor be mistaken for it. Done once per task and outcome (`outcome-counted`),
 *    so a reflection that is tried again does not pay for the judging again.
 * A revert counts only when a verified member reverted it (`subject.revertedBy`, from the revert detector's record: a revert by commit message or by revert pull request): anything unproven records nothing.
 * The judge is the counters' (the company's own model path, scoped to this task's failure tally and cost total); where it cannot rate (no usable model, the month used up) `recordTaskOutcome` records nothing.
 */
async function countOutcome(deps: TaskLearningDeps, base: TaskSubjectBase, subject: ReflectSubject, input: { taskId: string }, tally: TaskFailureTally, phase: "before" | "after"): Promise<void> {
  if (deps.counters === undefined || subject.outcome === undefined) return;
  try {
    const attempt = currentLearningAttempt();
    if (attempt?.signal?.aborted === true) return;
    if (subject.outcome === "reverted" && subject.revertedBy === undefined) return;
    const corrections = correctionsOf(base, subject, deps.reflect.now());
    const needsJudge = corrections.some((correction) => correction.fixed !== true);
    if ((phase === "before") === needsJudge) return;
    const where = { workspaceId: subject.workspaceId, project: subject.project };
    const counted = `outcome-counted:${input.taskId}:${subject.outcome}`;
    if (needsJudge && await deps.counters.store.seenOnce(where, counted)) return;
    const startedAt = deps.reflect.now();
    const counters: CounterDeps = {
      ...deps.counters, judge: deps.counters.judge.forTask?.(tally) ?? deps.counters.judge,
      mayCall: () => deps.reflect.now() - startedAt < OUTCOME_JUDGE_BUDGET_MS && learningCallMayStart(Date.now(), LESSONS_BROKER_MODEL_WAIT_SECONDS * 1000),
    };
    // The judge runs as its own attempt: the deadline and the signal are the reflection's, but no lease, no key noted on it and no "a call started" mark, and its faults are its own.
    const judging = attempt === undefined || !needsJudge ? undefined : { deadlineAt: attempt.deadlineAt, ...(attempt.signal === undefined ? {} : { signal: attempt.signal }), ...(attempt.attemptId === undefined ? {} : { attemptId: `${attempt.attemptId}-outcome` }) };
    const run = () => recordTaskOutcome(counters, {
      workspaceId: subject.workspaceId, project: subject.project, taskId: input.taskId, outcome: subject.outcome!, sendBacks: Math.max(subject.spans.filter((span) => span.kind === "send_back").length, base.sendBackRequestIds.length),
      ...(subject.outcome === "merged" ? { mergedAt: deps.reflect.now() } : {}), corrections, ...(subject.evalRun === true ? { evalRun: true } : {}),
    });
    const result = await (judging === undefined ? run() : withLearningAttempt(judging, run));
    // Counted for good only when no judging was cut for time; a cut one is tried again by the next delivery (the harmful marks are once per person, the queued mark is replaced, so nothing counts twice).
    if (needsJudge && result.deferred !== true) await deps.counters.store.markOnce(where, counted);
  } catch {
    deps.log?.("learning.outcome_failed", { task: logRef(subject.workspaceId, input.taskId) });
  }
}

export type LearnStatus = "off" | "no_facts" | "not_reflected" | "reflected" | "eval_run";
/**
 * what a reflection came to, typed. `retry` is true only for a fault that is known to have spent nothing at the moment it happened and may pass: a read of the task, the project's settings or the record failed, the
 * model path failed in a way it marked retryable (a table fault before the call, a refusal by the deadline, a call the in-VPC client refused before sending), or the spend look failed. The worker retries those, and only after it
 * has checked the ledger for the keys the attempt minted (`reflect-claims.ts`). Everything else is final: a reflection that was made (or cut at the deadline after its model answered), a refusal that trying again will not
 * change (no provider, no budget, the month's limit), a model answer that did not parse, a task that teaches nothing.
 */
/** `retryAt`: when a retry came from a host's rate limit, the time (ms since the epoch) the host said asking again may work. */
export interface LearnResult { status: LearnStatus; retry: boolean; retryAt?: number }

const final = (status: LearnStatus): LearnResult => ({ status, retry: false });

/** Reflects on one finished task. Never throws. */
export async function learnFromEndedTaskTyped(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<LearnResult> {
  const faultBefore = currentLearningAttempt();
  if (faultBefore !== undefined) delete faultBefore.fault;
  try {
    // The switch comes first, from the task's project alone. A project whose learning is Off or Collect never has its plan text, standing or erasure state read.
    if (deps.source.projectOf !== undefined) {
      const project = await deps.source.projectOf({ workspaceId: input.workspaceId, taskId: input.taskId });
      if (project === undefined) return final("no_facts");
      if (!modeAllows((await resolveLearning(deps.settings, input.workspaceId, project)).mode, "reflect")) return final("off");
    }
    const base = await deps.source.read({ workspaceId: input.workspaceId, taskId: input.taskId });
    if (base === undefined || base.facts.workspaceId !== input.workspaceId) return final("no_facts");
    // An eval or replay run is not learned from: no rows are read, no outcome is counted, no model is called.
    if (isEvalRunMark(base.facts.rest.evalRun)) return final("eval_run");
    // The switch again on the project the facts name (the only check for a source that cannot name the project alone; for the others it only repeats the same answer).
    const learning = await resolveLearning(deps.settings, input.workspaceId, base.facts.project);
    if (!modeAllows(learning.mode, "reflect")) return final("off");
    const subject = await subjectFrom(deps, base, input.workspaceId, input.outcome);
    if (subject === undefined) return final("no_facts");
    // What needs no judge is counted BEFORE the reflection (idempotent: a once-key per task and lesson, a queued mark that is only replaced or removed), so it happens on every attempt whatever the reflection comes to (a refusal,
    // a model that failed, an attempt that will be retried, a deadline that cut it); a revert's re-reflection takes the merge's queued helpful mark back here. What needs the judge is counted AFTER the reflection.
    // This task's failed model calls (the outcome judge, the reflection and each draft's judge) count toward `model_failed` once per kind, not once per call.
    const tally = newTaskFailureTally();
    await countOutcome(deps, base, subject, input, tally, "before");
    // Review: Public's per-task cap is one total across this run and the human-edit job, in either order: a merged task starts from what the job already held.
    const taskCap = learningCaps(deps.reflect.edition, deps.reflect.capsOverride).perTaskUsd;
    if (taskCap !== undefined && subject.outcome === "merged" && (base.repoChanges?.length ?? 0) > 0) {
      // Review: every paid call of this run reserves its hold on the task's shared ladder before it is made, so the job running at the same time cannot take the cap twice.
      attachCapLadder(tally, deps.process.store, { workspaceId: input.workspaceId, project: base.facts.project }, input.taskId, taskCap);
      try { tally.heldUsd = Math.max(tally.heldUsd, await readTaskHeld(deps.process.store, { workspaceId: input.workspaceId, project: base.facts.project }, input.taskId, taskCap)); } catch { deps.log?.("learning.task_hold_unreadable", { task: logRef(input.workspaceId, input.taskId) }); }
    }
    // Review: the curator's judge calls for these drafts hold from the same task total as the reflections and the outcome judge.
    const processDeps = { ...withFailuresCountedOnce(deps.process, tally), taskBudget: tally };
    const reflectionOf = async (): Promise<LearnResult> => {
      // The reflection's hold goes on the task's tally, so the outcome judge that follows shares Public's one per-task cap with it.
      // Review: the reflection is given what is left of the task's one Public cap (the human-edit job may have spent from it); a task with nothing left makes no call.
      const room = taskCap === undefined ? undefined : Math.round((taskCap - tally.heldUsd) * 1e6) / 1e6;
      if (room !== undefined && room < 0.001) return final("not_reflected");
      const result = await reflectSubject({ ...withFailuresCountedOnce(deps.reflect, tally), taskBudget: tally, ...(room === undefined ? {} : { capsOverride: { ...deps.reflect.capsOverride, perTaskUsd: room } }) }, subject);
      if (result.status !== "ok") {
        // "learning_paused" is a refusal (no provider, every model forbidden, a price or budget that cannot fit, the month's limit): the reason is already recorded as the project's pause, and trying again changes
        // nothing, so it ends the reflection (final) whatever fault state an earlier step left. A spend look that could not read the counter is "spend_refused" with a retryable fault (nothing was held or sent).
        if (result.reason === "learning_paused") return final("not_reflected");
        // The reflector turns a failed model call or spend look into a fixed reason; the model path says whether that failure was worth another try.
        const retryable = (result.reason === "model_error" || result.reason === "spend_refused") && currentLearningAttempt()?.fault === "retryable";
        return { status: "not_reflected", retry: retryable };
      }
      const key = { workspaceId: input.workspaceId, project: base.facts.project };
      const signal = currentLearningAttempt()?.signal;
      for (const draft of result.drafts) {
        // At the deadline no new draft is started (the store's writes are refused too, `deadline-guard.ts`). The model has been paid for; what is cut is lost, not repeated.
        if (signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", { task: logRef(input.workspaceId, input.taskId) }); break; }
        try { await processDraftRetrying(processDeps, key, draft, { ...(deps.log === undefined ? {} : { log: (event, fields) => deps.log!(event, { task: logRef(input.workspaceId, input.taskId), ...fields }) }) }); } catch { deps.log?.("learning.draft_failed", { task: logRef(input.workspaceId, input.taskId) }); }
      }
      return final("reflected");
    };
    // The reflection (and its drafts) come first and are never held back by the counting: whatever they come to, the corrections that need the judge are counted after them (`countOutcome`, "after").
    let reflected: LearnResult;
    try {
      reflected = await reflectionOf();
    } finally {
      await countOutcome(deps, base, subject, input, tally, "after");
    }
    // A merged pull request's SECOND reflection, over the repository's own words only. After the first one and after the outcome judge (review: the judge's marks decide "stable", so the
    // repo-only call takes what is left of the task's budget, not the other way round), in the same attempt and lease, on the same task tally. It runs whatever the first reflection came to, a retry included (review: its own once-key decides, so a retried delivery does not repeat it). It never makes the result retry (a retry would run the first reflection again, which the
    // lease forbids once its call started) and never holds the end of the work back. The task end ALWAYS runs this (the comments reflection); a pull request with human edits gets a separate edits reflection from the human-edit job, with its own once-key.
    if (subject.outcome === "merged" && (base.repoChanges?.length ?? 0) > 0) {
      await reflectRepoOnly({ reflect: deps.reflect, process: deps.process, settings: deps.settings, ...(deps.log === undefined ? {} : { log: deps.log }) }, subject, base.repoChanges!, tally, { kind: "comments" });
    }
    // What this run held counts against the task's one Public cap for the human-edit job too, which runs later (or earlier) as another run of the same task.
    if ((base.repoChanges?.length ?? 0) > 0 && taskCap !== undefined && subject.outcome === "merged") {
      try { await noteTaskHeld(deps.process.store, { workspaceId: input.workspaceId, project: base.facts.project }, input.taskId, tally.heldUsd, taskCap); } catch { deps.log?.("learning.task_hold_not_noted", { task: logRef(input.workspaceId, input.taskId) }); }
    }
    return reflected;
  } catch {
    deps.log?.("learning.task_end_failed", { task: logRef(input.workspaceId, input.taskId) });
    // Outside a worker nothing is retried. Inside one, a fault here is a read that failed, before any model key was minted by this call (or one the model path marked itself).
    return { status: "not_reflected", retry: currentLearningAttempt() !== undefined && currentLearningAttempt()?.fault !== "final" };
  }
}

/** Reflects on one finished task. Never throws. */
export async function learnFromEndedTask(deps: TaskLearningDeps, input: { workspaceId: string; taskId: string; outcome?: ReflectSubject["outcome"] }): Promise<LearnStatus> {
  return (await learnFromEndedTaskTyped(deps, input)).status;
}

/**
 * (lessons in production): the end of a task never runs the reflector. The handler sends ONE message of ids only (`{ orgId, taskId, outcome, requestId }`) to the LessonsReflect queue and returns; a
 * worker (`reflect-worker.ts`, its own Lambda) runs `learnFromEndedTask` under its own time and spend limits. A queue that did not take the message is one fixed log line: the task has ended all the same and is never
 * held up (the nightly re-reflection and the next task's own end are the only other chances to learn from it; a lost message is a lost reflection, never a lost task).
 */
export interface TaskEndEnqueue {
  queue: ReflectQueue;
  newRequestId?: () => string;
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** The handler for a task's end. It reads the queue when a task ends, so a later queue is the one it uses; none means it does nothing. */
export function learningTaskEndHandler(get: () => TaskEndEnqueue | undefined): TaskEndHandler {
  return async (event) => {
    const target = get();
    const outcome = reflectOutcomeOf(event.outcome);
    if (target === undefined || outcome === undefined) return;
    try {
      await target.queue.send({ orgId: event.orgId, taskId: event.taskId, outcome, requestId: (target.newRequestId ?? randomUUID)() });
    } catch {
      // One fixed line (never the error's text): the end goes on.
      (target.log ?? ((name, fields) => console.log(JSON.stringify({ component: "lessons", event: name, ...fields }))))("learning.enqueue_failed", { task: logRef(event.orgId, event.taskId) });
    }
  };
}
