// The HTTP EvalModelAccess against the gateway's whole-stage eval hold. No network: every request goes to an injected fetch
// that records it and answers like the gateway contract (one test uses a loopback server to prove the built-in fetch path).
// Money rules: a hold is used only when it is exactly the asked one; one attempt per call; every unreadable answer is an
// unknown cost that stops the stage and is released as unknown; release is sent once; at most one call over, flagged overrun.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalSpendGrant, ModelEgressEvent, ModelEgressFrame, ModelEgressScope } from "@agentx/contracts";
import { createEvalGatewayAccess, EvalGatewayUnknownCost, EVAL_GATEWAY_SCOPE_HEADER } from "../../packages/worker/src/verification/eval-gateway-access.js";
import { createEvalMeter, type EvalModelHold } from "../../packages/worker/src/verification/eval-model-access.js";

const GATEWAY = "https://gateway.example.test";
const TOKEN = "task-token-abcdefghijklmnop";
const SCOPE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const grant: EvalSpendGrant = { company: "company-a", project: "project-a", selection: "eval", role: "owner", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
const frame = (over: Partial<ModelEgressFrame> = {}): ModelEgressFrame => ({
  row: "gemini", method: "POST", path: "/v1beta/models/gemini-2.5-flash:generateContent", query: "",
  headers: [["content-type", "application/json"], ["x-goog-api-key", "dummy-key"], ["authorization", "Bearer other"], ["x-rovara-eval-scope", "forged"], ["accept", "application/json"]],
  body: new TextEncoder().encode("{\"contents\":[]}"), ...over,
});
const b64 = (text: string): string => Buffer.from(text).toString("base64");
type Line = Record<string, unknown> | string;
const head = (status = 200): Line => ({ kind: "head", status, headers: [["content-type", "application/json"], ["set-cookie", "provider"]] });
const chunk = (text = "{\"ok\":true}"): Line => ({ kind: "chunk", b64: b64(text) });
const settleLine = (over: Record<string, unknown> = {}): Line => ({ kind: "settle", status: 200, class: "ok", costMicros: 10, estimated: false, ...over });
const ndjson = (lines: readonly Line[], init: { status?: number; type?: string } = {}): Response =>
  new Response(lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", { status: init.status ?? 200, headers: { "content-type": init.type ?? "application/x-ndjson" } });
const parsed = (text: string): unknown => JSON.parse(text) as unknown;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Sent { url: string; method: string; headers: Record<string, string>; body: string; redirect: string | undefined; signal: AbortSignal | undefined }
type Answer = (sent: Sent, index: number) => Response | Promise<Response>;
/** A gateway: the hold answers with `holdAnswer`, each call with `call`, the release with 200. Records every request. */
function gateway(opts: { hold?: Answer; call?: Answer; release?: Answer } = {}) {
  const sent: Sent[] = []; let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : typeof init?.body === "string" ? init.body : "";
    const s: Sent = { url, method: init?.method ?? "GET", headers, body, redirect: init?.redirect, signal: init?.signal ?? undefined };
    sent.push(s);
    const path = new URL(url).pathname;
    if (path === "/v1/product/eval/hold") return (opts.hold ?? (() => { const asked = parsed(body) as { calls: number; costMicros: number }; return json({ scope: SCOPE, calls: asked.calls, costMicros: asked.costMicros, expiresAt: 1 }); }))(s, 0);
    if (path === "/v1/product/eval/release") return (opts.release ?? (() => json({ released: 0 })))(s, 0);
    return (opts.call ?? (() => ndjson([head(), chunk(), settleLine()])))(s, calls++);
  }) as typeof fetch;
  const holds = () => sent.filter(s => s.url.endsWith("/v1/product/eval/hold"));
  const releases = () => sent.filter(s => s.url.endsWith("/v1/product/eval/release"));
  const forwards = () => sent.filter(s => s.url.includes("/v1/product/gemini/"));
  return { fetchImpl, sent, holds, releases, forwards };
}
const access = (g: ReturnType<typeof gateway>, token: () => Promise<string> = async () => TOKEN) => createEvalGatewayAccess(GATEWAY, token, { fetch: g.fetchImpl });
async function events(hold: EvalModelHold, f: ModelEgressFrame = frame(), scope: ModelEgressScope = hold.scope, signal?: AbortSignal): Promise<ModelEgressEvent[]> {
  const out: ModelEgressEvent[] = [];
  for await (const e of hold.egress.forward(scope, f, signal === undefined ? undefined : { signal })) out.push(e);
  return out;
}
const lastSettle = (list: ModelEgressEvent[]) => list[list.length - 1] as Extract<ModelEgressEvent, { kind: "settle" }>;
const holdOf = async (g: ReturnType<typeof gateway>, calls = 3, costMicros = 100) => {
  const hold = await access(g).hold({ grant, calls, costMicros }); expect(hold).toBeDefined(); return hold!;
};
const holdAnswer = (calls: number, costMicros: number): Answer => () => json({ scope: SCOPE, calls, costMicros, expiresAt: 1 });

