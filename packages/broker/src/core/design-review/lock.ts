// Design review stage: the company's lock on a project's design review setting. A lock can only make the setting STRICTER (the M8 rule):
//   - set `allowSkip` to false,
//   - raise the tier (a floor),
//   - lower the cap ceiling,
//   - name the high-risk approver group.
// A project can never loosen it. Two places enforce that, and both fail closed:
//   - `checkAgainstLock` refuses a project's write that is looser than the lock, naming only the field;
//   - `effectiveDesignReviewSetting` clamps whatever is stored to the lock, so a lock added AFTER a project chose something looser still holds from then on.
// There is NO mode floor: a lock may never stop a project's maintainers turning their own project Off. An older item may still carry `lock.mode`; it is ignored on read and never written.
// A lock that is stored but cannot be read is never read as "no lock": its fields are clamped to the strictest posture (no skipping, the default cap, the default tier), design review is NOT available for the company (switch.ts), and a write is refused.
import { z } from "zod";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, markEffective, type EffectiveDesignReviewSetting } from "./effective-setting.js";
import {
  DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_CAP_MIN_USD, DESIGN_REVIEW_DEFAULT_SETTING, DESIGN_REVIEW_TIERS, DesignReviewTierSchema, when,
  type DesignReviewSetting, type DocumentStore, type TransactItem,
} from "@agentx/contracts";

/** The lock the company set. Every field is optional: an absent field locks nothing. Strict, so a typo is not a silently ignored lock. */
export const DesignReviewLockSchema = z.object({
  /** The setting's tier may not be below this. */
  tierAtLeast: DesignReviewTierSchema.optional(),
  /** `false` takes away the Skip button for every project. There is no `true`: a lock that allows something locks nothing. */
  allowSkip: z.literal(false).optional(),
  /** The setting's cap per task may not be above this. */
  capCeilingUsd: z.number().min(DESIGN_REVIEW_CAP_MIN_USD).max(DESIGN_REVIEW_CAP_MAX_USD).optional(),
  /** The high-risk approver is this group, in every project. Enterprise only. */
  approverGroupId: z.string().min(1).max(100).optional(),
}).strict();
export type DesignReviewLock = z.infer<typeof DesignReviewLockSchema>;

/**
 * Reads a stored lock. An item written before the mode floor was removed may carry `mode`: it is dropped here (never read as a lock, never written back), so such an item stays readable. Any other unknown field still makes
 * the lock unreadable (strict), which is the safe side for a newer release's field.
 */
export function parseStoredLock(value: unknown): ReturnType<typeof DesignReviewLockSchema.safeParse> {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "mode" in value) {
    const { mode: _ignored, ...rest } = value as Record<string, unknown>;
    void _ignored;
    return DesignReviewLockSchema.safeParse(rest);
  }
  return DesignReviewLockSchema.safeParse(value);
}

/** What reading the company's lock gave: none, a lock, or one that is stored but unreadable (never the same as none). */
export type DesignReviewLockRead = { kind: "none" } | { kind: "lock"; lock: DesignReviewLock; /** The lock item's revision at the read. A write that depends on this read is conditional on it (M3). */ revision: number } | { kind: "unreadable" };

/** The company item the lock and policy live on: Cloud's organisation item (`ORG#<id>`), so a hosted install and Code read the same row. */
const orgMetaKey = (orgId: string): { pk: string; sk: "META" } => ({ pk: `ORG#${orgId}`, sk: "META" });
export const DESIGN_REVIEW_LOCK_SK = "DESIGNREVIEW#LOCK";
/** What the company's lock and policy are read from: the document store (the key is Cloud's, so a lock a hosted install wrote is held here too; Code itself has no writer for it). */
export type DesignReviewLockTable = Pick<DocumentStore, "get">;

/** The condition a write puts on the lock item so that a lock set after the read refuses the write (M3). `none`: the item must still not exist; a lock: its revision must be the one read. Unreadable has none (a write is refused). */
export function lockRevisionCheck(orgId: string, read: DesignReviewLockRead): TransactItem | undefined {
  const key = { pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK };
  if (read.kind === "none") return { kind: "check", key, condition: when.absent() };
  if (read.kind === "lock") return { kind: "check", key, condition: when.eq("revision", read.revision) };
  return undefined;
}

/**
 * The company's design review policy, beside the lock on the same item: whether design review is allowed at all (absent means not allowed). Projects choose their own mode; there is no company default mode.
 * An older item may still carry `defaultMode`: unknown keys are dropped on read and the field is never written.
 */
