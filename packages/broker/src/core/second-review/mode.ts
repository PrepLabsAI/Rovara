// Second review: the writer of the mode, `review.otherCompany` (off, shadow, on), for the company and, as an override that can only be stricter, for a project.
// The rules:
//   - RAISING applies at once, audited in the same transaction. Raising to `on` is refused unless the evidence for the chosen model holds (the caller asks `secondReviewVerdictHolds` and passes the answer; nothing
//     here trusts a stored pass).
//   - LOWERING (`on` to `shadow` or `off`, `shadow` to `off`, a company mode or a project's, and clearing a project's override when that lowers it) goes through the APPROVERS port: when its requirement for a
//     `setting` request needs more than the person who asked (`minApprovers` above 1, or no self-approval), the lowering is a proposal that a DIFFERENT person approves with a proof the port verifies, and the
//     proposer can never approve their own. When the port needs only one (Code's default: the local owner), the lowering applies at once, audited. (the hosted product's rule "a different eligible admin, no sole-owner exception,
//     signed in within 10 minutes" is its approvers adapter's answer to `requirement`; see the 51 gaps in the lane report for the membership fence.)
//   - A project can be pinned to `on` ONLY by an admin/owner (`requesterIsAdmin`; a maintainer may pin `shadow`, or `off` where that is not below the company). `on` needs the evidence for the model whenever the
//     project is not already pinned `on`. A project pinned `on` follows the company down: lowering the company stamps `loweredAt`, and a pin written before that stamp stops counting
//     (`readSecondReviewSettings`). Atomic and race-free: nothing has to find and rewrite the pinned projects inside the approval.
//   - A waiting proposal whose `from` is no longer what the scope effectively has is cancelled by the next proposal for that scope, in the same transaction (audited).
//   - Stored under the company's partition beside the other second-review settings (settings.ts): the company's mode is written as BOTH its `default` and its `lock` (the floor a project cannot go below); a
//     project's override is its `mode`. A proposal is `SECONDREVIEW#MODECHANGE#<id>` (the shared key layout).
//   - Every write is conditional on the values it was made against, and an approval commits the claim on the proposal, the setting and the audit event in ONE transaction.
import { createHash, randomUUID } from "node:crypto";
import {
  SecondReviewModeSchema, change, configuredSecondReviewMode, queryAll, secondReviewModeLoweringNeedsSecondPerson, stricterSecondReviewMode, when,
  type ApprovalProof, type ApprovalRequest, type Approvers, type AuditEvent, type AuditSink, type Condition, type DocumentKey, type JsonValue, type Principal, type SecondReviewMode, type TransactItem, type UpdateOp,
} from "@agentx/contracts";
import {
  SECOND_REVIEW_SETTINGS_SK, readSecondReviewSettings, secondReviewPartition, secondReviewProjectKey, secondReviewSettingsKey, type SecondReviewSettings, type SecondReviewStore,
} from "./settings.js";

export const SECOND_REVIEW_MODE_CHANGE_TTL_MS = 7 * 86_400_000;
const CHANGE_PREFIX = "SECONDREVIEW#MODECHANGE#";
const changeKey = (companyId: string, id: string): DocumentKey => ({ pk: secondReviewPartition(companyId), sk: `${CHANGE_PREFIX}${id.replace(/#/gu, "_")}` });

export type ModeScope = { kind: "company" } | { kind: "project"; project: string };
const scopeKey = (scope: ModeScope): string => (scope.kind === "company" ? "company" : `project:${scope.project}`);

/** A proposal to lower the mode. `from` is the effective mode it was made against: an approval after that moved is stale. */
export interface ModeChange {
  id: string; orgId: string; scope: ModeScope;
  from: SecondReviewMode; to: SecondReviewMode;
  /** A project proposal that clears the override (the project follows the company again). `to` is then the mode it falls back to. */
  clear?: true;
  proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "cancelled";
}

