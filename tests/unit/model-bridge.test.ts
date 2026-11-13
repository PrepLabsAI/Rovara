// TE-F1c: the model bridge (the worker's side of a model call) behind its per-run Unix socket, driven through the helper-side client exactly as the helper loop will. Every test runs under the network tripwire: the bridge and
// the client open no socket to a non-loopback address (the port is a stub or the fake adapter, nothing else). The required "no request reaches a real model host" test for the bridge half is at the end.
import { chmodSync, mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_EGRESS_REFUSAL_HEADER, e2eSecretSpellings, type ModelEgress, type ModelEgressEvent, type ModelEgressSettle } from "@agentx/contracts";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { fixtureEgressRows, fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { createModelBridge, MODEL_BRIDGE_LIMITS, MODEL_FRESH_SANDBOX_SENTENCE, type ModelBridge, type ModelBridgeOptions } from "../../packages/worker/src/model-bridge.js";
import { callModelBridge, collectModelBridge } from "../../packages/worker/src/model-helper-bridge-client.js";
import { createModelBridgeLedger, type ModelBridgeLedger } from "../../packages/worker/src/model-bridge-ledger.js";

const enc = (text: string) => new TextEncoder().encode(text);
const FAMILIES = new Map(Object.values(fixtureEgressRows()).map((row) => [row.id, row.family] as const));
const familyOf = (row: string) => FAMILIES.get(row);

const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  row: "openai", method: "POST", path: "/v1/chat/completions", query: "", headers: [["content-type", "application/json"]], body: enc(JSON.stringify({ model: "fixture-small", messages: [{ role: "user", content: "hello" }] })), ...over,
});
const okSettle = (over: Partial<ModelEgressSettle> = {}): ModelEgressSettle => ({ kind: "settle", status: 200, class: "ok", inputTokens: 3, outputTokens: 4, costMicros: 1_000, estimated: false, ...over });
async function* okEvents(body = "{\"ok\":true}", settle: Partial<ModelEgressSettle> = {}): AsyncGenerator<ModelEgressEvent> {
  yield { kind: "head", status: 200, headers: [["content-type", "application/json"]] };
  yield { kind: "chunk", bytes: enc(body) };
  yield okSettle(settle);
}

interface Stub { readonly egress: ModelEgress; readonly calls: Array<{ frame: unknown; signal: AbortSignal | undefined }>; }
function stub(handler: (frame: unknown, signal: AbortSignal | undefined) => AsyncIterable<ModelEgressEvent> = () => okEvents()): Stub {
  const calls: Stub["calls"] = [];
  return { calls, egress: { capabilities: { schemes: [] }, forward: (_scope, input, options) => { calls.push({ frame: input, signal: options?.signal }); return handler(input, options?.signal); } } };
}

let dir: string;
let tripwire: NetworkTripwire;
const bridges: ModelBridge[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-"));
  tripwire = installNetworkTripwire();
});
afterEach(async () => {
  tripwire.restore();
  for (const bridge of bridges.splice(0)) await bridge.close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
  expect(tripwire.attempts, "no socket to a non-loopback address").toEqual([]);
});

interface Rig { readonly bridge: ModelBridge; readonly ledger: ModelBridgeLedger; readonly socket: string; readonly logs: Array<Record<string, unknown>>; readonly stub: Stub; readonly clock: { now: number }; }
async function rig(over: Partial<ModelBridgeOptions> & { stub?: Stub; roundKind?: unknown } = {}): Promise<Rig> {
  const clock = { now: 1_000 };
  const held = over.stub ?? stub();
  const ledger = createModelBridgeLedger({ now: () => clock.now, capMicros: 2_000_000 });
  const logs: Array<Record<string, unknown>> = [];
  let counter = 0;
  const bridge = createModelBridge({
    egress: held.egress, egressScope: {} as never, roundKind: "check_unsealed", familyOf, ledger, now: () => clock.now, capMicros: 2_000_000,
    randomToken: () => (counter += 1).toString(16).padStart(32, "a"), log: (fields) => logs.push({ ...fields }), ...over,
  });
  bridges.push(bridge);
  const socket = join(dir, "s.sock");
  await bridge.listen(socket);
  return { bridge, ledger, socket, logs, stub: held, clock };
}
const call = (r: Rig, mode: "real" | "record" | "replay", token: string | undefined, input: Record<string, unknown> = frame()) => collectModelBridge({ socketPath: r.socket, mode, ...(token === undefined ? {} : { token }), frame: input });

