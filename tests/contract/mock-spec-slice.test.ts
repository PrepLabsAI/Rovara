import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureSetSchema, fixtureEntry, fixtureSetDigest, type FixtureSet } from "../../packages/contracts/src/service-mocks.js";
import { MOCK_SPEC_CATALOG, MockSpecSliceSchema, mockSpecCatalogEntryDigest, mockSpecSliceDigest, mockSpecSliceKey, pinMockSpecSlice, validateMockAgainstSpec } from "../../packages/contracts/src/mock-spec-slices.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const set = (method: "GET" | "POST", path: string, body = "{}"): FixtureSet => {
  const dependency = { id: "payments", family: "http:api.stripe.com", protocol: "http_json" as const, target: "api.stripe.com" };
  const request = { method, path, contentType: "application/json", body: "{}" };
  return FixtureSetSchema.parse({ schemaVersion: 2, dependency, origin: "recorded", revision: 1, recordedAt: "2026-11-01T00:00:00.000Z", syntheticOnly: true, match: { ignorePaths: [] }, entries: [fixtureEntry({ dependency, match: { ignorePaths: [] } }, request, { status: 200, headers: [], contentType: "application/json", body, latencyMs: 0 })], faults: [] });
};

describe("pinned vendor spec slices", () => {
  it("ships small independently hashed Stripe and GitHub catalog excerpts", () => {
    expect(MOCK_SPEC_CATALOG.map(({ vendor }) => vendor)).toEqual(["github", "stripe"]);
    expect(MOCK_SPEC_CATALOG.map((entry) => entry.specVersion)).toEqual(["rovara-test-excerpt-1", "rovara-test-excerpt-1"]);
    for (const entry of MOCK_SPEC_CATALOG) {
      expect(mockSpecCatalogEntryDigest(entry)).toBe(entry.specSha256);
      const fixtureName = entry.vendor === "stripe" ? "rovara-test-excerpt-1.yaml" : "rovara-test-excerpt-2.yaml";
      const fixture = readFileSync(resolve("tests/fixtures/mock-spec-slices", fixtureName), "utf8");
      expect(fixture).toBe(entry.specSource);
    }
  });

  it("refuses a vendor catalog excerpt whose bytes no longer match its pinned hash", () => {
    const stripe = MOCK_SPEC_CATALOG.find((item) => item.vendor === "stripe")!;
    expect(() => validateMockAgainstSpec(set("POST", "/v1/charges"), { ...stripe, specSource: `${stripe.specSource}changed` })).toThrow("vendor spec catalog hash mismatch");
  });

  it("keys a versioned approval-time slice by mock digest and records a catalog miss explicitly", () => {
    const stripe = set("POST", "/v1/charges", JSON.stringify({ id: "ch_1", object: "charge", amount: 10 }));
    const slice = pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: stripe });
    expect(MockSpecSliceSchema.parse(slice)).toMatchObject({ mockDigest: fixtureSetDigest(stripe), vendor: "stripe", specVersion: "rovara-test-excerpt-1", result: "matches" });
    expect(slice.specSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(mockSpecSliceDigest(slice)).toMatch(/^[a-f0-9]{64}$/u);
    expect(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest)).toBe(`ORG#${slice.companyId}#MOCK_SPEC#${slice.project}#${slice.mockDigest}`);
    expect(mockSpecSliceKey("org_bbbbbbbbbbbbbbbbbbbb", slice.project, slice.mockDigest)).not.toBe(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest));
    expect(mockSpecSliceKey(slice.companyId, "other", slice.mockDigest)).not.toBe(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest));
    expect(() => mockSpecSliceKey(slice.companyId, "../other", slice.mockDigest)).toThrow("invalid mock spec slice key");
    const missing = pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: set("POST", "/v1/unknown") });
    expect(missing).toMatchObject({ vendor: "stripe", result: "no_spec", findings: ["No published spec operation matches this mock."] });
  });

  it("reports a mismatch without blocking the approved fixture", () => {
    const fixture = set("POST", "/v1/unknown");
    const validation = validateMockAgainstSpec(fixture, MOCK_SPEC_CATALOG.find((item) => item.vendor === "stripe")!);
    expect(validation.result).toBe("no_spec");
    expect(validateMockAgainstSpec(set("POST", "/v1/charges"), MOCK_SPEC_CATALOG.find((item) => item.vendor === "stripe")!).result).toBe("mismatch");
    expect(fixtureSetDigest(fixture)).toBe(fixtureSetDigest(set("POST", "/v1/unknown")));
  });

  it("does not treat vendor operation path parameters as literals", () => {
    const gh = MOCK_SPEC_CATALOG.find((item) => item.vendor === "github")!;
    expect(validateMockAgainstSpec(set("GET", "/repos/acme/widgets/issues", JSON.stringify({ number: 1, title: "Bug", state: "open" })), gh).result).toBe("matches");
    expect(sha(gh.specSource)).toBe(gh.specSha256);
  });
});
