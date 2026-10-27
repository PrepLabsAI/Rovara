import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2E_MODEL_SESSION_SYNC_FEATURE, E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES, E2E_MODEL_SESSION_SYNC_MAX_VALUES, E2EModelChannelRequestSchema, E2EModelChannelStepMarkerSchema,
  E2EModelSessionSyncSchema, WORKER_INVOCATION_FEATURES,
} from "../../packages/contracts/src/index.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { E2EModelChannelError, createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { E2E_SESSION_SYNC_PENDING_LIMIT_MS, createE2ESessionSyncSource, type E2ESessionStateReader } from "../../packages/verifier/src/executor/session-sync.js";
import { parseSetCookie } from "../../packages/verifier/src/executor/form-login.js";
import { createE2ECredentialGuard } from "../../packages/worker/src/e2e-model-credential-guard.js";
import { e2eSecretSpellings } from "../../packages/worker/src/e2e-secret-spellings.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelProxy, type E2EModelTranscript } from "../../packages/worker/src/e2e-model-proxy.js";
import { createApplicationChecksFeatureMonitor } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import type { E2EModelReceipt } from "../../packages/contracts/src/e2e-model-channel.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, RUN_ID, bedrockRoute, call, channelRequest, tapAnswer } from "../support/e2e-model-fixtures.js";

// MIDSTEPCOOKIE: the redaction set is current before EVERY model call, and a call without a current sync is refused.

/** Contains a quote and a backslash (so its JSON-escaped spelling differs from the raw one) and `>>` (so its base64url spelling differs from its base64 one). */
const COOKIE = 's3ss"on\\id/AB12+Z9x8y7w6v5u4>>??~~';
const POSITION = { caseId: CASE_ID, stepIndex: 0 };

class Sink implements E2EModelEvidenceSink {
  receipts: E2EModelReceipt[] = [];
  transcripts: E2EModelTranscript[] = [];
  writeReceipt(receipt: E2EModelReceipt) { this.receipts.push(receipt); }
  writeTranscript(transcript: E2EModelTranscript) { this.transcripts.push(transcript); }
}

const ENCODINGS: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ["raw", (value) => value],
  ["percent-encoded", (value) => encodeURIComponent(value)],
  ["double percent-encoded", (value) => encodeURIComponent(encodeURIComponent(value))],
  ["base64", (value) => Buffer.from(value, "utf8").toString("base64")],
  ["base64url", (value) => Buffer.from(value, "utf8").toString("base64url")],
  ["hex", (value) => Buffer.from(value, "utf8").toString("hex")],
  ["JSON-escaped", (value) => JSON.stringify(value).slice(1, -1)],
];

let dir: string;
let socketPath: string;
const closers: Array<() => Promise<unknown>> = [];
let proxyCount = 0;

beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "ms-")); proxyCount = 0; });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

async function startRun(options: { allowedSteps?: Array<{ caseId: string; stepIndex: number }>; begin?: boolean } = {}) {
  const seen: unknown[] = [];
  const invoke: E2EInvoke = async (input) => { seen.push(input.call); return tapAnswer(); };
  const route = createGovernedE2EModelRoute(bedrockRoute(), { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
  const sink = new Sink();
  socketPath = join(dir, `m${++proxyCount}.sock`);
  const proxy: E2EModelProxy = await startE2EModelProxy({ socketPath, runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] }, evidence: sink,
    deadlineAt: Date.now() + 60_000, environment: {}, allowedSteps: options.allowedSteps ?? [POSITION] });
  closers.push(() => proxy.close());
  if (options.begin !== false) proxy.beginStep(POSITION);
  return { proxy, seen, sink, socketPath };
}

function postJson(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: Record<string, unknown> & { result?: { status: string; code?: string; message?: string } } }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as never }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const syncBody = (syncSeq: number, values: string[] = [], runId = RUN_ID) => ({ schemaVersion: "rovara-e2e-model-channel/v1", runId, syncSeq, values });
const callBody = (callIndex: number, syncSeq: number | undefined, observation?: string) => channelRequest({ callIndex, ...(syncSeq === undefined ? {} : { syncSeq }), ...(observation === undefined ? {} : { callOverride: call(observation) }) });

