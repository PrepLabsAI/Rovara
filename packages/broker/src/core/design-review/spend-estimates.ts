// Design review stage (money W2/W4): the cost gate's inputs for the SPEND card, rebuilt from the review's own record, for the person looking at the card. The hold stored the estimate it stopped on
// (`estimateUsd`; none means "cost unavailable"). The lower tier's estimate is not stored, so it is worked out again with the SAME function the round start uses: the packet size the hold was worked out for is found
// from the stored estimate (the estimate only goes up with the packet), and the next lower tier is priced at that size with the same models. Nothing is guessed: a model without a price, or an estimate that cannot be
// matched, leaves the lower tier out, and the round start gates again when it runs anyway.
import { DESIGN_REVIEW_ROUNDS_MAX, type ModelIdentifier, type WorkflowDesignReview } from "@agentx/contracts";
import { TIER_REVIEWERS, estimateDesignReviewUsd, nextLowerTier, type DesignReviewEstimate, type PriceLookup } from "./estimate.js";
import type { DesignReviewTier } from "@agentx/contracts";

export interface SpendEstimates { estimate: DesignReviewEstimate; lowerTier?: { tier: DesignReviewTier; estimate: DesignReviewEstimate } | undefined }

const PACKET_TOKENS_MAX = 5_000_000;

/** The estimate the review held on, and the next lower tier's at the same packet size. */
export function spendEstimatesOf(input: { review: Pick<WorkflowDesignReview, "tier" | "estimateUsd" | "rounds">; reviewerModel: ModelIdentifier | undefined; plannerModel: ModelIdentifier | undefined; price: PriceLookup; /** The reviewers run on Rovara's own route (the same flag the round start passes); absent: not known, so no cache discount. */ reviewerCaches?: boolean | undefined }): SpendEstimates {
  const { review } = input;
  const rounds = (DESIGN_REVIEW_ROUNDS_MAX - review.rounds.length) as 1 | 2;
  if (review.estimateUsd === undefined) return { estimate: { kind: "unavailable", tier: review.tier, missing: [] } };
  const stored: DesignReviewEstimate = { kind: "priced", usd: review.estimateUsd, breakdown: { reviewersUsd: 0, mergeUsd: 0, plannerUsd: 0 }, tier: review.tier, reviewers: TIER_REVIEWERS[review.tier].length, rounds };
  const lower = nextLowerTier(review.tier);
  if (lower === undefined || input.reviewerModel === undefined) return { estimate: stored };
  const models = { reviewer: input.reviewerModel, merge: input.reviewerModel, planner: input.plannerModel ?? input.reviewerModel };
  const at = (tier: DesignReviewTier, packetTokens: number): DesignReviewEstimate => estimateDesignReviewUsd({ tier, models, price: input.price, packetTokens, rounds, reviewerCaches: input.reviewerCaches });
  const priced = (value: DesignReviewEstimate): number | undefined => (value.kind === "priced" ? value.usd : undefined);
  // The estimate rises with the packet: find the size whose estimate is the stored one (to a cent).
  let low = 1, high = PACKET_TOKENS_MAX;
  const top = priced(at(review.tier, high));
  if (top === undefined || top < review.estimateUsd) return { estimate: stored };
  for (let step = 0; step < 40 && high - low > 1; step += 1) {
    const middle = Math.floor((low + high) / 2);
    const value = priced(at(review.tier, middle));
    if (value === undefined) return { estimate: stored };
    if (value < review.estimateUsd) low = middle; else high = middle;
  }
  const found = priced(at(review.tier, high));
  if (found === undefined || Math.abs(found - review.estimateUsd) > 0.01) return { estimate: stored };
  return { estimate: stored, lowerTier: { tier: lower, estimate: at(lower, high) } };
}