export type ModeFailure =
  | "not_eligible" | "approval_unavailable" | "settings_unreadable"
  | "reauth_required" | "below_company_mode" | "verdict_missing" | "already_open" | "not_found" | "not_pending" | "expired" | "stale" | "second_person_required" | "conflict";

export interface ModeDeps {
  store: SecondReviewStore;
  audit: AuditSink;
  approvers: Approvers;
  companyId: string;
  now(): number;
  newId?: () => string;
}

/** The mode a scope effectively has now (a project: its override, else the company's, never below the company's floor). */
export function effectiveMode(settings: Pick<SecondReviewSettings, "companyDefault" | "companyLock" | "projectMode">, scope: ModeScope): SecondReviewMode {
  return scope.kind === "company"
    ? stricterSecondReviewMode(settings.companyDefault ?? "off", settings.companyLock ?? "off")
    : configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
}
const companyModeOf = (settings: SecondReviewSettings): SecondReviewMode => effectiveMode(settings, { kind: "company" });

/** `attr = v` for a stored value, `notExists` for an absent one: a write made against what was read. */
const sameAsRead = (fields: ReadonlyArray<[name: string, value: JsonValue | undefined]>): Condition =>
  when.and(...fields.map(([name, value]) => (value === undefined ? when.notExists(name) : when.eq(name, value))));

/** The setting write for a mode change, conditional on what was read. A project change with `clear` removes the override. */
function settingUpdate(deps: ModeDeps, input: { scope: ModeScope; to: SecondReviewMode; clear?: boolean; lowering?: boolean; seen: SecondReviewSettings; by: string; at: number }): TransactItem {
  const company = input.scope.kind === "company";
  const key = company ? secondReviewSettingsKey(deps.companyId) : secondReviewProjectKey(deps.companyId, (input.scope as { project: string }).project);
  // The project's guard is its STORED mode (a pin that has lapsed is still what is stored).
  const guard = company ? sameAsRead([["default", input.seen.companyDefault], ["lock", input.seen.companyLock]]) : sameAsRead([["mode", input.seen.projectModeStored]]);
  const stamps: UpdateOp[] = [change.set("updatedAt", input.at), change.set("updatedBy", input.by), change.set("entityType", company ? "SECOND_REVIEW_SETTINGS" : "SECOND_REVIEW_PROJECT")];
  const ops: UpdateOp[] = company
    // A lowering stamps the company, so a project pinned `on` before it stops counting.
    ? [...stamps, change.set("default", input.to), change.set("lock", input.to), ...(input.lowering === true ? [change.set("loweredAt", input.at)] : [])]
    : input.clear === true ? [...stamps, change.remove("mode"), change.remove("modeAt")] : [...stamps, change.set("mode", input.to), change.set("modeAt", input.at)];
  return { kind: "update", key, ops, condition: guard };
}

/** A check, in the same transaction, that the company has not been lowered since `seen` was read (the stamp is what it was, or still absent). */
const loweredCheck = (deps: ModeDeps, seen: SecondReviewSettings): TransactItem =>
  ({ kind: "check", key: { pk: secondReviewPartition(deps.companyId), sk: SECOND_REVIEW_SETTINGS_SK }, condition: sameAsRead([["loweredAt", seen.companyLoweredAt]]) });

/** The audit event as transaction steps (Code: the sink's own; none when it writes somewhere else). */
export function stagedAudit(deps: Pick<ModeDeps, "audit" | "companyId">, event: { action: string; subject?: { type: string; id: string }; details?: Record<string, JsonValue> }, actorId: string, at: number): TransactItem[] {
  const when_ = new Date(at).toISOString();
  const full: AuditEvent = {
    eventId: `${event.action}:${createHash("sha256").update(JSON.stringify([deps.companyId, event.action, when_, actorId, event.subject, event.details, randomUUID()])).digest("hex").slice(0, 40)}`,
    companyId: deps.companyId, at: when_, actor: { type: "person", id: actorId }, action: event.action,
    ...(event.subject === undefined ? {} : { subject: event.subject }), ...(event.details === undefined ? {} : { details: event.details }),
  };
  return [...deps.audit.stage(full)];
}
const subjectOf = (deps: Pick<ModeDeps, "companyId">, scope: ModeScope) => (scope.kind === "company" ? { type: "company", id: deps.companyId.slice(0, 100) } : { type: "project", id: scope.project });