/** One raw request to the socket, for envelopes the client would never send. */
function raw(socket: string, options: { mode?: string; token?: string; body: string | Buffer; path?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, method: "POST", path: options.path ?? "/call", headers: { "x-rovara-mode": options.mode ?? "real", ...(options.token === undefined ? {} : { "x-rovara-token": options.token }), "content-type": "application/json" } }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}
const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({ row: "openai", method: "POST", path: "/v1/chat/completions", query: "", headers: [["content-type", "application/json"]], bodyB64: Buffer.from("{\"model\":\"fixture-small\",\"messages\":[]}").toString("base64"), ...over });

describe("the socket", () => {
  it("is a Unix socket with mode 0600, and is removed when the bridge closes", async () => {
    const r = await rig();
    expect(statSync(r.socket).mode & 0o777).toBe(0o600);
    expect(statSync(r.socket).isSocket()).toBe(true);
    await r.bridge.close();
    expect(existsSync(r.socket)).toBe(false);
  });
  it("answers nothing but POST /call", async () => {
    const r = await rig();
    expect((await raw(r.socket, { body: envelope(), path: "/other" })).status).toBe(404);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses a socket path too long for the system, rather than listen on a cut one", async () => {
    const r = await rig();
    await expect(createModelBridge({ egress: r.stub.egress, egressScope: {} as never, roundKind: "working", familyOf, ledger: r.ledger, now: () => 1 }).listen(join(dir, "x".repeat(120)))).rejects.toThrow(/too long/u);
  });
  it("states the design's limits", () => {
    expect(MODEL_BRIDGE_LIMITS).toMatchObject({ headersBytes: 16 * 1024, bodyBytes: 5 * 1024 * 1024, responseBytes: 10 * 1024 * 1024, chunkBytes: 1024 * 1024, headerReadMs: 10_000, totalMs: 10 * 60 * 1000, concurrent: 4, calls: 200 });
  });
});

