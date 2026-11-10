// Approving, rejecting and rolling back lessons. Who must approve is set by the tier and the policy:
// tier 0 and tier 1 need one maintainer by default (tier 0 applies by itself only if the project sets tier0Approval "auto"), tier 2 needs two (a second maintainer or admin). Eligibility comes from the project's
// maintainers and How-we-work editors (`ApproverDirectory`); the second-person rule is the existing `decideSecondPersonApproval`, so the sole-owner exception
// and its 24-hour cool-off behave as they do for every other less-safe change.
//
// The approvals inbox: a lesson waiting for people is a `LESSON#` item in the lesson store, listed by `listWaiting`. Registering it as a subject kind in
// the host's own approvals engine, so it also shows in a generic inbox, is wiring a host may add.
import { randomUUID } from "node:crypto";
import { secondPersonOutcome } from "./approval-rules.js";
import { cleanForLearning, requestsCapabilityChange } from "./guards.js";
import { firstExpiry } from "./expiry.js";
import { approversRequired, emitAudit, modeAllows, requireAudit, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { lessonValue } from "./value.js";
import type { ApproverDirectory, LessonDeps, LessonVectors } from "./ports.js";
import { foldDuplicate, retireLesson } from "./curate.js";
import { afterPersonEdit } from "./repo-eligibility.js";
import { dropVector } from "./similarity.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { classifyTier } from "./tier.js";
import type { AccessCheckPort } from "./access-port.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import { memberView, type MemberOf } from "./members.js";
import { distinctIds, idIn, normId, sameId, type IdentitySet, type Lesson, type Tier } from "./types.js";

export interface ApproveDeps extends LessonDeps {
  store: LessonStore; directory: ApproverDirectory; settings: LearningSettingsReader;
  /** Where lesson vectors are kept: a lesson an approval retires (the one a refinement supersedes) loses its vector. */
  vectors?: LessonVectors;
  /** The record core's access check: who may see and decide a lesson is asked of the access records NOW, not only of the snapshot the lesson froze. Required (no port, no decisions). */
  access: AccessCheckPort;
  log?: LessonLog;
}

export type ApprovalFailure =
  | "not_found" | "not_pending" | "mode_off" | "not_eligible" | "already_approved" | "author_cannot_approve_alone"
  | "second_person_required" | "sole_owner_cool_off" | "eligibility_unavailable" | "capability_request" | "conflict" | "tier_never" | "not_permitted" | "audit_unavailable" | "cannot_merge";
export type ApprovalResult =
  | { ok: true; status: "active" | "pending"; lesson: Lesson; needs: "nothing" | "second_person" | "group_member" }
  | { ok: false; code: ApprovalFailure };

const MAX_TRIES = 3;

/** The change was not made because its audit record could not be written (fail closed). */
export class AuditUnavailable extends Error { constructor() { super("audit unavailable"); } }

/** A restricted lesson may be shown to, and decided by, only a person who could see its source. Unrestricted lessons are open to every eligible person. */
async function mayHandle(deps: { directory: ApproverDirectory; access: AccessCheckPort; log?: LessonLog }, key: ScopeKey, lesson: Lesson, personId: string): Promise<boolean> {
  // The person's frozen-snapshot standing AND the access records now (a person removed from the channel can neither see nor decide its lessons); no port, or no answer, is a no.
  try {
    const identity = await deps.directory.identity(key.workspaceId, personId);
    return (await readVisible({ access: deps.access, key, viewer: identity, lessons: [lesson], where: "approve", log: deps.log })).length === 1;
  } catch { return false; }
}

/** What a go-live rests on: the exact lesson version the approvals were given for, the set version that was current when the decision was made, and the decision's own commit conditions. */
export interface ActivationPin { version: number; setVersion: number; fence?: readonly unknown[] }

/**
 * Makes a lesson live: status active, expiry set, approvals recorded, and the lesson it supersedes retired. ONE conditional commit, pinned: it applies only if the stored lesson is still
 * exactly `pin.version` and the set is still at `pin.setVersion`. Approvals are given for a version and its text, so a lesson that moved on (an edit, a rollback, another person's
 * decision) is never made live under them; the caller re-reads and decides again. Returns undefined when it did not go live.
 */
export async function activateLesson(deps: LessonDeps & { store: LessonStore; vectors?: LessonVectors }, key: ScopeKey, lesson: Lesson, approvals: Lesson["approvals"], expiryDays: number | undefined, action: "lesson.activated" | "lesson.auto_applied" | "lesson.trial_started", pin: ActivationPin): Promise<Lesson | undefined> {
  const now = deps.now();
  // A refinement is never applied without a person: the judge that called it a refinement can be steered by the text it read.
  if (action !== "lesson.activated" && lesson.supersedes !== undefined) return undefined;
  // Audit first: a go-live that cannot be recorded does not happen.
  if (!(await requireAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { tier: lesson.tier, type: lesson.type, approvals: approvals.length, ...(lesson.supersedes === undefined ? {} : { supersedes: lesson.supersedes }) } }))) throw new AuditUnavailable();
  const fresh = await deps.store.get(key, lesson.id);
  if (fresh === undefined || (fresh.status !== "pending" && fresh.status !== "candidate")) return undefined;
  // The approvals were collected on `pin.version`: any other version (someone's edit landed since) is not made live under them.
  if (fresh.version !== pin.version || lesson.version !== pin.version) return undefined;
  const next: Lesson = {
    ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), status: "active", approvals: [...approvals],
    // Every new lesson (a trial one too) gets its trial period before the without-helping clock can remove it: it first fades at the end of the trial period plus N days.
    expiresAt: firstExpiry(fresh.type, now, expiryDays), updatedAt: now,
    ...(action === "lesson.trial_started" ? { trial: { state: "trial" as const, startedAt: now } } : {}),
  };
  delete (next as { pendingExpiresAt?: number }).pendingExpiresAt;
  // A person's go-live (or any other way than trial) is not a trial: a leftover trial record would let one thumbs-down retire an approved lesson and make it publishable without ever having been a trial.
  if (action !== "lesson.trial_started") delete (next as { trial?: Lesson["trial"] }).trial;
  const writes = [next];
  if (fresh.supersedes !== undefined) {
    const old = await deps.store.get(key, fresh.supersedes);
    if (old !== undefined && old.status === "active") writes.push({ ...old, version: nextVersion(old, await deps.store.versions(key, old.id)), status: "retired", updatedAt: now });
  }
  // The set version is the one the decision was made on, never one read now: if anything was committed since, this write is refused.
  const result = await deps.store.commit(key, pin.setVersion, writes, now, pin.fence);
  if (result.ok && fresh.supersedes !== undefined) await dropVector(deps.vectors, key, fresh.supersedes);
  return result.ok ? next : undefined;
}

