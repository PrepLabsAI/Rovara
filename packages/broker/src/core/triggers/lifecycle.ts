// What happens to triggers: making one, turning one on (the owner's act, proved), turning one off, and what happens when something they depend on changes. A trigger is made OFF. Turning it ON needs the owner's proof
// bound to exactly what the trigger is now (its target, project, spec, hook and limit): a change to any of them turns the trigger off again, so a trigger never runs as something the owner did not see. A change to
// a target (a publish, an archive, a built-in turned off) re-checks every enabled trigger of the target against what runs now and turns off the ones that no longer qualify, saying so; the change that caused it still succeeds.
import {
  EventTriggerSpecSchema, ScheduleTriggerSpecSchema, SchedulerError, TRIGGER_MAX_RUNS_PER_HOUR, TriggerTargetSchema, agentXError,
  type ApprovalProof, type Approvers, type AuditSink, type OrgId, type Scheduler, type TransactItem, type TriggerTarget,
} from "@agentx/contracts";
import { automationRequest, verifyOwnerProof } from "../automation/authority.js";
import { requireAutomation, type AutomationSwitch } from "../automation/switch.js";
import { createHash } from "node:crypto";
import { errorName, iso, type RequestMark, type Table } from "../automation/kit.js";
import { scheduleEntryOf, scheduleRefusal, triggerScheduleId } from "./schedule-spec.js";
import { targetName, targetVersionOf, triggerProblemText, triggerProblems, triggerWords, type TriggerProblem, type TriggerRequirementDeps } from "./requirements.js";
import { isTriggerConflict, type TriggerRecord, type TriggerStore } from "./store.js";

