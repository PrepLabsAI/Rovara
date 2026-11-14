// Test services TS3 (contract): FixtureSet v2, its request hash (method, path, identifying query, ignorePaths), its bounds, and the converters from v1 sets and from the E2E checker's GET fixtures.
import { describe, expect, it } from "vitest";
import { e2eApiMockFixtureToFixtureSet, type E2EApiMockFixture } from "../../packages/contracts/src/e2e-node.js";
import * as mocks from "../../packages/contracts/src/service-mocks.js";

const dependency: mocks.FixtureSet["dependency"] = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" };
const baseMatch: mocks.FixtureSet["match"] = { ignorePaths: ["/requestedAt"], query: ["customer"] };
const request = (over: Record<string, unknown> = {}) => ({ method: "POST", path: "/v1/charges", query: [{ name: "customer", value: "c1" }], contentType: "application/json", body: '{"amount":5,"requestedAt":"2026-11-02T00:00:00Z"}', ...over });
const response = (over: Record<string, unknown> = {}) => ({ status: 200, headers: [{ name: "etag", value: "abc" }], contentType: "application/json", body: '{"ok":true}', latencyMs: 12, ...over });
const entryFor = (over: Record<string, unknown> = {}, match = baseMatch, dep = dependency) => {
  const req = request(over);
  return { requestHash: mocks.fixtureRequestHash({ dependency: dep, match }, req), request: req, response: response() };
};
const set = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 2, dependency, origin: "recorded", revision: 3, recordedAt: "2026-11-02T00:00:00.000Z", syntheticOnly: true,
  requestSchema: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] },
  responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  match: baseMatch, entries: [entryFor()], faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }], ...over,
});
const ok = (value: unknown) => mocks.FixtureSetSchema.safeParse(value).success;
const parsed = (over: Record<string, unknown> = {}) => mocks.FixtureSetSchema.parse(set(over));
const hash = (body: string, over: Record<string, unknown> = {}, match: { ignorePaths: string[]; query?: string[] } = { ignorePaths: [] }, dep: typeof dependency = dependency) => mocks.fixtureRequestHash({ dependency: dep, match }, request({ query: undefined, body, ...over }));

