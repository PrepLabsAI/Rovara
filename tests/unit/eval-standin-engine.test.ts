// L4-E56 (rows E5 and E6, R2): the pure half of the eval stand-in. Every claim has a control: the same request is the same bytes on both sides, a gap is always answered and counted, a made-up answer never reads as a stored one,
// a question that failed in a gap run is "not compared" only while the LATEST run that asked it hit the gap, the set and the summary are bound to one company and task, and the repository's own recordings are used first.
import { describe, expect, it } from "vitest";
import {
  EVAL_STAND_IN_BOOK_MAX_ENTRIES, EVAL_STAND_IN_BODY_MAX_BYTES, EVAL_STAND_IN_RECORDED_MAX_BYTES, EvalAnswerBook, isEvalStandInPlanHost, answerEvalStandInRequest, buildEvalStandInSetBytes, buildOpenApiFake, evalStandInNotCompared, evalStandInLine,
  evalStandInPathName, evalStandInRecordedFromValue, evalStandInRecordedKey, evalStandInRequestKey, evalStandInResultOf, generateEvalStandInAnswer, parseEvalStandInSetBytes, parseEvalStandInSummaryText,
  reviveEvalStandInPlan, serializeEvalStandInPlan, type EvalStandInPlan, type EvalStandInRequest,
} from "@agentx/contracts";

/** A string shaped like a PEM block, built at run time so no key-shaped literal sits in the source. */
const fakePem = (label: string): string => `${"-".repeat(5)}BEGIN ${label}${"-".repeat(5)}\n${"A".repeat(120)}\n${"-".repeat(5)}END ${label}${"-".repeat(5)}\n`;
const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OTHER_WORKSPACE = "1c9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c12";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const request = (overrides: Partial<EvalStandInRequest> = {}): EvalStandInRequest => ({ method: "GET", host: "open.tiktokapis.com", path: "/v2/user/info", query: "fields=display_name&username=ada", contentType: "", body: "", ...overrides });

const DOCUMENT = {
  openapi: "3.0.3", info: { title: "tiktok", version: "1" },
  paths: {
    "/v2/user/info": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "object", properties: { display_name: { type: "string" }, follower_count: { type: "integer", minimum: 1, maximum: 9 } } } } } } } } } } },
  },
};
const PLAN: EvalStandInPlan = [{ host: "open.tiktokapis.com", openapi: buildOpenApiFake(DOCUMENT, "openapi.json") }];

