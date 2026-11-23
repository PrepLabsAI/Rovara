import { describe, expect, it } from "vitest";
import { planningContextUnavailableMessage } from "../support/planning-context-error.js";

describe("journey failure for a core without application planning context", () => {
  it("keeps the leading text and includes the reason of an unknown context", () => {
    const message = planningContextUnavailableMessage({ status: "unknown", reason: "the task's pinned project revision is unavailable" });
    expect(message).toMatch(/^core did not offer application planning context/u);
    expect(message).toContain("unknown");
    expect(message).toContain("the task's pinned project revision is unavailable");
  });
  it("says so when no reason is given or no context exists", () => {
    expect(planningContextUnavailableMessage(undefined)).toBe("core did not offer application planning context: absent (no reason given)");
    expect(planningContextUnavailableMessage({ status: "unknown" })).toContain("(no reason given)");
  });
});