async function read(deps: ModeDeps, scope: ModeScope): Promise<SecondReviewSettings | undefined> {
  try { return await readSecondReviewSettings(deps.store, deps.companyId, scope.kind === "project" ? scope.project : ""); } catch { return undefined; }
}

async function send(deps: ModeDeps, items: TransactItem[]): Promise<"ok" | "cancelled"> {
  return (await deps.store.transact(items)).applied ? "ok" : "cancelled";
}

export type ModeRequest = { ok: true; status: "applied"; mode: SecondReviewMode } | { ok: true; status: "needs_approval"; changeId: string } | { ok: false; code: ModeFailure };

/** The approval request a lowering is asked and verified under: a `setting` of the company, bound to exactly this change (its scope, from, to). */
export function modeApprovalRequest(deps: Pick<ModeDeps, "companyId">, change_: Pick<ModeChange, "id" | "scope" | "from" | "to" | "clear" | "expiresAt">, requestedBy?: Principal): ApprovalRequest {
  return {
    companyId: deps.companyId, requestId: `second-review-mode:${change_.id}`, kind: "setting", subject: { type: "second-review-mode", id: scopeKey(change_.scope) },
    ...(change_.scope.kind === "project" ? { projectName: change_.scope.project } : {}), revision: 1,
    artifactDigest: createHash("sha256").update(JSON.stringify(["second-review-mode", scopeKey(change_.scope), change_.from, change_.to, change_.clear === true])).digest("hex"),
    ...(requestedBy === undefined ? {} : { requestedBy }), risk: "high", expiresAt: new Date(change_.expiresAt).toISOString(),
  };
}

/** Whether lowering needs a person other than the one who asks: the approvers port's own answer for a `setting` request. */
export async function needsAnotherPerson(deps: ModeDeps, scope: ModeScope, from: SecondReviewMode, to: SecondReviewMode, requestedBy: Principal): Promise<boolean | undefined> {
  try {
    const requirement = await deps.approvers.requirement(modeApprovalRequest(deps, { id: "probe", scope, from, to, expiresAt: deps.now() + SECOND_REVIEW_MODE_CHANGE_TTL_MS }, requestedBy));
    return requirement.minApprovers > 1 || !requirement.selfApprovalAllowed;
  } catch { return undefined; }
}

/**
 * Asks to set the mode. The caller has checked the person's role for the scope and that this is the owner's own session (the page, never a token); `onAllowed` is whether the evidence for the chosen model holds
 * (asked when `to` is `on`). A project value below the company's mode is refused. Equal or higher applies now; lower applies now unless the approvers port needs another person, and then opens a proposal.
 */
