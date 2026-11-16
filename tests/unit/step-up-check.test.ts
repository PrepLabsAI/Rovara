// Lane W: the old broker's step-up check is lane ID's contract (#660 claims, #662 route check). These pin the shared behaviour so the swap to their functions is a no-op.
import { describe, expect, it } from "vitest";
import { FRESH_SIGN_IN_SECONDS } from "@agentx/contracts";
import { requireFreshStepUp, stepUpOfClaims } from "../../packages/broker/src/aws/step-up-check.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const at = (ageSeconds: number) => new Date(NOW - ageSeconds * 1000).toISOString();
const refusal = "confirm it's you";
const refused = (run: () => unknown) => expect(run).toThrow(expect.objectContaining({ code: "REAUTH_REQUIRED", message: `REAUTH_REQUIRED: ${refusal}` }));

describe("the step-up a verified token carries", () => {
  it("reads whole seconds and one of Code's own factors", () => {
    expect(stepUpOfClaims({ step_up_at: NOW / 1000, step_up_amr: "email_code" })).toEqual({ at: new Date(NOW).toISOString(), method: "email_code" });
    expect(stepUpOfClaims({ step_up_at: NOW / 1000, step_up_amr: "passkey" })?.method).toBe("passkey");
    expect(stepUpOfClaims({ step_up_at: NOW / 1000, step_up_amr: "company_reauth" })?.method).toBe("company_reauth");
  });
  it.each([
    [{}], [{ step_up_at: NOW / 1000 }], [{ step_up_amr: "email_code" }], [{ step_up_at: NOW / 1000 + 0.5, step_up_amr: "email_code" }], [{ step_up_at: "1763208000", step_up_amr: "email_code" }],
    [{ step_up_at: 0, step_up_amr: "email_code" }], [{ step_up_at: 9e12, step_up_amr: "email_code" }], [{ step_up_at: NOW / 1000, step_up_amr: "slack" }], [{ step_up_at: NOW / 1000, step_up_amr: "oidc" }],
    [{ step_up_at: NOW / 1000, step_up_amr: ["email_code"] }],
  ])("reads nothing from %j", (claims) => expect(stepUpOfClaims(claims)).toBeUndefined());
});

describe("a fresh step-up on the route", () => {
  it("accepts one inside the window and a little clock skew", () => {
    expect(requireFreshStepUp({ at: at(FRESH_SIGN_IN_SECONDS), method: "email_code" }, NOW, refusal)).toEqual({ at: at(FRESH_SIGN_IN_SECONDS), method: "email_code" });
    expect(requireFreshStepUp({ at: at(-100), method: "passkey" }, NOW, refusal).method).toBe("passkey");
  });
  it("refuses a missing, stale, future, malformed or foreign-factor step-up", () => {
    refused(() => requireFreshStepUp(undefined, NOW, refusal));
    refused(() => requireFreshStepUp({ at: at(FRESH_SIGN_IN_SECONDS + 1), method: "email_code" }, NOW, refusal));
    refused(() => requireFreshStepUp({ at: at(-121), method: "email_code" }, NOW, refusal));
    refused(() => requireFreshStepUp({ at: "2026-11-15T11:59:00Z", method: "email_code" }, NOW, refusal));
    refused(() => requireFreshStepUp({ at: at(5), method: "slack" as never }, NOW, refusal));
    refused(() => requireFreshStepUp(null as never, NOW, refusal));
  });
  it("lets a company window only shorten the default; a window that does not read refuses", () => {
    refused(() => requireFreshStepUp({ at: at(61), method: "email_code" }, NOW, refusal, 60));
    expect(requireFreshStepUp({ at: at(59), method: "email_code" }, NOW, refusal, 60).method).toBe("email_code");
    refused(() => requireFreshStepUp({ at: at(FRESH_SIGN_IN_SECONDS + 1), method: "email_code" }, NOW, refusal, 86_400));
    refused(() => requireFreshStepUp({ at: at(1), method: "email_code" }, NOW, refusal, 0));
    refused(() => requireFreshStepUp({ at: at(0), method: "email_code" }, NOW, refusal, 0));
    for (const window of [-1, 1.5, "600", undefined as unknown as number, 86_401]) {
      if (window === undefined) continue;
      refused(() => requireFreshStepUp({ at: at(1), method: "email_code" }, NOW, refusal, window));
    }
    // Skew never longer than a short window.
    refused(() => requireFreshStepUp({ at: at(-31), method: "email_code" }, NOW, refusal, 30));
  });
});
