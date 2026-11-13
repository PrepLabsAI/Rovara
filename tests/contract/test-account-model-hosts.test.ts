// FIX-0518 (security): a test account is never for an AI model service. Save (the schema), the production check and the pure host test all refuse a model host from F0a's catalog: exact hosts, the Azure suffix,
// any case, a trailing dot. Non-model Google hosts (storage, bigquery, the token hosts) stay allowed.
import { describe, expect, it } from "vitest";
import {
  TEST_ACCOUNT_MODEL_HOST_SENTENCE, TestAccountSchema, builtinModelCatalog, isTestAccountModelHost, testAccountApprovalDigest, testAccountModelHostProblems, testAccountProdProblems, testAccountSchemaFor, testAccountSecretRef,
} from "../../packages/contracts/src/index.js";

const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
const person = (letter: string) => letter.repeat(64);
const approval = (by: string) => ({ by: person(by), at: "2026-11-02T10:00:00.000Z", freshSignIn: true, kind: "approver" });
function record(host: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: "model-test", orgId: ORG, projectIds: ["orders"], family: `http:${host}`, label: "Some test account", kind: "api_key", secretRef: testAccountSecretRef("staging", ORG, "model-test", "apiKey"),
    hosts: [host], envNames: ["SOME_API_KEY"], limits: { maxConnectionsPerRun: 2_000, maxConnectionsPerDay: 20_000, maxConcurrentRounds: 2 }, approvals: [approval("a"), approval("b")], status: "active",
    expiresAt: "2027-01-30T10:00:00.000Z", ...over,
  };
  const digest = testAccountApprovalDigest(base as never);
  return { ...base, approvals: (base.approvals as Array<Record<string, unknown>>).map((each) => ({ ...each, approvedDigest: digest })) };
}
const save = (host: string, over: Record<string, unknown> = {}, schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } } } = TestAccountSchema) => schema.safeParse(record(host, over));
const messages = (host: string, over: Record<string, unknown> = {}, schema = TestAccountSchema) => (save(host, over, schema).error?.issues ?? []).map((issue) => issue.message);
const DENY = { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] };

const rows = builtinModelCatalog().rows;
const catalogHosts = [...new Set(rows.flatMap((row) => row.hosts))];
const suffixes = [...new Set(rows.flatMap((row) => row.hostSuffixes))];

describe("the model host test", () => {
  it("knows every catalog host, the Azure suffix form and the company's gateway hosts", () => {
    expect(catalogHosts.length).toBeGreaterThan(50);
    for (const host of ["generativelanguage.googleapis.com", "api.openai.com", "api.anthropic.com", "us-central1-aiplatform.googleapis.com", "openrouter.ai"]) expect(catalogHosts, host).toContain(host);
    for (const host of catalogHosts) expect(isTestAccountModelHost(host), host).toBe(true);
    expect(suffixes).toContain("openai.azure.com");
    for (const host of ["my-resource.openai.azure.com", "a.b.openai.azure.com", "openai.azure.com"]) expect(isTestAccountModelHost(host), host).toBe(true);
    expect(isTestAccountModelHost("llm.corp-gateway.example.com")).toBe(false);
    expect(isTestAccountModelHost("llm.corp-gateway.example.com", { gatewayHosts: ["llm.corp-gateway.example.com"] })).toBe(true);
  });
  it("is case-insensitive and ignores trailing dots and spaces", () => {
    for (const host of ["API.OPENAI.COM", "Api.OpenAI.com", "api.openai.com.", "api.openai.com..", " api.openai.com ", "My-Resource.OpenAI.Azure.COM.", "GENERATIVELANGUAGE.googleapis.com."]) expect(isTestAccountModelHost(host), host).toBe(true);
  });
  it("does not take a look-alike or a non-model host for a model host", () => {
    for (const host of [
      "storage.googleapis.com", "bigquery.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com", "api.example-pay.com", "api.openai.com.example.net", "notapi.openai.com", "xopenai.azure.com",
      "openai.azure.com.example.net", "example.com", "", "api.openai.co",
    ]) expect(isTestAccountModelHost(host), host).toBe(false);
    for (const odd of [undefined, null, 5, {}, ["api.openai.com"]]) expect(isTestAccountModelHost(odd as never)).toBe(false);
  });
  it("gives positions only", () => {
    expect(testAccountModelHostProblems(["api.example-pay.com", "API.OPENAI.COM", "storage.googleapis.com", "x.openai.azure.com"])).toEqual([1, 3]);
  });
});

