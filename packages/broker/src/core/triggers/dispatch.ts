// An event starts paid work with no person watching, so everything is decided here, at the moment of the event, from what is stored now and not from what was true when the trigger was saved. In order, for each
// enabled trigger of the receiving company, project, source and hook whose type and filter the event meets:
//   0. the switch (off: nothing is read, counted or started);
//   1. the loop guard (what Rovara itself did never starts work);
//   2. the requirements, read live (any problem turns the trigger off);
//   3. the event's identity (one run per event, however often it arrives);
//   4. the trigger's allowance for the hour, 5. the company's allowance for the day;
//   6. the start, through the one unattended door (`Admission` first), as the owner. It carries no approval and answers no question.
// A refusal is recorded by its code, never by its words; a fault that may pass is thrown after the other triggers have been tried, so the sender sends the event again and the identity makes the repeat harmless.
// Nothing in a log line is text the sender wrote: only ids, an outcome and a code.
import { createHash } from "node:crypto";
import {
  AgentXError, CHAIN_MAX_CONCURRENT_RUNS, ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, TRIGGER_MAX_RUNS_PER_HOUR, TRIGGER_SUBJECT_GUARD_MINUTES, TriggerEventSchema, agentXError, isBuiltinAgentId, recipeDigest, orgAutonomousKey,
  triggerRateKey, triggerSubjectKey, triggerSummary as eventSummary, INDEX_EXPIRY_ATTRIBUTE,
  type AgentId, type ChainRunStartedBy, type EventSource, type OrgId, type TriggerEvent, type TriggerOutcome,
} from "@agentx/contracts";
import { automationIsOn, type AutomationSwitch } from "../automation/switch.js";
import { countOne, errorName, iso, type Table } from "../automation/kit.js";
import { UNATTENDED_EVENT_TEXT, startUnattendedRun, type AutomatedOrigin, type UnattendedStartDeps } from "../automation/run-seam.js";
import { readGuardrails } from "../agents/guardrails.js";
import { resolveAgentForAutonomousRun } from "../agents/roster.js";
import { buildHandoff, type HandoffTrigger } from "../chains/handoff.js";
import { readChainRun, startChainRun, type ChainRunnerDeps } from "../chains/runner.js";
import { disableTrigger, type TriggerLifecycleDeps } from "./lifecycle.js";
import { triggerProblems } from "./requirements.js";
import type { TriggerRecord } from "./store.js";

export interface TriggerDispatchDeps extends Table, TriggerLifecycleDeps {
  companyId: OrgId;
  automation: AutomationSwitch;
  chainRuns: ChainRunnerDeps;
  unattended: UnattendedStartDeps;
  /** The person every unattended run is for: the owner of the install. */
  owner: { developerId: string };
  /** Rovara's own accounts at an outside system, as they are now, for the loop guard (a code host's `<app>[bot]`, a tracker's service account). Absent: only the event's own `actor.kind` is told. */
  rovaraActorIds?: (source: EventSource) => Promise<ReadonlySet<string>>;
  /** Whether a task a schedule trigger started is still going. Absent: a task that began lately counts as open (a schedule never overlaps itself on a doubt). */
  taskOpen?: (taskId: string) => Promise<boolean>;
}

/** What GitHub's API says of a pull request's or issue's author, asked now: a member of the repository's organisation, an outside collaborator with write access, nobody of those, or an error (which counts as nobody). */
export type AuthorVerdict = "member" | "collaborator" | "none" | "error";

/** What the source of one event can add to dispatch. `authorAssociation` in a webhook shows a private member as CONTRIBUTOR or NONE; `verifyAuthor` asks the host's API (not the payload) about the author, at most once per event, and never throws. */
export interface TriggerDispatchContext { verifyAuthor?: () => Promise<AuthorVerdict> }

export interface DispatchOutcome { triggerId: string; outcome: TriggerOutcome; runId?: string; taskId?: string; reason?: string }

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
const BUSY_CODES: ReadonlySet<string> = new Set(["WORKSPACE_BUSY", "TOO_MANY_REQUESTS"]);
const BOOKKEEPING_TRIES = 5;
const REQUEST_NAMESPACE = Buffer.from("a1d6f7c2e0b34e5c8f4a2b9d7c6e5f31", "hex");
/** The minutes an unattended agent run may take. */
export const UNATTENDED_AGENT_MINUTES = 120;

