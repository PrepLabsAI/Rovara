// The learning preset (Standard / Regulated) as a company or project setting.
//   Standard (the default, in both editions): a low-risk lesson from a project member's own correction goes live on trial. Regulated: no trial, every lesson needs a person first.
// Stricter-only, like the mode lock and the tier-0 approval setting (`sole-owner-switch.ts`, whose rules this follows):
//  - Regulated (stricter) applies at once for an eligible maintainer or admin (a company's: an eligible company admin), audited, never blocked by an audit outage.
//  - Standard (a loosening) never applies as a direct write. It opens a proposal that a DIFFERENT eligible person approves; the one exception is the shared sole-owner exception
//    (the "one-admin company" rule): the proposer is the ONLY eligible person and nobody eligible left or was removed in the last 24 hours, and the
//    company has not turned the exception off. The audit records mode `sole_owner_exception`, and a separate `lesson.sole_owner_exception` entry.
//  - A company's Regulated is a floor: a project cannot go below it (refused at request and again at approval).
//  - Every write is conditional on the value it was made against and fenced on the membership the decision rested on; fail closed on anything unreadable.
// The stored setting names no person (the audit event does); a proposal names its proposer, under the prefix the person erase already rewrites.
import { randomUUID } from "node:crypto";
import { trySecondPersonTimed } from "./approve.js";
import { DEFAULT_LEARNING_PRESET, LearningPresetSchema, emitAudit, requireAudit, type LearningPreset } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import type { Tier0Authority, Tier0Failure, Tier0Fence, Tier0Group } from "./sole-owner-switch.js";
import { idIn, sameId } from "./types.js";

export type PresetScope = { kind: "project"; workspaceId: string; project: string } | { kind: "company"; workspaceId: string };
export const PRESET_CHANGE_TTL_MS = 7 * 86_400_000;
const NO_PROJECT = "_workspace";
const projectOf = (scope: PresetScope): string => (scope.kind === "project" ? scope.project : NO_PROJECT);
const sameScope = (a: PresetScope, b: PresetScope): boolean => a.kind === b.kind && a.workspaceId === b.workspaceId && projectOf(a) === projectOf(b);

/** The stored preset of one scope and its conditional, fenced write. */
export interface PresetStore {
  /** The stored preset, or undefined when never set (Standard). A stored value that is not valid throws (the caller fails closed). */
  read(scope: PresetScope): Promise<LearningPreset | undefined>;
  /**
   * Writes only if the stored value is still `from` (an absent value counts as the default, Standard). False: it moved or the fence failed, and nothing was written. With a `fence` the write also commits only
   * if the membership the decision rested on still holds (the same transaction). A store that cannot honour a fence must refuse (throw), never ignore it.
   */
  write(scope: PresetScope, value: LearningPreset, meta: { by: string; at: number }, from: LearningPreset, fence?: Tier0Fence): Promise<boolean>;
}
/** A proposal to loosen a preset. `from` is the value it was made against: an approval after the value moved is stale. */
export interface PresetChange {
  id: string; scope: PresetScope; from: LearningPreset; to: LearningPreset; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled";
  /** True when the proposer was the ONLY eligible person when they proposed: only such a proposal can be approved by its proposer (sole-owner exception). */
  soleEligibleAtProposal?: boolean;
}
export interface PresetChangeStore {
  create(change: PresetChange): Promise<boolean>;
  get(scope: PresetScope, id: string): Promise<PresetChange | undefined>;
  open(scope: PresetScope, now: number): Promise<PresetChange | undefined>;
  transition(scope: PresetScope, id: string, from: PresetChange["state"], to: PresetChange["state"]): Promise<boolean>;
}
export interface PresetDeps {
  settings: PresetStore; changes: PresetChangeStore; audit: LessonAuditSink; authority: Tier0Authority; now(): number;
  /** The company setting that allows the sole-owner exception for loosening (default ON when never set). Asked only when a person approves their own loosening; a throw counts as OFF. */
  soleOwnerLoosening(workspaceId: string): Promise<boolean>;
  newId?: () => string;
}

export type PresetFailure = Tier0Failure;
export type PresetResult = { ok: true; status: "applied"; changed: boolean; value: LearningPreset } | { ok: true; status: "needs_approval"; changeId: string; value: LearningPreset } | { ok: false; code: PresetFailure };
export type PresetApproveResult = { ok: true; value: LearningPreset } | { ok: false; code: PresetFailure; availableAt?: string };