describe("saving a test account for a model host", () => {
  it("refuses every catalog host, each with the fixed sentence at its own position", () => {
    for (const host of catalogHosts) {
      const result = save(host);
      expect(result.success, host).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message), host).toContain(TEST_ACCOUNT_MODEL_HOST_SENTENCE);
      expect(result.error?.issues.some((issue) => issue.path.join(".") === "hosts.0"), host).toBe(true);
    }
  });
  it("refuses a model host listed after an ordinary one, and names that position", () => {
    const result = TestAccountSchema.safeParse(record("api.example-pay.com", { hosts: ["api.example-pay.com", "api.openai.com"] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.filter((issue) => issue.message === TEST_ACCOUNT_MODEL_HOST_SENTENCE).map((issue) => issue.path.join("."))).toEqual(["hosts.1"]);
  });
  it("refuses the Azure suffix forms, the apex and a deeper name", () => {
    for (const host of ["my-resource.openai.azure.com", "a.b.openai.azure.com", "openai.azure.com"]) expect(messages(host), host).toContain(TEST_ACCOUNT_MODEL_HOST_SENTENCE);
  });
  it("refuses case variants and a trailing dot with the same sentence, not a generic host message", () => {
    for (const host of ["API.OPENAI.COM", "Api.OpenAI.com", "api.openai.com.", "My-Resource.OpenAI.Azure.COM", "GenerativeLanguage.GoogleAPIs.com."]) {
      expect(save(host).success, host).toBe(false);
      expect(messages(host), host).toContain(TEST_ACCOUNT_MODEL_HOST_SENTENCE);
    }
  });
  it("never repeats the host it refused", () => {
    expect(JSON.stringify(save("api.openai.com").error?.issues)).not.toContain("api.openai.com");
    expect(JSON.stringify(save("My-Resource.OpenAI.Azure.COM").error?.issues).toLowerCase()).not.toContain("my-resource");
  });
  it("still accepts hosts that are not model hosts, including Google's storage and BigQuery", () => {
    for (const host of ["storage.googleapis.com", "bigquery.googleapis.com", "api.example-pay.com", "api.openai.com.example.net", "oauth2.googleapis.com"]) {
      const result = save(host);
      expect(result.success, `${host} ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });
  it("refuses a company's own gateway host when the schema is made with it, and accepts it without", () => {
    const gateway = "llm.corp-gateway.example.com";
    expect(save(gateway).success).toBe(true);
    const withGateway = testAccountSchemaFor({ gatewayHosts: [gateway] });
    expect(save(gateway, {}, withGateway).success).toBe(false);
    expect(messages(gateway, {}, withGateway)).toContain(TEST_ACCOUNT_MODEL_HOST_SENTENCE);
    expect(save("api.example-pay.com", {}, withGateway).success).toBe(true);
  });
});

describe("using a stored test account that holds a model host", () => {
  // A stored record can hold anything (it did not necessarily come through today's schema), so the use-time check reads the raw hosts.
  const stored = (hosts: string[]) => ({ ...(record("api.example-pay.com") as object), hosts }) as never;
  it("is a production-check problem at its position, so the backing choice refuses it", () => {
    expect(testAccountProdProblems(stored(["api.example-pay.com", "api.openai.com"]), DENY)).toEqual([{ kind: "model_host", field: "hosts[1]" }]);
    expect(testAccountProdProblems(stored(["API.OPENAI.COM."]), DENY)).toEqual([{ kind: "model_host", field: "hosts[0]" }]);
    expect(testAccountProdProblems(stored(["x.openai.azure.com"]), DENY)).toEqual([{ kind: "model_host", field: "hosts[0]" }]);
    expect(testAccountProdProblems(stored(["api.example-pay.com"]), DENY, { modelGatewayHosts: ["api.example-pay.com"] })).toEqual([{ kind: "model_host", field: "hosts[0]" }]);
  });
  it("is found even while the company's production list is empty", () => {
    const kinds = testAccountProdProblems(stored(["api.openai.com"]), { accountIds: [], hosts: [], arnPrefixes: [] }).map((problem) => problem.kind);
    expect(kinds).toContain("model_host");
    expect(kinds).toContain("prod_deny_missing");
  });
  it("finds nothing for an ordinary account or Google's storage host", () => {
    expect(testAccountProdProblems(stored(["api.example-pay.com"]), DENY)).toEqual([]);
    expect(testAccountProdProblems(stored(["storage.googleapis.com", "bigquery.googleapis.com"]), DENY)).toEqual([]);
  });
});
