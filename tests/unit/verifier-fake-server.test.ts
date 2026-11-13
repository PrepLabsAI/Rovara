// Test services TS23: the one fake server (FixtureSet v2 replay, record-only sinkhole), its request ledger and ledger reader, and the v1 / E2E entry points that now run on it.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer as createNetServer, connect, type Server as NetServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureSetSchema, fixtureEntry, fixtureSetDigest, ServiceMockFixtureSetSchema, serviceMockFixtureSetDigest, type E2EApiMockFixture, type FixtureEntry, type FixtureSet } from "@rovara-code/contracts";
import { startMockServer } from "../../packages/verifier/src/executor/mock-server.js";
import {
  FakeServerRefused, FixtureSetRefused, allowedResponseHeaders, assertRunAddress, parseFakeLedger, startFakeFromE2eFixture, startFakeServer, startServiceMock, withholdFakeLedgerCredentials,
  type FakeLedgerLine, type FakeReplayOptions, type RunningFakeServer,
} from "../../packages/verifier/src/service-mocks/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), "fake-server-")); roots.push(dir); return dir; };

const dependency = { id: "payments-api", family: "http:api.example-pay.com", protocol: "http_json", target: "api.example-pay.com" } as const;
const match = { ignorePaths: ["/requestedAt"], query: ["customer"] };
const json = "application/json";
const charge = (amount: number, extra: Record<string, unknown> = {}) => ({ method: "POST" as const, path: "/v1/charges", query: [{ name: "customer", value: "c1" }], contentType: json, body: JSON.stringify({ amount, requestedAt: "2026-11-02T00:00:00Z", ...extra }) });
const answer = (body: unknown, status = 200, headers: FixtureEntry["response"]["headers"] = []) => ({ status, headers, contentType: json, body: JSON.stringify(body), latencyMs: 0 });
function makeSet(over: Record<string, unknown> = {}): FixtureSet {
  const shell = { dependency, match };
  return FixtureSetSchema.parse({
    schemaVersion: 2, dependency, origin: "recorded", revision: 1, recordedAt: "2026-11-02T00:00:00.000Z", syntheticOnly: true, match,
    requestSchema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } }, responseSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    entries: [fixtureEntry(shell, charge(5), answer({ ok: true, id: "ch_1" }, 200, [{ name: "etag", value: "abc" }, { name: "x-request-id", value: "r-1" }])), fixtureEntry(shell, charge(7), answer({ error: "declined" }, 402))],
    faults: [{ name: "busy", kind: "throttle", status: 429, delayMs: 0 }, { name: "boom", kind: "http_5xx", status: 503, delayMs: 0 }, { name: "hang", kind: "timeout", delayMs: 5 }],
    ...over,
  });
}
async function replay(set: FixtureSet = makeSet(), extra: Partial<Omit<FakeReplayOptions, "mode">> = {}) {
  const fake = await startFakeServer({ mode: "replay", fixtureSet: set, expectedDigest: fixtureSetDigest(set), unmatched: "fail", bindAddress: "127.0.0.1", callers: "any", ledgerPath: null, ...extra });
  running.push(fake);
  return fake;
}
const post = (fake: RunningFakeServer, amount: number, init: RequestInit = {}, query = "customer=c1", extra: Record<string, unknown> = {}) =>
  fetch(`${fake.url}/v1/charges?${query}`, { method: "POST", headers: { "content-type": json }, body: JSON.stringify({ requestedAt: "2030-01-01T00:00:00Z", amount, ...extra }), ...init });
const control = (fake: RunningFakeServer, path: string, init: RequestInit = {}, token = fake.controlToken) => fetch(`${fake.url}/__rovara/${path}`, { ...init, headers: { "x-rovara-control": token, "content-type": json } });

/** Sends exactly these bytes and returns what comes back until the server closes the connection. */
function raw(port: number, bytes: string | Buffer, host = "127.0.0.1", holdMs = 800): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let received = "";
    socket.on("data", (chunk: Buffer) => { received += chunk.toString("latin1"); });
    socket.on("error", () => resolve(received));
    socket.once("connect", () => socket.write(bytes));
    socket.once("close", () => resolve(received));
    setTimeout(() => { socket.destroy(); resolve(received); }, holdMs).unref();
  });
}
const until = async (check: () => Promise<boolean> | boolean, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((done) => setTimeout(done, 25)); } return check(); };
const ledgerOf = async (path: string): Promise<FakeLedgerLine[]> => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLedgerLine);