export interface ApproveInput {
  workspaceId: string; project: string; lessonId: string; approverId: string; edit?: { title: string; description: string; body: string };
  /** The version the approver read. When given, an approval of any other version is a conflict: a person approves the text they saw. */
  expectedVersion?: number;
}

export async function approveLesson(deps: ApproveDeps, input: ApproveInput): Promise<ApprovalResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { ok: false, code: "mode_off" };

  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    // Every attempt reads who may approve afresh, with the commit conditions that pin that answer: a person removed since a lost race cannot decide on a retry, and the writes below
    // carry the conditions, so a removal between this read and the write stops them.
    const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.approverId }).catch(() => undefined);
    if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
    if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
    // The set version is read BEFORE the lesson and then used for every write of this attempt: anything committed after this point (another person's edit, approval, rollback) moves the
    // set, so a decision made on the lesson read below can never be written over a newer one. (A set version read at write time would always match, which is how an approval given for an
    // earlier text once went live on a later one.)
    const setVersion = await deps.store.setVersion(key);
    const lesson = await deps.store.get(key, input.lessonId);
    if (lesson === undefined) return { ok: false, code: "not_found" };
    if (lesson.status !== "pending") return { ok: false, code: "not_pending" };
    if (!(await mayHandle(deps, key, lesson, input.approverId))) return { ok: false, code: "not_permitted" };
    // A lesson that supersedes or contradicts another is decided only by a person who could read that other lesson too: approving a refinement retires the old one, and a card must not be decided on advice its approver cannot see.
    for (const otherId of [lesson.supersedes, lesson.contradictsWith, lesson.possibleDuplicateOf]) {
      if (otherId === undefined) continue;
      const other = await deps.store.get(key, otherId);
      if (other !== undefined && !(await mayHandle(deps, key, other, input.approverId))) return { ok: false, code: "not_permitted" };
    }
    if (input.expectedVersion !== undefined && lesson.version !== input.expectedVersion) return { ok: false, code: "conflict" };

    // Edit and approve: the edited text is cleaned and screened, and the tier is worked out again on it.
    let working: Lesson = lesson;
    let approvals = [...lesson.approvals];
    if (input.edit !== undefined) {
      const title = cleanForLearning(input.edit.title, 80);
      const description = cleanForLearning(input.edit.description, 160);
      const body = cleanForLearning(input.edit.body, 600);
      if (title === "" || body === "" || requestsCapabilityChange(title, description, body)) return { ok: false, code: "capability_request" };
      working = { ...lesson, title, description, body };
      // The tier of an edited lesson is the higher of its old tier and the new one, and it keeps its reasons (including the judge's escalate flag): an edit can
      // raise a tier, never lower it, so rewording a tier-2 lesson cannot take it to one person.
      const decision = classifyTier(working, { contradiction: lesson.contradictsWith !== undefined || lesson.tierReasons.includes("matches_rejected"), judgeEscalate: lesson.tierReasons.includes("judge_escalate") }, { tier: lesson.tier, reasons: lesson.tierReasons });
      if (decision.tier === "never") return { ok: false, code: "tier_never" };
      // The editor is recorded as an EDITOR, not an author: the author rule (who may approve alone) is about who wrote the evidence, so a one-tap edit keeps working, but erasure counts
      // an editor as a writer of the text (a lesson an erased person rewrote is hard-deleted).
      working = { ...working, tier: decision.tier, tierReasons: decision.reasons, provenance: { ...afterPersonEdit(working.provenance), editors: distinctIds([...(working.provenance.editors ?? []), input.approverId]) } };
      // A person's edit is a new lesson text: approvals given to the old text do not carry over, and a higher tier needs its people again.
      approvals = [];
    }

    // An approval counts only while its giver is still eligible: a first approver who left the project (or was erased) is dropped, audited, and the person deciding now gives the first.
    const gone = approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial" && !idIn(group.eligibleIds, a.by));
    if (gone.length > 0) {
      approvals = approvals.filter((a) => !gone.includes(a));
      await emitAudit(deps.audit, { action: "lesson.updated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { dropped: gone.length, reason: "approver_not_eligible" } });
    }
    // The author rules compare MEMBERS: a developer merged into another reads as that other (an author recorded under the old id is the member now, and two approvers who are one member are one person).
    const member = await memberViewOf(deps.directory, key.workspaceId, [...working.provenance.authors, input.approverId, ...approvals.map((a) => a.by)]);
    if (member === undefined) return { ok: false, code: "eligibility_unavailable" };
    if (approvals.some((a) => member(a.by) === member(input.approverId))) return { ok: false, code: "already_approved" };
    const tier: Tier = working.tier;
    // A lesson sent back to a person (review required) needs at least one person even if the policy would let its tier apply by itself.
    const required = Math.max(approversRequired(tier, resolved.approval), working.reviewRequired === true ? 1 : 0) as 0 | 1 | 2;
    const isAuthor = isAuthorOf(member, working.provenance.authors, input.approverId);
    let mode: Lesson["approvals"][number]["mode"] = "one";

    if (required === 0) {
      // Policy says this tier applies by itself, but a person who is deciding anyway is accepted as the approval.
      mode = "one";
    } else if (required === 1) {
      if (isAuthor && group.eligibleIds.length > 1) return { ok: false, code: "author_cannot_approve_alone" };
      if (isAuthor) {
        const decision = trySecondPerson(group, input.approverId, input.approverId, deps.now());
        if (!decision.ok) return decision;
        mode = "sole_owner_exception";
      }
    } else if (approvals.length === 0) {
      // The first of two. If this person is the only eligible one, the sole-owner exception may let them finish alone.
      if (group.eligibleIds.length === 1) {
        const decision = trySecondPerson(group, input.approverId, input.approverId, deps.now());
        if (!decision.ok) return decision;
        mode = "sole_owner_exception";
      }
    } else {
      const first = approvals[0]!;
      const decision = trySecondPerson(group, first.by, input.approverId, deps.now());
      if (!decision.ok) return decision;
      mode = decision.mode;
      // A reviewer, check or security lesson is read by someone who did not write the evidence: two of its own authors are not enough (the sole-owner exception above keeps its own rules).
      if (mode !== "sole_owner_exception" && !hasNonAuthor(member, [first.by, input.approverId], working.provenance.authors)) return { ok: false, code: "second_person_required" };
    }

    // A lesson that asks for a capability change (more tools, domains, budget or approvals) reaches the agent only after two different people. The sole-owner exception does not stand in for the second.
    if (mode === "sole_owner_exception" && working.tierReasons.includes("capability_request")) return { ok: false, code: "second_person_required" };
    const now = deps.now();
    const given = { approvalId: (deps.newId ?? randomUUID)(), by: input.approverId, at: now, mode };
    approvals = [...approvals, given];
    const complete = mode === "sole_owner_exception" || approvals.length >= Math.max(required, 1);
    const inGroup = resolved.requiredGroups.every((name) => approvals.some((a) => idIn(group.groups?.[name] ?? [], a.by)));
    // The approval is recorded before it takes effect; if the record cannot be written, nothing changes.
    if (!(await requireAudit(deps.audit, { action: "lesson.approved", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier, mode, count: approvals.length } }))) return { ok: false, code: "audit_unavailable" };
    if (mode === "sole_owner_exception" && !(await requireAudit(deps.audit, { action: "lesson.sole_owner_exception", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier } }))) return { ok: false, code: "audit_unavailable" };

    if (complete && inGroup) {
      // The edited text must be saved with the activation: write the edit first as a version of the pending lesson when there is one. The go-live is then pinned to THAT version and the
      // set version the edit produced, so nothing written between the two steps is made live under these approvals.
      let pin: ActivationPin = { version: lesson.version, setVersion, ...(group.fence === undefined ? {} : { fence: group.fence }) };
      if (input.edit !== undefined) {
        const version = nextVersion(lesson, await deps.store.versions(key, lesson.id));
        const saved = await deps.store.commit(key, setVersion, [{ ...working, approvals: [], version, updatedAt: now }], now, group.fence);
        if (!saved.ok) continue;
        working = { ...working, approvals: [], version, updatedAt: now };
        pin = { ...pin, version, setVersion: saved.setVersion };
      }
      let active: Lesson | undefined;
      try { active = await activateLesson(deps, key, working, approvals, resolved.expiryDays, "lesson.activated", pin); } catch (error) { if (error instanceof AuditUnavailable) return { ok: false, code: "audit_unavailable" }; throw error; }
      if (active === undefined) continue;
      return { ok: true, status: "active", lesson: active, needs: "nothing" };
    }
    // Not complete: keep the lesson pending with this approval, on the version and set this decision was made on.
    const saved: Lesson = { ...working, version: nextVersion(lesson, await deps.store.versions(key, lesson.id)), approvals, updatedAt: now };
    const result = await deps.store.commit(key, setVersion, [saved], now, group.fence);
    if (!result.ok) continue;
    return { ok: true, status: "pending", lesson: saved, needs: complete ? "group_member" : "second_person" };
  }
  return { ok: false, code: "conflict" };
}

