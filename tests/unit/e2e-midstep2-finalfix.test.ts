import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBrowserState } from "../../packages/verifier/src/executor/browser-state-reader.js";
import { classifyString, type ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { createHostModelStack } from "../../packages/verifier/src/executor/host-model-stack.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { headerSecrets, urlSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { createE2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { classifyStorageEntry } from "../../packages/verifier/src/executor/storage-entry-classifier.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { RUN_ID, TOOLS } from "../support/e2e-model-fixtures.js";
import { MIDSTEP2_POSITION as POSITION, createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 final-review fixes: F-1 (ordinary top-level values are scrub-only, never masked), F-2 (the caps do not stop the mask), F-3 (a signed-out visitor's context is read), F-4 (one-time sign-in
// URL parameters are credentials). Real worker proxy, redactor, registry, session source, channel client and adapter; the F-3 browser test is a real Chromium.

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const tierOf = (items: readonly ClassifiedValue[], value: string) => items.find((item) => item.value === value)?.tier ?? null;
const TOOLS_V4 = TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
type Part = { type: "text"; text: string };

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "ff-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

async function stackFor(storage: Array<{ name: string; value: string }>, redactorOptions?: { maskOnlyLimit?: number }) {
  const e = await harness.executor(undefined, redactorOptions);
  e.state.current = { cookies: [], origins: [{ localStorage: storage }] };
  const stack = createHostModelStack({ socketPath: e.run.socketPath, runId: RUN_ID, routeId: "rovara-e2e-default", registry: e.registry, sessionSync: e.source, position: () => POSITION });
  /** What the model was shown for one user text. */
  const shown = async (text: string): Promise<string> => {
    await stack.adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: TOOLS_V4 });
    const last = e.run.seen[e.run.seen.length - 1] as { prompt: Array<{ content: Part[] }> };
    return last.prompt[0]!.content[0]!.text;
  };
  return { e, stack, shown };
}

describe("F-1: ordinary values at the top level of storage are scrub-only, never masked for the model", () => {
  const ORDINARY: Array<[string, string]> = [["apiBase", "https://app.example.com"], ["lastProject", "Quarterly Report"], ["lastRoute", "/projects/alpha/settings"], ["returnUrl", "https://app.example.com/orders/12345"],
    ["userEmail", "maya.rodriguez@example.com"], ["selectedWorkspace", "acme-engineering-team"], ["draft:42", "Meeting notes for Monday standup"], ["lastSeen", "2026-10-27T09:15:00.000Z"],
    ["workspaceId", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"], ["tz", "America/Los_Angeles"], ["apiHost", "login.example.com"], ["searchQuery", "internationalization settings"]];
  it.each(ORDINARY)("%s=%s is scrub at the top level and not registered as a JSON leaf", (name, value) => {
    expect(tierOf(classifyStorageEntry({ name, value }), value)).toBe("scrub");
    expect(tierOf(classifyStorageEntry({ name: "settings", value: JSON.stringify({ [name]: value }) }), value)).toBeNull();
  });
  it("a token-shaped value at the top level is still weak (masked), and a sentence under a credential-sounding name is weak too", () => {
    expect(tierOf(classifyStorageEntry({ name: "lastDocument", value: "Dk3pQ9xW2mV7cL4nR8tY" }), "Dk3pQ9xW2mV7cL4nR8tY")).toBe("weak");
    expect(tierOf(classifyString("tokenEndpoint", "https://login.example.com/oauth2/token"), "https://login.example.com/oauth2/token")).toBe("weak");
  });
  it("the model reads an app's base URL, a project name that is part of a longer word, a route and a draft; the same values are still scrubbed from evidence; a token beside them is masked", async () => {
    const { e, shown } = await stackFor([{ name: "apiBase", value: "https://app.example.com" }, { name: "lastProject", value: "Quarterly Report" }, { name: "lastRoute", value: "/projects/alpha/settings" },
      { name: "selectedWorkspace", value: "acme-engineering-team" }, { name: "draft:42", value: "Meeting notes for Monday standup" }, { name: "lastDocument", value: "Dk3pQ9xW2mV7cL4nR8tY" }]);
    const text = "URL: https://app.example.com/orders/12345 | Quarterly Reports overview | /acme-engineering-team/settings | Meeting notes for Monday standup | /projects/alpha/settings | doc Dk3pQ9xW2mV7cL4nR8tY";
    expect(await shown(text)).toBe(text.replace("Dk3pQ9xW2mV7cL4nR8tY", "<session>"));
    // Positive control: the sync registered them (evidence scrub and scan know them) and the call was not refused.
    for (const value of ["https://app.example.com", "Quarterly Report", "acme-engineering-team", "Meeting notes for Monday standup"]) expect(e.redactor.contains(Buffer.from(value), "all"), value).toBe(true);
    expect(e.redactor.text("see Quarterly Report")).toBe("see <session>");
    expect(e.registry.modelScan(Buffer.from(text))).toBe(false);
  });
  it("the redactor masks a scrub-only value for nobody, and a scrub-only value later registered weak becomes maskable (the other way round it stays maskable)", () => {
    const redactor = createCredentialRedactor([]);
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true, scrubOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a Quarterly Report b");
    expect(redactor.text("a Quarterly Report b")).toBe("a <session> b");
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a <session> b");
    redactor.addSessionSecret("Quarterly Report", { evidenceOnly: true, scrubOnly: true });
    expect(redactor.maskEvidenceOnly("a Quarterly Report b")).toBe("a <session> b");
  });
});

describe("F-2: the caps do not stop the mask", () => {
  const weakItem = (index: number): ClassifiedValue => ({ value: `Zq${String(index).padStart(6, "0")}LmWp3Rt6YvB2nXc`, tier: "weak" });
  it("the 2,001st weak value (past the evidence cap) and the 2,500th are still masked, and the call is not refused", async () => {
    const { e, shown } = await stackFor([]);
    e.source.learn(Array.from({ length: 2_500 }, (_unused, index) => weakItem(index)));
    expect(await shown(`first ${weakItem(0).value} 2000th ${weakItem(1_999).value} 2001st ${weakItem(2_000).value} 2500th ${weakItem(2_499).value} ordinary text`)).toBe("first <session> 2000th <session> 2001st <session> 2500th <session> ordinary text");
    // Only the first 2,000 are scrubbed from evidence (the cap is the evidence scrub's); the rest are held for the mask alone.
    expect(e.redactor.contains(Buffer.from(weakItem(1_999).value), "all")).toBe(true);
    expect(e.redactor.contains(Buffer.from(weakItem(2_000).value), "all")).toBe(false);
    expect(e.registry.sessionSecrets).toEqual([]);
  });
  it("the 201st opaque leaf of one storage entry and the 250th are still masked", async () => {
    const leaves = Object.fromEntries(Array.from({ length: 250 }, (_unused, index) => [`k${index}`, `Lf${String(index).padStart(5, "0")}Xc7Yb2Nm5Qr8Tw`]));
    const { shown } = await stackFor([{ name: "cache", value: JSON.stringify(leaves) }]);
    expect(await shown(`a ${leaves.k0 as string} b ${leaves.k199 as string} c ${leaves.k200 as string} d ${leaves.k249 as string}`)).toBe("a <session> b <session> c <session> d <session>");
  });
  it("past even the mask bound the model's view fails closed: every opaque run of 16+ characters is masked, ordinary text is not, and the call is not refused", async () => {
    const { e, shown } = await stackFor([], { maskOnlyLimit: 5 });
    const fresh = "Zq8LmWp3Rt6YvB2nXc5K";
    // Before the bound is passed, an unregistered run is shown (the control).
    expect(await shown(`doc ${fresh}`)).toBe(`doc ${fresh}`);
    e.source.learn(Array.from({ length: 8 }, (_unused, index) => ({ value: `Mk${String(index).padStart(6, "0")}LmWp3Rt6YvB2nXc`, tier: "mask" as const })));
    expect(e.registry.maskOverflowed()).toBe(true);
    expect(await shown(`doc ${fresh} path /projects/alpha/settings words Quarterly Report short Ab3dEf9h`)).toBe("doc <session> path /projects/alpha/settings words Quarterly Report short Ab3dEf9h");
  });
  it("an overflow note from the classifier (a weak value over 64 KiB) fails the view closed; a scrub-only value that large does not", () => {
    expect(classifyStorageEntry({ name: "session", value: "word ".repeat(20_000) }).some((item) => item.tier === "overflow")).toBe(true);
    expect(classifyStorageEntry({ name: "blob", value: "plain words ".repeat(8_000) }).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("one combined matcher: 20,000 values that share a start (JWT-like) and a 200 KB text full of that start are masked in well under two seconds", () => {
    const redactor = createCredentialRedactor([]);
    const head = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.";
    for (let index = 0; index < 20_000; index += 1) redactor.addMaskOnly(`${head}${String(index).padStart(8, "0")}.sig${String(index * 7).padStart(8, "0")}`);
    const target = `${head}${String(12_345).padStart(8, "0")}.sig${String(12_345 * 7).padStart(8, "0")}`;
    const text = `${`${head}unregistered `.repeat(1_500)}${target} end`;
    const started = Date.now();
    const out = redactor.maskEvidenceOnly(text);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.endsWith("<session> end")).toBe(true);
    expect(out).not.toContain(target);
  }, 60_000);
});

describe("F-9 / R-2: a credential too large to register fails the view closed; an oversized ordinary parameter or header does not", () => {
  it("a credential-named URL value or header over 16 KiB gives an overflow note; below the bounds there is none", () => {
    expect(urlSecrets(`https://app.test/?token=${"x".repeat(20_000)}`).some((item) => item.tier === "overflow")).toBe(true);
    expect(urlSecrets("https://app.test/?a=b&token=Ab3dEf9hJk").some((item) => item.tier === "overflow")).toBe(false);
    expect(headerSecrets([{ name: "x-api-key", value: "y".repeat(20_000) }]).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "authorization", value: `Bearer ${"y".repeat(20_000)}` }]).some((item) => item.tier === "overflow")).toBe(true);
    expect(headerSecrets([{ name: "x-api-key", value: "Ab3dEf9hJk" }]).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("more weak leaves in one entry than the mask bound (5,000) give an overflow note; fewer do not", () => {
    const leaves = (count: number) => JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`k${index}`, `Lf${String(index).padStart(6, "0")}Xc7Yb2Nm5Qr8Tw`])));
    expect(classifyStorageEntry({ name: "cache", value: leaves(5_300) }).some((item) => item.tier === "overflow")).toBe(true);
    expect(classifyStorageEntry({ name: "cache", value: leaves(300) }).some((item) => item.tier === "overflow")).toBe(false);
  });
  it("an overflow note is registered once, however often it is learned", () => {
    const registered: Array<{ value: string; overflow: boolean }> = [];
    const source = createE2ESessionSyncSource({ register: (value, options) => { registered.push({ value, overflow: options?.overflow === true }); }, known: () => [] });
    source.learn([{ value: "", tier: "overflow" }, { value: "", tier: "overflow" }]);
    source.learn([{ value: "", tier: "overflow" }]);
    expect(registered).toEqual([{ value: "", overflow: true }]);
  });
  it("an overflow note learned by the session source fails the model's view closed, once", async () => {
    const { e, shown } = await stackFor([]);
    const fresh = "Zq8LmWp3Rt6YvB2nXc5K";
    expect(await shown(`doc ${fresh}`)).toBe(`doc ${fresh}`);
    e.source.learn([{ value: "", tier: "overflow" }, { value: "", tier: "overflow" }]);
    expect(e.registry.maskOverflowed()).toBe(true);
    expect(await shown(`doc ${fresh}`)).toBe("doc <session>");
  });
});

describe("F-3: a signed-out visitor's context is read", () => {
  it("a token the visitor gains mid-step (a fragment, a Supabase-style cache) is registered and refused if shown; a visitor id and a cart are not registered", async () => {
    const e = await harness.executor();
    e.state.current = { cookies: [{ value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", httpOnly: false }], origins: [{ localStorage: [{ name: "visitor_id", value: "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301" }, { name: "cart", value: "3 items: blue shirt, red hat" }] }] };
    e.source.detach("s1");
    e.source.attach("visitor", { storageState: async () => e.state.current }, { anonymous: true });
    expect((await e.executorSays("visitor visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301 cart 3 items: blue shirt, red hat")), "before").toBe("ok");
    e.state.current = { ...e.state.current, urls: [`https://app.test/welcome#access_token=${JWT}&token_type=bearer`], origins: [{ localStorage: [...e.state.current.origins[0]!.localStorage, { name: "sb-xyz-auth-token", value: JSON.stringify({ access_token: JWT, refresh_token: "r3fr3sh0pq9" }) }] }] };
    expect(await e.executorSays(`landed on https://app.test/welcome#access_token=${JWT}`)).toBe("credential-in-prompt");
    // The worker is told it too (the sync), so its own scan would refuse it.
    expect(e.registry.sessionSecrets).toContain(JWT);
    expect(e.registry.sessionSecrets).toContain("r3fr3sh0pq9");
    expect(e.registry.sessionSecrets).not.toContain("visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });
  const haveChromium = existsSync(chromium.executablePath());
  it.skipIf(!haveChromium)("real Chromium: an anonymous context that gains #access_token= after the first page is protected from the next model call; its visitor id is not registered", async () => {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; Path=/" });
      response.end(`<!doctype html><html><body><p>Welcome visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301</p><script>localStorage.setItem("visitor_id", "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301");</script></body></html>`);
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    const context = await browser.newContext();
    const e = await harness.executor();
    e.source.detach("s1");
    // As the host attaches a signed-out visitor: with the visitor bar. Nothing else watches this context, so the fragment is found only because the visitor's browser state is read.
    e.source.attach("visitor", { storageState: () => readBrowserState(context) }, { anonymous: true });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    expect(await e.executorSays("Welcome visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "the visitor id is no secret").toBe("ok");
    await page.goto(`${origin}/welcome#access_token=${JWT}&token_type=bearer`);
    expect(await e.executorSays(`You are at ${page.url()}`)).toBe("credential-in-prompt");
    expect(e.registry.sessionSecrets).toContain(JWT);
  }, 60_000);
});

describe("F-3: the visitor bar of the request watch", () => {
  it("a visitor's Cookie header (its id and cart) registers nothing, a JWT in it does; a signed-in context's cookie header is unchanged", () => {
    const header = [{ name: "cookie", value: `visitor=visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301; cart=3-items-blue-shirt-red-hat; sid=${JWT}` }];
    expect(headerSecrets(header, { visitor: true }).map((item) => item.value)).toEqual([JWT]);
    expect(headerSecrets(header).map((item) => item.value)).toEqual(expect.arrayContaining(["visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301", JWT]));
  });
});

describe("F-4: one-time sign-in URL parameters are credentials", () => {
  const SAML = "AAQAAMFbLinlmzYhpL8Tq7Wx0v3Cn2D5Rk9sE1uJ4gB6hN8mA";
  const OOB = "b9Gk2Lx7Qw4Zp1Vm6Rt3Hc8Dn5Fs0JyAeUo";
  it.each([["oobCode", OOB], ["otp", "Ab3dEf9hJk"], ["magic_link", "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3"], ["magicLink", "https://app.test/magic/b9Gk2Lx7Qw4Zp1Vm6Rt3"], ["inviteCode", "Tm9x2Kq8Lw"],
    ["SAMLart", SAML], ["SAMLResponse", `${SAML}${SAML}`], ["verificationCode", "Qx7Lm2Vb9Tz"], ["resetCode", "Rn4Kp8Wd1Yc"], ["t", OOB], ["t", "Qx7Lm2Vb9Tz4Wk8P"]])("?%s= is strong", (name, value) => {
    expect(tierOf(urlSecrets(`https://app.test/auth?${name}=${encodeURIComponent(value)}&lang=en-US`), value)).toBe("strong");
  });
  it("SAMLart is one word (not sam and lart), and a parameter named t counts only when its value is a token; other *code names are masked, not refused", () => {
    expect(tierOf(urlSecrets("https://app.test/?t=1730000000"), "1730000000")).toBeNull();
    expect(tierOf(urlSecrets("https://app.test/?t=pending-review-status"), "pending-review-status")).toBeNull();
    expect(tierOf(urlSecrets("https://app.test/?promoCode=SUMMER2026SALE"), "SUMMER2026SALE")).toBe("weak");
    expect(urlSecrets("https://app.test/?lang=en-US&page=2&q=blue+shirts+for+summer")).toEqual([]);
  });
  it("a page URL that carries a live oobCode is refused when the model would be shown it; the same URL without it is not", async () => {
    const e = await harness.executor();
    e.source.learn(urlSecrets(`https://app.test/__/auth/action?mode=signIn&oobCode=${OOB}&apiKey=AIzaSyfake`));
    expect(await e.executorSays("at https://app.test/__/auth/action?mode=signIn")).toBe("ok");
    expect(await e.executorSays(`at https://app.test/__/auth/action?mode=signIn&oobCode=${OOB}`)).toBe("credential-in-prompt");
    expect(e.registry.sessionSecrets).toContain(OOB);
  });
  it("random tokens under a neutral parameter name are masked (weak); hex ids and UUIDs are not registered", () => {
    for (let index = 0; index < 50; index += 1) {
      const token = randomBytes(24).toString("base64url");
      if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) continue;
      expect(tierOf(urlSecrets(`https://app.test/x?ref=${token}`), token), token).not.toBeNull();
    }
    expect(urlSecrets(`https://app.test/x?ref=${"a1".repeat(16)}&id=3f2504e0-4f89-11d3-9a0c-0305e82c3301`)).toEqual([]);
  });
});
