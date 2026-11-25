// TIER-GROWTH-MERGE: the hosted wiring of the grown tier's reviews (core-host/hosted-tier-review.ts), where it can be told without a whole task: it is built only where this install can mint task tokens and has a gateway,
// and a model call is refused (nothing sent) outside the tier pass's task scope. The whole path (the token's claims, the meter and cap, the booking, the merge) is in tests/journeys/tier-growth.test.ts, through the hosted root.
import { describe, expect, it, vi } from "vitest";
import { tierReviewTask } from "../../packages/broker/src/core/build-step/tier-review-calls.js";
import { hostedTierReview, TIER_REVIEW_CALL_FAILED } from "../../packages/broker/src/core-host/hosted-tier-review.js";
import { signingWorld } from "../support/model-gateway.js";

const COMPANY = "org_corehost00000000000a" as never;
const ENV = { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-6" };
const signer = signingWorld().signer;
const options = (extra: Record<string, unknown> = {}) => ({
  env: ENV, taskTokens: () => ({ signer, issuer: "https://api.example/v1/auth" }), flow: {} as never, companyId: COMPANY, now: () => new Date(), taskRoomUsd: async () => 5, booking: { bookUsageReport: async () => true }, ...extra,
});

describe("hostedTierReview", () => {
  it("is built only for an install with a gateway and a task-token key", () => {
    expect(hostedTierReview(options())).toBeDefined();
    expect(hostedTierReview(options({ env: {} }))).toBeUndefined();
    expect(hostedTierReview(options({ env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example" } }))).toBeUndefined();
    expect(hostedTierReview(options({ taskTokens: undefined }))).toBeUndefined();
    expect(hostedTierReview(options({ taskTokens: () => undefined }))).toBeUndefined();
    expect(hostedTierReview(options({ taskTokens: () => { throw new Error("no key"); } }))).toBeUndefined();
  });

  it("makes no call outside the tier pass's task scope: it names no task, so nothing is minted or sent", async () => {
    const fetchSpy = vi.fn();
    const built = hostedTierReview(options({ fetch: fetchSpy }))!;
    await expect(built.call({ model: undefined, prompt: "p", purpose: "code_review", signal: new AbortController().signal })).rejects.toThrow(TIER_REVIEW_CALL_FAILED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the meter for a task it cannot read (fail closed, and not as the spending limit: it could not be told)", async () => {
    const built = hostedTierReview(options({ flow: { store: { get: async () => { throw new Error("down"); }, query: async () => ({ items: [] }) }, companyId: COMPANY } }))!;
    await expect(built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 100 })).resolves.toBe("unavailable");
    await tierReviewTask.run({ taskId: "t1" }, async () => {
      await expect(built.call({ model: undefined, prompt: "p", purpose: "code_review", signal: new AbortController().signal })).rejects.toThrow();
    });
  });
});