describe("replay of a FixtureSet v2", () => {
  it("answers a recorded request with its recorded answer whatever the key order, the ignored members or the other query parameters", async () => {
    const fake = await replay();
    const first = await post(fake, 5);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe(json);
    expect(first.headers.get("etag")).toBe("abc");
    expect(first.headers.get("x-request-id")).toBe("r-1");
    expect(await first.json()).toEqual({ ok: true, id: "ch_1" });
    // A parameter the set does not match on does not change which request this is.
    expect((await post(fake, 5, {}, "customer=c1&trace=zzz")).status).toBe(200);
    const declined = await post(fake, 7);
    expect(declined.status).toBe(402);
    expect(fake.usage()).toMatchObject({ service: "payments-api", matched: 3, unmatchedFailed: 0, synthesized: 0, faultsInjected: [], additionsServed: 0, foreignCalls: 0 });
  });
  it("fails a request it has no recording for with the contract's 500 and words, and counts it; the method, path and identifying query all matter", async () => {
    const fake = await replay();
    const unknown = await post(fake, 99);
    expect(unknown.status).toBe(500);
    expect(await unknown.text()).toBe("mock had no recording");
    expect(unknown.headers.get("x-rovara-mock")).toBe("no-recording");
    expect((await post(fake, 5, {}, "customer=c2")).status).toBe(500);
    expect((await fetch(`${fake.url}/v1/other?customer=c1`, { method: "POST", headers: { "content-type": json }, body: JSON.stringify({ amount: 5 }) })).status).toBe(500);
    expect((await fetch(`${fake.url}/v1/charges?customer=c1`, { method: "PUT", headers: { "content-type": json }, body: JSON.stringify({ amount: 5 }) })).status).toBe(500);
    expect(fake.usage()).toMatchObject({ matched: 0, unmatchedFailed: 4 });
  });
  it("synthesizes an answer for a request that satisfies the request schema only in schema_synth mode, and counts it", async () => {
    const synth = await replay(makeSet(), { unmatched: "schema_synth" });
    const made = await post(synth, 99);
    expect(made.status).toBe(200);
    expect(made.headers.get("x-rovara-mock")).toBe("synthesized");
    expect(typeof ((await made.json()) as { ok: unknown }).ok).toBe("boolean");
    expect((await post(synth, 1, {}, "customer=c1", { amount: "x" })).status).toBe(500);
    expect(synth.usage()).toMatchObject({ synthesized: 1, unmatchedFailed: 1 });
    expect((await post(await replay(), 99)).status).toBe(500);
  });
  it("serves only the pinned digest: a set that does not parse, was edited, or has an entry under the wrong hash is refused", async () => {
    const set = makeSet();
    const start = (value: unknown, digest = fixtureSetDigest(set)) => startFakeServer({ mode: "replay", fixtureSet: value, expectedDigest: digest, unmatched: "fail", bindAddress: "127.0.0.1", callers: "any", ledgerPath: null });
    const edited = { ...set, entries: [{ ...set.entries[0]!, response: { ...set.entries[0]!.response, body: '{"ok":false}' } }, set.entries[1]!] };
    await expect(start(edited)).rejects.toMatchObject({ reason: "digest_mismatch" });
    await expect(start({ nonsense: true })).rejects.toMatchObject({ reason: "unreadable" });
    await expect(start(set, "a".repeat(64))).rejects.toMatchObject({ reason: "digest_mismatch" });
    await expect(start({ ...set, entries: [{ ...set.entries[0]!, requestHash: "b".repeat(64) }] })).rejects.toBeInstanceOf(FixtureSetRefused);
    await expect(start({ ...set, schemaVersion: 1 })).rejects.toBeInstanceOf(FixtureSetRefused);
  });
  it("serves the task's additions only after the pinned set, each under the hash of its own request", async () => {
    const set = makeSet();
    const shell = { dependency, match };
    const added = fixtureEntry(shell, charge(11), answer({ ok: true, id: "ch_new" }));
    const sneaky = fixtureEntry(shell, charge(5), answer({ ok: false, id: "ch_evil" }));
    const fake = await replay(set, { additionEntries: [added, sneaky] });
    expect(await (await post(fake, 11)).json()).toEqual({ ok: true, id: "ch_new" });
    expect(await (await post(fake, 5)).json()).toEqual({ ok: true, id: "ch_1" });
    expect(fake.usage()).toMatchObject({ matched: 1, additionsServed: 1 });
    const wrongHash = { ...added, requestHash: "c".repeat(64) };
    await expect(replay(set, { additionEntries: [wrongHash] })).rejects.toMatchObject({ reason: "additions_invalid" });
    await expect(replay(set, { additionEntries: [{ ...added, response: { ...added.response, headers: [{ name: "set-cookie", value: "a=b" }] } } as never] })).rejects.toMatchObject({ reason: "additions_invalid" });
  });
  it("waits for the recorded latency only when asked to", async () => {
    const shell = { dependency, match };
    const slow = makeSet({ entries: [fixtureEntry(shell, charge(5), { ...answer({ ok: true }), latencyMs: 120 })] });
    const quick = await replay(slow);
    let begun = Date.now();
    await post(quick, 5);
    expect(Date.now() - begun).toBeLessThan(100);
    const waiting = await replay(slow, { replayLatency: true });
    begun = Date.now();
    await post(waiting, 5);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(100);
  });
  it("answers a model endpoint set (POST /endpoints/<name>/invocations) and leaves another endpoint unmatched without using up a fault", async () => {
    const model = { id: "scorer", family: "aws:sagemaker-runtime", protocol: "model_invoke", target: "partner-scorer" } as const;
    const shell = { dependency: model, match: { ignorePaths: [] as string[] } };
    const request = { method: "POST" as const, path: "/endpoints/partner-scorer/invocations", contentType: json, body: '{"partner":"p1"}' };
    const set = FixtureSetSchema.parse({ schemaVersion: 2, dependency: model, origin: "recorded", revision: 1, recordedAt: "2026-11-02T00:00:00.000Z", syntheticOnly: true, match: shell.match,
      entries: [fixtureEntry(shell, request, answer({ score: 0.9 }))], faults: [{ name: "boom", kind: "http_5xx", status: 503, delayMs: 0 }] });
    const fake = await replay(set);
    await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    expect((await fetch(`${fake.url}/endpoints/other/invocations`, { method: "POST", headers: { "content-type": json }, body: request.body })).status).toBe(500);
    const faulted = await fetch(`${fake.url}/endpoints/partner-scorer/invocations`, { method: "POST", headers: { "content-type": json }, body: request.body });
    expect(faulted.status).toBe(503);
    expect(faulted.headers.get("x-amzn-errortype")).toBe("InternalFailure");
    const served = await fetch(`${fake.url}/endpoints/partner-scorer/invocations`, { method: "POST", headers: { "content-type": json + "; charset=utf-8" }, body: '{"partner":"p1"}' });
    expect(served.status).toBe(200);
    expect(served.headers.get("x-amzn-invoked-production-variant")).toBe("AllTraffic");
  });
});