const logOf = (deps: Pick<TriggerDispatchDeps, "log">) => deps.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));

/** The identity of one trigger's start for one event: the same event at the same trigger is the same start. */
export const eventIdentity = (triggerId: string, eventKey: string): string => createHash("sha256").update(`${triggerId}\0${eventKey}`).digest("hex");
/** A chain run's id from an identity: `crn_` and 20 base-36 characters. */
export const runIdFor = (identity: string): string => `crn_${BigInt(`0x${identity}`).toString(36).slice(-20).padStart(20, "0")}`;
/** The request id for a start (a UUID v5 of the identity), so a repeat of the start is the first one's answer. */
export function requestIdFor(identity: string): string {
  const hash = createHash("sha1").update(REQUEST_NAMESPACE).update(identity).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether every key of the trigger's filter has one of its values among the event's, without regard to case. A key the event does not have, or a filter with no values, does not match. */
function meetsFilter(filter: Record<string, string[]> | undefined, fields: TriggerEvent["fields"]): boolean {
  for (const [key, wanted] of Object.entries(filter ?? {})) {
    const have = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!Array.isArray(have) || !Array.isArray(wanted)) return false;
    const lower = new Set(wanted.map((value) => value.toLowerCase()));
    if (!have.some((value) => lower.has(value.toLowerCase()))) return false;
  }
  return true;
}

/** Whether a stored trigger is one this event is for, apart from its filter: the record itself says so, whatever the index it was found under. */
function isForExceptFilter(trigger: TriggerRecord, orgId: OrgId, event: TriggerEvent): boolean {
  const { spec } = trigger;
  return trigger.orgId === orgId && trigger.enabled === true && trigger.project === event.project && spec.kind === "event" && spec.source === event.source && spec.type === event.type && trigger.hookId === event.hookId;
}

const AUTHOR_KEY = "authorAssociation";
const VERIFIED_AS: Record<"member" | "collaborator", string> = { member: "MEMBER", collaborator: "COLLABORATOR" };
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["MEMBER", "COLLABORATOR"]);

const missedKeys = (filter: Record<string, string[]> | undefined, fields: TriggerEvent["fields"]): string[] => Object.keys(filter ?? {}).filter((key) => !meetsFilter({ [key]: filter![key]! }, fields));

interface Work {
  deps: TriggerDispatchDeps;
  orgId: OrgId;
  event: TriggerEvent;
  log: (event: string, fields: Record<string, unknown>) => void;
  actors: Map<EventSource, Promise<ReadonlySet<string>>>;
  context: TriggerDispatchContext;
  verdict?: Promise<AuthorVerdict>;
  misses: Array<{ triggerId: string; filterKeys: string[]; membership: AuthorVerdict | "not_checked" }>;
}

function verdictOf(work: Work): Promise<AuthorVerdict> {
  work.verdict ??= (async (): Promise<AuthorVerdict> => {
    try {
      const verdict = await work.context.verifyAuthor!();
      return verdict === "member" || verdict === "collaborator" || verdict === "none" ? verdict : "error";
    } catch {
      return "error";
    }
  })();
  return work.verdict;
}

