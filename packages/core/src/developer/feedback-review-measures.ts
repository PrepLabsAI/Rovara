/** Privacy-safe aggregate feedback-review measurements. Values never contain task or reviewer data. */
export type FeedbackReviewMeasureName =
  | "feedback_notice_to_decision_under_1m"
  | "feedback_notice_to_decision_1m_to_1h"
  | "feedback_notice_to_decision_over_1h"
  | "feedback_recommendation_followed"
  | "feedback_recommendation_changed"
  | "feedback_reopened";

export interface FeedbackReviewMeasure {
  event: "feedback_review.measure";
  measure: FeedbackReviewMeasureName;
  count: 1;
  at: string;
}

const event = (measure: FeedbackReviewMeasureName, at: string): FeedbackReviewMeasure | undefined => {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return undefined;
  return { event: "feedback_review.measure", measure, count: 1, at: new Date(timestamp).toISOString() };
};

export function feedbackNoticeToDecisionMeasure(noticeAt: string, decisionAt: string): FeedbackReviewMeasure | undefined {
  const notice = Date.parse(noticeAt);
  const decision = Date.parse(decisionAt);
  if (!Number.isFinite(notice) || !Number.isFinite(decision) || decision < notice) return undefined;
  const elapsed = decision - notice;
  const bucket = elapsed < 60_000 ? "under_1m" : elapsed <= 3_600_000 ? "1m_to_1h" : "over_1h";
  return event(`feedback_notice_to_decision_${bucket}`, decisionAt);
}

export function feedbackRecommendationMeasure(
  recommendedFindingIds: readonly string[],
  selectedFindingIds: readonly string[],
  decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS",
  at: string,
): FeedbackReviewMeasure | undefined {
  if (recommendedFindingIds.length === 0) return undefined;
  const sameSet = decision === "APPROVE" && new Set(recommendedFindingIds).size === new Set(selectedFindingIds).size
    && recommendedFindingIds.every(id => selectedFindingIds.includes(id));
  return event(sameSet ? "feedback_recommendation_followed" : "feedback_recommendation_changed", at);
}

export function feedbackReopenedMeasure(at: string): FeedbackReviewMeasure | undefined {
  return event("feedback_reopened", at);
}
