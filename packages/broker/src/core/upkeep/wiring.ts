// Nightly upkeep, connected to the ports (lead 4 N1): the schedule, the fire, the switch the unattended door reads, and the admins' notice. Hosts compose these; nothing here is on by itself.
//   - the SCHEDULE follows the switch (`createUpkeepSchedule`, used by `setUpkeepEnabled`): ON puts one schedule for the project at `UPKEEP_DEFAULT_CRON_UTC` (target kind `upkeep`), OFF removes it. A project that never turned
//     it on has none.
//   - the FIRE (`subscribeUpkeep`): a delivery whose target is `upkeep` runs `runUpkeepNight` for the company the fire names and the project its target names; any other target is left alone (the nightly TEST run's, a
//     schedule trigger's). A fire whose company has no upkeep wiring on this install, or whose project name is not a project name, does nothing. A fault that may pass is thrown so the scheduler delivers it again.
//   - the SWITCH the unattended door reads (`upkeepAutomationSwitch`): upkeep ON for THIS project, read on every use. The install-wide automation switch is not consulted for upkeep (the door is opened narrowly, for
//     upkeep only: chains, triggers and custom agents stay hidden).
//   - the PAUSE: `upkeepPauseHooks` writes the admins' notice (once per company, project, month and reason) when the limit read says paused before a start, and when the gateway pauses a started run.
import { createHash } from "node:crypto";
import { AGENTX_NAME_PATTERN, UPKEEP_TARGET_KIND, change, when, type DocumentStore, type DueSchedule, type OrgId, type ScheduleSubscription, type Scheduler, type UpkeepPauseReason } from "@agentx/contracts";
import type { AutomationSwitch } from "../automation/switch.js";
import { queueUpkeepPaused } from "../notify/attention.js";
import { upkeepNightKey, type UpkeepScope } from "./keys.js";
import { runUpkeepNight, type UpkeepNightDeps, type UpkeepNightResult } from "./night.js";
import { upkeepIsOn } from "./settings.js";

/** When the upkeep night runs (UTC): after the nightly test run's usual hours, so the setup check sees the day's merges. */
export const UPKEEP_DEFAULT_CRON_UTC = "30 4 * * *";
const HOUR_S = 3_600;

const sha = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");
/** The schedule's name: stable per project, and a legal schedule id. */
export const upkeepScheduleName = (orgId: string, project: string): string => `upkeep-${sha([orgId, project]).slice(0, 40)}`;

/** The project's upkeep night on the scheduler: `put` while the switch is ON, `remove` when it is OFF. Both are idempotent. */
export function createUpkeepSchedule(scheduler: Pick<Scheduler, "put" | "remove">): { put(scope: UpkeepScope): Promise<void>; remove(scope: UpkeepScope): Promise<void> } {
  return {
    put: (scope) => scheduler.put({
      companyId: scope.orgId, scheduleId: upkeepScheduleName(scope.orgId, scope.project), when: { kind: "cron", cron: UPKEEP_DEFAULT_CRON_UTC, timezone: "UTC" }, enabled: true,
      target: { kind: UPKEEP_TARGET_KIND, ref: { project: scope.project } }, maxLateSeconds: 6 * HOUR_S, description: "Rovara nightly upkeep",
    }),
    remove: async (scope) => { await scheduler.remove(scope.orgId, upkeepScheduleName(scope.orgId, scope.project)); },
  };
}

/** The switch the unattended door reads for one project's upkeep start: that project's own row says ON. Anything else (a read that fails included) is off. */
export function upkeepAutomationSwitch(deps: { store: DocumentStore; companyId: OrgId }, project: string): AutomationSwitch {
  return { enabled: () => upkeepIsOn(deps, project) };
}

export type UpkeepFireAnswer = (UpkeepNightResult & { project: string }) | { outcome: "ignored" };