/** Whether the event meets the trigger's filter. When the only thing it misses is `authorAssociation` and the trigger would take a member or a collaborator, the author is looked up through the API: a verified author is counted for this match. The payload alone never upgrades anyone. */
async function meetsTriggerFilter(work: Work, trigger: TriggerRecord): Promise<boolean> {
  const { spec } = trigger;
  const filter = spec.kind === "event" ? spec.filter : undefined;
  const { event } = work;
  if (meetsFilter(filter, event.fields)) return true;
  const missed = missedKeys(filter, event.fields);
  const wanted = filter !== undefined && Object.hasOwn(filter, AUTHOR_KEY) ? filter[AUTHOR_KEY] : undefined;
  let membership: AuthorVerdict | "not_checked" = "not_checked";
  if (work.context.verifyAuthor !== undefined && Array.isArray(wanted) && missed.length === 1 && missed[0] === AUTHOR_KEY && wanted.some((value) => TRUSTED_ASSOCIATIONS.has(value.toUpperCase()))) {
    membership = await verdictOf(work);
    if (membership === "member" || membership === "collaborator") {
      const have = Object.hasOwn(event.fields, AUTHOR_KEY) ? event.fields[AUTHOR_KEY] : undefined;
      if (meetsFilter(filter, { ...event.fields, [AUTHOR_KEY]: [...(Array.isArray(have) ? have : []), VERIFIED_AS[membership]] })) return true;
    }
  }
  work.misses.push({ triggerId: trigger.triggerId, filterKeys: missed, membership });
  return false;
}

const handoffOf = (event: TriggerEvent): HandoffTrigger => ({
  eventKey: event.eventKey, source: event.source, type: event.type,
  subject: { kind: event.subject.kind, title: event.subject.title, ...(event.subject.url === undefined ? {} : { url: event.subject.url }) },
});