const LEVEL: Record<LearningPreset, number> = { standard: 0, regulated: 1 };
const fenceOf = (group: Tier0Group): Tier0Fence => ({ membershipVersion: group.membershipVersion, ...(group.fence === undefined ? {} : { conditions: group.fence }) });
const groupOf = async (deps: Pick<PresetDeps, "authority">, scope: PresetScope, who: { proposerId: string; approverId: string }): Promise<Tier0Group | undefined> => {
  const group = await deps.authority.eligibility(scope, who).catch(() => undefined);
  return group !== undefined && group.complete ? group : undefined;
};
const currentOf = async (deps: Pick<PresetDeps, "settings">, scope: PresetScope): Promise<LearningPreset> => (await deps.settings.read(scope)) ?? DEFAULT_LEARNING_PRESET;
/** The company's preset: a floor for every project. An unreadable company setting counts as Regulated (fail closed), so a project cannot go below something that cannot be read. */
const companyFloor = async (deps: Pick<PresetDeps, "settings">, workspaceId: string): Promise<LearningPreset> => {
  try { return await currentOf(deps, { kind: "company", workspaceId }); } catch { return "regulated"; }
};
const soleOwnerAllowed = async (deps: PresetDeps, workspaceId: string): Promise<boolean> => { try { return (await deps.soleOwnerLoosening(workspaceId)) === true; } catch { return false; } };

/**
 * Asks to set a scope's preset. Regulated (or the value it already has) applies now; Standard over Regulated opens a proposal for a different eligible person. Routes call this and
 * `approvePresetChange` / `cancelPresetChange` only.
 */
export async function setLearningPreset(deps: PresetDeps, input: { scope: PresetScope; value: unknown; requestedBy: string }): Promise<PresetResult> {
  const parsed = LearningPresetSchema.safeParse(input.value);
  if (!parsed.success) return { ok: false, code: "invalid_value" };
  const value = parsed.data;
  const { scope } = input;
  const group = await groupOf(deps, scope, { proposerId: input.requestedBy, approverId: input.requestedBy });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.requestedBy)) return { ok: false, code: "not_eligible" };
  let current: LearningPreset;
  try { current = await currentOf(deps, scope); } catch { return { ok: false, code: "eligibility_unavailable" }; }
  if (scope.kind === "project" && LEVEL[value] < LEVEL[await companyFloor(deps, scope.workspaceId)]) return { ok: false, code: "below_company_floor" };
  if (value === current) return { ok: true, status: "applied", changed: false, value };
  const at = deps.now();
  const facts = (extra: Record<string, string> = {}) => ({ scope: scope.kind, from: current, to: value, ...extra });
  if (LEVEL[value] > LEVEL[current]) {
    // Stricter: applied now, against the value it was read at, fenced. An audit outage never blocks the stricter side.
    if (!(await deps.settings.write(scope, value, { by: input.requestedBy, at }, current, fenceOf(group)))) return { ok: false, code: "stale" };
    await emitAudit(deps.audit, { action: "lesson.preset_changed", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.requestedBy, facts: facts({ mode: "direct" }) });
    return { ok: true, status: "applied", changed: true, value };
  }
  // A loosening: a proposal.
  if ((await deps.changes.open(scope, at)) !== undefined) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  // The proposal is created first and the ledger entry follows, so a create that loses a race leaves no `preset_proposed` entry for a proposal that does not exist. A proposal whose entry cannot be
  // written is closed again (nothing waits for a second person without its record), and `needsApproval` reports the value actually in force.
  const created = await deps.changes.create({ id, scope, from: current, to: value, proposedBy: input.requestedBy, at, expiresAt: at + PRESET_CHANGE_TTL_MS, state: "pending", soleEligibleAtProposal: group.eligibleIds.length === 1 });
  if (!created) return { ok: false, code: "conflict" };
  if (!(await requireAudit(deps.audit, { action: "lesson.preset_proposed", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.requestedBy, facts: facts({ changeId: id }) }))) {
    await deps.changes.transition(scope, id, "pending", "cancelled").catch(() => false);
    return { ok: false, code: "audit_unavailable" };
  }
  return { ok: true, status: "needs_approval", changeId: id, value: current };
}

