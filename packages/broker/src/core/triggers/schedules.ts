// Schedule triggers on the scheduler: a schedule trigger that is ON has one schedule at the scheduler, named by the trigger (`trigger-<id>`), whose target names only the company and the trigger. A scheduler only
// says WHEN: at each fire it tells the ONE handler below, and the core decides, from what is stored now, whether anything starts, in the same order and with the same gates as an event (the switch, the
// requirements read live, the one-start-per-slot identity, the trigger's allowance for the hour and the company's for the day, `Admission`). A scheduler that fires twice, late or after a restart does no harm.
//
import { OrgIdSchema, type DueSchedule, type OrgId } from "@agentx/contracts";
import { automationIsOn } from "../automation/switch.js";
import { errorName, iso } from "../automation/kit.js";
import { readChainRun } from "../chains/runner.js";
import { eventIdentity, refusalOf, runIdFor, startAgentFor, startChainFor, useAllowance, type AutonomousSource, type DispatchOutcome, type TriggerDispatchDeps } from "./dispatch.js";
import { disableTrigger } from "./lifecycle.js";
import { triggerProblems } from "./requirements.js";
import type { TriggerRecord } from "./store.js";

import { TRIGGER_SCHEDULE_KIND, triggerScheduleId } from "./schedule-spec.js";

export * from "./schedule-spec.js";

/** A start under way (a slot's claim) blocks another slot for this long; a stale one (a start cut short) is ignored. */
const START_CLAIM_MS = 120_000;
/** An agent run that has no way to be asked "are you still running" counts as open for this long. */
const UNKNOWN_OPEN_MS = 2 * 60 * 60_000;
const TRIGGER_ID = /^ctr_[0-9a-z]{20}$/u;

/** The slot a fire is: one start per slot, however often the scheduler delivers it. */
export const slotIdentity = (triggerId: string, slotId: string): string => eventIdentity(triggerId, `schedule#${slotId}`);

const logOf = (deps: Pick<TriggerDispatchDeps, "log">) => deps.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));

/** Whether the work this trigger last started is still open: a chain run that has not ended, or a task the host says is open (without a way to ask, one that began lately). */
async function previousWorkOpen(deps: TriggerDispatchDeps, trigger: TriggerRecord): Promise<boolean> {
  if (trigger.lastRunId !== undefined) {
    const run = await readChainRun(deps, trigger.orgId, trigger.lastRunId);
    return run !== undefined && !["succeeded", "failed", "cancelled", "timed_out"].includes(run.status);
  }
  if (trigger.lastTaskId !== undefined) {
    if (deps.taskOpen !== undefined) return deps.taskOpen(trigger.lastTaskId);
    return trigger.lastFiredAt !== undefined && deps.now() - Date.parse(trigger.lastFiredAt) < UNKNOWN_OPEN_MS;
  }
  return false;
}

/**
 * One fire of a schedule. Handled once however often it is delivered: the slot is claimed on the trigger's record (a conditional update on its revision) before any work is started, so two deliveries that both saw
 * no open work cannot both start; the one start per slot is also its identity. While automation is off, or when the trigger is gone or off, nothing starts (and a schedule with no live trigger is removed). A fault that
 * may pass is thrown, so the scheduler delivers the fire again.
 */
