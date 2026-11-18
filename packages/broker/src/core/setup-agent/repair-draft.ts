// L4-RD (DEC 254z c, 254zza; setup-upkeep-plan.md decision 1, "if it needs a person"): the automatic repair draft. See repair-rows.ts for the rows and the words.
//
// The rule this file keeps: Rovara DRAFTS, a person DECIDES. Nothing here approves a setup, makes a candidate the project's latest revision, imports the approval gate, or asks a model anything itself. What it does:
//   1. When the free re-check (recheck.ts) settles as "setup broken", and ONLY THEN, `startRepairDraft` decides whether to start ONE setup-agent run for that failure. It starts nothing unless ALL of these hold, each read
//      now and each failing CLOSED (a throw, a missing answer or a malformed one is "no"):
//        - the company's EFFECTIVE system-runs gate is on (L4-P2, owner DEC 254zzt: the operator's `CoreSystemRuns` ceiling AND the company's consent, `effectiveSystemRunsGate`). An absent gate is OFF: this file never
//          starts anything on its own authority. A host that wires this hook must pass that gate; nothing hosted wires it yet (see the OFF NOTE below);
//        - a person turned upkeep ON for the project (`UpkeepGate.enabled`: a page-only act, audited; this file only reads it);
//        - a dollar cap is enforced on this install (the unattended door's `enforces.dollars`; the door itself refuses a model run without one);
//        - the project's upkeep cap has room for the whole run (`UpkeepGate.roomCents` >= the run's budget). The gateway holds the real cap on every model call (the token carries the work origin "nightly", so the
//          project's `upkeep_month` row applies, L4-E); this read only avoids starting a run the gateway would refuse;
//        - the project is still at the revision that broke, no candidate waits for a decision, no setup run is going, and no automatic draft started in the last `REPAIR_COOLDOWN_MS`.
//      One repair per failure: the claim row is keyed by the re-check, written only if absent, so a double call starts one run, and a failed draft is final (no loop).
//   2. The run is started through THE one unattended door (`startUnattendedRun`: the switch, the cap, `Admission`, the host's starter), with the run's own limits (the setup agent's existing limits, about $4) and the
//      origin "nightly" (the project pays; the gateway's upkeep cap applies). The host's starter starts the project's setup run as the project's system owner; one that does not know a `setupRepair` request refuses it.
//   3. `advanceRepairDraft` moves it on from the stored facts, safe to call from anywhere and any number of times: the run ended with a proposal Rovara itself finished (`proposed`, not partial) -> the candidate is stored
//      by `confirmSetupAgent` (the SAME path a person's "Use this setup" takes: every citation re-read from the code host, the candidate stored but not the project's latest, its check started on a NEW workspace) ->
//      the candidate's check passed -> `ready`: the project's maintainers see "Approve new setup", and the decision is the hosted approval gate's (risk-based approvers, a fresh sign-in, the digest) as for any setup.
//      A run that failed, a proposal nothing could be used from, or a candidate whose check failed ends the draft as `failed`, in fixed words, and the failed candidate is removed. The manual "Fix setup" stays open.
//
// OFF NOTE (lead 4, owner DEC 254zzl/254zzt/254zzy): the AUTOMATIC path is OFF on every install. Nothing wires `TaskFlowDeps.afterSetupBroken` or calls `advanceRepairDraft`, the system starter refuses `repair_draft`
// (`createSystemStarter` starts the two free kinds only) and the access rule does not accept a system owner for a `setup_agent` task. Turning it on needs ALL of: the starter taking this kind through `startUnattendedRun`
// like the wiki refresh; a hosted starter that knows `setupRepair`; the access rule's step marks for the setup task; the audit record written BEFORE the run starts (here it is staged after); the `systemRuns` gate above.
// Until then a person starts the fix ("Fix setup (uses your AI, up to $4)") and the same approval rule decides it.
import { createHash } from "node:crypto";
import {
  ROVARA_CODE_AGENT_ID, SETUP_RUN_END_WORDS, change, effectiveSetupAgentLimits, systemOwnerIdOf, when,
  type SetupDriftClass, type TransactItem,
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
  REPAIR_COOLDOWN_MS, REPAIR_GRACE_MINUTES, REPAIR_START_STALE_MS, REPAIR_WORDS, fixSetupLabel, repairCurrentKey, repairRowKey,
  type RepairCurrentRow, type RepairReason, type RepairRow, type RepairState, type SetupRepairView,
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
}

