// The approver directory of one person on one machine. The person who runs `rovara up` is the only owner and the only person who may approve: they are the owner, the one eligible approver, and (so a lesson
// that needs a second person can still go live) the sole-owner exception applies to them, with no loss of eligible people to wait out. An install with more people gives its own directory from its
// identity and approvers points; the library asks the same questions of either.
import type { ApproverDirectory } from "./ports.js";
import type { IdentitySet } from "./types.js";
import type { Tier0Authority } from "./sole-owner-switch.js";

export interface LocalDirectoryInput {
  /** The owner's id as lessons record it (the identity point's person id). */
  ownerId: string;
  /** The outside accounts the owner linked (the code host's account ids), for the checks on restricted places. May throw: the identity is then empty. */
  linkedAccounts?: (developerId: string) => Promise<readonly string[]>;
}

const roster = (ownerId: string) => ({ complete: true, membershipVersion: 0, ownerIds: [ownerId], eligibleIds: [ownerId], lastEligibleLossAtMs: null as number | null });

export function createLocalApproverDirectory(input: LocalDirectoryInput): ApproverDirectory {
  return {
    async eligibility() { return roster(input.ownerId); },
    async identity(_workspaceId, developerId): Promise<IdentitySet> {
      try { return { principals: [...(await input.linkedAccounts?.(developerId) ?? [])], groups: [], developerId }; } catch { return { principals: [], groups: [], developerId }; }
    },
  };
}

/** The authority for the tier-0 setting and the sole-owner switch: the one owner, eligible, with no one lost. */
export function createLocalTier0Authority(ownerId: string): Tier0Authority {
  return { async eligibility() { return roster(ownerId); } };
}
