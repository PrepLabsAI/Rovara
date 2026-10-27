import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2E_EXECUTOR_COMPILED_ORIGIN, readE2EApplicationProjectContract } from "@agentx/contracts";
import { createExecutorSessionStore } from "../../packages/verifier/src/executor/accounts.js";
import { readBrowserState, type BrowserContextLike, type BrowserFrameLike } from "../../packages/verifier/src/executor/browser-state-reader.js";
import { BROWSER_STATE_IDB_MAX_RECORDS, BROWSER_STATE_MEMO_MAX, tellBrowserState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { E2E_SESSION_SYNC_MAX_WEAK_VALUES, createE2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { REQUEST_HEADER_WAIT_MS, watchBrowserRequests } from "../../packages/verifier/src/executor/request-capture.js";
import { createSessionSecretRegistry } from "../../packages/verifier/src/executor/session-secret-registry.js";
import type { FormLoginDriver, FormLoginStorageState, FormRequestContext } from "../../packages/verifier/src/executor/form-login.js";
import { createAccountsExecutorPlan } from "../support/e2e-accounts-fixture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { CASE_ID, call } from "../support/e2e-model-fixtures.js";
import { createMidstep2Harness } from "../support/e2e-midstep2-harness.js";
import type { ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";

// MIDSTEP-2, end to end through the real pieces: the real classifier, source, registry and redactor, the real channel client, the real worker proxy. Only the browser is a stand-in here
// (the real Chromium is in e2e-midstep2-real-browser.test.ts).

const POSITION = { caseId: CASE_ID, stepIndex: 0 };
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"user-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const OPAQUE = "Zk3pQ9xW2mV7cL4nR8tY1bH6jD5sA0gF";
const TOKEN = "tok_live_9f8e7d6c5b4a3928";
const SLUG = "/projects/alpha/settings/notifications2";

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "m2-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

const harness = createMidstep2Harness({ dir: () => dir, closers });
const executor = harness.executor;
type Executor = Awaited<ReturnType<typeof executor>>;

/**
 * What the worker answers to a prompt that shows `secret`, in a step of its own. A refusal latches the step (every later call of it is refused too), so a second secret checked in the same
 * step would prove nothing: each gets a fresh step, after a call that shows nothing secret and must pass (so the sync ran and the refusal is the secret's).
 */
async function refusedAlone(secret: string, prepare: (e: Executor) => void | Promise<void>): Promise<{ status: string; code?: string }> {
  const e = await executor();
  await prepare(e);
  expect((await e.workerSays("Nothing secret here")).status).toBe("ok");
  return e.workerSays(`Shown: ${secret}`);
}
const REFUSED = { status: "error", code: "refused-credential-match" };

describe("gap 1: JSON leaves", () => {
  it.each([
    ["compact JSON", (token: string) => `{"user":"maya","token":"${token}","draft":"Quarterly report for ACME"}`],
    ["pretty-printed JSON", (token: string) => JSON.stringify({ user: "maya", token, draft: "Quarterly report for ACME" }, null, 2)],
    ["JSON inside JSON (redux-persist)", (token: string) => JSON.stringify({ _persist: "{\"version\":1}", auth: JSON.stringify({ session: { token } }) })],
  ])("%s: a token inside it is refused if a prompt shows it, at the worker and at the executor; the draft beside it is not", async (_name, build) => {
    const e = await executor();
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "persist:root", value: build(TOKEN) }] }] };
    // Positive control: the page shows nothing secret, the call reaches the model (so the sync path ran and a refusal below is the token's).
    expect((await e.workerSays("Orders for maya")).status).toBe("ok");
    expect(e.run.seen).toHaveLength(1);
    expect((await e.workerSays(`Draft: Quarterly report for ACME`)).status).toBe("ok");
    expect(await e.workerSays(`Your key is ${TOKEN}`)).toMatchObject({ status: "error", code: "refused-credential-match" });
    expect(await e.executorSays(`Your key is ${TOKEN}`)).toBe("credential-in-prompt");
    expect(e.run.seen).toHaveLength(2);
    expect(e.registry.sessionSecrets).toContain(TOKEN);
    expect(e.registry.sessionSecrets).not.toContain("Quarterly report for ACME");
  });
});

