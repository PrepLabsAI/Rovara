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

// M1.3 Task 3.7 (Ruling AU): the two refusals M1.3 introduces are said as plain sentences too, and only their opening words are said: what follows is data (account and
// application names, dates) and never reaches Slack.
describe("what a Slack press hears when the test accounts or an outside service's mock changed", () => {
  const ACCOUNTS = "The test accounts changed since this plan was approved. Retry the checks to approve the plan again with the accounts that are registered now.";
  const MOCK = "The mock for an outside service changed since this plan was approved. Retry the checks to approve the plan again with the mock that is approved now.";

  it.each([
    ["CONFIG_INVALID", "accounts-changed-reapprove: account profile orders-viewer of application demo expires at 2026-12-01T00:00:00.000Z, before this round can finish", ACCOUNTS],
    ["RUNTIME_UNAVAILABLE", "accounts-changed-reapprove: the registered record of account profile orders-owner cannot be read; an administrator must register the project again", ACCOUNTS],
    ["CONFIG_INVALID", "the application E2E plan cannot be approved: accounts-changed-reapprove: account profile orders-viewer of application demo is not the registered one. Request changes so the plan is written against the test accounts registered now", ACCOUNTS],
    ["CONFIG_INVALID", "the plan cannot be approved again here: mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
    ["CONFIG_INVALID", "mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
    ["RUNTIME_UNAVAILABLE", "mock-fixture-changed-reapprove: the fixture for inventory-v1 differs from the approved one", MOCK],
  ])("says the sentence for %s: %s", (code, reason, sentence) => {
    expect(slackRefusalMessage(code, OUT_OF_DATE, reason)).toBe(sentence);
  });

  it("does not say the data after the opening words, and does not take a lookalike for them", () => {
    const said = slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "accounts-changed-reapprove: <!channel> orders-viewer@tenant-a.example") ?? "";
    expect(said).not.toContain("channel");
    expect(said).not.toContain("tenant-a.example");
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "the accounts-changed-reapprove: nothing")).toBe(OUT_OF_DATE);
    expect(slackRefusalMessage("CONFIG_INVALID", OUT_OF_DATE, "mock-fixture-changed: x")).toBe(OUT_OF_DATE);
  });
});
