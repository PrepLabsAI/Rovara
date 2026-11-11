// A generic poll over a tracker's search, for the places work is asked for that have no webhook of ours (a team's own tracker, an install that can't receive webhooks: every tracker on a laptop). It knows
// no tracker: an ADAPTER (`Tracker.askedFor`) turns "what is asked for now in this source" into `IntakeCandidate`s, and the intake engine (`engine.ts`) decides what happens to each: a member's
// act starts work, anything else waits, and a ticket seen again is the same ticket. This file only decides WHEN and HOW OFTEN to ask, and what to do when asking fails:
//
//   - one tick of the timer asks `runIntakePoll`; a source is polled when it is due (`nextPollAt`), by default every 2 minutes, at most 60 reads an hour per source, both settings of the source
//     (`IntakeChannelRef.poll`, inside the limits of `intake.ts`);
//   - NO DOUBLE START: a source is polled by whichever tick wins a conditional update of `nextPollAt`; two ticks that overlap poll it once. A ticket handed over twice is one item (a conditional write
//     in the engine), so even a repeat of a poll starts nothing twice;
//   - the hour's reads are counted with a conditional count, so a source can't exceed its cap however many ticks or retries there are;
//   - a read that fails (an error, a time-out, no adapter, a result that is not a list) backs the source off (twice the interval each time, at most an hour) and, once it has failed
//     for an hour, tells the owner once a day; it never starts anything and it never logs what the tracker said, only a code;
//   - everything is bounded: the sources per tick, the time of one read (10 s), the items of one read (50) and the whole tick's time.
// Nothing a tracker returns is trusted: a result that names another tracker than the source's is dropped, and the engine treats every string as an outsider's text.
import {
  AgentXError, TrackerSearchError, agentXError, change, INDEX_EXPIRY_ATTRIBUTE, INTAKE_MAX_ITEMS_PER_POLL, intakeCallsKey, intakePollSettingsOf, intakeSourceIsPolled, intakeSourceKey, intakeSystemOf, when,
  type OrgId,
} from "@agentx/contracts";
import { ingestIntakeBatchWithin, type IntakeActor, type IntakeCandidate, type IntakeOutcome, type IntakePorts } from "./engine.js";
import { listAllIntakeSources, type IntakeSourceRecord } from "./sources.js";

// ---- the adapters

/** What an adapter is asked: read what is asked for now in this source. It must stop when `signal` aborts. It reads through the org's own connection; it never receives a secret. */
export interface IntakeSearchInput {
  orgId: OrgId;
  project: string;
  source: IntakeSourceRecord;
  signal: AbortSignal;
  /** The most items to hand back; more are cut. */
  limit: number;
}

/** What an adapter hands back for one ticket: the engine's candidate without the parts the source fixes (the org, the project and the channel). */
export type IntakeSearchItem = Omit<IntakeCandidate, "orgId" | "project" | "channel"> & { actor?: IntakeActor | undefined };
export type IntakeSearch = (input: IntakeSearchInput) => Promise<readonly IntakeSearchItem[]>;

// ---- the poll

const MINUTE = 60_000;
const HOUR_SECONDS = 3600;
/** How long one read may take before it counts as a failure. */
export const INTAKE_SEARCH_TIMEOUT_MS = 10_000;
/** The longest a failing source waits between reads. */
export const INTAKE_BACKOFF_MAX_MS = 60 * MINUTE;
/** How long a source must have been failing before its maintainers are told, and how long before they are told again. */
export const INTAKE_NOTICE_AFTER_MS = 60 * MINUTE;
export const INTAKE_NOTICE_EVERY_MS = 24 * 60 * MINUTE;
/** The most sources one tick polls, and the most time one tick takes: well inside the broker function's 30 second timeout, checked between sources and between the tickets of a batch. */
export const INTAKE_SOURCES_PER_TICK = 20;
export const INTAKE_TICK_BUDGET_MS = 15_000;

/** What the poll tells a source's maintainers. Fixed words are the notifier's; this carries ids and a code only. */
export interface IntakeNotice {
  code: "source_failing";
  orgId: OrgId;
  project: string;
  sourceId: string;
  system: string;
  /** How long it has been failing, in minutes. */
  failingMinutes: number;
  /** The code of the last failure. */
  lastError: string;
}

export interface IntakePollDependencies {
  ports: IntakePorts;
  /** The search of a system (a registered tracker's `askedFor`). */
  searchFor: (system: string) => IntakeSearch | undefined;
  /** Tells the owner. A failure to tell is logged and the notice is tried again at the next failure. */
  notify(notice: IntakeNotice): Promise<void>;
  /** Read every source on a timer, not only the ones that ask for it: an install with no webhook of its own (a laptop) listens to nothing, so every source is polled. */
  pollAll?: boolean;
  /** How long one read may take (tests shorten it). */
  searchTimeoutMs?: number;
}

export type SourceOutcome =
  | { outcome: "polled"; started: number; waiting: number; duplicates: number; skipped: number }
  | { outcome: "not_due" | "not_polled" | "lost_lease" | "call_cap" }
  | { outcome: "failed"; code: string; noticed: boolean };

