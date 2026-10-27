import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tellBrowserState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import type { ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { headerSecrets } from "../../packages/verifier/src/executor/request-secrets.js";
import { adoptCaseContext, closeCaseContext } from "../../packages/verifier/src/executor/session-context-wiring.js";
import type { E2ESessionSyncSource } from "../../packages/verifier/src/executor/session-sync.js";
import { analyticsCookieName, cookieTier } from "../../packages/verifier/src/executor/visitor-cookie.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";

// MIDSTEP-2 mini-fix (task-midstep2-last-check.md F-1, F-2): the analytics cookie names are whole names or delimited stems, and an opaque value under one is weak; the host's two sequences are exported
// functions with behaviour tests, and the host holds one plain statement for each.

const OPAQUE = "Qx7Lm2Vb9Tz4Wk8PzN3Qx7Lm2Vb9Tz4";
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"visitor-1234567890"}')}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "mf-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });

describe("F-1: the analytics names are whole names or delimited stems; an opaque value under one is weak", () => {
  it.each([["_gateway_session"], ["_gallery_session"], ["_game_session"], ["_gamma_session"], ["_garage_auth"], ["_galaxy_token"], ["_gidget_session"], ["optimizely_login"], ["mp_session"], ["utm_session"], ["ajs_session"], ["amplitude_session"], ["_pk_sess"]])(
    "%s is not an analytics name: a signed-in browser registers it strong, a visitor's too (it names a session or a token)", (name) => {
      expect(analyticsCookieName(name), name).toBe(false);
      for (const httpOnly of [true, false]) {
        expect(cookieTier({ name, value: OPAQUE, httpOnly }, false), `owner ${name}`).toBe("strong");
        expect(cookieTier({ name, value: OPAQUE, httpOnly }, true), `visitor ${name}`).toBe("strong");
      }
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value: OPAQUE, httpOnly: true }], origins: [] }, (item) => told.push(item));
      expect(told).toEqual([{ value: OPAQUE, tier: "strong" }]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${OPAQUE}` }]).map((item) => item.tier)).toEqual(["strong"]);
    });

  it.each([["_ga"], ["_ga_ABC123XYZ"], ["_gid"], ["_gat"], ["_gat_UA123"], ["_gac_UA123"], ["_gcl_au"]])("%s is an analytics name", (name) => {
    expect(analyticsCookieName(name)).toBe(true);
  });

  // The names that had no test of their own, plus the ones of the list: each with an opaque value (weak) and a plain one (not registered), for an owner and a visitor.
  const NAMES: Array<[string, string]> = [["_fbp", "fb.1.1730000000000.1234567890"], ["_fbc", "fb.1.1730000000000.IwAR0abcdefghijklmnop"], ["_gid", "GA1.2.987654321.1730000000"], ["_pk_id.1.abcd", "a1b2c3d4e5f6a7b8.1730000000.1"],
    ["_pk_ses.1.abcd", "a1b2c3d4e5f6a7b8"], ["_cs_id", "a1b2c3d4-e5f6.1730000000.1"], ["_ttp", OPAQUE], ["_scid", OPAQUE], ["_dd_s", "rum=0&id=abc123def456&created=1&expire=2"], ["_shopify_y", OPAQUE], ["_ga", "GA1.2.123456789.1730000000"],
    ["_ga_ABC123XYZ", "GS1.1.1730000000.1.0.1730000000.0.0.0"], ["optimizelyEndUserId", "oeu1698765432123r0.1234567890123"], ["_hjSessionUser_1", b64(JSON.stringify({ id: "abcdefgh-ijkl", created: 1698765432 }))], ["__cf_bm", OPAQUE], ["_uetsid", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"]];
  it.each(NAMES)("%s: analytics name, so an opaque value is weak (masked, never refused) in every path, for an owner and a visitor", (name, value) => {
    expect(analyticsCookieName(name), name).toBe(true);
    for (const visitor of [false, true]) {
      for (const httpOnly of [false, true]) {
        const tier = cookieTier({ name, value, httpOnly }, visitor);
        expect(["weak", null], `${name} visitor=${String(visitor)}`).toContain(tier);
        // The state read and the Cookie header give the same tier.
        const told: ClassifiedValue[] = [];
        tellBrowserState({ cookies: [{ name, value, httpOnly }], origins: [] }, (item) => told.push(item), undefined, { visitor });
        expect(told.map((item) => item.tier), `state ${name}`).toEqual(tier === null ? [] : [tier]);
        expect(headerSecrets([{ name: "cookie", value: `${name}=${value}` }], { visitor }).map((item) => item.tier), `header ${name}`).toEqual(tier === null ? [] : [tier]);
      }
    }
  });
  it.each([["_ga"], ["optimizelyEndUserId"], ["__cf_bm"], ["_fbp"], ["_ttp"]])("%s with an opaque 32-character value is weak in the state read and in the Cookie header, owner and visitor; with a short one it is not registered", (name) => {
    for (const visitor of [false, true]) {
      const told: ClassifiedValue[] = [];
      tellBrowserState({ cookies: [{ name, value: OPAQUE, httpOnly: false }], origins: [] }, (item) => told.push(item), undefined, { visitor });
      expect(told, `state ${name}`).toEqual([{ value: OPAQUE, tier: "weak" }]);
      expect(headerSecrets([{ name: "cookie", value: `${name}=${OPAQUE}` }], { visitor }), `header ${name}`).toEqual([{ value: OPAQUE, tier: "weak" }]);
      expect(cookieTier({ name, value: "short", httpOnly: false }, visitor)).toBeNull();
      expect(cookieTier({ name, value: "GA1.2.3", httpOnly: true }, visitor)).toBeNull();
    }
  });
  it("a JWT under an analytics name stays strong", () => {
    for (const visitor of [false, true]) expect(cookieTier({ name: "_ga", value: JWT, httpOnly: false }, visitor)).toBe("strong");
  });
});

describe("F-2: the host's two sequences, through a real Chromium", () => {
  const haveChromium = existsSync(chromium.executablePath());
  const VISITOR = "visitor-3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  function recorder() {
    const learned: ClassifiedValue[] = [];
    const attached: Array<{ sessionRef: string; anonymous: boolean | undefined }> = [];
    const detached: string[] = [];
    const tracked: Array<Promise<unknown>> = [];
    const source: E2ESessionSyncSource = {
      read: async () => [], track: (promise) => { tracked.push(promise); }, learn: (items) => { learned.push(...items); },
      attach: (sessionRef, _reader, options) => { attached.push({ sessionRef, anonymous: options?.anonymous }); }, detach: (sessionRef) => { detached.push(sessionRef); },
    };
    return { source, learned, attached, detached, settle: async () => { await Promise.allSettled(tracked); } };
  }
  async function context(): Promise<{ origin: string; context: BrowserContext }> {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": `sb-abcdefgh-auth-token=base64-${b64(JSON.stringify({ access_token: JWT }))}; Path=/` });
      response.end(`<html><body><script>localStorage.setItem("visitor_id", "${VISITOR}"); localStorage.setItem("sb-abcdefgh-auth-token", JSON.stringify({ access_token: "${JWT}" }));</script></body></html>`);
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, context: await browser.newContext() };
  }

  it.skipIf(!haveChromium)("adoptCaseContext remembers the context and wires it, for a visitor and for a signed-in session alike; closeCaseContext takes it out, detaches it and reads it", async () => {
    for (const anonymous of [true, false]) {
      const { origin, context: browserContext } = await context();
      const contexts = new Map<string, BrowserContext>();
      const r = recorder();
      const registered: string[] = [];
      const sessionRef = anonymous ? "visitor-1" : "owned-1";
      const isAnonymous = (ref: string): boolean => ref === "visitor-1";
      adoptCaseContext({ contexts, sessionRef, browserContext, isAnonymous, sessionSync: r.source, registerSecret: (value) => registered.push(value) });
      expect(contexts.get(sessionRef), "remembered").toBe(browserContext);
      expect(r.attached, "attached").toEqual([{ sessionRef, anonymous }]);
      const page = await browserContext.newPage();
      await page.goto(`${origin}/`);
      await r.settle();
      // The Set-Cookie answer was watched: the Supabase session cookie is registered whoever the visitor is.
      expect(registered.length, `set-cookie ${sessionRef}`).toBe(1);
      await closeCaseContext({ contexts, sessionRef, isAnonymous, sessionSync: r.source });
      expect(contexts.has(sessionRef), "forgotten").toBe(false);
      expect(r.detached, "detached").toEqual([sessionRef]);
      // The close read learned the token the page stored; the visitor id only for a signed-in session.
      const values = r.learned.map((item) => item.value);
      expect(values, `close read ${sessionRef}`).toContain(JWT);
      expect(values.includes(VISITOR), `visitor id ${sessionRef}`).toBe(!anonymous);
      // A second close finds nothing and still detaches.
      await closeCaseContext({ contexts, sessionRef, isAnonymous, sessionSync: r.source });
      expect(r.detached).toEqual([sessionRef, sessionRef]);
    }
  }, 90_000);

  it.skipIf(!haveChromium)("closeCaseContext on a session that was never adopted reads nothing and does not throw", async () => {
    const r = recorder();
    await closeCaseContext({ contexts: new Map(), sessionRef: "none", isAnonymous: () => true, sessionSync: r.source });
    expect(r.learned).toEqual([]);
    expect(r.detached).toEqual(["none"]);
  });
});

describe("F-2: the host holds one plain statement for each sequence (syntax tree, not a regex)", () => {
  const source = readFileSync(new URL("../../packages/verifier/src/executor/host.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("host.ts", source, ts.ScriptTarget.ES2022, true);
  const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
  function calls(name: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node); ts.forEachChild(node, visit); };
    visit(file);
    return found;
  }
  /** Whether a node holds a return anywhere outside nested functions. */
  function exits(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => { if (found || isFunction(child)) return; if (ts.isReturnStatement(child)) { found = true; return; } ts.forEachChild(child, visit); };
    visit(node);
    return found;
  }
  it.each([["adoptCaseContext"], ["closeCaseContext"]])("%s is called once, as a statement of its own at the top level of its callback, after no return and no visitor condition", (name) => {
    const found = calls(name);
    expect(found).toHaveLength(1);
    const call = found[0]!;
    const statement = call.parent.kind === ts.SyntaxKind.AwaitExpression ? call.parent.parent : call.parent;
    expect(ts.isExpressionStatement(statement), "an expression statement").toBe(true);
    const block = statement.parent;
    expect(ts.isBlock(block), "directly in a block").toBe(true);
    expect(isFunction(block.parent), "the block is a function body").toBe(true);
    const before = (block as ts.Block).statements.filter((item) => item.pos < statement.pos);
    for (const item of before) {
      expect(exits(item), `no exit before it: ${item.getText(file).slice(0, 60)}`).toBe(false);
      expect((ts.isIfStatement(item) || ts.isTryStatement(item) || ts.isSwitchStatement(item)) && /isAnonymous/.test(item.getText(file)), `no visitor condition before it: ${item.getText(file).slice(0, 60)}`).toBe(false);
    }
  });
  it("the host no longer touches the context map itself, and does not name the lower functions", () => {
    expect(source).not.toMatch(/ownedContexts\.(set|get|delete)\(/);
    expect(source).not.toMatch(/wireCaseContext|readCaseContextAtClose|wireSessionContext/);
    expect(source).toMatch(/adoptCaseContext\(\{ contexts: ownedContexts, sessionRef, browserContext, isAnonymous: store\.isAnonymous, sessionSync, registerSecret \}\)/);
    expect(source).toMatch(/closeCaseContext\(\{ contexts: ownedContexts, sessionRef, isAnonymous: store\.isAnonymous, sessionSync \}\)/);
  });
});
