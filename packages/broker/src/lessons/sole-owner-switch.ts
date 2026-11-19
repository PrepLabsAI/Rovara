// The company switch for the sole-owner exception on loosening, and the shared types the learning settings use (the approval level, the setting's scope, the membership fence, who may change a
// setting). Routes call ONLY `setSoleOwnerSwitch` and `approveSoleOwnerSwitch`; the store's `write` is internal to them.
// This module held the tier-0 approval setting's own change flow (request, approve, cancel) until lessons connect: the Standard / Regulated preset (`preset-setting.ts`) replaced it as the
// person-facing control, and the stored `tier0Approval` / `companyApproval` are still READ (`document-settings.ts`, `resolveLearning`) because they still gate `trialAllowed`.
//  - OFF (stricter: the exception stops working) applies at once, by an eligible company admin, audited (an audit outage does not block it).
//  - ON (a loosening) opens a proposal that a DIFFERENT eligible admin approves. The sole-owner exception does NOT apply to turning itself back on: a company of one that switched the
//    exception off keeps it off unless a second admin joins (safer default; the owner may change this).
//  - Every write is conditional on the value it was made against and fenced on the membership the decision rested on. A refusal by the fence alone (the value is unchanged) is retryable
//    ("membership_changed_retry"): the proposal goes back to pending with its expiry and the next approval re-runs every check. Fail closed: an unknown value, incomplete or unreadable eligibility, a stale or
//    expired proposal, or an audit event that cannot be written stops the change (a loosening is taken back if its audit cannot be written).
import { randomUUID } from "node:crypto";
import { requireAudit, emitAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { trySecondPersonTimed } from "./approve.js";
import { idIn, sameId } from "./types.js";

export type Tier0Level = "auto" | "one" | "two";

export type Tier0Scope = { kind: "project"; workspaceId: string; project: string } | { kind: "company"; workspaceId: string };
export const SOLE_OWNER_CHANGE_TTL_MS = 7 * 86_400_000;

/** The stored value of one scope: the project's `tier0Approval`, or the company floor. Undefined when none was ever set. */
export interface Tier0SettingsStore {
  read(scope: Tier0Scope): Promise<Tier0Level | undefined>;
  /**
   * Writes only if the stored value is still `from` (an absent value counts as the default). False: it moved, and nothing was written. No route writes the setting any more (its change flow is gone); this stays for the
   * store's own contract tests and for a future writer, which must carry a `fence` the same way the preset does.
   */
  write(scope: Tier0Scope, value: Tier0Level, meta: { by: string; at: number }, from: Tier0Level, fence?: Tier0Fence): Promise<boolean>;
}
/** What a decision rested on: the membership generation, and the opaque commit conditions (`readSecondPersonApprovalEvidence`'s) that pin both people's live authority. */
export interface Tier0Fence { membershipVersion: number; conditions?: readonly unknown[] }
export interface Tier0Group { complete: boolean; membershipVersion: number; ownerIds: string[]; eligibleIds: string[]; lastEligibleLossAtMs: number | null; /** Commit conditions for the writes that rest on this answer. */ fence?: readonly unknown[] }
/** Who may change the setting: the project's maintainers and admins, or the company's admins. `who` names the proposer and the approver the answer is for (the same person when one acts alone). */
export interface Tier0Authority {
  eligibility(scope: Tier0Scope, who: { proposerId: string; approverId: string }): Promise<Tier0Group>;
}
const fenceOf = (group: Tier0Group): Tier0Fence => ({ membershipVersion: group.membershipVersion, ...(group.fence === undefined ? {} : { conditions: group.fence }) });

export type Tier0Failure =
  | "invalid_value" | "not_eligible" | "eligibility_unavailable" | "below_company_floor" | "auto_apply_not_enabled" | "already_open" | "audit_unavailable"
  | "not_found" | "not_pending" | "expired" | "stale" | "second_person_required" | "sole_owner_cool_off" | "conflict"
  /** The membership fence refused the write (a person added, removed or demoted since the check) and the value is unchanged: the proposal is still open, so check again and approve again. */
  | "membership_changed_retry";

const NO_PROJECT = "_workspace";

/** After a refused write: whether the value is still the one the change was made against, so only the membership fence failed. A read that fails counts as "moved" (fail closed: the change is cancelled). */
async function valueUnmoved<T>(read: () => Promise<T>, from: T): Promise<boolean> {
  try { return (await read()) === from; } catch { return false; }
}
async function groupOf(deps: Pick<SoleOwnerSwitchDeps, "authority">, scope: Tier0Scope, who: { proposerId: string; approverId: string }) {
  const group = await deps.authority.eligibility(scope, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
}

export interface SoleOwnerSwitchChange {
  id: string; workspaceId: string; from: boolean; to: boolean; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled";
}
export interface SoleOwnerSwitchStore {
  /** The stored switch; true (ON) when never set. Throws when the stored value is not valid. */
  read(workspaceId: string): Promise<boolean>;
  /** INTERNAL to `setSoleOwnerSwitch` / `approveSoleOwnerSwitch`. Writes only if the switch is still `from`; false: it moved, or the fence failed, and nothing was written. */
  write(workspaceId: string, enabled: boolean, meta: { by: string; at: number }, from: boolean, fence?: Tier0Fence): Promise<boolean>;
  create(change: SoleOwnerSwitchChange): Promise<boolean>;
  get(workspaceId: string, id: string): Promise<SoleOwnerSwitchChange | undefined>;
  open(workspaceId: string, now: number): Promise<SoleOwnerSwitchChange | undefined>;
  transition(workspaceId: string, id: string, from: SoleOwnerSwitchChange["state"], to: SoleOwnerSwitchChange["state"]): Promise<boolean>;
}
export interface SoleOwnerSwitchDeps { store: SoleOwnerSwitchStore; audit: LessonAuditSink; authority: Tier0Authority; now(): number; newId?: () => string }
export type SoleOwnerSwitchRequest = { ok: true; status: "applied"; enabled: boolean } | { ok: true; status: "needs_approval"; changeId: string } | { ok: false; code: Tier0Failure };

const companyScope = (workspaceId: string): Tier0Scope => ({ kind: "company", workspaceId });

/** Asks to set the switch. Turning it OFF applies now; turning it ON (or leaving it as it is) is a no-op or a proposal. */
export async function setSoleOwnerSwitch(deps: SoleOwnerSwitchDeps, input: { workspaceId: string; enabled: boolean; requestedBy: string }): Promise<SoleOwnerSwitchRequest> {
  const { workspaceId, enabled } = input;
  if (typeof enabled !== "boolean") return { ok: false, code: "invalid_value" };
  const scope = companyScope(workspaceId);
  const group = await groupOf(deps, scope, { proposerId: input.requestedBy, approverId: input.requestedBy });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.requestedBy)) return { ok: false, code: "not_eligible" };
  let current: boolean;
  try { current = await deps.store.read(workspaceId); } catch { return { ok: false, code: "conflict" }; }
  const at = deps.now();
  const facts = (extra: Record<string, string | boolean> = {}) => ({ from: current, to: enabled, membershipVersion: group.membershipVersion, ...extra });
  if (enabled === current) return { ok: true, status: "applied", enabled };
  if (!enabled) {
    // Stricter: applied now, against the value it was read at, fenced. An audit outage never blocks the stricter side.
    if (!(await deps.store.write(workspaceId, false, { by: input.requestedBy, at }, current, fenceOf(group)))) return { ok: false, code: "stale" };
    await emitAudit(deps.audit, { action: "lesson.sole_owner_switch_changed", workspaceId, project: NO_PROJECT, actor: input.requestedBy, facts: facts({ mode: "direct" }) });
    return { ok: true, status: "applied", enabled };
  }
  // Turning ON is a loosening: a proposal for a different admin.
  if ((await deps.store.open(workspaceId, at)) !== undefined) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  if (!(await requireAudit(deps.audit, { action: "lesson.sole_owner_switch_proposed", workspaceId, project: NO_PROJECT, actor: input.requestedBy, facts: facts({ changeId: id }) }))) return { ok: false, code: "audit_unavailable" };
  const created = await deps.store.create({ id, workspaceId, from: current, to: true, proposedBy: input.requestedBy, at, expiresAt: at + SOLE_OWNER_CHANGE_TTL_MS, state: "pending" });
  return created ? { ok: true, status: "needs_approval", changeId: id } : { ok: false, code: "conflict" };
}