describe("faults and the control token", () => {
  it("needs the run's token for every control path", async () => {
    const fake = await replay();
    expect((await control(fake, "usage", {}, "wrong")).status).toBe(403);
    expect((await fetch(`${fake.url}/__rovara/usage`)).status).toBe(403);
    expect((await control(fake, "usage")).status).toBe(200);
    expect((await control(fake, "nothing")).status).toBe(404);
  });
  it("writes a refused ledger line, before the 403, for every control request without the token, and none for one with it", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath });
    expect((await control(fake, "usage", {}, "wrong")).status).toBe(403);
    expect((await fetch(`${fake.url}/__rovara/fault`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await control(fake, "usage")).status).toBe(200);
    const lines = await ledgerOf(ledgerPath);
    expect(lines).toMatchObject([{ outcome: "refused", status: 403, path: "/__rovara/usage", method: "GET" }, { outcome: "refused", status: 403, path: "/__rovara/fault", method: "POST" }]);
    // The ledger holds the refusals, and the fake still serves recordings.
    expect((await post(fake, 5)).status).toBe(200);
  });
  it("arms a named fault for the next requests, then goes back to recordings, and counts it", async () => {
    const fake = await replay();
    expect((await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "busy", count: 2 }) })).status).toBe(204);
    for (let n = 0; n < 2; n += 1) expect((await post(fake, 5)).status).toBe(429);
    expect((await post(fake, 5)).status).toBe(200);
    await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    expect((await post(fake, 5)).status).toBe(503);
    expect(fake.usage().faultsInjected).toEqual([{ name: "busy", count: 2 }, { name: "boom", count: 1 }]);
    expect((await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "nope" }) })).status).toBe(404);
    expect((await control(fake, "fault", { method: "POST", body: "{" })).status).toBe(400);
  });
  it("drops the connection for a timeout fault", async () => {
    const fake = await replay();
    await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "hang" }) });
    await expect(post(fake, 5)).rejects.toThrow();
  });
});

