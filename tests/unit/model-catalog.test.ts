// TE-F0a: the provider-row schema, the built-in rows, the company-gateway rows and the stable digest. Offline: a test fails if anything opens a socket or calls fetch.
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANY_GATEWAY_MAX_PER_PROJECT,
  CompanyGatewayRowSchema,
  MODEL_FAMILIES,
  MODEL_STREAMING_FORMATS,
  ModelCatalogRowSchema,
  ModelCatalogSchema,
  NONE_REDIRECT_SENTENCE,
  checkCompanyGatewayRows,
  checkModelHost,
  type ModelCatalogRow,
} from "../../packages/contracts/src/model-catalog.js";
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

describe("the built-in rows", () => {
  it("parse under the strict schema and cover the first rows of the brief", () => {
    const catalog = ModelCatalogSchema.parse(JSON.parse(JSON.stringify(builtinModelCatalog())));
    const ids = catalog.rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["gemini", "vertex", "gemini-openai", "openrouter", "cloudflare-ai-gateway", "vercel-ai-gateway", "portkey"]));
    expect(catalog.rows.filter((row) => row.kind === "hosted_gateway").map((row) => row.id).sort()).toEqual(["cloudflare-ai-gateway", "openrouter", "portkey", "vercel-ai-gateway"]);
  });
  it("takes the Gemini facts from the redirect check", () => {
    const gemini = rowById("gemini");
    expect(gemini.hosts).toEqual(["generativelanguage.googleapis.com"]);
    expect(gemini.family).toBe("gemini");
    expect(gemini.auth).toEqual([{ scheme: "header", name: "x-goog-api-key" }]);
    expect(gemini.streaming).toEqual(["sse", "json_array"]);
    const env = gemini.redirect.find((method) => method.kind === "env_var");
    expect(env).toMatchObject({ kind: "env_var", names: ["GOOGLE_GEMINI_BASE_URL"], verified: true });
    // The AI SDK and LangChain JS honour no variable: they are an SDK option, and the legacy gRPC default is not a redirect at all.
    const sdk = gemini.redirect.filter((method) => method.kind === "sdk_option").map((method) => method.client).join("|");
    expect(sdk).toContain("@ai-sdk/google");
    expect(sdk).toContain("@langchain/google-genai");
    expect(gemini.redirect.some((method) => method.kind === "none" && method.client.includes("gRPC"))).toBe(true);
  });
  it("lists Vertex by exact names, the metadata variables, and the token hosts it blocks", () => {
    const vertex = rowById("vertex");
    expect(vertex.family).toBe("vertex");
    expect(vertex.hosts).toContain("aiplatform.googleapis.com");
    expect(vertex.hosts).toContain("us-central1-aiplatform.googleapis.com");
    expect(vertex.hosts.every((host) => !host.includes("*"))).toBe(true);
    expect(vertex.authHosts).toEqual(["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"]);
    expect(vertex.auth.map((auth) => auth.scheme).sort()).toEqual(["gcp_oauth", "header"]);
    const env = vertex.redirect.find((method) => method.kind === "env_var" && method.names.includes("GOOGLE_VERTEX_BASE_URL"));
    expect(env).toMatchObject({ companion: expect.arrayContaining(["GCE_METADATA_HOST", "GCE_METADATA_IP"]) as unknown });
  });
  it("serves Gemini through Google's OpenAI-compatible endpoint as the openai_compatible family", () => {
    const row = rowById("gemini-openai");
    expect(row.family).toBe("openai_compatible");
    expect(row.pathPrefix).toBe("/v1beta/openai");
    expect(row.hosts).toEqual(["generativelanguage.googleapis.com"]);
    expect(row.auth).toEqual([{ scheme: "bearer" }]);
    expect(row.redirect[0]).toMatchObject({ kind: "env_var", names: ["OPENAI_BASE_URL"], verified: true });
    expect(row.streaming).toEqual(["sse"]);
  });
  it("marks what the redirect check calls UNVERIFIED as unverified, in the data and in the notes", () => {
    const text = JSON.stringify(builtinModelCatalog());
    expect(rowById("vertex").redirect.some((method) => method.verified === false)).toBe(true);
    expect(rowById("gemini").notes.some((note) => note.startsWith("UNVERIFIED") && note.includes("enum"))).toBe(true);
    expect(rowById("gemini").notes.some((note) => note.startsWith("UNVERIFIED") && note.includes("Live API"))).toBe(true);
    expect(rowById("vertex").notes.some((note) => note.startsWith("UNVERIFIED") && note.includes("location"))).toBe(true);
    // The hosted gateways were not part of the redirect check: every one of their redirects is unverified.
    for (const id of ["openrouter", "cloudflare-ai-gateway", "vercel-ai-gateway", "portkey"]) expect(rowById(id).redirect.every((method) => !method.verified)).toBe(true);
    expect(text).not.toMatch(/AIza|sk-[A-Za-z0-9]{10}|-----BEGIN/u);
  });
  it("gives every row the five error-shape ids F2 will fill", () => {
    for (const row of builtin()) expect(Object.keys(row.errors).sort()).toEqual(["badToolJson", "cutOffStream", "rateLimit", "refusal", "tokenLimit"]);
  });
  it("keeps one row per (host, family) so routing is never ambiguous", () => {
    const pairs = builtin().flatMap((row) => row.hosts.map((host) => `${host}|${row.family}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

describe("row schema", () => {
  it("accepts a built-in row round-tripped through JSON", () => {
    expect(ModelCatalogRowSchema.safeParse(sampleRow()).success).toBe(true);
  });
  it("refuses unknown keys at every level", () => {
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ extra: 1 })).success).toBe(false);
    const nested = sampleRow();
    (nested.errors as Record<string, unknown>).other = "x";
    expect(ModelCatalogRowSchema.safeParse(nested).success).toBe(false);
    const auth = sampleRow({ auth: [{ scheme: "bearer", extra: true }] });
    expect(ModelCatalogRowSchema.safeParse(auth).success).toBe(false);
    const redirect = sampleRow();
    ((redirect.redirect as Record<string, unknown>[])[0] as Record<string, unknown>).extra = 1;
    expect(ModelCatalogRowSchema.safeParse(redirect).success).toBe(false);
  });
  it("refuses a __proto__ key and does not pollute the prototype", () => {
    const hostile = JSON.parse(`{"__proto__":{"polluted":true},"id":"x"}`) as unknown;
    expect(ModelCatalogRowSchema.safeParse(hostile).success).toBe(false);
    const hostileCatalog = JSON.parse(`{"schemaVersion":1,"revision":1,"rows":[],"__proto__":{"polluted":true}}`) as unknown;
    expect(ModelCatalogSchema.safeParse(hostileCatalog).success).toBe(false);
    const nested = JSON.parse(`{"scheme":"bearer","__proto__":{"polluted":true}}`) as unknown;
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ auth: [nested] })).success).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
    const many = Array.from({ length: 65 }, (_, index) => `h${String(index)}.example.com`);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: many })).success).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ hosts: many.slice(0, 64) })).success).toBe(true);
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
  it("checks env-var names, path prefixes and the redirect kinds", () => {
    const withRedirect = (redirect: unknown[]) => ModelCatalogRowSchema.safeParse(sampleRow({ redirect }));
    expect(withRedirect([{ kind: "env_var", client: "c", names: ["lower"], companion: [], verified: true }]).success).toBe(false);
    expect(withRedirect([{ kind: "env_var", client: "c", names: [], companion: [], verified: true }]).success).toBe(false);
    expect(withRedirect([{ kind: "env_var", client: "c", names: ["A"], companion: [], verified: true }]).success).toBe(true);
    expect(withRedirect([{ kind: "sdk_option", client: "c", option: "baseUrl", needsRestTransport: false, verified: true }]).success).toBe(true);
    expect(withRedirect([{ kind: "dns_in_sealed_network", client: "c", verified: false }]).success).toBe(true);
    expect(withRedirect([{ kind: "none", client: "c", verified: true }]).success).toBe(true);
    expect(withRedirect([{ kind: "proxy", client: "c", verified: true }]).success).toBe(false);
    expect(withRedirect([]).success).toBe(false);
    for (const pathPrefix of ["v1", "/v1/", "/v1?x=1", "/../v1", "/a//b", "/v1 beta"]) expect(ModelCatalogRowSchema.safeParse(sampleRow({ pathPrefix })).success, pathPrefix).toBe(false);
    expect(ModelCatalogRowSchema.safeParse(sampleRow({ pathPrefix: "/api/v1" })).success).toBe(true);
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
  it("accepts a plain public HTTPS host", () => {
    const parsed = CompanyGatewayRowSchema.parse(gateway({ auth: { scheme: "header", name: "x-gateway-key" }, pathPrefix: "/litellm" }));
    expect(parsed.host).toBe("llm.gateway-corp.example.com");
    expect(checkCompanyGatewayRows([gateway()], builtin())).toMatchObject({ ok: true });
  });
  it.each([
    ["scheme", "https://llm.gateway-corp.example.com"],
    ["userinfo", "user@llm.gateway-corp.example.com"],
    ["wildcard", "*.gateway-corp.example.com"],
    ["path", "llm.gateway-corp.example.com/v1"],
    ["query", "llm.gateway-corp.example.com?x=1"],
    ["port", "llm.gateway-corp.example.com:8443"],
    ["port", "llm.gateway-corp.example.com:0"],
    ["ip_literal", "127.0.0.1"],
    ["ip_literal", "10.1.2.3"],
    ["ip_literal", "169.254.169.254"],
    ["ip_literal", "2130706433"],
    ["ip_literal", "0x7f.0.0.1"],
    ["ip_literal", "127.1"],
    ["ip_literal", "[::1]"],
    ["ip_literal", "::1"],
    ["ip_literal", "[2001:db8::1]:443"],
    ["ip_literal", "1.2.3.4.5"],
    ["localhost", "localhost"],
    ["localhost", "api.localhost"],
    ["not_public", "intranet"],
    ["not_public", "gw.corp.internal"],
    ["not_public", "gw.corp.local"],
    ["not_public", "127.0.0.1.nip.io"],
    ["not_lowercase", "LLM.gateway-corp.example.com"],
    ["bad_label", "gw..example.com"],
    ["bad_label", "gw.example.com."],
    ["bad_label", "-gw.example.com"],
    ["bad_label", "g_w.example.com"],
    ["bad_characters", "gw example.com"],
    ["bad_characters", "gw.exämple.com"],
    ["bad_characters", "gw.example.com\n"],
    ["too_long", `${"a".repeat(250)}.example.com`],
    ["empty", ""],
  ])("refuses a host with the code %s: %j", (code, host) => {
    expect(checkModelHost(host)).toEqual({ ok: false, code });
    const result = checkCompanyGatewayRows([gateway({ host })], builtin());
    expect(result).toMatchObject({ ok: false, issues: [{ index: 0, code }] });
  });
  it("refuses a host with a 64-character label", () => {
    expect(checkModelHost(`${"a".repeat(64)}.example.com`)).toMatchObject({ ok: false, code: "bad_label" });
  });
  it("does not echo the refused host in its words", () => {
    const result = checkCompanyGatewayRows([gateway({ host: "https://evil.example.com/steal?token=abc" })], builtin());
    expect(JSON.stringify(result)).not.toContain("evil.example.com");
  });
  it("allows at most 20 gateway rows per project", () => {
    expect(COMPANY_GATEWAY_MAX_PER_PROJECT).toBe(20);
    const rows = (count: number) => Array.from({ length: count }, (_, index) => gateway({ id: `gw-${String(index)}`, host: `gw${String(index)}.example.com` }));
    expect(checkCompanyGatewayRows(rows(20), builtin())).toMatchObject({ ok: true });
    expect(checkCompanyGatewayRows(rows(21), builtin())).toMatchObject({ ok: false, issues: [{ code: "too_many" }] });
  });
  it("refuses a host equal to a built-in row's host with a different family (confusable)", () => {
    expect(checkCompanyGatewayRows([gateway({ host: "generativelanguage.googleapis.com", family: "anthropic_messages" })], builtin())).toMatchObject({ ok: false, issues: [{ index: 0, code: "confusable_host" }] });
    expect(checkCompanyGatewayRows([gateway({ host: "openrouter.ai", family: "gemini" })], builtin())).toMatchObject({ ok: false, issues: [{ code: "confusable_host" }] });
    // The same family as a built-in row on that host is not confusable.
    expect(checkCompanyGatewayRows([gateway({ host: "openrouter.ai", family: "openai_compatible" })], builtin())).toMatchObject({ ok: true });
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
    const started = Date.now();
    expect(checkModelHost("a".repeat(1_000_000))).toEqual({ ok: false, code: "too_long" });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("the stable digest and the unsigned parse", () => {
  it("is the same whatever the key order and changes with any row change", () => {
    const base = builtinModelCatalog();
    const reverseKeys = (value: unknown): unknown => (Array.isArray(value) ? value.map(reverseKeys) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)])) : value);
    const reordered = reverseKeys(base) as typeof base;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base));
    expect(modelCatalogDigest(base)).toMatch(/^[a-f0-9]{64}$/u);
    expect(modelCatalogDigest(reordered)).toBe(modelCatalogDigest(base));
    const changed = JSON.parse(JSON.stringify(base)) as typeof base;
    changed.rows[0]!.hosts = [...changed.rows[0]!.hosts, "extra.example.com"];
    expect(modelCatalogDigest(changed)).not.toBe(modelCatalogDigest(base));
    expect(modelCatalogDigest({ ...base, revision: base.revision + 1 })).not.toBe(modelCatalogDigest(base));
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