export async function requestSecondReviewMode(deps: ModeDeps, input: { scope: ModeScope; to: SecondReviewMode | "inherit"; requestedBy: Principal; onAllowed: boolean; /** The caller's role: an owner or admin. A project is pinned `on` only by one. */ requesterIsAdmin: boolean; /** The page session is recent (ten minutes): lowering needs a fresh sign-in. Default: it is. */ fresh?: boolean }): Promise<ModeRequest> {
  const { scope } = input;
  const by = input.requestedBy.personId;
  if (input.to === "inherit" ? scope.kind !== "project" : !SecondReviewModeSchema.safeParse(input.to).success) return { ok: false, code: "conflict" };
  // Blocking for a project is an admin's decision, not the maintainer's.
  if (scope.kind === "project" && input.to === "on" && !input.requesterIsAdmin) return { ok: false, code: "not_eligible" };
  const seen = await read(deps, scope);
  if (seen === undefined) return { ok: false, code: "settings_unreadable" };
  const before = effectiveMode(seen, scope);
  const clear = input.to === "inherit";
  const companyMode = companyModeOf(seen);
  const to: SecondReviewMode = clear ? companyMode : input.to as SecondReviewMode;
  if (scope.kind === "project" && !clear && secondReviewModeLoweringNeedsSecondPerson(companyMode, to)) return { ok: false, code: "below_company_mode" };
  const at = deps.now();
  const facts = { scope: scope.kind, from: before, to };
  const lowering = secondReviewModeLoweringNeedsSecondPerson(before, to);
  let another = false;
  if (lowering && input.fresh === false) return { ok: false, code: "reauth_required" };
  if (lowering) {
    const asked = await needsAnotherPerson(deps, scope, before, to, input.requestedBy);
    if (asked === undefined) return { ok: false, code: "approval_unavailable" };
    another = asked;
  }
  if (!lowering || !another) {
    // Equal or stricter, or a lowering nobody else has to approve: applied now. `on` only for a model whose evidence holds, and that is asked whenever the scope is not already SET to `on` (a project that merely
    // follows an `on` company is not pinned to it).
    const alreadyOn = scope.kind === "project" ? seen.projectMode === "on" : before === "on";
    if (to === "on" && !alreadyOn && !input.onAllowed) return { ok: false, code: "verdict_missing" };
    const audit = stagedAudit(deps, { action: "company.second_review_mode_changed", subject: subjectOf(deps, scope), details: { ...facts, mode: lowering ? "owner" : "direct" } }, by, at);
    // A project's pin is also conditional on the company not having been lowered since it was read: a pin that races a lowering commits first or fails, never lands after it unnoticed.
    const unlowered: TransactItem[] = scope.kind === "project" ? [loweredCheck(deps, seen)] : [];
    const result = await send(deps, [settingUpdate(deps, { scope, to, clear, lowering: lowering && scope.kind === "company", seen, by, at }), ...unlowered, ...audit]);
    return result === "cancelled" ? { ok: false, code: "stale" } : { ok: true, status: "applied", mode: to };
  }
  // Lowering that needs a different person: a proposal.
  const open = await openModeChange(deps, scope, at).catch(() => "unreadable" as const);
  if (open === "unreadable") return { ok: false, code: "settings_unreadable" };
  // A waiting proposal that was made against a mode the scope no longer has can never be approved (it would be stale): the new proposal replaces it, in the same transaction.
  if (open !== undefined && open.from === before) return { ok: false, code: "already_open" };
  const id = (deps.newId ?? (() => randomUUID()))();
  const audit = stagedAudit(deps, { action: "company.second_review_mode_proposed", subject: subjectOf(deps, scope), details: facts }, by, at);
  const replaced = open === undefined ? [] : stagedAudit(deps, { action: "company.second_review_mode_cancelled", subject: subjectOf(deps, scope), details: { scope: scope.kind, from: open.from, to: open.to, cause: "stale" } }, by, at);
  const proposal: ModeChange = { id, orgId: deps.companyId, scope, from: before, to, ...(clear ? { clear: true as const } : {}), proposedBy: by, at, expiresAt: at + SECOND_REVIEW_MODE_CHANGE_TTL_MS, state: "pending" };
  const result = await send(deps, [
    ...(open === undefined ? [] : [cancelUpdate(deps, open.id), ...replaced]),
    { kind: "put", item: { ...changeKey(deps.companyId, id), entityType: "SECOND_REVIEW_MODE_CHANGE", ...structuredClone(proposal) as unknown as Record<string, JsonValue>, proposer: principalDoc(input.requestedBy) }, condition: when.absent() }, ...audit,
  ]);
  return result === "cancelled" ? { ok: false, code: "conflict" } : { ok: true, status: "needs_approval", changeId: id };
}