export interface TriggerLifecycleDeps extends Table {
  companyId: OrgId;
  automation: AutomationSwitch;
  audit: AuditSink;
  approvers: Approvers;
  triggers: TriggerStore;
  requirements: TriggerRequirementDeps;
  /** The install's scheduler. Without one a schedule trigger cannot be turned on (it would never fire, and the owner would not know). */
  scheduler?: Pick<Scheduler, "put" | "remove" | "capabilities"> | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

const REASON_MAX = 300;
const NAME_MAX = 80;
const MAX_RETRIES = 3;
/** The hourly allowance a new trigger gets unless its maker names one. */
export const DEFAULT_TRIGGER_RUNS_PER_HOUR = 5;

const log = (deps: Pick<TriggerLifecycleDeps, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);
const trimStop = (text: string): string => text.replace(/\.+$/u, "");
const shown = (text: string, max: number): string => { const clean = text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").trim(); return [...clean].length <= max ? clean : `${[...clean].slice(0, max - 1).join("")}…`; };

/** What the owner sees when turning a trigger on, and what their proof is bound to: the trigger as it is AND the version of its target as it is (a publish after the page was drawn makes the proof stale). */
export const triggerFacts = (trigger: TriggerRecord, targetVersion: number | undefined) => ({ target: trigger.target, targetVersion: targetVersion ?? null, project: trigger.project, spec: trigger.spec, hookId: trigger.hookId ?? null, maxRunsPerHour: trigger.maxRunsPerHour });
/** The request AND the version of the target it was built from, read once: what is stored when the trigger is turned on is exactly the version the proof covers, never a newer one read a moment later. */
export async function triggerEnableOffer(deps: Pick<TriggerLifecycleDeps, "companyId" | "requirements">, trigger: TriggerRecord) {
  const version = await targetVersionOf(deps.requirements, trigger.orgId, trigger.target);
  return { version, request: automationRequest({ companyId: deps.companyId, kind: "trigger_on", subjectId: trigger.triggerId, revision: trigger.revision, facts: triggerFacts(trigger, version), project: trigger.project }) };
}
export const triggerEnableRequest = async (deps: Pick<TriggerLifecycleDeps, "companyId" | "requirements">, trigger: TriggerRecord) => (await triggerEnableOffer(deps, trigger)).request;

/** Makes a trigger, OFF. A project's trigger names one target (a chain or an agent), one project and what starts it. */
export async function createTrigger(deps: TriggerLifecycleDeps, input: { orgId: OrgId; target: unknown; project: string; spec: unknown; hookId?: string; maxRunsPerHour?: number; by: string; request?: RequestMark }): Promise<TriggerRecord> {
  await requireAutomation(deps.automation);
  const target = TriggerTargetSchema.safeParse(input.target);
  if (!target.success) throw agentXError("CONFIG_INVALID", `target: ${target.error.issues[0]?.message ?? "a chain or an agent"}`);
  const spec = input.spec !== null && typeof input.spec === "object" && (input.spec as { kind?: unknown }).kind === "schedule" ? ScheduleTriggerSpecSchema.safeParse(input.spec) : EventTriggerSpecSchema.safeParse(input.spec);
  if (!spec.success) throw agentXError("CONFIG_INVALID", `spec: ${spec.error.issues[0]?.message ?? "an event or a schedule"}`);
  const maxRunsPerHour = input.maxRunsPerHour ?? DEFAULT_TRIGGER_RUNS_PER_HOUR;
  if (!Number.isInteger(maxRunsPerHour) || maxRunsPerHour < 1 || maxRunsPerHour > TRIGGER_MAX_RUNS_PER_HOUR) throw agentXError("CONFIG_INVALID", `maxRunsPerHour: a whole number from 1 to ${String(TRIGGER_MAX_RUNS_PER_HOUR)}`);
  if (spec.data.kind === "schedule" && deps.scheduler !== undefined) {
    const refusal = scheduleRefusal(deps.scheduler.capabilities, spec.data);
    if (refusal !== undefined) throw agentXError("CONFIG_INVALID", `spec: ${refusal}`);
  }
  const record = await deps.triggers.create({
    record: { orgId: input.orgId, triggerId: deps.triggers.newTriggerId(), target: target.data, project: input.project, spec: spec.data, ...(input.hookId === undefined ? {} : { hookId: input.hookId }), enabled: false, maxRunsPerHour, createdBy: input.by },
    ...(input.request === undefined ? {} : { request: input.request }),
  });
  return record;
}

/**
 * Turns a trigger ON. Needs the owner's proof for exactly this trigger as it is now (`triggerEnableRequest`), a target that qualifies right now, and (for a schedule) the scheduler. The proof is used up in the same
 * transaction. Nothing a run, a report or an event says reaches here.
 */
export async function enableTrigger(deps: TriggerLifecycleDeps, orgId: OrgId, triggerId: string, proof: ApprovalProof | undefined): Promise<TriggerRecord> {
  await requireAutomation(deps.automation);
  const trigger = await deps.triggers.get(orgId, triggerId);
  if (trigger === undefined) throw agentXError("NOT_FOUND", "no trigger has that ID");
  if (trigger.enabled) return trigger;
  const problems = await triggerProblems(deps.requirements, trigger);
  if (problems.length > 0) throw agentXError(problems[0]!.code ?? "CONFIG_INVALID", triggerProblemText(problems[0]!));
  if (trigger.spec.kind === "schedule") {
    if (deps.scheduler === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this install has no scheduler, so a schedule can't be turned on");
    // A rule the scheduler cannot run is refused here, not left waiting: a trigger that is "on" and never fires would tell the owner something false.
    const refusal = scheduleRefusal(deps.scheduler.capabilities, trigger.spec);
    if (refusal !== undefined) throw agentXError("CONFIG_INVALID", `spec: ${refusal}`);
  }
  const offer = await triggerEnableOffer(deps, trigger);
  const verified = await verifyOwnerProof(deps.approvers, offer.request, proof);
  const schedule = trigger.spec.kind === "schedule";
  const version = offer.version;
  const on = await deps.triggers.update({
    trigger, patch: { enabled: true, ...(version === undefined ? {} : { approvedVersion: version }), ...(schedule ? { scheduleStatus: "pending" as const } : {}) }, clear: ["disabledReason"],
    extra: [verified.used, ...deps.audit.stage({ eventId: `evt_${createHash("sha256").update(`trigger.enabled\0${triggerId}\0${String(trigger.revision + 1)}`).digest("hex").slice(0, 40)}`, companyId: deps.companyId, at: iso(deps), actor: { type: "person", id: verified.approver.personId }, action: "trigger.enabled", subject: { type: "trigger", id: triggerId }, details: { method: verified.method } })],
    refuse: (failed) => (failed.has(1) ? agentXError("FORBIDDEN", "that approval was already used") : undefined),
  });
  if (!schedule) return on;
  return putSchedule(deps, on, true);
}

/** Puts (or replaces) the schedule of a schedule trigger and notes it as held; a scheduler that cannot be reached leaves it `pending` for the repair sweep. */
async function putSchedule(deps: TriggerLifecycleDeps, trigger: TriggerRecord, enabled: boolean): Promise<TriggerRecord> {
  try {
    await deps.scheduler!.put(scheduleEntryOf(trigger, enabled));
  } catch (error) {
    log(deps, "trigger_schedule.put_failed", { orgId: trigger.orgId, triggerId: trigger.triggerId, error: errorName(error) });
    // A scheduler that REFUSES the rule will refuse it again: the trigger is turned off with the reason, never left "on" and waiting. One that cannot be reached is tried again by the repair sweep.
    if (error instanceof SchedulerError && error.code === "refused") {
      await disableTrigger(deps, trigger, [{ path: "spec", message: `this install's scheduler refused the schedule (${error.message})` }]);
      await deps.triggers.dropPending(trigger.orgId, trigger.triggerId);
      return (await deps.triggers.get(trigger.orgId, trigger.triggerId)) ?? trigger;
    }
    return trigger;
  }
  const latest = await deps.triggers.get(trigger.orgId, trigger.triggerId);
  if (latest === undefined) return trigger;
  return deps.triggers.update({ trigger: latest, patch: { scheduleStatus: "ok" } }).catch(() => latest);
}

/** The schedules that were to be put and could not be: tries each pending one again. Returns how many it put. */
export async function repairPendingSchedules(deps: TriggerLifecycleDeps, limit = 50): Promise<number> {
  if (deps.scheduler === undefined) return 0;
  let put = 0;
  for (const { orgId, triggerId } of await deps.triggers.listPendingSchedules(limit)) {
    const trigger = await deps.triggers.get(orgId, triggerId);
    if (trigger === undefined || trigger.spec.kind !== "schedule") { await deps.triggers.dropPending(orgId, triggerId); continue; }
    if (trigger.scheduleStatus !== "pending") { await deps.triggers.dropPending(orgId, triggerId); continue; }
    const after = await putSchedule(deps, trigger, trigger.enabled);
    if (after.scheduleStatus === "ok") put += 1;
  }
  return put;
}

/** Turns a trigger off at the owner's word (no proof: stopping is always allowed), and takes its schedule away. */
export async function turnOffTrigger(deps: TriggerLifecycleDeps, orgId: OrgId, triggerId: string, by: string): Promise<TriggerRecord> {
  let current = await deps.triggers.get(orgId, triggerId);
  for (let attempt = 0; attempt < MAX_RETRIES && current !== undefined; attempt += 1) {
    if (!current.enabled) break;
    try {
      current = await deps.triggers.update({ trigger: current, patch: { enabled: false, disabledReason: "turned off by the owner" }, extra: [deps.triggers.activityItem(orgId, triggerId, { eventKey: `disabled#${String(current.revision + 1)}`, outcome: "disabled", reason: `turned off by ${shown(by, NAME_MAX)}` })] });
      break;
    } catch (error) {
      if (!isTriggerConflict(error)) throw error;
      current = await deps.triggers.get(orgId, triggerId);
    }
  }
  if (current === undefined) throw agentXError("NOT_FOUND", "no trigger has that ID");
  if (current.spec.kind === "schedule") await deps.scheduler?.remove(orgId, triggerScheduleId(triggerId)).catch((error: unknown) => log(deps, "trigger_schedule.remove_failed", { orgId, triggerId, error: errorName(error) }));
  return current;
}

/** Edits a trigger that is OFF. An edit to one that is on is refused: turn it off, change it, and turn it on again with a proof for what it now is. */
export async function updateTrigger(deps: TriggerLifecycleDeps, orgId: OrgId, triggerId: string, patch: { spec?: unknown; maxRunsPerHour?: number; hookId?: string }): Promise<TriggerRecord> {
  await requireAutomation(deps.automation);
  const trigger = await deps.triggers.get(orgId, triggerId);
  if (trigger === undefined) throw agentXError("NOT_FOUND", "no trigger has that ID");
  if (trigger.enabled) throw agentXError("CONFIG_INVALID", "turn the trigger off before changing it; it is turned on again with the owner's approval of what it then is");
  const next: Partial<TriggerRecord> = {};
  if (patch.spec !== undefined) {
    const parsed = trigger.spec.kind === "schedule" ? ScheduleTriggerSpecSchema.safeParse(patch.spec) : EventTriggerSpecSchema.safeParse(patch.spec);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `spec: ${parsed.error.issues[0]?.message ?? "is not valid"}`);
    next.spec = parsed.data;
  }
  if (patch.maxRunsPerHour !== undefined) {
    if (!Number.isInteger(patch.maxRunsPerHour) || patch.maxRunsPerHour < 1 || patch.maxRunsPerHour > TRIGGER_MAX_RUNS_PER_HOUR) throw agentXError("CONFIG_INVALID", `maxRunsPerHour: a whole number from 1 to ${String(TRIGGER_MAX_RUNS_PER_HOUR)}`);
    next.maxRunsPerHour = patch.maxRunsPerHour;
  }
  if (patch.hookId !== undefined) next.hookId = patch.hookId;
  return deps.triggers.update({ trigger, patch: next });
}

export async function deleteTrigger(deps: TriggerLifecycleDeps, orgId: OrgId, triggerId: string): Promise<void> {
  const trigger = await deps.triggers.get(orgId, triggerId);
  if (trigger === undefined) return;
  if (trigger.spec.kind === "schedule") await deps.scheduler?.remove(orgId, triggerScheduleId(triggerId)).catch(() => undefined);
  await deps.triggers.delete({ trigger });
}

// ---- turning a trigger off because it no longer qualifies

/**
 * Turns one trigger off with the reason of the first problem it has: a conditional update to `enabled: false` with `disabledReason`, an activity row `disabled` and the notice to its owner, in one transaction; then,
 * for a schedule trigger, its schedule is taken away. A trigger already off is left as it is.
 */
export async function disableTrigger(deps: TriggerLifecycleDeps, trigger: TriggerRecord, problems: readonly TriggerProblem[]): Promise<void> {
  const first = problems[0];
  if (first === undefined) return;
  let current: TriggerRecord | undefined = trigger;
  for (let attempt = 0; attempt < MAX_RETRIES && current !== undefined; attempt += 1) {
    if (!current.enabled) break;
    const reason = shown(triggerProblemText(first), REASON_MAX);
    const name = shown(await targetName(deps.requirements, current.orgId, current.target), NAME_MAX);
    const text = `${name}'s trigger "${triggerWords(current)}" was turned off: ${trimStop(reason)}.`;
    const extra: TransactItem[] = [
      deps.triggers.activityItem(current.orgId, current.triggerId, { eventKey: `disabled#${String(current.revision)}`, outcome: "disabled", reason }),
      ...deps.triggers.noticeItems(current.orgId, current.triggerId, current.createdBy, text),
    ];
    try {
      await deps.triggers.update({ trigger: current, patch: { enabled: false, disabledReason: reason }, extra });
      break;
    } catch (error) {
      if (!isTriggerConflict(error)) throw error;
      current = await deps.triggers.get(current.orgId, current.triggerId);
    }
  }
  if (trigger.spec.kind === "schedule") {
    // Dispatch of a due schedule asks the requirements and the trigger's own flag again, so one whose schedule could not be taken away is still not started.
    await deps.scheduler?.remove(trigger.orgId, triggerScheduleId(trigger.triggerId)).catch((error: unknown) => log(deps, "trigger_schedule.remove_failed", { orgId: trigger.orgId, triggerId: trigger.triggerId, error: errorName(error) }));
  }
}

export interface DisabledTrigger { triggerId: string; problems: TriggerProblem[] }

/** After a change to a target (a publish, a rollback, a built-in turned off): re-checks each enabled trigger of the target and turns off the ones that no longer qualify. Answers what it turned off. */
export async function recheckTriggersForTarget(deps: TriggerLifecycleDeps, orgId: OrgId, target: TriggerTarget): Promise<DisabledTrigger[]> {
  const turnedOff: DisabledTrigger[] = [];
  for (const trigger of await deps.triggers.listForTarget(orgId, target)) {
    if (!trigger.enabled) continue;
    const problems = await triggerProblems(deps.requirements, trigger);
    if (problems.length === 0) continue;
    await disableTrigger(deps, trigger, problems);
    turnedOff.push({ triggerId: trigger.triggerId, problems });
  }
  return turnedOff;
}

/** The target is archived: every trigger of it is turned off. */
export async function disableTriggersForTarget(deps: TriggerLifecycleDeps, orgId: OrgId, target: TriggerTarget): Promise<void> {
  for (const trigger of await deps.triggers.listForTarget(orgId, target)) {
    if (trigger.enabled) await disableTrigger(deps, trigger, [{ path: "target", message: "its target was archived" }]);
  }
}


/** After a publish, an archive or any other change to a chain or an agent: every enabled trigger of it is read again, and one whose target is no longer the version the owner turned it on for (or no longer qualifies) is turned off. */
export async function afterTargetChanged(deps: TriggerLifecycleDeps, orgId: OrgId, target: TriggerTarget): Promise<DisabledTrigger[]> {
  return recheckTriggersForTarget(deps, orgId, target);
}