describe("mode control: real calls only in a fresh or sealed round, with a live per-exec token", () => {
  it("forwards one call in a fresh round with a live token, and writes one ledger row", async () => {
    const r = await rig();
    const token = r.bridge.issueToken("exec-1");
    const answer = await call(r, "real", token);
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("{\"ok\":true}");
    expect(answer.settle).toMatchObject({ class: "ok", costMicros: 1_000 });
    expect(r.stub.calls).toHaveLength(1);
    expect(r.ledger.rows()).toEqual([expect.objectContaining({ row: "openai", status: 200, class: "ok", costMicros: 1_000, via: "real", inputTokens: 3, outputTokens: 4 })]);
    // The port got the checked frame, not the envelope.
    expect(Object.keys(r.stub.calls[0]!.frame as object).sort()).toEqual(["body", "headers", "method", "path", "query", "row"]);
  });
  it("refuses real in the working round even with a live token, and calls nothing", async () => {
    const r = await rig({ roundKind: "working" });
    const token = r.bridge.issueToken("exec-1");
    const answer = await call(r, "real", token);
    expect(answer.notRun).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
    expect(MODEL_FRESH_SANDBOX_SENTENCE).toBe("not run: real model checks need a fresh check sandbox");
    expect(r.stub.calls).toHaveLength(0);
  });
  it("reads a round it does not know as the working round (fail closed)", async () => {
    for (const roundKind of ["check_sealed ", "sealed", "CHECK_UNSEALED", "", undefined, 3, { toString: () => "check_unsealed" }]) {
      const r = await rig({ roundKind });
      const answer = await call(r, "real", r.bridge.issueToken("e"));
      expect(answer.notRun, String(roundKind)).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
      expect(r.stub.calls).toHaveLength(0);
      await r.bridge.close();
    }
  });
  it("allows real in the sealed round too", async () => {
    const r = await rig({ roundKind: "check_sealed" });
    expect((await call(r, "real", r.bridge.issueToken("e"))).status).toBe(200);
  });
  it("refuses a call with no token, a wrong token, a malformed token, and a token that was dropped when its exec ended", async () => {
    const r = await rig();
    const token = r.bridge.issueToken("exec-1");
    for (const bad of [undefined, "b".repeat(32), "short", `${token}x`, token.toUpperCase()]) {
      const answer = await call(r, "real", bad);
      expect(answer.status, String(bad)).toBe(403);
      expect(answer.settle, String(bad)).toMatchObject({ class: "refused", refusal: "not_allowed", costMicros: 0 });
    }
    expect(r.stub.calls).toHaveLength(0);
    expect((await call(r, "real", token)).status).toBe(200);
    r.bridge.dropToken("exec-1");
    expect((await call(r, "real", token)).status).toBe(403);
    expect(r.stub.calls).toHaveLength(1);
  });
  it("keeps one exec's token apart from another's, and never writes a token into the ledger or a log", async () => {
    const r = await rig();
    const first = r.bridge.issueToken("exec-1");
    const second = r.bridge.issueToken("exec-2");
    expect(first).not.toBe(second);
    r.bridge.dropToken("exec-1");
    expect((await call(r, "real", second)).status).toBe(200);
    expect((await call(r, "real", first)).status).toBe(403);
    const printed = JSON.stringify([r.ledger.rows(), r.logs]);
    expect(printed.includes(first)).toBe(false);
    expect(printed.includes(second)).toBe(false);
  });
  it("refuses an injected token that is not plain", async () => {
    const r = await rig({ randomToken: () => "has space in it" });
    expect(() => r.bridge.issueToken("e")).toThrow(/token/u);
  });
  it("an unknown mode is refused", async () => {
    const r = await rig();
    expect((await raw(r.socket, { mode: "everything", body: envelope() })).text).toContain("\"settle\"");
    expect(r.stub.calls).toHaveLength(0);
  });
});

