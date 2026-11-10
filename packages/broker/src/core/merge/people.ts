// Port lane L7a: who a person is on the code host, and whether their approval counts. Cloud answers from the org's members (a GitHub account linked to each member, a role that is not
// an Auditor's). Code runs as one implicit company with one owner: no member is linked to a reviewer's account, so the default answers "nobody" and a project's code settings default to
// self-approval on (the owner approves with their own session, or a repository collaborator by comment; decision 45.3). A second reader, such as Cloud's members, plugs in here.
//
// Lane P3 (item I1, decision 60): these lookups are the identity port's abilities, `accountsOf` (a person's outside accounts) and `resolveExternalAccount` (the person of an outside account). `createIdentityMergePeople`
// builds `MergePeople` from any identity adapter, so a plug-in implements the identity port once and the merge code needs no seam of its own. The interface stays as the shape the merge code reads.
import { isKnownOrgRole, type IdentityProvider, type OrgId, type Principal } from "@agentx/contracts";
import { requesterIds } from "./approval.js";
import type { MergeTask } from "./seams.js";

export interface MergePeople {
  /** The code-host account ids of the people who asked for the task, or "unlinked" when any of them has none (their approval cannot be told from a reviewer's). */
  requestersOf(orgId: OrgId, task: MergeTask): Promise<string[] | "unlinked">;
  /** Which of these code-host accounts are linked to a person who is in the company now and may approve. */
  linkedAmong(orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>>;
  /** Which of these code-host accounts are linked to a person who is in the company but may not approve (the Auditor): their approval counts for nothing. */
  nonWritersAmong(orgId: OrgId, hostUserIds: readonly string[]): Promise<Set<string>>;
  /** The code-host account a person (who presses Merge) linked, or undefined. */
  hostAccountOf(orgId: OrgId, personId: string): Promise<string | undefined>;
  /**
   * EVERY code-host account a person linked, when a person may link several (lane P3, review M1). The merge code excludes all of them from the "someone else approved" count, so a person cannot approve with a second account.
   * Absent: `hostAccountOf` is the person's only account.
   */
  hostAccountsOf?(orgId: OrgId, personId: string): Promise<string[]>;
}

/** Code's default: one owner, no linked accounts, nobody excluded. */
export const soleOwnerPeople: MergePeople = {
  requestersOf: async () => "unlinked",
  linkedAmong: async () => new Set(),
  nonWritersAmong: async () => new Set(),
  hostAccountOf: async () => undefined,
};

export interface IdentityMergePeopleOptions {
  /** The provider id the code host's accounts carry in the identity port (`ExternalAccountRef.provider`). */
  hostProvider: string;
  /** The code host's workspace or organisation id for those accounts; default none. */
  hostTenant?: string;
  /** Whether a person of the company may approve. Default: holds a role the core knows (an unknown role, such as an auditor's, may not). */
  mayApprove?: (person: Principal) => boolean;
}

/** `MergePeople` over an identity adapter: nothing is linked when the adapter cannot say (no `accountsOf`), which is `soleOwnerPeople`'s answer. */
export function createIdentityMergePeople(identity: IdentityProvider, options: IdentityMergePeopleOptions): MergePeople {
  const tenant = options.hostTenant ?? "";
  const mayApprove = options.mayApprove ?? ((person: Principal) => person.roles.some((role) => isKnownOrgRole(role)));
  const hostAccountsOf = async (orgId: OrgId, personId: string): Promise<string[]> => {
    const accounts = (await identity.accountsOf?.(orgId, personId)) ?? [];
    return [...new Set(accounts.filter((account) => account.provider === options.hostProvider && account.tenant === tenant).map((account) => account.accountId))];
  };
  const peopleOf = async (orgId: OrgId, hostUserIds: readonly string[]): Promise<Array<{ hostUserId: string; person: Principal }>> => {
    const found: Array<{ hostUserId: string; person: Principal }> = [];
    for (const hostUserId of hostUserIds) {
      const person = await identity.resolveExternalAccount(orgId, { provider: options.hostProvider, tenant, accountId: hostUserId });
      if (person !== undefined && person.companyId === orgId) found.push({ hostUserId, person });
    }
    return found;
  };
  return {
    async requestersOf(orgId, task) {
      const accounts: string[] = [];
      for (const personId of requesterIds(task)) {
        const own = await hostAccountsOf(orgId, personId);
        if (own.length === 0) return "unlinked";
        accounts.push(...own);
      }
      return accounts.length === 0 ? "unlinked" : [...new Set(accounts)];
    },
    async linkedAmong(orgId, hostUserIds) {
      return new Set((await peopleOf(orgId, hostUserIds)).filter((entry) => mayApprove(entry.person)).map((entry) => entry.hostUserId));
    },
    async nonWritersAmong(orgId, hostUserIds) {
      return new Set((await peopleOf(orgId, hostUserIds)).filter((entry) => !mayApprove(entry.person)).map((entry) => entry.hostUserId));
    },
    hostAccountOf: async (orgId, personId) => (await hostAccountsOf(orgId, personId))[0],
    hostAccountsOf,
  };
}
