// TE-F1a: building the outbound request: the per-family path, query and header rules (SSRF and header injection), and credential injection per scheme (every inbound credential dropped first, exactly one added).
import { describe, expect, it } from "vitest";
import {
  buildOutboundRequest, checkEgressPathSyntax, countCredentials, dropInboundCredentials, isInboundCredentialHeader, normalizeHeaderName, parseModelEgressFrame, routeEgressRequest, SIGV4_NOT_RUN_SENTENCE,
  type ModelEgressFrame, type ModelEgressRow,
} from "@agentx/contracts";
import { FIXTURE_VERTEX_CONNECTION, fixtureEgressRows, fixtureKey, fixtureToken } from "../../packages/testing/src/ports/model-egress-fixtures.js";

/** A planted inbound credential value, built at runtime (the public repository refuses key-shaped literals). */
const inb = (name: string): string => ["inbound", "secret", name].join("-");
const rows = fixtureEgressRows();
const body = new TextEncoder().encode(JSON.stringify({ model: "fixture-small", messages: [] }));
function frame(row: ModelEgressRow, over: Partial<Record<keyof ModelEgressFrame, unknown>> = {}): ModelEgressFrame {
  const parsed = parseModelEgressFrame({ row: row.id, method: "POST", path: "/", query: "", headers: [], body, ...over });
  if (!parsed.ok) throw new Error(`test frame refused: ${parsed.refusal}`);
  return parsed.frame;
}
const route = (row: ModelEgressRow, path: string, extra: Partial<Record<keyof ModelEgressFrame, unknown>> = {}) => routeEgressRequest(row, FIXTURE_VERTEX_CONNECTION, frame(row, { path, ...extra }));
const refusal = (result: ReturnType<typeof route>) => (result.ok ? "ok" : result.refusal);

describe("path syntax: the forms no client sends", () => {
  const bad: Array<[string, string, string]> = [
    ["dot-dot", "/v1beta/models/../x:generateContent", "bad_request"],
    ["dot-dot at the end", "/v1beta/models/..", "bad_request"],
    ["single dot", "/v1beta/./models/m:generateContent", "bad_request"],
    ["encoded slash lower", "/v1beta/models%2fm:generateContent", "bad_request"],
    ["encoded slash upper", "/v1beta/models%2Fm:generateContent", "bad_request"],
    ["double-encoded slash", "/v1beta/models%252fm:generateContent", "bad_request"],
    ["encoded dot-dot", "/v1beta/%2e%2e/x", "bad_request"],
    ["encoded backslash", "/v1beta/models%5cm", "bad_request"],
    ["at sign", "/v1beta/models/m@evil.test:generateContent", "bad_request"],
    ["backslash", "/v1beta\\models/m:generateContent", "bad_request"],
    ["absolute-form http", "http://evil.test/v1beta/models/m:generateContent", "bad_request"],
    ["absolute-form https", "https://evil.test/", "bad_request"],
    ["scheme-relative", "//evil.test/v1beta/models/m:generateContent", "bad_request"],
    ["no leading slash", "v1beta/models/m:generateContent", "bad_request"],
    ["a second question mark", "/v1beta/models/m:generateContent?x", "bad_request"],
    ["a fragment", "/v1beta/models/m:generateContent#x", "bad_request"],
    ["a newline", "/v1beta/models/m:generateContent\nX-Evil: 1", "bad_request"],
    ["a carriage return", "/v1beta/models/m\r:generateContent", "bad_request"],
    ["a NUL", "/v1beta/models/m\u0000:generateContent", "bad_request"],
    ["a tab", "/v1beta/models/m\t:generateContent", "bad_request"],
    ["a space", "/v1beta/models/m :generateContent", "bad_request"],
    ["a semicolon parameter", "/v1beta/models/m:generateContent;x=1", "bad_request"],
    ["a non-ASCII letter", "/v1beta/models/mé:generateContent", "bad_request"],
    ["an empty segment", "/v1beta//models/m:generateContent", "bad_request"],
    ["a trailing slash", "/v1beta/models/m:generateContent/", "bad_request"],
    ["an over-long path", `/v1beta/models/${"a".repeat(600)}:generateContent`, "too_large"],
  ];
  for (const [label, path, expected] of bad) {
    it(`refuses ${label}`, () => {
      expect(checkEgressPathSyntax(path)).toMatchObject({ ok: false, refusal: expected });
      expect(refusal(route(rows.gemini, path))).toBe(expected);
    });
  }
  it("a refusal's description never repeats the refused text", () => {
    expect(JSON.stringify(route(rows.gemini, "/v1beta/models/m@evil.test:generateContent"))).not.toContain("evil");
  });
  it("accepts the plain path", () => {
    expect(checkEgressPathSyntax("/v1beta/models/gemini-2.5-flash:generateContent")).toBeUndefined();
  });
});

