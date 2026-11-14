import type { PolicyValues } from "./policy.js";

/** Data only. Settings §3.3, corrected by testing plan §8.1: Careful offers, never opens a revert.
 * No preset is applied to an existing project without a row. Balanced is the new-project picker default.
 * Readiness-derived budgets are absent until measured; failure attempts are NOT the CI-fix round count.
 * Unmodelled settings (approvals, learning, accounts, evidence) belong to their later lanes.
 */
export const POLICY_PRESETS = Object.freeze({
  lightweight: Object.freeze({ preset_level: "lightweight", real_check: "their_ci_watch", ci_fix_rounds: 3, round_time_minutes: 30, model_budget_usd: null, machine_budget_minutes: null, extra_review: true, after_merge_revert: "report_only", mutation_spot_check: "off", prompt_side_by_side: "off" } satisfies PolicyValues),
  balanced: Object.freeze({ preset_level: "balanced", real_check: "their_ci_fix", ci_fix_rounds: 3, round_time_minutes: 30, model_budget_usd: null, machine_budget_minutes: null, extra_review: true, after_merge_revert: "offer_revert", mutation_spot_check: "off", prompt_side_by_side: "off" } satisfies PolicyValues),
  careful: Object.freeze({ preset_level: "careful", real_check: "rovara_real_run", ci_fix_rounds: 3, round_time_minutes: 30, model_budget_usd: null, machine_budget_minutes: null, extra_review: true, after_merge_revert: "offer_revert", mutation_spot_check: "on", prompt_side_by_side: "on" } satisfies PolicyValues),
});
export const DEFAULT_POLICY_PRESET = "balanced";
