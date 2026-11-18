// Engine host (lead 4 L4-P2): WHO IS TOLD when nightly upkeep pauses (the admins' notice, core/notify/attention.ts `queueUpkeepPaused`, and the delivery's live "do they still administer this project" read). The people are the
// project's administrators and the company's owners and admins, and nobody else, read from the install's own records and re-checked LIVE for this company:
//   - a company owner or admin counts only while their membership is live, in THIS company, with that role now;
//   - a project administrator counts only while their membership is live in THIS company AND their grant on THIS project is still `administrator`;
//   - the lists are bounded, a person id that is not a 64-hex person id is dropped, and a source that cannot be read THROWS (the notice then gives its marker back and a later night tries again).
// A company is bound at creation: a call for another company answers nobody (never another company's admins).
import type { OrgId, OrgRole } from "@agentx/contracts";

/** The most people one notice names (the attention queue's own cap is the same order). */
export const UPKEEP_RECIPIENTS_MAX = 50;
const PERSON_ID = /^[a-f0-9]{64}$/u;

export interface UpkeepRecipientSources {
  /** The company's members with a role of owner or admin, as the install lists them (any page size; bounded by the source). Throws when it cannot be read. */
  companyAdmins(companyId: OrgId): Promise<readonly string[]>;
  /** The project's administrators as the project's own member list says. Throws when it cannot be read. */
  projectAdmins(project: string): Promise<readonly string[]>;
  /** A person's LIVE membership. Undefined: none or revoked. Throws when it cannot be read. */
  membershipOf(personId: string): Promise<{ companyId: OrgId; role: OrgRole } | undefined>;
  /** A person's LIVE grant on a project. */
  projectGrantRole(personId: string, project: string): Promise<"developer" | "administrator" | undefined>;
}

const isCompanyAdminRole = (role: OrgRole): boolean => role === "owner" || role === "admin";

/** Whether the person administers the project NOW in this company: a live owner or admin, or a live project administrator. Never throws (a read that fails is "no"). */
export function createUpkeepAdministers(companyId: OrgId, sources: Pick<UpkeepRecipientSources, "membershipOf" | "projectGrantRole">): (orgId: OrgId, personId: string, project: string) => Promise<boolean> {
  return async (orgId, personId, project) => {
    if (orgId !== companyId || !PERSON_ID.test(personId)) return false;
    try {
      const membership = await sources.membershipOf(personId);
      if (membership === undefined || membership.companyId !== companyId) return false;
      if (isCompanyAdminRole(membership.role)) return true;
      return (await sources.projectGrantRole(personId, project)) === "administrator";
    } catch {
      return false;
    }
  };
}

/** The recipients reader for ONE company (`UpkeepPauseHooksDeps.recipients`). */
export function createUpkeepRecipients(companyId: OrgId, sources: UpkeepRecipientSources): (orgId: OrgId, project: string) => Promise<readonly string[]> {
  const administers = createUpkeepAdministers(companyId, sources);
  return async (orgId, project) => {
    if (orgId !== companyId) return [];
    const candidates = [...new Set([...(await sources.companyAdmins(companyId)), ...(await sources.projectAdmins(project))])].filter((id) => PERSON_ID.test(id));
    const told: string[] = [];
    for (const personId of candidates) {
      if (told.length >= UPKEEP_RECIPIENTS_MAX) break;
      if (await administers(orgId, personId, project)) told.push(personId);
    }
    return told;
  };
}
