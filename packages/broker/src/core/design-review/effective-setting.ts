// Design review stage: a design review setting that has been HELD TO THE COMPANY'S LOCK is a different type from one read off a playbook. Mode resolution, the cost gate, approval and
// skip take the first and never the second, so no caller can run a task on a project's stored (possibly looser) value by passing the raw playbook setting. The brand is a hidden symbol set only by
// `markEffective`, which `effectiveDesignReviewSetting` (lock.ts) and nothing else calls; at run time a setting without it is read as the strictest posture, never as itself.
import { DESIGN_REVIEW_DEFAULT_SETTING, type DesignReviewSetting } from "@agentx/contracts";

const EFFECTIVE = Symbol("designReviewEffectiveSetting");

/** A setting held to the company's lock (or the strictest posture, when the lock could not be read). */
export type EffectiveDesignReviewSetting = DesignReviewSetting & { readonly [EFFECTIVE]: true };

/** Brands a setting as effective. Only the code that has applied the lock calls this. The brand is not enumerable, so it never reaches a record, a log or a comparison. */
export function markEffective(setting: DesignReviewSetting): EffectiveDesignReviewSetting {
  const copy: DesignReviewSetting = { ...setting, highRiskApprover: { ...setting.highRiskApprover } };
  Object.defineProperty(copy, EFFECTIVE, { value: true, enumerable: false });
  return copy as EffectiveDesignReviewSetting;
}

export const isEffectiveSetting = (setting: unknown): setting is EffectiveDesignReviewSetting =>
  typeof setting === "object" && setting !== null && (setting as Record<symbol, unknown>)[EFFECTIVE] === true;

/** What a setting that cannot be trusted runs as. Same cap, tier and maintainers as approver as the owner's defaults; mode Off; no skipping. */
export const DESIGN_REVIEW_FAIL_CLOSED_SETTING: Readonly<DesignReviewSetting> = Object.freeze({ ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "never", allowSkip: false, highRiskApprover: Object.freeze({ kind: "maintainers" as const }) });
