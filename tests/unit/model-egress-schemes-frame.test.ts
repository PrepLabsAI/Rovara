// TE-F1a: the schemes, the egress row and the frame: strict parse, unknown keys, `__proto__`, oversized lists, every enum.
import { describe, expect, it } from "vitest";
import {
  MODEL_EGRESS_BODY_MAX_BYTES, builtinModelCatalog, MODEL_EGRESS_SCHEMES as SCHEMES, MODEL_EGRESS_REFUSALS, MODEL_EGRESS_SCHEMES, ModelEgressConnectionSchema, ModelEgressFrameSchema, ModelEgressSchemeSchema, gatewayEgressRow, parseModelEgressFrame, parseModelEgressRow,
  type CompanyGatewayRow,
} from "@agentx/contracts";
import { fixtureEgressRows } from "../../packages/testing/src/ports/model-egress-fixtures.js";

const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ row: "gemini", method: "POST", path: "/v1beta/models/m:generateContent", query: "", headers: [], body: new Uint8Array(2), ...over });
const rowJson = (name: keyof ReturnType<typeof fixtureEgressRows>): Record<string, unknown> => JSON.parse(JSON.stringify(fixtureEgressRows()[name])) as Record<string, unknown>;

describe("the scheme enum", () => {
  it("is exactly the eight schemes, and nothing else parses", () => {
    expect([...MODEL_EGRESS_SCHEMES]).toEqual(["bearer", "header:x-goog-api-key", "header:x-api-key", "header:api-key", "query:key", "gcp-oauth:federation", "gcp-oauth:key-file", "sigv4"]);
    for (const scheme of MODEL_EGRESS_SCHEMES) expect(ModelEgressSchemeSchema.safeParse(scheme).success).toBe(true);
    for (const bad of ["Bearer", "header:authorization", "header:", "basic", "", "gcp-oauth", 1, null]) expect(ModelEgressSchemeSchema.safeParse(bad).success).toBe(false);
  });
  it("has the ten refusal words", () => {
    expect([...MODEL_EGRESS_REFUSALS].sort()).toEqual(["bad_request", "cap", "key_refused", "not_allowed", "not_found", "overloaded", "quota", "rate_limit", "ssrf", "too_large"]);
  });
});