// ---------------------------------------------------------------------------------------------------------------------
// The real stack: a fake app sets a session cookie mid-step; the executor's source reads the browser; the worker's proxy scans.
// ---------------------------------------------------------------------------------------------------------------------

/** An app that sets a session cookie when asked to log in. Its own port, chosen by the OS. */
async function fakeApp(cookieValue: string): Promise<{ port: number }> {
  const server: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/login") res.setHeader("set-cookie", `session=${cookieValue}; HttpOnly; Path=/`);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: (server.address() as { port: number }).port };
}

/** A browser stand-in: a cookie jar fed from the app's answers, with the response-header read finishing a little later than the answer, as Playwright's does. */
function fakeBrowser(port: number, onResponse: (setCookies: string[]) => void) {
  const jar: Array<{ name: string; value: string; httpOnly: boolean }> = [];
  const reader: E2ESessionStateReader = { storageState: async () => ({ cookies: jar.map((cookie) => ({ ...cookie })), origins: [] }) };
  const goto = (path: string) => new Promise<void>((resolve) => {
    httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      const setCookies = res.headers["set-cookie"] ?? [];
      for (const line of setCookies) { const parsed = parseSetCookie(line); if (parsed !== null) jar.push(parsed); }
      onResponse(setCookies);
      res.resume();
      res.on("end", resolve);
    }).end();
  });
  return { reader, goto, jar };
}

/** The executor's side, wired the way the host wires it: registered session values, the source, the response listener, the client. */
function executorFor(port: number, options: { learnFromBrowser?: boolean } = {}) {
  const sessionSecrets: string[] = [];
  const register = (value: string) => { if (value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value); };
  const source = createE2ESessionSyncSource({ register, known: () => sessionSecrets });
  const browser = fakeBrowser(port, (setCookies) => {
    source.track(new Promise<void>((resolve) => setTimeout(() => {
      for (const line of setCookies) { const parsed = parseSetCookie(line); if (parsed !== null && parsed.value.length >= 8) register(parsed.value); }
      resolve();
    }, 15)));
  });
  source.attach("s1", browser.reader, { anonymous: false });
  // A source that never looks at the browser: the executor of before this change, which told the worker only what it knew when the step began.
  const stale = { read: async (): Promise<readonly string[]> => [] };
  const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: options.learnFromBrowser === false ? stale : source });
  return { client, browser, source, sessionSecrets };
}