describe("FixtureSet v2 schema", () => {
  it("accepts a recorded set and round-trips it", () => {
    expect(mocks.FixtureSetSchema.parse(set())).toEqual(set());
  });
  it("is version 2, synthetic only and strict at every level", () => {
    expect(ok(set({ schemaVersion: 1 }))).toBe(false);
    expect(ok(set({ syntheticOnly: false }))).toBe(false);
    expect(ok(set({ extra: 1 }))).toBe(false);
    expect(ok(set({ dependency: { ...dependency, extra: 1 } }))).toBe(false);
    expect(ok(set({ match: { ...baseMatch, extra: 1 } }))).toBe(false);
    expect(ok(set({ entries: [{ ...entryFor(), extra: 1 }] }))).toBe(false);
    expect(ok(set({ entries: [{ ...entryFor(), request: { ...request(), extra: 1 } }] }))).toBe(false);
  });
  it("needs a date for a recorded set and for no other, and a writer only for a written one", () => {
    expect(ok(set({ recordedAt: undefined }))).toBe(false);
    expect(ok(set({ origin: "written", recordedAt: undefined, writtenBy: "Priya (reviewed)" }))).toBe(true);
    expect(ok(set({ origin: "written", recordedAt: "2026-11-02T00:00:00.000Z" }))).toBe(false);
    expect(ok(set({ origin: "imported", recordedAt: undefined }))).toBe(true);
    expect(ok(set({ origin: "imported", recordedAt: undefined, writtenBy: "x" }))).toBe(false);
    expect(ok(set({ writtenBy: "x" }))).toBe(false);
    expect(ok(set({ origin: "scraped" }))).toBe(false);
  });
  it("names its dependency by id, family and protocol", () => {
    expect(ok(set({ dependency: { ...dependency, family: "http:10.0.0.1" } }))).toBe(false);
    expect(ok(set({ dependency: { ...dependency, protocol: "soap" } }))).toBe(false);
    expect(ok(set({ dependency: { ...dependency, id: "Bad Id" } }))).toBe(false);
  });
  it("lets the schemas be absent but not null", () => {
    expect(ok(set({ requestSchema: undefined, responseSchema: undefined }))).toBe(true);
    expect(ok(set({ requestSchema: null }))).toBe(false);
  });
  it("keeps a recording once and a fault name once", () => {
    expect(ok(set({ entries: [entryFor(), entryFor()] }))).toBe(false);
    expect(ok(set({ faults: [{ name: "a", kind: "timeout", delayMs: 1 }, { name: "a", kind: "timeout", delayMs: 1 }] }))).toBe(false);
    expect(ok(set({ faults: Array.from({ length: 21 }, (_, n) => ({ name: `f${String(n)}`, kind: "timeout", delayMs: 1 })) }))).toBe(false);
  });
  it("takes a method from the five, and a canonical path", () => {
    expect(ok(set({ entries: [entryFor({ method: "TRACE" })] }))).toBe(false);
    expect(ok(set({ entries: [entryFor({ method: "get" })] }))).toBe(false);
    for (const path of ["/", "/v1/charges", "/endpoints/x-1/invocations", "/a%20b", "/a.b_c~d"]) expect(ok(set({ entries: [entryFor({ path })] })), path).toBe(true);
    for (const path of ["v1", "", "/a/../b", "//x", "/a b", "/a?x=1", "/a#x", `/${"a".repeat(512)}`]) expect(ok(set({ entries: [entryFor({ path })] })), path).toBe(false);
  });
  it("lets an empty content type through for a request with no body, and bounds a body to 64 KiB", () => {
    expect(ok(set({ entries: [entryFor({ contentType: "", body: "" })] }))).toBe(true);
    expect(ok(set({ entries: [entryFor({ body: "x".repeat(65_536) })] }))).toBe(true);
    expect(ok(set({ entries: [entryFor({ body: "x".repeat(65_537) })] }))).toBe(false);
    expect(ok(set({ entries: [{ ...entryFor(), response: response({ body: "é".repeat(40_000) }) }] }))).toBe(false);
    expect(ok(set({ entries: [entryFor({ contentType: "a\nb" })] }))).toBe(false);
  });
  it("bounds the response: status, latency, headers", () => {
    const withResponse = (over: Record<string, unknown>) => set({ entries: [{ ...entryFor(), response: response(over) }] });
    expect(ok(withResponse({ status: 99 }))).toBe(false);
    expect(ok(withResponse({ status: 600 }))).toBe(false);
    expect(ok(withResponse({ latencyMs: 30_001 }))).toBe(false);
    expect(ok(withResponse({ latencyMs: -1 }))).toBe(false);
    expect(ok(withResponse({ headers: [] }))).toBe(true);
    expect(ok(withResponse({ contentType: "" }))).toBe(false);
  });
  it("keeps only allow-listed response headers, once each, at most eight", () => {
    const withHeaders = (headers: unknown[]) => set({ entries: [{ ...entryFor(), response: response({ headers }) }] });
    for (const name of mocks.FIXTURE_RESPONSE_HEADER_NAMES) expect(ok(withHeaders([{ name, value: "v" }])), name).toBe(true);
    for (const name of ["set-cookie", "location", "authorization", "www-authenticate", "refresh", "content-security-policy", "x-forwarded-for", "ETag", "link"]) expect(ok(withHeaders([{ name, value: "v" }])), name).toBe(false);
    expect(ok(withHeaders([{ name: "etag", value: "a" }, { name: "etag", value: "b" }]))).toBe(false);
    expect(ok(withHeaders([{ name: "etag", value: "a\r\nSet-Cookie: x" }]))).toBe(false);
    expect(ok(withHeaders(mocks.FIXTURE_RESPONSE_HEADER_NAMES.slice(0, 9).map((name) => ({ name, value: "v" }))))).toBe(false);
  });
  it("lists at most twenty ignored pointers, once each, each a real JSON pointer with no empty part", () => {
    const ignoring = (ignorePaths: string[]) => set({ match: { ignorePaths, query: ["customer"] }, entries: [] });
    expect(ok(ignoring(["/a", "/a/b", "/items/0/id", "/a~1b", "/a~0b"]))).toBe(true);
    expect(ok(ignoring(Array.from({ length: 21 }, (_, n) => `/p${String(n)}`)))).toBe(false);
    expect(ok(ignoring(Array.from({ length: 20 }, (_, n) => `/p${String(n)}`)))).toBe(true);
    expect(ok(ignoring(["/a", "/a"]))).toBe(false);
    for (const pointer of ["", "a", "a/b", "/a~2", "/a~", `/${"a".repeat(200)}`, "/", "//", "/a/", "/a//b", "//a"]) expect(ok(ignoring([pointer])), pointer).toBe(false);
  });
  it("refuses ignored paths that take out every member of a recorded body", () => {
    const withBody = (ignorePaths: string[], body: string, contentType = "application/json") => {
      const match = { ignorePaths, query: ["customer"] };
      return set({ match, entries: [entryFor({ body, contentType }, match)] });
    };
    // Every member gone: every such request would be one request.
    expect(ok(withBody(["/requestedAt"], '{"requestedAt":"x"}'))).toBe(false);
    expect(ok(withBody(["/a", "/b"], '{"a":1,"b":2}'))).toBe(false);
    expect(ok(withBody(["/a/b"], '{"a":{"b":1}}'))).toBe(true);
    expect(ok(withBody(["/0", "/1"], "[1,2]"))).toBe(false);
    expect(ok(withBody(["/0"], "[1,2]"))).toBe(true);
    expect(ok(withBody(["/0", "/1"], "[null,2]"))).toBe(false);
    expect(ok(withBody(["/a", "/b"], '{"a":1,"b":2,"c":3}'))).toBe(true);
    expect(ok(withBody(["/a"], '{"a":1,"b":2}'))).toBe(true);
    // An empty or non-object body had nothing to take out; a body that is not JSON is hashed as written.
    expect(ok(withBody(["/a"], "{}"))).toBe(true);
    expect(ok(withBody(["/a"], "[]"))).toBe(true);
    expect(ok(withBody(["/a"], "not json"))).toBe(true);
    expect(ok(withBody(["/a"], '{"a":1}', "text/plain"))).toBe(true);
    expect(ok(withBody(["/a"], '{"a":1}', "application/vnd.api+json"))).toBe(false);
    // One bad entry among good ones is enough.
    const match = { ignorePaths: ["/requestedAt"], query: ["customer"] };
    expect(ok(set({ match, entries: [entryFor({ path: "/ok" }, match), entryFor({ path: "/bad", body: '{"requestedAt":"x"}' }, match)] }))).toBe(false);
    expect(ok(set({ match, entries: [entryFor({ path: "/ok" }, match), entryFor({ path: "/ok2", body: '{"requestedAt":"x","k":1}' }, match)] }))).toBe(true);
  });
  it("matches on at most eight named query parameters, once each, and keeps no other parameter", () => {
    expect(ok(set({ match: { ignorePaths: [], query: Array.from({ length: 9 }, (_, n) => `q${String(n)}`) }, entries: [] }))).toBe(false);
    expect(ok(set({ match: { ignorePaths: [], query: ["a", "a"] }, entries: [] }))).toBe(false);
    expect(ok(set({ match: { ignorePaths: [], query: ["a b"] }, entries: [] }))).toBe(false);
    expect(ok(set({ match: { ignorePaths: [], query: ["__proto__"] }, entries: [] }))).toBe(false);
    expect(ok(set({ entries: [entryFor({ query: [{ name: "other", value: "x" }] })] }))).toBe(false);
    expect(ok(set({ entries: [entryFor({ query: [{ name: "customer", value: "a" }, { name: "customer", value: "b" }] })] }))).toBe(false);
    expect(ok(set({ match: { ignorePaths: [] }, entries: [entryFor({ query: undefined }, { ignorePaths: [] })] }))).toBe(true);
    expect(ok(set({ match: { ignorePaths: [] }, entries: [entryFor({ query: [{ name: "customer", value: "x" }] }, { ignorePaths: [] })] }))).toBe(false);
  });
  it("has no JSON pointers for a form-encoded protocol", () => {
    const query = { ...dependency, protocol: "aws_query" };
    expect(ok(set({ dependency: query, match: { ignorePaths: ["/a"], query: ["customer"] }, entries: [] }))).toBe(false);
    expect(ok(set({ dependency: query, match: { ignorePaths: [], query: ["customer"] }, entries: [] }))).toBe(true);
  });
  it("sends a model endpoint through POST /endpoints/<name>/invocations only", () => {
    const model = { id: "scorer", family: "aws:sagemaker-runtime", protocol: "model_invoke", target: "partner-scorer" };
    const entry = (over: Record<string, unknown> = {}) => entryFor({ method: "POST", path: "/endpoints/partner-scorer/invocations", query: undefined, ...over }, { ignorePaths: [] }, model as never);
    expect(ok(set({ dependency: model, match: { ignorePaths: [] }, entries: [entry()] }))).toBe(true);
    expect(ok(set({ dependency: model, match: { ignorePaths: [] }, entries: [entry({ path: "/endpoints/other/invocations" })] }))).toBe(false);
    expect(ok(set({ dependency: model, match: { ignorePaths: [] }, entries: [entry({ method: "PUT" })] }))).toBe(false);
    expect(ok(set({ dependency: { ...model, family: "http:api.example-pay.com" }, match: { ignorePaths: [] }, entries: [] }))).toBe(false);
    expect(ok(set({ dependency: { ...model, target: "bad name!" }, match: { ignorePaths: [] }, entries: [] }))).toBe(false);
  });
  it("ties the target to the host its family names", () => {
    const withTarget = (family: string, target: string, protocol = "http_json") => set({ dependency: { ...dependency, family, target, protocol }, entries: [] });
    expect(ok(withTarget("http:api.example-pay.com", "api.example-pay.com"))).toBe(true);
    expect(ok(withTarget("http:api.example-pay.com", "api.other-pay.com"))).toBe(false);
    expect(ok(withTarget("http:api.example-pay.com", "api.example-pay.com:8443"))).toBe(false);
    expect(ok(withTarget("http:api.example-pay.com", "API.EXAMPLE-PAY.COM"))).toBe(false);
    expect(ok(withTarget("http:api.example-pay.com", "169.254.169.254"))).toBe(false);
    expect(ok(withTarget("aws:dynamodb", "dynamodb.us-west-2.amazonaws.com", "aws_json"))).toBe(true);
    expect(ok(withTarget("aws:dynamodb", "sqs.us-west-2.amazonaws.com", "aws_json"))).toBe(false);
    expect(ok(withTarget("aws:dynamodb", "api.example-pay.com", "aws_json"))).toBe(false);
    expect(ok(withTarget("aws:dynamodb", "dynamodb.us-west-2.amazonaws.com.evil.example", "aws_json"))).toBe(false);
  });
  it("refuses a stored entry whose hash is not the hash of its own request, whatever else is right", () => {
    const good = entryFor({ path: "/a" });
    expect(ok(set({ entries: [good] }))).toBe(true);
    expect(ok(set({ entries: [{ ...good, requestHash: "a".repeat(64) }] }))).toBe(false);
    expect(ok(set({ entries: [{ ...good, request: { ...good.request, path: "/b" } }] }))).toBe(false);
    expect(ok(set({ entries: [{ ...good, request: { ...good.request, body: '{"amount":6}' } }] }))).toBe(false);
    expect(ok(set({ entries: [{ ...good, request: { ...good.request, method: "PUT" } }] }))).toBe(false);
    expect(ok(set({ entries: [good, { ...entryFor({ path: "/c" }), requestHash: good.requestHash }] }))).toBe(false);
    // The hash covers the set's own match rules: an entry hashed under other rules does not belong.
    expect(ok(set({ match: { ignorePaths: [], query: ["customer"] }, entries: [good] }))).toBe(false);
    expect(ok(set({ dependency: { ...dependency, id: "payments-two" }, entries: [good] }))).toBe(true);
    expect(ok(set({ dependency: { ...dependency, family: "http:api.other-pay.com", target: "api.other-pay.com" }, entries: [good] }))).toBe(false);
  });
  it("holds at most 2,000 entries", () => {
    const many = (count: number) => Array.from({ length: count }, (_, n) => entryFor({ path: `/p${String(n)}` }));
    expect(ok(set({ entries: many(2_000) }))).toBe(true);
    expect(ok(set({ entries: many(2_001) }))).toBe(false);
  });
  it("refuses a set over 4 MiB however its entries are spread", () => {
    const big = (count: number) => Array.from({ length: count }, (_, n) => ({ ...entryFor({ path: `/p${String(n)}`, body: "x".repeat(60_000) }), response: response({ body: "y".repeat(60_000) }) }));
    expect(ok(set({ entries: big(30) }))).toBe(true);
    expect(ok(set({ entries: big(40) }))).toBe(false);
  });
});

