import { describe, expect, it } from "vitest";
import { slackRefusalMessage } from "../../packages/broker/src/aws/slack-refusals.js";

const OUT_OF_DATE = "That approval is out of date. Use the latest message in this thread.";

// Ruling AU: a refused approval or retry says why, as the API and the page do, instead of "out of date" for every reason the press can meet.
describe("what a Slack press hears when the broker refuses it", () => {

  it("still answers a reason it does not know with the out-of-date words, and never says data it was not written for", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "request ID was already used for a different workflow decision")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, `the approved work breakdown is invalid: ${"x".repeat(50)}`)).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("RUNTIME_UNAVAILABLE", OUT_OF_DATE, "EC2 worker returned HTTP 500")).toBeUndefined();
  });

  it("keeps escaping Slack's markup characters in what it says", () => {
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "the application E2E plan cannot be approved: <!channel> & more")).toBe("The application E2E plan cannot be approved: &lt;!channel&gt; &amp; more.");
  });
});

// M1.3 Task 3.7 (Ruling AU): the two refusals M1.3 introduces are said as plain sentences too, and only their opening words are said: what follows is data (account and
// application names, dates) and never reaches Slack.
describe("what a Slack press hears when the test accounts or an outside service's mock changed", () => {
  const ACCOUNTS = "The test accounts changed since this plan was approved. Retry the checks to approve the plan again with the accounts that are registered now.";

  it.each([
    ["CONFIG_INVALID", "accounts-changed-reapprove: account profile orders-viewer of application demo expires at 2026-12-01T00:00:00.000Z, before this round can finish", ACCOUNTS],
  ])("says the sentence for %s: %s", (code, reason, sentence) => {
    expect(slackRefusalMessage(code, OUT_OF_DATE, reason)).toBe(sentence);
  });

});


it("only the exact unavailable core action refusal gets the not available yet message", () => {
  expect(slackRefusalMessage("NOT_FOUND", OUT_OF_DATE, "That is not on the core engine on this install yet.")).toBe("This action is not available on this install yet.");
  expect(slackRefusalMessage("NOT_FOUND", OUT_OF_DATE, "unrelated missing object")).toBeUndefined();
});
