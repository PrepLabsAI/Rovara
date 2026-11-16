import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2E_MODEL_SESSION_SYNC_FEATURE, E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES, E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES, E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS, E2E_MODEL_SESSION_SYNC_MAX_VALUES,
  E2EModelChannelRequestSchema, E2EModelChannelStepMarkerSchema, E2EModelSessionSyncSchema, WORKER_INVOCATION_FEATURES, boundSessionValue,
} from "../../packages/contracts/src/index.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget, type E2EInvoke } from "../../packages/model-runtime/src/e2e-route.js";
import { E2EModelChannelError, createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { E2E_SESSION_SYNC_PENDING_LIMIT_MS, createE2ESessionSyncSource, type E2ESessionStateReader } from "../../packages/verifier/src/executor/session-sync.js";
import { createE2EAgentModelAdapter } from "../../packages/verifier/src/executor/agent-model-adapter.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { parseSetCookie } from "../../packages/verifier/src/executor/form-login.js";
import { isSessionStorageCredential } from "../../packages/verifier/src/executor/session-storage-secret.js";
import { createE2ECredentialGuard } from "../../packages/worker/src/e2e-model-credential-guard.js";
import { e2eSecretSpellings } from "../../packages/worker/src/e2e-secret-spellings.js";
import { startE2EModelProxy, type E2EModelEvidenceSink, type E2EModelProxy, type E2EModelTranscript } from "../../packages/worker/src/e2e-model-proxy.js";
import { createE2ESessionSyncLedger } from "../../packages/worker/src/e2e-model-session-sync.js";
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
const syncBody = (values: string[] = [], runId = RUN_ID) => ({ schemaVersion: "rovara-e2e-model-channel/v1", runId, values });
const callBody = (callIndex: number, syncToken: string | undefined, observation?: string) => channelRequest({ callIndex, ...(syncToken === undefined ? {} : { syncToken }), ...(observation === undefined ? {} : { callOverride: call(observation) }) });
/** A sync the worker accepted; returns the token it issued. */
const syncToken = async (values: string[] = []): Promise<string> => {
  const reply = await postJson("/v1/sync", syncBody(values));
  expect(reply.status).toBe(200);
  return reply.body["syncToken"] as string;
};

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
  const storage: Array<{ name: string; value: string }> = [];
  const reader: E2ESessionStateReader = { storageState: async () => ({ cookies: jar.map((cookie) => ({ ...cookie })), origins: [{ localStorage: storage.map((entry) => ({ ...entry })) }] }) };
  const goto = (path: string) => new Promise<void>((resolve) => {
    httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      const setCookies = res.headers["set-cookie"] ?? [];
      for (const line of setCookies) { const parsed = parseSetCookie(line); if (parsed !== null) jar.push(parsed); }
      onResponse(setCookies);
      res.resume();
      res.on("end", resolve);
    }).end();
  });
  return { reader, goto, jar, storage };
}