const principalDoc = (principal: Principal): JsonValue => ({ companyId: principal.companyId, personId: principal.personId, displayName: principal.displayName, roles: [...principal.roles], provider: principal.provider });

/** Marks a pending proposal cancelled (only while it is pending). */
const cancelUpdate = (deps: ModeDeps, id: string): TransactItem => ({ kind: "update", key: changeKey(deps.companyId, id), ops: [change.set("state", "cancelled")], condition: when.eq("state", "pending") });

function parseChange(item: Record<string, unknown> | undefined): ModeChange | undefined {
  if (item?.["entityType"] !== "SECOND_REVIEW_MODE_CHANGE" || typeof item["id"] !== "string" || typeof item["orgId"] !== "string") return undefined;
  const scope = item["scope"] as { kind?: unknown; project?: unknown } | undefined;
  const from = SecondReviewModeSchema.safeParse(item["from"]), to = SecondReviewModeSchema.safeParse(item["to"]);
  if (!from.success || !to.success || typeof item["proposedBy"] !== "string" || typeof item["at"] !== "number" || typeof item["expiresAt"] !== "number") return undefined;
  const state = item["state"];
  if (state !== "pending" && state !== "applied" && state !== "cancelled") return undefined;
  const parsedScope: ModeScope | undefined = scope?.kind === "company" ? { kind: "company" } : scope?.kind === "project" && typeof scope.project === "string" ? { kind: "project", project: scope.project } : undefined;
  if (parsedScope === undefined) return undefined;
  return { id: item["id"], orgId: item["orgId"], scope: parsedScope, from: from.data, to: to.data, ...(item["clear"] === true ? { clear: true as const } : {}), proposedBy: item["proposedBy"], at: item["at"], expiresAt: item["expiresAt"], state };
}

const proposerOf = (item: Record<string, unknown> | undefined, fallback: ModeChange): Principal => {
  const raw = item?.["proposer"] as Partial<Principal> | undefined;
  return raw !== undefined && typeof raw.personId === "string" && raw.personId === fallback.proposedBy
    ? { companyId: String(raw.companyId ?? fallback.orgId), personId: raw.personId, displayName: String(raw.displayName ?? raw.personId), roles: Array.isArray(raw.roles) ? raw.roles.map(String) : [], provider: String(raw.provider ?? "recorded") }
    : { companyId: fallback.orgId, personId: fallback.proposedBy, displayName: fallback.proposedBy, roles: [], provider: "recorded" };
};

/** A proposal by id, or none (an unreadable one is none). */
export async function getModeChange(store: SecondReviewStore, companyId: string, id: string): Promise<ModeChange | undefined> {
  return parseChange(await store.get(changeKey(companyId, id)));
}

/** Every proposal item of the company, paged through to the end. */
async function allModeChanges(store: SecondReviewStore, companyId: string): Promise<ModeChange[]> {
  const found: ModeChange[] = [];
  for (const item of await queryAll(store, { pk: secondReviewPartition(companyId), sk: { op: "beginsWith", prefix: CHANGE_PREFIX } })) { const parsed = parseChange(item); if (parsed !== undefined) found.push(parsed); }
  return found;
}

/** The scope's pending proposal that has not expired. */
export async function openModeChange(deps: Pick<ModeDeps, "store" | "companyId">, scope: ModeScope, now: number): Promise<ModeChange | undefined> {
  return (await allModeChanges(deps.store, deps.companyId)).find((entry) => entry.state === "pending" && entry.expiresAt > now && scopeKey(entry.scope) === scopeKey(scope));
}

/** Every pending, unexpired proposal of the company (the settings page lists them). */
export async function openModeChanges(deps: Pick<ModeDeps, "store" | "companyId">, now: number): Promise<ModeChange[]> {
  return (await allModeChanges(deps.store, deps.companyId)).filter((entry) => entry.state === "pending" && entry.expiresAt > now);
}

