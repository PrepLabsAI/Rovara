import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { NotSentError } from "../../packages/model-gateway/src/provider.js";
import { call, setup, scope, caps, mint, answer, sse, requestBody, MemorySink, now } from "./model-gateway-fixture.js";
it("R3 streams while held, settles usage, refuses the next call without sending, and prices unknown above zero", async () => {
  let release!: () => void; let opened!: () => void;
  const pause = new Promise<void>((r) => { release = r; }); const start = new Promise<void>((r) => { opened = r; });
  let sent = 0;
  const f = setup({ caps: new FixedCapsSource({ ...caps, task: 250 }), transport: async () => { sent++; return { status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 2 } } }); opened(); await pause; yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop"); })() }; } });
  const running = call(f.deps); await start;
  expect((await f.meter.read(scope))[0]).toMatchObject({ spentMicros: 0 }); expect((await f.meter.read(scope))[0]!.reservedMicros).toBeGreaterThan(0);
  release(); expect((await running).status).toBe(200);
  expect((await f.meter.read(scope))[0]).toMatchObject({ spentMicros: 12, reservedMicros: 0 });
  const refused = await call(f.deps, { ...requestBody, max_tokens: 200 }); expect(refused.status).toBe(422); expect(refused.text()).toContain("Budget has been exceeded! Key=task"); expect(sent).toBe(1);
  const unknown = setup({ prices: { priceFor: () => undefined } });
  const result = await call(unknown.deps); expect(result.status).toBe(200);
  expect((await unknown.meter.read(scope))[0]!.spentMicros).toBeGreaterThan(0);
  expect(unknown.logs).toContainEqual(expect.objectContaining({ event: "settled", estimated: true }));
});
it("charges no not-sent fault, charges every post-send fault in full, settles once even on sink throws", async () => {
  for (const notSent of [true, false]) {
    const f = setup({ transport: async () => { throw notSent ? new NotSentError() : new Error("sensitive cause"); } });
    const result = await call(f.deps); expect(result.status).toBe(502); expect(result.text()).not.toContain("sensitive");
    const spent = (await f.meter.read(scope))[0]!.spentMicros; expect(notSent ? spent === 0 : spent > 0).toBe(true);
    expect(f.logs.filter((x) => (x as { event: string }).event === "settled")).toHaveLength(1);
  }
  const f = setup(); const sink = new MemorySink(); sink.write = async () => { throw new Error("private key"); };
  await call(f.deps, requestBody, mint(), sink);
  expect((await f.meter.read(scope))[0]!.spentMicros).toBeGreaterThan(19);
  expect(f.logs.filter((x) => (x as { event: string }).event === "settled")).toHaveLength(1);
});
it("fixed auth failures, ended refusal, oversize refusal and no secrets in headers, answers or logs", async () => {
  const f = setup(); const bad = await call(f.deps, requestBody, "secret");
  expect(bad.status).toBe(401); expect(bad.text()).toBe('{"error":{"type":"authentication_error","message":"invalid or expired model access"}}');
  const ok = await call(f.deps, requestBody, mint(), new MemorySink(), { authorization: `Bearer ${mint()}` });
  expect(ok.status).toBe(200); expect(f.calls[0]?.headers.authorization).toBeUndefined(); expect(f.calls[0]?.headers["x-api-key"]).toBeUndefined();
  f.ended.end(scope.iss, scope.cid, scope.tid); expect((await call(f.deps)).text()).toContain("task_ended"); expect(f.calls).toHaveLength(1);
  const other = setup(); expect((await call(other.deps, Buffer.alloc(4 * 1024 * 1024 + 1))).status).toBe(413); expect(other.calls).toHaveLength(0);
  expect(JSON.stringify([f.logs, ok.text(), ok.headers, bad.text()])).not.toContain(f.providerKey);
});
it("never refuses unknown, throwing or malformed prices and settles at cautious usage", async () => {
  for (const priceFor of [() => undefined, () => { throw new Error("secret"); }, () => ({ inputMicrosPerMTok: 0, outputMicrosPerMTok: NaN })]) {
    const f = setup({ prices: { priceFor } });
    let held = 0; f.deps.transport = async () => { held = (await f.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
    expect((await call(f.deps)).status).toBe(200); expect(held).toBeGreaterThan(0); expect((await f.meter.read(scope))[0]!.spentMicros).toBe(1_800);
  }
});
it("reports other holds as 429 with retry-after, keeps fixed scope prefixes", async () => {
  const f = setup({ caps: new FixedCapsSource({ ...caps, task: 250 }) });
  await f.meter.reserve({ scope, caps: { ...caps, task: 250 }, estimateMicros: 200 });
  const r = await call(f.deps); expect(r.status).toBe(429); expect(r.headers["retry-after"]).toBe("2"); expect(r.text()).toContain("budget_held");
  for (const [field, prefix] of [["personMonth", "ExceededBudget: User="], ["projectMonth", "Budget has been exceeded! Project="], ["companyMonth", "Budget has been exceeded! Team="]]) {
    const x = setup({ caps: new FixedCapsSource({ ...caps, [field!]: 0 }) }); const response = await call(x.deps); expect(response.status).toBe(422); expect(response.text()).toContain(prefix);
  }
});
it("cuts leaked provider keys and broken streams, retaining the full hold", async () => {
  const f = setup(); f.deps.transport = async () => ({ status: 200, body: (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 2 } } }); yield sse("content_block_delta", { delta: { type: "text_delta", text: f.providerKey } }); yield sse("message_delta", { usage: { output_tokens: 5 } }); yield sse("message_stop"); })() });
  const response = await call(f.deps); expect(response.text()).not.toContain(f.providerKey); expect(response.destroyed).toBe(true);
  expect((await f.meter.read(scope))[0]!.spentMicros).toBeGreaterThan(19);
});
it("uses one total deadline over a slow stream, cancels it and settles once", async () => {
  let cancelled = false;
  const f = setup({ timeoutMs: 20, transport: async () => ({ status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: () => { cancelled = true; } }) });
  const r = await call(f.deps); expect(r.destroyed).toBe(true); expect(cancelled).toBe(true);
  expect((await f.meter.read(scope))[0]!.spentMicros).toBeGreaterThan(19);
  expect(f.logs.filter((x) => (x as { event: string }).event === "settled")).toHaveLength(1);
});
it("keeps a failed settle reserved, handles key-port failures and strips all provider error text", async () => {
  const f = setup(); let settles = 0;
  f.deps.meter = { pendingExpired: (now, n, c) => f.meter.pendingExpired(now, n, c), expire: (c) => f.meter.expire(c), pendingKeys: (n) => f.meter.pendingKeys(n), pendingFor: (k, n) => f.meter.pendingFor(k, n), correct: (c) => f.meter.correct(c), reserve: (r) => f.meter.reserve(r), read: (s) => f.meter.read(s), settle: async () => { settles++; throw new Error(f.providerKey); } };
  await call(f.deps); expect(settles).toBe(1); expect((await f.meter.read(scope))[0]!.reservedMicros).toBeGreaterThan(0); expect(JSON.stringify(f.logs)).not.toContain(f.providerKey);
  const k = setup({ keys: { keyFor: async () => { throw new Error("private cause"); } } });
  expect((await call(k.deps)).text()).not.toContain("private"); expect((await k.meter.read(scope))[0]!.spentMicros).toBe(0);
  for (const status of [302, 401, 403, 429, 500]) {
    const e = setup(); e.deps.transport = async () => ({ status, body: (async function* () { yield Buffer.from(e.providerKey); })() });
    const response = await call(e.deps); expect(response.status).toBe(502); expect(response.text()).toBe('{"error":{"type":"provider_error","message":"provider unavailable"}}');
    const spent = (await e.meter.read(scope))[0]!.spentMicros;
    if (status === 429) expect(spent).toBe(0); else expect(spent).toBeGreaterThan(0);
  }
});
it("uses person caps for member payers, refuses ambiguous auth, and isolates companies through the full handler", async () => {
  const f = setup({ caps: new FixedCapsSource({ ...caps, personMonth: 0 }) });
  expect((await call(f.deps)).status).toBe(422);
  expect((await call(f.deps, requestBody, mint({ per: undefined, pay: { kind: "project", project: scope.pid } }))).status).toBe(200);
  const bad = await call(f.deps, requestBody, mint(), new MemorySink(), { authorization: "Bearer different" }); expect(bad.status).toBe(401);
  const g = setup(); const other = `org_${"b".repeat(20)}`;
  await call(g.deps, requestBody, mint({ cid: other }));
  expect((await g.meter.read(scope))[0]?.spentMicros).toBe(0);
  expect((await g.meter.read({ ...scope, cid: other }))[0]?.spentMicros).toBe(23);
});
it("charges a member payer's person row when requester differs", async () => {
  const requester = "c".repeat(64); const payer = "d".repeat(64);
  const f = setup();
  const result = await call(f.deps, requestBody, mint({ per: requester, pay: { kind: "member", developerId: payer } }));
  expect(result.status).toBe(200);
  expect((await f.meter.read({ ...scope, per: payer })).find(row => row.item === "person")?.spentMicros).toBe(23);
  expect((await f.meter.read({ ...scope, per: requester })).find(row => row.item === "person")?.spentMicros ?? 0).toBe(0);
});
it("caps a member payer's person row when requester is absent", async () => {
  const payer = "d".repeat(64);
  const f = setup({ caps: new FixedCapsSource({ ...caps, personMonth: 0 }) });
  const result = await call(f.deps, requestBody, mint({ per: undefined, pay: { kind: "member", developerId: payer } }));
  expect(result.status).toBe(422);
  expect(result.text()).toContain("ExceededBudget: User=");
  expect((await f.meter.read({ ...scope, per: payer })).find(row => row.item === "person")?.spentMicros ?? 0).toBe(0);
});
it("rejects response byte overflow and malformed usage, and never follows a redirect or retries", async () => {
  for (const body of [(async function* () { yield Buffer.alloc(10 * 1024 * 1024 + 1); })(), (async function* () { yield sse("message_start", { message: { usage: { input_tokens: 2 } } }); yield Buffer.from("data: broken\n\n"); })()]) {
    let sends = 0; const f = setup({ transport: async () => { sends++; return { status: 200, body }; } });
    expect((await call(f.deps)).destroyed).toBe(true); expect(sends).toBe(1); expect((await f.meter.read(scope))[0]!.spentMicros).toBeGreaterThan(19);
  }
});
it("runs the node:http adapter without a socket and preserves health and route bodies", async () => {
  const { Readable, Writable } = await import("node:stream");
  const { createGatewayHandler } = await import("../../packages/model-gateway/src/server.js");
  for (const [method, url, status, text] of [["GET", "/healthz", 200, '{"ok":true}'], ["GET", "/missing", 404, '{"error":{"type":"not_found","message":"not found"}}']] as const) {
    const request = Object.assign(Readable.from([]), { method, url, headers: {} });
    const output: Buffer[] = []; let actual = 0;
    const response = Object.assign(new Writable({ write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }), { writeHead(code: number) { actual = code; } });
    await createGatewayHandler(setup().deps)(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(actual).toBe(status); expect(Buffer.concat(output).toString()).toBe(text);
  }
});
it("invokes the meter settle port exactly once, including an exception after the response head", async () => {
  const f = setup(); let settlements = 0;
  f.deps.meter = { pendingExpired: (now, n, c) => f.meter.pendingExpired(now, n, c), expire: (c) => f.meter.expire(c), pendingKeys: (n) => f.meter.pendingKeys(n), pendingFor: (k, n) => f.meter.pendingFor(k, n), correct: (c) => f.meter.correct(c), reserve: (r) => f.meter.reserve(r), read: (s) => f.meter.read(s), settle: async (r, c) => { settlements++; await f.meter.settle(r, c); } };
  const sink = new MemorySink(); sink.write = async () => { throw new Error("private cause"); };
  await call(f.deps, requestBody, mint(), sink); expect(settlements).toBe(1);
});

it("rejects response byte overflow in otherwise valid buffered JSON", async () => {
  const f = setup({ transport: async () => ({ status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ content: "x".repeat(10 * 1024 * 1024), usage: { input_tokens: 2, output_tokens: 5 } })); })() }) });
  const r = await call(f.deps, { ...requestBody, stream: false }); expect(r.status).toBe(502); expect(r.text()).toBe('{"error":{"type":"provider_error","message":"provider unavailable"}}');
});
it("ADDENDUM-2 src is reporting-only: present and absent reserve and settle identically and caps cannot read it", async () => {
  const spends: number[] = [];
  for (const src of ["app", undefined]) {
    let capInput: unknown;
    const f = setup({ caps: { capsFor: async (input) => { capInput = input; return caps; } } });
    expect((await call(f.deps, requestBody, mint({ src }))).status).toBe(200);
    expect(capInput).not.toHaveProperty("src"); spends.push((await f.meter.read(scope))[0]!.spentMicros);
  }
  expect(spends).toEqual([23, 23]);
});