export interface PollReport {
  considered: number;
  polled: number;
  failed: number;
  notices: number;
  started: number;
  waiting: number;
  duplicates: number;
  skipped: Record<string, number>;
}

const hourOf = (now: number): string => new Date(now).toISOString().slice(0, 13);

/** The code a failure is recorded under: an allow-list, never the error's words. */
function failureCode(error: unknown): string {
  if (error instanceof TrackerSearchError) return error.code;
  if (error instanceof AgentXError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  if (error instanceof Error && error.message === "intake_timeout") return "TIMEOUT";
  return "SEARCH_FAILED";
}

/** Counts one read against the source's hour in one conditional update; false when the hour's reads are used up. */
async function countRead(ports: IntakePorts, orgId: OrgId, sourceId: string, now: number, max: number): Promise<boolean> {
  return (await ports.table.store.update({
    key: intakeCallsKey(orgId, sourceId, hourOf(now)),
    ops: [change.add("count", 1), change.set(INDEX_EXPIRY_ATTRIBUTE, Math.floor(now / 1000) + 2 * HOUR_SECONDS)],
    condition: when.or(when.notExists("count"), when.lt("count", max)),
  })).applied;
}

/** Takes the source for this tick: moves `nextPollAt` forward from the value that was read. Of two ticks only one wins. */
async function takeSource(ports: IntakePorts, record: IntakeSourceRecord, now: number, intervalMs: number): Promise<boolean> {
  return (await ports.table.store.update({
    key: intakeSourceKey(record.orgId, record.project, record.sourceId),
    ops: [change.set("nextPollAt", now + intervalMs), change.set("lastPolledAt", now)],
    condition: when.and(when.present(), when.eq("nextPollAt", record.nextPollAt)),
  })).applied;
}

/** Reads the source with a time limit. The adapter is asked to stop (`signal`); a read that ignores the signal is still abandoned after the limit. */
async function readWithin<Value>(timeoutMs: number, read: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(controller.signal),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("intake_timeout")); }, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function candidatesOf(record: IntakeSourceRecord, items: readonly IntakeSearchItem[]): { candidates: IntakeCandidate[]; dropped: number } {
  const system = intakeSystemOf(record.ref);
  const candidates: IntakeCandidate[] = [];
  let dropped = 0;
  for (const item of items.slice(0, INTAKE_MAX_ITEMS_PER_POLL)) {
    // A result that names another tracker than the source's is not the source's: it is dropped, never started.
    if (typeof item !== "object" || item === null || item.externalRef?.system !== system) {
      dropped += 1;
      continue;
    }
    candidates.push({ ...item, orgId: record.orgId, project: record.project, channel: record.ref.channel });
  }
  dropped += Math.max(0, items.length - INTAKE_MAX_ITEMS_PER_POLL);
  return { candidates, dropped };
}

/** A read worked: the source is healthy again. */
async function recordSuccess(ports: IntakePorts, record: IntakeSourceRecord): Promise<void> {
  if (record.failures === 0 && record.failingSince === undefined) return;
  await ports.table.store.update({
    key: intakeSourceKey(record.orgId, record.project, record.sourceId),
    ops: [change.set("failures", 0), change.remove("failingSince"), change.remove("lastError"), change.remove("noticedAt")],
    condition: when.present(),
  });
}

/** A read failed: back the source off, and tell the owner once it has failed for an hour. */
async function recordFailure(deps: IntakePollDependencies, record: IntakeSourceRecord, now: number, intervalMs: number, code: string): Promise<boolean> {
  const { ports } = deps;
  const { table } = ports;
  const failures = record.failures + 1;
  const backoff = Math.min(intervalMs * 2 ** Math.min(failures, 12), INTAKE_BACKOFF_MAX_MS);
  const failingSince = record.failingSince ?? now;
  const key = intakeSourceKey(record.orgId, record.project, record.sourceId);
  await table.store.update({
    key, ops: [change.set("nextPollAt", now + Math.max(backoff, intervalMs)), change.set("failures", failures), change.set("failingSince", failingSince), change.set("lastError", code)], condition: when.present(),
  });
  if (now - failingSince < INTAKE_NOTICE_AFTER_MS) return false;
  if (record.noticedAt !== undefined && now - record.noticedAt < INTAKE_NOTICE_EVERY_MS) return false;
  // Claim the notice first (a conditional update on the time we read), so two ticks tell the owner once.
  const claimed = await table.store.update({
    key, ops: [change.set("noticedAt", now)],
    condition: record.noticedAt === undefined ? when.and(when.present(), when.notExists("noticedAt")) : when.and(when.present(), when.eq("noticedAt", record.noticedAt)),
  });
  if (!claimed.applied) return false;
  try {
    await deps.notify({ code: "source_failing", orgId: record.orgId, project: record.project, sourceId: record.sourceId, system: intakeSystemOf(record.ref), failingMinutes: Math.floor((now - failingSince) / MINUTE), lastError: code });
    return true;
  } catch (error) {
    ports.log("intake_poll.notice_failed", { orgId: record.orgId, project: record.project, error: failureCode(error) });
    // Give the claim back, so the next failure tells them.
    await table.store.update({ key, ops: [change.remove("noticedAt")], condition: when.and(when.present(), when.eq("noticedAt", now)) }).catch(() => undefined);
    return false;
  }
}