describe("gap 2: tiers", () => {
  it("a long URL path or slug with a digit under a neutral key is scrubbed from evidence but a page that shows it is NOT refused; an opaque run under the same key is refused", async () => {
    const e = await executor();
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "lastVisited", value: SLUG }, { name: "lastSeen", value: OPAQUE }, { name: "password", value: "hunter2222" }] }] };
    expect((await e.workerSays(`Breadcrumb ${SLUG}`)).status).toBe("ok");
    expect(await e.executorSays(`Breadcrumb ${SLUG}`)).toBe("ok");
    expect(e.registry.sessionSecrets).not.toContain(SLUG);
    // Weak: scrubbed from text and refused in evidence (the "all" scope), as before.
    expect(e.redactor.text(`saw ${SLUG}`)).toBe("saw <session>");
    expect(e.redactor.contains(Buffer.from(SLUG), "all")).toBe(true);
    expect(e.redactor.contains(Buffer.from(SLUG), "model")).toBe(false);
    const prepare = (fresh: Executor) => { fresh.state.current = e.state.current; };
    expect(await refusedAlone(OPAQUE, prepare)).toMatchObject(REFUSED);
    expect(await refusedAlone("hunter2222", prepare)).toMatchObject(REFUSED);
  });

  it("a weak value that later turns out to be a credential (the same text under a key that says so) becomes one", async () => {
    const e = await executor();
    const value = "Paris-Berlin-Madrid-itinerary-2026";
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "trip", value }] }] };
    expect((await e.workerSays(`Trip ${value}`)).status).toBe("ok");
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "auth_token", value }] }] };
    expect(await e.workerSays(`Trip ${value}`)).toMatchObject({ status: "error", code: "refused-credential-match" });
  });
});

/** A stand-in for the Playwright pieces the capture and the reader use. */
class FakeContext extends EventEmitter implements BrowserContextLike {
  frames: Array<BrowserFrameLike> = [];
  stored: Awaited<ReturnType<BrowserContextLike["storageState"]>> = { cookies: [], origins: [] };
  pageList: Array<EventEmitter & { frames: () => unknown[] }> = [];
  async storageState() { return this.stored; }
  pages() { return this.pageList.map((page) => ({ frames: () => page.frames() as never, mainFrame: () => (page.frames() as BrowserFrameLike[])[0]! })); }
  addPage(frames: FakeContext["frames"]): EventEmitter { const page = Object.assign(new EventEmitter(), { frames: () => frames }); this.pageList.push(page); this.emit("page", page); return page; }
}
const request = (url: string, headers: Record<string, string>, later: Array<{ name: string; value: string }> = [], delayMs = 20) => ({
  url: () => url, headers: () => headers,
  headersArray: () => new Promise<Array<{ name: string; value: string }>>((resolve) => setTimeout(() => resolve([...Object.entries(headers).map(([name, value]) => ({ name, value })), ...later]), delayMs)),
});

