// Design review stage: the setting a task runs with, read in one place. The project's How we work value (the playbook's `designReview`; Off with the owner's defaults when it has none OR when the stored one cannot be read) held to the
// company's lock. Consumers (mode resolution, the cost gate, approval by risk) call this and never read the playbook or the lock themselves. A lock that cannot be read gives the strictest posture; a read that fails is
// the caller's to handle (a task is not started on a guessed setting).
import type { OrgId } from "@agentx/contracts";
import { readProjectPlaybookDetail, type ProjectPlaybookDetail, type ProjectPlaybookReader } from "./playbook-store.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";
import { effectiveDesignReviewSetting, lockedFields, readDesignReviewCompany, type DesignReviewCompanyRead, type LockViolation } from "./lock.js";

export interface EffectiveDesignReview {
  /** Held to the company's lock. The only value mode resolution, the cost gate, approval and skip accept (the type is branded). */
  setting: EffectiveDesignReviewSetting;
  /** The fields the company's lock holds fixed, so the page can show them as locked. */
  locked: LockViolation[];
  lockUnreadable: boolean;
  /** Whether the company allows design review at all . False when the policy is not set or cannot be read, and when the lock cannot be read (the same rule as `readEffectiveWhenAllowed` and the switch). */
  allowed: boolean;
  /** The project's stored setting is there but could not be read. It reads as Off, and the page says so; never Always or Auto. */
  settingUnreadable: boolean;
}

const effectiveOf = (read: ProjectPlaybookDetail, company: DesignReviewCompanyRead): EffectiveDesignReview => ({
  setting: effectiveDesignReviewSetting(read.playbook, company.lock), settingUnreadable: read.designReviewUnreadable,
  locked: company.lock.kind === "lock" ? lockedFields(company.lock.lock) : [], lockUnreadable: company.lock.kind === "unreadable", allowed: company.policy.allowed && company.lock.kind !== "unreadable",
});

export async function readEffectiveDesignReview(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<EffectiveDesignReview> {
  const [playbook, company] = await Promise.all([readProjectPlaybookDetail(deps, orgId, project, { lenient: true }), readDesignReviewCompany(deps, orgId, { allowedWhenAbsent: deps.allowedWhenAbsent === true })]);
  return effectiveOf(playbook, company);
}

/**
 * The same, but the project's playbook is read only when design review is AVAILABLE: `undefined` for a company that has not allowed it, and for one whose lock cannot be read (fail closed to OFF, M2: "strictest" for a lock
 * is a different thing from "on" for spend, and an unreadable item must not turn design review on in every project). Nothing about the project is read then.
 */
export async function readEffectiveWhenAllowed(deps: ProjectPlaybookReader, orgId: OrgId, project: string): Promise<EffectiveDesignReview | undefined> {
  const company = await readDesignReviewCompany(deps, orgId, { allowedWhenAbsent: deps.allowedWhenAbsent === true });
  if (!company.policy.allowed || company.lock.kind === "unreadable") return undefined;
  return effectiveOf(await readProjectPlaybookDetail(deps, orgId, project, { lenient: true }), company);
}