/** The members behind these ids (see members.ts), asked of the directory. `undefined`: the merge record could not be read. */
const memberViewOf = (directory: ApproverDirectory, workspaceId: string, ids: readonly string[]): Promise<MemberOf | undefined> =>
  memberView(directory.resolveMember?.bind(directory), workspaceId, ids);
/** True when this person is one of the lesson's authors, as members. */
const isAuthorOf = (member: MemberOf, authors: readonly string[], person: string): boolean => authors.some((author) => member(author) === member(person));
/** True when at least one of these people is not among the lesson's authors, as members. */
function hasNonAuthor(member: MemberOf, people: readonly string[], authors: readonly string[]): boolean { return people.some((person) => !isAuthorOf(member, authors, person)); }

export function trySecondPerson(group: Awaited<ReturnType<ApproverDirectory["eligibility"]>>, proposerId: string, approverId: string, nowMs: number):
  | { ok: true; mode: "second_person" | "sole_owner_exception" } | { ok: false; code: ApprovalFailure } {
  const decision = trySecondPersonTimed(group, proposerId, approverId, nowMs);
  return decision.ok ? decision : { ok: false, code: decision.code };
}
/** The same decision, and in the cool-off case the time it opens (ISO), taken from the shared rule's own refusal so no caller repeats the 24-hour constant. */
export function trySecondPersonTimed(group: Awaited<ReturnType<ApproverDirectory["eligibility"]>>, proposerId: string, approverId: string, nowMs: number):
  | { ok: true; mode: "second_person" | "sole_owner_exception" } | { ok: false; code: ApprovalFailure; availableAt?: string } {
  // The shared rule compares ids exactly: hand it each person in the spelling of the eligible list. (The rule is shared with the design review stage.)
  const spelled = (id: string): string => group.eligibleIds.find((e) => sameId(e, id)) ?? id;
  return secondPersonOutcome(group, spelled(proposerId), spelled(approverId), nowMs);
}

