import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureSetSchema, fixtureEntry, fixtureSetDigest, type FixtureSet } from "../../packages/contracts/src/service-mocks.js";
import { extractExcerpt, excerptText, type Json } from "../../scripts/extract-mock-spec-excerpts.js";
import { MOCK_SPEC_CATALOG, MockSpecSliceSchema, mockSpecCatalogEntryDigest, mockSpecSliceDigest, mockSpecSliceKey, pinMockSpecSlice, validateMockAgainstSpec } from "../../packages/contracts/src/mock-spec-slices.js";

const CHARGE = { id: "ch_1", object: "charge", amount: 1000, amount_captured: 1000, amount_refunded: 0, billing_details: {}, captured: true, created: 1700000000, currency: "usd", disputed: false, livemode: false, metadata: {}, paid: true, refunded: false, status: "succeeded" };
const REFUND = { id: "re_1", object: "refund", amount: 500, created: 1700000000, currency: "usd" };
const ISSUE = { assignee: null, closed_at: null, comments: 0, comments_url: "https://api.github.com/x", events_url: "https://api.github.com/x", html_url: "https://github.com/x", id: 1, node_id: "I_1", labels: [], labels_url: "https://api.github.com/x", milestone: null, number: 7, repository_url: "https://api.github.com/x", state: "open", locked: false, title: "Bug", url: "https://api.github.com/x", user: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
const COMMENT = { id: 2, node_id: "IC_2", url: "https://api.github.com/x", html_url: "https://github.com/x", issue_url: "https://api.github.com/x", user: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
const entryOf = (vendor: "stripe" | "github") => MOCK_SPEC_CATALOG.find((item) => item.vendor === vendor)!;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const set = (method: "GET" | "POST", path: string, body = "{}", status = 200, host = "api.stripe.com"): FixtureSet => {
  const dependency = { id: "payments", family: `http:${host}`, protocol: "http_json" as const, target: host };
  const request = { method, path, contentType: "application/json", body: "{}" };
  return FixtureSetSchema.parse({ schemaVersion: 2, dependency, origin: "recorded", revision: 1, recordedAt: "2026-11-01T00:00:00.000Z", syntheticOnly: true, match: { ignorePaths: [] }, entries: [fixtureEntry({ dependency, match: { ignorePaths: [] } }, request, { status, headers: [], contentType: "application/json", body, latencyMs: 0 })], faults: [] });
};

describe("pinned vendor spec slices", () => {
  it("ships small independently hashed Stripe and GitHub catalog excerpts, pinned to upstream commits", () => {
    expect(MOCK_SPEC_CATALOG.map(({ vendor }) => vendor)).toEqual(["github", "stripe"]);
    for (const entry of MOCK_SPEC_CATALOG) {
      expect(mockSpecCatalogEntryDigest(entry)).toBe(entry.specSha256);
      expect(entry.specSource.length).toBeLessThan(10_000);
      const fixture = readFileSync(resolve("tests/fixtures/mock-spec-slices", `${entry.vendor}-openapi-excerpt.json`), "utf8");
      expect(fixture).toBe(entry.specSource);
      expect(entry.upstream.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(entry.upstream.retrievedAt).toBe("2026-11-17");
      expect(entry.specVersion).not.toContain("rovara-test-excerpt");
      expect(entry.specSource).not.toMatch(/illustrative|stub/iu);
    }
    // Literal pins: a regenerated excerpt (a new upstream commit) changes these lines, so the change is visible in review.
    expect(MOCK_SPEC_CATALOG.map((entry) => [entry.vendor, entry.upstream.commit, entry.specSha256])).toEqual([
      ["github", "c9c95fe34ced05fe076001f5c55704742bc8e7f8", "35caf0c363a16320e18ab3c5ede4e76132506f93fd8371a784e93ecdcac87ca2"],
      ["stripe", "ed463ff0873e207ec317de52bf483aa94929144e", "22bd2df2447ecff07dc6bdc605c386bcd0ed633f981d8bde6ecac5f36a4bc434"],
    ]);
    expect(MOCK_SPEC_CATALOG.find((entry) => entry.vendor === "stripe")!.operations.map((operation) => operation.operationId)).toEqual(["PostCharges", "GetChargesCharge", "PostRefunds", "PostPaymentIntents", "GetPaymentIntentsIntent", "PostCustomers"]);
    expect(MOCK_SPEC_CATALOG.find((entry) => entry.vendor === "github")!.operations.map((operation) => operation.operationId)).toEqual(["issues/list-for-repo", "issues/create", "issues/get", "issues/list-comments", "issues/create-comment"]);
  });

  it("carries the upstream licence notice for each vendor excerpt", () => {
    const notices = readFileSync(resolve("THIRD_PARTY_NOTICES.md"), "utf8");
    for (const entry of MOCK_SPEC_CATALOG) {
      expect(notices, `${entry.vendor} source url`).toContain(entry.upstream.url);
      expect(notices, `${entry.vendor} pinned commit`).toContain(entry.upstream.commit);
      expect(notices, `${entry.vendor} retrieval date`).toContain(entry.upstream.retrievedAt);
      expect(notices, `${entry.vendor} excerpt file`).toContain(`${entry.vendor}-openapi-excerpt.json`);
    }
    expect(notices).toContain("Copyright (c) 2011- Stripe, Inc.");
    expect(notices).toContain("Copyright (c) 2020 GitHub");
    expect((notices.match(/Permission is hereby granted, free of charge, to any person obtaining a copy/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((notices.match(/THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/gu) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps no key-shaped strings or example values in the excerpts", () => {
    for (const entry of MOCK_SPEC_CATALOG) {
      expect(entry.specSource).not.toMatch(/\b(?:sk|pk|rk|whsec)_(?:live|test)_/u);
      expect(entry.specSource).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/u);
      expect(entry.specSource).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN/u);
      expect(entry.specSource).not.toMatch(/"(?:description|example|examples|x-[A-Za-z-]+)"/u);
    }
  });

  it("refuses a vendor catalog excerpt whose bytes no longer match its pinned hash", () => {
    const stripe = MOCK_SPEC_CATALOG.find((item) => item.vendor === "stripe")!;
    expect(() => validateMockAgainstSpec(set("POST", "/v1/charges"), { ...stripe, specSource: `${stripe.specSource}changed` })).toThrow("vendor spec catalog hash mismatch");
  });

  it("keys a versioned approval-time slice by mock digest and records a catalog miss explicitly", () => {
    const stripe = set("POST", "/v1/charges", JSON.stringify(CHARGE));
    const slice = pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: stripe });
    expect(MockSpecSliceSchema.parse(slice)).toMatchObject({ mockDigest: fixtureSetDigest(stripe), vendor: "stripe", specVersion: "2026-10-28.endive (stripe/openapi ed463ff0873e)", result: "matches", findings: [] });
    expect(slice.specSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(mockSpecSliceDigest(slice)).toMatch(/^[a-f0-9]{64}$/u);
    expect(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest)).toBe(`ORG#${slice.companyId}#MOCK_SPEC#${slice.project}#${slice.mockDigest}`);
    expect(mockSpecSliceKey("org_bbbbbbbbbbbbbbbbbbbb", slice.project, slice.mockDigest)).not.toBe(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest));
    expect(mockSpecSliceKey(slice.companyId, "other", slice.mockDigest)).not.toBe(mockSpecSliceKey(slice.companyId, slice.project, slice.mockDigest));
    expect(() => mockSpecSliceKey(slice.companyId, "../other", slice.mockDigest)).toThrow("invalid mock spec slice key");
    const missing = pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: set("POST", "/v1/unknown") });
    expect(missing).toMatchObject({ vendor: "stripe", result: "no_spec", findings: ["No published spec operation matches this mock."] });
    const other = pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: set("GET", "/anything", "{}", 200, "api.example.com") });
    expect(other).toMatchObject({ vendor: "unknown", result: "no_spec", specVersion: null, specSha256: null });
  });

  describe("a known-good mock matches the real vendor spec", () => {
    it.each([
      ["Stripe create charge", set("POST", "/v1/charges", JSON.stringify(CHARGE)), "stripe"],
      ["Stripe get charge", set("GET", "/v1/charges/ch_123", JSON.stringify(CHARGE)), "stripe"],
      ["Stripe create refund", set("POST", "/v1/refunds", JSON.stringify(REFUND)), "stripe"],
      ["Stripe error answer is not read against the success schema", set("POST", "/v1/charges", JSON.stringify({ error: { type: "card_error" } }), 402), "stripe"],
      ["GitHub get issue", set("GET", "/repos/acme/widgets/issues/7", JSON.stringify(ISSUE), 200, "api.github.com"), "github"],
      ["GitHub list issues", set("GET", "/repos/acme/widgets/issues", JSON.stringify([ISSUE, ISSUE]), 200, "api.github.com"), "github"],
      ["GitHub create issue answers 201", set("POST", "/repos/acme/widgets/issues", JSON.stringify(ISSUE), 201, "api.github.com"), "github"],
    ] as const)("%s", (_name, fixture, vendor) => {
      const result = validateMockAgainstSpec(fixture, entryOf(vendor));
      expect(result.findings).toEqual([]);
      expect(result.result).toBe("matches");
    });
  });

  describe("a known-bad mock does not match, and never blocks", () => {
    it.each([
      ["a required field is missing", set("POST", "/v1/charges", JSON.stringify({ id: "ch_1", object: "charge", amount: 10 })), "stripe", 'PostCharges: response is missing "amount_captured", which the pinned spec requires.'],
      ["a field has the wrong type", set("POST", "/v1/refunds", JSON.stringify({ ...REFUND, amount: "10" })), "stripe", 'PostRefunds: "amount" is not the integer the pinned spec says.'],
      ["a fractional number is not an integer", set("POST", "/v1/refunds", JSON.stringify({ ...REFUND, amount: 10.5 })), "stripe", 'PostRefunds: "amount" is not the integer the pinned spec says.'],
      ["the object enum is wrong", set("POST", "/v1/refunds", JSON.stringify({ ...REFUND, object: "charge" })), "stripe", 'PostRefunds: "object" is not one of the values the pinned spec lists.'],
      ["a non-nullable field is null", set("POST", "/v1/refunds", JSON.stringify({ ...REFUND, currency: null })), "stripe", 'PostRefunds: "currency" is null, which the pinned spec does not allow.'],
      ["a nullable field null is fine but a missing one is not", set("GET", "/repos/acme/widgets/issues/7", JSON.stringify({ ...ISSUE, closed_at: undefined }), 200, "api.github.com"), "github", 'issues/get: response is missing "closed_at", which the pinned spec requires.'],
      ["a create answers the wrong success status", set("POST", "/repos/acme/widgets/issues", JSON.stringify(ISSUE), 200, "api.github.com"), "github", "issues/create: answers 200, but the pinned spec documents 201."],
      ["a list answers one object", set("GET", "/repos/acme/widgets/issues", JSON.stringify(ISSUE), 200, "api.github.com"), "github", "issues/list-for-repo: the response should be a list, as the pinned spec says."],
      ["an item of a list is bad", set("GET", "/repos/acme/widgets/issues", JSON.stringify([ISSUE, { ...ISSUE, number: "7" }]), 200, "api.github.com"), "github", 'issues/list-for-repo: "number" is not the integer the pinned spec says.'],
      ["the body is not JSON", set("GET", "/v1/charges/ch_1", "not json"), "stripe", "GetChargesCharge: response is not JSON."],
    ] as const)("%s", (_name, fixture, vendor, finding) => {
      const result = validateMockAgainstSpec(fixture, entryOf(vendor));
      expect(result.result).toBe("mismatch");
      expect(result.findings).toContain(finding);
      // advisory only: the fixture's own digest is untouched, and pinning records the result without refusing anything.
      expect(pinMockSpecSlice({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", project: "web", set: fixture }).result).toBe("mismatch");
    });

    it("does not echo recorded values in a finding", () => {
      const result = validateMockAgainstSpec(set("POST", "/v1/refunds", JSON.stringify({ ...REFUND, amount: "SECRET-VALUE-123" })), entryOf("stripe"));
      expect(JSON.stringify(result.findings)).not.toContain("SECRET-VALUE-123");
    });
  });

  it("reports no_spec for a mock the spec has no operation for, without a finding that blocks", () => {
    const fixture = set("POST", "/v1/unknown");
    const validation = validateMockAgainstSpec(fixture, entryOf("stripe"));
    expect(validation.result).toBe("no_spec");
    expect(fixtureSetDigest(fixture)).toBe(fixtureSetDigest(set("POST", "/v1/unknown")));
  });

  it("does not treat vendor operation path parameters as literals", () => {
    expect(validateMockAgainstSpec(set("GET", "/repos/acme/widgets/issues/9/comments", JSON.stringify([COMMENT]), 200, "api.github.com"), entryOf("github")).result).toBe("matches");
    expect(validateMockAgainstSpec(set("GET", "/repos/acme/widgets/issues/9/commentsX", JSON.stringify([COMMENT]), 200, "api.github.com"), entryOf("github")).result).toBe("no_spec");
    expect(sha(entryOf("github").specSource)).toBe(entryOf("github").specSha256);
  });

  describe("the extractor", () => {
    const vendor: Json = {
      openapi: "3.0.3", info: { title: "T", version: "9", description: "long text" },
      paths: { "/a/{id}": { get: { operationId: "getA", summary: "x", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/a" } } } }, default: { description: "err" } } } } },
      components: { schemas: { a: { type: "object", description: "d", required: ["id", "kind"], properties: { id: { type: "string", description: "d", example: "sk_test_x" }, kind: { type: "string", enum: ["a"], "x-ext": 1 }, optional: { type: "string" } } } } },
    };
    it("keeps only the required properties' type keywords and drops descriptions, examples and optional properties", () => {
      const text = excerptText(extractExcerpt(vendor, [{ path: "/a/{id}", method: "get" }]));
      expect(JSON.parse(text)).toEqual({ openapi: "3.0.3", info: { title: "T", version: "9" }, paths: { "/a/{id}": { get: { operationId: "getA", responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/a" } } } } } } } }, components: { schemas: { a: { type: "object", required: ["id", "kind"], properties: { id: { type: "string" }, kind: { type: "string", enum: ["a"] } } } } } });
      expect(text).not.toContain("sk_test_x");
    });
    it("refuses a spec that no longer has a listed operation, rather than shrinking the excerpt", () => {
      expect(() => extractExcerpt(vendor, [{ path: "/gone", method: "get" }])).toThrow("no path /gone");
      expect(() => extractExcerpt(vendor, [{ path: "/a/{id}", method: "post" }])).toThrow("no post /a/{id}");
    });
  });
});
