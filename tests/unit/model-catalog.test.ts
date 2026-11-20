// TE-F0a: the provider-row schema, the built-in rows, the company-gateway rows and the stable digest. Offline: a test fails if anything opens a socket or calls fetch.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectLinearScaling } from "../support/scaling.js";
import { COMPANY_GATEWAY_MAX_PER_PROJECT, CompanyGatewayRowSchema, MODEL_FAMILIES, MODEL_STREAMING_FORMATS, ModelCatalogRowSchema, ModelCatalogSchema, NONE_REDIRECT_SENTENCE, checkCompanyGatewayRows, checkModelHost, type ModelCatalogRow } from "../../packages/contracts/src/model-catalog.js";
import { builtinModelCatalog } from "../../packages/contracts/src/model-catalog-rows.js";
import { modelCatalogDigest, parseModelCatalogBytes } from "../../packages/contracts/src/model-catalog-digest.js";

let connects = 0;
let fetches = 0;
beforeEach(() => {
  connects = 0;
  fetches = 0;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function stub(this: net.Socket) {
    connects += 1;
    throw new Error("a socket was opened in an offline test");
  });
  vi.stubGlobal("fetch", () => {
    fetches += 1;
    throw new Error("fetch was called in an offline test");
  });
});
afterEach(() => {
  expect(connects).toBe(0);
  expect(fetches).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const builtin = (): ModelCatalogRow[] => builtinModelCatalog().rows;
const rowById = (id: string): ModelCatalogRow => {
  const found = builtin().find((row) => row.id === id);
  if (found === undefined) throw new Error(`no built-in row ${id}`);
  return found;
};
const gateway = (over: Record<string, unknown> = {}) => ({ id: "corp-gateway", host: "llm.gateway-corp.example.com", family: "openai_compatible", auth: { scheme: "bearer" }, ...over });
const sampleRow = (over: Record<string, unknown> = {}): Record<string, unknown> => JSON.parse(JSON.stringify({ ...rowById("gemini"), ...over })) as Record<string, unknown>;

describe("row schema", () => {
  it("accepts only the three DEC 174 token hosts as authHosts", () => {
    const authHosts = ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"];
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ authHosts })).success).toBe(true);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ authHosts: [] })).success).toBe(true);
    for (const host of authHosts) expect(ModelCatalogRowSchema.safeParse(sampleRow({ authHosts: [host] })).success, host).toBe(true);
    for (const host of ["eu.api.openai.com", "models.inference.ai.azure.com", "storage.googleapis.com", "auth.example.com", "x.oauth2.googleapis.com", "oauth2.googleapis.com.evil.example.com", "OAUTH2.googleapis.com", "oauth2.googleapis.com."]) {
      const row = sampleRow({ authHosts: [host] });
      expect(ModelCatalogRowSchema.safeParse(row).success, host).toBe(false);
      expect(parseModelCatalogBytes(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, revision: 1, rows: [row] }))).ok, host).toBe(false);
    }
  });
  it("covers every family, auth scheme, redirect kind and streaming format", () => {
    expect([...MODEL_FAMILIES]).toEqual(["openai_compatible", "anthropic_messages", "gemini", "vertex", "bedrock", "cohere"]);
    for (const family of MODEL_FAMILIES.filter((value) => value !== "bedrock" && value !== "vertex")) {
      expect(ModelCatalogRowSchema.safeParse(sampleRow({ id: `r-${family.replace("_", "-")}`, family })).success).toBe(true);
    }
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ family: "mistral" })).success).toBe(false);
    expect([...MODEL_STREAMING_FORMATS]).toEqual(["sse", "aws_event_stream", "json_array", "json_lines"]);
    for (const format of MODEL_STREAMING_FORMATS) expect(ModelCatalogRowSchema.safeParse(sampleRow({ streaming: [format] })).success).toBe(true);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ streaming: ["websocket"] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ streaming: [] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ streaming: ["sse", "sse"] })).success).toBe(false);
    for (const auth of [{ scheme: "bearer" }, { scheme: "header", name: "x-api-key" }, { scheme: "header", name: "api-key" }, { scheme: "header", name: "x-goog-api-key" }]) {
      expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [auth] })).success).toBe(true);
    }
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [{ scheme: "basic" }] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [] })).success).toBe(false);
  });
  it("lets sigv4 only on bedrock rows (which route to the local AWS front) and gcp_oauth only on vertex rows", () => {
    const bedrock = sampleRow({ id: "bedrock", family: "bedrock", hosts: ["bedrock-runtime.us-east-1.amazonaws.com"], auth: [{ scheme: "sigv4" }], streaming: ["aws_event_stream"], routesTo: "local_aws_front" });
    expect(ModelCatalogRowSchema.safeParse(bedrock).success).toBe(true);
    expect(ModelCatalogRowSchema.safeParse({ ...bedrock, routesTo: undefined }).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse({ ...bedrock, routesTo: "helper" }).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ routesTo: "local_aws_front" })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [{ scheme: "sigv4" }] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [{ scheme: "gcp_oauth" }] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ family: "bedrock" })).success).toBe(false);
  });
  it("bounds the lists", () => {
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: [] })).success).toBe(false);
    const many = Array.from({ length: 257 }, (_, index) => `h${String(index)}.example.com`);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: many })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: many.slice(0, 256) })).success).toBe(true);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: [], hostSuffixes: [] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: [], hostSuffixes: ["openai.azure.com", "cognitiveservices.azure.com", "services.ai.azure.com"] })).success).toBe(true);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hostSuffixes: ["com"] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hostSuffixes: ["*.azure.com"] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: ["a.example.com", "a.example.com"] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ notes: Array.from({ length: 21 }, () => "n") })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ notes: ["x".repeat(301)] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ notes: ["tab\there"] })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ id: "A".repeat(3) })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ id: "x".repeat(41) })).success).toBe(false);
  });
  it("accepts only exact lowercase host names in a row", () => {
    for (const bad of ["Generativelanguage.googleapis.com", "https://a.example.com", "a.example.com:443", "a.example.com/v1", "*.example.com", "a.example.com.", "127.0.0.1", "localhost", "a b.example.com", "a_b.example.com", ""]) {
      expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: [bad] })).success, bad).toBe(false);
    }
  });
  it("renders the 'none' redirect as 'not run: client cannot be redirected'", () => {
    expect(NONE_REDIRECT_SENTENCE).toBe("not run: client cannot be redirected");
  });
  it("refuses a catalog with a repeated id or a repeated (host, family)", () => {
    const base = builtinModelCatalog();
    const first = JSON.parse(JSON.stringify(base.rows[0])) as Record<string, unknown>;
    expect(ModelCatalogSchema.safeParse({ ...base, rows: [...base.rows, first] }).success).toBe(false);
    expect(ModelCatalogSchema.safeParse({ ...base, rows: [...base.rows, { ...first, id: "twin" }] }).success).toBe(false);
    expect(ModelCatalogSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
    expect(ModelCatalogSchema.safeParse({ ...base, rows: [] }).success).toBe(false);
  });
});

