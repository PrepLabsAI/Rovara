// Option B (owner 2026-11-16): the vendor-family check lives in a neutral contracts module, so the eval discovery report need not import the sealed side-by-side lane. Same list, same words, same regexes, same results.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VENDOR_FAMILIES } from "../../packages/contracts/src/vendor-family.js";

describe("vendor-family (moved out of the side-by-side lane, unchanged)", () => {
  it("keeps the closed family list in its order", () => {
    expect([...VENDOR_FAMILIES]).toEqual(["anthropic", "google", "openai", "cohere", "meta", "mistral", "amazon", "xai", "deepseek"]);
  });
  it("is reached by the eval discovery report without importing the side-by-side lane", () => {
    const text = readFileSync("packages/contracts/src/eval-discovery-report.ts", "utf8");
    expect(text).toMatch(/from "\.\/vendor-family\.js"/u);
    expect(text).not.toMatch(/side-by-side/u);
  });
});
