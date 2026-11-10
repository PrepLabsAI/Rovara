// Learning is never silent. When it cannot run for a project or its company (no company-billed provider, the monthly learning limit, every model forbidden, the
// cheapest model too dear for the budgets) ONE current reason is recorded, as a fixed code and a time, and the Lessons tab and Home say it in one line. A learning call that succeeds clears it.
//
//   project: pk of the project, sk `LESSONSET#PAUSED`   (why learning cannot run for this project: its providers, models and budgets)
//   company: pk of the workspace, sk `LESSONSET#PAUSED`  (why it cannot run for the company: the monthly learning limit)
//   project: pk of the project, sk `LESSONSET#FAILS`     (how many learning calls in a row failed after the key was made: a count and a time, nothing else)
// A reason that is already in force keeps the time it started; a success clears the reason and the count.
// Every sort key starts with `LESSONSET`, which a project erase and a company erase wipe. The item holds a code from the allow-list, a time and nothing else: no model name, no amount, no
// provider or proxy text, no person (checklist section 3). A store that cannot be reached never blocks learning and never throws into it: the pause is bookkeeping, not a gate.
import { LESSONS_PAUSE_CODES, teamRecordPk, when, change, type DocumentStore, type LessonsPauseCode } from "@agentx/contracts";
import type { LearningSpend } from "./ports.js";

export type { LessonsPauseCode };

/** A learning call refused BEFORE any key existed or any money was held, with the fixed code that says why. The message is fixed words, never a provider's or the proxy's. */
export class LearningRefusal extends Error {
  constructor(readonly code: LessonsPauseCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LearningRefusal";
  }
}
export const isLearningRefusal = (error: unknown): error is LearningRefusal => error instanceof LearningRefusal;

/** Whose failures a count is of: the reflector's model call, or the curator's judge call. Each has its own count in a row, so one's success never hides the other's failures. */
export type FailureKind = "reflect" | "judge";
export interface CurrentPause { code: LessonsPauseCode; at: number; scope: "project" | "company" }
export interface LessonsPauseStore {
  /** Records the one current reason for the code's scope (the monthly limit is the company's; every other reason is the project's). Never throws. */
  record(workspaceId: string, project: string, code: LessonsPauseCode): Promise<void>;
  /** A learning call for the project succeeded: its own reason and the company's are cleared, and the count of failures in a row starts again. Never throws. With `ifCode`, a reason is deleted only while it is still that code (the Lessons tab clears the reason it showed, never one recorded since); when it is not, nothing is cleared, not even the count. */
  clear(workspaceId: string, project: string, only?: "project" | "company", ifCode?: LessonsPauseCode): Promise<void>;
  /** A learning call for the project failed after its key was made (the provider, the proxy, an empty answer): counts one more failure in a row and returns the count. Never throws; absent counts nothing. */
  failed?(workspaceId: string, project: string, kind?: FailureKind): Promise<number>;
  /** The curator's judge answered: its own count of failures in a row starts again. The reflector's success does NOT do this (it clears the reflector's count only), so a judge that always fails still pauses the project. Never throws; absent clears nothing. */
  clearJudgeFailures?(workspaceId: string, project: string): Promise<void>;
  /** The reason in force for a project: its own, else the company's. Undefined when there is none or it cannot be read. */
  read(workspaceId: string, project: string): Promise<CurrentPause | undefined>;
}

/** Which scope a reason belongs to: the monthly limit is the company's; the rest follow from the project's own providers, models and budgets. */
export const pauseScopeOf = (code: LessonsPauseCode): "project" | "company" => (code === "monthly_limit" ? "company" : "project");

const SK = "LESSONSET#PAUSED";
const FAILS_SK = "LESSONSET#FAILS";
const JUDGE_FAILS_SK = "LESSONSET#FAILS_JUDGE";
/** This many failed learning calls in a row for a project pause it as `model_failed`. */
export const MODEL_FAILURES_BEFORE_PAUSE = 3;
const isCode = (value: unknown): value is LessonsPauseCode => typeof value === "string" && (LESSONS_PAUSE_CODES as readonly string[]).includes(value);