/** The record of an outcome: an activity row, and a log line with ids and a code only. */
async function settle(work: Work, trigger: TriggerRecord, result: Omit<DispatchOutcome, "triggerId">): Promise<DispatchOutcome> {
  const outcome: DispatchOutcome = { triggerId: trigger.triggerId, ...result };
  await work.deps.triggers.recordActivity(work.orgId, trigger.triggerId, {
    eventKey: work.event.eventKey, outcome: outcome.outcome,
    ...(outcome.runId === undefined ? {} : { runId: outcome.runId }), ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }), ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  work.log("trigger_dispatch.outcome", { orgId: work.orgId, triggerId: trigger.triggerId, outcome: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
  return outcome;
}

async function causedByRovara(work: Work): Promise<boolean> {
  const { event } = work;
  if (event.actor.kind === "rovara") return true;
  // The provider's word is not the only one: the actor is checked against Rovara's own accounts as they are now.
  if (event.actor.id === undefined || work.deps.rovaraActorIds === undefined) return false;
  let ids = work.actors.get(event.source);
  if (ids === undefined) {
    ids = work.deps.rovaraActorIds(event.source);
    work.actors.set(event.source, ids);
  }
  return (await ids).has(event.actor.id);
}

/** Notes that the trigger fired, for the no-overlap check. Best effort: the run is already started and its activity written, so a lost race here only leaves the note a moment late. */
async function noteFired(work: Work, trigger: TriggerRecord, started: { runId?: string; taskId?: string }): Promise<void> {
  const store = work.deps.triggers;
  let current: TriggerRecord | undefined = trigger;
  for (let attempt = 0; attempt < BOOKKEEPING_TRIES && current !== undefined; attempt += 1) {
    try {
      await store.update({ trigger: current, patch: { lastFiredAt: iso(work.deps), ...(started.runId === undefined ? {} : { lastRunId: started.runId }), ...(started.taskId === undefined ? {} : { lastTaskId: started.taskId }) } });
      return;
    } catch (error) {
      current = await store.get(work.orgId, trigger.triggerId).catch(() => undefined);
      if (current === undefined || attempt === BOOKKEEPING_TRIES - 1) work.log("trigger_dispatch.bookkeeping_failed", { orgId: work.orgId, triggerId: trigger.triggerId, error: errorName(error) });
    }
  }
}

/** What went wrong at the start, as the outcome: a code, `busy`, or (for a fault that may pass) the error itself to throw. */
export async function refusalOf(deps: Pick<TriggerDispatchDeps, "chainRuns">, orgId: OrgId, trigger: TriggerRecord, error: unknown): Promise<{ reason: string } | { transient: unknown }> {
  if (!(error instanceof AgentXError)) return { transient: error };
  // A service that is away (`RUNTIME_UNAVAILABLE` and its kind answer 503) may be back when the sender sends the event again.
  if (error.statusCode >= 500) return { transient: error };
  if (BUSY_CODES.has(error.code)) return { reason: "busy" };
  if (error.code === "FORBIDDEN" && trigger.target.kind === "chain") {
    // The chain's concurrency refusal has no code of its own: it is the one that leaves the chain with its most runs open.
    const chain = await deps.chainRuns.chains.get(orgId, trigger.target.chainId);
    if (chain !== undefined && chain.openRuns >= CHAIN_MAX_CONCURRENT_RUNS) return { reason: "busy" };
  }
  return { reason: error.code };
}

/** What starts the work, apart from the trigger: an event's, or a schedule's slot. The same steps start either. */
export interface AutonomousSource {
  origin: Extract<AutomatedOrigin, "event" | "schedule">;
  project: string;
  startedBy: ChainRunStartedBy;
  /** The event that started it, for the hand-off and the run's input; a schedule has none. */
  event?: TriggerEvent;
  /** The chain run's input, and the agent's text. */
  chainInput?: string;
  agentText: string;
}

/** Starts a chain trigger's run as the install's owner. */
export async function startChainFor(deps: TriggerDispatchDeps, orgId: OrgId, trigger: TriggerRecord, identity: string, source: AutonomousSource): Promise<{ runId: string }> {
  if (trigger.target.kind !== "chain") throw new Error("not a chain trigger");
  const run = await startChainRun(deps.chainRuns, {
    orgId, chainId: trigger.target.chainId, project: source.project, origin: source.origin, startedBy: source.startedBy,
    ...(source.event === undefined ? {} : { trigger: handoffOf(source.event) }), ...(source.chainInput === undefined ? {} : { input: source.chainInput }), runId: runIdFor(identity), owner: deps.owner,
  });
  return { runId: run.runId };
}

/** Starts an agent trigger's task, through the one unattended door: the published version, the guardrails' per-run ceiling and an `Admission` decision first. */
export async function startAgentFor(deps: TriggerDispatchDeps, orgId: OrgId, trigger: TriggerRecord, identity: string, source: AutonomousSource): Promise<{ taskId: string }> {
  if (trigger.target.kind !== "agent") throw new Error("not an agent trigger");
  const agentId: AgentId = trigger.target.agentId;
  if (!isBuiltinAgentId(agentId) && await deps.requirements.roster.store.get(orgId, agentId) === undefined) throw agentXError("NOT_FOUND", "no agent has that ID");
  const { ref, recipe } = await resolveAgentForAutonomousRun(deps.requirements.roster, { orgId, project: source.project, agentId });
  const context = source.event === undefined ? [] : buildHandoff({ runId: identity.slice(0, 20), trigger: handoffOf(source.event), earlier: [], mode: "previous" } as never);
  const guardrails = await readGuardrails(deps.requirements.roster.store.table, orgId);
  const started = await startUnattendedRun(deps.unattended, {
    recipeDigest: recipeDigest(recipe), requestId: requestIdFor(identity), project: source.project, agent: { agentId, version: ref.version }, input: { text: source.agentText, ...(context.length === 0 ? {} : { context }) }, origin: source.origin,
    // Nobody started this run, so it names the trigger that did (taken from the trigger's own record, never from the event).
    trigger: { kind: source.origin, triggerId: trigger.triggerId },
    limits: { maxRunUsd: guardrails.maxPerRunCeilingUsd, maxMinutes: UNATTENDED_AGENT_MINUTES },
  });
  return { taskId: started.taskId };
}

const eventSourceOf = (event: TriggerEvent, triggerId: string): AutonomousSource => ({
  origin: "event", project: event.project, event, agentText: UNATTENDED_EVENT_TEXT, chainInput: eventSummary(event),
  startedBy: { kind: "event", triggerId, eventKey: event.eventKey, source: event.source, type: event.type, title: event.subject.title, ...(event.subject.url === undefined ? {} : { url: event.subject.url }) },
});

const subjectKeyOf = (work: Work, trigger: TriggerRecord) => triggerSubjectKey(work.orgId, trigger.triggerId, work.event.subject);

/** Whether this trigger started a run for the event's subject less than `TRIGGER_SUBJECT_GUARD_MINUTES` ago. */
async function recentlyStarted(work: Work, trigger: TriggerRecord): Promise<boolean> {
  const found = await work.deps.store.get(subjectKeyOf(work, trigger));
  const at = typeof found?.["at"] === "string" ? Date.parse(found["at"]) : Number.NaN;
  return Number.isFinite(at) && work.deps.now() - at < TRIGGER_SUBJECT_GUARD_MINUTES * 60_000;
}

/** Notes that this trigger started a run for the event's subject now. Best effort: the run exists, and a note that is lost only lets one more event through. */
async function noteSubject(work: Work, trigger: TriggerRecord): Promise<void> {
  try {
    await work.deps.store.put({ item: { ...subjectKeyOf(work, trigger), entityType: "TRIGGER_SUBJECT", orgId: work.orgId, at: iso(work.deps), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(work.deps.now() / 1000) + 2 * HOUR_SECONDS } });
  } catch (error) {
    work.log("trigger_dispatch.bookkeeping_failed", { orgId: work.orgId, triggerId: trigger.triggerId, error: errorName(error) });
  }
}

/**
 * The trigger's allowance for the hour (never above the platform's), then the company's for the day. Undefined when both allow it. Two deliveries of one event at the same moment may each count here before the event's
 * identity collapses them into one start: that over-counts by one per racing delivery, which errs on the side of fewer runs, never more.
 */
export async function useAllowance(deps: Table, orgId: OrgId, trigger: Pick<TriggerRecord, "triggerId" | "maxRunsPerHour">): Promise<"rate_limited" | "org_daily_limit" | undefined> {
  const now = iso(deps);
  const allowed = Number.isInteger(trigger.maxRunsPerHour) ? Math.min(trigger.maxRunsPerHour, TRIGGER_MAX_RUNS_PER_HOUR) : 0;
  if (!await countOne(deps, triggerRateKey(orgId, trigger.triggerId, now.slice(0, 13)), allowed, 2 * HOUR_SECONDS)) return "rate_limited";
  if (!await countOne(deps, orgAutonomousKey(orgId, now.slice(0, 10)), ORG_MAX_AUTONOMOUS_RUNS_PER_DAY, 2 * DAY_SECONDS)) return "org_daily_limit";
  return undefined;
}

/** One trigger, one event. Returns its outcome, or throws what may pass so that the event is sent again. */
async function dispatchOne(work: Work, trigger: TriggerRecord): Promise<{ outcome: DispatchOutcome } | { transient: unknown }> {
  const { deps, orgId, event } = work;
  // 1. The loop guard, before anything is read or counted: what Rovara did never starts what Rovara does.
  if (await causedByRovara(work)) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "caused_by_rovara" }) };
  // 2. What the trigger needs, read now. Any problem turns it off, says so and starts nothing; no allowance is used.
  const problems = await triggerProblems(deps.requirements, trigger);
  // A service of ours that is away is not the trigger's fault: it stays on, the event is skipped and the fault is logged.
  if (problems.some((problem) => problem.code === "RUNTIME_UNAVAILABLE")) {
    work.log("trigger_dispatch.runtime_unavailable", { orgId, triggerId: trigger.triggerId });
    return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "runtime_unavailable" }) };
  }
  if (problems.length > 0) {
    await disableTrigger(deps, trigger, problems);
    return { outcome: await settle(work, trigger, { outcome: "failed", reason: "trigger_invalid" }) };
  }
  // 3. One start per event: a start that is already there is the answer, and uses no allowance.
  const identity = eventIdentity(trigger.triggerId, event.eventKey);
  if (trigger.target.kind === "chain") {
    const existing = await readChainRun(deps, orgId, runIdFor(identity));
    if (existing !== undefined) return { outcome: await settle(work, trigger, { outcome: "duplicate", runId: existing.runId }) };
  } else {
    const existing = await deps.unattended.starter.read(requestIdFor(identity));
    if (existing !== undefined) return { outcome: await settle(work, trigger, { outcome: "duplicate", taskId: existing.taskId }) };
  }
  // The subject this trigger just started a run for: what that run did to it may be what this event is, so it is not started again at once. No allowance is used.
  if (await recentlyStarted(work, trigger)) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: "recent_subject" }) };
  // 4 and 5. The allowances.
  const used = await useAllowance(deps, orgId, trigger);
  if (used !== undefined) return { outcome: await settle(work, trigger, { outcome: "skipped", reason: used }) };
  // 6. The start. A refusal is a recorded outcome; a fault that may pass is the event's to be sent again.
  let started: { runId?: string; taskId?: string };
  try {
    const source = eventSourceOf(event, trigger.triggerId);
    started = trigger.target.kind === "chain" ? await startChainFor(deps, orgId, trigger, identity, source) : await startAgentFor(deps, orgId, trigger, identity, source);
  } catch (error) {
    const refusal = await refusalOf(deps, orgId, trigger, error);
    if ("transient" in refusal) {
      work.log("trigger_dispatch.start_failed", { orgId, triggerId: trigger.triggerId, error: errorName(refusal.transient) });
      return { transient: refusal.transient };
    }
    return { outcome: await settle(work, trigger, { outcome: "failed", reason: refusal.reason }) };
  }
  // The start happened: whatever goes wrong in writing it down, the run is noted on the trigger and its subject, and the fault is the event's to be sent again for.
  try {
    return { outcome: await settle(work, trigger, { outcome: "started", ...started }) };
  } finally {
    await noteSubject(work, trigger);
    await noteFired(work, trigger, started);
  }
}