/** One source, one tick. Never throws for a failing source (that is recorded); throws only if the source's own record can't be written. */
export async function pollIntakeSource(deps: IntakePollDependencies, record: IntakeSourceRecord, options: { deadline?: number } = {}): Promise<SourceOutcome> {
  const { ports } = deps;
  const now = ports.table.now();
  if (deps.pollAll !== true && !intakeSourceIsPolled(record.ref)) return { outcome: "not_polled" };
  if (record.nextPollAt > now) return { outcome: "not_due" };
  const settings = intakePollSettingsOf(record.ref.poll);
  const intervalMs = settings.everyMinutes * MINUTE;
  if (!await takeSource(ports, record, now, intervalMs)) return { outcome: "lost_lease" };
  const system = intakeSystemOf(record.ref);
  if (!await countRead(ports, record.orgId, record.sourceId, now, settings.maxCallsPerHour)) {
    ports.log("intake_poll.call_cap", { orgId: record.orgId, project: record.project, system });
    return { outcome: "call_cap" };
  }
  let result: { outcomes: IntakeOutcome[]; dropped: number; fault?: unknown };
  try {
    const search = deps.searchFor(system);
    if (search === undefined) throw agentXError("NOT_FOUND", "no search for this tracker");
    const items = await readWithin(deps.searchTimeoutMs ?? INTAKE_SEARCH_TIMEOUT_MS, (signal) => search({ orgId: record.orgId, project: record.project, source: record, signal, limit: INTAKE_MAX_ITEMS_PER_POLL }));
    if (!Array.isArray(items)) throw new Error("not a list");
    const read = candidatesOf(record, items);
    // A fault in a START (the start service away) is not a fault of the source: the read worked, the batch stops, and the tickets not yet handed over are seen again next tick.
    const done = await ingestIntakeBatchWithin(ports, read.candidates, options.deadline === undefined ? {} : { deadline: options.deadline });
    result = { outcomes: done.outcomes, dropped: read.dropped, ...(done.fault === undefined ? {} : { fault: done.fault }) };
  } catch (error) {
    const code = failureCode(error);
    ports.log("intake_poll.failed", { orgId: record.orgId, project: record.project, system, code });
    return { outcome: "failed", code, noticed: await recordFailure(deps, record, now, intervalMs, code) };
  }
  if (result.fault !== undefined) ports.log("intake_poll.start_fault", { orgId: record.orgId, project: record.project, system, code: failureCode(result.fault) });
  await recordSuccess(ports, record);
  const count = (kind: IntakeOutcome["outcome"]) => result.outcomes.filter((entry) => entry.outcome === kind).length;
  return { outcome: "polled", started: count("started"), waiting: count("waiting"), duplicates: count("duplicate"), skipped: count("skipped") + result.dropped };
}

/**
 * One tick of the scheduler: every due source, at most `INTAKE_SOURCES_PER_TICK` and `INTAKE_TICK_BUDGET_MS`, due ones first. A source that fails is recorded and the others go on.
 * Throws only a fault that is not a source's (the sources can't be listed), so the scheduler's retry runs the tick again.
 */
export async function runIntakePoll(deps: IntakePollDependencies, options: { maxSources?: number; budgetMs?: number } = {}): Promise<PollReport> {
  const { ports } = deps;
  const started = ports.table.now();
  const report: PollReport = { considered: 0, polled: 0, failed: 0, notices: 0, started: 0, waiting: 0, duplicates: 0, skipped: {} };
  const skip = (reason: string) => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };
  const sources = (await listAllIntakeSources(ports.table)).filter((record) => deps.pollAll === true || intakeSourceIsPolled(record.ref)).sort((a, b) => a.nextPollAt - b.nextPollAt);
  const max = options.maxSources ?? INTAKE_SOURCES_PER_TICK;
  for (const record of sources) {
    report.considered += 1;
    if (record.nextPollAt > started) { skip("not_due"); continue; }
    if (report.polled + report.failed >= max || ports.table.now() - started >= (options.budgetMs ?? INTAKE_TICK_BUDGET_MS)) { skip("tick_full"); continue; }
    let result: SourceOutcome;
    try {
      result = await pollIntakeSource(deps, record, { deadline: started + (options.budgetMs ?? INTAKE_TICK_BUDGET_MS) });
    } catch (error) {
      // The source's own record could not be written; the others go on, and this one is due again at its next tick.
      ports.log("intake_poll.source_unavailable", { orgId: record.orgId, project: record.project, error: failureCode(error) });
      report.failed += 1;
      continue;
    }
    if (result.outcome === "polled") {
      report.polled += 1;
      report.started += result.started;
      report.waiting += result.waiting;
      report.duplicates += result.duplicates;
    } else if (result.outcome === "failed") {
      report.failed += 1;
      if (result.noticed) report.notices += 1;
    } else skip(result.outcome);
  }
  return report;
}