describe("hold", () => {
  it("posts the grant's nine fields, the estimate and the task token to the hold path, never following a redirect", async () => {
    const g = gateway();
    await holdOf(g);
    expect(g.holds()).toHaveLength(1);
    const [h] = g.holds();
    expect(h!.url).toBe(`${GATEWAY}/v1/product/eval/hold`); expect(h!.method).toBe("POST"); expect(h!.redirect).toBe("error");
    expect(h!.headers["x-api-key"]).toBe(TOKEN); expect(h!.headers["content-type"]).toBe("application/json");
    expect(parsed(h!.body)).toEqual({ grant, calls: 3, costMicros: 100 });
    expect(g.forwards()).toEqual([]); expect(g.releases()).toEqual([]);
  });
  it("sends no field of the caller's object beyond the grant's nine", async () => {
    const g = gateway();
    await access(g).hold({ grant: { ...grant, secret: "x", token: "y" } as unknown as EvalSpendGrant, calls: 3, costMicros: 100 });
    expect(Object.keys((parsed(g.holds()[0]!.body) as { grant: object }).grant).sort()).toEqual(Object.keys(grant).sort());
  });
  it.each([
    ["422 eval_hold_refused", () => json({ error: { type: "eval_hold_refused" } }, 422)],
    ["422 budget_exceeded", () => json({ error: { type: "budget_exceeded" } }, 422)],
    ["429 budget_held", () => json({ error: { type: "budget_held" } }, 429)],
    ["429 busy", () => json({ error: { type: "busy" } }, 429)],
    ["503 unavailable", () => json({ error: { type: "unavailable" } }, 503)],
    ["404 not_set_up", () => json({ error: { type: "not_set_up" } }, 404)],
    ["201 with a scope", () => json({ scope: SCOPE, calls: 3, costMicros: 100 }, 201)],
    ["200 that is not JSON", () => new Response(JSON.stringify({ scope: SCOPE, calls: 3, costMicros: 100 }), { status: 200, headers: { "content-type": "text/plain" } })],
    ["200 with unreadable JSON", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })],
    ["200 with no scope", () => json({ calls: 3, costMicros: 100 })],
    ["200 with a scope of another shape", () => json({ scope: "../release?x", calls: 3, costMicros: 100 })],
    ["200 with an over-long body", () => json({ scope: SCOPE, calls: 3, costMicros: 100, pad: "x".repeat(70_000) })],
    ["a transport fault", () => { throw new Error("socket-secret-detail"); }],
  ] as Array<[string, Answer]>)("%s is a refusal with nothing held, called and released", async (_name, answer) => {
    const g = gateway({ hold: answer });
    expect(await access(g).hold({ grant, calls: 3, costMicros: 100 })).toBeUndefined();
    expect(g.forwards()).toEqual([]); expect(g.releases()).toEqual([]);
  });
  it.each([[{ calls: 4, costMicros: 100 }], [{ calls: 3, costMicros: 101 }], [{ calls: 3, costMicros: 99 }], [{ calls: 2, costMicros: 100 }]])("a hold of another amount (%j) is given back at once, unspent, and refused", async held => {
    const g = gateway({ hold: holdAnswer(held.calls, held.costMicros) });
    expect(await access(g).hold({ grant, calls: 3, costMicros: 100 })).toBeUndefined();
    expect(g.releases().map(r => parsed(r.body))).toEqual([{ scope: SCOPE, calls: 0, costMicros: 0, unknown: false }]);
    expect(g.forwards()).toEqual([]);
  });
  it.each([
    ["throws", async () => { throw new Error("token-secret"); }],
    ["is empty", async () => ""],
    ["has a space", async () => "a b"],
    ["is not a string", async () => 7 as unknown as string],
  ] as Array<[string, () => Promise<string>]>)("no hold is asked for when the token source %s", async (_n, source) => {
    const g = gateway();
    expect(await access(g, source).hold({ grant, calls: 3, costMicros: 100 })).toBeUndefined();
    expect(g.sent).toEqual([]);
  });
  it.each([{ calls: 0, costMicros: 1 }, { calls: 1, costMicros: 0 }, { calls: 1.5, costMicros: 1 }, { calls: 1, costMicros: Number.NaN }, { calls: Number.MAX_SAFE_INTEGER + 1, costMicros: 1 }])("never asks for the estimate %j", async estimate => {
    const g = gateway();
    expect(await access(g).hold({ grant, ...estimate })).toBeUndefined();
    expect(await access(g).hold({ grant: undefined as never, calls: 1, costMicros: 1 })).toBeUndefined();
    expect(g.sent).toEqual([]);
  });
});