export const DesignReviewCompanyPolicySchema = z.object({
  allowed: z.boolean().optional(),
});
export type DesignReviewCompanyPolicyStored = z.infer<typeof DesignReviewCompanyPolicySchema>;
/** The policy as it applies. */
export interface DesignReviewCompanyPolicy { allowed: boolean }
/** What a company with no policy (or one that cannot be read) has: design review not allowed. */
export const DESIGN_REVIEW_COMPANY_POLICY_OFF: Readonly<DesignReviewCompanyPolicy> = Object.freeze({ allowed: false });

/** The company item as read: the lock, the policy, and the revision they share. One read answers both. */
export interface DesignReviewCompanyRead {
  lock: DesignReviewLockRead;
  policy: DesignReviewCompanyPolicy;
  /** The stored policy did not parse: it counts as not allowed (fail closed), and the page says so. */
  policyUnreadable: boolean;
  /** The item's revision: 0 when there is no item, undefined when the item has no readable revision. */
  revision: number | undefined;
  /** Who last wrote the item ; undefined when there is no item. */
  updatedBy?: string | undefined;
}

/**
 * Reads the company's lock and policy from the State table beside its other settings, in ONE consistent read. A missing item is no lock and no policy; an item whose `lock` does not parse, that is not an object, or that has
 * no whole-number `revision` (the writer bumps it on every write) has an `unreadable` lock (fail closed). An item with a policy and no `lock` has no lock. A policy that does not parse counts as "not allowed". A failed read
 * is the caller's to handle: it must not be taken for "no lock".
 */
export async function readDesignReviewCompany(table: DesignReviewLockTable, orgId: string, options: { /** What a company with no policy item has. Cloud: not allowed. Code: allowed, because its one company is the owner who switched the stage on. */ allowedWhenAbsent?: boolean } = {}): Promise<DesignReviewCompanyRead> {
  const found = { Item: await table.get({ pk: orgMetaKey(orgId).pk, sk: DESIGN_REVIEW_LOCK_SK }) as Record<string, unknown> | undefined };
  if (found.Item === undefined) return { lock: { kind: "none" }, policy: { allowed: options.allowedWhenAbsent === true }, policyUnreadable: false, revision: 0 };
  const revision = found.Item["revision"];
  const revisionOk = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  const storedPolicy = found.Item["policy"];
  const policyParsed = storedPolicy === undefined ? undefined : DesignReviewCompanyPolicySchema.safeParse(storedPolicy);
  const policy: DesignReviewCompanyPolicy = policyParsed?.success === true
    ? { allowed: policyParsed.data.allowed === true } : { ...DESIGN_REVIEW_COMPANY_POLICY_OFF };
  const storedLock = found.Item["lock"] === undefined && storedPolicy !== undefined ? {} : found.Item["lock"];
  const parsed = parseStoredLock(storedLock);
  return {
    lock: parsed.success && revisionOk ? { kind: "lock", lock: parsed.data, revision } : { kind: "unreadable" },
    policy, policyUnreadable: policyParsed !== undefined && !policyParsed.success, revision: revisionOk ? revision : undefined,
    ...(typeof found.Item["updatedBy"] === "string" ? { updatedBy: found.Item["updatedBy"] } : {}),
  };
}

/** The lock alone (one read). Kept for the writers that rest on it. */
export async function readDesignReviewLock(table: DesignReviewLockTable, orgId: string): Promise<DesignReviewLockRead> {
  return (await readDesignReviewCompany(table, orgId)).lock;
}

const TIER_RANK = Object.fromEntries(DESIGN_REVIEW_TIERS.map((tier, index) => [tier, index])) as Record<DesignReviewSetting["tier"], number>;

export { DESIGN_REVIEW_FAIL_CLOSED_SETTING };

/** A field a write was refused on, named by its path only (never a value). */
export type LockViolation = "designReview.tier" | "designReview.allowSkip" | "designReview.capUsdPerTask" | "designReview.highRiskApprover";

/** The fields of `setting` that are looser than the lock. Empty: the setting holds the lock. */
export function lockViolations(setting: DesignReviewSetting, lock: DesignReviewLock): LockViolation[] {
  const found: LockViolation[] = [];
  if (lock.tierAtLeast !== undefined && TIER_RANK[setting.tier] < TIER_RANK[lock.tierAtLeast]) found.push("designReview.tier");
  if (lock.allowSkip === false && setting.allowSkip) found.push("designReview.allowSkip");
  if (lock.capCeilingUsd !== undefined && setting.capUsdPerTask > lock.capCeilingUsd) found.push("designReview.capUsdPerTask");
  if (lock.approverGroupId !== undefined && !(setting.highRiskApprover.kind === "group" && setting.highRiskApprover.groupId === lock.approverGroupId)) found.push("designReview.highRiskApprover");
  return found;
}

