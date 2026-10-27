import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tellBrowserState, type BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { classifyString, isTokenShape, type ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { MASK_BUCKET_CAP, createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { headerSecrets, oversizedTokens, urlSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { createSessionSecretRegistry } from "../../packages/verifier/src/executor/session-secret-registry.js";
import { readCaseContextAtClose, wireCaseContext } from "../../packages/verifier/src/executor/session-context-wiring.js";
import type { E2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { analyticsCookieName, cookieTier } from "../../packages/verifier/src/executor/visitor-cookie.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";

// MIDSTEP-2, last scoped round (task-midstep2-finalfix-recheck2.md): analytics cookies and dotted words are not credentials, the wiring is tested for a signed-in context too, a JWT in an oversized URL value
// is found, and the mask has a hard time and size bound.

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "lr-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

describe("analytics and anti-bot cookies are not credentials", () => {
  const OPAQUE = "oeu1698765432123r0.1234567890123";
  const COOKIES: Array<[string, string]> = [["optimizelyEndUserId", OPAQUE], ["_hjSessionUser_123456", "eyJpZCI6ImFiY2RlZmdoLWlqa2wiLCJjcmVhdGVkIjoxNjk4NzY1NDMyfQ=="], ["_hjSession_123456", "eyJpZCI6ImFiY2RlZiIsImMiOjE2OTg3NjU0MzJ9"],
    ["_uetsid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["_uetvid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["hubspotutk", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"], ["__hstc", "123456789.a1b2c3d4e5f6a7b8.1698765432.1698765432.1"],
    ["_clck", "1abcdef|2|fgh|0|1234"], ["_clsk", "abcdef1234567890|1698765432123|1|0|x.clarity.ms/collect"], ["__stripe_mid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301abcdef"], ["__stripe_sid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301abcdef"],
    ["__cf_bm", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-0-Abc"], ["cf_clearance", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-1-Abc"], ["_gcl_au", "1.1.123456789.1698765432"], ["_fbc", "fb.1.1698765432123.IwAR0abcdefghijklmnop"],
    ["ajs_user_id", "a1b2c3d4e5f6a7b8c9d0"], ["mp_abc123_mixpanel", "%7B%22distinct_id%22%3A%20%22abcdef123456%22%7D"], ["amplitude_id_abc123", "eyJkZXZpY2VJZCI6ImFiY2RlZmdoaWprbCJ9"], ["intercom-session-abc123", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7L"], ["utm_source_cookie", "Qx7Lm2Vb9Tz4Wk8PzN3"], ["datadome", "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3"]];
  it.each(COOKIES)("%s is not registered, in a signed-out or a signed-in browser, from the state, the Cookie header and cookieTier", (name, value) => {
    expect(analyticsCookieName(name), name).toBe(true);
    for (const visitor of [true, false]) {
      expect(cookieTier({ name, value, httpOnly: false }, visitor), `${name} visitor=${String(visitor)}`).toBeNull();
      expect(cookieTier({ name, value, httpOnly: true }, visitor), `${name} httpOnly visitor=${String(visitor)}`).toBeNull();
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value, httpOnly: true }], origins: [] }, (item) => told.push(item), undefined, { visitor });
      expect(told, `${name} state`).toEqual([]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${value}` }], { visitor }), `${name} header`).toEqual([]);
    }
  });
  it("a JWT is still a credential under an analytics name, and a real session cookie beside the analytics ones still is", () => {
    expect(cookieTier({ name: "ajs_user_id", value: JWT, httpOnly: false }, true)).toBe("strong");
    expect(cookieTier({ name: "session", value: "Qx7Lm2Vb9Tz4Wk8PzN3", httpOnly: false }, true)).toBe("strong");
    expect(cookieTier({ name: "connect.sid", value: "s%3AQx7Lm2Vb9Tz4Wk8P.abc", httpOnly: true }, false)).toBe("strong");
    const told: ClassifiedValue[] = [];
    tellBrowserState({ cookies: [{ name: "_ga", value: "GA1.2.123456789.1730000000", httpOnly: false }, { name: "sid", value: "a1b2c3d4e5f6a7b8c9d0", httpOnly: false }], origins: [] }, (item) => told.push(item));
    expect(told).toEqual([{ value: "a1b2c3d4e5f6a7b8c9d0", tier: "strong" }]);
  });
});

describe("dotted words and hyphenated phrases are not tokens", () => {
  const DOTTED = ["navigation.breadcrumbs.dashboard", "checkout.payment_method.label", "validation.messages.required", "components.dashboard.header", "notifications.preferences.email", "dashboard.mycompany.com", "analytics.amplitude.com",
    "myorganization.atlassian.net", "container.registry.local", "application.properties.server", "settings.profile.changePassword"];
  it.each(DOTTED)("%s is not strong or weak at the top level or as a JSON leaf, in a URL parameter or in a header", (value) => {
    expect(isTokenShape(value), value).toBe(false);
    expect(["scrub", null], value).toContain(tierOf(classifyStorageEntry({ name: "lastKey", value }), value));
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ lastKey: value }) }), value)).toBeNull();
    expect(urlSecrets(`https://app.test/?label=${value}`).filter((item) => item.value === value)).toEqual([]);
    expect(headerSecrets([{ name: "x-label", value }]).filter((item) => item.value === value)).toEqual([]);
  });
  it("only a header that starts eyJ is a JWS or a JWE", () => {
    expect(isTokenShape(JWT)).toBe(true);
    expect(isTokenShape(`${b64('{"alg":"dir","enc":"A128GCM"}')}..${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`)).toBe(true);
    expect(isTokenShape(`navigation.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`)).toBe(false);
    expect(tierOf(classifyString("anything", JWT), JWT)).toBe("strong");
  });
  it.each([["base64-encoded-image-data"], ["base64-thumbnail-preview"], ["base64-image-attachment-1"]])("%s is not a token shape: not strong at the top level, as a leaf, in a URL parameter or in a header", (value) => {
    expect(isTokenShape(value)).toBe(false);
    expect(["scrub", null]).toContain(tierOf(classifyStorageEntry({ name: "lastFormat", value }), value));
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ lastFormat: value }) }), value)).toBeNull();
    expect(urlSecrets(`https://app.test/?format=${value}`).filter((item) => item.value === value)).toEqual([]);
    expect(headerSecrets([{ name: "x-format", value }]).filter((item) => item.value === value)).toEqual([]);
  });
  it("Supabase's `base64-` plus a JSON session stays strong", () => {
    const supabase = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }))}`;
    expect(isTokenShape(supabase)).toBe(true);
    expect(cookieTier({ name: "sb-abcdefgh-auth-token", value: supabase, httpOnly: false }, true)).toBe("strong");
  });
});

describe("a JWT inside an oversized neutral value is found", () => {
  const padded = JSON.stringify({ pad: "x".repeat(12_000), session: { token: JWT }, tail: "y".repeat(12_000) });
  it("in a URL query value, a fragment value and a header value over 16 KiB", () => {
    expect(padded.length).toBeGreaterThan(16_384);
    expect(tierOf(urlSecrets(`https://app.test/?state=${encodeURIComponent(padded)}`), JWT)).toBe("strong");
    expect(tierOf(urlSecrets(`https://app.test/#state=${encodeURIComponent(padded)}`), JWT)).toBe("strong");
    expect(tierOf(headerSecrets([{ name: "x-state", value: padded }]), JWT)).toBe("strong");
  });
  it("ordinary text of that size registers nothing, and nothing is refused for it", () => {
    expect(urlSecrets(`https://app.test/?q=${"x".repeat(20_000)}`)).toEqual([]);
    expect(headerSecrets([{ name: "referer", value: `https://app.test/${"y".repeat(20_000)}` }])).toEqual([]);
  });
  it("the scan is bounded and linear: a megabyte of separators and dotted pieces takes well under a second, a JWT past the first MiB is not looked for, at most 100 are kept", () => {
    const started = Date.now();
    expect(oversizedTokens(".-".repeat(600_000))).toEqual([]);
    expect(oversizedTokens("aaaaaaaa.".repeat(150_000))).toEqual([]);
    expect(oversizedTokens(`${"z ".repeat(600_000)}${JWT}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(oversizedTokens(Array.from({ length: 300 }, (_unused, index) => `${JWT}${index.toString(36)} `).join("")).length).toBe(100);
  });
});

describe("the mask has a hard time and size bound; past it the view fails closed and the run goes on", () => {
  it("20,000 nine-character values that share a 6-character start, and a 200 KB text made of it: registered and masked in under a second, nothing of the start left readable", () => {
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    const started = Date.now();
    for (let index = 0; index < 20_000; index += 1) registry.register(`Zq8LmW${String(index).padStart(3, "0")}`, { maskOnly: true });
    const out = registry.maskForModel("Zq8LmWxxx ".repeat(20_000));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).not.toContain("Zq8LmW");
    expect(registry.maskOverflowed()).toBe(true);
  });
  it("20 values of 32 KB that share their first 32,000 characters, and a 200 KB text of that periodic start: under a second, masked", () => {
    const registry = createSessionSecretRegistry({ redactor: createCredentialRedactor([]) });
    const common = "ab".repeat(16_000);
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) registry.register(`${common}${String(index).padStart(4, "0")}${"z".repeat(100)}`, { maskOnly: true });
    const out = registry.maskForModel("ab".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).not.toContain("ababab");
  });
  it("the work bound: a text that costs more than the budget is cut short and reported, a normal text is not", () => {
    const redactor = createCredentialRedactor([]);
    const common = "ab".repeat(16_000);
    for (let index = 0; index < 20; index += 1) redactor.addMaskOnly(`${common}${String(index).padStart(4, "0")}${"z".repeat(100)}`);
    const started = Date.now();
    expect(redactor.maskEvidenceOnlyBounded("ab".repeat(100_000)).exceeded).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(redactor.maskEvidenceOnlyBounded("an ordinary page with no registered value").exceeded).toBe(false);
    const normal = createCredentialRedactor([]);
    normal.addMaskOnly("Dk3pQ9xW2mV7cL4nR8tY");
    expect(normal.maskEvidenceOnlyBounded("doc Dk3pQ9xW2mV7cL4nR8tY here")).toEqual({ text: "doc <session> here", exceeded: false });
  });
  it("the size bound: a bucket of forms that share their first 6 characters is full at MASK_BUCKET_CAP; the value that does not fit is refused and the mask is degraded", () => {
    const redactor = createCredentialRedactor([]);
    let refused = 0;
    for (let index = 0; index < 5_000; index += 1) if (!redactor.addMaskOnly(`Zq8LmW${String(index).padStart(4, "0")}`)) refused += 1;
    expect(refused).toBeGreaterThan(0);
    expect(redactor.maskDegraded()).toBe(true);
    expect(MASK_BUCKET_CAP).toBe(4_096);
    const fresh = createCredentialRedactor([]);
    expect(fresh.addMaskOnly("Dk3pQ9xW2mV7cL4nR8tY")).toBe(true);
    expect(fresh.maskDegraded()).toBe(false);
  });
});

describe("the context wiring, for a signed-in context as well as a visitor's (real Chromium)", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const SESSION = "Qx7Lm2Vb9Tz4Wk8PzN3";

  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined }> = [];
    const tracked: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [], track: (promise) => { tracked.push(promise); }, learn: (items) => { learned.push(...items); },
      attach: (sessionRef, _reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous }); }, detach: () => undefined,
    };
    return { source, learned, attached, tracked, settle: async () => { await Promise.allSettled(tracked); } };
  }
  async function page(routes: (url: string) => { headers?: Record<string, string | string[]>; body?: string }) {
    const server: Server = createServer((request, response) => {
      const route = routes(request.url ?? "/");
      response.writeHead(200, { "content-type": "text/html", ...(route.headers ?? {}) });
      response.end(route.body ?? "<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    return { origin, context: await browser.newContext() };
  }

  it.skipIf(!haveChromium)("the choice of bar is the caller's callback, and every context is attached whichever answer it gives", async () => {
    for (const anonymous of [true, false]) {
      const { context } = await page(() => ({}));
      const r = recorder();
      wireCaseContext({ browserContext: context, sessionRef: `s-${String(anonymous)}`, isAnonymous: (ref) => ref === `s-${String(anonymous)}` ? anonymous : !anonymous, sessionSync: r.source, registerSecret: () => undefined });
      expect(r.attached).toEqual([{ sessionRef: `s-${String(anonymous)}`, anonymous }]);
    }
  }, 60_000);

  it.skipIf(!haveChromium)("a signed-in context: its plain `visitor=<uuid>` Set-Cookie and Cookie header ARE registered (the visitor bar is not applied), analytics cookies are not, and every Set-Cookie answer is tracked", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": [`visitor=${VISITOR}; Path=/`, `_hjSessionUser_1=Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm; Path=/`] } }));
    const r = recorder();
    const registered: string[] = [];
    wireCaseContext({ browserContext: context, sessionRef: "owned-1", isAnonymous: () => false, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    let requests = 0;
    let responses = 0;
    context.on("request", () => { requests += 1; });
    context.on("response", () => { responses += 1; });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await p.goto(`${origin}/again`);
    await r.settle();
    expect(r.attached).toEqual([{ sessionRef: "owned-1", anonymous: false }]);
    expect(registered).toContain(VISITOR);
    expect(registered.some((value) => value.startsWith("Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm"))).toBe(false);
    expect(r.learned.map((item) => item.value)).toContain(VISITOR);
    // One tracked read per request (the header read) and one per response (the Set-Cookie read): the sync waits for the Set-Cookie read before the next model call.
    expect(r.tracked.length).toBe(requests + responses);
  }, 60_000);

  it.skipIf(!haveChromium)("a signed-in context's request watch uses the signed-in bar for the Authorization header, and its case-close read takes the visitor-style id too", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` }, body: `<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); fetch("/api/me", { headers: { Authorization: "Bearer ${SESSION}" } });</script></body></html>` }));
    const r = recorder();
    wireCaseContext({ browserContext: context, sessionRef: "owned-2", isAnonymous: () => false, sessionSync: r.source, registerSecret: () => undefined });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await p.waitForLoadState("networkidle");
    await r.settle();
    expect(r.learned.map((item) => item.value)).toContain(SESSION);
    const closing = recorder();
    await readCaseContextAtClose({ browserContext: context, sessionRef: "owned-2", isAnonymous: () => false, sessionSync: closing.source });
    expect(closing.learned.map((item) => item.value)).toContain(VISITOR);
    const visitorClose = recorder();
    await readCaseContextAtClose({ browserContext: context, sessionRef: "visitor-2", isAnonymous: (ref) => ref === "visitor-2", sessionSync: visitorClose.source });
    expect(visitorClose.learned.map((item) => item.value)).not.toContain(VISITOR);
    await readCaseContextAtClose({ browserContext: undefined, sessionRef: "none", isAnonymous: () => true, sessionSync: closing.source });
  }, 60_000);

  it.skipIf(!haveChromium)("a visitor's `__cf_bm` and a plain unknown opaque cookie: the first registers nothing, the second is learned weak (masked, not refused)", async () => {
    const { origin, context } = await page(() => ({ headers: { "set-cookie": [`__cf_bm=Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4Wk8PzN3-1698765432-0-Abc; HttpOnly; Path=/`, `appstate=Qx7Lm2Vb9Tz4Wk8PzN3; Path=/`] } }));
    const r = recorder();
    const registered: string[] = [];
    wireCaseContext({ browserContext: context, sessionRef: "visitor-3", isAnonymous: () => true, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    const p = await context.newPage();
    await p.goto(`${origin}/`);
    await r.settle();
    expect(registered).toEqual([]);
    expect(r.learned).toEqual([{ value: "Qx7Lm2Vb9Tz4Wk8PzN3", tier: "weak" }]);
  }, 60_000);
});