describe("methods", () => {
  it("refuses CONNECT and every method but POST by name", () => {
    for (const method of ["CONNECT", "GET", "PUT", "DELETE", "OPTIONS", "post", "PATCH", "HEAD"]) {
      expect(refusal(route(rows.gemini, "/v1beta/models/m:generateContent", { method })), method).toBe("not_allowed");
    }
  });
});

describe("query keys", () => {
  const path = "/v1beta/models/m:streamGenerateContent";
  it("allows alt and $alt on Gemini and Vertex, canonically spelled", () => {
    const sse = route(rows.gemini, path, { query: "alt=sse" });
    expect(sse.ok && sse.query).toEqual([["alt", "sse"]]);
    const legacy = route(rows.gemini, path, { query: "%24alt=json;enum-encoding=int" });
    expect(legacy.ok && legacy.query).toEqual([["$alt", "json;enum-encoding=int"]]);
  });
  it("removes the inbound key parameter in every case and encoding, duplicates included", () => {
    const routed = route(rows.gemini, path, { query: "key=a&KEY=b&Key=c&ke%79=d&alt=sse&key=e" });
    expect(routed.ok && routed.query).toEqual([["alt", "sse"]]);
  });
  it("refuses any other query key by name", () => {
    for (const query of ["foo=1", "access_token=x", "api_key=x", "apikey=x", "alt=sse&foo=1", "%256bey=x", "api-version=2024-06-01"]) expect(refusal(route(rows.gemini, path, { query })), query).toBe("not_allowed");
    expect(refusal(route(rows.openai, "/v1/chat/completions", { query: "alt=sse" }))).toBe("not_allowed");
  });
  it("holds query values to letters, digits, underscore and hyphen (with the one legacy Gemini value spelled exactly)", () => {
    for (const value of ["a.b", "a~b", "a,b", "a:b", "a;b", "a=b", "a/b", "a+b", "a*b", "json;enum-encoding=str", "json;enum-encoding=int;x"]) expect(refusal(route(rows.gemini, "/v1beta/models/m:streamGenerateContent", { query: `alt=${value}` })), value).toBe("bad_request");
    for (const value of ["sse", "json", "a_b-C9", ""]) expect(route(rows.gemini, "/v1beta/models/m:streamGenerateContent", { query: `alt=${value}` }).ok, value).toBe(true);
    expect(route(rows.gemini, "/v1beta/models/m:streamGenerateContent", { query: "%24alt=json;enum-encoding=int" }).ok).toBe(true);
    expect(route(rows.gemini, "/v1beta/models/m:streamGenerateContent", { query: "alt=json;enum-encoding=int" }).ok).toBe(true);
    expect(refusal(route(rows.azure, "/openai/deployments/fixture-small/chat/completions", { query: "api-version=2024.06.01" }))).toBe("bad_request");
  });
  it("refuses alt and $alt together, in any order and encoding, and the legacy alt value on any other key (review L6, L7)", () => {
    const path = "/v1beta/models/m:streamGenerateContent";
    for (const query of ["alt=sse&%24alt=json", "$alt=json&alt=sse", "alt=sse&alt=sse", "%24alt=sse&$alt=sse"]) expect(refusal(route(rows.gemini, path, { query })), query).toBe("bad_request");
    expect(route(rows.gemini, path, { query: "$alt=sse" }).ok).toBe(true);
    // The legacy value is for alt and $alt only.
    expect(refusal(route(rows.azure, "/openai/deployments/fixture-small/chat/completions", { query: "api-version=json;enum-encoding=int" }))).toBe("bad_request");
    expect(refusal(route(rows.gemini, path, { query: "alt=json;enum-encoding=int&alt=sse" }))).toBe("bad_request");
  });
  it("refuses a second question mark, a fragment, a duplicate allowed key, a percent value and an over-long query", () => {
    for (const query of ["alt=sse?x", "alt=sse#x", "alt=sse&alt=json", "alt=%73se", "alt=a b"]) expect(refusal(route(rows.gemini, path, { query })), query).toBe("bad_request");
    expect(refusal(route(rows.gemini, path, { query: `alt=${"a".repeat(2000)}` }))).toBe("too_large");
  });
  it("an Azure row requires its own api-version", () => {
    const deployment = "/openai/deployments/fixture-small/chat/completions";
    expect(route(rows.azure, deployment, { query: "api-version=2024-06-01" }).ok).toBe(true);
    expect(refusal(route(rows.azure, deployment))).toBe("not_allowed");
    expect(refusal(route(rows.azure, deployment, { query: "api-version=2023-01-01" }))).toBe("not_allowed");
  });
});