async function decideOnce(deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; actorId: string; expectedVersion?: number; allowed: readonly Lesson["status"][]; to: "rejected" | "retired"; reason: string; action: "lesson.rejected" | "lesson.retired" }): Promise<{ ok: true } | { ok: false; code: ApprovalFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (!input.allowed.includes(lesson.status)) return { ok: false, code: "not_pending" };
  // Reading a restricted lesson to reject it needs the same access as approving it. Retire is the kill switch: it shows no text, so it is never blocked.
  if (input.to === "rejected" && !(await mayHandle(deps, key, lesson, input.actorId))) return { ok: false, code: "not_permitted" };
  // A person rejects the text they read: a lesson that moved on since is not rejected under them.
  if (input.expectedVersion !== undefined && lesson.version !== input.expectedVersion) return { ok: false, code: "conflict" };
  if (input.to === "retired") return (await retireLesson(deps, key, lesson.id, input.reason, input.actorId, "lesson.retired")) ? { ok: true } : { ok: false, code: "conflict" };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined || fresh.status !== "pending") return { ok: false, code: "not_pending" };
    // Every attempt: a retry after a lost race re-reads the lesson, and a lesson that moved on is not rejected under the person who read the earlier text.
    if (input.expectedVersion !== undefined && fresh.version !== input.expectedVersion) return { ok: false, code: "conflict" };
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), status: "rejected", rejectedReason: cleanForLearning(input.reason, 200), updatedAt: deps.now() }], deps.now());
    if (result.ok) {
      await emitAudit(deps.audit, { action: input.action, workspaceId: key.workspaceId, project: key.project, lessonId: fresh.id, actor: input.actorId, facts: {} });
      return { ok: true };
    }
  }
  return { ok: false, code: "conflict" };
}

