// TE-A3: the broker's words for the new labels. Fixed words only; nothing from a repository is echoed.
// (The approval card's backing words and the pinned-fake cases went with their deleted subjects, test-env/dependency-card-lines.ts and evidence-line.ts.)
import { describe, expect, it } from "vitest";
import type { EvidenceDependency } from "@agentx/contracts";
import { dependencyLines } from "../../packages/broker/src/core/proof/dependency-lines.js";

describe("the pull request's lines for the new labels", () => {
  const made: EvidenceDependency = { name: "Payments", backing: "fake", label: "rovara_made_fake", madeUpAnswers: 3 };
  it("says a Rovara-made fake's answers were made by Rovara and counts its made-up answers", () => {
    const { lines, notTested } = dependencyLines([made], 0);
    expect(lines.join("\n")).toContain("fake made by Rovara");
    expect(notTested.join("\n")).toContain("answers were made by Rovara, not recorded from the real service");
    expect(notTested.join("\n")).toContain("3 requests had no recording and got a made-up answer");
    expect(dependencyLines([made], 3).notTested.join("\n")).toContain("made by Rovara");
  });
});