describe("the family path allow lists", () => {
  it("Gemini: any version prefix, the five operations, nothing else", () => {
    for (const version of ["v1", "v1beta", "v1alpha", "v1beta1", "v2"]) {
      for (const op of ["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"]) expect(route(rows.gemini, `/${version}/models/gemini-2.5-flash:${op}`).ok, `${version} ${op}`).toBe(true);
    }
    for (const path of ["/v1beta/models", "/v1beta/models/m", "/v1beta/models/m:predict", "/v1beta/models/m:generateContent/x", "/v1beta/tunedModels/m:generateContent", "/v1beta/files", "/models/m:generateContent", "/vx/models/m:generateContent", "/v1beta/models/:generateContent"]) {
      expect(refusal(route(rows.gemini, path)), path).toBe("not_allowed");
    }
  });
  it("Gemini: the stream operation is streamed, the others are not", () => {
    const stream = route(rows.gemini, "/v1beta/models/m:streamGenerateContent");
    const plain = route(rows.gemini, "/v1beta/models/m:generateContent");
    expect(stream.ok && stream.streaming).toBe("always");
    expect(plain.ok && plain.streaming).toBe("never");
    expect(stream.ok && stream.model).toBe("m");
  });
  it("OpenAI: chat/completions, responses, embeddings under /v1; nothing else", () => {
    for (const tail of ["chat/completions", "responses", "embeddings"]) {
      const routed = route(rows.openai, `/v1/${tail}`);
      expect(routed.ok && routed.path).toBe(`/v1/${tail}`);
    }
    // The proxy builds the path: a base URL without a version still reaches `/v1`.
    const bare = route(rows.openai, "/chat/completions");
    expect(bare.ok && bare.path).toBe("/v1/chat/completions");
    for (const path of ["/v1/models", "/v1/files", "/v1/chat/completions/x", "/v1/assistants", "/v1/audio/speech", "/v1/images/generations", "/v1/fine_tuning/jobs"]) expect(refusal(route(rows.openai, path)), path).toBe("not_allowed");
  });
  it("OpenAI with a row prefix: the prefix is added once whether or not the client sent it, and the version is not doubled", () => {
    for (const path of ["/chat/completions", "/v1/chat/completions", "/api/v1/chat/completions"]) {
      const routed = route(rows.openrouter, path);
      expect(routed.ok && routed.path, path).toBe("/api/v1/chat/completions");
      expect(routed.ok && routed.host).toBe("openrouter.ai");
    }
    expect(refusal(route(rows.openrouter, "/api/v1/models"))).toBe("not_allowed");
  });
  it("Anthropic: messages and count_tokens only", () => {
    expect(route(rows.anthropic, "/v1/messages").ok).toBe(true);
    expect(route(rows.anthropic, "/v1/messages/count_tokens").ok).toBe(true);
    // The proxy builds the provider path: a base URL without the version still reaches `/v1`.
    const bare = route(rows.anthropic, "/messages");
    expect(bare.ok && bare.path).toBe("/v1/messages");
    expect(bare.ok && bare.host).toBe("api.anthropic.com");
    for (const path of ["/v1/complete", "/v1/messages/batches", "/v1/models", "/v1/messages/count_tokens/x"]) expect(refusal(route(rows.anthropic, path)), path).toBe("not_allowed");
  });
  it("Cohere: chat, embed and rerank under v1 or v2", () => {
    for (const op of ["chat", "embed", "rerank"]) for (const v of ["v1", "v2"]) expect(route(rows.cohere, `/${v}/${op}`).ok).toBe(true);
    for (const path of ["/v1/classify", "/v3/chat", "/v1/datasets"]) expect(refusal(route(rows.cohere, path)), path).toBe("not_allowed");
  });
  it("Azure: the host is the connected resource's own, under the row's suffix, and nothing else", () => {
    const deployment = "/openai/deployments/fixture-small/chat/completions";
    const frameOf = frame(rows.azure, { path: deployment, query: "api-version=2024-06-01" });
    const ok = routeEgressRequest(rows.azure, FIXTURE_VERTEX_CONNECTION, frameOf);
    expect(ok.ok && ok.host).toBe("fixture-resource.openai.azure.com");
    expect(ok.ok && ok.path).toBe(deployment);
    for (const host of [undefined, "evil.example.com", "openai.azure.com", "fixture-resource.openai.azure.com.evil.example.com", "127.0.0.1", "a.openai.azure.com@evil.example.com", "FIXTURE.openai.azure.com", "x.y.example.com"]) {
      const result = routeEgressRequest(rows.azure, host === undefined ? {} : { host }, frameOf);
      expect(result.ok, String(host)).toBe(false);
    }
  });
  it("Azure: the connected deployment path only", () => {
    expect(route(rows.azure, "/openai/deployments/fixture-small/chat/completions", { query: "api-version=2024-06-01" }).ok).toBe(true);
    expect(refusal(route(rows.azure, "/openai/deployments/another/chat/completions", { query: "api-version=2024-06-01" }))).toBe("not_allowed");
    expect(refusal(route(rows.azure, "/v1/chat/completions", { query: "api-version=2024-06-01" }))).toBe("not_allowed");
  });
  it("Vertex: the connected project and location only; another project or location is not_allowed", () => {
    const base = "/v1/projects/fixture-project-1/locations/us-central1/publishers/google/models/gemini-2.5-flash";
    const ok = route(rows.vertex, `${base}:generateContent`);
    expect(ok.ok && ok.host).toBe("us-central1-aiplatform.googleapis.com");
    expect(route(rows.vertex, `${base}:streamGenerateContent`).ok).toBe(true);
    expect(route(rows.vertex, `${base}:rawPredict`).ok).toBe(true);
    expect(refusal(route(rows.vertex, "/v1/projects/other-project-9/locations/us-central1/publishers/google/models/m:generateContent"))).toBe("not_allowed");
    expect(refusal(route(rows.vertex, "/v1/projects/fixture-project-1/locations/europe-west1/publishers/google/models/m:generateContent"))).toBe("not_allowed");
    expect(refusal(route(rows.vertex, `${base}:deleteSomething`))).toBe("not_allowed");
    expect(refusal(route(rows.vertex, "/v1/projects/fixture-project-1/locations/us-central1/endpoints/1:predict"))).toBe("not_allowed");
    // A source with no connected project serves no project path at all.
    expect(routeEgressRequest(rows.vertex, {}, frame(rows.vertex, { path: `${base}:generateContent` })).ok).toBe(false);
  });
  it("Vertex: the project-less express form needs a key scheme", () => {
    const express = "/v1/publishers/google/models/gemini-2.5-flash:generateContent";
    expect(refusal(route(rows.vertex, express))).toBe("not_allowed");
    const keyed: ModelEgressRow = { ...rows.vertex, scheme: "header:x-goog-api-key" };
    const routed = routeEgressRequest(keyed, FIXTURE_VERTEX_CONNECTION, frame(keyed, { path: express }));
    expect(routed.ok && routed.host).toBe("aiplatform.googleapis.com");
  });
  it("answers a Bedrock or sigv4 row with the not-run sentence and no call", () => {
    const result = route(rows.bedrock, "/model/m/converse");
    expect(result).toEqual({ ok: false, refusal: "not_allowed", notRun: SIGV4_NOT_RUN_SENTENCE });
    expect(SIGV4_NOT_RUN_SENTENCE).toBe("not run: Bedrock real calls need the AWS account connection (TE-F6)");
  });
  it("the destination host is the row's own, whatever the client sent in any field", () => {
    const hostile = frame(rows.openai, { path: "/v1/chat/completions", headers: [["Host", "evil.test"], ["X-Forwarded-Host", "evil.test"], [":authority", "evil.test"], ["Forwarded", "host=evil.test"]] });
    const built = buildOutboundRequest(rows.openai, {}, hostile, fixtureKey("a"));
    expect(built.ok && built.request.host).toBe("api.openai.com");
    expect(JSON.stringify(built.ok && built.request.headers)).not.toContain("evil");
  });
});