describe("the model-egress row is F0a's catalog row plus the egress fields", () => {
  it("parses every fixture row, and the result is the catalog row with the extras", () => {
    for (const [name, row] of Object.entries(fixtureEgressRows())) {
      const parsed = parseModelEgressRow(JSON.parse(JSON.stringify(row)));
      expect(parsed.ok, name).toBe(true);
    }
  });
  it("refuses an unknown key, in the catalog part and in the egress part, and a __proto__ key", () => {
    expect(parseModelEgressRow({ ...rowJson("openai"), surprise: 1 }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), prices: [{ model: "m", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, extra: true }] }).ok).toBe(false);
    const proto = JSON.parse(`{"__proto__": {"scheme": "bearer"}}`) as Record<string, unknown>;
    expect(parseModelEgressRow({ ...rowJson("openai"), ...proto }).ok).toBe(false);
    expect(parseModelEgressRow(JSON.parse(`${JSON.stringify(rowJson("openai")).slice(0, -1)},"__proto__":{"polluted":true}}`)).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("refuses a scheme the catalog row does not list, sigv4 off a bedrock row, a token scheme off a vertex row, and a duplicate price", () => {
    expect(parseModelEgressRow({ ...rowJson("openai"), scheme: "header:x-api-key" }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), scheme: "sigv4" }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("anthropic"), scheme: "gcp-oauth:federation" }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("bedrock"), scheme: "bearer" }).ok).toBe(false);
    const twice = [{ model: "m", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }, { model: "m", inputMicrosPerMTok: 2, outputMicrosPerMTok: 2 }];
    expect(parseModelEgressRow({ ...rowJson("openai"), prices: twice }).ok).toBe(false);
  });
  it("takes the legacy query:key scheme for a Gemini row only", () => {
    expect(parseModelEgressRow({ ...rowJson("gemini"), scheme: "query:key" }).ok).toBe(true);
    expect(parseModelEgressRow({ ...rowJson("openai"), scheme: "query:key" }).ok).toBe(false);
  });
  it("accepts either Google token scheme on a vertex row (federation versus key file is the source record's choice)", () => {
    expect(parseModelEgressRow({ ...rowJson("vertex"), scheme: "gcp-oauth:key-file" }).ok).toBe(true);
    expect(parseModelEgressRow({ ...rowJson("vertex"), scheme: "gcp-oauth:federation" }).ok).toBe(true);
  });
  it("bounds the lists and the numbers: too many prices, a negative or fractional price, a zero or huge default", () => {
    const many = Array.from({ length: 257 }, (_, index) => ({ model: `m${String(index)}`, inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }));
    expect(parseModelEgressRow({ ...rowJson("openai"), prices: many }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), prices: [{ model: "m", inputMicrosPerMTok: -1, outputMicrosPerMTok: 1 }] }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), prices: [{ model: "m", inputMicrosPerMTok: 1.5, outputMicrosPerMTok: 1 }] }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), defaultMaxOutputTokens: 0 }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("openai"), defaultMaxOutputTokens: 10_000_001 }).ok).toBe(false);
  });
  it("keeps Azure to an openai_compatible row that sends api-key", () => {
    expect(parseModelEgressRow({ ...rowJson("azure") }).ok).toBe(true);
    expect(parseModelEgressRow({ ...rowJson("openai"), azure: { deployment: "d", apiVersion: "2024-06-01" } }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("azure"), azure: { deployment: "../d", apiVersion: "2024-06-01" } }).ok).toBe(false);
    expect(parseModelEgressRow({ ...rowJson("azure"), azure: { deployment: "d", apiVersion: "latest" } }).ok).toBe(false);
  });
  it("refuses a non-object, an array and null without throwing", () => {
    for (const input of [null, [], "row", 3, undefined]) expect(parseModelEgressRow(input).ok).toBe(false);
  });
  it("turns a company gateway row into an egress row, and refuses a gateway header the scheme list does not name", () => {
    const bearer: CompanyGatewayRow = { id: "acme-litellm", host: "llm.acme.example.com", family: "openai_compatible", auth: { scheme: "bearer" }, pathPrefix: "/litellm" };
    const made = gatewayEgressRow(bearer, { defaultMaxOutputTokens: 512, prices: [] });
    expect(made).toMatchObject({ id: "acme-litellm", hosts: ["llm.acme.example.com"], scheme: "bearer", pathPrefix: "/litellm" });
    const custom: CompanyGatewayRow = { ...bearer, auth: { scheme: "header", name: "x-portkey-api-key" } };
    expect(gatewayEgressRow(custom, { defaultMaxOutputTokens: 512, prices: [] })).toBeUndefined();
    const xApiKey: CompanyGatewayRow = { ...bearer, family: "anthropic_messages", auth: { scheme: "header", name: "x-api-key" } };
    expect(gatewayEgressRow(xApiKey, { defaultMaxOutputTokens: 512, prices: [] })?.scheme).toBe("header:x-api-key");
  });
});