describe("one call", () => {
  it("forwards the frame to the product route with the scope and token, and only the body's type and accept headers", async () => {
    const g = gateway();
    const hold = await holdOf(g);
    const out = await events(hold, frame({ path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent", query: "alt=sse" }));
    const [f] = g.forwards();
    expect(f!.url).toBe(`${GATEWAY}/v1/product/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(f!.method).toBe("POST"); expect(f!.redirect).toBe("error");
    expect(f!.headers).toEqual({ "content-type": "application/json", accept: "application/json", [EVAL_GATEWAY_SCOPE_HEADER]: SCOPE, "x-api-key": TOKEN });
    expect(f!.body).toBe("{\"contents\":[]}");
    expect(out).toEqual([
      { kind: "head", status: 200, headers: [["content-type", "application/json"]] },
      { kind: "chunk", bytes: new TextEncoder().encode("{\"ok\":true}") },
      { kind: "settle", status: 200, class: "ok", costMicros: 10, estimated: false },
    ]);
  });
  it("passes the caller's abort signal to the request", async () => {
    const g = gateway(); const hold = await holdOf(g); const controller = new AbortController();
    await events(hold, frame(), hold.scope, controller.signal);
    expect(g.forwards()[0]!.signal).toBe(controller.signal);
  });
  it("keeps the settle's own fields: refusal word, tokens, estimated", async () => {
    const g = gateway({ call: () => ndjson([head(429), chunk("{}"), settleLine({ status: 429, class: "cap", refusal: "cap", costMicros: 0, inputTokens: 3, outputTokens: 0, estimated: true })]) });
    const hold = await holdOf(g);
    expect(lastSettle(await events(hold))).toEqual({ kind: "settle", status: 429, class: "cap", refusal: "cap", costMicros: 0, inputTokens: 3, outputTokens: 0, estimated: true });
  });
  it.each([
    ["a dot segment", { path: "/v1beta/models/../../eval/release" }],
    ["an encoded dot segment", { path: "/v1beta/models/%2e%2e:generateContent" }],
    ["another operation", { path: "/v1beta/models/m:countTokens" }],
    ["another version", { path: "/v2/models/m:generateContent" }],
    ["a key in the query", { query: "key=abc" }],
    ["a second query key", { query: "alt=sse&x=1" }],
    ["a GET", { method: "GET" }],
    ["a frame that does not parse", { row: "Not A Row" }],
  ] as Array<[string, Partial<ModelEgressFrame>]>)("%s is refused before anything is sent, at no cost", async (_n, over) => {
    const g = gateway(); const hold = await holdOf(g);
    const out = await events(hold, frame(over));
    expect(lastSettle(out)).toMatchObject({ class: "refused", refusal: "not_allowed", costMicros: 0 });
    expect(out[0]).toMatchObject({ kind: "head", status: 403 });
    expect(g.forwards()).toEqual([]);
  });
  it("another hold's scope is not found, at no cost, and nothing is sent", async () => {
    const g = gateway(); const hold = await holdOf(g); const other = await holdOf(g);
    expect(lastSettle(await events(hold, frame(), other.scope))).toMatchObject({ class: "refused", refusal: "not_found", costMicros: 0 });
    expect(g.forwards()).toEqual([]);
  });
  it("no token at call time sends nothing and costs nothing", async () => {
    const g = gateway(); let n = 0;
    const hold = (await createEvalGatewayAccess(GATEWAY, async () => { if (n++ > 0) throw new Error("gone"); return TOKEN; }, { fetch: g.fetchImpl }).hold({ grant, calls: 3, costMicros: 100 }))!;
    expect(lastSettle(await events(hold))).toMatchObject({ class: "refused", costMicros: 0 });
    expect(g.forwards()).toEqual([]);
  });
});

describe("every outcome class through the eval meter", () => {
  const cases: Array<[string, number, number]> = [["ok", 200, 10], ["rate_limit", 429, 0], ["quota", 429, 0], ["overloaded", 503, 0], ["cap", 429, 0], ["key_refused", 401, 0], ["provider_error", 502, 7], ["refused", 400, 0]];
  it.each(cases)("%s keeps its class and its known cost, and the release says what was spent", async (cls, status, cost) => {
    const g = gateway({ call: () => ndjson([head(status), chunk(), settleLine({ status, class: cls, costMicros: cost })]) });
    const reservation = (await createEvalMeter(access(g)).reserve({ approval: grant, calls: 3, costMicros: 100 }))!;
    const result = await reservation.call(frame());
    expect(result.class).toBe(cls); expect(result.costMicros).toBe(cost); expect(result.calls).toBe(1);
    expect(result.events === undefined).toBe(cls !== "ok");
    await reservation.close();
    expect(g.releases().map(r => parsed(r.body))).toEqual([{ scope: SCOPE, calls: 1, costMicros: cost, unknown: false }]);
  });
});

describe("an unreadable answer is an unknown cost", () => {
  const unknownCases: Array<[string, Answer]> = [
    ["a 500", () => ndjson([head(), settleLine()], { status: 500 })],
    ["a 502 JSON error", () => json({ error: "x" }, 502)],
    ["a 200 that is not NDJSON", () => ndjson([head(), settleLine()], { type: "application/json" })],
    ["a transport fault", () => { throw new Error("socket-secret"); }],
    ["a line that is not JSON", () => ndjson([head(), "{not json", settleLine()])],
    ["a chunk before the head", () => ndjson([chunk(), head(), settleLine()])],
    ["two heads", () => ndjson([head(), head(), settleLine()])],
    ["a settle with no head", () => ndjson([settleLine()])],
    ["two settles", () => ndjson([head(), settleLine(), settleLine()])],
    ["a chunk after the settle", () => ndjson([head(), settleLine(), chunk()])],
    ["no settle", () => ndjson([head(), chunk()])],
    ["an empty answer", () => new Response("", { status: 200, headers: { "content-type": "application/x-ndjson" } })],
    ["an event of another kind", () => ndjson([head(), { kind: "trailer" }, settleLine()])],
    ["chunk bytes that are not base64", () => ndjson([head(), { kind: "chunk", b64: "@@@" }, settleLine()])],
    ["chunk bytes with no b64", () => ndjson([head(), { kind: "chunk", bytes: "x" }, settleLine()])],
    ["a settle with a fractional cost", () => ndjson([head(), settleLine({ costMicros: 1.5 })])],
    ["a settle with a negative cost", () => ndjson([head(), settleLine({ costMicros: -1 })])],
    ["a settle with a string cost", () => ndjson([head(), settleLine({ costMicros: "10" })])],
    ["a settle with no cost", () => ndjson([head(), { kind: "settle", status: 200, class: "ok", estimated: false }])],
    ["a settle of an unknown class", () => ndjson([head(), settleLine({ class: "fine" })])],
    ["a settle with an unknown refusal word", () => ndjson([head(), settleLine({ refusal: "maybe" })])],
    ["a settle with no estimated flag", () => ndjson([head(), { kind: "settle", status: 200, class: "ok", costMicros: 10 }])],
    ["a settle whose overrun is not a boolean", () => ndjson([head(), settleLine({ overrun: "yes" })])],
    ["a head with no status", () => ndjson([{ kind: "head", headers: [] }, settleLine()])],
    ["a head whose headers are not pairs", () => ndjson([{ kind: "head", status: 200, headers: { a: "b" } }, settleLine()])],
    ["bytes that are not UTF-8", () => new Response(new Uint8Array([0xff, 0xfe, 0x0a]), { status: 200, headers: { "content-type": "application/x-ndjson" } })],
  ];
  it.each(unknownCases)("%s: provider_error with an unknown cost, the stage stops, the release says unknown", async (_n, answer) => {
    const g = gateway({ call: answer });
    const reservation = (await createEvalMeter(access(g)).reserve({ approval: grant, calls: 3, costMicros: 100 }))!;
    const result = await reservation.call(frame());
    expect(result.class).toBe("provider_error"); expect(Number.isNaN(result.costMicros)).toBe(true);
    await expect(reservation.call(frame())).rejects.toThrow();
    await reservation.close();
    expect(g.forwards()).toHaveLength(1);
    expect(g.releases().map(r => parsed(r.body))).toEqual([{ scope: SCOPE, calls: 1, costMicros: 0, unknown: true }]);
  });
  it.each(unknownCases)("%s, read straight from the egress: one fixed fault, nothing more sent, released as unknown whatever the meter says", async (_n, answer) => {
    const g = gateway({ call: answer });
    const hold = await holdOf(g);
    await expect(events(hold)).rejects.toBeInstanceOf(EvalGatewayUnknownCost);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(1);
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 0, unknown: true });
  });
  it("the egress throws one fixed error that carries nothing of the answer or the token", async () => {
    const g = gateway({ call: () => new Response(`{"kind":"head","status":200,"headers":[]}\n{"secret":"${TOKEN}"}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } }) });
    const hold = await holdOf(g);
    const error = await events(hold).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(EvalGatewayUnknownCost);
    expect(String((error as Error).message)).toBe("eval gateway call failed");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
  it("a stream cut off mid-way (an abort) is an unknown cost and the stage sends nothing more", async () => {
    const g = gateway({
      call: () => new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify(head())}\n`)); c.error(new Error("cut")); },
      }), { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    });
    const hold = await holdOf(g);
    await expect(events(hold)).rejects.toBeInstanceOf(EvalGatewayUnknownCost);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(1);
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 0, unknown: true });
  });
  it("an answer past the stream limit is an unknown cost", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk("x".repeat(4096)), settleLine()]) });
    const hold = (await createEvalGatewayAccess(GATEWAY, async () => TOKEN, { fetch: g.fetchImpl, streamBytes: 1024 }).hold({ grant, calls: 3, costMicros: 100 }))!;
    await expect(events(hold)).rejects.toBeInstanceOf(EvalGatewayUnknownCost);
  });
  it("an answer exactly at the stream limit is read", async () => {
    const body = [head(), chunk("abc"), settleLine()].map(l => JSON.stringify(l)).join("\n") + "\n";
    const g = gateway({ call: () => ndjson([head(), chunk("abc"), settleLine()]) });
    const hold = (await createEvalGatewayAccess(GATEWAY, async () => TOKEN, { fetch: g.fetchImpl, streamBytes: Buffer.byteLength(body) }).hold({ grant, calls: 3, costMicros: 100 }))!;
    expect(lastSettle(await events(hold))).toMatchObject({ class: "ok", costMicros: 10 });
  });
  it("blank lines and a last line with no newline are read", async () => {
    const g = gateway({ call: () => new Response(`\n${JSON.stringify(head())}\n\n${JSON.stringify(settleLine({ costMicros: 4 }))}`, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } }) });
    const hold = await holdOf(g);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "ok", costMicros: 4 });
  });
});

describe("the held count and cost: at most one call over, flagged overrun (#704)", () => {
  it("sends nothing once the known spend reached the held cost", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 50 })]) });
    const hold = await holdOf(g, 9, 100);
    await events(hold); await events(hold);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(2);
  });
  it("sends one call while the known spend is one below the held cost", async () => {
    const g = gateway({ call: (_s, i) => ndjson([head(), chunk(), settleLine({ costMicros: i === 0 ? 99 : 1 })]) });
    const hold = await holdOf(g, 9, 100);
    await events(hold);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "ok", costMicros: 1 });
    expect(g.forwards()).toHaveLength(2);
  });
  it("sends nothing past the held call count", async () => {
    const g = gateway();
    const hold = await holdOf(g, 2, 100);
    await events(hold); await events(hold);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(2);
  });
  it("flags a settle that takes the known spend past the hold as overrun, even when the gateway did not, and stops", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 101 })]) });
    const hold = await holdOf(g, 9, 100);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "ok", costMicros: 101, overrun: true });
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(1);
  });
  it("the gateway's overrun flag stops the stage at once, below the held cost, and nothing more is sent", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 5, overrun: true })]) });
    const hold = await holdOf(g, 9, 100);
    expect(lastSettle(await events(hold))).toMatchObject({ class: "ok", costMicros: 5, overrun: true });
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", refusal: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(1);
    await hold.release({ calls: 1, costMicros: 5, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 5, unknown: false });
  });
  it("a settle past the hold stops the stage even when a later call would still fit the count", async () => {
    const g = gateway({ call: (_s, i) => ndjson([head(), chunk(), settleLine({ costMicros: i === 0 ? 60 : 50 })]) });
    const hold = await holdOf(g, 9, 100);
    await events(hold);
    expect(lastSettle(await events(hold))).toMatchObject({ costMicros: 50, overrun: true });
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toHaveLength(2);
  });
  it("a settle that ends exactly at the hold is not an overrun", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 100 })]) });
    const hold = await holdOf(g, 9, 100);
    expect(lastSettle(await events(hold)).overrun).toBeUndefined();
  });
  it("keeps the gateway's overrun flag and stops the stage with the cost known", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 5, overrun: true })]) });
    const reservation = (await createEvalMeter(access(g)).reserve({ approval: grant, calls: 9, costMicros: 100 }))!;
    const first = await reservation.call(frame());
    expect(first).toMatchObject({ class: "ok", costMicros: 5 });
    await expect(reservation.call(frame())).rejects.toThrow();
    await reservation.close();
    expect(g.forwards()).toHaveLength(1);
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 5, unknown: false });
  });
  it("calls already open when the hold is reached settle at their real cost and the release counts all of them", async () => {
    let free: () => void = () => undefined; const gate = new Promise<void>(r => { free = r; });
    const g = gateway({ call: async (_s, i) => { if (i === 0) await gate; return ndjson([head(), chunk(), settleLine({ costMicros: i === 0 ? 30 : 100 })]); } });
    const hold = await holdOf(g, 9, 100);
    const late = events(hold);
    await new Promise(r => setTimeout(r, 0));
    expect(g.forwards()).toHaveLength(1);
    expect(lastSettle(await events(hold)).overrun).toBeUndefined();
    free();
    expect(lastSettle(await late)).toMatchObject({ costMicros: 30, overrun: true });
    await hold.release({ calls: 2, costMicros: 130, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 2, costMicros: 130, unknown: false });
  });
});

describe("release", () => {
  it("is posted once with the scope, the token and the spend, and a second release sends nothing", async () => {
    const g = gateway(); const hold = await holdOf(g);
    await events(hold);
    await hold.release({ calls: 1, costMicros: 10, unknown: false });
    await expect(hold.release({ calls: 1, costMicros: 10, unknown: false })).rejects.toThrow("already released");
    expect(g.releases()).toHaveLength(1);
    const [r] = g.releases();
    expect(r!.url).toBe(`${GATEWAY}/v1/product/eval/release`); expect(r!.headers["x-api-key"]).toBe(TOKEN); expect(r!.redirect).toBe("error");
    expect(parsed(r!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 10, unknown: false });
  });
  it("never reports less than the adapter itself counted", async () => {
    const g = gateway({ call: () => ndjson([head(), chunk(), settleLine({ costMicros: 40 })]) });
    const hold = await holdOf(g, 9, 100);
    await events(hold); await events(hold);
    await hold.release({ calls: 1, costMicros: 10, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 2, costMicros: 80, unknown: false });
  });
  it("keeps the meter's larger report and its unknown", async () => {
    const g = gateway(); const hold = await holdOf(g);
    await hold.release({ calls: 3, costMicros: 70, unknown: true });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 3, costMicros: 70, unknown: true });
  });
  it("a malformed report is released as unknown", async () => {
    const g = gateway(); const hold = await holdOf(g);
    await hold.release({ calls: -1, costMicros: 1.5, unknown: "no" } as never);
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 0, costMicros: 0, unknown: true });
  });
  it("a call still open at the release makes it unknown", async () => {
    const g = gateway({ call: () => new Promise<Response>(() => undefined) });
    const hold = await holdOf(g);
    void events(hold).catch(() => undefined);
    await new Promise(r => setTimeout(r, 0));
    await hold.release({ calls: 1, costMicros: 0, unknown: false });
    expect(parsed(g.releases()[0]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 0, unknown: true });
  });
  it("after the release nothing more is sent", async () => {
    const g = gateway(); const hold = await holdOf(g);
    await hold.release({ calls: 0, costMicros: 0, unknown: false });
    expect(lastSettle(await events(hold))).toMatchObject({ class: "cap", costMicros: 0 });
    expect(g.forwards()).toEqual([]);
  });
  it.each([
    ["a 503", () => json({ error: { type: "unavailable" } }, 503)],
    ["a 409", () => json({ error: { type: "already_released" } }, 409)],
    ["a fault", () => { throw new Error("socket"); }],
  ] as Array<[string, Answer]>)("%s fails the release once, with no retry", async (_n, answer) => {
    const g = gateway({ release: answer }); const hold = await holdOf(g);
    await expect(hold.release({ calls: 0, costMicros: 0, unknown: false })).rejects.toThrow("eval hold could not be released");
    await expect(hold.release({ calls: 0, costMicros: 0, unknown: false })).rejects.toThrow();
    expect(g.releases()).toHaveLength(1);
  });
  it("the meter's close sends exactly one release after its calls joined", async () => {
    const g = gateway();
    const reservation = (await createEvalMeter(access(g)).reserve({ approval: grant, calls: 3, costMicros: 100 }))!;
    await Promise.all([reservation.call(frame()), reservation.call(frame())]);
    await reservation.close(); await reservation.close();
    expect(g.releases().map(r => parsed(r.body))).toEqual([{ scope: SCOPE, calls: 2, costMicros: 20, unknown: false }]);
  });
});

describe("the gateway address", () => {
  it.each(["http://gateway.example.test", "https://user:pw@gateway.example.test", "https://gateway.example.test/?a=1", "https://gateway.example.test/#x", "ftp://gateway.example.test", "not a url"])("refuses %s", url => {
    expect(() => createEvalGatewayAccess(url, async () => TOKEN)).toThrow();
  });
  it("refuses a token source that is not a function", () => {
    expect(() => createEvalGatewayAccess(GATEWAY, undefined as never)).toThrow();
  });
  it("keeps a base path and drops a trailing slash", async () => {
    const g = gateway();
    await createEvalGatewayAccess(`${GATEWAY}/gw/`, async () => TOKEN, { fetch: g.fetchImpl }).hold({ grant, calls: 3, costMicros: 100 });
    expect(g.sent[0]!.url).toBe(`${GATEWAY}/gw/v1/product/eval/hold`);
  });
});

describe("with the built-in fetch against a loopback gateway", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });
  it("holds, forwards and releases over HTTP", async () => {
    const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(parts).toString() });
        if (req.url === "/v1/product/eval/hold") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ scope: SCOPE, calls: 2, costMicros: 50, expiresAt: 1 })); return; }
        if (req.url === "/v1/product/eval/release") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ released: 40 })); return; }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify(head())}\n`); res.write(`${JSON.stringify(chunk("hi"))}\n`); res.end(`${JSON.stringify(settleLine({ costMicros: 10 }))}\n`);
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    close = () => new Promise<void>(r => server.close(() => r()));
    const { port } = server.address() as AddressInfo;
    const reservation = (await createEvalMeter(createEvalGatewayAccess(`http://127.0.0.1:${port}`, async () => TOKEN)).reserve({ approval: grant, calls: 2, costMicros: 50 }))!;
    const result = await reservation.call(frame());
    expect(result).toMatchObject({ class: "ok", costMicros: 10, calls: 1 });
    await reservation.close();
    expect(seen.map(s => s.url)).toEqual(["/v1/product/eval/hold", "/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent", "/v1/product/eval/release"]);
    expect(seen[1]!.headers[EVAL_GATEWAY_SCOPE_HEADER]).toBe(SCOPE); expect(seen[1]!.headers["x-api-key"]).toBe(TOKEN); expect(seen[1]!.headers["x-goog-api-key"]).toBeUndefined();
    expect(parsed(seen[2]!.body)).toEqual({ scope: SCOPE, calls: 1, costMicros: 10, unknown: false });
  });
});