/** A maintainer rejects a pending lesson. The reason is kept (cleaned), and a similar lesson is not proposed again. */
export const rejectLesson = (deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string; reason: string; expectedVersion?: number }) =>
  decideOnce(deps, { ...input, actorId: input.approverId, allowed: ["pending"], to: "rejected", reason: input.reason, action: "lesson.rejected" });

/**
 * A maintainer merges a pending lesson that is linked as a possible duplicate into the lesson it may duplicate. The person must be eligible to decide lessons here and able to read BOTH lessons (the access records,
 * now). The merge is `foldDuplicate` (all caps, AND-merged trust flags, no lowering of an active lesson's trust or audience): one conditional commit writes the merged lesson and retires the duplicate, so the pair
 * is never half merged. Audited BEFORE the commit (no record, no merge): `lesson.merged` on the surviving lesson, by the person (`judged: "person"`), and `lesson.retired` on the duplicate. A pending target loses the approvals it had (its evidence, authors and audience changed).
 */
export async function mergeDuplicate(deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; actorId: string; expectedVersion?: number }): Promise<{ ok: true; lesson: Lesson } | { ok: false; code: ApprovalFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    // The set version first, then the lessons: a decision made on what was read can never be written over something newer.
    const setVersion = await deps.store.setVersion(key);
    const duplicate = await deps.store.get(key, input.lessonId);
    if (duplicate === undefined) return { ok: false, code: "not_found" };
    if (duplicate.status !== "pending") return { ok: false, code: "not_pending" };
    if (!(await mayHandle(deps, key, duplicate, input.actorId))) return { ok: false, code: "not_permitted" };
    if (input.expectedVersion !== undefined && duplicate.version !== input.expectedVersion) return { ok: false, code: "conflict" };
    if (duplicate.possibleDuplicateOf === undefined) return { ok: false, code: "cannot_merge" };
    const target = await deps.store.get(key, duplicate.possibleDuplicateOf);
    if (target === undefined) return { ok: false, code: "cannot_merge" };
    // Reading the other lesson is part of deciding about it.
    if (!(await mayHandle(deps, key, target, input.actorId))) return { ok: false, code: "not_permitted" };
    const writes = await foldDuplicate(deps, key, target, duplicate);
    if (writes === undefined) return { ok: false, code: "cannot_merge" };
    // The record first (fail closed, as approve does): a merge changes what a live lesson rests on (support tasks, authors, citations), so no record, no merge. The retired duplicate has its own record, under its own id.
    const merged = await requireAudit(deps.audit, { action: "lesson.merged", workspaceId: key.workspaceId, project: key.project, lessonId: target.id, actor: input.actorId, facts: { tier: target.tier, judged: "person", duplicate: duplicate.id } });
    const retired = merged && await requireAudit(deps.audit, { action: "lesson.retired", workspaceId: key.workspaceId, project: key.project, lessonId: duplicate.id, actor: input.actorId, facts: { cause: "merged", reason: "merged", into: target.id, tier: duplicate.tier } });
    if (!retired) return { ok: false, code: "audit_unavailable" };
    const result = await deps.store.commit(key, setVersion, writes, deps.now());
    if (result.ok) {
      await dropVector(deps.vectors, key, duplicate.id);
      return { ok: true, lesson: writes[0]! };
    }
  }
  return { ok: false, code: "conflict" };
}

