import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tellBrowserState, type BrowserSecretState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import { classifyString, isTokenShape, type ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { createHostModelStack } from "../../packages/verifier/src/executor/host-model-stack.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { headerSecrets, urlSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { readSessionContextAtClose, wireSessionContext } from "../../packages/verifier/src/executor/session-context-wiring.js";
import type { E2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { visitorCookieSecret } from "../../packages/verifier/src/executor/visitor-cookie.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { RUN_ID, TOOLS } from "../support/e2e-model-fixtures.js";
import { MIDSTEP2_POSITION as POSITION, createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 final-review fixes, round 2 (task-midstep2-finalfix-recheck.md): R-1 random-looking top-level runs are masked, R-2 an oversized ordinary parameter does not fail the view closed, R-3 a visitor's
// session cookie is registered by its name, R-4 a one-time parameter needs a token-like value, R-5 the fail-closed mask and the matcher, R-6 the context wiring through a real browser.

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;
const TOOLS_V4 = TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
type Part = { type: "text"; text: string };

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "r2-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

async function stackFor(storage: Array<{ name: string; value: string }>, redactorOptions?: { maskOnlyLimit?: number }) {
  const e = await harness.executor(undefined, redactorOptions);
  e.state.current = { cookies: [], origins: [{ localStorage: storage }] };
  const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "rovara-e2e-default", registry: e.registry, sessionSync: e.source, position: () => POSITION });
  const shown = async (text: string): Promise<string> => {
    await stack.adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: TOOLS_V4 });
    return ((e.run.seen[e.run.seen.length - 1] as { prompt: Array<{ content: Part[] }> }).prompt[0]!.content[0]!.text);
  };
  return { e, stack, shown };
}

describe("R-1: a random-looking run of 16+ characters at the top level is weak (masked), whatever its alphabet", () => {
  const A64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const make: Record<string, (n: number) => string> = {
    hex: (n) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n),
    lower: (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[randomInt(26)]).join(""),
    upper: (n) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[randomInt(26)]).join(""),
    base64: (n) => randomBytes(n).toString("base64").slice(0, n),
    base64url: (n) => randomBytes(n).toString("base64url").slice(0, n),
    nanoid: (n) => Array.from({ length: n }, () => A64[randomInt(64)]).join(""),
    "payload.signature": (n) => `${randomBytes(n).toString("base64url").slice(0, n >> 1)}.${randomBytes(n).toString("base64url").slice(0, n >> 1)}`,
  };
  it.each(Object.keys(make))("%s of 16 to 31 characters under a neutral key: weak in at least 85 percent, never unregistered, never strong", (kind) => {
    for (const size of [16, 21, 24, 31]) {
      let weak = 0;
      const total = 200;
      for (let index = 0; index < total; index += 1) {
        const value = make[kind]!(size);
        const tier = tierOf(classifyStorageEntry({ name: "lastDocument", value }), value);
        expect(["weak", "scrub"], `${kind} ${value}`).toContain(tier);
        if (tier === "weak") weak += 1;
      }
      expect(weak / total, `${kind} ${size}`).toBeGreaterThanOrEqual(0.85);
    }
  });
  it.each([["s:abc123DEF456ghi789.Zm9vYmFyYmF6cXV4MTIz"], ["Zm9vYmFyYmF6.cXV4MTIzNDU2Nzg5"], ["12|abcDEF123ghiJKL456mno"], ["ya29.a0AfH6SMBx9QzLmN2pRtVw8YcK3"], ["sessionid=a1b2c3d4e5f6a7b8"], ["oauth_state=Xk3_9aB-q7LmZp2RtVw8"],
    ["V1StGXR8_Z5jdHi6B-myT"], ["Ck3x-Qw9_ZLm2vB7nRtYhA"], ["9f86d081884c7d65"], ["a1b2c3d4e5f60718293a4b5c"]])("the re-check's shape %s is weak", (value) => {
    expect(tierOf(classifyStorageEntry({ name: "lastDocument", value }), value)).toBe("weak");
  });
  it("the model does not read a nanoid, a token_urlsafe(16) or a short hex id kept under a neutral top-level key; it still reads the base URL beside them", async () => {
    const { shown } = await stackFor([{ name: "uid", value: "V1StGXR8_Z5jdHi6B-myT" }, { name: "anonId", value: "Ck3x-Qw9_ZLm2vB7nRtYhA" }, { name: "build", value: "9f86d081884c7d65" }, { name: "apiBase", value: "https://app.example.com" }]);
    expect(await shown("user V1StGXR8_Z5jdHi6B-myT anon Ck3x-Qw9_ZLm2vB7nRtYhA build 9f86d081884c7d65 at https://app.example.com/orders")).toBe("user <session> anon <session> build <session> at https://app.example.com/orders");
  });
  it("a leaf of JSON is unchanged by this rule (a cache of ordinary ids is not masked)", () => {
    const value = "V1StGXR8_Z5jdHi6B-myT";
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ uid: value }) }), value)).toBeNull();
  });
});

