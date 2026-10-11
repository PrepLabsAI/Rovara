import { describe, expect, it } from "vitest";
import {
  feedbackNoticeToDecisionMeasure,
  feedbackRecommendationMeasure,
  feedbackReopenedMeasure,
} from "../../packages/broker/src/developer/feedback-review-measures.js";

describe("privacy-safe feedback review measures", () => {
  it("records notice-to-decision time as a coarse aggregate event name and timestamp", () => {
    const measure = feedbackNoticeToDecisionMeasure("2026-10-05T11:58:00.000Z", "2026-10-05T12:00:00.000Z");
    expect(measure).toEqual({ event: "feedback_review.measure", measure: "feedback_notice_to_decision_1m_to_1h", count: 1, at: "2026-10-05T12:00:00.000Z" });
    expect(Object.keys(measure ?? {}).sort()).toEqual(["at", "count", "event", "measure"]);
    expect(feedbackNoticeToDecisionMeasure("invalid", "2026-10-05T12:00:00.000Z")).toBeUndefined();
  });

  it("counts whether the owner accepted or changed recommendations without storing finding IDs", () => {
    const changed = feedbackRecommendationMeasure(["f1", "f2"], ["f1"], "APPROVE", "2026-10-05T12:00:00.000Z");
    expect(changed).toMatchObject({ event: "feedback_review.measure", measure: "feedback_recommendation_changed", count: 1 });
    expect(JSON.stringify(changed)).not.toContain("f1");
    expect(feedbackRecommendationMeasure(["f1"], ["f1"], "APPROVE", "2026-10-05T12:00:00.000Z")?.measure).toBe("feedback_recommendation_followed");
    expect(feedbackRecommendationMeasure(["f1"], ["f1"], "REQUEST_CHANGES", "2026-10-05T12:00:00.000Z")?.measure).toBe("feedback_recommendation_changed");
    expect(feedbackRecommendationMeasure([], [], "REQUEST_CHANGES", "2026-10-05T12:00:00.000Z")).toBeUndefined();
  });

  it("counts reopened feedback using only an aggregate name, count, and timestamp", () => {
    const measure = feedbackReopenedMeasure("2026-10-05T12:00:00.000Z");
    expect(measure).toEqual({ event: "feedback_review.measure", measure: "feedback_reopened", count: 1, at: "2026-10-05T12:00:00.000Z" });
    expect(Object.keys(measure ?? {}).sort()).toEqual(["at", "count", "event", "measure"]);
  });
});