describe("company-gateway rows", () => {
  it.each([
    ["userinfo", "user@llm.gateway-corp.example.com"],
    ["query", "llm.gateway-corp.example.com?x=1"],
    ["not_public", "gw.corp.internal"],
  ])("refuses a host with the code %s: %j", (code, host) => {
    expect(checkModelHost(host)).toEqual({ ok: false, code });
    const result = checkCompanyGatewayRows([gateway({ host })], builtin());
    expect(result).toMatchObject({ ok: false, issues: [{ index: 0, code }] });
  });
  it("allows at most 20 gateway rows per project", () => {
    expect(COMPANY_GATEWAY_MAX_PER_PROJECT).toBe(20);
    const rows = (count: number) => Array.from({ length: count }, (_, index) => gateway({ id: `gw-${String(index)}`, host: `gw${String(index)}.example.com` }));
    expect(checkCompanyGatewayRows(rows(20), builtin())).toMatchObject({ ok: true });
    expect(checkCompanyGatewayRows(rows(21), builtin())).toMatchObject({ ok: false, issues: [{ code: "too_many" }] });
  });
  it("also treats a built-in row's auth hosts and host suffixes as confusable", () => {
    for (const host of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) {
      expect(checkCompanyGatewayRows([gateway({ host })], builtin()), host).toMatchObject({ ok: false, issues: [{ index: 0, code: "confusable_host" }] });
      expect(checkCompanyGatewayRows([gateway({ host, family: "gemini" })], builtin()), host).toMatchObject({ ok: false, issues: [{ code: "confusable_host" }] });
    }
    expect(checkCompanyGatewayRows([gateway({ host: "mine.openai.azure.com", family: "anthropic_messages" })], builtin())).toMatchObject({ ok: false, issues: [{ code: "confusable_host" }] });
    expect(checkCompanyGatewayRows([gateway({ host: "mine.openai.azure.com", family: "openai_compatible" })], builtin())).toMatchObject({ ok: true });
  });
  it("refuses a repeated id, an id equal to a built-in id, and one host spoken in two shapes", () => {
    expect(checkCompanyGatewayRows([gateway(), gateway({ host: "b.example.com" })], builtin())).toMatchObject({ ok: false, issues: [{ index: 1, code: "duplicate_id" }] });
    expect(checkCompanyGatewayRows([gateway({ id: "gemini" })], builtin())).toMatchObject({ ok: false, issues: [{ code: "duplicate_id" }] });
    expect(checkCompanyGatewayRows([gateway(), gateway({ id: "two", family: "gemini" })], builtin())).toMatchObject({ ok: false, issues: [{ index: 1, code: "confusable_host" }] });
    expect(checkCompanyGatewayRows([gateway(), gateway({ id: "two" })], builtin())).toMatchObject({ ok: false, issues: [{ index: 1, code: "duplicate_host" }] });
  });
  it("keeps to the families a gateway can speak and a plain header or bearer", () => {
    for (const family of ["vertex", "bedrock", "other"]) expect(checkCompanyGatewayRows([gateway({ family })], builtin())).toMatchObject({ ok: false, issues: [{ code: "invalid_row" }] });
    for (const family of ["openai_compatible", "anthropic_messages", "gemini", "cohere"]) expect(CompanyGatewayRowSchema.safeParse(gateway({ family })).success).toBe(true);
    for (const auth of [{ scheme: "sigv4" }, { scheme: "gcp_oauth" }, { scheme: "header" }, { scheme: "header", name: "Authorization" }, { scheme: "header", name: "host" }, { scheme: "header", name: "cookie" }, { scheme: "header", name: "x-a b" }, { scheme: "header", name: "x-forwarded-for" }]) {
      expect(CompanyGatewayRowSchema.safeParse(gateway({ auth })).success, JSON.stringify(auth)).toBe(false);
    }
    expect(CompanyGatewayRowSchema.safeParse(gateway({ auth: { scheme: "header", name: "x-portkey-api-key" } })).success).toBe(true);
    expect(CompanyGatewayRowSchema.safeParse(gateway({ unknown: 1 })).success).toBe(false);
    expect(CompanyGatewayRowSchema.safeParse(JSON.parse(`{"__proto__":{"x":1},"id":"a","host":"a.example.com","family":"gemini","auth":{"scheme":"bearer"}}`)).success).toBe(false);
  });
  it("refuses a non-array without throwing, and a huge host fast", () => {
    expect(checkCompanyGatewayRows("nope", builtin())).toMatchObject({ ok: false, issues: [{ code: "invalid_row" }] });
    expect(checkModelHost("a".repeat(1_000_000))).toEqual({ ok: false, code: "too_long" });
    // Refusing it must not cost more as the host grows (32,000 -> 256,000 characters: the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 1,000,000 characters is checked once above).
    let refusal: ReturnType<typeof checkModelHost> | undefined;
    expectLinearScaling((size) => { const host = "a".repeat(size); return () => { refusal = checkModelHost(host); }; }, { n: 32_000, label: "refusing a huge model host" });
    expect(refusal).toEqual({ ok: false, code: "too_long" });
  });
});

describe("the stable digest and the unsigned parse", () => {
  it("keeps the unsigned parse out of the barrel: only builtinModelCatalog() may feed F1 and F2", async () => {
    const barrel = (await import("../../packages/contracts/src/index.js")) as Record<string, unknown>;
    expect(barrel.parseModelCatalogBytes).toBeUndefined();
    expect(typeof barrel.modelCatalogDigest).toBe("function");
    expect(typeof barrel.builtinModelCatalog).toBe("function");
  });
  it("parses bytes strictly, returns the digest and says it is unsigned", () => {
    const base = builtinModelCatalog();
    const bytes = new TextEncoder().encode(JSON.stringify(base));
    const parsed = parseModelCatalogBytes(bytes);
    expect(parsed).toMatchObject({ ok: true, signed: false, digest: modelCatalogDigest(base) });
    expect(parseModelCatalogBytes(new TextEncoder().encode("{"))).toMatchObject({ ok: false });
    expect(parseModelCatalogBytes(new TextEncoder().encode(JSON.stringify({ ...base, extra: 1 })))).toMatchObject({ ok: false });
    expect(parseModelCatalogBytes(new Uint8Array(2 * 1024 * 1024))).toMatchObject({ ok: false, reason: "the model catalog is too large" });
  });
});