/** A DIFFERENT eligible person approves a proposal to loosen a preset (or the proposer alone, through the sole-owner exception). */
export async function approvePresetChange(deps: PresetDeps, input: { scope: PresetScope; changeId: string; approverId: string }): Promise<PresetApproveResult> {
  const { scope } = input;
  const change = await deps.changes.get(scope, input.changeId);
  if (change === undefined || !sameScope(change.scope, scope)) return { ok: false, code: "not_found" };
  if (change.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (change.expiresAt <= at) return { ok: false, code: "expired" };
  const selfApproval = sameId(change.proposedBy, input.approverId);
  if (selfApproval && change.soleEligibleAtProposal !== true) return { ok: false, code: "second_person_required" };
  const group = await groupOf(deps, scope, { proposerId: change.proposedBy, approverId: input.approverId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok) {
    if (decision.code === "eligibility_unavailable") return { ok: false, code: "eligibility_unavailable" };
    if (decision.code === "sole_owner_cool_off" && selfApproval && decision.availableAt !== undefined) {
      if (!(await soleOwnerAllowed(deps, scope.workspaceId))) return { ok: false, code: "second_person_required" };
      return { ok: false, code: "sole_owner_cool_off", availableAt: decision.availableAt };
    }
    return { ok: false, code: "second_person_required" };
  }
  if (decision.mode === "sole_owner_exception" && !(selfApproval && (await soleOwnerAllowed(deps, scope.workspaceId)))) return { ok: false, code: "second_person_required" };
  let current: LearningPreset;
  try { current = await currentOf(deps, scope); } catch { return { ok: false, code: "eligibility_unavailable" }; }
  if (current !== change.from) return { ok: false, code: "stale" };
  if (scope.kind === "project" && LEVEL[change.to] < LEVEL[await companyFloor(deps, scope.workspaceId)]) return { ok: false, code: "below_company_floor" };
  if (!(await deps.changes.transition(scope, change.id, "pending", "applied"))) return { ok: false, code: "not_pending" };
  if (!(await deps.settings.write(scope, change.to, { by: input.approverId, at }, change.from, fenceOf(group)))) {
    // A refusal by the commit fence alone (the value is still the one the change was made against) is retryable: back to pending with its expiry. A value that moved cancels it.
    const unmoved = await currentOf(deps, scope).then((value) => value === change.from, () => false);
    if (unmoved && await deps.changes.transition(scope, change.id, "applied", "pending").catch(() => false)) {
      await emitAudit(deps.audit, { action: "lesson.tier0_setting_refused_retryable", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId, facts: { scope: scope.kind, changeId: change.id } });
      return { ok: false, code: "membership_changed_retry" };
    }
    await deps.changes.transition(scope, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "stale" };
  }
  // The audit event is written only now, after the claim and the write; a loosening that cannot be recorded is taken back (conditionally) and the change closed.
  // A sole-owner approval is also recorded as `lesson.sole_owner_exception` (the same entry the tier-0 setting writes), first, so an audit of sole-owner use across settings finds preset loosenings too.
  const soleFacts: Record<string, string | number | boolean> = decision.mode === "sole_owner_exception"
    ? { ownerCount: group.ownerIds.length, exceptionReason: "sole_owner_no_other_eligible_24h_clear" } : {};
  const exceptionRecorded = decision.mode !== "sole_owner_exception" || await requireAudit(deps.audit, {
    action: "lesson.sole_owner_exception", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId,
    facts: { scope: scope.kind, changeId: change.id, membershipVersion: group.membershipVersion, ...soleFacts },
  });
  const audited = exceptionRecorded && await requireAudit(deps.audit, {
    action: "lesson.preset_changed", workspaceId: scope.workspaceId, project: projectOf(scope), actor: input.approverId,
    facts: { scope: scope.kind, from: change.from, to: change.to, mode: decision.mode, changeId: change.id, ...soleFacts },
  });
  if (!audited) {
    await deps.settings.write(scope, change.from, { by: input.approverId, at }, change.to).catch(() => false);
    await deps.changes.transition(scope, change.id, "applied", "cancelled").catch(() => false);
    return { ok: false, code: "audit_unavailable" };
  }
  return { ok: true, value: change.to };
}

/** What the people who decide are shown about a proposal waiting for a person (the Lessons tab and the company read). Names nobody: `mine` says whether the viewer asked. */
export interface PresetProposalView { changeId: string; to: LearningPreset; mine: boolean; soleOwner: boolean; expiresAt: number }
/**
 * The open proposal of a scope as `viewerId` may see it, or undefined. Read side only: a store that cannot be read shows nothing (the approval itself is checked again, live, by `approvePresetChange`),
 * so a reader of this never learns anything the routes would not let the same person do. The caller shows it only to people who decide.
 */
export async function readPresetProposal(deps: Pick<PresetDeps, "changes" | "now">, scope: PresetScope, viewerId: string): Promise<PresetProposalView | undefined> {
  const at = deps.now();
  const open = await deps.changes.open(scope, at).catch(() => undefined);
  if (open === undefined || open.state !== "pending" || open.expiresAt <= at || !sameScope(open.scope, scope)) return undefined;
  return { changeId: open.id, to: open.to, mine: sameId(open.proposedBy, viewerId), soleOwner: open.soleEligibleAtProposal === true, expiresAt: open.expiresAt };
}
/** The company preset in force, for the company read. A stored value that cannot be read throws (the route answers 503). */
export async function readPreset(deps: Pick<PresetDeps, "settings">, scope: PresetScope): Promise<LearningPreset> { return currentOf(deps, scope); }

/** An eligible person withdraws a pending proposal. */
export async function cancelPresetChange(deps: PresetDeps, input: { scope: PresetScope; changeId: string; actorId: string }): Promise<{ ok: true } | { ok: false; code: PresetFailure }> {
  const group = await groupOf(deps, input.scope, { proposerId: input.actorId, approverId: input.actorId });
  if (group === undefined) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const change = await deps.changes.get(input.scope, input.changeId);
  if (change === undefined || !sameScope(change.scope, input.scope)) return { ok: false, code: "not_found" };
  if (!(await deps.changes.transition(input.scope, change.id, "pending", "cancelled"))) return { ok: false, code: "not_pending" };
  await emitAudit(deps.audit, { action: "lesson.tier0_setting_cancelled", workspaceId: input.scope.workspaceId, project: projectOf(input.scope), actor: input.actorId, facts: { changeId: change.id, scope: input.scope.kind } });
  return { ok: true };
}
