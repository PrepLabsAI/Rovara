import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { fixtureSetDigest, type FixtureSet } from "./service-mocks.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Plain = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]*$/u);
const operationSchema = z.object({ operationId: Plain, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().min(1).max(300), requiredResponseFields: z.array(Plain).max(32) }).strict();
export const MockSpecCatalogEntrySchema = z.object({ vendor: z.enum(["stripe", "github"]), specVersion: Plain, specSha256: Sha256, specSource: z.string().min(1).max(4096), operations: z.array(operationSchema).min(1).max(16) }).strict();
export type MockSpecCatalogEntry = z.infer<typeof MockSpecCatalogEntrySchema>;

/**
 * Illustrative test catalog excerpts: hand-written stubs shaped like the vendors' OpenAPI.
 * Replace these with real pinned vendor extracts before the catalog ships.
 */
export const MOCK_SPEC_CATALOG = [
  {
    vendor: "github", specVersion: "rovara-test-excerpt-1", specSha256: "1002a151c4f815ebc5abac7a2b5d93a481f7850406c21f44ce752f777e02eff5",
    specSource: "openapi: 3.1.0\ninfo: { title: GitHub REST API, version: rovara-test-excerpt-1 }\npaths:\n  /repos/{owner}/{repo}/issues:\n    get: { operationId: issues/list }\n  /repos/{owner}/{repo}/issues/{issue_number}:\n    get: { operationId: issues/get }\n",
    operations: [
      { operationId: "issues/list", method: "GET", path: "/repos/{owner}/{repo}/issues", requiredResponseFields: ["number", "title", "state"] },
      { operationId: "issues/get", method: "GET", path: "/repos/{owner}/{repo}/issues/{issue_number}", requiredResponseFields: ["number", "title", "state"] },
    ],
  },
  {
    vendor: "stripe", specVersion: "rovara-test-excerpt-1", specSha256: "24a324eadcc430c06c7ff4b45927a846a91a379f2b869d536b95f812d1b7245f",
    specSource: "openapi: 3.1.0\ninfo: { title: Stripe API, version: rovara-test-excerpt-1 }\npaths:\n  /v1/charges:\n    post: { operationId: createCharge }\n  /v1/refunds:\n    post: { operationId: createRefund }\n",
    operations: [
      { operationId: "createCharge", method: "POST", path: "/v1/charges", requiredResponseFields: ["id", "object", "amount"] },
      { operationId: "createRefund", method: "POST", path: "/v1/refunds", requiredResponseFields: ["id", "object", "charge"] },
    ],
  },
] as const satisfies readonly MockSpecCatalogEntry[];

const MockSpecFindingSchema = Plain;
export const MockSpecSliceSchema = z.object({ schemaVersion: z.literal(1), companyId: Plain, project: z.string().regex(AGENTX_NAME_PATTERN), mockDigest: Sha256, vendor: z.enum(["stripe", "github", "unknown"]), specVersion: Plain.nullable(), specSha256: Sha256.nullable(), operations: z.array(operationSchema).max(16), cutAt: z.string().datetime(), result: z.enum(["matches", "mismatch", "no_spec"]), findings: z.array(MockSpecFindingSchema).max(100) }).passthrough();
export type MockSpecSlice = z.infer<typeof MockSpecSliceSchema>;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function mockSpecCatalogEntryDigest(entry: MockSpecCatalogEntry): string { return sha256(entry.specSource); }
export function mockSpecSliceDigest(slice: MockSpecSlice): string { return sha256(canonicalJson(MockSpecSliceSchema.parse(slice))); }
/** Company and project are both part of the row key; the referenced digest remains the only value stored in a mock approval index. */
export function mockSpecSliceKey(companyId: string, project: string, mockDigest: string): string {
  if (!Plain.safeParse(companyId).success || !AGENTX_NAME_PATTERN.test(project) || !Sha256.safeParse(mockDigest).success) throw new Error("invalid mock spec slice key");
  return `ORG#${companyId}#MOCK_SPEC#${project}#${mockDigest}`;
}

function pathMatches(template: string, actual: string): boolean {
  const expression = template.split("/").map((part) => /^\{[^/{}]+\}$/u.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/");
  return new RegExp(`^${expression}/?$`, "u").test(actual);
}

/** Runs offline against the catalog excerpt. A catalog miss is explicit no_spec; response drift is advisory mismatch. */
export function validateMockAgainstSpec(set: FixtureSet, catalog: MockSpecCatalogEntry): { result: "matches" | "mismatch" | "no_spec"; operations: MockSpecCatalogEntry["operations"]; findings: string[] } {
  const entry = MockSpecCatalogEntrySchema.parse(catalog);
  if (mockSpecCatalogEntryDigest(entry) !== entry.specSha256) throw new Error("vendor spec catalog hash mismatch");
  const findings: string[] = [];
  for (const fixture of set.entries) {
    const operation = entry.operations.find((candidate) => candidate.method === fixture.request.method && pathMatches(candidate.path, fixture.request.path));
    if (operation === undefined) continue;
    let response: unknown;
    try { response = JSON.parse(fixture.response.body); } catch { findings.push(`${operation.operationId}: response is not JSON.`); continue; }
    if (response === null || typeof response !== "object" || Array.isArray(response) || operation.requiredResponseFields.some((field) => !Object.hasOwn(response, field))) {
      findings.push(`${operation.operationId}: response is missing fields required by the pinned spec.`);
    }
  }
  const operations = entry.operations;
  const hasOperation = set.entries.some((fixture) => operations.some((operation) => operation.method === fixture.request.method && pathMatches(operation.path, fixture.request.path)));
  if (!hasOperation) findings.push("No published spec operation matches this mock.");
  return { result: !hasOperation ? "no_spec" : findings.length === 0 ? "matches" : "mismatch", operations, findings };
}

/** Pin at approval time. The returned record is separate from FixtureSet and never affects its canonical digest. */
export function pinMockSpecSlice(input: { companyId: string; project: string; set: FixtureSet; cutAt?: Date; catalog?: readonly MockSpecCatalogEntry[] }): MockSpecSlice {
  const { companyId, project, set } = input;
  const host = set.dependency.target.toLowerCase();
  const vendor = host === "api.stripe.com" || host === "stripe.com" ? "stripe" : host === "api.github.com" || host === "github.com" ? "github" : "unknown";
  const catalog = input.catalog ?? MOCK_SPEC_CATALOG;
  const found = catalog.find((entry) => entry.vendor === vendor);
  const checked = found === undefined ? { result: "no_spec" as const, operations: [], findings: ["No published spec is pinned for this vendor."] } : validateMockAgainstSpec(set, found);
  const slice = {
    schemaVersion: 1 as const, companyId, project, mockDigest: fixtureSetDigest(set), vendor,
    specVersion: found?.specVersion ?? null, specSha256: found?.specSha256 ?? null,
    operations: checked.operations, cutAt: (input.cutAt ?? new Date()).toISOString(), result: checked.result, findings: checked.findings,
  };
  return MockSpecSliceSchema.parse(slice);
}