export function documentPauseStore(store: DocumentStore, now: () => number, log?: (event: string, fields: Record<string, string | number>) => void): LessonsPauseStore {
  const keyOf = (workspaceId: string, project: string | undefined) => ({ pk: teamRecordPk(workspaceId, project), sk: SK });
  const readOne = async (workspaceId: string, project: string | undefined, scope: CurrentPause["scope"]): Promise<CurrentPause | undefined> => {
    const item = await store.get(keyOf(workspaceId, project));
    return item !== undefined && isCode(item["code"]) && typeof item["at"] === "number" && Number.isFinite(item["at"]) ? { code: item["code"], at: item["at"], scope } : undefined;
  };
  return {
    async record(workspaceId, project, code) {
      try {
        // A reason already in force keeps the time it started (the condition fails and nothing is written); a different reason replaces it.
        await store.put({
          item: { ...keyOf(workspaceId, pauseScopeOf(code) === "company" ? undefined : project), entityType: "LESSON_PAUSE", code, at: now() },
          condition: when.or(when.absent(), when.not(when.eq("code", code))),
        });
      } catch { log?.("lessons.pause_not_recorded", { code }); }
    },
    async clear(workspaceId, project, only, ifCode) {
      for (const scoped of only === "project" ? [project] : only === "company" ? [undefined] : [project, undefined]) {
        try {
          const result = await store.delete({ key: keyOf(workspaceId, scoped), ...(ifCode === undefined ? {} : { condition: when.eq("code", ifCode) }) });
          // The reason is no longer the one that was shown: a newer one stays, and so does the count of failures that goes with it.
          if (!result.applied && ifCode !== undefined) return;
        } catch {
          log?.("lessons.pause_not_cleared", { scope: scoped === undefined ? "company" : "project" });
        }
      }
      if (only === "company") return;
      try { await store.delete({ key: { pk: teamRecordPk(workspaceId, project), sk: FAILS_SK } }); } catch { log?.("lessons.failures_not_cleared", {}); }
      // A person's clear from the Lessons page (the conditional one) starts the judge's count again too: the pause they dismissed must not return on the next single judge failure. A reflection that succeeds does not.
      if (ifCode === undefined) return;
      try { await store.delete({ key: { pk: teamRecordPk(workspaceId, project), sk: JUDGE_FAILS_SK } }); } catch { log?.("lessons.failures_not_cleared", {}); }
    },
    async clearJudgeFailures(workspaceId, project) {
      try { await store.delete({ key: { pk: teamRecordPk(workspaceId, project), sk: JUDGE_FAILS_SK } }); } catch { log?.("lessons.failures_not_cleared", {}); }
    },
    async failed(workspaceId, project, kind = "reflect") {
      try {
        const out = await store.update({
          key: { pk: teamRecordPk(workspaceId, project), sk: kind === "judge" ? JUDGE_FAILS_SK : FAILS_SK }, return: "new",
          ops: [change.add("count", 1), change.set("entityType", "LESSON_FAILS"), change.set("at", now())],
        });
        const count = out.applied ? out.item?.["count"] : undefined;
        return typeof count === "number" ? count : 0;
      } catch { log?.("lessons.failure_not_counted", {}); return 0; }
    },
    async read(workspaceId, project) {
      try {
        const [own, company] = await Promise.all([readOne(workspaceId, project, "project"), readOne(workspaceId, undefined, "company")]);
        return own ?? company;
      } catch { return undefined; }
    },
  };
}

/** Records a pause without ever throwing into the learning call (the store may be absent). */
export async function notePause(pause: LessonsPauseStore | undefined, workspaceId: string, project: string, code: LessonsPauseCode): Promise<void> {
  if (pause === undefined) return;
  try { await pause.record(workspaceId, project, code); } catch { /* bookkeeping only */ }
}
/** Clears the pause after a learning call succeeded, without ever throwing into the call. */
export async function noteRecovered(pause: LessonsPauseStore | undefined, workspaceId: string, project: string): Promise<void> {
  if (pause === undefined) return;
  try { await pause.clear(workspaceId, project); } catch { /* bookkeeping only */ }
}

