// TIER-GROWTH-MERGE (from the Sonnet pre-review's probe): the meter must hold the call's REAL worst-case price (the prompt the model is sent) against the task's room.
// A meter that is given only the patch's length (no prompt) prices the widest it could be; one given the prompt prices exactly that. The call itself compares its own worst case to the room before it sends anything.
import { describe, expect, it } from "vitest";
import { grownReviewPrompt } from "../../packages/broker/src/core/build-step/tier-review-calls.js";
import { hostedTierReview } from "../../packages/broker/src/core-host/hosted-tier-review.js";
import { gatewayCallUsd } from "../../packages/broker/src/core-host/gateway-call-price.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { signingWorld } from "../support/model-gateway.js";

const COMPANY = "org_corehost00000000000a";
const MODEL = "claude-sonnet-4-6";
const GATEWAY = "https://gateway.example";
const signer = signingWorld().signer;
const price = { ...runPriceFor(MODEL), companyId: COMPANY };

describe("the tier review meter holds the real worst-case price of the prompt that is sent", () => {
  it("refuses a call whose real prompt does not fit the room, even when the raw patch length alone would", async () => {
    const patchText = "\n".repeat(150_000); // every newline is two bytes once the patch is one JSON value
    const prompt = grownReviewPrompt("code_review", "standard", ["a.ts"], patchText);
    const real = gatewayCallUsd(price, { system: "", user: prompt, maxOutputTokens: 4_096 })!;
    const naive = gatewayCallUsd(price, { system: "", user: "x".repeat(patchText.length), maxOutputTokens: 4_096 })!;
    expect(real, "the real prompt costs more in the worst case than the patch length says").toBeGreaterThan(naive);
    const room = (real + naive) / 2; // fits the naive estimate, not the real prompt
    const task = { pk: "TASK#t1", sk: "TASK", taskId: "t1", companyId: COMPANY, project: "demo", workflow: { stage: "WAIT_FOR_MERGE" } };
    const flow = { store: { get: async () => task, query: async () => ({ items: [] }), put: async () => undefined, delete: async () => undefined }, companyId: COMPANY, admission: { admit: async () => ({ allowed: true }) }, modelAccess: { route: async () => ({ alias: MODEL }) } };
    const fetchStub = (async () => Response.json({ runPrice: { ...price, expiresAt: Date.now() + 300_000 } })) as unknown as typeof fetch;
    const built = hostedTierReview({
      env: { ROVARA_CORE_MODEL_GATEWAY_URL: GATEWAY, ROVARA_CORE_AGENT_MODEL: MODEL }, taskTokens: () => ({ signer, issuer: "https://api.example/v1/auth" }), flow: flow as never, companyId: COMPANY, now: () => new Date(),
      taskRoomUsd: async () => room, booking: { bookUsageReport: async () => true }, fetch: fetchStub,
    })!;
    // What the tier pass hands the meter: the raw patch's length.
    const allowed = await built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: patchText.length });
    expect(allowed, "the meter must refuse: the call it admits could cost more than the task has left").toBe(false);
    // Given the prompt itself it prices exactly that request: the same refusal at this room, and a yes at a room that holds it.
    expect(await built.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: patchText.length, prompt })).toBe(false);
    const roomy = hostedTierReview({
      env: { ROVARA_CORE_MODEL_GATEWAY_URL: GATEWAY, ROVARA_CORE_AGENT_MODEL: MODEL }, taskTokens: () => ({ signer, issuer: "https://api.example/v1/auth" }), flow: flow as never, companyId: COMPANY, now: () => new Date(),
      taskRoomUsd: async () => real * 1.01, booking: { bookUsageReport: async () => true }, fetch: fetchStub,
    })!;
    expect(await roomy.meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: patchText.length, prompt }), "the exact prompt fits a room that holds it").toBe(true);
  });
});