it.each(["memory", "dynamo"])("charges only a signed member payer with %s: two project requesters with zero personal caps both succeed", async adapter => {
  const f = setup({ caps: new FixedCapsSource({ ...caps, personMonth: 0 }) });
  const tables = { meter: "meter", ledger: "ledger", markers: "markers" };
  const wire = new WireDynamo(Object.values(tables));
  const meter = adapter === "memory" ? f.meter : new DynamoMeter({ tables, now: () => now, db: new Dynamo({ region: "us-east-1", credentials: async () => ({ accessKeyId: "test", secretAccessKey: "test" }), transport: wire.transport }) });
  f.deps.meter = meter;
  for (const per of ["a".repeat(64), "b".repeat(64)]) {
    for (const pay of [{ kind: "project", project: scope.pid }, { kind: "agent", agentId: "rovara-code" }, { kind: "chain", chainId: `chn_${"a".repeat(20)}` }]) {
      expect((await call(f.deps, requestBody, mint({ per, pay }))).status).toBe(200);
      expect((await meter.read({ ...scope, per })).find(row => row.item === "person")?.spentMicros).toBe(0);
    }
  }
  expect((await meter.read(scope)).find(row => row.item === "project")?.spentMicros).toBeGreaterThan(0);
  expect((await call(f.deps)).status).toBe(422);
});