describe("R-2: an oversized ordinary parameter or header does not fail the view closed", () => {
  it("a 20 KB query value, a 20 KB fragment value, 250 parameters and a 17 KB Referer leave the view open; the credential in the 250th parameter is still found", async () => {
    const { e, shown } = await stackFor([]);
    const fresh = "ORD2026102712345678";
    e.source.learn(urlSecrets(`https://app.test/?q=${"x".repeat(20_000)}`));
    e.source.learn(urlSecrets(`https://app.test/#json=${"A".repeat(20_000)}`));
    e.source.learn(headerSecrets([{ name: "referer", value: `https://app.test/${"y".repeat(17_000)}` }]));
    const many = `${Array.from({ length: 249 }, (_unused, index) => `f${index}=v${index}`).join("&")}&token=Ab3dEf9hJk`;
    const items = urlSecrets(`https://app.test/?${many}`);
    expect(tierOf(items, "Ab3dEf9hJk")).toBe("strong");
    e.source.learn(items);
    expect(e.registry.maskOverflowed()).toBe(false);
    expect(await shown(`order ${fresh} /orders/12345/items/99882211 https://app.example.com/orders/12345`)).toBe(`order ${fresh} /orders/12345/items/99882211 https://app.example.com/orders/12345`);
  });
  it("a header list of 300 ordinary headers leaves the view open, and a credential header at the end of it is still found", () => {
    const headers = [...Array.from({ length: 299 }, (_unused, index) => ({ name: `x-h${index}`, value: "short-value-here" })), { name: "x-api-key", value: "Ab3dEf9hJk" }];
    const items = headerSecrets(headers);
    expect(items.some((item) => item.tier === "overflow")).toBe(false);
    expect(tierOf(items, "Ab3dEf9hJk")).toBe("strong");
  });
  it("a credential-named parameter or header that is too large still fails the view closed (the one case that must)", () => {
    expect(urlSecrets(`https://app.test/?access_token=${"x".repeat(20_000)}`).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "cookie", value: `a=${"y".repeat(20_000)}` }]).some((item) => item.tier === "overflow")).toBe(true);
  });
});

describe("R-5: the fail-closed mask and the matcher", () => {
  it("once the view has failed closed, a run of 16+ of one case, a run over 4,096 characters and a digit-less lower-case run are masked; slugs and paths are not", async () => {
    const { e, shown } = await stackFor([]);
    e.source.learn([{ value: "", tier: "overflow" }]);
    const long = "Qk".repeat(2_600);
    const out = await shown(`a kjhsdfqwpoiuzxcmvbnq b ABCDEFGHIJKLMNOPQRSTUVWXYZ c ${long} d /projects/alpha/settings e my-quarterly-report-final f Quarterly Report`);
    expect(out).toBe("a <session> b <session> c <session> d /projects/alpha/settings e my-quarterly-report-final f Quarterly Report");
  });
  it("no recursion: 40 values that share 60,000 characters register and are masked without a stack overflow, and are never thrown out of addSessionSecret", () => {
    const redactor = createCredentialRedactor([]);
    const common = "Zq".repeat(30_000);
    const values = Array.from({ length: 40 }, (_unused, index) => `${common}${String(index).padStart(4, "0")}`);
    for (const value of values) { expect(() => redactor.addSessionSecret(value, { evidenceOnly: true })).not.toThrow(); }
    for (const value of values.slice(0, 3)) expect(() => redactor.addMaskOnly(`${value}x`)).not.toThrow();
    expect(redactor.maskEvidenceOnly(`a ${values[7]!} b`)).toBe("a <session> b");
  });
  it("20,000 values of 10 characters that share their first 6, and a 200 KB text made of that start, are registered and masked in a few seconds (the unsplit tree took 17 s)", () => {
    const redactor = createCredentialRedactor([]);
    const started = Date.now();
    for (let index = 0; index < 20_000; index += 1) redactor.addMaskOnly(`Zq8LmW${String(index).padStart(4, "0")}`);
    const text = `${"Zq8LmWxxxx ".repeat(18_000)}Zq8LmW${String(12_345).padStart(4, "0")} end`;
    const out = redactor.maskEvidenceOnly(text);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(out.endsWith("<session> end")).toBe(true);
  }, 60_000);
});