/** What the cheap look at the company's learning month says, with the reason when it refuses; a spend port without `look` is asked `admit`, and a refusal there reads as `month_full`. */
export async function spendLook(spend: LearningSpend, workspaceId: string, estimateUsd: number): Promise<"ok" | "month_full" | "too_large" | "unreadable"> {
  try {
    if (spend.look !== undefined) return await spend.look(workspaceId, estimateUsd);
    return (await spend.admit(workspaceId, estimateUsd)) ? "ok" : "month_full";
  } catch { return "unreadable"; }
}
/** The pause a refused look records: the month's limit is the company's; a call too large for the whole cap is a cost problem; a counter that could not be read is a fault, not a reason (nothing is recorded). */
export const pauseOfLook = (look: "month_full" | "too_large" | "unreadable"): LessonsPauseCode | undefined => (look === "month_full" ? "monthly_limit" : look === "too_large" ? "cost_too_high" : undefined);

/** What one task's learning has counted so far, per kind (shared by the reflector's and the curator's pause handles of that task). */
export interface TaskFailureTally {
  counted: Set<FailureKind>;
  /** What the task's learning calls have held so far (the reflection's quote, then the outcome judge's): Public's per-task cap is one total for them together. */
  heldUsd: number;
  /**
   * when the task has a shared cap ledger, every paid call of the task (a reflection, a curator judge, the outcome judge, a repo-only reflection) reserves its hold here BEFORE it is made.
   * False: the cap's steps are used up, and the call is not made. Absent: no shared ledger (Enterprise, or a task nothing else runs for).
   */
  reserve?: (usd: number) => Promise<boolean>;
}
export const newTaskFailureTally = (): TaskFailureTally => ({ counted: new Set(), heldUsd: 0 });
/**
 * /: a pause handle that counts failed model calls toward `model_failed` ONCE per kind for a task (or one draft set), not once per call. A task whose reflection is judged against several neighbours, draft
 * by draft, could otherwise reach the three failures that pause the project from one short outage. After the first failure of a kind the rest of the task's failures of that kind are not counted (the reason and the clear are
 * untouched), and a call that succeeds clears that kind's count as always, after which a later failure of the same task counts afresh (the count is "in a row"). Share one tally between the handles of a task.
 */
export function failuresCountedOncePerTask(pause: LessonsPauseStore | undefined, tally: TaskFailureTally): LessonsPauseStore | undefined {
  if (pause?.failed === undefined) return pause;
  const failed = pause.failed.bind(pause);
  return {
    record: (workspaceId, project, code) => pause.record(workspaceId, project, code),
    read: (workspaceId, project) => pause.read(workspaceId, project),
    async clear(workspaceId, project, only, ifCode) { await pause.clear(workspaceId, project, only, ifCode); if (only !== "company" && ifCode === undefined) tally.counted.delete("reflect"); },
    ...(pause.clearJudgeFailures === undefined ? {} : { async clearJudgeFailures(workspaceId: string, project: string) { await pause.clearJudgeFailures!(workspaceId, project); tally.counted.delete("judge"); } }),
    async failed(workspaceId, project, kind = "reflect") {
      // Zero is returned for a failure after the first of its kind: below the pause threshold, so nothing is recorded.
      if (tally.counted.has(kind)) return 0;
      tally.counted.add(kind);
      return failed(workspaceId, project, kind);
    },
  };
}

/** `deps` with its pause handle counting failures once per task (`failuresCountedOncePerTask`); deps with no pause store are returned as they are. */
export function withFailuresCountedOnce<T extends { pause?: LessonsPauseStore }>(deps: T, tally: TaskFailureTally): T {
  const pause = failuresCountedOncePerTask(deps.pause, tally);
  return pause === undefined ? deps : { ...deps, pause };
}

/** A learning call failed after its key was made: counts it, and pauses the project as `model_failed` once this many in a row have failed (a success clears both). Never throws. */
export async function noteModelFailure(pause: LessonsPauseStore | undefined, workspaceId: string, project: string, kind: FailureKind = "reflect"): Promise<void> {
  if (pause?.failed === undefined) return;
  try {
    if ((await pause.failed(workspaceId, project, kind)) >= MODEL_FAILURES_BEFORE_PAUSE) await pause.record(workspaceId, project, "model_failed");
  } catch { /* bookkeeping only */ }
}
/** The curator's judge answered: clears the pause as any success does, and the judge's own count of failures in a row (the reflector's success never clears that one). Never throws. */
export async function noteJudgeRecovered(pause: LessonsPauseStore | undefined, workspaceId: string, project: string): Promise<void> {
  await noteRecovered(pause, workspaceId, project);
  try { await pause?.clearJudgeFailures?.(workspaceId, project); } catch { /* bookkeeping only */ }
}