it("routes the agent call on the bare path and on exactly ?beta=true (the Anthropic SDK beta client); any other query is not_found before auth", async () => {
  const { handleGateway } = await import("../../packages/model-gateway/src/server.js");
  const post = async (deps: Parameters<typeof handleGateway>[0], url: string, token = mint()) => {
    const sink = new MemorySink(); const bytes = Buffer.from(JSON.stringify(requestBody));
    await handleGateway(deps, { method: "POST", url, headers: { "content-type": "application/json", "x-api-key": token }, body: (async function* () { yield bytes; })() }, sink);
    return sink;
  };
  for (const url of ["/v1/messages", "/v1/messages?beta=true"]) {
    const f = setup(); const ok = await post(f.deps, url);
    expect(ok.status, url).toBe(200); expect(f.calls, url).toHaveLength(1);
    expect((await post(setup().deps, url, "secret")).status, `${url} bad token`).toBe(401);
  }
  for (const url of ["/v1/messages?beta=false", "/v1/messages?beta=true&x=1", "/v1/messages?x=1", "/v1/messages?", "/v1/messages/", "/v1/messages?BETA=TRUE", "/v1/messages#beta=true"]) {
    const f = setup(); const refused = await post(f.deps, url);
    expect(refused.status, url).toBe(404); expect(refused.text(), url).toBe('{"error":{"type":"not_found","message":"not found"}}'); expect(f.calls, url).toHaveLength(0);
    // Refused before auth: a bad token on an unknown path is still not_found, never 401.
    expect((await post(setup().deps, url, "secret")).status, `${url} bad token`).toBe(404);
  }
});