describe("R-3: a signed-out visitor's session cookie is registered by its name and value; its id and cart are not", () => {
  const SUPABASE = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9", user: { id: "u1" } }))}`;
  it("token shapes include a `base64-` session", () => {
    expect(isTokenShape(SUPABASE)).toBe(true);
    expect(isTokenShape("base64-short")).toBe(false);
  });
  it.each([
    ["sb-abcdefgh-auth-token", SUPABASE, true], ["sb-abcdefgh-auth-token", "plainvalueplainvalue", true], ["sid", "a1b2c3d4e5f6a7b8", true], ["session", "Qx7Lm2Vb9Tz4Wk8P", true], ["connect.sid", "s%3AQx7Lm2Vb9Tz4Wk8P.abc", true],
    ["appstate", "Qx7Lm2Vb9Tz4Wk8PzN3", true], ["visitor", "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", false], ["visitor_id", "Qx7Lm2Vb9Tz4Wk8PzN3", false], ["cart", "3-items-blue-shirt-red-hat", false],
    ["anon_id", "Qx7Lm2Vb9Tz4Wk8PzN3", false], ["_ga", "GA1.2.123456789.1730000000", false], ["theme", "dark", false], ["lang", "en-US", false], ["foo", "short", false],
  ])("cookie %s=%s: %s", (name, value, secret) => {
    expect(visitorCookieSecret({ name, value, httpOnly: false })).toBe(secret);
  });
  it("an HttpOnly cookie and a JWT count under any name; with no name the old rule stands", () => {
    expect(visitorCookieSecret({ name: "foo", value: "Qx7Lm2Vb9Tz4", httpOnly: true })).toBe(true);
    expect(visitorCookieSecret({ name: "visitor", value: JWT, httpOnly: false })).toBe(true);
    expect(visitorCookieSecret({ value: "a1b2c3d4e5f6a7b8c9d0", httpOnly: false })).toBe(false);
  });
  it("through the state read and the Cookie header", () => {
    const state: BrowserSecretState = { cookies: [{ name: "sb-abcdefgh-auth-token", value: SUPABASE, httpOnly: false }, { name: "visitor", value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", httpOnly: false }], origins: [] };
    const told: ClassifiedValue[] = [];
    tellBrowserState(state, (item) => told.push(item), undefined, { visitor: true });
    expect(told).toEqual([{ value: SUPABASE, tier: "strong" }]);
    const header = [{ name: "cookie", value: `visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; sb-abcdefgh-auth-token=${SUPABASE}` }];
    expect(headerSecrets(header, { visitor: true }).map((item) => item.value)).toEqual([SUPABASE]);
  });
});

describe("R-4: a one-time parameter needs a token-like value", () => {
  it.each([["otp", "required"], ["invite", "accepted"], ["magic_link", "sent-already"], ["inviteCode", "accepted"], ["oobCode", "expired-link"], ["verificationCode", "pending-review"]])("?%s=%s is not registered", (name, value) => {
    expect(urlSecrets(`https://app.test/auth?${name}=${value}`)).toEqual([]);
  });
  it("the status word is not refused when the page shows it", async () => {
    const e = await harness.executor();
    e.source.learn(urlSecrets("https://app.test/auth?otp=required&invite=accepted"));
    expect(await e.executorSays("Two-factor required to continue; invite accepted")).toBe("ok");
    expect(e.registry.sessionSecrets).toEqual([]);
  });
  it.each([["otc"], ["magic_code"], ["invite"], ["verify_code"], ["signin_code"], ["login_code"], ["login_link"], ["signin_link"], ["onetime_code"], ["email_code"], ["magic_token"], ["passwordless_token"]])("?%s= with a token-like value is strong", (name) => {
    expect(tierOf(urlSecrets(`https://app.test/auth?${name}=Qx7Lm2Vb9Tz4`), "Qx7Lm2Vb9Tz4")).toBe("strong");
  });
  it("a magic link URL counts when a piece of it is opaque", () => {
    const link = "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3";
    expect(tierOf(urlSecrets(`https://app.test/?magicLink=${encodeURIComponent(link)}`), link)).toBe("strong");
  });
  it("a neutral value classified as before: an opaque token under another name is weak", () => {
    expect(tierOf(classifyString("lastDocument", "Dk3pQ9xW2mV7cL4nR8tY"), "Dk3pQ9xW2mV7cL4nR8tY")).toBe("weak");
  });
});

describe("R-6: the context wiring, through a real Chromium, for a signed-out visitor", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const SB_VALUE = `base64-${b64(JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }))}`;
  const API_KEY = "Qx7Lm2Vb9Tz4Wk8PzN3";

  /** A session sync that only records what the wiring tells it, so each path is seen on its own. */
  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined; reader: { storageState(): Promise<BrowserSecretState> } }> = [];
    const pending: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [],
      track: (promise) => { pending.push(promise); },
      learn: (items) => { learned.push(...items); },
      attach: (sessionRef, reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous, reader }); },
      detach: () => undefined,
    };
    return { source, learned, attached, settle: async () => { await Promise.allSettled(pending); } };
  }
  async function visitorPage(routes: (url: string) => { headers?: Record<string, string>; body?: string }) {
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
    const context = await browser.newContext();
    return { origin, context };
  }

  it.skipIf(!haveChromium)("Set-Cookie: a Supabase session cookie issued to a visitor is registered; a plain visitor id cookie is not", async () => {
    const { origin, context } = await visitorPage((url) => url === "/signup"
      ? { headers: { "set-cookie": [`sb-abcdefgh-auth-token=${SB_VALUE}; Path=/`, `visitor=${VISITOR}; Path=/`] as unknown as string } } : { headers: { "set-cookie": `visitor=${VISITOR}; Path=/` } });
    const r = recorder();
    const registered: string[] = [];
    wireSessionContext({ browserContext: context, sessionRef: "visitor-1", anonymous: true, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await r.settle();
    expect(registered).toEqual([]);
    await page.goto(`${origin}/signup`);
    await r.settle();
    expect(registered).toEqual([SB_VALUE]);
    expect(r.attached.map((item) => [item.sessionRef, item.anonymous])).toEqual([["visitor-1", true]]);
  }, 60_000);

  it.skipIf(!haveChromium)("request watch: a visitor's Authorization header and its #access_token= fragment are learned; its Cookie header with an id and a cart is not", async () => {
    const { origin, context } = await visitorPage(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` },
      body: `<html><body><script>fetch("/api/me", { headers: { Authorization: "Bearer ${API_KEY}" } });</script></body></html>` }));
    const r = recorder();
    wireSessionContext({ browserContext: context, sessionRef: "visitor-1", anonymous: true, sessionSync: r.source, registerSecret: () => undefined });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.goto(`${origin}/again`);
    await page.waitForLoadState("networkidle");
    await page.goto(`${origin}/welcome#access_token=${JWT}&token_type=bearer`);
    await r.settle();
    const values = r.learned.map((item) => item.value);
    expect(values).toContain(API_KEY);
    expect(values).toContain(JWT);
    // The second page load sent `Cookie: visitor=...`: the visitor bar leaves it out (it is registered if the watch ignores the bar).
    expect(values).not.toContain(VISITOR);
  }, 60_000);

  it.skipIf(!haveChromium)("case close: what a visitor's browser holds at the end (a token the app stored mid-step) is learned; the visitor id beside it is not", async () => {
    const { origin, context } = await visitorPage(() => ({ headers: { "set-cookie": `visitor=${VISITOR}; Path=/` },
      body: `<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); localStorage.setItem("sb-abcdefgh-auth-token", JSON.stringify({ access_token: "${JWT}", refresh_token: "r3fr3sh0pq9" }));</script></body></html>` }));
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const r = recorder();
    await readSessionContextAtClose({ browserContext: context, anonymous: true, sessionSync: r.source });
    const values = r.learned.map((item) => item.value);
    expect(values).toContain(JWT);
    expect(values).toContain("r3fr3sh0pq9");
    expect(values).not.toContain(VISITOR);
    // The same read for a signed-in context takes the id as well (the visitor bar is the only difference).
    const owned = recorder();
    await readSessionContextAtClose({ browserContext: context, anonymous: false, sessionSync: owned.source });
    expect(owned.learned.map((item) => item.value)).toContain(VISITOR);
  }, 60_000);
});