describe("the request key", () => {
  it("is the same for the same question however the client orders its query, and names no side, time or run", () => {
    expect(evalStandInRequestKey(request({ query: "username=ada&fields=display_name" }))).toBe(evalStandInRequestKey(request()));
    expect(evalStandInRequestKey(request({ method: "get", host: "OPEN.tiktokapis.com" }))).toBe(evalStandInRequestKey(request()));
    expect(evalStandInRequestKey(request())).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("differs for a different method, host, path, query or body, and ignores the key order of a JSON body", () => {
    const base = evalStandInRequestKey(request());
    for (const other of [request({ method: "POST" }), request({ host: "api.example.test" }), request({ path: "/v2/user/videos" }), request({ query: "username=bob" }), request({ contentType: "text/plain", body: "x" })]) expect(evalStandInRequestKey(other)).not.toBe(base);
    const json = (body: string) => request({ method: "POST", contentType: "application/json", body });
    expect(evalStandInRequestKey(json('{"a":1,"b":2}'))).toBe(evalStandInRequestKey(json('{"b":2,"a":1}')));
    expect(evalStandInRequestKey(json('{"a":1}'))).not.toBe(evalStandInRequestKey(json('{"a":2}')));
  });
});

describe("a gap is always answered, the same on both sides, and counted", () => {
  it("makes the same bytes for the same request, from two separate books (so a lost book changes nothing)", () => {
    const one = answerEvalStandInRequest(new EvalAnswerBook(), PLAN, request({ path: "/v2/user/videos" }));
    const two = answerEvalStandInRequest(new EvalAnswerBook(), PLAN, request({ path: "/v2/user/videos" }));
    expect(two).toEqual(one);
  });
  it("gives the second side the first side's answer from the SHARED book, without making it again", () => {
    const book = new EvalAnswerBook();
    let made = 0;
    const key = evalStandInRequestKey(request());
    const first = book.resolve(key, undefined, () => { made += 1; return { status: 200, contentType: "application/json", body: '{"n":1}', cls: "generated" }; });
    const second = book.resolve(key, undefined, () => { made += 1; return { status: 200, contentType: "application/json", body: '{"n":2}', cls: "generated" }; });
    expect(second).toBe(first);
    expect(made).toBe(1);
  });
  it("answers an operation the contract lists from the contract (class generated) and one it does not list with a minimal answer built from the request (generated_no_contract)", () => {
    const book = new EvalAnswerBook();
    const known = answerEvalStandInRequest(book, PLAN, request());
    expect(known).toMatchObject({ status: 200, cls: "generated" });
    expect(JSON.parse(known.body)).toEqual({ data: { display_name: "example", follower_count: expect.any(Number) as number } });
    const unknown = answerEvalStandInRequest(book, PLAN, request({ path: "/v2/user/videos", query: "" }));
    expect(unknown).toMatchObject({ status: 200, cls: "generated_no_contract" });
    expect(JSON.parse(unknown.body)).toMatchObject({ ok: true, request: { method: "GET", path: "/v2/user/videos" } });
  });
  it("shapes a new operation from the answer types of an SDK, and from the fields the caller reads", () => {
    const plan: EvalStandInPlan = [{
      host: "api.vendor.test",
      types: [{ method: "GET", template: "/things/{id}", schema: { type: "object", required: ["id", "total"], properties: { id: { type: "string" }, total: { type: "integer", minimum: 5, maximum: 5 } } } }],
      reads: ["data.user.display_name", "data.user.follower_count", "items[].id", "paging.has_more", "created_at"],
    }];
    const book = new EvalAnswerBook();
    const typed = answerEvalStandInRequest(book, plan, request({ host: "api.vendor.test", path: "/things/42", query: "" }));
    expect(typed.cls).toBe("generated");
    expect(JSON.parse(typed.body)).toMatchObject({ total: 5, id: expect.stringMatching(/^synthetic-/u) as string });
    const read = answerEvalStandInRequest(book, plan, request({ host: "api.vendor.test", path: "/other", query: "" }));
    expect(read.cls).toBe("generated_no_contract");
    const body = JSON.parse(read.body) as { data: { user: { display_name: string; follower_count: number } }; items: { id: string }[]; paging: { has_more: boolean }; created_at: string };
    expect(typeof body.data.user.display_name).toBe("string");
    expect(Number.isInteger(body.data.user.follower_count)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(typeof body.paging.has_more).toBe("boolean");
    expect(body.created_at).toBe("2026-01-01T00:00:00.000Z");
  });
  it("never stops: a host nobody named is a new connection, still answered, and POST gets a 201", () => {
    const book = new EvalAnswerBook();
    const answer = answerEvalStandInRequest(book, PLAN, request({ host: "never.seen.test", method: "POST", path: "/x" }));
    expect(answer).toMatchObject({ status: 201, cls: "new_connection" });
    const nameless = answerEvalStandInRequest(book, PLAN, request({ host: null, path: "/y" }));
    expect(nameless.cls).toBe("new_connection");
  });
  it("counts distinct answers by class and every call, and a repeat of a gap is still a gap call", () => {
    const book = new EvalAnswerBook();
    answerEvalStandInRequest(book, PLAN, request());
    answerEvalStandInRequest(book, PLAN, request());
    answerEvalStandInRequest(book, PLAN, request({ path: "/v2/user/videos" }));
    answerEvalStandInRequest(book, PLAN, request({ host: "never.seen.test" }));
    expect(book.counts()).toEqual({ recorded: 0, generated: 1, generatedNoContract: 1, newConnections: 1, served: 4, gapCalls: 4, saturated: false });
  });
  it("is bounded: a full book still answers (the same pure function) and says its counts are lower bounds", () => {
    const book = new EvalAnswerBook();
    for (let at = 0; at < EVAL_STAND_IN_BOOK_MAX_ENTRIES + 5; at += 1) answerEvalStandInRequest(book, PLAN, request({ path: `/p/${String(at)}`, query: "" }));
    const counts = book.counts();
    expect(counts.saturated).toBe(true);
    expect(counts.generatedNoContract).toBe(EVAL_STAND_IN_BOOK_MAX_ENTRIES);
    const again = answerEvalStandInRequest(new EvalAnswerBook(), PLAN, request({ path: `/p/${String(EVAL_STAND_IN_BOOK_MAX_ENTRIES + 4)}`, query: "" }));
    expect(answerEvalStandInRequest(book, PLAN, request({ path: `/p/${String(EVAL_STAND_IN_BOOK_MAX_ENTRIES + 4)}`, query: "" }))).toEqual(again);
  });
  it("keeps a body inside the limit even for a huge schema answer", () => {
    const schema = { type: "array" as const, minItems: 16, items: { type: "string" as const, minLength: 4_000 } };
    const answer = generateEvalStandInAnswer([{ host: "h.test", types: [{ method: "GET", template: "/big", schema }] }], request({ host: "h.test", path: "/big", query: "" }), "a".repeat(64));
    expect(new TextEncoder().encode(answer.body).length).toBeLessThanOrEqual(EVAL_STAND_IN_BODY_MAX_BYTES);
  });
});

describe("the repository's own recordings are used first and are not a gap", () => {
  it("answers from a cassette (class recorded, never counted as made up) and keeps the recorded bytes", () => {
    const book = new EvalAnswerBook();
    expect(book.preloadRecorded({ method: "GET", host: "open.tiktokapis.com", path: "/v2/user/info", query: "username=ada&fields=display_name", status: 200, contentType: "application/json", body: '{"data":{"display_name":"Ada"}}' })).toBe(true);
    const answer = answerEvalStandInRequest(book, PLAN, request());
    expect(answer).toMatchObject({ cls: "recorded", body: '{"data":{"display_name":"Ada"}}' });
    expect(book.counts()).toMatchObject({ recorded: 1, generated: 0, gapCalls: 0, served: 1 });
    expect(book.snapshot()).toHaveLength(1);
  });
  it("matches a cassette by method, host, path and query but not by the body a test happened to send", () => {
    const book = new EvalAnswerBook();
    book.preloadRecorded({ method: "POST", host: "api.vendor.test", path: "/search", query: "", status: 200, contentType: "application/json", body: '{"hits":[]}' });
    expect(answerEvalStandInRequest(book, [], request({ host: "api.vendor.test", method: "POST", path: "/search", query: "", contentType: "application/json", body: '{"q":"x"}' })).cls).toBe("recorded");
    expect(answerEvalStandInRequest(book, [], request({ host: "api.vendor.test", method: "POST", path: "/other", query: "" })).cls).toBe("new_connection");
    expect(evalStandInRecordedKey({ method: "post", host: "API.vendor.test", path: "/search", query: "" })).toBe(evalStandInRecordedKey({ method: "POST", host: "api.vendor.test", path: "/search", query: "" }));
  });
  it("refuses recordings past the total byte budget (they travel in the set file), keeping the ones that fit", () => {
    const book = new EvalAnswerBook();
    const body = "x".repeat(EVAL_STAND_IN_BODY_MAX_BYTES - 1);
    let accepted = 0;
    for (let at = 0; at < 80; at += 1) if (book.preloadRecorded({ method: "GET", host: "a.test", path: `/p/${String(at)}`, query: "", status: 200, contentType: "text/plain", body })) accepted += 1;
    expect(accepted).toBe(Math.floor(EVAL_STAND_IN_RECORDED_MAX_BYTES / (EVAL_STAND_IN_BODY_MAX_BYTES + 127)));
    expect(accepted).toBeLessThan(80);
  });
  it("only stands in for a dotted outside name, never localhost, a name under it, or a one-word name", () => {
    for (const ok of ["open.tiktokapis.com", "api.vendor.test", "a.b"]) expect(isEvalStandInPlanHost(ok)).toBe(true);
    for (const bad of ["localhost", "app.localhost", "redis", "Not A Host", "", "10.0.0.1"]) expect(isEvalStandInPlanHost(bad)).toBe(false);
    expect(serializeEvalStandInPlan([{ host: "localhost" }])).toBeUndefined();
    expect(reviveEvalStandInPlan([{ host: "redis" }])).toBeUndefined();
  });
  it("refuses a recorded answer with a bad host, status or size", () => {
    const book = new EvalAnswerBook();
    const good = { method: "GET", host: "a.test", path: "/", query: "", status: 200, contentType: "application/json", body: "{}" };
    expect(book.preloadRecorded({ ...good, host: "not a host" })).toBe(false);
    expect(book.preloadRecorded({ ...good, status: 99 })).toBe(false);
    expect(book.preloadRecorded({ ...good, body: "x".repeat(EVAL_STAND_IN_BODY_MAX_BYTES + 1) })).toBe(false);
  });
});

describe("recordings of every common shape (R2)", () => {
  const har = { log: { entries: [
    { request: { method: "GET", url: "https://api.vendor.test/v1/items?page=2" }, response: { status: 200, headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "session=SECRET" }], content: { mimeType: "application/json", text: '{"items":[1]}' } } },
    { request: { method: "GET", url: "https://api.vendor.test/v1/b64" }, response: { status: 200, content: { mimeType: "application/json", encoding: "base64", text: Buffer.from('{"b":1}').toString("base64") } } },
    { request: { method: "GET", url: "ftp://x.test/y" }, response: { status: 200, content: { text: "{}" } } },
    { request: { method: "GET", url: "https://api.vendor.test/redirect" }, response: { status: 302, content: { text: "" } } },
  ] } };
  it("reads a HAR file, drops redirects and non-http schemes, and keeps no header", () => {
    const read = evalStandInRecordedFromValue(har, undefined);
    expect(read.recorded.map((entry) => `${entry.method} ${entry.host}${entry.path}?${entry.query} ${String(entry.status)}`)).toEqual(["GET api.vendor.test/v1/items?page=2 200", "GET api.vendor.test/v1/b64? 200"]);
    expect(read.skipped).toBe(2);
    expect(JSON.stringify(read.recorded)).not.toContain("SECRET");
    expect(read.recorded[1]!.body).toBe('{"b":1}');
  });
  it("reads vcrpy and Ruby VCR cassettes", () => {
    const vcrpy = { interactions: [{ request: { method: "GET", uri: "https://api.vendor.test/v1/me" }, response: { status: { code: 200, message: "OK" }, headers: { "Content-Type": ["application/json"] }, body: { string: '{"me":1}' } } }], version: 1 };
    const ruby = { http_interactions: [{ request: { method: "get", uri: "https://api.vendor.test/v1/you", body: { string: "" } }, response: { status: { code: 404 }, body: { string: "{}" } } }] };
    expect(evalStandInRecordedFromValue(vcrpy, undefined).recorded).toMatchObject([{ method: "GET", host: "api.vendor.test", path: "/v1/me", status: 200, contentType: "application/json", body: '{"me":1}' }]);
    expect(evalStandInRecordedFromValue(ruby, undefined).recorded).toMatchObject([{ method: "GET", path: "/v1/you", status: 404 }]);
  });
  it("reads WireMock mappings and places a host-less one on the one planned host (and skips it when there is none)", () => {
    const mapping = { request: { method: "GET", urlPath: "/v1/things" }, response: { status: 200, jsonBody: { things: [] }, headers: { "Content-Type": "application/json" } } };
    expect(evalStandInRecordedFromValue({ mappings: [mapping] }, "api.vendor.test").recorded).toMatchObject([{ host: "api.vendor.test", path: "/v1/things", body: '{"things":[]}' }]);
    expect(evalStandInRecordedFromValue({ mappings: [mapping] }, undefined)).toEqual({ recorded: [], skipped: 1 });
    expect(evalStandInRecordedFromValue({ mappings: [{ request: { method: "GET", urlPattern: "/v1/.*" }, response: { status: 200, body: "x" } }] }, "api.vendor.test").recorded).toEqual([]);
  });
  it("reads nock fixtures and refuses a body past the limit, junk, and more entries than the limit", () => {
    const nock = [{ scope: "https://api.vendor.test", method: "POST", path: "/v1/make", status: 201, response: { made: true } }];
    expect(evalStandInRecordedFromValue(nock, undefined).recorded).toMatchObject([{ method: "POST", host: "api.vendor.test", path: "/v1/make", status: 201, body: '{"made":true}' }]);
    expect(evalStandInRecordedFromValue([{ scope: "https://a.test", method: "GET", path: "/", status: 200, response: "x".repeat(EVAL_STAND_IN_BODY_MAX_BYTES + 1) }], undefined).recorded).toEqual([]);
    for (const junk of [null, 7, "x", {}, [], [1, 2], { log: 1 }]) expect(evalStandInRecordedFromValue(junk, undefined).recorded).toEqual([]);
  });
});

describe("the gap rule: which questions are not compared", () => {
  const run = (side: "old" | "new", ids: string[], hitGap: boolean) => ({ side, ids, hitGap });
  it("drops a question that failed in the latest run that hit a gap, and keeps one that passed everywhere", () => {
    const dropped = evalStandInNotCompared([run("new", ["q0", "q1"], true)], new Set(["q1"]));
    expect([...dropped]).toEqual(["q1"]);
  });
  it("is cleared by a later re-ask that hit no gap (the re-ask of few questions isolates what the big first run could not)", () => {
    const runs = [run("new", ["q0", "q1", "q2"], true), run("old", ["q1"], false), run("new", ["q1"], false)];
    expect([...evalStandInNotCompared(runs, new Set(["q1"]))]).toEqual([]);
  });
  it("stays dropped when the re-ask on either side hit a gap again", () => {
    expect([...evalStandInNotCompared([run("new", ["q1"], false), run("old", ["q1"], true), run("new", ["q1"], false)], new Set(["q1"]))]).toEqual(["q1"]);
    expect([...evalStandInNotCompared([run("new", ["q1"], true), run("old", ["q1"], false), run("new", ["q1"], true)], new Set(["q1"]))]).toEqual(["q1"]);
  });
  it("drops nothing when no run hit a gap", () => {
    expect(evalStandInNotCompared([run("new", ["q0"], false)], new Set(["q0"])).size).toBe(0);
  });
});

describe("the set file is bound to one company and task and pinned by a digest", () => {
  const ca = { certPem: fakePem("CERTIFICATE"), keyPem: fakePem("PRIVATE " + "KEY") };
  const content = { workspaceId: WORKSPACE, operationId: OPERATION, plan: PLAN, recorded: [], book: [], ca };
  const built = buildEvalStandInSetBytes(content)!;
  it("round-trips the plan, and refuses another digest, company or task", () => {
    expect(built).toBeDefined();
    const parsed = parseEvalStandInSetBytes(built.bytes, { digest: built.digest, workspaceId: WORKSPACE, operationId: OPERATION })!;
    expect(parsed.plan[0]!.host).toBe("open.tiktokapis.com");
    expect(parsed.ca.keyPem).toBe(ca.keyPem);
    expect(parseEvalStandInSetBytes(built.bytes, { digest: "0".repeat(64), workspaceId: WORKSPACE, operationId: OPERATION })).toBeUndefined();
    expect(parseEvalStandInSetBytes(built.bytes, { digest: built.digest, workspaceId: OTHER_WORKSPACE, operationId: OPERATION })).toBeUndefined();
    expect(parseEvalStandInSetBytes(built.bytes, { digest: built.digest, workspaceId: WORKSPACE, operationId: OTHER_WORKSPACE })).toBeUndefined();
  });
  it("refuses bytes that were altered (even to a still-valid set), a plan with a bad host and a CA that is not PEM", () => {
    const text = new TextDecoder().decode(built.bytes);
    const tampered = new TextEncoder().encode(text.replace("open.tiktokapis.com", "evil.example.test"));
    expect(parseEvalStandInSetBytes(tampered, { digest: built.digest, workspaceId: WORKSPACE, operationId: OPERATION })).toBeUndefined();
    expect(buildEvalStandInSetBytes({ ...content, plan: [{ host: "Not A Host" }] })).toBeUndefined();
    expect(buildEvalStandInSetBytes({ ...content, ca: { certPem: "nope", keyPem: "nope" } })).toBeUndefined();
    expect(reviveEvalStandInPlan([{ host: "a.test", extra: 1 }])).toBeUndefined();
    expect(reviveEvalStandInPlan([{ host: "a.test" }, { host: "a.test" }])).toBeUndefined();
    expect(reviveEvalStandInPlan([{ host: "a.test", reads: ["bad path!"] }])).toBeUndefined();
    expect(serializeEvalStandInPlan([{ host: "a.test" }, { host: "a.test" }])).toBeUndefined();
  });
});

describe("the summary", () => {
  const trusted = { schemaVersion: 1, trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: "a".repeat(64), counts: { recorded: 0, generated: 1, generatedNoContract: 0, newConnections: 0, served: 2, gapCalls: 2, saturated: false }, foreign: 0, refused: 0, tlsFailed: 0, additions: [], gaps: [], newHosts: [] };
  it("parses one line and refuses junk, extra fields, extra lines and a field that is not a count", () => {
    expect(parseEvalStandInSummaryText(`${JSON.stringify(trusted)}\n`)).toMatchObject({ trusted: true, counts: { generated: 1 } });
    expect(parseEvalStandInSummaryText(`${JSON.stringify({ ...trusted, extra: 1 })}\n`)).toBeUndefined();
    expect(parseEvalStandInSummaryText(`${JSON.stringify(trusted)}\n${JSON.stringify(trusted)}\n`)).toBeUndefined();
    expect(parseEvalStandInSummaryText(`${JSON.stringify({ ...trusted, foreign: -1 })}\n`)).toBeUndefined();
    expect(parseEvalStandInSummaryText("not json")).toBeUndefined();
    expect(parseEvalStandInSummaryText("")).toBeUndefined();
  });
  it("names a path without its ids and turns counts into numbers-only words", () => {
    expect(evalStandInPathName("/v2/user/8841276543/videos?token=abc")).toBe("/v2/user/{id}/videos");
    expect(evalStandInPathName(`/x/${"a".repeat(30)}`)).toBe("/x/{id}");
    const result = evalStandInResultOf({ recorded: 2, generated: 1, generatedNoContract: 1, newConnections: 1, served: 9, gapCalls: 3, saturated: false }, 4);
    expect(result).toEqual({ recorded: 2, generated: 1, generatedNoContract: 1, newConnections: 1, notCompared: 4, saturated: false });
    const line = evalStandInLine(result);
    // L4-EINT (E9): the owner's words: "N answers were made up", "not compared".
    expect(line).toContain("3 answers were made up");
    expect(line).toContain("4 questions were not compared");
    expect(line).toContain("Both runs got the same answers.");
    expect(line).not.toMatch(/https?:|\/v2/u);
  });
});
