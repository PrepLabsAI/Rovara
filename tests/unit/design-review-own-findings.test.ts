// Design review stage: findings the broker makes itself, no model involved.
import { describe, expect, it } from "vitest";
import { DESIGN_TEXT_MAX_BYTES, type DesignFinding } from "@agentx/contracts";
import { designSectionThree, ownDesignFindings, requirementsMissingFromDesign, withOwnFindings } from "../../packages/broker/src/core/design-review/own-findings.js";

const design = (three: string, extra = ""): string => `# Design\n\n## §1 Problem and goal\nCovers R1, R2 and R3.\n\n## §2 Current system\nR4 is old.\n\n## §3 Proposed design\n${three}\n\n## §4 Alternatives\nNone. ${extra}\n\n## §5 Risks\nR5 fails.\n`;

describe("designSectionThree", () => {
  it("returns §3 with its subsections, and stops at §4", () => {
    const text = designSectionThree(design("### 3.1 Interfaces\nR1 is handled here.\n### 3.2 Data\nR2."))!;
    expect(text).toContain("R1 is handled");
    expect(text).toContain("R2.");
    expect(text).not.toContain("None.");
    expect(text).not.toContain("R3");
  });
});

describe("ownDesignFindings", () => {

  it("every requirement is missing when the design has no §3, and an id of an odd shape is never matched", () => {
    expect(requirementsMissingFromDesign("## §1 x\nR1", ["R1"])).toEqual(["R1"]);
    expect(requirementsMissingFromDesign(design("some text"), ["not an id!"])).toEqual(["not an id!"]);
  });

  it("adds a major 'too long' finding over 24 KB, and nothing for a design that fits", () => {
    expect(ownDesignFindings({ design: design("R1"), requirementIds: ["R1"] })).toEqual([]);
    const long = design("R1", "x".repeat(DESIGN_TEXT_MAX_BYTES));
    const findings = ownDesignFindings({ design: long, requirementIds: ["R1"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "major", origin: "rovara", id: "rovara-too-long" });
    expect(findings[0]!.text).toContain("split the work");
  });

  it("bounds the list: past 12 missing requirements the rest share one finding", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `R${i + 1}`);
    const findings = ownDesignFindings({ design: design("nothing"), requirementIds: ids });
    expect(findings).toHaveLength(13);
    expect(findings.at(-1)!.id).toBe("rovara-requirements-more");
    expect(findings.at(-1)!.text.length).toBeLessThanOrEqual(500);
  });
});

describe("withOwnFindings", () => {
  const reviewer = (id: string, severity: DesignFinding["severity"]): DesignFinding => ({ id, severity, section: "§3", text: `t ${id}`, citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic"], rawIds: [id], fingerprint: "f".repeat(64) });
  it("keeps ids unique", () => {
    const own = ownDesignFindings({ design: design("none"), requirementIds: ["R1"] });
    const { findings } = withOwnFindings([reviewer("rovara-R1", "major")], own);
    expect(new Set(findings.map((f) => f.id)).size).toBe(2);
  });
});
