// tests/contract/init-retry.test.ts
// Q7: a check that fails on the page asks to be run again; without a page it fails exactly as it
// always has, asking nothing.
import { describe, expect, it } from "vitest";
import { checkWithChangeOnPage, problemText } from "../../packages/cli/src/init/retry.js";
import { scriptedPrompter } from "../support/init-fakes.js";

describe("retryOnPage", () => {

  it("names an expired AWS session the way the rest of the CLI does", () => {
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    expect(problemText(expired)).toBe("AWS credentials missing or expired: The security token included in the request is expired");
    expect(problemText("plain")).toBe("plain");
  });

});

describe("spec 048 FR-028: a failed check on the page offers Change answers", () => {

  it("without a page throws the first failure, asking nothing", async () => {
    const prompter = scriptedPrompter([]);
    await expect(checkWithChangeOnPage({ surface: undefined, prompter, question: "q", run: async () => { throw new Error("no"); }, failed: () => undefined })).rejects.toThrow("no");
    expect(prompter.asked).toEqual([]);
  });
});
