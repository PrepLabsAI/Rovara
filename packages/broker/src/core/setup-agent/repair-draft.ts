// L4-RD (DEC 254z c, 254zza; setup-upkeep-plan.md decision 1, "if it needs a person"): the automatic repair draft. See repair-rows.ts for the rows and the words.
//
// The rule this file keeps: Rovara DRAFTS, a person DECIDES. Nothing here approves a setup, makes a candidate the project's latest revision, imports the approval gate, or asks a model anything itself. What it does:
//   1. When the free re-check (recheck.ts) settles as "setup broken", and ONLY THEN, `startRepairDraft` decides whether to start ONE setup-agent run for that failure. It starts nothing unless ALL of these hold, each read
//      now and each failing CLOSED (a throw, a missing answer or a malformed one is "no"):
//        - the company's EFFECTIVE system-runs gate is on (L4-P2, owner DEC 254zzt: the operator's `CoreSystemRuns` ceiling AND the company's consent, `effectiveSystemRunsGate`). An absent gate is OFF: this file never
//          starts anything on its own authority. The hosted host wires this hook and passes that gate (core-host/setup-repair.ts, L4-SR2); a host that does not pass it never starts a draft;
//        - a person turned upkeep ON for the project (`UpkeepGate.enabled`: a page-only act, audited; this file only reads it);
//        - a dollar cap is enforced on this install (the unattended door's `enforces.dollars`; the door itself refuses a model run without one);
//        - the project's upkeep cap has room for the whole run (`UpkeepGate.roomCents` >= the run's budget). The gateway holds the real cap on every model call (the token carries the work origin "nightly", so the
//          project's `upkeep_month` row applies, L4-E); this read only avoids starting a run the gateway would refuse;
//        - the project is still at the revision that broke, no automatic draft was ever started for that revision (`REPAIR_REV#`), no candidate waits for a decision, no setup run is going, and no automatic draft started in the last `REPAIR_COOLDOWN_MS`.
//      One repair per failure: the claim row is keyed by the re-check, written only if absent, so a double call starts one run, and a failed draft is final (no loop).
//   2. The run is started through THE one unattended door (`startUnattendedRun`: the switch, the cap, `Admission`, the host's starter), with the run's own limits (the setup agent's existing limits, about $4) and the
//      origin "nightly" (the project pays; the gateway's upkeep cap applies). The host's starter starts the project's setup run as the project's system owner; the door refuses a `setupRepair` request unless the starter declares `startsSetupRepair` (L4-SR2).
//   3. `advanceRepairDraft` moves it on from the stored facts, safe to call from anywhere and any number of times: the run ended with a proposal Rovara itself finished (`proposed`, not partial) -> the candidate is stored
//      by `confirmSetupAgent` (the SAME path a person's "Use this setup" takes: every citation re-read from the code host, the candidate stored but not the project's latest, its check started on a NEW workspace) ->
//      the candidate's check passed -> `ready`: the project's maintainers see "Approve new setup", and the decision is the hosted approval gate's (risk-based approvers, the digest) as for any setup.
//      A run that failed, a proposal nothing could be used from, or a candidate whose check failed ends the draft as `failed`, in fixed words, and the failed candidate is removed. The manual "Fix setup" stays open.
//
// L4-SR2 (lead 4, owner DEC 254zzl/254zzt/254zzy): the AUTOMATIC path is wired on a hosted install and is OFF until every one of its locks is open (the company's effective system-runs gate, the project's upkeep switch, an enforced cap
// with room): core-host/setup-repair.ts supplies the hosted pieces (the hook on `TaskFlowDeps.afterSetupBroken`, the setup-run starter that starts as the project's system owner, the progress pass); the access rule
// (core/system-runs/access.ts) accepts the system owner for a `setup_agent` task only with the marks. What this file adds to #927: the audit record is written BEFORE the run starts (a record that cannot be written starts
// nothing); one automatic draft per (project, broken setup revision); the effective gate and the upkeep switch are read again on every move of a draft, and a draft whose gate went off stops (its run is cancelled, its own
// candidate removed), so withdrawing consent or switching upkeep off ends it at the next pass; a run the gateway paused for the upkeep cap ends the draft and writes the admins' notice (N1).
import { createHash } from "node:crypto";
import {
  ROVARA_CODE_AGENT_ID, SETUP_RUN_END_WORDS, SYSTEM_RUN_AUDIT, UpkeepPauseReasonSchema, change, effectiveSetupAgentLimits, systemOwnerIdOf, when,
  type SetupDriftClass, type TransactItem, type UpkeepPauseReason,
} from "@agentx/contracts";
import { eventIdOf } from "../automatic-runs/cap.js";
import { systemRunsGateSaysOn, type SystemRunsGate } from "../system-runs/consent.js";
import { putRow } from "../automation/kit.js";
import { startUnattendedRun, type AutomatedRunRequest, type UnattendedStartDeps } from "../automation/run-seam.js";
import { iso, log } from "../task-flow/support.js";
import { readState, setupAgentRequestText } from "./agent.js";
import { confirmSetupAgent, discardSetupApply, readSetupApply, setupCandidateRisk, waitingSetupApply, type SetupApplyDeps } from "./apply.js";
import { expiryOf } from "./keys.js";
import { advanceCurrentRecheck, readSetupRepairCard, type RecheckRow } from "./recheck.js";
import { isRow, recheckRowKey, repairNoticeKey } from "./recheck-rows.js";
import {
  REPAIR_COOLDOWN_MS, REPAIR_GRACE_MINUTES, REPAIR_START_STALE_MS, REPAIR_WORDS, fixSetupLabel, repairCurrentKey, repairRevisionKey, repairRowKey,
  type RepairCurrentRow, type RepairReason, type RepairRevisionRow, type RepairRow, type RepairState, type SetupRepairView,
} from "./repair-rows.js";