export async function handleScheduleFire(deps: TriggerDispatchDeps, due: DueSchedule): Promise<DispatchOutcome | undefined> {
  if (!(await automationIsOn(deps.automation))) return undefined;
  // Another feature's schedule on the same scheduler (the nightly run): not ours, and not a fault.
  if (due.target.kind !== TRIGGER_SCHEDULE_KIND) return undefined;
  const log = logOf(deps);
  const org = OrgIdSchema.safeParse(due.target.ref["orgId"]);
  const triggerId = due.target.ref["triggerId"];
  if (!org.success || typeof triggerId !== "string" || !TRIGGER_ID.test(triggerId) || due.scheduleId !== triggerScheduleId(triggerId)) {
    log("trigger_schedule.fire_invalid", {});
    return undefined;
  }
  const orgId: OrgId = org.data;
  if (orgId !== deps.companyId) { log("trigger_schedule.fire_other_company", {}); return undefined; }
  const trigger = await deps.triggers.get(orgId, triggerId);
  if (trigger === undefined || trigger.spec.kind !== "schedule") {
    await deps.scheduler?.remove(orgId, due.scheduleId).catch(() => undefined);
    return undefined;
  }
  const spec = trigger.spec;
  const record = async (result: Omit<DispatchOutcome, "triggerId">): Promise<DispatchOutcome> => {
    const outcome: DispatchOutcome = { triggerId, ...result };
    await deps.triggers.recordActivity(orgId, triggerId, { eventKey: `schedule#${due.slotId}`, outcome: outcome.outcome, ...(outcome.runId === undefined ? {} : { runId: outcome.runId }), ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }), ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
    log("trigger_schedule.outcome", { orgId, triggerId, outcome: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) });
    return outcome;
  };
  if (!trigger.enabled) return record({ outcome: "skipped", reason: "trigger_off" });
  // A fire that is late and whose trigger says "skip what was missed" is not run.
  const lateSeconds = (deps.now() - Date.parse(due.scheduledAt)) / 1000;
  if (spec.missed === "skip" && lateSeconds > 300) return record({ outcome: "skipped", reason: "missed" });
  const problems = await triggerProblems(deps.requirements, trigger);
  if (problems.some((problem) => problem.code === "RUNTIME_UNAVAILABLE")) return record({ outcome: "skipped", reason: "runtime_unavailable" });
  if (problems.length > 0) {
    await disableTrigger(deps, trigger, problems);
    return record({ outcome: "failed", reason: "trigger_invalid" });
  }
  const identity = slotIdentity(triggerId, due.slotId);
  // One start per slot: the work this slot already started is the answer.
  if (trigger.target.kind === "chain") {
    const existing = await readChainRun(deps, orgId, runIdFor(identity));
    if (existing !== undefined) return record({ outcome: "duplicate", runId: existing.runId });
  }
  // No overlap: a schedule never starts work while the work it last started is still going, and a start under way (a fresh claim by another slot) counts as work.
  if (trigger.startClaim !== undefined && trigger.startClaim.slot !== due.slotId && deps.now() - Date.parse(trigger.startClaim.at) < START_CLAIM_MS) return record({ outcome: "skipped", reason: "previous_run_open" });
  if (await previousWorkOpen(deps, trigger)) return record({ outcome: "skipped", reason: "previous_run_open" });
  // Claim the slot before anything is started: a conditional update on the revision; a lost race is another delivery of this fire (or another slot) that won.
  let claimed: TriggerRecord;
  try {
    claimed = await deps.triggers.update({ trigger, patch: { startClaim: { slot: due.slotId, at: iso(deps) } } });
  } catch (error) {
    log("trigger_schedule.claim_lost", { orgId, triggerId, error: errorName(error) });
    return record({ outcome: "skipped", reason: "previous_run_open" });
  }
  const used = await useAllowance(deps, orgId, claimed);
  if (used !== undefined) return record({ outcome: "skipped", reason: used });
  const source: AutonomousSource = {
    origin: "schedule", project: trigger.project, agentText: "Do your job for this scheduled run.", startedBy: { kind: "schedule", triggerId, scheduledAt: new Date(due.scheduledAt).toISOString() },
  };
  let started: { runId?: string; taskId?: string };
  try {
    started = claimed.target.kind === "chain" ? await startChainFor(deps, orgId, claimed, identity, source) : await startAgentFor(deps, orgId, claimed, identity, source);
  } catch (error) {
    const refusal = await refusalOf(deps, orgId, claimed, error);
    if ("transient" in refusal) { log("trigger_schedule.start_failed", { orgId, triggerId, error: errorName(refusal.transient) }); throw refusal.transient; }
    return record({ outcome: "failed", reason: refusal.reason });
  }
  const outcome = await record({ outcome: "started", ...started });
  // The note that takes the claim away (best effort: a stale claim is ignored, so a lost race here only leaves the claim a moment longer).
  const latest = await deps.triggers.get(orgId, triggerId).catch(() => undefined);
  if (latest !== undefined) await deps.triggers.update({ trigger: latest, clear: ["startClaim"], patch: { lastFiredAt: iso(deps), ...(started.runId === undefined ? {} : { lastRunId: started.runId }), ...(started.taskId === undefined ? {} : { lastTaskId: started.taskId }) } }).catch(() => undefined);
  return outcome;
}

/** The handler a schedule router is given: this feature's fires only (every other kind of fire is left alone). */
export const triggerScheduleHandler = (deps: TriggerDispatchDeps) => (due: DueSchedule): Promise<void> => handleScheduleFire(deps, due).then(() => undefined);
