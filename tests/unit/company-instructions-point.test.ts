// Port lane P6 (item L1): the company-instructions point: a plug-in point that holds one adapter, the snapshot shape Cloud's port shares, and the shared test fake.
// (Code's file adapter, `company-instructions.md` in the laptop's state folder, went with `@agentx/local-adapters`, issue #1538.)
import { describe, expect, it } from "vitest";
import { CompanyInstructionsSnapshotSchema, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, type CompanyInstructionsSource } from "@agentx/contracts";
import { fakeCompanyInstructionsSource } from "../support/company-instructions-fake.js";

describe("the company-instructions point", () => {
  it("is a registered plug-in point that holds one adapter", () => {
    expect(PLUGIN_POINTS).toContain("company-instructions");
    expect(PLUGIN_POINT_CARDINALITY["company-instructions"]).toBe("one");
  });

  it("is the same snapshot shape as Cloud's port: a version and rules with a priority", () => {
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "a".repeat(64), rules: [{ text: "x", priority: "required" }] }).success).toBe(true);
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "1", rules: [{ text: "x", priority: "optional" }] }).success).toBe(false);
    expect(CompanyInstructionsSnapshotSchema.safeParse({ version: "1", rules: [], hash: "x" }).success).toBe(false);
  });

  it("is satisfied by the shared test fake (answers in turn, records the company key)", async () => {
    const fake = fakeCompanyInstructionsSource([{ version: "1", rules: [{ text: "a", priority: "required" }] }, undefined]);
    const source: CompanyInstructionsSource = fake;
    expect((await source.current("org_x"))?.version).toBe("1");
    expect(await source.current("org_y")).toBeUndefined();
    expect(fake.asked).toEqual(["org_x", "org_y"]);
  });
});