export * from "./repair-rows.js";

/**
 * What the install says about the project's upkeep: a switch a person turned on (page-only, audited, never an API token: not decided here) and what is left of the project's monthly upkeep cap. The host fills it in from
 * the upkeep setting and Cloud's `upkeep_month` limit (L4-E). Absent, a throw, or an answer that is not exactly `true` / a whole number of cents: no automatic draft.
 */
export interface UpkeepGate {
  enabled(project: string): Promise<boolean>;
  /** Whole cents of the project's monthly upkeep cap that are still free, or undefined when it cannot be read (no room). */
  roomCents(project: string): Promise<number | undefined>;
}

export interface RepairDraftDeps extends SetupApplyDeps {
  /** The company's EFFECTIVE system-runs gate (the operator's ceiling AND the company's consent, read now). Absent, a throw or anything but an explicit `true`: no automatic draft. */
  systemRuns?: SystemRunsGate | undefined;
  upkeep?: UpkeepGate | undefined;
  /** The unattended door's dependencies (the switch, the cap declaration, `Admission`, the host's starter). Absent: nothing starts on its own. */
  run?: UnattendedStartDeps | undefined;
  /** N1: tells the project's admins (once per month and reason) that the gateway paused nightly upkeep under a draft's run. Never throws. Absent: nobody is told (the draft still ends). */
  onUpkeepPaused?: ((project: string, reason: UpkeepPauseReason) => Promise<void>) | undefined;
}

/** Why a draft was not started (nothing was written, nothing was spent). */
export type RepairSkip = "not_broken" | "system_runs_off" | "upkeep_off" | "no_cap" | "no_room" | "busy" | "cooling_down" | "already_drafted" | "start_refused";
export type RepairStart = { status: "started"; row: RepairRow } | { status: "exists"; row: RepairRow } | { status: "skipped"; why: RepairSkip };

/** A draft whose run or check has not finished after this long is over (the run's own stale rule is shorter; this covers a proposal that can never be confirmed). */
const ABANDON_MS = 48 * 3_600_000;
const expiry = (deps: Pick<RepairDraftDeps, "now">) => expiryOf(deps.now());
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const errorCode = (error: unknown): string => (typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "none");
const logOf = (deps: RepairDraftDeps, entry: Record<string, unknown>): void => log(deps.flow, { component: "setup-repair", ...entry });
const isoOf = (deps: Pick<RepairDraftDeps, "now">): string => iso({ now: () => new Date(deps.now()) });

