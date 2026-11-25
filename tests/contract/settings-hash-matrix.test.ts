// F1: the template hash matrix masks what depends on the folder it ran from, so a base built elsewhere compares with a lane built here (scripts/template-hash-matrix.ts).
import { describe, expect, it } from "vitest";
import { normalizeTemplateText } from "../../scripts/template-hash-matrix.js";

const HASH = "a1".repeat(32);

describe("normalizeTemplateText (F1)", () => {
  it("masks the asset hash and the 8-hex path suffix of an asset parameter's logical id, and nothing else", () => {
    const here = `{"AssetParameters${HASH}S3Bucket1A2B3C4D":{"Type":"String"},"Ref":"AssetParameters${HASH}ArtifactHashDEADBEEF","Other":"Role9F8E7D6C"}`;
    const elsewhere = here.replaceAll("1A2B3C4D", "0F0F0F0F").replaceAll("DEADBEEF", "ABCDEF01").replaceAll(HASH, "b2".repeat(32));
    expect(normalizeTemplateText(here)).toBe(normalizeTemplateText(elsewhere));
    expect(normalizeTemplateText(here)).toContain("AssetParameters<asset-hash>S3Bucket<path-hash>");
    expect(normalizeTemplateText(here)).toContain("Role9F8E7D6C");
  });
});