/** Why a draft was not started (nothing was written, nothing was spent). */
export type RepairSkip = "not_broken" | "system_runs_off" | "upkeep_off" | "no_cap" | "no_room" | "busy" | "cooling_down" | "start_refused";
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
  const claim = await deps.store.transact([
    putRow(repairRowKey(orgId, project, recheckKey), row.entityType, { ...row, ...expiry(deps) }),
    // The pointer is written only while it is as read: two claims for different failures at once cannot both pass the cooldown, and neither can wipe the other's pointer.
    putRow(repairCurrentKey(orgId, project), pointer.entityType, { ...pointer, ...expiry(deps) }, previous === undefined ? when.absent() : when.and(when.eq("key", previous.key), when.eq("startedAt", previous.startedAt))),
  ]);
  if (!claim.applied) {
    const other = await readRepair(deps, project, recheckKey);
    return other === undefined ? { status: "skipped", why: "busy" } : { status: "exists", row: other };
  }
  const giveBack = async (): Promise<void> => {
    // The claim and the pointer go back as they were: nothing started, nothing was spent, and a later call may try again. The pointer is restored only while it is still this claim's own.
    await deps.store.transact([{ kind: "delete", key: repairRowKey(orgId, project, recheckKey), condition: when.eq("state", "starting") }]).catch(() => undefined);
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
  let taskId: string;
  try {
    taskId = (await startUnattendedRun(door, request)).taskId;
  } catch (error) {
    // A fault is not known to have failed: if the starter holds a run for this request, it is the draft's run.
    const made = await door.starter.read(row.runRequestId).catch(() => undefined);
    if (made === undefined) {
      logOf(deps, { event: "setup_repair.start_refused", code: errorCode(error), error: errorName(error) });
      await giveBack();
      return { status: "skipped", why: "start_refused" };
    }
    taskId = made.taskId;
  }
  const started = { ...row, state: "drafting" as const, taskId, startedAt: isoOf(deps) };
  await deps.store.transact([
    { kind: "update", key: repairRowKey(orgId, project, recheckKey), ops: [change.set("state", "drafting"), change.set("taskId", taskId), change.set("startedAt", started.startedAt)], condition: when.eq("state", "starting") },
    ...startedAudit(deps, row),
  ]);
  return { status: "started", row: started };
}

/** The audit event of a draft whose run really started (Rovara is the actor; the person who turned upkeep on is the project's own audit). Staged with the move to `drafting`, so a claim given back leaves no event. */
const startedAudit = (deps: RepairDraftDeps, row: Pick<RepairRow, "project" | "key" | "budgetCents">): readonly TransactItem[] =>
  deps.flow.audit.stage({ eventId: eventIdOf("setup-repair-started", deps.companyId, row.project, row.key), companyId: deps.companyId, at: isoOf(deps), actor: { type: "system", id: "rovara" }, action: "setup_repair.started", subject: { type: "project", id: row.project }, details: { budgetCents: row.budgetCents } });

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

async function progress(deps: RepairDraftDeps, project: string, row: RepairRow): Promise<RepairRow> {
  try {
    const age = deps.now() - Date.parse(row.claimedAt);
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
  const made = await deps.run?.starter.read(row.runRequestId).catch(() => undefined);
  if (made !== undefined) {
    const result = await deps.store.transact([{ kind: "update", key: repairRowKey(deps.companyId, row.project, row.key), ops: [change.set("state", "drafting"), change.set("taskId", made.taskId), change.set("startedAt", isoOf(deps))], condition: when.eq("state", "starting") }, ...startedAudit(deps, row)]);
    return result.applied ? { ...row, state: "drafting", taskId: made.taskId } : ((await readRepair(deps, row.project, row.key)) ?? row);
  }
  if (age <= REPAIR_START_STALE_MS) return row;
  await deps.store.transact([{ kind: "delete", key: repairRowKey(deps.companyId, row.project, row.key), condition: when.eq("state", "starting") }]).catch(() => undefined);
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
    body: failure === "run_failed" || failure === "no_usable_fix" || failure === "check_failed" ? `${base.body} ${REPAIR_WORDS.failed[failure]}` : base.body, ...(failure === undefined ? {} : { failure }),
  });
  try {
    const notice = await deps.store.get(repairNoticeKey(deps.companyId, project));
    const key = typeof notice?.["key"] === "string" ? notice["key"] : undefined;
    const failedStep = typeof notice?.["failedStep"] === "string" ? notice["failedStep"] : "setup";
    const repair = key === undefined ? undefined : await readRepair(deps, project, key);
    if (repair === undefined) return noFix();
    if (repair.state === "failed") return noFix(repair.reason);
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
