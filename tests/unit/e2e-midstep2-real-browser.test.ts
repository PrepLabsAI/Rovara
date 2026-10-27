import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlaywrightFormLoginDriver } from "../../packages/verifier/src/executor/form-login.js";
import { readBrowserState } from "../../packages/verifier/src/executor/browser-state-reader.js";
import { tellBrowserState } from "../../packages/verifier/src/executor/browser-state-secrets.js";
import type { ClassifiedValue } from "../../packages/verifier/src/executor/credential-classifier.js";
import { watchBrowserRequests } from "../../packages/verifier/src/executor/request-capture.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { createMidstep2Harness } from "../support/e2e-midstep2-harness.js";

// MIDSTEP-2 against a real Chromium: a page that keeps its login in session storage, IndexedDB and local JSON, calls its API with an Authorization header, and lands on a URL with a token in its fragment. The reader, the request capture and the form-login
// driver are the real ones. Skipped where no Chromium is installed (CI's linux image has one).

const haveChromium = existsSync(chromium.executablePath());
const JWT = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"user-1234567890"}').toString("base64url")}.c2lnbmF0dXJlLWJ5dGVzLWhlcmU`;
const IDB_TOKEN = "Mn4bV7cX1zL9kJ2hG5fD8sA3qW6eR0tY";
const JSON_TOKEN = "tok_live_9f8e7d6c5b4a3928";
const BEARER = "Qe5rT8yU1iO4pA7sD0fG3hJ6kL9zXcVb";
const API_KEY = "key-abcdef0123456789";
const FRAGMENT = "Wx2cV5bN8mQ1aZ4sE7dR0fT3gY6hU9jI";

const PAGE = `<!doctype html><html><body><h1>Orders</h1><script>
  sessionStorage.setItem("msal.idtoken", ${JSON.stringify(JWT)});
  sessionStorage.setItem("draftTitle", "Quarterly report for ACME");
  localStorage.setItem("persist:root", JSON.stringify({ user: "maya", token: ${JSON.stringify(JSON_TOKEN)} }));
  const open = indexedDB.open("firebaseLocalStorageDb", 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("firebaseLocalStorage", { keyPath: "fbase_key" }); };
  open.onsuccess = () => {
    const tx = open.result.transaction("firebaseLocalStorage", "readwrite");
    tx.objectStore("firebaseLocalStorage").put({ fbase_key: "firebase:authUser:KEY", value: { accessToken: ${JSON.stringify(IDB_TOKEN)}, displayName: "Maya" } });
    tx.oncomplete = () => {
      fetch("/api/orders", { headers: { Authorization: "Bearer " + ${JSON.stringify(BEARER)}, "X-API-Key": ${JSON.stringify(API_KEY)} } }).then(() => { window.__done = true; });
    };
  };
</script></body></html>`;

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { cleanRedirectingEnvironment(); dir = await mkdtemp(join(tmpdir(), "m2rb-")); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); });
const harness = createMidstep2Harness({ dir: () => dir, closers });

async function app(): Promise<string> {
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe.skipIf(!haveChromium)("the real browser", () => {
  it("every place the page keeps or sends a login secret reaches the worker's scan before the next model call (and the draft beside them does not)", async () => {
    const origin = await app();
    const browser: Browser = await chromium.launch();
    closers.push(() => browser.close());
    const context = await browser.newContext();
    const learned: ClassifiedValue[] = [];
    const pending: Array<Promise<unknown>> = [];
    watchBrowserRequests(context, { learn: (items) => learned.push(...items), track: (read) => pending.push(read) });
    const page = await context.newPage();
    await page.goto(origin + "/");
    await page.waitForFunction("window.__done === true");
    await page.goto(`${origin}/callback#access_token=${FRAGMENT}&token_type=bearer`);
    await Promise.all(pending);
    // Each secret gets a step of its own (a refusal latches a step). Positive control first: nothing the page shows is secret, and the call reaches the model.
    for (const [where, secret] of [["session storage", JWT], ["IndexedDB", IDB_TOKEN], ["a token inside local JSON", JSON_TOKEN], ["the Authorization header", BEARER], ["the X-API-Key header", API_KEY], ["the URL fragment", FRAGMENT]]) {
      const e = await harness.executor();
      e.source.learn(learned);
      e.source.attach("s2", { storageState: () => readBrowserState(context) }, { anonymous: false });
      expect((await e.workerSays("Orders for Maya, Quarterly report for ACME")).status, where).toBe("ok");
      expect(e.run.seen, where).toHaveLength(1);
      expect(await e.workerSays(`Shown: ${secret}`), where).toMatchObject({ status: "error", code: "refused-credential-match" });
      expect(e.run.seen, where).toHaveLength(1);
    }
  });

  it("the form-login driver reports the sign-in's request headers and returns session storage, IndexedDB and the URLs", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "m2cdp-"));
    const child: ChildProcess = spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
    closers.push(async () => { child.kill(); rmSync(userDir, { recursive: true, force: true }); });
    for (let attempt = 0; attempt < 100 && !existsSync(join(userDir, "DevToolsActivePort")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const port = readFileSync(join(userDir, "DevToolsActivePort"), "utf8").split("\n")[0];
    const observed: string[] = [];
    // The page of this test has no login form; the driver's sign-in needs one, so the page below has the fields the driver fills and the same scripts.
    const form = `<!doctype html><html><body><input data-testid="u"><input data-testid="p" type="password"><button data-testid="go" id="go">Go</button><div data-testid="ok" style="display:none">in</div>
      <script>document.getElementById("go").onclick = () => { ${PAGE.match(/<script>([\s\S]*)<\/script>/)![1]!.replace("window.__done = true;", "document.querySelector('[data-testid=ok]').style.display='block';")} };</script></body></html>`;
    const server: Server = createServer((request, response) => {
      if (request.url?.startsWith("/api/")) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
      response.writeHead(200, { "content-type": "text/html" }); response.end(form);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const formOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const driver = createPlaywrightFormLoginDriver({ cdpEndpoint: `http://127.0.0.1:${port}`, guard: async () => undefined });
    const signedIn = await driver.signIn({ origin: formOrigin, login: { path: "/", usernameTestId: "u", passwordTestId: "p", submitTestId: "go", successTestId: "ok" } as never, email: "maya@example.com", password: "pw-1234567890", signal: new AbortController().signal,
      observe: (items) => { for (const item of items) observed.push(item.value); } });
    const told: string[] = [];
    tellBrowserState(signedIn.state, (item) => { if (item.tier === "strong") told.push(item.value); });
    for (const secret of [JWT, IDB_TOKEN, JSON_TOKEN]) expect(told, secret).toContain(secret);
    expect(observed).toEqual(expect.arrayContaining([BEARER, API_KEY]));
  });
});
