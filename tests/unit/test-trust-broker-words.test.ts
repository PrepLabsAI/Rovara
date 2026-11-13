// TE-A3: the broker's words for the two new labels and the new backing. Fixed words only; nothing from a repository is echoed.
import { describe, expect, it } from "vitest";
import type { EvidenceDependency, TestEnvBacking } from "@agentx/contracts";
import { backingWords } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { dependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";

const sha = (letter: string) => letter.repeat(64);
const fake = (provenance?: Record<string, unknown>): TestEnvBacking => ({ kind: "fake", fixtureSetRef: sha("a"), unmatched: "fail", ...(provenance === undefined ? {} : { provenance }) }) as TestEnvBacking;
const mockSet = { setId: "payments-mocks", version: 1, store: "rovara" };

describe("the approval card's words for a backing", () => {
  it("says a vendor's test mode needs a second person, like a test account", () => {
    expect(backingWords({ kind: "vendor_test", accountId: "payments-test" })).toBe("uses the vendor's own test mode with your test key in sealed checks (a second person approves this)");
  });
  it("says who made a fake: Rovara, a recording, or nobody in particular", () => {
    expect(backingWords(fake({ origin: "rovara_task", mockSet }))).toBe("answers from a fake made by Rovara");
    expect(backingWords(fake({ origin: "rovara_setup", mockSet }))).toBe("answers from a fake made by Rovara");
    expect(backingWords(fake({ origin: "recorded", recordedOn: "2026-11-12" }))).toBe("answers from a recorded fake");
    expect(backingWords(fake())).toBe("answers from a fake");
  });
  it("never lets a recording that Rovara made read as a plain recording", () => {
    expect(backingWords(fake({ origin: "rovara_task", mockSet }), new Map([[sha("a"), { origin: "recorded" as const }]]))).toBe("answers from a fake made by Rovara");
  });
});

describe("the pull request's lines for the new labels", () => {
  const made: EvidenceDependency = { name: "Payments", backing: "fake", label: "rovara_made_fake", madeUpAnswers: 3 };
  const vendor: EvidenceDependency = { name: "Stripe", backing: "vendor_test", label: "vendor_test" };
  it("says a Rovara-made fake's answers were made by Rovara and counts its made-up answers", () => {
    const { lines, notTested } = dependencyLines([made], 0);
    expect(lines.join("\n")).toContain("fake made by Rovara");
    expect(notTested.join("\n")).toContain("answers were made by Rovara, not recorded from the real service");
    expect(notTested.join("\n")).toContain("3 requests had no recording and got a made-up answer");
    expect(dependencyLines([made], 3).notTested.join("\n")).toContain("made by Rovara");
  });
  it("says a vendor test mode ran, and adds no 'not checked' line for it", () => {
    const { lines, notTested } = dependencyLines([vendor], 0);
    expect(lines.join("\n")).toContain("vendor test mode");
    expect(notTested).toEqual([]);
  });
});
