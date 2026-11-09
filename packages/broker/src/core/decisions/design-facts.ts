// Vendored from the hosted product's design-review risk module (a pure leaf: codes and counts in, a tier out). The design-review lane (L9) may move it; keep the two identical until then.
// Design review stage (DR9, design-review-stage.md 3.8): which design areas set the tier of an `approve_design` card, and the facts a card shows. PURE and fixed-word: a tier is worked out from codes and
// counts the broker holds, never from a model's sentences, and every rule only RAISES (a design that says "small change" but names the data model in `touches` is still high; leaving an area out lowers nothing).
//
// The codes that make a design HIGH are the DR1 contract's one list (`DESIGN_REVIEW_HIGH_RISK_REASONS`, which includes `infrastructure` per 3.8), shared with DR2's skip rule.
import { DESIGN_REVIEW_HIGH_RISK_REASONS, type DesignReason } from "@agentx/contracts";

/** Areas that make a design high risk: it needs the configured high-risk approver, a fresh sign-in, and the requester may not approve it (unless the sole owner). */
export const DESIGN_TIER_HIGH_CODES: readonly DesignReason[] = DESIGN_REVIEW_HIGH_RISK_REASONS;
/** Areas that make a design at least medium: the approver opens the evidence first. */
export const DESIGN_TIER_MEDIUM_CODES: readonly DesignReason[] = ["new_api", "api_change", "new_dependency"];

/** Fixed words for each area, used in the card's risk reasons. */
export const DESIGN_AREA_WORDS: Readonly<Record<DesignReason, string>> = {
  new_api: "adds a new API", api_change: "changes an existing API", data_model: "changes the data model", cross_repo_or_service: "works across repositories or other services",
  new_dependency: "adds a new dependency", auth: "changes who can do what (auth)", money: "touches money", pii: "touches personal data", infrastructure: "changes infrastructure",
  small_change: "is a small change", bug_fix: "is a bug fix",
};

export const isHighRiskCodes = (codes: readonly DesignReason[]): boolean => codes.some((code) => DESIGN_TIER_HIGH_CODES.includes(code));

/** What an `approve_design` card shows and what its tier reads. Every field is a code, a count or a short line; the lines are model words and are shown through `plainLine`. */
export interface DesignCardFacts {
  /** Understand's reasons (model words, fixed codes). They can only raise the tier. */
  reasons: readonly DesignReason[];
  /** The design's own §6 `touches[]` codes. They can only raise the tier. */
  touches: readonly DesignReason[];
  /** `planned`: reviewers the tier meant to run; `verified`: those whose input was verified and whose findings counted. Planned 0 means the review did not run at all. */
  reviewers: { planned: number; verified: number };
  /** Blockers no settled resolution closed. Approving with any needs a one-line reason (Q8). */
  blockers: ReadonlyArray<{ section: string; text: string; /** Rests on source items alone (3.12 item 5): still open, shown as "source-only". */ sourceOnly?: true }>;
  majors: number;
  /** The contract's `designReviewDisagreements` (the one definition): where the reviewers and the planner differ, or a blocker or major nobody closed. */
  disagreements: ReadonlyArray<{ section: string; text: string; kind?: "contested" | "unresolved" | "unchecked_fix" | "oscillation" }>;
  costUsd?: number | undefined;
}

/** How the review went, from the counts: `all` reviewers verified, `partial`, or `none` (it did not run). */
export function reviewCoverage(reviewers: DesignCardFacts["reviewers"]): "all" | "partial" | "none" {
  if (reviewers.planned <= 0 || reviewers.verified <= 0) return "none";
  return reviewers.verified >= reviewers.planned ? "all" : "partial";
}