describe("gaps 3 and 4: URL tokens and request headers (the real capture on a stand-in context)", () => {
  it("registers the Authorization value, a Cookie and an API key header, and a token in the query of a request, before the next model call", async () => {
    const context = new FakeContext();
    const learned: ClassifiedValue[] = [];
    const pending: Array<Promise<unknown>> = [];
    watchBrowserRequests(context as never, { learn: (items) => learned.push(...items), track: (read) => pending.push(read) });
    const apiKey = "key-abcdef0123456789";
    const sid = "0123456789abcdef0123456789";
    const basic = Buffer.from("maya:hunter2222").toString("base64");
    // The app calls its API; the browser's own headers (the cookie) arrive a little later than the request event.
    context.emit("request", request(`${E2E_EXECUTOR_COMPILED_ORIGIN}/api/orders?id_token=${JWT}`, { authorization: `Bearer ${OPAQUE}`, "x-api-key": apiKey }, [{ name: "Cookie", value: `theme=dark; sid=${sid}` }]));
    context.emit("request", request(`${E2E_EXECUTOR_COMPILED_ORIGIN}/api/me`, { authorization: `Basic ${basic}` }));
    await Promise.all(pending);
    for (const secret of [JWT, OPAQUE, apiKey, sid, basic]) expect(await refusedAlone(secret, (e) => { e.source.learn(learned); }), secret).toMatchObject(REFUSED);
  });

  it("the source waits for a header read that is still running before it reads the browser (the cookie arrives after the request event)", async () => {
    const e = await executor();
    const context = new FakeContext();
    watchBrowserRequests(context as never, { learn: (items) => e.source.learn(items), track: (pending) => e.source.track(pending) });
    const sid = "0123456789abcdef0123456789";
    context.emit("request", request(`${E2E_EXECUTOR_COMPILED_ORIGIN}/api/orders`, {}, [{ name: "Cookie", value: `sid=${sid}` }], 150));
    expect((await e.workerSays("Nothing secret here")).status).toBe("ok");
    expect(await e.workerSays(`Shown: ${sid}`)).toMatchObject(REFUSED);
  });

  it("the headers the page set are read at once: a header read that fails, or never finishes, does not lose the Authorization value", async () => {
    const e = await executor();
    const context = new FakeContext();
    watchBrowserRequests(context as never, { learn: (items) => e.source.learn(items), track: (pending) => e.source.track(pending) });
    context.emit("request", { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/api/a`, headers: () => ({ authorization: `Bearer ${OPAQUE}` }), headersArray: () => Promise.reject(new Error("request is gone")) });
    expect(await e.workerSays(`Shown: ${OPAQUE}`)).toMatchObject({ status: "error", code: "refused-credential-match" });
  });

  it("registers the fragment of a page URL (which no request carries) from the navigation event, and from the frame URLs the sync reads", async () => {
    const e = await executor();
    const context = new FakeContext();
    watchBrowserRequests(context as never, { learn: (items) => e.source.learn(items), track: (pending) => e.source.track(pending) });
    const page = context.addPage([]);
    page.emit("framenavigated", { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/cb#access_token=${JWT}&token_type=bearer` });
    expect(await e.workerSays(`URL ${JWT}`)).toMatchObject({ status: "error", code: "refused-credential-match" });
    // Read at sync time from the frames' current URLs, when no event was seen.
    const e2 = await executor();
    const second = new FakeContext();
    second.addPage([{ url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/cb?session_id=${OPAQUE}`, evaluate: async () => ({ over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries: [] }) }]);
    e2.source.attach("s2", { storageState: () => readBrowserState(second) }, { anonymous: false });
    expect(await e2.workerSays(`URL ${OPAQUE}`)).toMatchObject({ status: "error", code: "refused-credential-match" });
  });

  it("settle() waits for the header reads started so far (the sign-in capture awaits it before it reads the browser), and the driver does", async () => {
    const context = new FakeContext();
    const learned: string[] = [];
    const watcher = watchBrowserRequests(context as never, { learn: (items) => { for (const item of items) learned.push(item.value); }, track: () => undefined });
    context.emit("request", request(`${E2E_EXECUTOR_COMPILED_ORIGIN}/api/a`, {}, [{ name: "X-Auth-Token", value: OPAQUE }], 150));
    expect(learned).toEqual([]);
    await watcher.settle();
    expect(learned).toContain(OPAQUE);
    const driver = readFileSync(new URL("../../packages/verifier/src/executor/form-login.ts", import.meta.url), "utf8");
    expect(driver.indexOf("await watcher?.settle()")).toBeGreaterThan(0);
    expect(driver.indexOf("await watcher?.settle()")).toBeLessThan(driver.indexOf("await readBrowserState(context)"));
  });

  it("an OAuth code in the URL is scrubbed from evidence and does not refuse the page that shows it; a header read that never finishes delays the call by the bound only", async () => {
    const e = await executor();
    const context = new FakeContext();
    watchBrowserRequests(context as never, { learn: (items) => e.source.learn(items), track: (pending) => e.source.track(pending) });
    context.emit("request", { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/cb?code=4%2F0AbCdEf123456&state=xyz12345678`, headers: () => ({}), headersArray: () => new Promise<never>(() => undefined) });
    const started = Date.now();
    expect((await e.workerSays("Welcome back 4/0AbCdEf123456")).status).toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(REQUEST_HEADER_WAIT_MS - 100);
    expect(Date.now() - started).toBeLessThan(REQUEST_HEADER_WAIT_MS + 4_000);
    expect(e.redactor.text("code 4/0AbCdEf123456")).toBe("code <session>");
  });
});

describe("gap 5: session storage and IndexedDB, through the real reader", () => {
  const sessionFrame = (entries: Array<{ name: string; value: string }>, url = `${E2E_EXECUTOR_COMPILED_ORIGIN}/`) => ({ url: () => url,
    evaluate: async () => ({ over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries }) });
  const idb = (value: Record<string, unknown>) => [{ name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", autoIncrement: false, indexes: [], records: [
    { valueEncoded: { o: [{ k: "fbase_key", v: "firebase:authUser:KEY" }, { k: "value", v: { o: Object.entries(value).map(([k, v]) => ({ k, v })), id: 2 } }], id: 1 } }] }] }];

  it("a token in session storage (MSAL's default) and one in IndexedDB (Firebase's default) are refused if a prompt shows them; the draft beside them is not", async () => {
    const prepare = (e: Executor) => {
      const context = new FakeContext();
      context.stored = { cookies: [], origins: [{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, localStorage: [], indexedDB: idb({ accessToken: OPAQUE, displayName: "Maya Q Draft Report" }) }] };
      context.addPage([sessionFrame([{ name: "msal.idtoken", value: JWT }, { name: "draftTitle", value: "Quarterly report for ACME" }])]);
      e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    };
    expect(await refusedAlone(JWT, prepare)).toMatchObject(REFUSED);
    expect(await refusedAlone(OPAQUE, prepare)).toMatchObject(REFUSED);
    const e = await executor();
    prepare(e);
    expect((await e.workerSays("Quarterly report for ACME by Maya Q Draft Report")).status).toBe("ok");
  });

  it("an IndexedDB value is read in the driver's encoded form: a short token under a key that names it, and a record key, are told", async () => {
    const context = new FakeContext();
    context.stored = { cookies: [], origins: [{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, localStorage: [], indexedDB: [{ name: "db", stores: [{ name: "s", records: [
      { keyEncoded: OPAQUE, valueEncoded: { o: [{ k: "refreshToken", v: "rt-0123456789" }], id: 1 } }] }] }] }] };
    const prepare = (fresh: Executor) => { fresh.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false }); };
    expect(await refusedAlone("rt-0123456789", prepare)).toMatchObject(REFUSED);
    expect(await refusedAlone(OPAQUE, prepare)).toMatchObject(REFUSED);
  });

  it("the source classifies a storage entry once, not on every model call (the whole browser is read before each one)", async () => {
    const e = await executor();
    let reads = 0;
    const entry = { name: "persist:root", get value() { reads += 1; return `{"user":"maya","token":"${TOKEN}"}`; } };
    const context = new FakeContext();
    context.stored = { cookies: [], origins: [{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, localStorage: [entry] }] };
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    await e.source.read();
    const afterFirst = reads;
    await e.source.read();
    expect(afterFirst).toBeGreaterThan(1);
    expect(reads - afterFirst).toBe(1);
  });

  it("IndexedDB over the record bound fails closed: the sync is not made and no model call goes out", async () => {
    const e = await executor();
    const context = new FakeContext();
    const records = Array.from({ length: BROWSER_STATE_IDB_MAX_RECORDS + 1 }, (_unused, index) => ({ valueEncoded: `record-${index}` }));
    context.stored = { cookies: [], origins: [{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, localStorage: [], indexedDB: [{ name: "cache", stores: [{ name: "items", records }] }] }] };
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    await expect(e.workerOnly.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    expect(e.run.seen).toHaveLength(0);
  });

  it("a frame that cannot be read and never held state (a sandboxed or still-loading iframe) is skipped; one that held state and can no longer be read fails closed; a blank or data frame is not asked", async () => {
    const e = await executor();
    const context = new FakeContext();
    let asked = 0;
    context.addPage([{ url: () => "about:blank", evaluate: async () => { asked += 1; throw new Error("no"); } }, { url: () => "data:text/html,x", evaluate: async () => { asked += 1; throw new Error("no"); } }]);
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    expect((await e.workerSays("fine")).status).toBe("ok");
    expect(asked).toBe(0);
    // A navigating child iframe that never answers: skipped (it is given a bounded settle and asked again, three times); the main frame, read first, still gives its storage.
    let settled = 0;
    context.addPage([sessionFrame([{ name: "msal.idtoken", value: JWT }]), { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/preview`, evaluate: async () => { asked += 1; throw new Error("Execution context was destroyed"); },
      waitForLoadState: async () => { settled += 1; } }]);
    expect((await e.workerSays("still fine")).status).toBe("ok");
    expect(asked).toBe(3);
    expect(settled).toBe(2);
    expect(await e.workerSays(`id ${JWT}`)).toMatchObject(REFUSED);
    // A frame that held state and then cannot be read is a real loss: fail closed.
    const e2 = await executor();
    const second = new FakeContext();
    let fail = false;
    second.addPage([{ url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/`, evaluate: async () => { if (fail) throw new Error("Execution context was destroyed"); return { over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries: [{ name: "msal.idtoken", value: JWT }] }; } }]);
    e2.source.attach("s2", { storageState: () => readBrowserState(second) }, { anonymous: false });
    expect((await e2.workerSays("fine")).status).toBe("ok");
    fail = true;
    await expect(e2.workerOnly.generate({ ...POSITION, callIndex: 5, call: call() })).rejects.toMatchObject({ code: "session-sync" });
    expect(e2.run.seen).toHaveLength(1);
  });

  it("session storage over its bound in the page fails closed", async () => {
    const e = await executor();
    const context = new FakeContext();
    context.addPage([{ url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/`, evaluate: async () => ({ over: true, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries: [] }) }]);
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    await expect(e.workerOnly.generate({ ...POSITION, callIndex: 0, call: call() })).rejects.toMatchObject({ code: "session-sync" });
  });
});

describe("gap 6: the executor's own scan knows the hex and double-percent spellings the worker knows", () => {
  const COOKIE = "s3ss\"on\\id/AB12+Z9x8y7w6v5u4>>??~~";
  const spelled: ReadonlyArray<readonly [string, (value: string) => string]> = [
    ["hex", (value) => Buffer.from(value, "utf8").toString("hex")],
    ["upper-case hex", (value) => Buffer.from(value, "utf8").toString("hex").toUpperCase()],
    ["double percent-encoded", (value) => encodeURIComponent(encodeURIComponent(value))],
  ];
  it.each(spelled)("a session secret shown as %s is refused by the executor's model scan, with the worker out of the loop", (_name, encode) => {
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    registry.register(COOKIE);
    expect(registry.modelScan(Buffer.from(JSON.stringify(call(`#n1 text "${encode(COOKIE)}"`)), "utf8"))).toBe(true);
    expect(redactor.text(`x ${encode(COOKIE)} y`)).toBe("x <session> y");
  });

  it.each(spelled)("an account password shown as %s is found by the executor's scan", (_name, encode) => {
    const account = createAccountsExecutorPlan().plan.accounts[0]!;
    const redactor = createCredentialRedactor([account]);
    expect(redactor.contains(Buffer.from(`pw: ${encode(account.password)}`), "accounts")).toBe(true);
  });
});

describe("sign-in capture reads the same things", () => {
  const fixture = createAccountsExecutorPlan();
  const applicationId = fixture.compiled.originByApplicationId[0]!.applicationId;
  const contract = readE2EApplicationProjectContract(fixture.compiled.runtimeAdmissionContext.selectionInput.sourceSnapshot, applicationId)!;
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const signal = new AbortController().signal;

  it("tells the register the session storage, the IndexedDB, the URL parameters and the request headers of the sign-in, strong and weak apart", async () => {
    const told: Array<{ value: string; evidenceOnly: boolean }> = [];
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    const bearer = `Zq${randomBytes(18).toString("base64url")}9`;
    const driver: FormLoginDriver = {
      async signIn(input) {
        const account = fixture.plan.accounts.find((item) => item.email === input.email && item.password === input.password)!;
        // The sign-in's requests, as the real driver reports them while the page runs.
        input.observe?.([{ value: bearer, tier: "strong" }]);
        const state: FormLoginStorageState = { cookies: [{ name: "sid", value: `tok-${sha(account.profileId).slice(0, 24)}`, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }],
          origins: [{ origin: input.origin, localStorage: [{ name: "persist:root", value: `{"user":"maya","token":"${TOKEN}"}` }], sessionStorage: [{ name: "msal.idtoken", value: JWT }, { name: "lastVisited", value: SLUG }],
            indexedDB: [{ name: "db", stores: [{ name: "s", records: [{ valueEncoded: { o: [{ k: "refreshToken", v: OPAQUE }] } }] }] }] }],
          urls: [`${input.origin}/home#access_token=${"Ab1".repeat(8)}`] };
        return { state, status: 200 };
      },
      async requestContext(): Promise<FormRequestContext> {
        return { async request({ path }) {
          const profile = contract.accountProfiles.find((item) => item.roleRef === "owner") ?? contract.accountProfiles[0]!;
          const body = new TextEncoder().encode(JSON.stringify(path === "/api/me" ? { subjectId: "s-1", tenantId: profile.tenantRef, role: profile.roleRef } : {}));
          return { status: 200, body, contentType: "application/json", setCookies: [] as string[] };
        }, async dispose() { /* nothing */ } };
      },
    };
    const store = createExecutorSessionStore({ plan: fixture.plan, formLogin: driver, registerSecret: (value, options) => { told.push({ value, evidenceOnly: options?.evidenceOnly === true }); registry.register(value, options); } });
    const profileId = contract.accountProfiles.find((item) => item.roleRef === "owner")?.profileId ?? contract.accountProfiles[0]!.profileId;
    const ref = { applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) };
    await store.open({ binding: {}, applicationId, profileId, approvedAccountRef: ref, origin: E2E_EXECUTOR_COMPILED_ORIGIN }, signal);
    const worker = told.filter((item) => !item.evidenceOnly).map((item) => item.value);
    for (const secret of [TOKEN, JWT, OPAQUE, bearer, "Ab1".repeat(8)]) expect(worker, secret).toContain(secret);
    expect(worker).not.toContain(SLUG);
    expect(told.filter((item) => item.evidenceOnly).map((item) => item.value)).toContain(SLUG);
    expect(registry.modelScan(Buffer.from(SLUG))).toBe(false);
    expect(registry.modelScan(Buffer.from(TOKEN))).toBe(true);
  });
});

describe("the host wires the new reads (static: the host is not started in unit tests; the behaviour is in e2e-midstep2-round2fix.test.ts)", () => {
  it("hands every case context, a signed-out visitor's too, to the wiring (attach, request watch, Set-Cookie) and reads it at case close through it", () => {
    const host = readFileSync(new URL("../../packages/verifier/src/executor/host.ts", import.meta.url), "utf8");
    expect(host).toMatch(/wireCaseContext\(\{ browserContext, sessionRef, isAnonymous: store\.isAnonymous, sessionSync, registerSecret \}\)/);
    expect(host).toMatch(/readCaseContextAtClose\(\{ browserContext: owned, sessionRef, isAnonymous: store\.isAnonymous, sessionSync \}\)/);
    // The calls are statements of their own: nothing decides in the host whether a context (a visitor's or any) is wired or read (the behaviour is in e2e-midstep2-lastround.test.ts).
    for (const line of host.split("\n").filter((item) => item.includes("wireCaseContext(") || item.includes("readCaseContextAtClose("))) expect(line.trim().startsWith("wireCaseContext(") || line.trim().startsWith("await readCaseContextAtClose("), line).toBe(true);
    expect(host).not.toMatch(/if \(anonymous\) return;/);
  });
});

describe("fix round 1 (review of 334c7ced)", () => {
  const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const bytesOf = (text: string) => Buffer.from(text, "utf8");

  it("B-1: an app with a persisted cache of ids and paths in IndexedDB: a trace that shows the path passes every scan, and a run built on it has nothing to remove at the final output scan", async () => {
    const e = await executor();
    const context = new FakeContext();
    const records = Array.from({ length: 300 }, (_unused, index) => ({ valueEncoded: { o: [{ k: "id", v: `${UUID.slice(0, 30)}${String(index).padStart(6, "0")}` }, { k: "href", v: `/orders/${UUID}` }, { k: "createdAt", v: "2026-10-27T12:00:00.000Z" }] } }));
    context.stored = { cookies: [], origins: [{ origin: E2E_EXECUTOR_COMPILED_ORIGIN, localStorage: [{ name: "cache", value: JSON.stringify({ lastPage: `${E2E_EXECUTOR_COMPILED_ORIGIN}/orders/${UUID}`, owner: "someone@example.com" }) }], indexedDB: [{ name: "db", stores: [{ name: "orders", records }] }] }] };
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    expect((await e.workerSays(`Order page /orders/${UUID} for someone@example.com`)).status).toBe("ok");
    const trace = bytesOf(JSON.stringify({ url: `${E2E_EXECUTOR_COMPILED_ORIGIN}/orders/${UUID}`, text: "Order for someone@example.com" }));
    expect(e.registry.modelScan(trace)).toBe(false);
    expect(e.registry.evidenceScan(trace)).toBe(false);
    expect(e.redactor.contains(trace)).toBe(false);
    expect(e.redactor.text(`/orders/${UUID}`)).toBe(`/orders/${UUID}`);
  });

  it("B-1: what the executor writes is held to the final scan: an evidence-only value is allowed in a model prompt but a trace showing it is dropped", () => {
    const redactor = createCredentialRedactor([]);
    const registry = createSessionSecretRegistry({ redactor });
    registry.register("Quarterly report for ACME", { evidenceOnly: true });
    const shown = bytesOf('{"text":"Quarterly report for ACME"}');
    expect(registry.modelScan(shown)).toBe(false);
    expect(registry.evidenceScan(shown)).toBe(true);
    expect(redactor.contains(shown)).toBe(registry.evidenceScan(shown));
  });

  it("I-1: a sandboxed iframe does not refuse model calls (real reader, the page expression answers an opaque origin with no entries)", async () => {
    const e = await executor();
    const context = new FakeContext();
    // What the in-page expression returns inside `<iframe sandbox="allow-scripts">`: no throw, no entries.
    context.addPage([{ url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/preview`, evaluate: async () => ({ over: false, origin: "null", entries: [] }) }, sessionFrameOf([{ name: "msal.idtoken", value: JWT }])]);
    e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
    expect((await e.workerSays("Preview shown")).status).toBe("ok");
    expect(await e.workerSays(`id ${JWT}`)).toMatchObject(REFUSED);
  });

  it("I-2: registering thousands of values is close to linear, and evidence registrations stop at the cap (the rest go to the model's mask)", { timeout: 30_000 }, () => {
    const redactor = createCredentialRedactor([]);
    const started = Date.now();
    for (let index = 0; index < 12_000; index += 1) redactor.addSessionSecret(`opaque-session-value-${String(index).padStart(6, "0")}-abcdef`, { evidenceOnly: true });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(redactor.contains(bytesOf("opaque-session-value-011999-abcdef"), "all")).toBe(true);
    expect(redactor.text("x opaque-session-value-000001-abcdef y")).toBe("x <session> y");
    const told: string[] = [];
    const masked: string[] = [];
    const source = createE2ESessionSyncSource({ register: (value, options) => { (options?.maskOnly === true ? masked : told).push(value); }, known: () => [] });
    source.learn(Array.from({ length: E2E_SESSION_SYNC_MAX_WEAK_VALUES + 500 }, (_unused, index) => ({ value: `weak-value-${String(index).padStart(6, "0")}-abcdef`, tier: "weak" as const })));
    // The evidence scrub stops at the cap; the values after it are held for the model's mask (never dropped: MASKMAYBE F-2).
    expect(told).toHaveLength(E2E_SESSION_SYNC_MAX_WEAK_VALUES);
    expect(masked).toHaveLength(500);
    // A strong value is never held back by the cap.
    source.learn([{ value: "strong-value-abcdef0123456789", tier: "strong" }]);
    expect(told).toHaveLength(E2E_SESSION_SYNC_MAX_WEAK_VALUES + 1);
  });

  it("I-4: a token stored with JSON.stringify is refused bare, at the worker and at the executor's scan", async () => {
    const e = await executor();
    e.state.current = { cookies: [], origins: [{ localStorage: [{ name: "accessToken", value: JSON.stringify(JWT) }] }] };
    expect((await e.workerSays("Nothing secret here")).status).toBe("ok");
    expect(await e.workerSays(`token ${JWT}`)).toMatchObject(REFUSED);
    expect(await e.executorSays(`token ${JWT}`)).toBe("credential-in-prompt");
  });

  it("M-1: a value whose registration failed is not remembered as registered; the next read tries again", async () => {
    let fail = true;
    const told: string[] = [];
    const source = createE2ESessionSyncSource({ register: (value) => { if (fail) throw new Error("disk full"); told.push(value); }, known: () => told });
    source.attach("s1", { storageState: async () => ({ cookies: [], origins: [{ localStorage: [{ name: "accessToken", value: JWT }] }] }) }, { anonymous: false });
    await expect(source.read()).rejects.toThrow();
    fail = false;
    await source.read();
    expect(told).toEqual([JWT]);
  });

  it("M-5: the classified-entry memo is bounded", () => {
    const memo = new Set<string>();
    const entries = Array.from({ length: BROWSER_STATE_MEMO_MAX + 10 }, (_unused, index) => ({ name: `k${index}`, value: `v${index}` }));
    tellBrowserState({ cookies: [], origins: [{ localStorage: entries }] }, () => undefined, memo);
    expect(memo.size).toBeLessThanOrEqual(BROWSER_STATE_MEMO_MAX);
  });
});

function sessionFrameOf(entries: Array<{ name: string; value: string }>) {
  return { url: () => `${E2E_EXECUTOR_COMPILED_ORIGIN}/`, evaluate: async () => ({ over: false, origin: E2E_EXECUTOR_COMPILED_ORIGIN, entries }) };
}