it("logs a not_found refusal's method and bounded pathname, and only whether a query was present", async () => {
  const { handleGateway } = await import("../../packages/model-gateway/src/server.js");
  const f = setup();
  const sink = new MemorySink();
  const long = `/v1/messages/count_tokens/${"x".repeat(300)}`;
  await handleGateway(f.deps, { method: "POST", url: `${long}?beta=true&secret=abc123`, headers: { "x-api-key": "secret-token-value" }, body: (async function* () { yield Buffer.from("{}"); })() }, sink);
  expect(sink.status).toBe(404);
  const line = f.logs.find((entry) => (entry as { event: string }).event === "refused") as Record<string, unknown>;
  expect(line).toMatchObject({ code: "not_found", status: 404, method: "POST", query: true });
  expect(typeof line.path).toBe("string"); expect((line.path as string).length).toBeLessThanOrEqual(120);
  expect((line.path as string).startsWith("/v1/messages/count_tokens/")).toBe(true);
  expect(JSON.stringify(f.logs)).not.toContain("abc123"); expect(JSON.stringify(f.logs)).not.toContain("secret-token-value");
  // An ordinary refusal on a known route carries no path fields.
  const g = setup(); await handleGateway(g.deps, { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": "bad" }, body: (async function* () { yield Buffer.from("{}"); })() }, new MemorySink());
  expect(g.logs.find((entry) => (entry as { event: string }).event === "refused")).not.toHaveProperty("path");
});
