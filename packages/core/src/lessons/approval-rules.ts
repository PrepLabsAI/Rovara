// Approval by risk, for lessons: the pure rules that decide HOW MANY people must approve a lesson and whether a second person's approval counts. Code asks them of the one person on the machine,
// so the second person of a tier-2 lesson is, for a company of one, the sole-owner exception (the owner approves, and the approval is recorded as the exception). Who the people ARE comes from the
// approver directory (`ApproverDirectory`), whose Code adapter reads the `approvers` and `identity` points; a hosted install gives its own roster, and these rules are the same.
//
// The shape of the rule: code decides the tier (a model's words can only raise it), a higher tier needs more or other people, and the person who wrote a lesson is not the second person, except
// through the sole-owner exception, which has its own cool-off after a loss of eligible people.

/** How many people a level needs: `auto` goes live by itself (only where a consumer allows it), `one`, `two`. */
export type ApprovalLevel = "auto" | "one" | "two";
/** An approval policy by tier: tier 0 and tier 1 as configured, tier 2 always two people (it has no setting). */
export interface ApprovalLevels { tier0: ApprovalLevel; tier1: "one" | "two" }

/** How many approvers a tier needs under a policy. Tier 2 can never go below two people. */
export function approversRequired(tier: 0 | 1 | 2, policy: ApprovalLevels): 0 | 1 | 2 {
  if (tier === 2) return 2;
  const level = tier === 0 ? policy.tier0 : policy.tier1;
  return level === "auto" ? 0 : level === "one" ? 1 : 2;
}

/** What a directory knows about who may approve, read fresh and complete. The same shape as the lessons' `ApproverDirectory.eligibility`. */
export interface ApprovalEligibility {
  complete: boolean;
  membershipVersion: number;
  ownerIds: readonly string[];
  eligibleIds: readonly string[];
  lastEligibleLossAtMs: number | null;
}

export type SecondPersonRefusal = "sole_owner_cool_off" | "second_person_required" | "eligibility_unavailable";
export type SecondPersonOutcome =
  | { ok: true; mode: "second_person" | "sole_owner_exception" }
  | { ok: false; code: SecondPersonRefusal; /** The time the cool-off opens (ISO). */ availableAt?: string };

const COOL_OFF_MS = 86_400_000;

/**
 * Whether the approver may stand as the second person for the proposer. Fails closed: an incomplete, malformed or contradictory answer of the directory is a refusal. Two different eligible
 * people are a second person; the same person is the sole-owner exception only when they are the one owner and the one eligible person, and no eligible person was lost in the last day.
 */
export function secondPersonOutcome(group: ApprovalEligibility, proposerId: string, approverId: string, nowMs: number): SecondPersonOutcome {
  const { eligibleIds, ownerIds, membershipVersion } = group;
  if (!group.complete || !Number.isSafeInteger(membershipVersion) || membershipVersion < 0 || !Number.isFinite(nowMs) || nowMs < 0
    || eligibleIds.some((id) => id.length === 0) || ownerIds.some((id) => id.length === 0)
    || new Set(eligibleIds).size !== eligibleIds.length || new Set(ownerIds).size !== ownerIds.length
    || !eligibleIds.includes(proposerId) || !eligibleIds.includes(approverId)) return { ok: false, code: "eligibility_unavailable" };
  if (proposerId !== approverId) return { ok: true, mode: "second_person" };
  if (ownerIds.length !== 1 || ownerIds[0] !== proposerId || eligibleIds.length !== 1) return { ok: false, code: "second_person_required" };
  const loss = group.lastEligibleLossAtMs;
  if (loss !== null && (!Number.isFinite(loss) || loss < 0 || loss > nowMs)) return { ok: false, code: "eligibility_unavailable" };
  if (loss !== null && nowMs - loss < COOL_OFF_MS) return { ok: false, code: "sole_owner_cool_off", availableAt: new Date(loss + COOL_OFF_MS).toISOString() };
  return { ok: true, mode: "sole_owner_exception" };
}