/**
 * Starts the work of every trigger the event is for: enabled triggers of this company, project, source and hook (and no other's: nothing outside the company's keys is read) whose type is the event's and whose every
 * filter key has one of its values among the event's. Answers what each did. While automation is off it does nothing at all. Throws when a start failed in a way that may pass, after every other trigger has been tried.
 */
export async function dispatchTriggerEvent(deps: TriggerDispatchDeps, orgId: OrgId, input: TriggerEvent, context: TriggerDispatchContext = {}): Promise<DispatchOutcome[]> {
  if (!(await automationIsOn(deps.automation))) return [];
  const log = logOf(deps);
  const parsed = TriggerEventSchema.safeParse(input);
  if (!parsed.success) {
    log("trigger_dispatch.event_invalid", { orgId });
    return [];
  }
  const event = parsed.data;
  // A code host's events come through its own connection and have no hook; every other source's come through one hook. An event that is neither would read the wrong index.
  if ((event.source === "github") !== (event.hookId === undefined)) {
    log("trigger_dispatch.hook_mismatch", { orgId, source: event.source });
    return [];
  }
  const work: Work = { deps, orgId, event, log, actors: new Map(), context, misses: [] };
  const outcomes: DispatchOutcome[] = [];
  let transient: { error: unknown } | undefined;
  let unreadable = 0;
  const found = await deps.triggers.listForMatch(orgId, event.source, event.project, event.hookId, (triggerId) => {
    unreadable += 1;
    log("trigger_dispatch.record_unreadable", { orgId, triggerId });
  });
  if (unreadable > 0) log("trigger_dispatch.records_skipped", { orgId, count: unreadable });
  for (const trigger of found) {
    try {
      if (!isForExceptFilter(trigger, orgId, event) || !await meetsTriggerFilter(work, trigger)) continue;
      const done = await dispatchOne(work, trigger);
      if ("outcome" in done) outcomes.push(done.outcome);
      else transient ??= { error: done.transient };
    } catch (error) {
      log("trigger_dispatch.failed", { orgId, triggerId: trigger.triggerId, error: errorName(error) });
      transient ??= { error };
    }
  }
  if (transient !== undefined) throw transient.error;
  if (outcomes.length === 0) {
    const association = (event.fields[AUTHOR_KEY] ?? []).filter((value) => /^[A-Z_]{1,24}$/.test(value)).slice(0, 4);
    for (const miss of work.misses) log("trigger_dispatch.filter_miss", { orgId, project: event.project, triggerId: miss.triggerId, type: event.type, filterKeys: miss.filterKeys, authorAssociation: association, membership: miss.membership });
  }
  return outcomes;
}

