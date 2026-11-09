// A REAL Playwright trace for the trace-scrub tests (Opus review C2: hand-built JSON lines hid what a real trace holds). A local app serves a login that answers with a JSON token, a page that keeps that token in
// localStorage, sends it in an Authorization header and in a custom header, loads a resource with a token in its query string, and shows the token on the page. The round's session cookie and a localStorage token
// are applied to the context BEFORE tracing starts (as the executor's host does), and one request carries the cookie. Every secret below is fake and built from parts, so no scanner takes it for a key.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const part = (...pieces: string[]) => pieces.join("");
export const TRACE_SECRETS = {
  sessionCookie: part("sessck", "-a1b2c3d4e5f6a7b8c9d0"),
  localStorageToken: part("lsjwt", ".eyJzdWIiOiJyb3ZhcmEtdGVzdCJ9.", "sig9f8e7d6c5b4a"),
  loginIdToken: part("idtok", "-5e4d3c2b1a09f8e7d6c5b4a3"),
  loginRefreshToken: part("rftok", "-0a9b8c7d6e5f4a3b2c1d0e9f"),
  queryToken: part("qtok", "-77aa88bb99cc00dd11ee"),
  customHeader: part("xsess", "-31415926535897932384"),
  bearer: part("bearer", "-27182818284590452353"),
  signedQuery: part("sig", "-16180339887498948482"),
  password: part("Pw", "-hunter2-planted-4242"),
} as const;

const PAGE = `<!doctype html><meta charset="utf-8"><title>round</title><body><h1 id="who">checking</h1><pre id="shown"></pre><script>
(async () => {
  const login = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "buyer", password: "${TRACE_SECRETS.password}" }) });
  const tokens = await login.json();
  localStorage.setItem("id_token", tokens.id_token);
  const me = await fetch("/api/me?access_token=${TRACE_SECRETS.queryToken}", { headers: { authorization: "Bearer " + tokens.id_token, "x-session": "${TRACE_SECRETS.customHeader}", accept: "application/json" } });
  await me.json();
  await fetch("/asset.json?sig=${TRACE_SECRETS.signedQuery}#frag-${TRACE_SECRETS.signedQuery}");
  document.getElementById("who").textContent = "signed in";
  document.getElementById("shown").textContent = "token " + tokens.id_token;
})();
</script></body>`;

/** The Chromium this repository's pinned Playwright can launch, or undefined (a host without a browser). */
async function launch() {
  try { return await chromium.launch(); } catch { return undefined; }
}

/** Records the trace of one round on a local app and returns the zip, or undefined when no browser can be launched here. */
export async function recordRealTrace(options: { traceBeforeAuth?: boolean } = {}): Promise<Buffer | undefined> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html", "set-cookie": `rotated=${TRACE_SECRETS.sessionCookie}-rot; HttpOnly` }); response.end(PAGE); return; }
    if (url.pathname === "/login") {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": `session=${TRACE_SECRETS.sessionCookie}; HttpOnly` });
      response.end(JSON.stringify({ id_token: TRACE_SECRETS.loginIdToken, refresh_token: TRACE_SECRETS.loginRefreshToken, expires_in: 3600 }));
      return;
    }
    if (url.pathname === "/api/me") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ name: "buyer" })); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const browser = await launch();
  if (browser === undefined) { server.close(); return undefined; }
  const dir = await mkdtemp(join(tmpdir(), "real-trace-"));
  try {
    const context = await browser.newContext();
    const startTracing = () => context.tracing.start({ screenshots: true, snapshots: true });
    // The wrong order, for the positive control: tracing first records the init script call with the token in its arguments.
    if (options.traceBeforeAuth === true) await startTracing();
    // The round's auth, applied as the executor host does it, BEFORE tracing starts: a cookie and a localStorage token.
    await context.addCookies([{ name: "orders", value: TRACE_SECRETS.sessionCookie, url: `http://127.0.0.1:${port}` }]);
    await context.addInitScript(({ token }) => { (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("round_token", token); }, { token: TRACE_SECRETS.localStorageToken });
    if (options.traceBeforeAuth !== true) await startTracing();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById("who")?.textContent === "signed in");
    const path = join(dir, "trace.zip");
    await context.tracing.stop({ path });
    return await readFile(path);
  } finally {
    await browser.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