/** A maintainer retires a lesson (active, stale or pending). Always possible for an eligible person: this is the kill switch (C14). */
export const retireByPerson = (deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; actorId: string; reason: string }) =>
  decideOnce(deps, { ...input, allowed: ["active", "stale", "pending", "candidate"], to: "retired", action: "lesson.retired" });

/** Restores an earlier lesson-set version. Audited `lesson.rolled_back`. */
export async function rollbackLessonSet(deps: ApproveDeps, input: { workspaceId: string; project: string; targetSetVersion: number; actorId: string; /** The set version the person saw: the store\'s conditional write enforces it, so a set that moved since is not rolled away. */ expectedSetVersion?: number; /** Runs the normal tier check again on each restored lesson (the caller passes `settleLesson`). */ onRestored?: (lessonId: string) => Promise<unknown> }): Promise<{ ok: true; setVersion: number; restored: string[] } | { ok: false; code: ApprovalFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.actorId }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.actorId)) return { ok: false, code: "not_eligible" };
  const current = input.expectedSetVersion ?? await deps.store.setVersion(key);
  if (!(await requireAudit(deps.audit, { action: "lesson.rolled_back", workspaceId: key.workspaceId, project: key.project, actor: input.actorId, facts: { to: input.targetSetVersion, from: current } }))) return { ok: false, code: "audit_unavailable" };
  const result = await deps.store.rollback(key, input.targetSetVersion, current, deps.now());
  if (!result.ok) return { ok: false, code: "conflict" };
  const restored = result.restored ?? [];
  for (const id of restored) { try { await input.onRestored?.(id); } catch { /* the lesson stays pending for a person */ } }
  for (const id of restored) { try { await recheckRestored(deps, key, id, group); } catch { /* the lesson stays pending for a person */ } }
  return { ok: true, setVersion: result.setVersion, restored };
}

/**
 * A restored lesson comes back pending. A person\'s earlier approval counts again only if it still stands NOW: the approver is still eligible, the current policy\'s
 * number of approvers is met, and every required group is represented. Approvals that no longer stand are removed (the lesson stays pending for a person).
 */
