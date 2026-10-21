import { describe, expect, it } from "vitest";
import { slackRefusalMessage } from "../../packages/broker/src/aws/slack-refusals.js";

const OUT_OF_DATE = "That approval is out of date. Use the latest message in this thread.";

// Ruling AU: a refused approval or retry says why, as the API and the page do, instead of "out of date" for every reason the press can meet.
describe("what a Slack press hears when the broker refuses it", () => {
  it.each([
    ["CONFIG_INVALID", "this plan was returned because its E2E source reference failed protected-candidate validation; request changes and submit a corrected plan before approval"],
    ["CONFIG_INVALID", "the corrected plan must retain the required feature E2E intent before approval"],
    ["CONFIG_INVALID", "the approved plan must include the canonical E2E intent required by the pinned project baseline"],
    ["CONFIG_INVALID", "the pinned project revision is unavailable; refresh the plan before approving it"],
    ["CONFIG_INVALID", "the candidate changed after this plan's source reference was rejected; refresh the plan before approval"],
    ["CONFIG_INVALID", "keep at least one check before retrying verification, or close the task"],
    ["CONFIG_INVALID", "keep only checks the approved plan proposed"],
    ["RUNTIME_UNAVAILABLE", "application E2E plans cannot be approved here: the check against the approved setup and the ready runtimes is not installed"],
  ])("says the real reason, as a sentence, for %s: %s", (code, reason) => {
    const said = slackRefusalMessage(code, OUT_OF_DATE, reason);
    expect(said).toBeDefined();
    expect(said).not.toBe(OUT_OF_DATE);
    expect(said!.charAt(0)).toBe(said!.charAt(0).toUpperCase());
    expect(said).toMatch(/[.!?]$/u);
    expect(said!.toLowerCase()).toContain(reason.slice(0, 40).toLowerCase());
  });

  it("still answers a reason it does not know with the out-of-date words, and never says data it was not written for", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "request ID was already used for a different workflow decision")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, `the approved work breakdown is invalid: ${"x".repeat(50)}`)).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("RUNTIME_UNAVAILABLE", OUT_OF_DATE, "EC2 worker returned HTTP 500")).toBeUndefined();
  });

  it("keeps escaping Slack's markup characters in what it says", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "the application E2E plan cannot be approved: <!channel> & more")).toBe("The application E2E plan cannot be approved: &lt;!channel&gt; &amp; more.");
  });
});
