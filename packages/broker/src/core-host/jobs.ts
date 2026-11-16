// Engine host (lane E2): the core's timers as schedules. On a laptop Code runs these from `setInterval` in one process (relay and dispatch every 2 s, merge tracking every 5 s); a deployed
// install runs each from an EventBridge schedule (1-minute minimum, accepted latency) or from the State table's stream reader.
//
// One table names every job: its area (it runs only for companies whose switch covers the area), how it is triggered, and what it calls. A new job is one row.
//
// Per-company isolation: each company runs in its own try/catch, so one company's failure never skips the others, and the order rotates by run so a time budget never defers the same tail
// companies every time.
import { CORE_JOB_EVENT_SOURCE } from "@agentx/contracts";
import type { CoreRuntime, CoreServiceName } from "./core-runtime.js";
import type { CoreArea } from "./flags.js";

export type JobTrigger = { kind: "schedule"; rate: string } | { kind: "stream"; on: "outbox-insert" };

export interface CoreJob {
  name: string;
  area: CoreArea;
  trigger: JobTrigger;
  run(runtime: CoreRuntime, budgetMs: number): Promise<Record<string, unknown>>;
}

const service = (name: CoreServiceName) => async (runtime: CoreRuntime, budgetMs: number): Promise<Record<string, unknown>> => {
  const wired = runtime.services[name];
  if (wired === undefined) return { skipped: "service_not_wired" };
  return await wired.pass({ budgetMs });
};

export const CORE_JOBS: readonly CoreJob[] = [
  // The outbox relay. The stream reader runs it on an outbox insert; the schedule is the backstop for a missed insert.
  { name: "outbox-relay", area: "flow", trigger: { kind: "stream", on: "outbox-insert" }, run: async (runtime) => ({ ...(await runtime.flow.relayOnce()) }) },
  { name: "outbox-relay-backstop", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: async (runtime) => ({ ...(await runtime.flow.relayOnce()) }) },
  // The recovery sweep over due workflow dispatch rows (laptop: every 2 s).
  { name: "dispatch-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: async (runtime) => ({ ...(await runtime.flow.sweepOnce()) }) },
  // The run-lost watchdog: an operation whose worker machine is lost or unhealthy past the grace period ends INTERRUPTED (the laptop runs it with the sweep).
  { name: "run-watch", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: async (runtime) => ({ ...(await runtime.flow.sweepRunsOnce()) }) },
  // Merge tracking's sweep.
  { name: "merge-tracking", area: "merge", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: service("merge-tracking") },
  { name: "session-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(5 minutes)" }, run: service("session-sweep") },
  { name: "notify-deliver", area: "flow", trigger: { kind: "schedule", rate: "rate(5 minutes)" }, run: service("notify-deliver") },
  // A hold whose caller died is closed by the admission adapter's own sweep, on a schedule.
  { name: "admission-hold-sweep", area: "flow", trigger: { kind: "schedule", rate: "rate(15 minutes)" }, run: service("admission-hold-sweep") },
  // With automations off, the runs already started are stopped at a safe point (optional service). Does nothing while they are on.
  { name: "automation-stop", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: service("automation-stop") },
  // Owed person erases: learning first, then the bounded evidence walk, in this runtime's company.
  { name: "person-erase-resume", area: "flow", trigger: { kind: "schedule", rate: "rate(15 minutes)" }, run: service("person-erase-resume") },
  // Lessons (optional service, wired only where `ROVARA_CORE_LESSONS` covers the company): milestones due, the shared reflection queue, and once a day the upkeep (`lessons.ts`).
  { name: "lessons", area: "flow", trigger: { kind: "schedule", rate: "rate(5 minutes)" }, run: service("lessons") },
  // The after-merge watcher's pass (optional service, M7 slice 2): windows that ended close, a report that could not be sent goes out again, and the deploy read backs up a deployment event that never came. The service is the
  // one `createAfterMergeService` makes for this company (`core/after-merge/service.ts`); it does nothing for a project whose own `afterMergeWatch` setting is off, and a runtime that wires none skips this job.
  { name: "after-merge", area: "flow", trigger: { kind: "schedule", rate: "rate(1 minute)" }, run: service("after-merge") },
];

/** The `source` of the event a core job schedule sends to the broker: `{ source: "agentx.core-job", job: <name> }`. */
export const CORE_SCHEDULE_SOURCE: typeof CORE_JOB_EVENT_SOURCE = CORE_JOB_EVENT_SOURCE;

export function scheduleEventOf(job: CoreJob): { source: typeof CORE_SCHEDULE_SOURCE; job: string } {
  return { source: CORE_SCHEDULE_SOURCE, job: job.name };
}

export function isCoreJobEvent(event: unknown): event is { source: typeof CORE_SCHEDULE_SOURCE; job: string } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === CORE_SCHEDULE_SOURCE && typeof (event as { job?: unknown }).job === "string";
}

export interface CompanyRunReport {
  companyId: string;
  outcome: "ran" | "failed" | "deferred";
  report?: Record<string, unknown>;
  /** The error's class name only (never its message: it may carry customer text). */
  error?: string;
}

/**
 * Runs `work` for each company, isolated: a throw is recorded for that company only. The start rotates by `rotation` (the caller passes a counter), and a company not reached before the budget
 * runs out is `deferred`, not failed. Each company's work is told the time that is LEFT of the budget, not the whole of it.
 */
export async function runPerCompany(companies: readonly string[], work: (companyId: string, leftMs: number) => Promise<Record<string, unknown>>, options: { rotation: number; budgetMs: number; nowMs: () => number }): Promise<CompanyRunReport[]> {
  const count = companies.length;
  if (count === 0) return [];
  const start = ((options.rotation % count) + count) % count;
  const ordered = [...companies.slice(start), ...companies.slice(0, start)];
  const deadline = options.nowMs() + options.budgetMs;
  const reports: CompanyRunReport[] = [];
  for (const companyId of ordered) {
    if (options.nowMs() >= deadline) { reports.push({ companyId, outcome: "deferred" }); continue; }
    try {
      reports.push({ companyId, outcome: "ran", report: await work(companyId, deadline - options.nowMs()) });
    } catch (error) {
      reports.push({ companyId, outcome: "failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return reports;
}