/** Runs one fire. Not a fire of this install's company, or a target that names no project: ignored (nothing read, nothing done). */
export async function fireUpkeep(forCompany: (companyId: string) => UpkeepNightDeps | undefined, due: DueSchedule): Promise<UpkeepFireAnswer> {
  if (due.target.kind !== UPKEEP_TARGET_KIND) return { outcome: "ignored" };
  const project = due.target.ref["project"];
  if (typeof project !== "string" || !AGENTX_NAME_PATTERN.test(project)) return { outcome: "ignored" };
  const deps = forCompany(due.companyId);
  if (deps === undefined || deps.companyId !== due.companyId) return { outcome: "ignored" };
  return { ...(await runUpkeepNight(deps, { project })), project };
}

/** Subscribes the upkeep night to the scheduler (through the router the nightly test run and schedule triggers share). The outcome of every fire goes to `log` in fixed words. A throw reaches the scheduler, which delivers again. */
export function subscribeUpkeep(input: { scheduler: Pick<Scheduler, "subscribe">; forCompany: (companyId: string) => UpkeepNightDeps | undefined; log?: (entry: { event: string; outcome: string; attempt: number }) => void }): ScheduleSubscription {
  return input.scheduler.subscribe(async (due) => {
    if (due.target.kind !== UPKEEP_TARGET_KIND) return;
    const answer = await fireUpkeep(input.forCompany, due);
    input.log?.({ event: "upkeep.fire", outcome: answer.outcome, attempt: due.attempt });
  });
}

export interface UpkeepPauseHooksDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** Who is told: the project's admins and the company's owners and admins, as the host reads them now (64-hex person ids). */
  recipients(orgId: OrgId, project: string): Promise<readonly string[]>;
  realtime?: Parameters<typeof queueUpkeepPaused>[0]["realtime"];
  log?: (entry: Record<string, unknown>) => void;
}

/** The two places a pause is written: before a start (`UpkeepNightDeps.paused`) and when a started run is paused by the gateway (`WikiPageLoopDeps.onUpkeepPaused`). Each writes the same one-per-month-and-reason notice. */
export function upkeepPauseHooks(deps: UpkeepPauseHooksDeps): { paused(input: { orgId: OrgId; project: string; reason: UpkeepPauseReason }): Promise<void>; onRunPaused(scope: { orgId: OrgId; project: string }, reason: UpkeepPauseReason): Promise<void> } {
  const write = async (project: string, reason: UpkeepPauseReason): Promise<void> => {
    await queueUpkeepPaused({ store: deps.store, now: () => new Date(deps.now()), ...(deps.log === undefined ? {} : { log: deps.log }), realtime: deps.realtime, recipients: (orgId, project) => deps.recipients(orgId, project) }, { orgId: deps.companyId, project, reason });
  };
  return {
    paused: async ({ orgId, project, reason }) => { if (orgId === deps.companyId) await write(project, reason); },
    // A run of another company is never written here: the hook is made for one company's store.
    onRunPaused: async (scope, reason) => {
      if (scope.orgId !== deps.companyId) return;
      await write(scope.project, reason);
      // L4-SR1: the night's own row says the run was paused and why (the reason the gateway named), so the setup page and the audit read one place. Only a night that RAN is rewritten (a night that ended some other way, or a later night, is never turned into a pause by a late callback). Best effort: the notice above is the voice, this is the record.
      try {
        const nowMs = deps.now();
        await deps.store.update({ key: upkeepNightKey({ orgId: deps.companyId, project: scope.project }, new Date(nowMs).toISOString().slice(0, 10)), ops: [change.set(["outcome"], "paused"), change.set(["pauseReason"], reason)], condition: when.and(when.present(), when.eq("orgId", deps.companyId), when.eq("project", scope.project), when.eq("outcome", "ran")) });
      } catch (error) {
        deps.log?.({ event: "upkeep.pause_not_recorded", error: error instanceof Error ? error.name : "unknown" });
      }
    },
  };
}
