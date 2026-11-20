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
  it("keeps a recording once and a fault name once", () => {
    expect(ok(set({ entries: [entryFor(), entryFor()] }))).toBe(false);
    expect(ok(set({ faults: [{ name: "a", kind: "timeout", delayMs: 1 }, { name: "a", kind: "timeout", delayMs: 1 }] }))).toBe(false);
    expect(ok(set({ faults: Array.from({ length: 21 }, (_, n) => ({ name: `f${String(n)}`, kind: "timeout", delayMs: 1 })) }))).toBe(false);
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
  it("refuses a set over 4 MiB however its entries are spread", () => {
    const big = (count: number) => Array.from({ length: count }, (_, n) => ({ ...entryFor({ path: `/p${String(n)}`, body: "x".repeat(60_000) }), response: response({ body: "y".repeat(60_000) }) }));
    expect(ok(set({ entries: big(30) }))).toBe(true);
    expect(ok(set({ entries: big(40) }))).toBe(false);
  });
});

describe("request hash (v2)", () => {

  describe("ignorePaths", () => {
    const ignoring = (...ignorePaths: string[]) => ({ ignorePaths });
    it("does nothing for a path that leads nowhere, and never touches the prototype", () => {
      const nowhere = ignoring("/missing", "/amount/deeper", "/items/9", "/items/x", "/items/01", "/items/-1", "/items/1.0", "/__proto__/polluted", "/constructor/prototype/x");
      expect(hash('{"amount":5,"items":[1,2]}', {}, nowhere)).toBe(hash('{"amount":5,"items":[1,2]}'));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe("identifying query", () => {
    const match = { ignorePaths: [], query: ["customer", "page"] };
    const withQuery = (query: Array<{ name: string; value: string }>, m = match) => mocks.fixtureRequestHash({ dependency, match: m }, request({ query }));
    it("does not depend on the order of the pairs", () => {
      expect(withQuery([{ name: "customer", value: "c1" }, { name: "page", value: "2" }])).toBe(withQuery([{ name: "page", value: "2" }, { name: "customer", value: "c1" }]));
    });
    it("keeps repeated values of one name apart, in a fixed order", () => {
      expect(withQuery([{ name: "customer", value: "b" }, { name: "customer", value: "a" }])).toBe(withQuery([{ name: "customer", value: "a" }, { name: "customer", value: "b" }]));
      expect(withQuery([{ name: "customer", value: "a" }])).not.toBe(withQuery([{ name: "customer", value: "a" }, { name: "customer", value: "b" }]));
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

  it("is a different digest from the v1 set's, so the pin has to be renewed", () => {
    expect(mocks.fixtureSetDigest(convert(v1()))).not.toBe(mocks.serviceMockFixtureSetDigest(v1()));
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
  it("refuses a host it cannot name a family for, a body that is not JSON, and a fixture that does not parse", () => {
    expect(convert({}, { host: "10.0.0.1" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({}, { host: "localhost" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ variants: [{ id: "success", inputValue: "a", status: 200, body: undefined }, { id: "refusal", inputValue: "b", status: 403, body: {} }, { id: "invalid-data", inputValue: "c", status: 200, body: {} }] })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ method: "POST" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ path: "/a b" })).toEqual({ ok: false, reason: "invalid" });
    expect(convert({ variants: [] })).toEqual({ ok: false, reason: "invalid" });
  });
});