describe("the run address", () => {
  it.each(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "localhost", "", "example.com", "127.0.0.1:80", "999.1.1.1"])("refuses %j as the address to listen on", async (address) => {
    expect(() => assertRunAddress(address)).toThrow(FakeServerRefused);
    const set = makeSet();
    await expect(startFakeServer({ mode: "replay", fixtureSet: set, expectedDigest: fixtureSetDigest(set), unmatched: "fail", bindAddress: address, callers: "any", ledgerPath: null })).rejects.toMatchObject({ reason: "bind_address" });
    await expect(startFakeServer({ mode: "sinkhole", bindAddress: address, callers: "any", ledgerPath: null })).rejects.toMatchObject({ reason: "bind_address" });
  });
  it("listens on that address and on no other", async () => {
    const fake = await replay();
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const other = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (other !== undefined) {
      const port = fake.ports[0]!;
      const reached = await new Promise<boolean>((resolve) => { const socket = connect({ host: other, port }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
      expect(reached).toBe(false);
    }
  });
  it("needs a caller list: empty, malformed or named by host is refused", async () => {
    const set = makeSet();
    const start = (callers: readonly string[]) => startFakeServer({ mode: "replay", fixtureSet: set, expectedDigest: fixtureSetDigest(set), unmatched: "fail", bindAddress: "127.0.0.1", callers, ledgerPath: null });
    await expect(start([])).rejects.toMatchObject({ reason: "callers_invalid" });
    await expect(start(["app"])).rejects.toMatchObject({ reason: "callers_invalid" });
    await expect(start(["10.1.2.3", "not an address"])).rejects.toMatchObject({ reason: "callers_invalid" });
  });
});

describe("only the run's own address counts", () => {
  it("answers a call from any other address with the sinkhole's 599, uses up no fault and counts it apart", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { callers: ["10.9.8.7"], ledgerPath });
    await control(fake, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    const response = await post(fake, 5);
    expect(response.status).toBe(599);
    expect(await response.text()).toBe('{"error":"rovara-unmocked"}');
    expect(fake.usage()).toMatchObject({ matched: 0, foreignCalls: 1, faultsInjected: [] });
    const lines = await ledgerOf(ledgerPath);
    expect(lines).toMatchObject([{ outcome: "foreign-caller", status: 599, entryHash: null, remoteAddress: "127.0.0.1" }]);
    // The armed fault is still there for the run's own caller.
    const own = await replay(makeSet(), { callers: ["127.0.0.1"] });
    await control(own, "fault", { method: "POST", body: JSON.stringify({ name: "boom" }) });
    expect((await post(own, 5)).status).toBe(503);
    expect((await post(own, 5)).status).toBe(200);
    expect(own.usage().foreignCalls).toBe(0);
  });
});

describe("limits", () => {
  it("answers a body over 64 KiB with 413, records it and counts it as unrecorded", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath });
    const response = await post(fake, 5, { body: JSON.stringify({ pad: "x".repeat(70_000) }) });
    expect(response.status).toBe(413);
    expect(fake.usage().unmatchedFailed).toBe(1);
    expect(await ledgerOf(ledgerPath)).toMatchObject([{ outcome: "too-large", status: 413 }]);
  });
  it("records a request head over 16 KiB, and anything that is not HTTP, as an unmatched call without answering from the set", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath });
    const port = fake.ports[0]!;
    await raw(port, `POST /v1/charges?customer=c1 HTTP/1.1\r\nhost: x\r\nx-pad: ${"a".repeat(20_000)}\r\n\r\n`);
    await raw(port, Buffer.from("160301020001", "hex"));
    await raw(port, "CONNECT example.com:443 HTTP/1.1\r\nhost: example.com:443\r\n\r\n");
    expect(await until(async () => (await ledgerOf(ledgerPath)).length >= 3)).toBe(true);
    const lines = await ledgerOf(ledgerPath);
    expect(lines.every((line) => line.entryHash === null && line.status === 599)).toBe(true);
    expect(lines.map((line) => line.outcome).sort()).toEqual(["refused", "unparsed", "unparsed"]);
    expect(fake.usage().matched).toBe(0);
  });
  it("records each connection past the cap as a dropped call", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath, maxConnections: 1, connectionGraceMs: 60_000 });
    const held = raw(fake.ports[0]!, "", "127.0.0.1", 2_500);
    await new Promise((done) => setTimeout(done, 200));
    await raw(fake.ports[0]!, "", "127.0.0.1", 400);
    expect(await until(async () => (await ledgerOf(ledgerPath)).some((line) => line.outcome === "dropped"))).toBe(true);
    await held;
  });
  it("stops at the ledger bound: the last slot says so, and nothing is answered from the set afterwards", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath, maxLines: 4 });
    for (let n = 0; n < 3; n += 1) expect((await post(fake, 5)).status).toBe(200);
    expect((await post(fake, 5)).status).toBe(599);
    expect((await post(fake, 5)).status).toBe(599);
    const lines = await ledgerOf(ledgerPath);
    expect(lines.map((line) => line.outcome)).toEqual(["matched", "matched", "matched", "overflow"]);
    expect(fake.usage().matched).toBe(3);
  });
});