describe("header injection", () => {
  const credentialHeaders: Array<[string, string]> = [
    ["Authorization", `Bearer ${inb("1")}`], ["authorization", `Basic ${inb("2")}`], ["AUTHORIZATION", `${inb("3")}`], ["x-api-key", `${inb("4")}`], ["X-Goog-Api-Key", `${inb("5")}`], ["api-key", `${inb("6")}`],
    ["x-goog-user-project", "inbound-project"], ["Cookie", `sid=${inb("7")}`], ["Proxy-Authorization", `${inb("8")}`], ["proxy-connection", "x"], ["x-amz-security-token", `${inb("9")}`], ["X-Amz-Date", "20260101T000000Z"],
    ["authorization\r\n x", `${inb("10")}`], [" authorization", `${inb("11")}`], ["authorization:", `${inb("12")}`], ["x-custom-api-key", `${inb("13")}`], ["x-apikey", `${inb("14")}`], ["set-cookie", `${inb("15")}`],
  ];
  const secretsIn = (text: string) => text.includes(inb("")) || text.includes("inbound-project");

  const schemes: Array<[string, ModelEgressRow, string, string]> = [
    ["bearer", rows.openai, "/v1/chat/completions", "authorization"],
    ["header:x-goog-api-key", rows.gemini, "/v1beta/models/m:generateContent", "x-goog-api-key"],
    ["header:x-api-key", rows.anthropic, "/v1/messages", "x-api-key"],
    ["header:api-key", rows.azure, "/openai/deployments/fixture-small/chat/completions", "api-key"],
    ["gcp-oauth:federation", rows.vertex, "/v1/projects/fixture-project-1/locations/us-central1/publishers/google/models/m:generateContent", "authorization"],
    ["gcp-oauth:key-file", { ...rows.vertex, scheme: "gcp-oauth:key-file" }, "/v1/projects/fixture-project-1/locations/us-central1/publishers/google/models/m:generateContent", "authorization"],
  ];
  for (const [scheme, row, path, header] of schemes) {
    it(`${scheme}: drops every inbound credential first, then adds exactly one`, () => {
      const secret = scheme.startsWith("gcp-oauth") ? fixtureToken("t") : fixtureKey("k");
      const query = row.azure === undefined ? `key=${inb("q")}` : `key=${inb("q")}&api-version=2024-06-01`;
      const built = buildOutboundRequest(row, FIXTURE_VERTEX_CONNECTION, frame(row, { path, query, headers: [...credentialHeaders, ["content-type", "application/json"]] }), secret);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const everything = JSON.stringify([built.request.headers, built.request.path, built.request.query, built.request.host]);
      expect(secretsIn(everything), everything).toBe(false);
      expect(countCredentials(built.request)).toBe(1);
      const carried = built.request.headers.filter(([name]) => name === header);
      expect(carried).toHaveLength(1);
      expect(carried[0]?.[1]).toBe(header === "authorization" ? `Bearer ${secret}` : secret);
      expect(built.request.headers.find(([name]) => name === "content-type")?.[1]).toBe("application/json");
    });
  }
  it("query:key: the inbound key is dropped and exactly one key is added, percent-encoded", () => {
    const row: ModelEgressRow = { ...rows.gemini, scheme: "query:key" };
    const secret = `${fixtureKey("q")}+/=`;
    const built = buildOutboundRequest(row, {}, frame(row, { path: "/v1beta/models/m:generateContent", query: `key=${inb("q")}&alt=sse`, headers: credentialHeaders }), secret);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.query).toBe(`alt=sse&key=${encodeURIComponent(secret)}`);
    expect(built.request.headers.some(([name]) => isInboundCredentialHeader(name))).toBe(false);
    expect(countCredentials(built.request)).toBe(1);
    expect(secretsIn(JSON.stringify(built.request.headers) + built.request.query)).toBe(false);
  });
  it("keeps only the family's allow list, lower-cased", () => {
    const built = buildOutboundRequest(
      rows.anthropic, {},
      frame(rows.anthropic, { path: "/v1/messages", headers: [["Content-Type", "application/json"], ["Accept", "text/event-stream"], ["Anthropic-Version", "2023-06-01"], ["anthropic-beta", "tools-2024-04-04"], ["User-Agent", "sdk/1"], ["X-Stainless-Os", "Linux"], ["openai-beta", "x"], ["x-goog-api-client", "x"], ["accept-encoding", "gzip"], ["host", "evil.test"], ["content-length", "5"], ["transfer-encoding", "chunked"], ["connection", "keep-alive"]] }),
      fixtureKey("k"),
    );
    expect(built.ok && built.request.headers.map(([name]) => name).sort()).toEqual(["accept", "accept-encoding", "anthropic-beta", "anthropic-version", "content-type", "user-agent", "x-api-key"]);
    expect(built.ok && built.request.headers.find(([name]) => name === "accept-encoding")?.[1]).toBe("identity");
    const gemini = buildOutboundRequest(rows.gemini, {}, frame(rows.gemini, { path: "/v1beta/models/m:generateContent", headers: [["x-goog-api-client", "genai-js/1"], ["anthropic-version", "1"], ["openai-beta", "1"]] }), fixtureKey("k"));
    expect(gemini.ok && gemini.request.headers.map(([name]) => name).sort()).toEqual(["accept-encoding", "x-goog-api-client", "x-goog-api-key"]);
    const openai = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions", headers: [["openai-beta", "assistants=v2"], ["anthropic-beta", "1"]] }), fixtureKey("k"));
    expect(openai.ok && openai.request.headers.map(([name]) => name).sort()).toEqual(["accept-encoding", "authorization", "openai-beta"]);
  });
  it("refuses an allowed header with a control character, over 1 KB, folded, or sent twice", () => {
    const refuseWith = (headers: Array<[string, string]>) => {
      const built = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions", headers }), fixtureKey("k"));
      return built.ok ? "built" : built.refusal;
    };
    expect(refuseWith([["content-type", "application/json\r\nX-Evil: 1"]])).toBe("bad_request");
    expect(refuseWith([["content-type", "a\u0000b"]])).toBe("bad_request");
    expect(refuseWith([["content-type", "a\tb"]])).toBe("bad_request");
    expect(refuseWith([["content-type", "café"]])).toBe("bad_request");
    expect(refuseWith([["user-agent", "x".repeat(1025)]])).toBe("bad_request");
    expect(refuseWith([["user-agent", "x".repeat(1024)]])).toBe("built");
    expect(refuseWith([["content-type", "a"], ["Content-Type", "b"]])).toBe("bad_request");
    // A name written with a fold reads as no allowed name at all: it is dropped, never forwarded.
    expect(refuseWith([["content-type\r\n x", "a"]])).toBe("built");
    expect(refuseWith([[" content-type", "a"]])).toBe("bad_request");
  });
  it("a value with a control character on a header that is NOT allowed is dropped, not an error", () => {
    const built = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions", headers: [["x-other", "a\r\nb"]] }), fixtureKey("k"));
    expect(built.ok).toBe(true);
  });
  it("refuses a secret it cannot place without echoing it", () => {
    for (const secret of ["", "a\r\nb", "café-key", "x".repeat(5000)]) {
      let message = "";
      try {
        buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions" }), secret);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("the credential cannot be placed in a request");
    }
  });
  it("places no credential for a refused request, and never reads the secret", () => {
    const refused = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/files" }), "");
    expect(refused).toEqual({ ok: false, refusal: "not_allowed" });
  });
  it("the credential name helpers see through folds, case and colons", () => {
    expect(normalizeHeaderName("Authorization\r\n x:")).toBe("authorizationx");
    expect(isInboundCredentialHeader("Authorization\r\n")).toBe(true);
    for (const name of ["x-custom-api-key", "x-apikey", "X-Goog-Api-Key", "set-cookie", "Cookie", "x-amz-date", "proxy-connection", "X-Goog-User-Project", "my-authorization-header"]) expect(isInboundCredentialHeader(name), name).toBe(true);
    expect(isInboundCredentialHeader("content-type")).toBe(false);
    expect(isInboundCredentialHeader("x-goog-api-client")).toBe(false);
    expect(dropInboundCredentials([["Authorization", "a"], ["content-type", "b"], ["Proxy-Foo", "c"]])).toEqual([["content-type", "b"]]);
  });
  it("copes with a body of 5 MB without copying it", () => {
    const big = new Uint8Array(5 * 1024 * 1024);
    const built = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions", body: big }), fixtureKey("k"));
    expect(built.ok && built.request.body).toBe(big);
  });
  it("sets the row's default maximum output in the forwarded body when the request names none, reserving on the same number", () => {
    const sent = (row: ModelEgressRow, path: string, body: unknown, query = "") => {
      const built = buildOutboundRequest(row, FIXTURE_VERTEX_CONNECTION, frame(row, { path, query, body: new TextEncoder().encode(JSON.stringify(body)) }), fixtureKey("k"));
      if (!built.ok) throw new Error(built.refusal);
      return { built, body: JSON.parse(new TextDecoder().decode(built.request.body)) as Record<string, unknown> };
    };
    const gemini = sent(rows.gemini, "/v1beta/models/x:generateContent", { contents: [] });
    expect(gemini.built.maxOutputTokens).toBe(rows.gemini.defaultMaxOutputTokens);
    expect((gemini.body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(rows.gemini.defaultMaxOutputTokens);
    const openai = sent(rows.openai, "/v1/chat/completions", { model: "m", messages: [] });
    expect(openai.built.maxOutputTokens).toBe(rows.openai.defaultMaxOutputTokens);
    // OpenAI's o-series and gpt-5 reject `max_tokens`: the openai row writes `max_completion_tokens`.
    expect(openai.body.max_completion_tokens).toBe(rows.openai.defaultMaxOutputTokens);
    expect(openai.body.max_tokens).toBeUndefined();
    const azure = sent(rows.azure, "/openai/deployments/fixture-small/chat/completions", { messages: [] }, "api-version=2024-06-01");
    expect(azure.body.max_completion_tokens).toBe(rows.azure.defaultMaxOutputTokens);
    expect(azure.body.max_tokens).toBeUndefined();
    // Every other OpenAI-compatible row keeps `max_tokens` unless its row says otherwise.
    const gateway = sent(rows.openrouter, "/api/v1/chat/completions", { model: "m", messages: [] });
    expect(gateway.body.max_tokens).toBe(rows.openrouter.defaultMaxOutputTokens);
    expect(gateway.body.max_completion_tokens).toBeUndefined();
    const chosen = sent({ ...rows.openrouter, maxOutputField: "max_completion_tokens" }, "/api/v1/chat/completions", { model: "m", messages: [] });
    expect(chosen.body.max_completion_tokens).toBe(rows.openrouter.defaultMaxOutputTokens);
    expect(chosen.built.maxOutputTokens).toBe(rows.openrouter.defaultMaxOutputTokens);
    const own = sent(rows.openai, "/v1/chat/completions", { model: "m", messages: [], max_tokens: 33 });
    expect(own.built.maxOutputTokens).toBe(33);
    expect(own.body.max_tokens).toBe(33);
    expect(own.body.max_completion_tokens).toBeUndefined();
    // The client's bytes are the client's: the forwarded body is the original text with one member spliced in.
    const text = '{"model":"fixture-small","seed":12345678901234567890,"temperature":1.0,"messages":[]}';
    const spliced = buildOutboundRequest(rows.openai, {}, frame(rows.openai, { path: "/v1/chat/completions", body: new TextEncoder().encode(text) }), fixtureKey("k"));
    expect(spliced.ok && new TextDecoder().decode(spliced.request.body)).toBe(`${text.slice(0, -1)},"max_completion_tokens":${String(rows.openai.defaultMaxOutputTokens)}}`);
    // A maximum the client named in an unusable form is overwritten, and the reservation reads the figure that is forwarded.
    const unusable = buildOutboundRequest(rows.gemini, {}, frame(rows.gemini, { path: "/v1beta/models/x:generateContent", body: new TextEncoder().encode('{"contents":[],"generation_config":{"max_output_tokens":null}}') }), fixtureKey("k"));
    expect(unusable.ok && new TextDecoder().decode(unusable.request.body)).toBe(`{"contents":[],"generation_config":{"max_output_tokens":${String(rows.gemini.defaultMaxOutputTokens)}}}`);
    expect(unusable.ok && unusable.maxOutputTokens).toBe(rows.gemini.defaultMaxOutputTokens);
    const snake = buildOutboundRequest(rows.gemini, {}, frame(rows.gemini, { path: "/v1beta/models/x:generateContent", body: new TextEncoder().encode('{"contents":[],"generation_config":{"max_output_tokens":60000}}') }), fixtureKey("k"));
    expect(snake.ok && snake.maxOutputTokens).toBe(60000);
  });
  it("reports a file or cached-content reference so the reservation does not rest on the body's size", () => {
    const flag = (body: unknown) => {
      const built = buildOutboundRequest(rows.gemini, {}, frame(rows.gemini, { path: "/v1beta/models/x:generateContent", body: new TextEncoder().encode(JSON.stringify(body)) }), fixtureKey("k"));
      return built.ok && built.externalInput;
    };
    expect(flag({ contents: [{ parts: [{ fileData: { fileUri: "x" } }] }] })).toBe(true);
    expect(flag({ cachedContent: "cachedContents/1", contents: [] })).toBe(true);
    expect(flag({ contents: [{ parts: [{ text: "plain" }] }] })).toBe(false);
  });
});
