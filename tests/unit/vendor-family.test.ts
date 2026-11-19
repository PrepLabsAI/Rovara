// Option B (owner 2026-11-16): the vendor-family check lives in a neutral contracts module, so the eval discovery report need not import the sealed side-by-side lane. Same list, same words, same regexes, same results.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelBelongsToFamily, VENDOR_FAMILIES, vendorFamilyOf, type VendorFamily } from "../../packages/contracts/src/vendor-family.js";

describe("vendor-family (moved out of the side-by-side lane, unchanged)", () => {
  it("keeps the closed family list in its order", () => {
    expect([...VENDOR_FAMILIES]).toEqual(["anthropic", "google", "openai", "cohere", "meta", "mistral", "amazon", "xai", "deepseek"]);
  });
  it("maps every family word as before and refuses API formats, unknown words and long values", () => {
    const words: Record<string, VendorFamily> = {
      anthropic: "anthropic", claude: "anthropic", google: "google", gemini: "google", gemma: "google", openai: "openai", gpt: "openai", cohere: "cohere", command: "cohere", meta: "meta", llama: "meta", mistral: "mistral", mixtral: "mistral",
      amazon: "amazon", nova: "amazon", titan: "amazon", xai: "xai", grok: "xai", deepseek: "deepseek",
    };
    for (const [word, family] of Object.entries(words)) {
      expect(vendorFamilyOf(word)).toBe(family);
      expect(vendorFamilyOf(` ${word.toUpperCase()} `)).toBe(family);
    }
    expect(vendorFamilyOf(`${" ".repeat(34)}claude`)).toBe("anthropic");
    for (const bad of [`${" ".repeat(35)}claude`, "anthropic_messages", "openai_compatible", "vertex", "bedrock", "toString", "__proto__", "", "x".repeat(41), 7, undefined, null]) expect(vendorFamilyOf(bad)).toBeUndefined();
  });
  it("matches model names with the same stems and boundaries as before", () => {
    const yes: [string, VendorFamily][] = [
      ["claude-3-5-sonnet", "anthropic"], ["us.anthropic.claude-sonnet-4", "anthropic"], ["gemini-2.5-flash", "google"], ["models/gemma-2", "google"], ["gpt-4o", "openai"], ["chatgpt-4o-latest", "openai"], ["o3-mini", "openai"],
      ["command-r", "cohere"], ["c4ai-aya", "cohere"], ["meta.llama3-70b", "meta"], ["meta-llama/Llama-3", "meta"], ["mistral-large", "mistral"], ["mixtral-8x7b", "mistral"], ["codestral", "mistral"], ["ministral-8b", "mistral"],
      ["amazon.nova-pro", "amazon"], ["titan-text", "amazon"], ["grok-2", "xai"], ["deepseek-r1", "deepseek"], ["x:grok-3", "xai"],
    ];
    for (const [model, family] of yes) expect(modelBelongsToFamily(model, family)).toBe(true);
    expect(modelBelongsToFamily("claude".padEnd(128, "x"), "anthropic")).toBe(true);
    const no: [unknown, VendorFamily][] = [["gemini-2.5-flash", "anthropic"], ["myclaude", "anthropic"], ["foo-gpt", "openai"], ["claude".padEnd(129, "x"), "anthropic"], [42, "anthropic"], ["oX", "openai"]];
    for (const [model, family] of no) expect(modelBelongsToFamily(model, family)).toBe(false);
  });
  it("is reached by the eval discovery report without importing the side-by-side lane", () => {
    const text = readFileSync("packages/contracts/src/eval-discovery-report.ts", "utf8");
    expect(text).toMatch(/from "\.\/vendor-family\.js"/u);
    expect(text).not.toMatch(/side-by-side/u);
  });
});
