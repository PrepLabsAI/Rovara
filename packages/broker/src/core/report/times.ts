// The cost report's time split and send-backs (lead 4, slice A4): what a task's work events say about where its time went.
//
// One task's events are read from its own shard of the company's event partitions (`workEventPartition`), inside the task's own life (its start to its end, or now), and folded into six whole numbers:
//   workingMs         time a step ran (`waiting_changed` with `waitingOn: agent`): "Rovara working"
//   decisionsMs       time the task waited for a person to approve a plan, answer a question, approve spend, or retry something blocked
//   prReviewMs        time the task waited for a person to review its pull request (`reason: pr_review`), up to the merge: shown apart from the decisions
//   waitingSystemMs   time a step was queued for the system (`waitingOn: system`)
//   sendBacksRovara   times Rovara sent its own code back (an automatic fix after a failing check or review, a CI fix round)
//   sendBacksPeople   times a person asked for changes (a plan sent back, work sent back to coding, the findings of a review, a round of pull request feedback)
//
// Absent is "not known", never zero. A task has these numbers only when its events cover it from its start: a `task_started` event and at least one wait are there. A task from before events were written, a task whose
// events cannot all be read, and a task whose events do not fit one bounded read have none: the numbers are left out of its row. A task that has events and no send-backs has send-backs of 0, which is true.
//
// The timeline is the `waiting_changed` events in time order: each begins a stretch that lasts until the next, until the task ended (the report's `endedAt`) or, for an open task, now. An event after the end is not
// counted. `person` and `none` never mix with `agent`: the classes are exclusive, so the three times never overlap and never exceed the wall time. Nothing here names a person (no event does).
import {
  INDEX_EXPIRY_ATTRIBUTE, WORK_EVENT_RETENTION_MONTHS, WorkEventSchema, companyOfKey, when, workEventMonths, workEventPartition, workEventShard,
  type DocumentStore, type OrgId, type StoredDocument, type WorkEvent,
} from "@agentx/contracts";
import { rowBelongsToCompany } from "../company-read-rows.js";

/** The numbers of one task. All six or none. */
export interface TaskTimes {
  workingMs: number;
  decisionsMs: number;
  prReviewMs: number;
  waitingSystemMs: number;
  sendBacksRovara: number;
  sendBacksPeople: number;
}

/** One task's read looks at most this many rows per month and keeps at most this many events; more is "not known". */
export const TIMES_PAGE = 500;
export const TIMES_PAGES_MAX = 6;
export const TIMES_EVENTS_MAX = 1_000;

const STORED_ONLY = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);

export interface TimesTask { taskId: string; project: string; orgId: OrgId }

/**
 * Folds one task's events into its numbers. `endAt` is when the task ended (epoch ms) or undefined while it is open, in which case it runs to `now`. Events of another task, company or project are ignored (the reader
 * has checked rows already; this is the second check). Pure; undefined when the events do not cover the task from its start.
 */
export function foldTimes(events: readonly WorkEvent[], task: TimesTask, endAt: number | undefined, now: number): TaskTimes | undefined {
  const own = [...new Map(events.filter((event) => event.taskId === task.taskId && event.orgId === task.orgId && event.project === task.project).map((event) => [event.id, event])).values()]
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  if (!own.some((event) => event.kind === "task_started")) return undefined;
  const waits = own.flatMap((event) => (event.kind === "waiting_changed" ? [{ at: Date.parse(event.at), event }] : []));
  if (waits.length === 0) return undefined;
  const end = Math.max(waits[0]!.at, endAt ?? now);
  const times: TaskTimes = { workingMs: 0, decisionsMs: 0, prReviewMs: 0, waitingSystemMs: 0, sendBacksRovara: 0, sendBacksPeople: 0 };
  waits.forEach(({ at, event }, index) => {
    if (event.kind !== "waiting_changed" || at >= end) return;
    const stop = Math.min(end, index + 1 < waits.length ? waits[index + 1]!.at : end);
    const span = Math.max(0, stop - at);
    if (event.waitingOn === "agent") times.workingMs += span;
    else if (event.waitingOn === "system") times.waitingSystemMs += span;
    else if (event.waitingOn === "person") {
      if (event.reason === "pr_review") times.prReviewMs += span;
      else times.decisionsMs += span;
    }
  });
  for (const event of own) {
    if (event.kind !== "decision_answered" || event.outcome !== "changes_requested") continue;
    if (event.place?.startsWith("rovara_") === true) times.sendBacksRovara += 1;
    else if (event.place?.startsWith("person_") === true) times.sendBacksPeople += 1;
  }
  return times;
}

/** The numbers as a stored row keeps them, checked (all six whole numbers), or undefined. */
export function timesOfStored(value: unknown): TaskTimes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const names = ["workingMs", "decisionsMs", "prReviewMs", "waitingSystemMs", "sendBacksRovara", "sendBacksPeople"] as const;
  if (Object.keys(record).length !== names.length || !names.every((name) => typeof record[name] === "number" && Number.isSafeInteger(record[name]) && (record[name] as number) >= 0)) return undefined;
  return Object.fromEntries(names.map((name) => [name, record[name]])) as unknown as TaskTimes;
}

export interface TaskEventsRead {
  times: TaskTimes | undefined;
  /** Event rows of this company's partition that are not this company's (counted, never used). */
  skipped: number;
}

/**
 * Reads one task's events and folds them. One query (and its pages) for each month the task lived in, in the one shard its events are in, from its start to its end (or now), filtered to the task. A read that fails
 * throws (the caller makes it the report's retryable refusal); rows this code cannot read, a read that does not fit the bounds and a window of more than the retention make the numbers unknown, never partial.
 */
export async function readTaskTimes(store: Pick<DocumentStore, "query">, task: TimesTask, startedAt: string, endedAt: string | undefined, now: number): Promise<TaskEventsRead> {
  const start = Date.parse(startedAt);
  const endAt = endedAt === undefined ? undefined : Date.parse(endedAt);
  const to = new Date(Math.max(start, endAt ?? now)).toISOString();
  const months = workEventMonths(startedAt, to);
  if (months.length > WORK_EVENT_RETENTION_MONTHS + 1) return { times: undefined, skipped: 0 };
  const events: WorkEvent[] = [];
  let skipped = 0;
  for (const month of months) {
    const pk = workEventPartition(task.orgId, month, workEventShard(task.taskId));
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= TIMES_PAGES_MAX) return { times: undefined, skipped };
      const read: { items: StoredDocument[]; cursor?: string } = await store.query({ pk, sk: { op: "between", low: startedAt, high: `${to}~` }, filter: when.eq("taskId", task.taskId), limit: TIMES_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      for (const row of read.items) {
        if (!rowBelongsToCompany(row, task.orgId) || companyOfKey(row.pk) !== task.orgId) { skipped += 1; continue; }
        const parsed = WorkEventSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => !STORED_ONLY.has(name))));
        // A row of this task that cannot be read makes the numbers unknown: counting around it would understate the time.
        if (!parsed.success) return { times: undefined, skipped };
        if (parsed.data.orgId !== task.orgId) { skipped += 1; continue; }
        events.push(parsed.data);
        if (events.length > TIMES_EVENTS_MAX) return { times: undefined, skipped };
      }
      cursor = read.cursor;
      if (cursor === undefined) break;
    }
  }
  return { times: foldTimes(events, task, endAt, now), skipped };
}