/** A version-5 shaped id made from text, so a repeated start or confirm is the same request. */
const uuidOf = (text: string): string => {
  const hex = createHash("sha256").update(`rovara-setup-repair\0${text}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

async function readRepair(deps: Pick<RepairDraftDeps, "store" | "companyId">, project: string, key: string): Promise<RepairRow | undefined> {
  const stored = await deps.store.get(repairRowKey(deps.companyId, project, key));
  return isRow(stored, deps.companyId, project, "SETUP_REPAIR") ? (stored as unknown as RepairRow) : undefined;
}
async function readRecheck(deps: Pick<RepairDraftDeps, "store" | "companyId">, project: string, key: string): Promise<RecheckRow | undefined> {
  const stored = await deps.store.get(recheckRowKey(deps.companyId, project, key));
  return isRow(stored, deps.companyId, project, "SETUP_RECHECK") ? (stored as unknown as RecheckRow) : undefined;
}
async function readRevisionClaim(deps: Pick<RepairDraftDeps, "store" | "companyId">, project: string, revision: number): Promise<RepairRevisionRow | undefined> {
  const stored = await deps.store.get(repairRevisionKey(deps.companyId, project, revision));
  return isRow(stored, deps.companyId, project, "SETUP_REPAIR_REVISION") && stored?.["revision"] === revision && typeof stored["key"] === "string" ? (stored as unknown as RepairRevisionRow) : undefined;
}
async function readPointer(deps: Pick<RepairDraftDeps, "store" | "companyId">, project: string): Promise<RepairCurrentRow | undefined> {
  const stored = await deps.store.get(repairCurrentKey(deps.companyId, project));
  return isRow(stored, deps.companyId, project, "SETUP_REPAIR_CURRENT") && typeof stored?.["key"] === "string" ? (stored as unknown as RepairCurrentRow) : undefined;
}

/** Whether a person turned upkeep on for the project. Anything but a clean `true` is off. */
async function upkeepOn(deps: RepairDraftDeps, project: string): Promise<boolean> {
  try { return (await deps.upkeep?.enabled(project)) === true; } catch { return false; }
}
/** The free cents of the upkeep cap, or undefined (unreadable, not a whole non-negative number): no room. */
async function roomOf(deps: RepairDraftDeps, project: string): Promise<number | undefined> {
  try {
    const room = await deps.upkeep?.roomCents(project);
    return typeof room === "number" && Number.isSafeInteger(room) && room >= 0 ? room : undefined;
  } catch { return undefined; }
}

/**
 * Starts the repair draft for one failure (a re-check that settled `broken`), or says why not. NEVER spends unless upkeep is on, a cap is enforced and has room (see the file header). A repeat for the same failure
 * answers the first draft. Never throws for a refusal: a start the door refused leaves nothing behind (the claim is given back) and is `start_refused`.
 */
export async function startRepairDraft(deps: RepairDraftDeps, project: string, recheckKey: string): Promise<RepairStart> {
  const orgId = deps.companyId;
  const recheck = await readRecheck(deps, project, recheckKey);
  if (recheck === undefined || recheck.state !== "broken") return { status: "skipped", why: "not_broken" };
  const existing = await readRepair(deps, project, recheckKey);
  if (existing !== undefined) return { status: "exists", row: existing };
  // The company's gate first (ceiling AND consent): where it is off nothing more is read, written or started. Absent is off.
  if (deps.systemRuns === undefined || !(await systemRunsGateSaysOn(deps.systemRuns))) return { status: "skipped", why: "system_runs_off" };
  if (!(await upkeepOn(deps, project))) return { status: "skipped", why: "upkeep_off" };
  const door = deps.run;
  if (door === undefined || door.enforces.dollars !== true) return { status: "skipped", why: "no_cap" };
  const latest = await deps.latest(project);
  if (latest === undefined || latest.revision !== recheck.setupRevision) return { status: "skipped", why: "not_broken" };
  // ONE automatic draft per (project, broken revision): a failed or ended draft of this revision is not tried again at it (a person's "Fix setup" stays open), whatever re-check found it broken.
  if ((await readRevisionClaim(deps, project, recheck.setupRevision)) !== undefined) return { status: "skipped", why: "already_drafted" };
  if ((await waitingSetupApply(deps.store, orgId, project)) !== undefined) return { status: "skipped", why: "busy" };
  const before = await readState(deps, project, latest.revision);
  if (before.view.status === "running") return { status: "skipped", why: "busy" };
  const previous = await readPointer(deps, project);
  if (previous !== undefined && previous.key !== recheckKey && deps.now() - Date.parse(previous.startedAt) < REPAIR_COOLDOWN_MS) return { status: "skipped", why: "cooling_down" };
  const limits = effectiveSetupAgentLimits(await deps.limitSetting?.(project));
  const room = await roomOf(deps, project);
  if (room === undefined || room < limits.budgetCents) return { status: "skipped", why: "no_room" };

  const at = isoOf(deps);
  const row: RepairRow = {
    entityType: "SETUP_REPAIR", orgId, project, key: recheckKey, setupRevision: recheck.setupRevision, runRequestId: uuidOf(`run:${recheckKey}`), confirmRequestId: uuidOf(`confirm:${recheckKey}`),
    state: "starting", budgetCents: limits.budgetCents, claimedAt: at,
  };
  const pointer: RepairCurrentRow = { entityType: "SETUP_REPAIR_CURRENT", orgId, project, key: recheckKey, startedAt: at };
  const revisionClaim: RepairRevisionRow = { entityType: "SETUP_REPAIR_REVISION", orgId, project, revision: recheck.setupRevision, key: recheckKey, claimedAt: at };
  const claim = await deps.store.transact([
    putRow(repairRowKey(orgId, project, recheckKey), row.entityType, { ...row, ...expiry(deps) }),
    // The broken revision's own claim, in the same transaction: two re-checks of one revision (or two calls at once) cannot both start a draft.
    putRow(repairRevisionKey(orgId, project, recheck.setupRevision), revisionClaim.entityType, { ...revisionClaim, ...expiry(deps) }, when.absent()),
    // The pointer is written only while it is as read: two claims for different failures at once cannot both pass the cooldown, and neither can wipe the other's pointer.
    putRow(repairCurrentKey(orgId, project), pointer.entityType, { ...pointer, ...expiry(deps) }, previous === undefined ? when.absent() : when.and(when.eq("key", previous.key), when.eq("startedAt", previous.startedAt))),
  ]);
  if (!claim.applied) {
    const other = await readRepair(deps, project, recheckKey);
    if (other !== undefined) return { status: "exists", row: other };
    return (await readRevisionClaim(deps, project, recheck.setupRevision)) !== undefined ? { status: "skipped", why: "already_drafted" } : { status: "skipped", why: "busy" };
  }
  const giveBack = async (): Promise<void> => {
    // The claim and the pointer go back as they were: nothing started, nothing was spent, and a later call may try again. The pointer is restored only while it is still this claim's own.
    await deps.store.transact([{ kind: "delete", key: repairRowKey(orgId, project, recheckKey), condition: when.eq("state", "starting") }]).catch(() => undefined);
    await deps.store.transact([{ kind: "delete", key: repairRevisionKey(orgId, project, recheck.setupRevision), condition: when.eq("key", recheckKey) }]).catch(() => undefined);
    const mine = when.eq("key", recheckKey);
    const restore: TransactItem = previous === undefined ? { kind: "delete", key: repairCurrentKey(orgId, project), condition: mine } : putRow(repairCurrentKey(orgId, project), "SETUP_REPAIR_CURRENT", { ...previous, ...expiry(deps) }, mine);
    await deps.store.transact([restore]).catch(() => undefined);
  };
  const request: AutomatedRunRequest = {
    requestId: row.runRequestId, project, agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: setupAgentRequestText(project) },
    // "nightly": the project pays (resolvePayer), and the gateway holds the project's upkeep cap on every call of this run (L4-E: the token's work origin).
    origin: "nightly", limits: { maxRunUsd: limits.budgetCents / 100, maxMinutes: limits.wallClockMin + REPAIR_GRACE_MINUTES },
    setupRepair: { limits, seenTaskId: before.pointer?.taskId },
  };
  // THE AUDIT RECORD FIRST (closes #927 REVIEW-1 L1): Rovara, as the project's system owner, says it is about to start a repair draft, with a fixed reason and the run's own request id. A record that cannot be written
  // starts nothing and gives the claim back. If the start then does not happen, `system_run.not_started` says so (best effort; the refusal stands either way).
  try {
    await deps.flow.audit.record(requestedAudit(deps, row));
  } catch (error) {
    logOf(deps, { event: "setup_repair.audit_unavailable", error: errorName(error) });
    await giveBack();
    return { status: "skipped", why: "start_refused" };
  }
  let taskId: string;
  try {
    taskId = (await startUnattendedRun(door, request)).taskId;
  } catch (error) {
    // A fault is not known to have failed: if the starter holds a run for this request, it is the draft's run. A read that itself fails says nothing (L4-SR2 REVIEW-1 L1): the claim, the revision claim and the pointer STAY,
    // so no second paid run can start for this revision; the stale-claim recovery adopts the run when the starter can be read again.
    let readFailed = false;
    const made = await door.starter.read(row.runRequestId).catch(() => { readFailed = true; return undefined; });
    if (readFailed) {
      logOf(deps, { event: "setup_repair.start_unknown", code: errorCode(error), error: errorName(error) });
      return { status: "skipped", why: "start_refused" };
    }
    if (made === undefined) {
      logOf(deps, { event: "setup_repair.start_refused", code: errorCode(error), error: errorName(error) });
      await giveBack();
      await deps.flow.audit.record(notStartedAudit(deps, row, errorCode(error))).catch(() => undefined);
      return { status: "skipped", why: "start_refused" };
    }
    taskId = made.taskId;
  }
  const started = { ...row, state: "drafting" as const, taskId, startedAt: isoOf(deps) };
  await deps.store.transact([
    { kind: "update", key: repairRowKey(orgId, project, recheckKey), ops: [change.set("state", "drafting"), change.set("taskId", taskId), change.set("startedAt", started.startedAt)], condition: when.eq("state", "starting") },
  ]);
  return { status: "started", row: started };
}

/** The audit event written BEFORE a repair draft's run starts (the same action as every system start: "who did it" is one read; Rovara's system owner is the actor, the reason a fixed code). */
const requestedAudit = (deps: RepairDraftDeps, row: Pick<RepairRow, "project" | "key" | "budgetCents" | "runRequestId">) => ({
  eventId: eventIdOf("system-run-started", deps.companyId, row.project, row.runRequestId), companyId: deps.companyId, at: isoOf(deps), actor: { type: "system" as const, id: systemOwnerIdOf(deps.companyId, row.project) },
  action: SYSTEM_RUN_AUDIT.requested, subject: { type: "project" as const, id: row.project }, details: { kind: "repair_draft", reason: "check_failed", requestId: row.runRequestId, budgetCents: row.budgetCents },
});
const notStartedAudit = (deps: RepairDraftDeps, row: Pick<RepairRow, "project" | "runRequestId">, code: string) => ({
  eventId: eventIdOf("system-run-not-started", deps.companyId, row.project, row.runRequestId), companyId: deps.companyId, at: isoOf(deps), actor: { type: "system" as const, id: systemOwnerIdOf(deps.companyId, row.project) },
  action: SYSTEM_RUN_AUDIT.notStarted, subject: { type: "project" as const, id: row.project }, details: { kind: "repair_draft", requestId: row.runRequestId, code: code.slice(0, 40) },
});

/** The hook the host puts on `TaskFlowDeps.afterSetupBroken`: one draft per failure, only where the rules above allow it. */
export function repairDraftHook(deps: RepairDraftDeps): (project: string, recheckKey: string) => Promise<void> {
  return async (project, recheckKey) => { await startRepairDraft(deps, project, recheckKey); };
}

// ---- progress

const TERMINAL: ReadonlySet<RepairState> = new Set<RepairState>(["approved", "failed", "ended"]);

/**
 * Moves the project's repair draft on from the stored facts and answers it (undefined: none). Safe from anywhere, any number of times: every write holds only while the row is as read. A project with no draft in
 * flight whose latest re-check is broken starts one (only where `startRepairDraft`'s rules allow it: that is how turning upkeep on later takes effect).
 */
export async function advanceRepairDraft(deps: RepairDraftDeps, project: string): Promise<RepairRow | undefined> {
  const pointer = await readPointer(deps, project);
  const current = pointer === undefined ? undefined : await readRepair(deps, project, pointer.key);
  if (current !== undefined && !TERMINAL.has(current.state)) return progress(deps, project, current);
  const recheck = await advanceCurrentRecheck(deps.flow, project);
  if (recheck === undefined || recheck.state !== "broken") return current;
  const started = await startRepairDraft(deps, project, recheck.key);
  return started.status === "skipped" ? current : started.row;
}

/**
 * The progress pass's step for one project: moves a draft that is IN FLIGHT on (or stops it where a lock went off) and answers it; a project with none, or whose draft is over, answers undefined and nothing else
 * is read or started (unlike `advanceRepairDraft`, it never advances a re-check and never starts a draft: a project that is not being repaired costs one read).
 */
export async function advanceInFlightRepairDraft(deps: RepairDraftDeps, project: string): Promise<RepairRow | undefined> {
  const pointer = await readPointer(deps, project);
  const current = pointer === undefined ? undefined : await readRepair(deps, project, pointer.key);
  return current === undefined || TERMINAL.has(current.state) ? undefined : progress(deps, project, current);
}

async function move(deps: RepairDraftDeps, row: RepairRow, from: RepairState, to: { state: RepairState; reason?: RepairReason; stop?: string }, audit?: string): Promise<RepairRow> {
  const orgId = deps.companyId;
  const at = isoOf(deps);
  const ops = [change.set("state", to.state), ...(TERMINAL.has(to.state) ? [change.set("decidedAt", at)] : []), ...(to.reason === undefined ? [] : [change.set("reason", to.reason)]), ...(to.stop === undefined ? [] : [change.set("stop", to.stop)])];
  const extra = audit === undefined ? [] : deps.flow.audit.stage({
    eventId: eventIdOf(`setup-repair-${audit}`, orgId, row.project, row.key), companyId: orgId, at, actor: { type: "system", id: "rovara" }, action: `setup_repair.${audit}`, subject: { type: "project", id: row.project },
    details: to.reason === undefined ? {} : { reason: to.reason },
  });
  const result = await deps.store.transact([{ kind: "update", key: repairRowKey(orgId, row.project, row.key), ops, condition: when.eq("state", from) }, ...extra]);
  // A lost race is the other caller's move: read what it wrote.
  if (!result.applied) return (await readRepair(deps, row.project, row.key)) ?? row;
  return { ...row, ...to, ...(TERMINAL.has(to.state) ? { decidedAt: at } : {}) };
}

/**
 * Whether the locks that let a draft go on are still open, read NOW (closes #927 REVIEW-1 L3): the company's effective system-runs gate (the operator's ceiling AND the company's consent) and the project's upkeep
 * switch. Every doubt (a throw, an absent gate, an answer that is not exactly `true`) is "no". Read before every move of a draft that is not finished and not waiting for a person.
 */
async function locksOpen(deps: RepairDraftDeps, project: string): Promise<boolean> {
  if (deps.systemRuns === undefined || !(await systemRunsGateSaysOn(deps.systemRuns))) return false;
  return await upkeepOn(deps, project);
}

/**
 * A draft whose lock went off stops: its run is cancelled (a running setup run loses its standing at the access rule's next step anyway; this ends it now), its own candidate is removed (by its request id, never a
 * person's) and the draft ends as `withdrawn`, in fixed words. Nothing is approved. The manual "Fix setup" stays open.
 */
async function stopWithdrawn(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  const found = row.taskId !== undefined ? { taskId: row.taskId } : await deps.run?.starter.read(row.runRequestId).catch(() => undefined);
  if (found !== undefined && (row.state === "starting" || row.state === "drafting")) await deps.run?.tasks?.cancel(found.taskId).catch((error: unknown) => logOf(deps, { event: "setup_repair.cancel_failed", error: errorName(error) }));
  if (row.state === "checking") await discardSetupApply(deps, project, systemOwnerIdOf(deps.companyId, project), row.confirmRequestId);
  if (row.state === "starting") await deps.flow.audit.record(notStartedAudit(deps, row, "WITHDRAWN")).catch(() => undefined);
  return move(deps, row, row.state, { state: "ended", reason: "withdrawn" }, "stopped");
}

async function progress(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  try {
    const age = deps.now() - Date.parse(row.claimedAt);
    // A draft that is going on (not finished, not waiting for a person) goes on only while its locks are open NOW.
    if ((row.state === "starting" || row.state === "drafting" || row.state === "checking") && !(await locksOpen(deps, project))) return await stopWithdrawn(deps, project, row);
    switch (row.state) {
      case "starting": return await recoverStart(deps, row, age);
      case "drafting": return age > ABANDON_MS ? move(deps, row, "drafting", { state: "failed", reason: "run_failed" }, "failed") : await drafting(deps, project, row);
      case "checking": return age > ABANDON_MS ? await abandonChecking(deps, project, row) : await checking(deps, project, row);
      case "ready": return await ready(deps, project, row);
      default: return row;
    }
  } catch (error) {
    // A fault leaves the draft as it was; the next call tries again. Never a text of the fault.
    logOf(deps, { event: "setup_repair.progress_failed", state: row.state, code: errorCode(error), error: errorName(error) });
    return row;
  }
}

/** A claim whose start never finished (a fault between the claim and the start): the run is adopted when the door holds one, else the claim is given back after a while. */
async function recoverStart(deps: RepairDraftDeps, row: RepairRow, age: number): Promise<RepairRow> {
  let readFailed = false;
  const made = await deps.run?.starter.read(row.runRequestId).catch(() => { readFailed = true; return undefined; });
  // The starter cannot be read: nothing is known, so nothing is given back (a run may exist). A claim that stays unreadable for two days ends the draft `failed` (the card then offers the manual Fix setup again).
  if (readFailed) return age > ABANDON_MS ? move(deps, row, "starting", { state: "failed", reason: "run_failed" }, "failed") : row;
  if (made !== undefined) {
    const result = await deps.store.transact([{ kind: "update", key: repairRowKey(deps.companyId, row.project, row.key), ops: [change.set("state", "drafting"), change.set("taskId", made.taskId), change.set("startedAt", isoOf(deps))], condition: when.eq("state", "starting") }]);
    return result.applied ? { ...row, state: "drafting", taskId: made.taskId } : ((await readRepair(deps, row.project, row.key)) ?? row);
  }
  if (age <= REPAIR_START_STALE_MS) return row;
  await deps.flow.audit.record(notStartedAudit(deps, row, "NEVER_STARTED")).catch(() => undefined);
  await deps.store.transact([{ kind: "delete", key: repairRowKey(deps.companyId, row.project, row.key), condition: when.eq("state", "starting") }]).catch(() => undefined);
  // The revision claim STAYS (REVIEW-1 L1): a start that was in flight for ten minutes may still turn into a run, and a second paid run for this revision must never follow. The revision is tried by a person ("Fix setup").
  await deps.store.transact([{ kind: "delete", key: repairCurrentKey(deps.companyId, row.project), condition: when.eq("key", row.key) }]).catch(() => undefined);
  return row;
}

const SAFE_STOPS: ReadonlySet<string> = new Set<string>(SETUP_RUN_END_WORDS);

async function drafting(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  const latest = await deps.latest(project);
  if (latest === undefined || latest.revision !== row.setupRevision) return move(deps, row, "drafting", { state: "ended", reason: "superseded" });
  const { view, pointer } = await readState(deps, project, latest.revision);
  // The run must be THIS draft's own: a pointer that names another task is another run (a person's), never confirmed here.
  if (pointer === undefined || pointer.taskId !== row.taskId || row.taskId === undefined) return move(deps, row, "drafting", { state: "ended", reason: "superseded" });
  if (view.status === "running") return row;
  // The gateway paused nightly upkeep under this run (HTTP 422 `upkeep_paused`, read by the worker from the gateway's fixed sentence): the draft stops here, no retry, and the project's admins get the ONE notice per
  // month and reason (N1). Only this unattended draft takes the word; a person's run never carries the origin that is counted against the upkeep cap.
  const paused = UpkeepPauseReasonSchema.safeParse(view.summary?.pause);
  if (paused.success) {
    await deps.onUpkeepPaused?.(project, paused.data).catch((error: unknown) => logOf(deps, { event: "setup_repair.pause_notice_failed", error: errorName(error) }));
    return move(deps, row, "drafting", { state: "failed", reason: "upkeep_paused" }, "failed");
  }
  // Only a run that finished by itself with a whole proposal is confirmed. A limit stop (a partial proposal) or a failed run is a failed draft, said in fixed words.
  if (view.status !== "ready" || view.proposal === undefined || view.stop !== "proposed" || view.summary?.partial === true) {
    return move(deps, row, "drafting", { state: "failed", reason: "run_failed", ...(view.stop !== undefined && SAFE_STOPS.has(view.stop) ? { stop: view.stop } : {}) }, "failed");
  }
  try {
    await confirmSetupAgent(deps, project, { requestId: row.confirmRequestId, expectedRevision: latest.revision }, systemOwnerIdOf(deps.companyId, project));
  } catch (error) {
    const code = errorCode(error);
    // Another candidate waits, or the project moved: this draft no longer matters. The citations not yet re-read: try again on the next call.
    if (code === "WORKSPACE_BUSY" || code === "PROJECT_REVISION_MISMATCH") return move(deps, row, "drafting", { state: "ended", reason: "superseded" });
    if (code === "CHANGE_STALE" || code === "RUNTIME_UNAVAILABLE") return row;
    logOf(deps, { event: "setup_repair.confirm_refused", code });
    return move(deps, row, "drafting", { state: "failed", reason: "no_usable_fix" }, "failed");
  }
  return move(deps, row, "drafting", { state: "checking" });
}

async function checking(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  const apply = await readSetupApply(deps, project);
  // The candidate is gone (a person discarded or rejected it), or it is not this draft's: the draft is over.
  if (apply === undefined || apply.requestId !== row.confirmRequestId) return move(deps, row, "checking", { state: "ended", reason: "decided" });
  if (apply.state === "approved") return move(deps, row, "checking", { state: "approved" });
  if (apply.state !== "checking") return move(deps, row, "checking", { state: "ended", reason: "decided" });
  if (apply.checkState.status === "ready") return move(deps, row, "checking", { state: "ready" }, "candidate_ready");
  if (apply.checkState.status === "failed") {
    // One draft per failure: its candidate failed its own check, so it is removed (nothing could approve it) and Rovara says so. The manual "Fix setup" stays open.
    await discardSetupApply(deps, project, systemOwnerIdOf(deps.companyId, project), row.confirmRequestId);
    return move(deps, row, "checking", { state: "failed", reason: "check_failed" }, "failed");
  }
  if (apply.checkState.status === "outdated") return move(deps, row, "checking", { state: "ended", reason: "superseded" });
  return row;
}

/** A check that never finished: the draft is over, and ITS OWN candidate (by its request id, never a person's) is removed so it cannot block the project or be approved later under words that say it failed. */
async function abandonChecking(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  await discardSetupApply(deps, project, systemOwnerIdOf(deps.companyId, project), row.confirmRequestId);
  return move(deps, row, "checking", { state: "failed", reason: "check_failed" }, "failed");
}

async function ready(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  const apply = await readSetupApply(deps, project);
  if (apply === undefined || apply.requestId !== row.confirmRequestId) return move(deps, row, "ready", { state: "ended", reason: "decided" });
  if (apply.state === "approved") return move(deps, row, "ready", { state: "approved" });
  if (apply.state !== "checking") return move(deps, row, "ready", { state: "ended", reason: "decided" });
  return row;
}

// ---- the admin card

/**
 * The admin card of a broken setup, with the draft's part in it (design 3c): "Approve new setup" when a checked fix waits, a quiet line while a draft is on its way, else the manual way out ("Fix setup (uses your AI, up to
 * $4)" and "Edit commands myself"; also after a draft that failed, with the fixed reason). Undefined while the setup is not broken, or once a newer setup was approved. Never throws for a damaged row (it reads as no fix).
 * The card names no person and offers no approval to anyone: who may press "Approve new setup" is the hosted approval's risk rule, read by the page's own `canApprove`.
 */
export async function readRepairView(deps: Pick<RepairDraftDeps, "store" | "companyId" | "now" | "limitSetting" | "flow">, project: string): Promise<SetupRepairView | undefined> {
  const base = await readSetupRepairCard(deps.flow, project);
  if (base === undefined) return undefined;
  const budgetCents = effectiveSetupAgentLimits(await deps.limitSetting?.(project)).budgetCents;
  const manual: SetupRepairView["actions"] = [{ id: "fix_setup", label: fixSetupLabel(budgetCents) }, { id: "edit_commands", label: "Edit commands myself" }];
  const classes: SetupDriftClass[] = base.classes;
  const noFix = (failure?: RepairReason): SetupRepairView => ({
    title: "Setup needs repair", state: "no_fix", classes, at: base.at, actions: manual,
    body: failure === "run_failed" || failure === "no_usable_fix" || failure === "check_failed" || failure === "upkeep_paused" ? `${base.body} ${REPAIR_WORDS.failed[failure]}` : failure === "withdrawn" ? `${base.body} ${REPAIR_WORDS.withdrawn}` : base.body, ...(failure === undefined ? {} : { failure }),
  });
  try {
    const notice = await deps.store.get(repairNoticeKey(deps.companyId, project));
    const key = typeof notice?.["key"] === "string" ? notice["key"] : undefined;
    const failedStep = typeof notice?.["failedStep"] === "string" ? notice["failedStep"] : "setup";
    const repair = key === undefined ? undefined : await readRepair(deps, project, key);
    if (repair === undefined) return noFix();
    if (repair.state === "failed") return noFix(repair.reason);
    if (repair.state === "ended" && repair.reason === "withdrawn") return noFix("withdrawn");
    if (repair.state === "starting" || repair.state === "drafting" || repair.state === "checking") {
      return { title: "Setup needs repair", state: "drafting", classes, at: base.at, body: `${base.body} ${REPAIR_WORDS.drafting}`, actions: [{ id: "edit_commands", label: "Edit commands myself" }] };
    }
    if (repair.state === "ready") {
      const apply = await readSetupApply(deps, project);
      if (apply === undefined || apply.state !== "checking" || apply.requestId !== repair.confirmRequestId || apply.checkState.status !== "ready") return noFix();
      const { changes } = await setupCandidateRisk(deps.store, deps.companyId, apply);
      const count = changes.length;
      return {
        title: "Setup needs repair", state: "fix_ready", classes, at: base.at, candidateRevision: apply.candidateRevision, changes: count,
        body: `The project's setup stopped working after recent code changes (${failedStep}). Rovara drafted a fix and checked it on a fresh machine: it passes. ${String(count)} change${count === 1 ? "" : "s"}.`,
        actions: [{ id: "approve_setup", label: "Approve new setup" }, { id: "see_changes", label: "See changes" }],
      };
    }
    return noFix();
  } catch {
    return noFix();
  }
}