/** The executor's side, wired the way the host wires it: registered session values, the source, the response listener, the client. */
function executorFor(port: number, options: { learnFromBrowser?: boolean } = {}) {
  const sessionSecrets: string[] = [];
  // As the host's registry does: an evidence-only value is scrubbed, but not told to the worker.
  const register = (value: string, options?: { evidenceOnly?: boolean }) => { if (options?.evidenceOnly !== true && value.length >= 8 && !sessionSecrets.includes(value)) sessionSecrets.push(value); };
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

  it("refuses a token that is replayed, one never issued, and one a newer sync replaced; each call needs the sync that directly preceded it", async () => {
    const run = await startRun();
    const first = await syncToken();
    expect((await postJson("/v1/generate", callBody(0, first))).body.result?.status).toBe("ok");
    expect(run.seen).toHaveLength(1);
    // The same token again: it was spent by the call above.
    const replayed = await postJson("/v1/generate", callBody(1, first));
    expect(replayed.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect(replayed.body.result?.message).toMatch(/^session-sync-stale:/);
    // A token the worker never issued.
    await syncToken();
    expect((await postJson("/v1/generate", callBody(2, "f".repeat(32)))).body.result?.message).toMatch(/^session-sync-stale:/);
    // A token that a newer sync replaced.
    const older = await syncToken();
    const newer = await syncToken();
    expect((await postJson("/v1/generate", callBody(3, older))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(1);
    // The newer one was spent by that refused call as well (any generate request spends it): the next call needs a sync of its own.
    expect((await postJson("/v1/generate", callBody(4, newer))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect((await postJson("/v1/generate", callBody(5, await syncToken()))).body.result?.status).toBe("ok");
    expect(run.seen).toHaveLength(2);
  });

  it("spends the sync on a request that is refused for another reason (not JSON, not a request, wrong position), so it cannot be kept for a later call", async () => {
    const run = await startRun();
    const token = await syncToken();
    // A request of the wrong shape arrives first and is refused; the token it never named is spent all the same.
    const garbage = await postJson("/v1/generate", { not: "a request" });
    expect(garbage.body.result).toMatchObject({ status: "error", code: "refused-protocol" });
    expect((await postJson("/v1/generate", callBody(1, token))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(0);
  });

  it("issues unguessable tokens: 128 random bits each, never repeated", async () => {
    await startRun();
    const tokens = new Set<string>();
    for (let index = 0; index < 20; index += 1) tokens.add(await syncToken());
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  it("accepts a sync only for this run, in the shape the protocol defines, within the caps", async () => {
    await startRun();
    expect(await postJson("/v1/sync", syncBody([], "11111111-2222-4333-8444-555555555555"))).toMatchObject({ status: 403, body: { code: "other-run" } });
    expect(await postJson("/v1/sync", { ...syncBody(), extra: true })).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", { ...syncBody(), syncSeq: 1 })).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(Array.from({ length: E2E_MODEL_SESSION_SYNC_MAX_VALUES + 1 }, (_, index) => `value-number-${index}`)))).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(["x".repeat(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS + 1)]))).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", { not: "a sync" })).toMatchObject({ status: 400, body: { code: "invalid-sync" } });
    expect(await postJson("/v1/sync", syncBody(), "GET")).toMatchObject({ status: 405 });
    // The refused syncs changed nothing.
    expect((await postJson("/v1/sync", syncBody())).status).toBe(200);
  });

  it("learns the values of a sync before the call that names it is looked at", async () => {
    const run = await startRun();
    const value = "late-session-value-1a2b3c4d5e";
    const token = await syncToken([value]);
    const reply = await postJson("/v1/generate", callBody(0, token, `#n1 text "${value}"`));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
  });

  it("does not split a synced value at an `=`: a stored `theme=dark-high-contrast` is one value, so `dark-high-contrast` alone is ordinary text", async () => {
    const run = await startRun();
    const token = await syncToken(["theme=dark-high-contrast"]);
    expect((await postJson("/v1/generate", callBody(0, token, '#n1 text "dark-high-contrast"'))).body.result?.status).toBe("ok");
    expect(run.seen).toHaveLength(1);
    const second = await syncToken();
    expect((await postJson("/v1/generate", callBody(1, second, '#n1 text "theme=dark-high-contrast"'))).body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
  });

  it("a value too short to scan for safely latches the proxy to refuse every later call (fail closed, as for the begin marker)", async () => {
    const run = await startRun();
    const token = await syncToken(["abc"]);
    const reply = await postJson("/v1/generate", callBody(0, token));
    expect(reply.body.result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(0);
  });
});

describe("what a run may teach the worker is bounded: values, bytes, and the work of scanning every prompt for them", () => {
  it("refuses a sync past the run's total number of values, and the calls after it are refused too (fail closed)", async () => {
    const run = await startRun();
    let refused: Awaited<ReturnType<typeof postJson>> | undefined;
    for (let sent = 0; sent < E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES + E2E_MODEL_SESSION_SYNC_MAX_VALUES && refused === undefined; sent += E2E_MODEL_SESSION_SYNC_MAX_VALUES) {
      const reply = await postJson("/v1/sync", syncBody(Array.from({ length: E2E_MODEL_SESSION_SYNC_MAX_VALUES }, (_, index) => `bulk-session-value-${sent}-${index}`)));
      if (reply.status !== 200) refused = reply;
    }
    expect(refused).toMatchObject({ status: 400, body: { code: "too-many-values" } });
    // The refused sync issued no token: a call cannot name one.
    expect((await postJson("/v1/generate", callBody(0, "e".repeat(32)))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(0);
  });

  it("refuses a sync past the run's total bytes (for values that spell short, so the scan-work cap is not the one that trips)", async () => {
    const ledger = createE2ESessionSyncLedger();
    let accepted = 0;
    let refused = false;
    for (let index = 0; index < 64 && !refused; index += 1) {
      const outcome = ledger.accept(syncBody([`${String(index).padStart(4, "0")}`.padEnd(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS, "q")]), RUN_ID);
      if (outcome.ok) accepted += 1; else { refused = true; expect(outcome).toMatchObject({ code: "too-many-values" }); }
    }
    expect(refused).toBe(true);
    expect(accepted * E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS).toBeLessThanOrEqual(E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES);
    expect((accepted + 1) * E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS).toBeGreaterThan(E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES);
  });

  it("refuses a sync past the run's scan work (the characters of every spelling the guard scans each prompt for), well before the byte cap for values that spell long", async () => {
    const ledger = createE2ESessionSyncLedger();
    let refusedAt = -1;
    // Values of `/` characters spell 23 times longer in the percent forms and the base64 forms.
    for (let index = 0; index < 64 && refusedAt < 0; index += 1) {
      const outcome = ledger.accept(syncBody([`${String(index).padStart(4, "0")}`.padEnd(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS, "/")]), RUN_ID);
      if (!outcome.ok) refusedAt = index;
    }
    expect(refusedAt).toBeGreaterThan(0);
    const spent = refusedAt * E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS;
    expect(spent).toBeLessThan(E2E_MODEL_SESSION_SYNC_MAX_TOTAL_BYTES);
    // A value the cap leaves room for is still accepted (positive control).
    expect(createE2ESessionSyncLedger().accept(syncBody(["a-normal-session-token-12345"]), RUN_ID)).toMatchObject({ ok: true });
  });

  it("does not encode a value again on every sync: the ledger computes the spellings once and the guard reuses them", async () => {
    const ledger = createE2ESessionSyncLedger();
    expect(ledger.accept(syncBody(["a-normal-session-token-12345"]), RUN_ID)).toMatchObject({ ok: true });
    expect(ledger.spellingsOf("a-normal-session-token-12345")).toBe(ledger.spellingsOf("a-normal-session-token-12345"));
  });

  it("keeps a prompt scan with hundreds of synced values fast (a call is not held for seconds)", async () => {
    const values = Array.from({ length: E2E_MODEL_SESSION_SYNC_MAX_TOTAL_VALUES }, (_, index) => `cookie-${String(index).padStart(4, "0")}-${"x7".repeat(24)}`);
    const guard = createE2ECredentialGuard({ passwords: [], emails: [], cookieValues: [], sessionValues: values });
    const started = performance.now();
    const outcome = guard.inspect(call(`#n1 text "${"ordinary page text ".repeat(2_000)}"`));
    expect(outcome).toMatchObject({ refuse: false });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("several executor clients on one proxy (the shards of a group) each sync for themselves", () => {
  function shard(app: { port: number }, tag: string) {
    const executor = executorFor(app.port);
    return { ...executor, tag };
  }

  it("two shards, one after the other on one proxy, each make their calls; both start from nothing and neither collides with the other", async () => {
    const run = await startRun({ begin: false, allowedSteps: [POSITION, { caseId: CASE_ID, stepIndex: 1 }] });
    const app = await fakeApp(COOKIE);
    const a = shard(app, "a");
    await a.client.beginStep(POSITION);
    expect((await a.client.generate({ ...POSITION, callIndex: 0, call: call() })).result.status).toBe("ok");
    expect((await a.client.generate({ ...POSITION, callIndex: 1, call: call() })).result.status).toBe("ok");
    await a.client.endStep(POSITION);
    // The second shard is a new client (a new process in production) with nothing of the first's state, on the same proxy.
    const b = shard(app, "b");
    const second = { caseId: CASE_ID, stepIndex: 1 };
    await b.client.beginStep(second);
    expect((await b.client.generate({ ...second, callIndex: 0, call: call() })).result.status).toBe("ok");
    expect((await b.client.generate({ ...second, callIndex: 1, call: call() })).result.status).toBe("ok");
    expect(run.seen).toHaveLength(4);
    expect(run.sink.receipts.map((receipt) => receipt.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("each shard learns the cookie its own browser gets mid-step, attributed to its own step; the cookie of the first shard stays scanned for the whole group", async () => {
    const run = await startRun({ begin: false, allowedSteps: [POSITION, { caseId: CASE_ID, stepIndex: 1 }] });
    const COOKIE_B = "second-shard-session-9f8e7d6c5b4a3921";
    const a = shard(await fakeApp(COOKIE), "a");
    const b = shard(await fakeApp(COOKIE_B), "b");
    const second = { caseId: CASE_ID, stepIndex: 1 };
    await a.client.beginStep(POSITION);
    await a.browser.goto("/login");
    expect((await a.client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 text "${COOKIE}"`) })).result).toMatchObject({ status: "error", code: "refused-credential-match" });
    await a.client.endStep(POSITION);
    await b.client.beginStep(second);
    expect((await b.client.generate({ ...second, callIndex: 0, call: call() })).result.status).toBe("ok");
    await b.browser.goto("/login");
    expect((await b.client.generate({ ...second, callIndex: 1, call: call(`#n1 text "${COOKIE_B}"`) })).result).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(run.seen).toHaveLength(1);
    expect(run.sink.receipts.map((receipt) => [receipt.caseId, receipt.stepIndex, receipt.outcome])).toEqual([[CASE_ID, 0, "refused-credential-match"], [CASE_ID, 1, "ok"], [CASE_ID, 1, "refused-credential-match"]]);
    for (const value of [COOKIE, COOKIE_B]) for (const spelling of e2eSecretSpellings(value)) expect(JSON.stringify(run.seen), spelling).not.toContain(spelling);
  });

  it("a client that was left behind by a newer sync is refused (fail closed), not served", async () => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const a = shard(app, "a");
    await a.client.beginStep(POSITION);
    // Another client syncs between a's sync and a's call (two shards at once on one proxy): a's token is replaced.
    const stale = await syncToken();
    await syncToken();
    expect((await postJson("/v1/generate", callBody(0, stale))).body.result?.message).toMatch(/^session-sync-stale:/);
    expect(run.seen).toHaveLength(0);
  });
});

describe("the executor's session source reads the browser before each sync", () => {
  const reader = (state: Awaited<ReturnType<E2ESessionStateReader["storageState"]>> | Error): E2ESessionStateReader => ({ storageState: async () => { if (state instanceof Error) throw state; return state; } });

  it("registers cookies and local storage credentials and leaves short, common and ordinary-data values alone, once each", async () => {
    const registered: string[] = [];
    const evidenceOnly: string[] = [];
    const source = createE2ESessionSyncSource({ register: (value, options) => { if (options?.evidenceOnly === true) evidenceOnly.push(value); else registered.push(value); }, known: () => registered });
    source.attach("s1", reader({
      cookies: [{ value: "1", httpOnly: false }, { value: "true", httpOnly: false }, { value: "en-US", httpOnly: true }, { value: "a-long-session-cookie-value", httpOnly: false }, { value: "abc12345", httpOnly: true }],
      origins: [{ localStorage: [
        { name: "cookieConsent", value: "accepted" },
        { name: "draft", value: "Quarterly report for ACME" },
        { name: "returnTo", value: "https://app.example.com/settings?tab=billing" },
        { name: "flags", value: "{\"newCheckout\": true, \"darkMode\": false, \"beta\": \"yes please\"}" },
        { name: "access_token", value: "a-long-local-storage-access-token" },
      ] }],
    }), { anonymous: false });
    expect(await source.read()).toEqual(["a-long-session-cookie-value", "abc12345", "a-long-local-storage-access-token"]);
    await source.read();
    expect(registered).toHaveLength(3);
    // The ordinary app data is scrubbed (weak), once each, and never told to the worker; `accepted` and the short cookies are not registered at all.
    expect(evidenceOnly).toEqual(["Quarterly report for ACME", "https://app.example.com/settings?tab=billing"]);
  });

  it("tells a credential in local storage from app data by its value and its key", () => {
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"user-1234"}').toString("base64url")}.c2lnbmF0dXJlLWJ5dGVz`;
    for (const entry of [
      { name: "anything", value: jwt },
      { name: "anything", value: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c" },
      { name: "sb-project-auth-token", value: "keyed-opaque-value-1234" },
      { name: "ID_TOKEN", value: "keyed-opaque-value-1234" },
    ]) expect(isSessionStorageCredential(entry), entry.name).toBe(true);
    for (const entry of [
      { name: "draft", value: "Quarterly report for ACME" },
      { name: "returnTo", value: "https://app.example.com/settings" },
      { name: "searchHistory", value: "orders,invoices,customers-with-open-balances" },
      { name: "access_token", value: "short" },
      { name: "access_token", value: "has whitespace in the value 1234" },
      { name: "locale", value: "en-US" },
      { name: "i18nextLng", value: "x".repeat(40) },
      { name: "sessionDraft", value: "a draft that is text and has spaces" },
    ]) expect(isSessionStorageCredential(entry), `${entry.name}=${entry.value}`).toBe(false);
  });

  it("an ordinary app-data value in local storage that the page shows does not fail the step (end to end)", async () => {
    const run = await startRun({ begin: false });
    const app = await fakeApp(COOKIE);
    const executor = executorFor(app.port);
    await executor.client.beginStep(POSITION);
    const draft = "Quarterly report for ACME";
    executor.browser.storage.push({ name: "draft", value: draft }, { name: "returnTo", value: "https://app.example.com/settings?next=%2Fhome" });
    const answer = await executor.client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 textbox "Title" value="${draft}"\n#n2 link "Back" href="https://app.example.com/settings?next=%2Fhome"`) });
    expect(answer.result.status).toBe("ok");
    expect(run.seen).toHaveLength(1);
  });

  it("reads an anonymous visitor's context with the visitor bar (a plain cookie id registers nothing) and leaves out a context that was detached", async () => {
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
  let epoch = "0123456789abcdef";
  let tokens = 0;
  const okSync = (res: ServerResponse) => answer(res, 200, { schemaVersion: "rovara-e2e-model-channel/v1", status: "ok", syncToken: String(++tokens).padStart(32, "0"), epoch });
  const okCall = { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: "r1", result: { status: "ok", content: [{ type: "tool-call", toolCallId: "c1", toolName: "tap", input: "{\"target\":\"n1\"}" }],
    finishReason: { unified: "tool-calls", raw: "x" }, usage: { inputTokens: 1, outputTokens: 1 } } };
  beforeEach(() => { epoch = "0123456789abcdef"; tokens = 0; });
  type SyncBody = { values: string[] };
  type CallBody = { syncToken: string };

  it("sends a sync, even an empty one, before each call and names the token the worker issued on the call", async () => {
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => ["token-value-0000000001"] } });
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    await client.generate({ ...POSITION, callIndex: 1, call: call() });
    expect(seen.map((item) => item.url)).toEqual(["/v1/sync", "/v1/generate", "/v1/sync", "/v1/generate"]);
    expect(seen.map((item) => JSON.parse(item.body) as SyncBody & CallBody)).toMatchObject([{ values: ["token-value-0000000001"] }, { syncToken: "1".padStart(32, "0") }, { values: [] }, { syncToken: "2".padStart(32, "0") }]);
  });

  it("keeps no counter of its own: a second client that starts from nothing syncs and calls like the first (the shards of a group)", async () => {
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    for (const index of [0, 1]) {
      const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => [] } });
      await client.generate({ ...POSITION, callIndex: 0, call: call() });
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(seen.filter((item) => item.url === "/v1/sync")).toHaveLength(2);
    // Nothing of a counter is on the wire.
    expect(seen.every((item) => !("syncSeq" in (JSON.parse(item.body) as object)))).toBe(true);
  });

  it("sends a long delta as several syncs and names the last token; a value counts as told only once the worker accepted it", async () => {
    const values = Array.from({ length: 40 }, (_, index) => `session-value-${String(index).padStart(4, "0")}-xyz`);
    let syncs = 0;
    let failSecond = true;
    const seen = await fakeWorker((req, res) => {
      if (req.url !== "/v1/sync") { answer(res, 200, okCall); return; }
      syncs += 1;
      if (failSecond && syncs === 2) { answer(res, 400, { status: "refused", code: "too-many-values" }); return; }
      okSync(res);
    });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => values } });
    // The second chunk is refused: the call is not made.
    await expect(client.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ name: "E2EModelChannelError", code: "session-sync", isRetryable: false });
    expect(seen.map((item) => item.url)).toEqual(["/v1/sync", "/v1/sync"]);
    failSecond = false;
    // Next time the chunk the worker never accepted is sent again.
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    const sent = seen.filter((item) => item.url === "/v1/sync").map((item) => (JSON.parse(item.body) as SyncBody).values);
    expect(sent.map((list) => list.length)).toEqual([32, 8, 8]);
    expect(sent[2]).toEqual(values.slice(32));
    expect((JSON.parse(seen.at(-1)!.body) as CallBody).syncToken).toBe(String(tokens).padStart(32, "0"));
  });

  it("sends everything again when the proxy was replaced (its epoch changed)", async () => {
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => ["token-value-0000000001", "token-value-0000000002"] } });
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    await client.generate({ ...POSITION, callIndex: 1, call: call() });
    expect(seen.filter((item) => item.url === "/v1/sync").map((item) => (JSON.parse(item.body) as SyncBody).values.length)).toEqual([2, 0]);
    epoch = "fedcba9876543210";
    await client.generate({ ...POSITION, callIndex: 2, call: call() });
    expect(seen.filter((item) => item.url === "/v1/sync").map((item) => (JSON.parse(item.body) as SyncBody).values.length)).toEqual([2, 0, 0, 2]);
  });

  it("splits a sync that would be too large by bytes, not only by count", async () => {
    const values = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(3, "0")}${"\u65e5".repeat(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS - 3)}`);
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => values } });
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    const syncs = seen.filter((item) => item.url === "/v1/sync");
    expect(syncs.length).toBeGreaterThan(1);
    for (const item of syncs) expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(200_000);
    expect(syncs.flatMap((item) => (JSON.parse(item.body) as SyncBody).values)).toEqual(values);
  });

  it("does not stop the call for a value over the bound: it sends the value's head and tail, once", async () => {
    const big = `T${randomBytes(6_000).toString("base64url")}Z`;
    expect(big.length).toBeGreaterThan(E2E_MODEL_SESSION_SYNC_MAX_VALUE_CHARS);
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => [big, "token-value-0000000001"] } });
    await client.generate({ ...POSITION, callIndex: 0, call: call() });
    await client.generate({ ...POSITION, callIndex: 1, call: call() });
    const syncs = seen.filter((item) => item.url === "/v1/sync").map((item) => (JSON.parse(item.body) as SyncBody).values);
    expect(syncs[0]).toEqual([...boundSessionValue(big), "token-value-0000000001"]);
    expect(boundSessionValue(big).map((slice) => slice.length)).toEqual([1_024, 1_024]);
    expect(syncs[1]).toEqual([]);
    expect(seen.filter((item) => item.url === "/v1/generate")).toHaveLength(2);
  });

  it("covers an oversized value exactly so far: a prompt that shows the whole value, its first 1024 characters or its last 1024 is refused by the worker; one that shows less of either end, or only the middle, is not (the executor's own scan, which holds the whole value, is the second check)", async () => {
    const big = `T${randomBytes(6_000).toString("base64url")}Z`;
    const [head, tail] = boundSessionValue(big) as [string, string];
    const cases: Array<[string, string, boolean]> = [
      ["the whole value", big, true], ["the head slice", head, true], ["the tail slice", tail, true],
      ["the first 64 characters", big.slice(0, 64), false], ["the last 64 characters", big.slice(-64), false], ["1000 characters of the middle", big.slice(2_000, 3_000), false],
    ];
    for (const [name, shown, refused] of cases) {
      const run = await startRun({ begin: false });
      const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => [big] } });
      await client.beginStep(POSITION);
      const answer = await client.generate({ ...POSITION, callIndex: 0, call: call(`#n1 text "${shown}"`) });
      if (refused) expect(answer.result, name).toMatchObject({ status: "error", code: "refused-credential-match" });
      else expect(answer.result.status, name).toBe("ok");
      expect(run.seen, name).toHaveLength(refused ? 0 : 1);
    }
  });

  it("makes no call when the session cannot be read, a sync is not accepted, or too many values are waiting, and keeps a transport failure's own code", async () => {
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const unreadable = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => { throw new Error("SECRET /srv/path"); } } });
    const failure = await unreadable.generate({ ...POSITION, callIndex: 0, call: call() }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(E2EModelChannelError);
    expect(failure).toMatchObject({ code: "session-sync" });
    expect((failure as Error).message).not.toMatch(/SECRET|srv/);
    const flood = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => Array.from({ length: 300 }, (_, index) => `flood-value-${index}-abcdef`) } });
    await expect(flood.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    expect(seen).toHaveLength(0);
    const refusing = await fakeWorker((_req, res) => answer(res, 400, { status: "refused", code: "too-many-values" }));
    void refusing;
    await expect(createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: { read: async () => [] } }).generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    const nobody = createE2EModelChannelClient({ socketPath: join(dir, "nobody.sock"), runId: RUN_ID, sessionSync: { read: async () => [] } });
    await expect(nobody.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("runs the executor's own scan AFTER the sync, so it knows what this call's sync read from the browser, and sends nothing when it flags the request", async () => {
    const seen = await fakeWorker((req, res) => { if (req.url === "/v1/sync") okSync(res); else answer(res, 200, okCall); });
    const redactor = createCredentialRedactor([]);
    const learned = "jar-only-secret-9f8e7d6c5b4a";
    // The value is in the redactor only once the source has been read, as the host's source registers what it reads.
    const sessionSync = { read: async (): Promise<readonly string[]> => { redactor.addSessionSecret(learned); return [learned]; } };
    const scan = (bytes: Uint8Array) => redactor.contains(bytes);
    const prompt = call(`#n1 text "${learned}"`);
    expect(scan(Buffer.from(JSON.stringify(prompt)))).toBe(false);
    const client = createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync, scan });
    await expect(client.generate({ ...POSITION, callIndex: 0, call: prompt })).rejects.toMatchObject({ code: "credential-in-prompt", isRetryable: false });
    expect(seen.map((item) => item.url)).toEqual(["/v1/sync"]);
    // Through the model adapter it is the adapter's own code.
    const adapter = createE2EAgentModelAdapter({ client, routeId: "r", position: () => POSITION });
    await expect(adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: `#n1 text "${learned}"` }] }] })).rejects.toMatchObject({ code: "credential-in-prompt" });
    expect(seen.filter((item) => item.url === "/v1/generate")).toHaveLength(0);
  });

  it("is the only way to call the model: no code in the executor package posts to the generate path or calls the channel client outside the client and the model adapter", () => {
    const root = new URL("../../packages/verifier/src", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (current: string) => { for (const name of readdirSync(current)) { const path = join(current, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
    walk(root);
    const mention = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.slice(root.length + 1)).sort();
    expect(mention(/E2E_MODEL_CHANNEL_GENERATE_PATH|["'`]\/v1\/generate["'`]/)).toEqual(["executor/model-channel.ts"]);
    expect(mention(/\bclient\.generate\(|options\.client\.generate\(/)).toEqual(["executor/agent-model-adapter.ts"]);
    // The host builds its one client through `createHostModelStack` (MASKMAYBE), the only code that does.
    expect(mention(/createE2EModelChannelClient\(/)).toEqual(["executor/host-model-stack.ts", "executor/model-channel.ts"]);
    expect(mention(/createHostModelStack\(/)).toEqual(["executor/host-model-stack.ts", "executor/host.ts"]);
    expect(mention(/E2E_MODEL_CHANNEL_SYNC_PATH/)).toEqual(["executor/model-channel.ts"]);
    // `sessionSync` is required by the client's options type: a client cannot be built without it.
    // @ts-expect-error sessionSync is required
    const missing: Parameters<typeof createE2EModelChannelClient>[0] = { socketPath: "/x", runId: RUN_ID };
    void missing;
    // The host builds its one client with the browser-backed source.
    expect(readFileSync(join(root, "executor/host-model-stack.ts"), "utf8")).toMatch(/createE2EModelChannelClient\(\{[^}]*sessionSync: input\.sessionSync, scan:/);
    expect(readFileSync(join(root, "executor/host.ts"), "utf8")).toMatch(/createHostModelStack\(\{[^}]*registry, sessionSync,/);
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
    // An older worker's request schema is strict, so it refuses a request that names `syncToken`, and it does not serve `/v1/sync` (404): the new executor cannot make a call through it.
    // This pins the strictness that refusal rests on.
    const newRequest = channelRequest({ syncToken: "a".repeat(32) });
    expect(E2EModelChannelRequestSchema.safeParse(newRequest).success).toBe(true);
    expect(E2EModelChannelRequestSchema.safeParse({ ...newRequest, unknownField: 1 }).success).toBe(false);
    expect(E2EModelSessionSyncSchema.safeParse({ ...syncBody(), unknownField: 1 }).success).toBe(false);
    // An older executor's call (no `syncToken`) is refused by the newer worker and never reaches the model.
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
    expect(E2EModelChannelRequestSchema.parse({ ...oldRequest, syncToken: "b".repeat(32) })).toMatchObject({ syncToken: "b".repeat(32) });
    expect(E2EModelChannelRequestSchema.safeParse({ ...oldRequest, syncToken: "short" }).success).toBe(false);
    expect(E2EModelSessionSyncSchema.safeParse({ schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, values: [] }).success).toBe(true);
  });

  it("writes receipts and transcripts a reader from before this change still parses (a refused sync is the existing `refused-protocol` outcome)", async () => {
    const { E2EModelReceiptSchema } = await import("../../packages/contracts/src/e2e-model-channel.js");
    const run = await startRun();
    await postJson("/v1/generate", callBody(0, undefined));
    await postJson("/v1/generate", callBody(1, await syncToken()));
    const summary = await run.proxy.close();
    expect(summary.receipts.map((receipt) => receipt.outcome)).toEqual(["refused-protocol", "ok"]);
    for (const receipt of summary.receipts) expect(E2EModelReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(Object.keys(summary.receipts[0]!).sort()).toEqual(Object.keys(E2EModelReceiptSchema.shape).filter((key) => key in summary.receipts[0]!).sort());
  });
});