describe("F0a's built-in catalog rows as egress rows", () => {
  const schemeFor = (auth: { scheme: string; name?: string }): string | undefined => {
    if (auth.scheme === "bearer") return "bearer";
    if (auth.scheme === "gcp_oauth") return "gcp-oauth:federation";
    if (auth.scheme === "sigv4") return "sigv4";
    const candidate = `header:${auth.name ?? ""}`;
    return (SCHEMES as readonly string[]).includes(candidate) ? candidate : undefined;
  };
  it("every built-in row parses with a scheme the egress enum names, except the ones whose only key header is a custom one (a recorded gap)", () => {
    const gaps: string[] = [];
    for (const catalogRow of builtinModelCatalog().rows) {
      const scheme = catalogRow.auth.map(schemeFor).find((candidate) => candidate !== undefined);
      if (scheme === undefined) {
        gaps.push(catalogRow.id);
        continue;
      }
      const extra = scheme === "sigv4" ? { scheme } : { scheme, ...(catalogRow.id === "azure-openai" ? { azure: { deployment: "d", apiVersion: "2024-06-01" } } : {}) };
      const parsed = parseModelEgressRow({ ...JSON.parse(JSON.stringify(catalogRow)), defaultMaxOutputTokens: 1024, prices: [], ...extra });
      expect(parsed.ok, `${catalogRow.id}: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
    }
    expect(gaps).toEqual(["portkey"]);
  });
  it("the Azure row names a host suffix and no host: the host comes from the connection", () => {
    const azure = builtinModelCatalog().rows.find((row) => row.id === "azure-openai");
    expect(azure?.hosts).toEqual([]);
    // code/next (the catalog rows after F0a) lists the three documented Azure OpenAI and Foundry suffixes; the row still names no host.
    expect(azure?.hostSuffixes).toEqual(["openai.azure.com", "cognitiveservices.azure.com", "services.ai.azure.com"]);
  });
});

describe("the connection", () => {
  it("holds only a Vertex project and location, strictly", () => {
    expect(ModelEgressConnectionSchema.safeParse({}).success).toBe(true);
    expect(ModelEgressConnectionSchema.safeParse({ vertex: { project: "fixture-project-1", location: "us-central1" } }).success).toBe(true);
    expect(ModelEgressConnectionSchema.safeParse({ vertex: { project: "p", location: "us-central1" } }).success).toBe(false);
    expect(ModelEgressConnectionSchema.safeParse({ vertex: { project: "fixture-project-1", location: "us-central1", extra: 1 } }).success).toBe(false);
    expect(ModelEgressConnectionSchema.safeParse({ company: "x" }).success).toBe(false);
  });
});

describe("the frame", () => {
  it("parses a well-formed frame", () => {
    expect(parseModelEgressFrame(frame()).ok).toBe(true);
  });
  it("never names a company, project or source: each such key is refused like any unknown key", () => {
    for (const key of ["company", "orgId", "org", "project", "projectId", "source", "sourceId", "task", "scope", "host", "url"]) {
      const parsed = parseModelEgressFrame(frame({ [key]: "x" }));
      expect(parsed, key).toEqual({ ok: false, refusal: "bad_request" });
    }
    expect(Object.keys(ModelEgressFrameSchema.shape).sort()).toEqual(["body", "headers", "method", "path", "query", "row"]);
  });
  it("is __proto__ safe", () => {
    const hostile = JSON.parse(`{"row":"gemini","method":"POST","path":"/x","query":"","headers":[],"__proto__":{"admin":true}}`) as Record<string, unknown>;
    expect(parseModelEgressFrame({ ...hostile, body: new Uint8Array(0) })).toEqual({ ok: false, refusal: "bad_request" });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
  it("refuses a bad row id, a non-bytes body, headers that are not pairs, and more than 64 headers", () => {
    for (const row of ["Gemini", "1gem", "", "a".repeat(41), "a b"]) expect(parseModelEgressFrame(frame({ row })).ok, row).toBe(false);
    expect(parseModelEgressFrame(frame({ body: "text" })).ok).toBe(false);
    expect(parseModelEgressFrame(frame({ headers: [["a"]] })).ok).toBe(false);
    expect(parseModelEgressFrame(frame({ headers: { a: "b" } })).ok).toBe(false);
    expect(parseModelEgressFrame(frame({ headers: Array.from({ length: 65 }, () => ["a", "b"]) })).ok).toBe(false);
  });
  it("caps the body at 5 MB, exactly", () => {
    expect(parseModelEgressFrame(frame({ body: new Uint8Array(MODEL_EGRESS_BODY_MAX_BYTES) })).ok).toBe(true);
    expect(parseModelEgressFrame(frame({ body: new Uint8Array(MODEL_EGRESS_BODY_MAX_BYTES + 1) }))).toEqual({ ok: false, refusal: "too_large" });
  });
  it("says too_large for a path or query over the parse bound", () => {
    expect(parseModelEgressFrame(frame({ path: `/${"a".repeat(4096)}` }))).toEqual({ ok: false, refusal: "too_large" });
    expect(parseModelEgressFrame(frame({ query: "a".repeat(4097) }))).toEqual({ ok: false, refusal: "too_large" });
  });
  it("does not echo the input in a refusal", () => {
    const parsed = parseModelEgressFrame(frame({ company: "secret-company-name" }));
    expect(JSON.stringify(parsed)).not.toContain("secret-company-name");
  });
});