describe("the ledger", () => {
  it("is written before the answer, one line per request, with who called and what was answered", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await replay(makeSet(), { ledgerPath });
    // The answer is only sent once the line is on disk: a clock that fails stops the server from answering at all.
    await post(fake, 5);
    await post(fake, 99);
    const [hit, miss] = await ledgerOf(ledgerPath);
    expect(hit).toMatchObject({ method: "POST", path: "/v1/charges", outcome: "matched", status: 200, remoteAddress: "127.0.0.1" });
    expect(hit!.host).toContain("127.0.0.1");
    expect(hit!.entryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(miss).toMatchObject({ outcome: "unmatched", status: 500, entryHash: null });
    expect(new Set([hit!.requestId, miss!.requestId]).size).toBe(2);
    // The query string is not kept in the line.
    expect(JSON.stringify(hit)).not.toContain("customer=");
  });
  it("stops answering when the ledger cannot be written", async () => {
    let failures = 0;
    const fake = await replay(makeSet(), { ledgerPath: join(await tempDir(), "fake.jsonl"), now: () => { throw new Error("disk full"); }, onFatal: () => { failures += 1; } });
    await expect(post(fake, 5)).rejects.toThrow();
    expect(failures).toBe(1);
  });
  it("is read back under System B's rules: trusted only if the helper was still running, only the app's address counts", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const set = makeSet();
    const fake = await replay(set, { ledgerPath });
    await post(fake, 5);
    await post(fake, 7);
    await post(fake, 99);
    const bytes = new Uint8Array(await readFile(ledgerPath));
    const own = parseFakeLedger({ bytes, appAddress: "127.0.0.1", helperStillRunning: true, fixtureSet: set });
    expect(own).toMatchObject({ trusted: true, trustProblem: null, malformed: 0, foreign: 0, counted: { matched: 2, unmatched: 1 } });
    // The same lines from the point of view of an application that has another address: none of them is the app's.
    const elsewhere = parseFakeLedger({ bytes, appAddress: "10.9.8.7", helperStillRunning: true, fixtureSet: set });
    expect(elsewhere).toMatchObject({ trusted: true, foreign: 3, counted: { matched: 0, unmatched: 0 } });
    expect(parseFakeLedger({ bytes, appAddress: null, helperStillRunning: true, fixtureSet: set }).counted.matched).toBe(0);
    // A helper that stopped could have missed calls: nothing is counted from its ledger.
    expect(parseFakeLedger({ bytes, appAddress: "127.0.0.1", helperStillRunning: false, fixtureSet: set })).toMatchObject({ trusted: false, trustProblem: "helper-stopped", counted: { matched: 0, unmatched: 0 } });
  });
  it("is not trusted with a line that does not parse, repeats an id, claims an answer the set never gave, or hides an overflow", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const set = makeSet();
    const fake = await replay(set, { ledgerPath });
    await post(fake, 5);
    const [line] = await ledgerOf(ledgerPath);
    const read = (rows: unknown[], extra: { truncated?: boolean } = {}) => parseFakeLedger({ bytes: new TextEncoder().encode(rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n"), appAddress: "127.0.0.1", helperStillRunning: true, fixtureSet: set, ...extra });
    expect(read([line])).toMatchObject({ trusted: true });
    expect(read([line, "{not json"])).toMatchObject({ trusted: false, trustProblem: "malformed", malformed: 1 });
    expect(read([line, line])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([{ ...line, status: 201 }])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([{ ...line, responseSha256: "d".repeat(64) }])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([{ ...line, entryHash: "e".repeat(64) }])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([{ ...line, outcome: "sinkhole", entryHash: null }])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([{ ...line, extra: 1 }])).toMatchObject({ trusted: false, malformed: 1 });
    expect(read([line], { truncated: true })).toMatchObject({ trusted: false, trustProblem: "overflow" });
  });
  it("keeps run credentials out of what it reports, without dropping or recounting the call", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "fake.jsonl");
    const fake = await startFakeServer({ mode: "sinkhole", bindAddress: "127.0.0.1", callers: "any", ledgerPath });
    running.push(fake);
    const secret = ["run", "secret", "value"].join("-");
    await raw(fake.ports[0]!, `GET /login/${secret}/ HTTP/1.1\r\nhost: ${secret}.example.com\r\nconnection: close\r\n\r\n`);
    const parsed = parseFakeLedger({ bytes: new Uint8Array(await readFile(ledgerPath)), appAddress: "127.0.0.1", helperStillRunning: true });
    expect(parsed.counted.sinkholed).toBe(1);
    const safe = withholdFakeLedgerCredentials(parsed, (bytes) => Buffer.from(bytes).toString("utf8").includes(secret));
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.lines[0]).toMatchObject({ path: "[credential]", host: "[credential]", outcome: "sinkhole" });
    expect(safe.counted.sinkholed).toBe(1);
  });
});