/** A DIFFERENT eligible admin approves a proposal to turn the switch ON. The proposer can never approve it, and the sole-owner exception does not apply. */
export async function approveSoleOwnerSwitch(deps: SoleOwnerSwitchDeps, input: { workspaceId: string; changeId: string; approverId: string }): Promise<{ ok: true; enabled: boolean } | { ok: false; code: Tier0Failure }> {
  const { workspaceId } = input;
  const change = await deps.store.get(workspaceId, input.changeId);
  if (change === undefined || change.workspaceId !== workspaceId) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  if (sameId(change.proposedBy, input.approverId)) return { ok: false, code: "second_person_required" };
  const scope = companyScope(workspaceId);
  const group = await groupOf(deps, scope, { proposerId: change.proposedBy, approverId: input.approverId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) return { ok: false, code: decision.code === "eligibility_unavailable" ? "eligibility_unavailable" : "second_person_required" };
  if (decision.mode !== "second_person") return { ok: false, code: "second_person_required" };
  let current: boolean;
  try { current = await deps.store.read(workspaceId); } catch { return { ok: false, code: "conflict" }; }
  if (current !== change.from) return { ok: false, code: "stale" };
  if (!(await deps.store.transition(workspaceId, change.id, "pending", "applied"))) return { ok: false, code: "not_pending" };
  if (!(await deps.store.write(workspaceId, change.to, { by: input.approverId, at }, change.from, fenceOf(group)))) {
    // A refusal by the commit fence alone is retryable (see `approveSoleOwnerSwitch`): back to pending with its expiry; a switch that moved, or a change that cannot be reopened, cancels it.
    if (await valueUnmoved(() => deps.store.read(workspaceId), change.from) && await deps.store.transition(workspaceId, change.id, "applied", "pending").catch(() => false)) {
      await emitAudit(deps.audit, { action: "lesson.tier0_setting_refused_retryable", workspaceId, project: NO_PROJECT, actor: input.approverId, facts: { scope: "company_switch", changeId: change.id } });
      return { ok: false, code: "membership_changed_retry" };
    }
    await deps.store.transition(workspaceId, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "stale" };
  }
  const audited = await requireAudit(deps.audit, {
    action: "lesson.sole_owner_switch_changed", workspaceId, project: NO_PROJECT, actor: input.approverId,
    facts: { from: change.from, to: change.to, mode: "second_person", proposedBy: change.proposedBy, changeId: change.id, membershipVersion: group.membershipVersion },
  });
  if (!audited) {
    await deps.store.write(workspaceId, change.from, { by: input.approverId, at }, change.to).catch(() => false);
    await deps.store.transition(workspaceId, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "audit_unavailable" };
  }
  return { ok: true, enabled: change.to };
}