export type ModeApproval = { ok: true; mode: SecondReviewMode } | { ok: false; code: ModeFailure };

/**
 * A DIFFERENT person approves a proposal to lower the mode, with a proof the approvers port verifies for exactly this change. The proposer can never approve it, whatever the port says (the one-admin rule: no
 * sole-owner exception).
 */
export async function approveSecondReviewModeChange(deps: ModeDeps, input: { changeId: string; approver: Principal; proof: ApprovalProof; fresh?: boolean }): Promise<ModeApproval> {
  if (input.fresh === false) return { ok: false, code: "reauth_required" };
  const stored = await deps.store.get(changeKey(deps.companyId, input.changeId)).catch(() => undefined);
  const found = parseChange(stored);
  if (found === undefined || found.orgId !== deps.companyId) return { ok: false, code: "not_found" };
  if (found.state !== "pending") return { ok: false, code: "not_pending" };
  const at = deps.now();
  if (found.expiresAt <= at) return { ok: false, code: "expired" };
  if (found.proposedBy === input.approver.personId) return { ok: false, code: "second_person_required" };
  const request = modeApprovalRequest(deps, found, proposerOf(stored, found));
  const verdict = await deps.approvers.verify(request, input.proof).catch(() => undefined);
  if (verdict === undefined) return { ok: false, code: "approval_unavailable" };
  if (!verdict.approved || verdict.approver.personId === found.proposedBy || verdict.approver.personId !== input.approver.personId) return { ok: false, code: "second_person_required" };
  const seen = await read(deps, found.scope);
  if (seen === undefined) return { ok: false, code: "settings_unreadable" };
  // The world moved since the proposal: what the scope effectively has is no longer what the proposal was made against.
  if (effectiveMode(seen, found.scope) !== found.from) return { ok: false, code: "stale" };
  // Clearing a project's override lands on the COMPANY's mode as it is now, which may differ from what it was when the proposal was made: the event and the answer say what the setting becomes.
  const to: SecondReviewMode = found.clear === true ? companyModeOf(seen) : found.to;
  const audit = stagedAudit(deps, { action: "company.second_review_mode_changed", subject: subjectOf(deps, found.scope), details: { scope: found.scope.kind, from: found.from, to, mode: "second_person" } }, input.approver.personId, at);
  const claim: TransactItem = { kind: "update", key: changeKey(deps.companyId, found.id), ops: [change.set("state", "applied")], condition: when.and(when.eq("state", "pending"), when.eq("proposedBy", found.proposedBy), when.eq("expiresAt", found.expiresAt)) };
  const write = settingUpdate(deps, { scope: found.scope, to, clear: found.clear === true, lowering: found.scope.kind === "company", seen, by: input.approver.personId, at });
  return (await send(deps, [claim, write, ...audit])) === "ok" ? { ok: true, mode: to } : { ok: false, code: "stale" };
}

/** The proposer, or another person the port lets act, withdraws a pending proposal. */
export async function cancelSecondReviewModeChange(deps: ModeDeps, input: { changeId: string; actor: Principal }): Promise<{ ok: true } | { ok: false; code: ModeFailure }> {
  const found = await getModeChange(deps.store, deps.companyId, input.changeId).catch(() => undefined);
  if (found === undefined || found.orgId !== deps.companyId) return { ok: false, code: "not_found" };
  const at = deps.now();
  const audit = stagedAudit(deps, { action: "company.second_review_mode_cancelled", subject: subjectOf(deps, found.scope), details: { scope: found.scope.kind, from: found.from, to: found.to, cause: "withdrawn" } }, input.actor.personId, at);
  // The cancellation and its audit event commit together.
  return (await send(deps, [cancelUpdate(deps, found.id), ...audit])) === "cancelled" ? { ok: false, code: "not_pending" } : { ok: true };
}