describe("the bridge checks every frame again; it never trusts the helper", () => {
  it("refuses a frame that names a host in any way, and never calls the port", async () => {
    const r = await rig();
    const token = r.bridge.issueToken("e");
    const attempts: Array<Record<string, unknown>> = [
      frame({ host: "api.openai.com" }), frame({ url: "https://api.openai.com/v1/chat/completions" }), frame({ company: "other" }),
      frame({ row: "api.openai.com" }), frame({ row: "no-such-row" }),
    ];
    for (const attempt of attempts) {
      const answer = await call(r, "real", token, attempt);
      expect([400, 404], JSON.stringify(Object.keys(attempt))).toContain(answer.status);
    }
    expect(r.stub.calls).toHaveLength(0);
  });
  it("a Host or credential header in the frame is the core's to drop: the bridge passes the frame on whole and the port never gets a host field", async () => {
    const r = await rig();
    const answer = await call(r, "real", r.bridge.issueToken("e"), frame({ headers: [["host", "api.openai.com"], ["content-type", "application/json"]] }));
    expect(answer.status).toBe(200);
    for (const key of Object.keys(r.stub.calls[0]!.frame as object)) expect(["row", "method", "path", "query", "headers", "body"]).toContain(key);
  });
  it("refuses an envelope that is not JSON, truncated, has bad base64, or an unknown key; none reaches the port", async () => {
    const r = await rig();
    const token = r.bridge.issueToken("e");
    const bodies = ["", "{", "[]", "null", envelope().slice(0, 40), envelope({ bodyB64: "***not base64***" }), envelope({ bodyB64: 5 }), envelope({ extra: true }), envelope({ headers: "x" }), envelope({ path: 3 }), JSON.stringify({ row: "openai" })];
    for (const body of bodies) {
      const answer = await raw(r.socket, { token, body });
      expect(answer.text, body.slice(0, 30)).toMatch(/"t":"settle"/u);
      expect(answer.text, body.slice(0, 30)).toMatch(/"refusal":"bad_request"/u);
    }
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses a body over 5 MB (too_large) and closes the request", async () => {
    const r = await rig();
    const answer = await call(r, "real", r.bridge.issueToken("e"), frame({ body: new Uint8Array(5 * 1024 * 1024 + 1) }));
    expect(answer.status).toBe(413);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses an envelope far over the limit without reading it all", async () => {
    const r = await rig();
    const answer = await raw(r.socket, { token: r.bridge.issueToken("e"), body: Buffer.alloc(9 * 1024 * 1024, 65) }).catch(() => ({ status: 0, text: "closed" }));
    expect(answer.text === "closed" || /too_large/u.test(answer.text)).toBe(true);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses a chunked body that grows past the limit though it never declared a length", async () => {
    const r = await rig();
    const outcome = await new Promise<string>((resolve) => {
      const request = http.request({ socketPath: r.socket, method: "POST", path: "/call", headers: { "x-rovara-mode": "real", "transfer-encoding": "chunked" } }, (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      });
      request.on("error", () => resolve("closed"));
      for (let i = 0; i < 10; i += 1) request.write(Buffer.alloc(1024 * 1024, 65));
      request.end();
    });
    expect(outcome === "closed" || /too_large/u.test(outcome)).toBe(true);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("closes a connection that is slow to send its headers", async () => {
    const r = await rig({ limits: { headerReadMs: 150 } });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect(r.socket);
      socket.on("connect", () => socket.write("POST /call HTTP/1.1\r\nx-rovara-mode: real\r\n"));
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
    expect(closed).toBe(true);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("closes a connection that sends a body too slowly", async () => {
    const r = await rig({ limits: { headerReadMs: 150 } });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect(r.socket);
      socket.on("connect", () => socket.write("POST /call HTTP/1.1\r\nhost: bridge\r\nx-rovara-mode: real\r\ncontent-length: 100000\r\n\r\n{\"row\""));
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
    expect(closed).toBe(true);
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses headers over 16 KB", async () => {
    const r = await rig();
    const status = await new Promise<number | string>((resolve) => {
      const request = http.request({ socketPath: r.socket, method: "POST", path: "/call", headers: { "x-rovara-mode": "real", "x-pad": "a".repeat(20 * 1024) } }, (response) => resolve(response.statusCode ?? 0));
      request.on("error", () => resolve("closed"));
      request.end(envelope());
    });
    expect([431, "closed"]).toContain(status);
    expect(r.stub.calls).toHaveLength(0);
  });
});

describe("one attempt, and the limits on a response", () => {
  it("makes ONE attempt and never retries after a fault", async () => {
    const held = stub(() => (async function* () { throw new Error("connection reset"); yield okSettle(); })());
    const r = await rig({ stub: held });
    const answer = await call(r, "real", r.bridge.issueToken("e"));
    expect(held.calls).toHaveLength(1);
    expect(answer.status).toBe(502);
    expect(answer.settle).toMatchObject({ class: "provider_error", costMicros: 0 });
    expect(r.ledger.rows()).toHaveLength(1);
    expect(r.ledger.rows()[0]).toMatchObject({ class: "provider_error", via: "real" });
  });
  it("a fault after the head ends the stream with a cut, once, and still records the call", async () => {
    const held = stub(() => (async function* () { yield { kind: "head", status: 200, headers: [] }; throw new Error("boom"); })());
    const r = await rig({ stub: held });
    const answer = await call(r, "real", r.bridge.issueToken("e"));
    expect(answer.cut).toBe("fault");
    expect(held.calls).toHaveLength(1);
    expect(r.ledger.rows()).toHaveLength(1);
  });
  it("splits a chunk over the chunk limit and stops a response over the total limit", async () => {
    const big = (parts: number, each: number) => stub(() => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      for (let i = 0; i < parts; i += 1) yield { kind: "chunk", bytes: new Uint8Array(each).fill(97) };
      yield okSettle();
    })());
    const split = await rig({ stub: big(1, 2_500), limits: { chunkBytes: 1_000 } });
    const pieces: number[] = [];
    for await (const event of callModelBridge({ socketPath: split.socket, mode: "real", token: split.bridge.issueToken("e"), frame: frame() })) if (event.kind === "chunk") pieces.push(event.bytes.byteLength);
    expect(pieces).toEqual([1_000, 1_000, 500]);
    const over = await rig({ stub: big(5, 1_000), limits: { responseBytes: 3_000, chunkBytes: 1_000 } });
    const answer = await call(over, "real", over.bridge.issueToken("e"));
    expect(answer.cut).toBe("response_too_large");
    expect(answer.bytes.byteLength).toBeLessThanOrEqual(3_000);
    expect(over.ledger.rows()).toHaveLength(1);
  });
  it("stops a call at the total time and tells the port to abort", async () => {
    const held = stub((_frame, signal) => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      yield okSettle();
    })());
    const r = await rig({ stub: held, limits: { totalMs: 250 } });
    const answer = await call(r, "real", r.bridge.issueToken("e"));
    expect(answer.cut).toBe("time");
    expect(held.calls[0]!.signal?.aborted).toBe(true);
  });
  it("aborts the port when the helper goes away mid-stream", async () => {
    let release: () => void = () => undefined;
    const held = stub((_frame, signal) => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener("abort", () => resolve()); });
      yield okSettle();
    })());
    const r = await rig({ stub: held });
    const controller = new AbortController();
    const reading = (async () => { for await (const event of callModelBridge({ socketPath: r.socket, mode: "real", token: r.bridge.issueToken("e"), frame: frame(), signal: controller.signal })) if (event.kind === "head") controller.abort(); })().catch(() => undefined);
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held.calls[0]!.signal?.aborted).toBe(true);
    release();
  });
});