async function recheckRestored(deps: ApproveDeps, key: ScopeKey, id: string, group: Awaited<ReturnType<ApproverDirectory["eligibility"]>>): Promise<void> {
  // The set version is read BEFORE the lesson and carried through every write below (each commit hands back the next one): an approval that lands while this check runs moves the set, and the
  // go-live at the end is then refused instead of making the newer version live under approvals worked out for the older one.
  let setVersion = await deps.store.setVersion(key);
  let lesson = await deps.store.get(key, id);
  if (lesson === undefined || lesson.status !== "pending") return;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  const eligible = new Set(group.eligibleIds.map(normId));
  const persons = lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial");
  const valid = persons.filter((a) => eligible.has(normId(a.by)));
  if (valid.length !== lesson.approvals.length) {
    const next: Lesson = { ...lesson, version: nextVersion(lesson, await deps.store.versions(key, id)), approvals: valid, updatedAt: deps.now() };
    const kept = await deps.store.commit(key, setVersion, [next], deps.now(), group.fence);
    if (!kept.ok) return;
    lesson = next; setVersion = kept.setVersion;
  }
  const required = Math.max(approversRequired(lesson.tier, resolved.approval), 1);
  // The sole-owner exception stands only while the group is still one person, and still passes the shared rule (cool-off included).
  const sole = group.eligibleIds.length === 1 && valid.some((a) => a.mode === "sole_owner_exception" && trySecondPerson(group, a.by, a.by, deps.now()).ok);
  // The author rule applies to a restored approval as it does to a new one: an author\'s own approval does not count while someone else could give it.
  const authors = lesson.provenance.authors;
  // Members, not raw ids (a merged developer is the member they became); a merge record that cannot be read leaves the lesson pending for a person.
  const member = await memberViewOf(deps.directory, key.workspaceId, [...authors, ...valid.map((a) => a.by)]);
  if (member === undefined) return;
  const countable = group.eligibleIds.length > 1 ? valid.filter((a) => !isAuthorOf(member, authors, a.by) || a.mode === "second_person") : valid;
  if (countable.length !== valid.length) {
    const next: Lesson = { ...lesson, version: nextVersion(lesson, await deps.store.versions(key, id)), approvals: countable, updatedAt: deps.now() };
    const kept = await deps.store.commit(key, setVersion, [next], deps.now(), group.fence);
    if (!kept.ok) return;
    lesson = next; setVersion = kept.setVersion;
  }
  // A team of one: the author's own approval (made when a person deciding anyway was accepted under "auto") is the sole-owner exception in all but name, so it needs the same
  // cool-off as a new one. An approval that does not pass the shared rule does not count; it stays on the record, and the lesson waits for a person.
  const soloAuthored = (a: Lesson["approvals"][number]): boolean => group.eligibleIds.length === 1 && a.mode !== "second_person" && isAuthorOf(member, authors, a.by);
  const standing = countable.filter((a) => !soloAuthored(a) || trySecondPerson(group, a.by, a.by, deps.now()).ok);
  // A tier-2 lesson that two of its own authors approved before the rule existed does not go live on a restore either.
  const enough = sole || (new Set(standing.map((a) => member(a.by))).size >= required && (required < 2 || hasNonAuthor(member, standing.map((a) => a.by), authors)));
  const groupsOk = resolved.requiredGroups.every((name) => standing.some((a) => idIn(group.groups?.[name] ?? [], a.by)));
  if (standing.length === 0 || !enough || !groupsOk) return;
  // Pinned to the version these approvals were judged on (the one this function read or wrote last) and the set version that goes with it.
  try { await activateLesson(deps, key, lesson, standing, resolved.expiryDays, "lesson.activated", { version: lesson.version, setVersion, ...(group.fence === undefined ? {} : { fence: group.fence }) }); } catch (error) { if (!(error instanceof AuditUnavailable)) throw error; }
}

/**
 * The lessons waiting for people, most valuable first (measured outcomes, then recurrence, then severity), for the Lessons tab and the Home card. A lesson
 * from a restricted source is listed only for a viewer who could see that source.
 */
export async function listWaiting(store: LessonStore, key: ScopeKey, viewer: IdentitySet, access: AccessCheckPort, log?: LessonLog): Promise<Lesson[]> {
  return (await readVisible({ access, key, viewer, lessons: await store.list(key, { statuses: ["pending"] }), where: "approve", log }))
    .sort((a, b) => lessonValue(b) - lessonValue(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Lessons collected but not yet in front of people (waiting for corroboration, or held because their source spiked), most valuable first. Nothing is dropped. */
export async function listQueued(store: LessonStore, key: ScopeKey, viewer: IdentitySet, access: AccessCheckPort, log?: LessonLog): Promise<Lesson[]> {
  return (await readVisible({ access, key, viewer, lessons: await store.list(key, { statuses: ["candidate"] }), where: "approve", log }))
    .sort((a, b) => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id));
}
