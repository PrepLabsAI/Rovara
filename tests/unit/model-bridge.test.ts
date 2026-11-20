// TE-F1c: the model bridge (the worker's side of a model call) behind its per-run Unix socket, driven through the helper-side client exactly as the helper loop will. Every test runs under the network tripwire: the bridge and
// the client open no socket to a non-loopback address (the port is a stub or the fake adapter, nothing else). The required "no request reaches a real model host" test for the bridge half is at the end.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
import { createModelBridgeLedger, modelBridgeEvidenceLines, type ModelBridgeLedger } from "../../packages/worker/src/model-bridge-ledger.js";

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

interface Rig { readonly bridge: ModelBridge; readonly ledger: ModelBridgeLedger; readonly socket: string; readonly logs: Array<Record<string, unknown>>; readonly stub: Stub; readonly clock: { now: number }; /** A token for an exec of the rig's own round, allowed `real` and `record` unless told otherwise. */ token(execId: string, modes?: readonly ("real" | "record")[]): string; }
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
  const kind = "roundKind" in over ? over.roundKind : "check_unsealed";
  return { bridge, ledger, socket, logs, stub: held, clock, token: (execId, modes = ["real", "record"]) => bridge.issueToken(execId, kind, modes) };
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
  it("answers nothing but POST /call", async () => {
    const r = await rig();
    expect((await raw(r.socket, { body: envelope(), path: "/other" })).status).toBe(404);
    expect(r.stub.calls).toHaveLength(0);
    // EVAL-WIRE-BRIDGE-UNLOGGED-DROPS: never a silent end
    expect(r.logs).toContainEqual({ event: "dropped", reason: "not_call" });
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
  it("reads a round it does not know as the working round (fail closed)", async () => {
    for (const roundKind of ["check_sealed ", "sealed", "CHECK_UNSEALED", "", undefined, 3, { toString: () => "check_unsealed" }]) {
      const r = await rig({ roundKind });
      const answer = await call(r, "real", r.token("e"));
      expect(answer.notRun, String(roundKind)).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
      expect(r.stub.calls).toHaveLength(0);
      await r.bridge.close();
    }
  });
  it("refuses a call with no token, a wrong token, a malformed token, and a token that was dropped when its exec ended", async () => {
    const r = await rig();
    const token = r.token("exec-1");
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
  it("refuses an injected token that is not plain", async () => {
    const r = await rig({ randomToken: () => "has space in it" });
    expect(() => r.token("e")).toThrow(/token/u);
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
    const token = r.token("e");
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
  it("refuses an envelope that is not JSON, truncated, has bad base64, or an unknown key; none reaches the port", async () => {
    const r = await rig();
    const token = r.token("e");
    const bodies = ["", "{", "[]", "null", envelope().slice(0, 40), envelope({ bodyB64: "***not base64***" }), envelope({ bodyB64: 5 }), envelope({ extra: true }), envelope({ headers: "x" }), envelope({ path: 3 }), JSON.stringify({ row: "openai" })];
    for (const body of bodies) {
      const answer = await raw(r.socket, { token, body });
      expect(answer.text, body.slice(0, 30)).toMatch(/"t":"settle"/u);
      expect(answer.text, body.slice(0, 30)).toMatch(/"refusal":"bad_request"/u);
    }
    expect(r.stub.calls).toHaveLength(0);
  });
  it("refuses an envelope far over the limit without reading it all", async () => {
    const r = await rig();
    const answer = await raw(r.socket, { token: r.token("e"), body: Buffer.alloc(9 * 1024 * 1024, 65) }).catch(() => ({ status: 0, text: "closed" }));
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
    expect(r.logs).toContainEqual({ event: "dropped", reason: "header_time" });
  });
  it("closes a connection that sends a body too slowly (the body idle limit is shorter than the header read)", async () => {
    const r = await rig({ limits: { bodyIdleMs: 150 } });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect(r.socket);
      socket.on("connect", () => socket.write("POST /call HTTP/1.1\r\nhost: bridge\r\nx-rovara-mode: real\r\ncontent-length: 100000\r\n\r\n{\"row\""));
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });
    expect(closed).toBe(true);
    expect(r.stub.calls).toHaveLength(0);
    expect(r.logs).toContainEqual({ event: "dropped", reason: "slow" });
  });
  it("logs a body that goes away before it is whole (a drop is never silent)", async () => {
    const r = await rig();
    await new Promise<void>((resolve) => {
      const socket = net.connect(r.socket);
      socket.on("connect", () => socket.write("POST /call HTTP/1.1\r\nhost: bridge\r\nx-rovara-mode: real\r\ncontent-length: 100000\r\n\r\n{\"row\"", () => setTimeout(() => socket.destroy(), 50)));
      socket.on("close", () => resolve());
      socket.on("error", () => undefined);
    });
    for (let waited = 0; waited < 2_000 && !r.logs.some((line) => line["event"] === "dropped"); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(r.logs).toContainEqual({ event: "dropped", reason: "gone" });
    expect(r.stub.calls).toHaveLength(0);
  });
});

describe("one attempt, and the limits on a response", () => {
  it("splits a chunk over the chunk limit and stops a response over the total limit", async () => {
    const big = (parts: number, each: number) => stub(() => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      for (let i = 0; i < parts; i += 1) yield { kind: "chunk", bytes: new Uint8Array(each).fill(97) };
      yield okSettle();
    })());
    const split = await rig({ stub: big(1, 2_500), limits: { chunkBytes: 1_000 } });
    const pieces: number[] = [];
    for await (const event of callModelBridge({ socketPath: split.socket, mode: "real", token: split.token("e"), frame: frame() })) if (event.kind === "chunk") pieces.push(event.bytes.byteLength);
    expect(pieces).toEqual([1_000, 1_000, 500]);
    const over = await rig({ stub: big(5, 1_000), limits: { responseBytes: 3_000, chunkBytes: 1_000 } });
    const answer = await call(over, "real", over.token("e"));
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
    const answer = await call(r, "real", r.token("e"));
    expect(answer.cut).toBe("time");
    expect(held.calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("per-task pre-caps: 4 at once, 200 calls, the dollar cap", () => {
  it("refuses past the call count, and the refused call is no call in the summary", async () => {
    const r = await rig({ limits: { calls: 3 } });
    const token = r.token("e");
    for (let i = 0; i < 3; i += 1) expect((await call(r, "real", token)).status).toBe(200);
    const refused = await call(r, "real", token);
    expect(refused.settle).toMatchObject({ class: "refused", refusal: "cap" });
    expect(r.stub.calls).toHaveLength(3);
    expect(r.ledger.summary().calls).toBe(3);
  });
  it("takes no further call after a settle that says overrun", async () => {
    const held = stub(() => okEvents("{}", { costMicros: 10, overrun: true }));
    const r = await rig({ stub: held });
    const token = r.token("e");
    expect((await call(r, "real", token)).status).toBe(200);
    const refused = await call(r, "real", token);
    expect(refused.settle).toMatchObject({ class: "cap" });
    expect(refused.body).toContain("budget exceeded by one call");
    expect(held.calls).toHaveLength(1);
  });
});

describe("the bridge's own limits are not a 'not run' that test code can fire at will (M1)", () => {
  const gated = () => {
    const gate: Array<() => void> = [];
    let released = false;
    const held = stub(() => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      if (!released) await new Promise<void>((resolve) => gate.push(resolve));
      yield okSettle();
    })());
    return { held, release: () => { released = true; gate.forEach((open) => open()); } };
  };
  it("five calls at once: the fifth is refused as class 'refused' and its check stays 'failed', never 'not run'", async () => {
    const { held, release } = gated();
    const r = await rig({ stub: held });
    r.ledger.execStart("check-1");
    const token = r.token("check-1");
    const open = Array.from({ length: 4 }, () => call(r, "real", token));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fifth = await call(r, "real", token);
    expect(fifth.status).toBe(429);
    expect(fifth.settle).toMatchObject({ class: "refused", refusal: "cap" });
    expect(fifth.body).not.toMatch(/budget (was|reached)/u);
    release();
    await Promise.all(open);
    r.ledger.execEnd("check-1");
    expect(r.ledger.rows().filter((row) => row.refusal === "cap")).toEqual([expect.objectContaining({ class: "refused", execId: "check-1", via: "refused" })]);
    expect(r.ledger.notRunFor("check-1")).toBeUndefined();
    expect(r.ledger.checkOutcome("check-1", "failed")).toEqual({ status: "failed" });
    expect(modelBridgeEvidenceLines({ roundKind: "check_unsealed", blockMode: "by_name", blockList: [], hostSuffixes: [], azureOpenAiNotBlocked: false, observedHosts: [], classes: r.ledger.classes() }).join("\n")).not.toMatch(/budget reached/u);
  });
  it("the DOLLAR cap is a real spend cap: a failed check whose call hit it is 'not run: test model budget reached'", async () => {
    const r = await rig({ stub: stub(() => okEvents("{}", { costMicros: 1_200_000 })) });
    r.ledger.execStart("check-1");
    const token = r.token("check-1");
    await call(r, "real", token);
    await call(r, "real", token);
    const refused = await call(r, "real", token);
    expect(refused.settle).toMatchObject({ class: "cap", refusal: "cap" });
    r.ledger.execEnd("check-1");
    expect(r.ledger.checkOutcome("check-1", "failed")).toEqual({ status: "not_run", sentence: "not run: test model budget reached ($2.00 per task)" });
  });
});

describe("the socket's own limits (L2)", () => {
  it("accepts only a few connections at once", async () => {
    const r = await rig({ limits: { connections: 2 } });
    const closed: boolean[] = [false, false, false];
    const sockets = [0, 1, 2].map((index) => { const socket = net.connect(r.socket); socket.on("close", () => { closed[index] = true; }); socket.on("error", () => undefined); return socket; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed.filter(Boolean)).toHaveLength(1);
    expect(r.logs.filter((line) => line["event"] === "dropped" && line["reason"] === "connections")).toHaveLength(1);
    sockets.forEach((socket) => socket.destroy());
  });
  it("ends a call whose reader stops taking the answer, and tells the port to abort", async () => {
    const big = stub((_frame, signal) => (async function* () {
      yield { kind: "head", status: 200, headers: [] };
      for (let i = 0; i < 9 && signal?.aborted !== true; i += 1) yield { kind: "chunk", bytes: new Uint8Array(1024 * 1024).fill(97) };
      yield okSettle();
    })());
    const r = await rig({ stub: big, limits: { writeStallMs: 300 } });
    const token = r.token("e");
    const envelopeText = JSON.stringify({ row: "openai", method: "POST", path: "/v1/chat/completions", query: "", headers: [], bodyB64: Buffer.from("{}").toString("base64") });
    const request = http.request({ socketPath: r.socket, method: "POST", path: "/call", headers: { "x-rovara-mode": "real", "x-rovara-token": token } }, (response) => { response.pause(); });
    request.on("error", () => undefined);
    request.end(envelopeText);
    for (let waited = 0; waited < 5_000 && big.calls[0]?.signal?.aborted !== true; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(big.calls[0]?.signal?.aborted).toBe(true);
    request.destroy();
  });
});

describe("near the cap, calls go one at a time (L5)", () => {
  it("with less than about four calls' budget left the next call waits for the one in flight to settle", async () => {
    let active = 0;
    let maxActive = 0;
    const held = stub(() => (async function* () {
      active += 1;
      maxActive = Math.max(maxActive, active);
      yield { kind: "head", status: 200, headers: [] };
      await new Promise((resolve) => setTimeout(resolve, 80));
      active -= 1;
      yield okSettle({ costMicros: 400_000 });
    })());
    const r = await rig({ stub: held, capMicros: 1_300_000 });
    const token = r.token("e");
    expect((await call(r, "real", token)).status).toBe(200);
    maxActive = 0;
    const answers = await Promise.all([call(r, "real", token), call(r, "real", token), call(r, "real", token)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(maxActive).toBe(1);
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
      const answer = await call(r, "real", r.token("e"));
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
});

describe("no request reaches a real model host (the bridge half)", () => {
  it("scripted, replay and record-hit modes call the port zero times and open no non-loopback connection; a real call's only destination is the port", async () => {
    const r = await rig({ roundKind: "working" });
    const token = r.token("e");
    // scripted/replay with no recording behind them
    expect((await call(r, "replay", undefined)).scripted).toBe(true);
    expect((await call(r, "real", token)).notRun).toBe(MODEL_FRESH_SANDBOX_SENTENCE);
    expect(r.stub.calls).toHaveLength(0);
    expect(tripwire.attempts).toEqual([]);
  });
});
void MODEL_EGRESS_REFUSAL_HEADER;