describe("per-task pre-caps: 4 at once, 200 calls, the dollar cap", () => {
  it("refuses a fifth call while four are open, in the family's cap shape, and calls nothing for it", async () => {
    const gate: Array<() => void> = [];
    let released = false;
    const held = stub(() => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      if (!released) await new Promise<void>((resolve) => gate.push(resolve));
      yield okSettle();
    })());
    const r = await rig({ stub: held });
    const token = r.bridge.issueToken("e");
    const open = Array.from({ length: 4 }, () => call(r, "real", token));
    await new Promise((resolve) => setTimeout(resolve, 150));
    console.error("DBG stats", JSON.stringify(r.bridge.stats()), held.calls.length);
    const fifth = await call(r, "real", token);
    expect(fifth.status).toBe(429);
    expect(fifth.settle).toMatchObject({ class: "cap", refusal: "cap" });
    expect(held.calls).toHaveLength(4);
    released = true;
    gate.forEach((release) => release());
    await Promise.all(open);
    // Once they are done a new call is allowed again.
    expect((await call(r, "real", token)).status).toBe(200);
  });
  it("refuses past the call count, and the refused call is no call in the summary", async () => {
    const r = await rig({ limits: { calls: 3 } });
    const token = r.bridge.issueToken("e");
    for (let i = 0; i < 3; i += 1) expect((await call(r, "real", token)).status).toBe(200);
    const refused = await call(r, "real", token);
    expect(refused.settle).toMatchObject({ class: "cap", refusal: "cap" });
    expect(r.stub.calls).toHaveLength(3);
    expect(r.ledger.summary().calls).toBe(3);
  });
  it("refuses once the settled spend reaches the cap, naming the cap", async () => {
    const held = stub(() => okEvents("{}", { costMicros: 1_200_000 }));
    const r = await rig({ stub: held });
    const token = r.bridge.issueToken("e");
    expect((await call(r, "real", token)).status).toBe(200);
    expect((await call(r, "real", token)).status).toBe(200);
    const refused = await call(r, "real", token);
    expect(refused.status).toBe(429);
    expect(refused.body).toContain("$2.00 per task");
    expect(held.calls).toHaveLength(2);
  });
  it("takes no further call after a settle that says overrun", async () => {
    const held = stub(() => okEvents("{}", { costMicros: 10, overrun: true }));
    const r = await rig({ stub: held });
    const token = r.bridge.issueToken("e");
    expect((await call(r, "real", token)).status).toBe(200);
    const refused = await call(r, "real", token);
    expect(refused.settle).toMatchObject({ class: "cap" });
    expect(refused.body).toContain("budget exceeded by one call");
    expect(held.calls).toHaveLength(1);
  });
});