describe("the record-only sinkhole", () => {
  it("records what is asked of it (method, path, the host asked for, who asked) and answers every call 599", async () => {
    const dir = await tempDir();
    const ledgerPath = join(dir, "sink.jsonl");
    const sink = await startFakeServer({ mode: "sinkhole", label: "unknown-hosts", bindAddress: "127.0.0.1", callers: ["127.0.0.1"], ledgerPath });
    running.push(sink);
    const port = sink.ports[0]!;
    const answer1 = await raw(port, "GET /geo/lookup?ip=1.2.3.4 HTTP/1.1\r\nhost: api.example-geo.com\r\nconnection: close\r\n\r\n");
    expect(answer1).toContain("599");
    expect(answer1).toContain('{"error":"rovara-unmocked"}');
    await raw(port, 'POST /v1/charges HTTP/1.1\r\nhost: api.example-pay.com\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}');
    await raw(port, "GET / HTTP/1.1\r\nhost: api.example-geo.com\r\nconnection: close\r\n\r\n");
    expect(await until(async () => (await ledgerOf(sink.usage().service === "unknown-hosts" ? ledgerPath : ledgerPath)).length === 3)).toBe(true);
    const lines = await ledgerOf(ledgerPath);
    expect(lines).toMatchObject([
      { method: "GET", path: "/geo/lookup", host: "api.example-geo.com", outcome: "sinkhole", status: 599, remoteAddress: "127.0.0.1" },
      { method: "POST", path: "/v1/charges", host: "api.example-pay.com", outcome: "sinkhole" },
      { method: "GET", path: "/", host: "api.example-geo.com", outcome: "sinkhole" },
    ]);
    expect(sink.usage()).toMatchObject({ service: "unknown-hosts", matched: 0, unmatchedFailed: 3, hosts: [{ host: "api.example-geo.com", count: 2 }, { host: "api.example-pay.com", count: 1 }] });
    const ledger = parseFakeLedger({ bytes: new Uint8Array(await readFile(ledgerPath)), appAddress: "127.0.0.1", helperStillRunning: true });
    expect(ledger).toMatchObject({ trusted: true, counted: { sinkholed: 3 }, unexpectedHosts: ["api.example-geo.com", "api.example-pay.com"] });
  });
  it("never forwards: an absolute-form request or a CONNECT for another server reaches nothing", async () => {
    let reached = 0;
    const target: NetServer = createNetServer((socket) => { reached += 1; socket.destroy(); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as { port: number }).port;
    running.push({ close: () => new Promise<void>((resolve) => { target.close(() => resolve()); }) });
    const dir = await tempDir();
    const ledgerPath = join(dir, "sink.jsonl");
    const sink = await startFakeServer({ mode: "sinkhole", bindAddress: "127.0.0.1", callers: "any", ledgerPath });
    running.push(sink);
    const port = sink.ports[0]!;
    expect(await raw(port, `GET http://127.0.0.1:${String(targetPort)}/secret HTTP/1.1\r\nhost: 127.0.0.1:${String(targetPort)}\r\nconnection: close\r\n\r\n`)).toContain("599");
    await raw(port, `CONNECT 127.0.0.1:${String(targetPort)} HTTP/1.1\r\nhost: 127.0.0.1:${String(targetPort)}\r\n\r\n`);
    expect(await until(async () => (await ledgerOf(ledgerPath)).length >= 2)).toBe(true);
    await new Promise((done) => setTimeout(done, 150));
    expect(reached).toBe(0);
    const lines = await ledgerOf(ledgerPath);
    expect(lines[0]).toMatchObject({ outcome: "sinkhole", host: `127.0.0.1:${String(targetPort)}` });
    expect(lines.some((line) => line.outcome === "refused")).toBe(true);
  });
  it("answers on every port it is given, and bounds the hosts it counts one by one", async () => {
    const sink = await startFakeServer({ mode: "sinkhole", bindAddress: "127.0.0.1", callers: "any", ledgerPath: null, port: 0, additionalPorts: [0, 0] });
    running.push(sink);
    expect(sink.ports).toHaveLength(3);
    for (const port of sink.ports) expect((await fetch(`http://127.0.0.1:${String(port)}/anything`)).status).toBe(599);
    for (let n = 0; n < 70; n += 1) await raw(sink.ports[0]!, `GET / HTTP/1.1\r\nhost: h${String(n)}.example.com\r\nconnection: close\r\n\r\n`, "127.0.0.1", 300);
    const hosts = sink.usage().hosts;
    expect(hosts.length).toBeLessThanOrEqual(65);
    expect(hosts.at(-1)).toMatchObject({ host: "(other hosts)" });
  });
  it("makes no outbound connection by construction: the fake's own source uses nothing that could", () => {
    const sources = ["fake-core.ts", "fake-server.ts", "fake-ledger.ts"].map((name) => readFileSync(join(here, "../../packages/verifier/src/service-mocks", name), "utf8"));
    for (const source of sources) {
      const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
      expect(code).not.toMatch(/node:(https|http2|tls|dns|dgram|child_process|worker_threads|cluster)\b/u);
      expect(code).not.toMatch(/\bfetch\s*\(|\.request\s*\(|\bcreateConnection\b|\bnet\.connect\b|\bconnect\s*\(\s*\{|\bsocket\.connect\b/u);
    }
    const imports = readFileSync(join(here, "../../packages/verifier/src/service-mocks/fake-core.ts"), "utf8").match(/^import .* from "[^"]+";$/gmu) ?? [];
    expect(imports.every((line) => /from "node:(crypto|fs|http|net)"/u.test(line))).toBe(true);
    // The core takes its sockets from `http.createServer` alone, and from `net` only the Socket type.
    expect(imports.filter((line) => line.includes('"node:net"')).every((line) => line.startsWith("import type"))).toBe(true);
    expect(imports.filter((line) => line.includes('"node:http"')).join("\n")).not.toMatch(/\brequest\b|\bget\b|\bAgent\b/u);
  });
});

describe("the response header allow-list", () => {
  it("keeps only the contract's headers, one plain line each, once", () => {
    expect(allowedResponseHeaders([
      { name: "etag", value: "abc" }, { name: "x-request-id", value: "r-1" }, { name: "set-cookie", value: "sid=1" }, { name: "location", value: "https://evil.example.com/" },
      { name: "authorization", value: "Bearer x" }, { name: "retry-after", value: "3\r\nset-cookie: a=b" }, { name: "etag", value: "second" }, { name: "x-powered-by", value: "x" },
      { name: "content-length", value: "1" }, { name: "transfer-encoding", value: "chunked" }, { name: "cache-control", value: "x".repeat(300) },
    ])).toEqual({ etag: "abc", "x-request-id": "r-1" });
  });
});

describe("the old entry points run on it", () => {
  const fixture: E2EApiMockFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getStock", method: "GET", path: "/v1/stock", inputField: "orderId", variants: [
    { id: "success", inputValue: "a1", status: 200, body: { status: "in-stock" } },
    { id: "refusal", inputValue: "a2", status: 404, body: { error: "unknown order" } },
    { id: "invalid-data", inputValue: "b1", status: 200, body: { status: 7 } },
  ] };
  it("answers an E2E checker fixture the same way as the container's mock, through the converter", async () => {
    const dir = await tempDir();
    const old = await startMockServer({ fixture, ledgerPath: join(dir, "old.jsonl"), host: "127.0.0.1", port: 0 });
    running.push(old);
    const fake = await startFakeFromE2eFixture(fixture, { host: "inventory.example-shop.com", bindAddress: "127.0.0.1", callers: "any", ledgerPath: null });
    running.push(fake);
    for (const value of ["a1", "a2", "b1"]) {
      const before = await fetch(`http://127.0.0.1:${String(old.port)}/v1/stock?orderId=${value}`);
      const after = await fetch(`${fake.url}/v1/stock?orderId=${value}`);
      expect([after.status, await after.text()]).toEqual([before.status, await before.text()]);
    }
    for (const path of ["/v1/stock?orderId=zz", "/v1/stock", "/v1/other?orderId=a1", "/v1/stock?orderId=a1&debug=1"]) {
      const before = await fetch(`http://127.0.0.1:${String(old.port)}${path}`);
      const after = await fetch(`${fake.url}${path}`);
      // The request with an extra parameter still finds its recording in a v2 set (parameters the set does not match on are ignored); every other one is unmatched in both.
      if (path.endsWith("debug=1")) { expect(before.status).toBe(599); expect(after.status).toBe(200); } else { expect(before.status).toBe(599); expect(after.status).toBe(500); }
    }
    expect(fake.usage()).toMatchObject({ matched: 4, unmatchedFailed: 3 });
  });
  it("refuses a v1 set of an HTTP service, whose entries kept no method or path, instead of guessing", async () => {
    const v1 = ServiceMockFixtureSetSchema.parse({ schemaVersion: 1, service: { name: "geo", kind: "http", target: "api.example-geo.com" }, revision: 1, recordedAt: "2026-11-02T00:00:00.000Z", syntheticOnly: true,
      requestSchema: null, responseSchema: null, entries: [{ requestHash: "a".repeat(64), request: { contentType: json, body: "{}" }, response: { status: 200, contentType: json, body: "{}", latencyMs: 0 } }], faults: [] });
    await expect(startServiceMock({ fixtureSet: v1, expectedDigest: serviceMockFixtureSetDigest(v1), unmatched: "fail" })).rejects.toMatchObject({ reason: "request_lines_unknown" });
  });
  it("lists the files of the helper: one core, one fake server, one ledger reader (no second server)", async () => {
    const files = await readdir(join(here, "../../packages/verifier/src/service-mocks"));
    expect(files.filter((name) => /^(fake|server)/u.test(name)).sort()).toEqual(["fake-core.ts", "fake-ledger.ts", "fake-server.ts", "server.ts"]);
    const server = readFileSync(join(here, "../../packages/verifier/src/service-mocks/server.ts"), "utf8");
    expect(server).not.toMatch(/createServer/u);
    const old = readFileSync(join(here, "../../packages/verifier/src/executor/mock-server.ts"), "utf8");
    expect(old).not.toMatch(/createServer\(/u);
  });
});