describe("a session cookie set mid-step is redacted from the next model call of the same step, in every encoding", () => {
  it("uses a cookie whose spellings all differ (otherwise an encoding case would test the raw form twice)", () => {
    const spellings = ENCODINGS.map(([, encode]) => encode(COOKIE));
    expect(new Set(spellings).size).toBe(ENCODINGS.length);
  });

  it.each(ENCODINGS)("%s", async (_name, encode) => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const executor = executorFor(app.port);
    await executor.client.beginStep(POSITION);
    // Before the login the page shows nothing secret: the call goes through.
    const before = await executor.client.generate({ ...POSITION, callIndex: 0, call: call() });
    expect(before.result.status).toBe("ok");
    expect(run.seen).toHaveLength(1);
    // The login happens mid-step. Nothing tells the worker except the sync that precedes the next call.
    await executor.browser.goto("/login");
    const after = await executor.client.generate({ ...POSITION, callIndex: 1, call: call(`#n1 text "Signed in: ${encode(COOKIE)}"`) });
    expect(after.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    // The model was called once, for the first call; the cookie, in no spelling, reached it.
    expect(run.seen).toHaveLength(1);
    for (const spelling of e2eSecretSpellings(COOKIE)) expect(JSON.stringify(run.seen), spelling).not.toContain(spelling);
    // Nor did it reach the stored evidence of the refused call.
    for (const spelling of e2eSecretSpellings(COOKIE)) expect(JSON.stringify([run.sink.receipts, run.sink.transcripts]), spelling).not.toContain(spelling);
    expect(run.sink.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "refused-credential-match"]);
  });

  it("finds the cookie inside longer base64 and base64url text at every alignment (a Basic header, a token payload), and ignores the same text without it", () => {
    const guard = createE2ECredentialGuard({ passwords: [], emails: [], cookieValues: [COOKIE] });
    for (const prefix of ["", "a:", "ab:", "abc:", "user-name:"]) {
      for (const encoding of ["base64", "base64url"] as const) {
        const text = `#n1 text "Authorization: Basic ${Buffer.from(`${prefix}${COOKIE}:tail`, "utf8").toString(encoding)}"`;
        expect(guard.inspect(call(text)), `${prefix} ${encoding}`).toMatchObject({ refuse: true, category: "cookie" });
      }
    }
    const innocent = `#n1 text "Authorization: Basic ${Buffer.from("user-name:not-the-cookie:tail", "utf8").toString("base64")}"`;
    expect(guard.inspect(call(innocent))).toMatchObject({ refuse: false });
  });

  it.each(ENCODINGS)("positive control, %s: an executor that does not read the browser lets the same call reach the model, so the leak path is real", async (_name, encode) => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const executor = executorFor(app.port, { learnFromBrowser: false });
    await executor.client.beginStep(POSITION);
    await executor.client.generate({ ...POSITION, callIndex: 0, call: call() });
    await executor.browser.goto("/login");
    const after = await executor.client.generate({ ...POSITION, callIndex: 1, call: call(`#n1 text "Signed in: ${encode(COOKIE)}"`) });
    expect(after.result.status).toBe("ok");
    expect(JSON.stringify(run.seen)).toContain(JSON.stringify(encode(COOKIE)).slice(1, -1));
  });

  it("learns a cookie that is only in the browser's jar (set by a script, in no response header)", async () => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const executor = executorFor(app.port);
    await executor.client.beginStep(POSITION);
    const scripted = "client-set-token-9f8e7d6c5b4a";
    executor.browser.jar.push({ name: "token", value: scripted, httpOnly: false });
    const first = await executor.client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 text "${scripted}"`) });
    expect(first.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
  });

  it("a cookie that the worker was told only at the begin marker is still scanned for (the begin marker keeps working)", async () => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const executor = executorFor(app.port);
    await executor.client.beginStep({ ...POSITION, cookieValues: [COOKIE] });
    const answer = await executor.client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 text "${COOKIE}"`) });
    expect(answer.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The proxy refuses a call without a current sync.
// ---------------------------------------------------------------------------------------------------------------------

describe("the proxy refuses a model call whose sync is missing or stale, with a fixed code and without reading the prompt", () => {
  it("refuses a call that names no sync, and keeps no copy of its prompt (the scan may not know what it carries)", async () => {
    const run = await startRun();
    const unsynced = "unsynced-session-cookie-9f8e7d6c5b";
    const reply = await postJson("/v1/generate", callBody(0, undefined, `#n1 text "${unsynced}"`));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(reply.body.result?.message).toMatch(/^session-sync-missing:/);
    expect(run.seen).toHaveLength(0);
    expect(run.sink.receipts.map((receipt) => receipt.outcome)).toEqual(["refused-protocol"]);
    expect(run.sink.transcripts[0]!.prompt).toBeNull();
    expect(JSON.stringify([run.sink.receipts, run.sink.transcripts, reply.body])).not.toContain(unsynced);
  });

  it("refuses a sync that is replayed, one that was never sent, and one a newer sync overtook; each call needs a sync of its own", async () => {
    const run = await startRun();
    expect((await postJson("/v1/sync", syncBody(1))).status).toBe(200);
    expect((await postJson("/v1/generate", callBody(0, 1))).body.result?.status).toBe("ok");
    expect(run.seen).toHaveLength(1);
    // The same sync again: already used by the call above.
    const replayed = await postJson("/v1/generate", callBody(1, 1));
    expect(replayed.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(replayed.body.result?.message).toMatch(/^session-sync-stale:/);
    // A sync the executor never sent.
    expect((await postJson("/v1/generate", callBody(2, 99))).body.result?.message).toMatch(/^session-sync-stale:/);
    // A sync that a newer one overtook.
    expect((await postJson("/v1/sync", syncBody(2))).status).toBe(200);
    expect((await postJson("/v1/sync", syncBody(3))).status).toBe(200);
    expect((await postJson("/v1/generate", callBody(3, 2))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(1);
    // A fresh sync covers exactly one call.
    expect((await postJson("/v1/sync", syncBody(4))).status).toBe(200);
    expect((await postJson("/v1/generate", callBody(4, 4))).body.result?.status).toBe("ok");
    expect((await postJson("/v1/generate", callBody(5, 4))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(2);
    expect(run.sink.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "refused-protocol", "refused-protocol", "refused-protocol", "ok", "refused-protocol"]);
  });

  it("accepts a sync only in order, for this run, in the shape the protocol defines", async () => {
    await startRun();
    expect((await postJson("/v1/sync", syncBody(5))).status).toBe(200);
    expect(await postJson("/v1/sync", syncBody(5))).toMatchObject({ status: 409, body: { status: "refused", code: "stale-sync" } });
    expect(await postJson("/v1/sync", syncBody(4))).toMatchObject({ status: 409, body: { code: "stale-sync" } });
    expect(await postJson("/v1/sync", syncBody(6, [], "11111111-2222-4333-8444-555555555555"))).toMatchObject({ status: 403, body: { code: "other-run" } });
    expect(await postJson("/v1/sync", { ...syncBody(6), extra: true })).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(0))).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(6, Array.from({ length: E2E_MODEL_SESSION_SYNC_MAX_VALUES + 1 }, (_, index) => `value-number-${index}`)))).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", { not: "a sync" })).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(6), "GET")).toMatchObject({ status: 405 });
    // The refused syncs changed nothing: the next in order is accepted.
    expect((await postJson("/v1/sync", syncBody(6))).status).toBe(200);
  });

  it("learns the values of a sync before the call that names it is looked at, and refuses a later sync past the run's total", async () => {
    const run = await startRun();
    const value = "late-session-value-1a2b3c4d5e";
    expect((await postJson("/v1/sync", syncBody(1, [value]))).body).toMatchObject({ status: "ok", syncSeq: 1 });
    const reply = await postJson("/v1/generate", callBody(0, 1, `#n1 text "${value}"`));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
    // The total a run may teach the worker is bounded; past it the sync is refused (and so is every call that would need it).
    let seq = 2;
    let refused: Awaited<ReturnType<typeof postJson>> | undefined;
    for (let sent = 1; sent < E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES && refused === undefined; sent += E2E_MODEL_SESSION_SYNC_MAX_VALUES) {
      const reply2 = await postJson("/v1/sync", syncBody(seq, Array.from({ length: E2E_MODEL_SESSION_SYNC_MAX_VALUES }, (_, index) => `bulk-session-value-${seq}-${index}`)));
      seq += 1;
      if (reply2.status !== 200) refused = reply2;
    }
    expect(refused).toMatchObject({ status: 400, body: { code: "too-many-values" } });
  });

  it("a value too short to scan for safely latches the proxy to refuse every later call (fail closed, as for the begin marker)", async () => {
    const run = await startRun();
    expect((await postJson("/v1/sync", syncBody(1, ["abc"]))).status).toBe(200);
    const reply = await postJson("/v1/generate", callBody(0, 1));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The executor's source and client.
// ---------------------------------------------------------------------------------------------------------------------

describe("the executor's session source reads the browser before each sync", () => {
  const reader = (state: Awaited<ReturnType<E2ESessionStateReader["storageState"]>> | Error): E2ESessionStateReader => ({ storageState: async () => { if (state instanceof Error) throw state; return state; } });

  it("registers cookies and local storage values that look like secrets and leaves short or common values alone, once each", async () => {
    const registered: string[] = [];
    const source = createE2ESessionSyncSource({ register: (value) => registered.push(value), known: () => registered });
    source.attach("s1", reader({
      cookies: [{ value: "1", httpOnly: false }, { value: "true", httpOnly: false }, { value: "en-US", httpOnly: true }, { value: "a-long-session-cookie-value", httpOnly: false }, { value: "abc12345", httpOnly: true }],
      origins: [{ localStorage: [{ value: "accepted" }, { value: "a-long-local-storage-access-token" }] }],
    }), { anonymous: false });
    expect(await source.read()).toEqual(["a-long-session-cookie-value", "abc12345", "a-long-local-storage-access-token"]);
    await source.read();
    expect(registered).toHaveLength(3);
  });

  it("leaves out an anonymous visitor's context and a context that was detached", async () => {
    const registered: string[] = [];
    const source = createE2ESessionSyncSource({ register: (value) => registered.push(value), known: () => registered });
    source.attach("anon", reader({ cookies: [{ value: "visitor-id-1234567890123", httpOnly: false }], origins: [] }), { anonymous: true });
    source.attach("gone", reader({ cookies: [{ value: "gone-session-1234567890123", httpOnly: false }], origins: [] }), { anonymous: false });
    source.detach("gone");
    expect(await source.read()).toEqual([]);
  });

  it("rejects, so no call is made, when the browser cannot be read or the response headers are not read in time", async () => {
    const source = createE2ESessionSyncSource({ register: () => undefined, known: () => [], pendingLimitMs: 30 });
    source.attach("s1", reader(new Error("context closed")), { anonymous: false });
    await expect(source.read()).rejects.toThrow();
    const hung = createE2ESessionSyncSource({ register: () => undefined, known: () => [], pendingLimitMs: 30 });
    hung.track(new Promise(() => undefined));
    await expect(hung.read()).rejects.toThrow(/not read in time/);
    expect(E2E_SESSION_SYNC_PENDING_LIMIT_MS).toBeGreaterThan(0);
  });
});

describe("the executor's channel client syncs before every call", () => {
  interface Seen { url: string | undefined; body: string }
  async function fakeWorker(handle: (req: IncomingMessage, res: ServerResponse, body: string, seen: Seen[]) => void): Promise<Seen[]> {
    const seen: Seen[] = [];
    socketPath = join(dir, `fw${++proxyCount}.sock`);
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); seen.push({ url: req.url, body }); handle(req, res, body, seen); });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return seen;
  }
  const answer = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const okSync = (res: ServerResponse, body: string) => answer(res, 200, { schemaVersion: "rovara-e2e-model-channel/v1", status: "ok", syncSeq: (JSON.parse(body) as { syncSeq: number }).syncSeq });
  const okCall = { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "r1", result: { status: "ok", content: [{ type: "tool-call", toolCallId: "c1", toolName: "tap", input: "{\"target\":\"n1\"}" }],
    finishReason: { unified: "tool-calls", raw: "x" }, usage: { inputTokens: 1, outputTokens: 1 } } };

  it("sends a sync, even an empty one, before each call and names the latest sequence on the call; sequences only go up", async () => {
    const seen = await fakeWorker((req, res, body) => { if (req.url === "/v1/sync") okSync(res, body); else answer(res, 200, okCall); });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => ["token-value-0000000001"] } });
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    await client.generate({ ...POSITION, callIndex: 1, call: call() });
    expect(seen.map((item) => item.url)).toEqual(["/v1/sync", "/v1/generate", "/v1/sync", "/v1/generate"]);
    expect(seen.map((item) => (item.url === "/v1/sync" ? (JSON.parse(item.body) as { syncSeq: number; values: string[] }) : (JSON.parse(item.body) as { syncSeq: number }))))
      .toMatchObject([{ syncSeq: 1, values: ["token-value-0000000001"] }, { syncSeq: 1 }, { syncSeq: 2, values: [] }, { syncSeq: 2 }]);
  });

  it("sends a long delta as several syncs and names the last; a value counts as told only once the worker accepted it", async () => {
    const values = Array.from({ length: 40 }, (_, index) => `session-value-${String(index).padStart(4, "0")}-xyz`);
    let failNext = false;
    const seen = await fakeWorker((req, res, body) => {
      if (req.url !== "/v1/sync") { answer(res, 200, okCall); return; }
      if (failNext && (JSON.parse(body) as { syncSeq: number }).syncSeq === 2) { answer(res, 409, { status: "refused", code: "stale-sync" }); return; }
      okSync(res, body);
    });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => values } });
    failNext = true;
    // The second chunk is refused: the call is not made.
    await expect(client.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ name: "E2EModelChannelError", code: "session-sync", isRetryable: false });
    expect(seen.map((item) => item.url)).toEqual(["/v1/sync", "/v1/sync"]);
    failNext = false;
    // Next time the chunk the worker never accepted is sent again, under a new sequence number.
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    const syncs = seen.filter((item) => item.url === "/v1/sync").map((item) => JSON.parse(item.body) as { syncSeq: number; values: string[] });
    expect(syncs.map((item) => [item.syncSeq, item.values.length])).toEqual([[1, 32], [2, 8], [3, 8]]);
    expect(syncs[2]!.values).toEqual(values.slice(32));
    expect((JSON.parse(seen.at(-1)!.body) as { syncSeq: number }).syncSeq).toBe(3);
  });

  it("makes no call when the session cannot be read, or a value cannot be sent, and keeps a transport failure's own code", async () => {
    const seen = await fakeWorker((req, res, body) => { if (req.url === "/v1/sync") okSync(res, body); else answer(res, 200, okCall); });
    const unreadable = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => { throw new Error("SECRET /srv/path"); } } });
    const failure = await unreadable.generate({ ...POSITION, callIndex: 0, call: call() }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(E2EModelChannelError);
    expect(failure).toMatchObject({ code: "session-sync" });
    expect((failure as Error).message).not.toMatch(/SECRET|srv/);
    const oversized = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => ["x".repeat(5_000)] } });
    await expect(oversized.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    const flood = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => Array.from({ length: 300 }, (_, index) => `flood-value-${index}-abcdef`) } });
    await expect(flood.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    expect(seen).toHaveLength(0);
    const nobody = createE2EModelChannelClient({ socketPath: join(dir, "nobody.sock"), runId: RUN_ID, sessionSync: { read: async () => [] } });
    await expect(nobody.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("is the only way to call the model: no code in the executor package posts to the generate path or calls the channel client outside the client and the model adapter", () => {
    const root = new URL("../../packages/verifier/src", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (current: string) => { for (const name of readdirSync(current)) { const path = join(current, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
    walk(root);
    const mention = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.slice(root.length + 1)).sort();
    expect(mention(/E2E_MODEL_CHANNEL_GENERATE_PATH|["'`]\/v1\/generate["'`]/)).toEqual(["executor/model-channel.ts"]);
    expect(mention(/\bclient\.generate\(|options\.client\.generate\(/)).toEqual(["executor/agent-model-adapter.ts"]);
    expect(mention(/createE2EModelChannelClient\(/)).toEqual(["executor/host.ts", "executor/model-channel.ts"]);
    // The host builds its one client with the browser-backed source.
    expect(readFileSync(join(root, "executor/host.ts"), "utf8")).toMatch(/createE2EModelChannelClient\(\{[^}]*sessionSync \}\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Mixed fleets and stored records.
// ---------------------------------------------------------------------------------------------------------------------

describe("mixed fleets are refused cleanly, and nothing stored before this change stops parsing", () => {
  it("lists the feature among the worker's invocation features, and the worker lists it only while its executor image has the label", async () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(E2E_MODEL_SESSION_SYNC_FEATURE);
    const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64);
    const dockerFor = (label: string) => ({ run: vi.fn(async (args: string[]) => ({ code: 0, stdout: args.includes("--format") ? label : "", stderr: "" })) });
    const ping = async (monitor: ReturnType<typeof createApplicationChecksFeatureMonitor>) => {
      const journalDir = await mkdtemp(join(tmpdir(), "mj-"));
      closers.push(() => rm(journalDir, { recursive: true, force: true }));
      const state = createWorkerServerState(new OperationJournal(join(journalDir, "journal")), { ...monitor.executor, run: async () => ({}) } as never);
      return (await handleWorkerRequest(new Request("http://worker/ping"), state)).json() as Promise<{ invocationFeatures: string[]; invocationFeatureDiagnostics?: Record<string, unknown> }>;
    };
    // An executor image from before this change has no label (the format prints nothing): the feature is withheld, with a fixed reason.
    const old = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker: dockerFor(""), intervalMs: 60_000 });
    const before = await ping(old);
    expect(before.invocationFeatures).not.toContain(E2E_MODEL_SESSION_SYNC_FEATURE);
    old.start();
    await vi.waitFor(() => expect(old.current()).toEqual({ status: "ready" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const oldImage = await ping(old);
    old.stop();
    expect(oldImage.invocationFeatures).not.toContain(E2E_MODEL_SESSION_SYNC_FEATURE);
    expect(oldImage.invocationFeatureDiagnostics).toMatchObject({ [E2E_MODEL_SESSION_SYNC_FEATURE]: { status: "unavailable", reason: "executor-image-lacks-session-sync" } });
    // Positive control: the same worker with the labelled image lists it.
    const fresh = createApplicationChecksFeatureMonitor({ environment: { EXECUTOR_IMAGE: image }, platform: "linux", arch: "arm64", docker: dockerFor("v1"), intervalMs: 60_000 });
    fresh.start();
    await vi.waitFor(() => expect(fresh.current()).toEqual({ status: "ready" }));
    await vi.waitFor(async () => expect((await ping(fresh)).invocationFeatures).toContain(E2E_MODEL_SESSION_SYNC_FEATURE));
    fresh.stop();
  });

  it("a part from before the sync cannot take part: an older worker's strict schema refuses the new fields, and the newer worker refuses an older executor's call that names no sync", async () => {
    // An older worker's request schema is strict, so it refuses a request that names `syncSeq`, and it does not serve `/v1/sync` (404): the new executor cannot make a call through it.
    // This pins the strictness that refusal rests on.
    const newRequest = channelRequest({ syncSeq: 1 });
    expect(E2EModelChannelRequestSchema.safeParse(newRequest).success).toBe(true);
    expect(E2EModelChannelRequestSchema.safeParse({ ...newRequest, unknownField: 1 }).success).toBe(false);
    expect(E2EModelSessionSyncSchema.safeParse({ ...syncBody(1), unknownField: 1 }).success).toBe(false);
    // An older executor's call (no `syncSeq`) is refused by the newer worker and never reaches the model.
    const run = await startRun();
    const reply = await postJson("/v1/generate", channelRequest({ callIndex: 0 }));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(run.seen).toHaveLength(0);
    // Even a begin marker with cookie values, as an older executor sends it, does not make the call acceptable.
    expect((await postJson("/v1/step", { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "end", caseId: CASE_ID, stepIndex: 0 })).status).toBe(200);
  });

  it("parses a request, a begin marker and an end marker exactly as the code before this change wrote them", () => {
    const oldRequest = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, callIndex: 3, call: call() };
    expect(E2EModelChannelRequestSchema.parse(oldRequest)).toEqual(oldRequest);
    const oldBegin = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "begin", caseId: CASE_ID, stepIndex: 1, cookieValues: ["session=abcdef123456"] };
    expect(E2EModelChannelStepMarkerSchema.parse(oldBegin)).toEqual(oldBegin);
    const oldEnd = { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, marker: "end", caseId: CASE_ID, stepIndex: 1 };
    expect(E2EModelChannelStepMarkerSchema.parse(oldEnd)).toEqual(oldEnd);
    // A request that names a sync is the same record plus one optional field; the sync itself is a new record, so nothing stored has to parse it.
    expect(E2EModelChannelRequestSchema.parse({ ...oldRequest, syncSeq: 7 })).toMatchObject({ syncSeq: 7 });
    expect(E2EModelChannelRequestSchema.safeParse({ ...oldRequest, syncSeq: 0 }).success).toBe(false);
    expect(E2EModelSessionSyncSchema.safeParse({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, syncSeq: 1, values: [] }).success).toBe(true);
  });

  it("writes receipts and transcripts a reader from before this change still parses (a refused sync is the existing `refused-protocol` outcome)", async () => {
    const { E2EModelReceiptSchema } = await import("../../packages/contracts/src/e2e-model-channel.js");
    const run = await startRun();
    await postJson("/v1/generate", callBody(0, undefined));
    await postJson("/v1/sync", syncBody(1));
    await postJson("/v1/generate", callBody(1, 1));
    const summary = await run.proxy.close();
    expect(summary.receipts.map((receipt) => receipt.outcome)).toEqual(["refused-protocol", "ok"]);
    for (const receipt of summary.receipts) expect(E2EModelReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(Object.keys(summary.receipts[0]!).sort()).toEqual(Object.keys(E2EModelReceiptSchema.shape).filter((key) => key in summary.receipts[0]!).sort());
  });
});