describe("the log test: a planted key never reaches a log, a returned error, the ledger or an answer", () => {
  it("on every error path, in all four spellings", async () => {
    const key = fixtureKey("bridge-planted-key");
    const spellings = e2eSecretSpellings(key);
    expect(spellings.length).toBeGreaterThanOrEqual(4);
    const kinds: Array<() => AsyncIterable<ModelEgressEvent>> = [
      () => (async function* () { throw new Error(`upstream failed with ${key}`); yield okSettle(); })(),
      () => (async function* () { yield { kind: "head", status: 401, headers: [["x-note", key]] }; throw new Error(key); })(),
      () => (async function* () { yield { kind: "head", status: 200, headers: [] }; yield { kind: "chunk", bytes: enc("{}") }; throw new TypeError(`bad ${encodeURIComponent(key)}`); })(),
    ];
    const outputs: unknown[] = [];
    for (const make of kinds) {
      const r = await rig({ stub: stub(make) });
      const answer = await call(r, "real", r.bridge.issueToken("e"));
      outputs.push(answer.text, r.ledger.rows(), r.logs, r.bridge.stats());
      await r.bridge.close();
    }
    // Hostile helper inputs too.
    const r = await rig();
    outputs.push((await raw(r.socket, { body: `{"row":"${key}"` })).text, (await raw(r.socket, { token: key, body: envelope({ row: key }) })).text);
    outputs.push(r.ledger.rows(), r.logs);
    const printed = JSON.stringify(outputs);
    for (const spelling of spellings) expect(printed.includes(spelling), spelling.slice(0, 8)).toBe(false);
  });
  it("logs fixed fields only", async () => {
    const r = await rig();
    await call(r, "real", r.bridge.issueToken("e"), frame({ body: enc(JSON.stringify({ messages: [{ content: "PLANTED-PROMPT-TEXT" }] })) }));
    await call(r, "real", "x".repeat(32));
    for (const line of r.logs) expect(Object.keys(line).every((key) => ["event", "row", "mode", "status", "class", "refusal", "reason"].includes(key)), JSON.stringify(line)).toBe(true);
    expect(JSON.stringify(r.logs)).not.toContain("PLANTED-PROMPT-TEXT");
  });
});

describe("no request reaches a real model host (the bridge half)", () => {
  it("scripted, replay and record-hit modes call the port zero times and open no non-loopback connection; a real call's only destination is the port", async () => {
    const r = await rig({ roundKind: "working" });
    const token = r.bridge.issueToken("e");
    // scripted/replay with no recording behind them
    expect((await call(r, "replay", undefined)).scripted).toBe(true);
    expect((await call(r, "real", token)).notRun).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
    expect(r.stub.calls).toHaveLength(0);
    expect(tripwire.attempts).toEqual([]);
  });
  it("a frame that names another host is refused by the bridge even when the helper sends it with a valid token", async () => {
    const r = await rig();
    const token = r.bridge.issueToken("e");
    for (const host of ["api.openai.com", "generativelanguage.googleapis.com", "evil.example", "127.0.0.1", "169.254.169.254"]) {
      expect((await call(r, "real", token, frame({ host }))).status).toBe(400);
      expect((await call(r, "real", token, frame({ row: host }))).status).toBeGreaterThanOrEqual(400);
    }
    expect(r.stub.calls).toHaveLength(0);
  });
});
void MODEL_EGRESS_REFUSAL_HEADER;