describe("FixtureSet digest", () => {
  it("is the same for a re-ordered set and different for a changed one", () => {
    const one = parsed();
    const reverseKeys = (value: unknown): unknown => (Array.isArray(value) ? value.map(reverseKeys) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reverseKeys(member)])) : value);
    const reordered = mocks.FixtureSetSchema.parse(reverseKeys(set()));
    expect(Object.keys(reverseKeys(set()) as object)).not.toEqual(Object.keys(set()));
    expect(mocks.fixtureSetDigest(one)).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.fixtureSetDigest(reordered)).toBe(mocks.fixtureSetDigest(one));
    expect(mocks.fixtureSetDigest(parsed({ revision: 4 }))).not.toBe(mocks.fixtureSetDigest(one));
    expect(mocks.fixtureSetDigest(parsed({ match: { ignorePaths: [], query: ["customer"] }, entries: [] }))).not.toBe(mocks.fixtureSetDigest(one));
  });
  it("refuses to digest a set that does not parse", () => {
    expect(() => mocks.fixtureSetDigest({ ...parsed(), syntheticOnly: false } as never)).toThrow();
  });
});

describe("request hash (v2)", () => {
  it("is one request for a JSON body whatever its key order or spacing", () => {
    expect(hash('{"a":1,"b":{"c":2,"d":3}}')).toBe(hash('{ "b": {"d":3, "c":2}, "a": 1 }'));
    expect(hash('{"a":1}')).not.toBe(hash('{"a":2}'));
  });
  it("includes the method and the path, so the same bytes to another operation find nothing", () => {
    const base = hash('{"a":1}');
    expect(hash('{"a":1}', { method: "PUT" })).not.toBe(base);
    expect(hash('{"a":1}', { path: "/v1/refunds" })).not.toBe(base);
    expect(hash('{"a":1}', { method: "post" })).toBe(base);
    expect(hash('{"a":1}', { contentType: "text/plain" })).not.toBe(base);
    expect(hash('{"a":1}', { contentType: "Application/JSON; charset=utf-8" })).toBe(base);
  });
  it("includes the dependency's family and target", () => {
    const base = hash('{"a":1}');
    expect(hash('{"a":1}', {}, { ignorePaths: [] }, { ...dependency, family: "http:api.other-pay.com" })).not.toBe(base);
    expect(hash('{"a":1}', {}, { ignorePaths: [] }, { ...dependency, target: "api.other-pay.com" })).not.toBe(base);
  });
  it("hashes a body that is not JSON as written, even under a JSON content type", () => {
    expect(hash("not json")).toBe(hash("not json"));
    expect(hash("not json")).not.toBe(hash("not  json"));
    expect(hash("a,b\n1,2", { contentType: "text/csv" })).toMatch(/^[a-f0-9]{64}$/);
    expect(hash("not json", {}, { ignorePaths: ["/a"] })).toBe(hash("not json"));
  });
  it("never meets a v1 hash", () => {
    const v1 = mocks.serviceMockRequestHash({ service: "http", target: dependency.target, method: "POST", contentType: "application/json", body: '{"a":1}' });
    expect(hash('{"a":1}')).not.toBe(v1);
  });

  describe("ignorePaths", () => {
    const ignoring = (...ignorePaths: string[]) => ({ ignorePaths });
    it("makes requests that differ only at an ignored path one request", () => {
      const match = ignoring("/requestedAt");
      expect(hash('{"amount":5,"requestedAt":"2026-11-02T10:00:00Z"}', {}, match)).toBe(hash('{"requestedAt":"2030-01-01T00:00:00Z","amount":5}', {}, match));
    });
    it("still tells requests apart by every other member", () => {
      const match = ignoring("/requestedAt");
      expect(hash('{"amount":5,"requestedAt":"x"}', {}, match)).not.toBe(hash('{"amount":6,"requestedAt":"x"}', {}, match));
      expect(hash('{"amount":5,"requestedAt":"x"}', {}, ignoring())).not.toBe(hash('{"amount":5}', {}, ignoring()));
    });
    it("does not ignore anything it was not told to", () => {
      expect(hash('{"amount":5,"requestedAt":"a"}')).not.toBe(hash('{"amount":5,"requestedAt":"b"}'));
    });
    it("reaches nested members and array elements, which become null so the others keep their places", () => {
      const nested = ignoring("/meta/trace/id");
      expect(hash('{"meta":{"trace":{"id":"1","k":2}}}', {}, nested)).toBe(hash('{"meta":{"trace":{"id":"2","k":2}}}', {}, nested));
      expect(hash('{"meta":{"trace":{"id":"1","k":2}}}', {}, nested)).not.toBe(hash('{"meta":{"trace":{"id":"1","k":3}}}', {}, nested));
      const array = ignoring("/items/1");
      expect(hash('{"items":["a","x","c"]}', {}, array)).toBe(hash('{"items":["a","y","c"]}', {}, array));
      expect(hash('{"items":["a","x","c"]}', {}, array)).not.toBe(hash('{"items":["a","c"]}', {}, array));
      expect(hash('{"items":["a","x","c"]}', {}, array)).not.toBe(hash('{"items":["b","x","c"]}', {}, array));
    });
    it("reads ~1 as a slash and ~0 as a tilde in a member name", () => {
      expect(hash('{"a/b":1,"k":0}', {}, ignoring("/a~1b"))).toBe(hash('{"a/b":2,"k":0}', {}, ignoring("/a~1b")));
      expect(hash('{"a~b":1,"k":0}', {}, ignoring("/a~0b"))).toBe(hash('{"a~b":2,"k":0}', {}, ignoring("/a~0b")));
      expect(hash('{"a/b":1,"a":{"b":1}}', {}, ignoring("/a~1b"))).not.toBe(hash('{"a/b":1,"a":{"b":2}}', {}, ignoring("/a~1b")));
    });
    it("does nothing for a path that leads nowhere, and never touches the prototype", () => {
      const nowhere = ignoring("/missing", "/amount/deeper", "/items/9", "/items/x", "/items/01", "/items/-1", "/items/1.0", "/__proto__/polluted", "/constructor/prototype/x");
      expect(hash('{"amount":5,"items":[1,2]}', {}, nowhere)).toBe(hash('{"amount":5,"items":[1,2]}'));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
    it("walks only a body's own members: a pointer through __proto__ cannot reach, let alone delete, anything on the prototype", () => {
      const original = Object.getOwnPropertyDescriptor(Object.prototype, "isPrototypeOf");
      try {
        hash('{"a":1}', {}, ignoring("/__proto__/isPrototypeOf", "/constructor/prototype/isPrototypeOf"));
        expect(Object.getOwnPropertyDescriptor(Object.prototype, "isPrototypeOf")).toEqual(original);
      } finally {
        if (original !== undefined) Object.defineProperty(Object.prototype, "isPrototypeOf", original);
      }
    });
    it("takes an own member called __proto__ out, like any other", () => {
      const match = ignoring("/__proto__");
      expect(hash('{"__proto__":{"a":1},"k":1}', {}, match)).toBe(hash('{"__proto__":{"a":2},"k":1}', {}, match));
      expect(hash('{"__proto__":{"a":1},"k":1}', {}, match)).not.toBe(hash('{"k":2}', {}, match));
    });
    it("leaves the caller's text alone", () => {
      const body = '{"a":1,"requestedAt":"x"}';
      hash(body, {}, ignoring("/requestedAt"));
      expect(body).toBe('{"a":1,"requestedAt":"x"}');
    });
  });

  describe("identifying query", () => {
    const match = { ignorePaths: [], query: ["customer", "page"] };
    const withQuery = (query: Array<{ name: string; value: string }>, m = match) => mocks.fixtureRequestHash({ dependency, match: m }, request({ query }));
    it("counts only the parameters the set matches on", () => {
      expect(withQuery([{ name: "customer", value: "c1" }, { name: "trace", value: "1" }])).toBe(withQuery([{ name: "customer", value: "c1" }, { name: "trace", value: "2" }]));
      expect(withQuery([{ name: "customer", value: "c1" }])).not.toBe(withQuery([{ name: "customer", value: "c2" }]));
    });
    it("does not depend on the order of the pairs", () => {
      expect(withQuery([{ name: "customer", value: "c1" }, { name: "page", value: "2" }])).toBe(withQuery([{ name: "page", value: "2" }, { name: "customer", value: "c1" }]));
    });
    it("tells a missing identifying parameter from a present one", () => {
      expect(withQuery([])).not.toBe(withQuery([{ name: "customer", value: "c1" }]));
      expect(withQuery([{ name: "customer", value: "" }])).not.toBe(withQuery([]));
    });
    it("keeps repeated values of one name apart, in a fixed order", () => {
      expect(withQuery([{ name: "customer", value: "b" }, { name: "customer", value: "a" }])).toBe(withQuery([{ name: "customer", value: "a" }, { name: "customer", value: "b" }]));
      expect(withQuery([{ name: "customer", value: "a" }])).not.toBe(withQuery([{ name: "customer", value: "a" }, { name: "customer", value: "b" }]));
    });
    it("ignores every parameter when the set matches on none", () => {
      expect(withQuery([{ name: "customer", value: "c1" }], { ignorePaths: [], query: undefined } as never)).toBe(withQuery([], { ignorePaths: [], query: undefined } as never));
    });
  });
});

describe("hash consistency", () => {
  it("finds an entry whose hash is not its own request's", () => {
    const good = parsed({ entries: [entryFor({ path: "/a" }), entryFor({ path: "/b" })] });
    expect(mocks.fixtureSetHashProblems(good)).toEqual([]);
    const tampered = { ...good, entries: [good.entries[0]!, { ...good.entries[1]!, request: { ...good.entries[1]!.request, path: "/c" } }] };
    expect(mocks.fixtureSetHashProblems(tampered)).toEqual([1]);
    expect(mocks.fixtureSetHashProblems({ ...good, match: { ...good.match, ignorePaths: [] } })).toEqual([0, 1]);
  });
  it("builds an entry whose hash is its request's", () => {
    const built = mocks.fixtureEntry({ dependency, match: baseMatch }, entryFor().request as never, entryFor().response as never);
    expect(built.requestHash).toBe(entryFor().requestHash);
  });
});

describe("v1 to v2 converter", () => {
  const v1Entry = (body: string, contentType = "application/json") => ({
    requestHash: mocks.serviceMockRequestHash({ service: "sagemaker_runtime", target: "partner-scorer", method: "POST", contentType, body }), request: { contentType, body },
    response: { status: 200, contentType: "application/json", body: '{"score":0.82}', latencyMs: 40 },
  });
  const v1 = (over: Record<string, unknown> = {}) => mocks.ServiceMockFixtureSetSchema.parse({
    schemaVersion: 1, service: { name: "Partner scorer", kind: "sagemaker_runtime", target: "partner-scorer" }, revision: 2, recordedAt: "2026-10-30T00:00:00.000Z", syntheticOnly: true,
    requestSchema: { type: "object", properties: { partner: { type: "string" } }, required: ["partner"] }, responseSchema: null,
    entries: [v1Entry('{"partner":"p1"}'), v1Entry('{"partner":"p2"}')], faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }], ...over,
  });
  const convert = (set: ReturnType<typeof v1>, options?: Parameters<typeof mocks.fixtureSetFromV1>[1]) => {
    const result = mocks.fixtureSetFromV1(set, options);
    if (!result.ok) throw new Error(result.reason);
    return result.set;
  };

  it("rebuilds a model endpoint set: POST /endpoints/<name>/invocations, rehashed under v2", () => {
    const out = convert(v1());
    expect(out).toMatchObject({ schemaVersion: 2, origin: "recorded", revision: 2, recordedAt: "2026-10-30T00:00:00.000Z", syntheticOnly: true, dependency: { id: "partner-scorer", family: "aws:sagemaker-runtime", protocol: "model_invoke", target: "partner-scorer" }, match: { ignorePaths: [] } });
    expect(out.entries.map((entry) => entry.request)).toEqual([
      { method: "POST", path: "/endpoints/partner-scorer/invocations", contentType: "application/json", body: '{"partner":"p1"}' },
      { method: "POST", path: "/endpoints/partner-scorer/invocations", contentType: "application/json", body: '{"partner":"p2"}' },
    ]);
    expect(mocks.fixtureSetHashProblems(out)).toEqual([]);
    expect(out.entries[0]!.requestHash).toBe(mocks.fixtureRequestHash(out, { method: "POST", path: "/endpoints/partner-scorer/invocations", contentType: "application/json", body: '{ "partner": "p1" }' }));
    expect(out.entries[0]!.response).toEqual({ status: 200, headers: [], contentType: "application/json", body: '{"score":0.82}', latencyMs: 40 });
    expect(out.faults).toEqual(v1().faults);
    expect(out.requestSchema).toEqual(v1().requestSchema);
    expect("responseSchema" in out).toBe(false);
    expect(mocks.FixtureSetSchema.safeParse(out).success).toBe(true);
  });
  it("is a different digest from the v1 set's, so the pin has to be renewed", () => {
    expect(mocks.fixtureSetDigest(convert(v1()))).not.toBe(mocks.serviceMockFixtureSetDigest(v1()));
  });
  it("keeps a v1 set with no entries", () => {
    expect(convert(v1({ entries: [] })).entries).toEqual([]);
  });
  it("will not place an http entry whose request line v1 never kept, unless the caller says what each was", () => {
    const http = (): ReturnType<typeof v1> => v1({ service: { name: "Payments API", kind: "http", target: "api.example-pay.com" } });
    expect(mocks.fixtureSetFromV1(http())).toEqual({ ok: false, reason: "request_line_unknown" });
    expect(mocks.fixtureSetFromV1(http(), { resolveRequest: () => undefined })).toEqual({ ok: false, reason: "request_line_unknown" });
    const seen: string[] = [];
    const out = convert(http(), { resolveRequest: (entry) => { seen.push(entry.request.body); return { method: "POST", path: "/v1/charges", query: [{ name: "customer", value: "c1" }] }; } });
    expect(seen).toEqual(['{"partner":"p1"}', '{"partner":"p2"}']);
    expect(out.dependency).toMatchObject({ family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" });
    expect(out.match.query).toEqual(["customer"]);
    expect(out.entries[0]!.request).toMatchObject({ method: "POST", path: "/v1/charges", query: [{ name: "customer", value: "c1" }] });
  });
  it("maps an AWS API set to its service, and refuses a host that is not an AWS endpoint", () => {
    const aws = (host: string) => v1({ service: { name: "Orders table", kind: "aws_api", target: host } });
    const place = { resolveRequest: () => ({ method: "POST" as const, path: "/" }) };
    expect(convert(aws("dynamodb.us-west-2.amazonaws.com"), place).dependency).toMatchObject({ family: "aws:dynamodb", protocol: "aws_json" });
    expect(mocks.fixtureSetFromV1(aws("example.com"), place)).toEqual({ ok: false, reason: "unreadable_host" });
  });
  it("gives an AWS set the wire protocol of its service, and refuses a service whose protocol cannot be known", () => {
    const aws = (host: string) => v1({ service: { name: "Some service", kind: "aws_api", target: host } });
    const place = { resolveRequest: () => ({ method: "POST" as const, path: "/" }) };
    const protocolOf = (service: string) => {
      const result = mocks.fixtureSetFromV1(aws(`${service}.us-west-2.amazonaws.com`), place);
      return result.ok ? result.set.dependency.protocol : result.reason;
    };
    for (const service of ["dynamodb", "kinesis", "events", "secretsmanager", "ssm", "kms", "states"]) expect(protocolOf(service), service).toBe("aws_json");
    for (const service of ["sns", "sts"]) expect(protocolOf(service), service).toBe("aws_query");
    for (const service of ["s3", "sqs", "lambda", "ec2", "iam", "rds", "apigateway"]) expect(protocolOf(service), service).toBe("protocol_unknown");
    // A form-encoded set has no body pointers: a converted query set carries none.
    const query = mocks.fixtureSetFromV1(aws("sns.us-west-2.amazonaws.com"), place);
    expect(query.ok && query.set.match.ignorePaths).toEqual([]);
  });
  it("refuses what does not parse as a v2 set, instead of repairing it", () => {
    expect(mocks.fixtureSetFromV1(v1({ service: { name: "Payments", kind: "http", target: "10.0.0.1" } }), { resolveRequest: () => ({ method: "POST", path: "/x" }) })).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.fixtureSetFromV1(v1({ service: { name: "Payments", kind: "http", target: "api.example-pay.com" } }), { resolveRequest: () => ({ method: "POST", path: "/a b" }) })).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.fixtureSetFromV1({ ...v1(), syntheticOnly: false } as never)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("E2E GET fixture converter", () => {
  const fixture = (over: Record<string, unknown> = {}): E2EApiMockFixture => ({
    schemaVersion: "source-backed-api-fixtures/v1", operationId: "getAccount", method: "GET", path: "/api/accounts", inputField: "accountId",
    variants: [
      { id: "success", inputValue: "acct-1", status: 200, body: { id: "acct-1", name: "Acme" } },
      { id: "refusal", inputValue: "acct-2", status: 403, body: { error: "forbidden" } },
      { id: "invalid-data", inputValue: "acct-3", status: 200, body: { id: 7 } },
    ], ...over,
  });
  const convert = (over: Record<string, unknown> = {}, options = { host: "accounts.example.com" }) => e2eApiMockFixtureToFixtureSet(fixture(over), options);

  it("turns each variant into an entry keyed by its query value, imported", () => {
    const result = convert();
    if (!result.ok) throw new Error(result.reason);
    const out = result.set;
    expect(out).toMatchObject({ schemaVersion: 2, origin: "imported", revision: 1, syntheticOnly: true, dependency: { id: "getaccount", family: "http:accounts.example.com", protocol: "http_json", target: "accounts.example.com" }, match: { ignorePaths: [], query: ["accountId"] }, faults: [] });
    expect("recordedAt" in out).toBe(false);
    expect(out.entries.map((entry) => [entry.request.method, entry.request.path, entry.request.query, entry.response.status, entry.response.body])).toEqual([
      ["GET", "/api/accounts", [{ name: "accountId", value: "acct-1" }], 200, '{"id":"acct-1","name":"Acme"}'],
      ["GET", "/api/accounts", [{ name: "accountId", value: "acct-2" }], 403, '{"error":"forbidden"}'],
      ["GET", "/api/accounts", [{ name: "accountId", value: "acct-3" }], 200, '{"id":7}'],
    ]);
    expect(out.entries.every((entry) => entry.response.contentType === "application/json" && entry.response.headers.length === 0)).toBe(true);
    expect(mocks.fixtureSetHashProblems(out)).toEqual([]);
  });
  it("finds each variant by the request the app would send, whatever other query parameters it adds", () => {
    const result = convert();
    if (!result.ok) throw new Error(result.reason);
    const find = (value: string, extra: Array<{ name: string; value: string }> = []) => result.set.entries.find((entry) => entry.requestHash === mocks.fixtureRequestHash(result.set, { method: "GET", path: "/api/accounts", query: [{ name: "accountId", value }, ...extra], contentType: "", body: "" }));
    expect(find("acct-2")?.response.status).toBe(403);
    expect(find("acct-3", [{ name: "trace", value: "9" }])?.response.body).toBe('{"id":7}');
    expect(find("acct-9")).toBeUndefined();
  });
  it("takes the revision the caller gives", () => {
    const result = convert({}, { host: "accounts.example.com", revision: 5 } as never);
    expect(result.ok && result.set.revision).toBe(5);
  });
  it("refuses a host it cannot name a family for, a body that is not JSON, and a fixture that does not parse", () => {
    expect(convert({}, { host: "10.0.0.1" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({}, { host: "localhost" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ variants: [{ id: "success", inputValue: "a", status: 200, body: undefined }, { id: "refusal", inputValue: "b", status: 403, body: {} }, { id: "invalid-data", inputValue: "c", status: 200, body: {} }] })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ method: "POST" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ path: "/a b" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ variants: [] })).toEqual({ ok: false, reason: "invalid" });
  });
  it("refuses a variant body over 64 KiB", () => {
    expect(convert({ variants: [{ id: "success", inputValue: "a", status: 200, body: { text: "x".repeat(70_000) } }, { id: "refusal", inputValue: "b", status: 403, body: {} }, { id: "invalid-data", inputValue: "c", status: 200, body: {} }] })).toEqual({ ok: false, reason: "invalid" });
  });
});