/** The setting made to hold the lock: each locked field moves to the lock's value when it is looser, and never the other way. Pure. */
export function applyLock(setting: DesignReviewSetting, lock: DesignReviewLock): DesignReviewSetting {
  return {
    mode: setting.mode,
    tier: lock.tierAtLeast !== undefined && TIER_RANK[setting.tier] < TIER_RANK[lock.tierAtLeast] ? lock.tierAtLeast : setting.tier,
    allowSkip: lock.allowSkip === false ? false : setting.allowSkip,
    capUsdPerTask: lock.capCeilingUsd !== undefined ? Math.min(setting.capUsdPerTask, lock.capCeilingUsd) : setting.capUsdPerTask,
    highRiskApprover: lock.approverGroupId !== undefined ? { kind: "group", groupId: lock.approverGroupId } : setting.highRiskApprover,
  };
}

/** The fields the lock holds fixed, for the page: a locked field cannot be changed by the project. */
export function lockedFields(lock: DesignReviewLock): LockViolation[] {
  return [
    ...(lock.tierAtLeast === undefined ? [] : ["designReview.tier" as const]),
    ...(lock.allowSkip === undefined ? [] : ["designReview.allowSkip" as const]),
    ...(lock.capCeilingUsd === undefined ? [] : ["designReview.capUsdPerTask" as const]),
    ...(lock.approverGroupId === undefined ? [] : ["designReview.highRiskApprover" as const]),
  ];
}

/**
 * The setting a task runs with: the project's own, or (with none) Off with the owner's defaults, held to the company's lock. The lock never changes the mode. An unreadable lock clamps every field it could hold to the
 * strictest known value (no skipping, the default cap at most, the default tier at least, the maintainers as approver). Pure.
 */
export function effectiveDesignReviewSetting(playbook: { designReview?: DesignReviewSetting | undefined }, lock: DesignReviewLockRead): EffectiveDesignReviewSetting {
  // A project with no setting of its own is Off: only the project's How we work turns it on.
  const own = playbook.designReview ?? { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never" as const, highRiskApprover: { ...DESIGN_REVIEW_DEFAULT_SETTING.highRiskApprover } };
  // An unreadable lock may have set anything, so every field it could hold is clamped (L1), and the maintainers are the approver (a project's own named people could be exactly who the lock was written to replace).
  if (lock.kind === "unreadable") {
    return markEffective({
      ...applyLock(own, { allowSkip: false, tierAtLeast: DESIGN_REVIEW_DEFAULT_SETTING.tier, capCeilingUsd: DESIGN_REVIEW_DEFAULT_SETTING.capUsdPerTask }),
      highRiskApprover: { kind: "maintainers" },
    });
  }
  return markEffective(lock.kind === "lock" ? applyLock(own, lock.lock) : own);
}

/** What the page shows when a lock names a group in an edition without groups (L2). */
export const DESIGN_REVIEW_LOCK_GROUP_EDITION = "group locks need an install with groups";

/**
 * Whether the company may save this lock (L2). A lock that names an approver group is refused in an edition without groups (Public, or an unknown edition): applied there it would leave every high-risk
 * design waiting on `group_not_available` with nobody able to skip it. The lock's writer calls this before it writes.
 */
export function checkDesignReviewLockWrite(lock: DesignReviewLock, groups: boolean): { ok: true } | { ok: false; reason: "group_not_available"; message: string } {
  if (lock.approverGroupId !== undefined && !groups) return { ok: false, reason: "group_not_available", message: DESIGN_REVIEW_LOCK_GROUP_EDITION };
  return { ok: true };
}

export type DesignReviewWriteCheck = { ok: true } | { ok: false; reason: "locked"; fields: LockViolation[] } | { ok: false; reason: "lock_unreadable" } | { ok: false; reason: "group_not_available" };

/**
 * Whether a project may save this setting. Refused when it is looser than the company's lock (the fields are named, never the values), when the lock cannot be read, or when it names a group in an
 * edition without groups (Public). `groups` is whether the install has groups (Code has none: it reads false).
 */
export function checkDesignReviewWrite(setting: DesignReviewSetting, lock: DesignReviewLockRead, groups: boolean): DesignReviewWriteCheck {
  if (setting.highRiskApprover.kind === "group" && !groups) return { ok: false, reason: "group_not_available" };
  if (lock.kind === "unreadable") return { ok: false, reason: "lock_unreadable" };
  if (lock.kind === "lock") {
    const fields = lockViolations(setting, lock.lock);
    if (fields.length > 0) return { ok: false, reason: "locked", fields };
  }
  return { ok: true };
}
