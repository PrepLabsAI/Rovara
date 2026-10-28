import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The MIDSTEP-2 carrier fixture: an app that signs people in through its own form (the accounts-app login) and that, when the page asks mid-step, hands the page a set of freshly issued values:
// a session cookie (Set-Cookie), a local storage token, a session storage token, a token inside a JSON blob, a `?token=` URL, an Authorization header, an IndexedDB token and one opaque id
// under a neutral key. The values are NOT in this repository: a test generates them at random for each run and writes them to the file named by CARRIERS_FILE (an owned mount in Docker,
// a temp file on a developer's machine). The file maps a case name to that case's own set of values (a set is used by one case only, so a case never sees a value an earlier case taught the run).
const root = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash("sha256").update(value, "utf8").digest();
const json = (status, value, headers = {}) => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(value) });
const cookieValue = (header, name) => String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const CARRIER_KEYS = ["cookie", "local", "session", "json", "url", "bearer", "idb", "weak"];

export function createApplication({ users, sets }) {
  const sessions = new Map();
  const tokenOf = (request) => cookieValue(request.headers?.cookie, "sid");
  const accountFor = (request) => { const token = tokenOf(request); return token ? sessions.get(token) ?? null : null; };
  function handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(String(request.url ?? "/"), "http://owned.invalid");
    if (method === "GET" && url.pathname === "/health") return json(200, { status: "ready" });
    if (method === "GET" && url.pathname === "/app.js") return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8" }, body: readFileSync(join(root, "public/app.js"), "utf8") };
    if (method === "GET" && url.pathname === "/") {
      const account = accountFor(request);
      const section = account === null
        ? '<form id="login"><label>Email <input data-testid="email" name="email" autocomplete="username"></label><label>Password <input data-testid="password" name="password" type="password" autocomplete="current-password"></label><button data-testid="login-submit" type="submit">Sign in</button></form>'
        : `<p data-testid="identity">${escapeHtml(`${account.displayName} (${account.role})`)}</p>`
          + '<div data-testid="sync-buttons">' + ["control", "cookie", "local", "session", "json", "url", "bearer", "idb", "weak"].map((name) => `<button type="button" data-sync="${name}" data-testid="sync-${name}">${name === "control" ? "Sync quietly" : `Sync and show ${name}`}</button>`).join("") + "</div>"
          + '<p data-testid="panel">Nothing synced yet</p>';
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: readFileSync(join(root, "public/index.html"), "utf8").replace("<!--ACCOUNT-->", section) };
    }
    if (method === "POST" && url.pathname === "/api/login") {
      const body = request.body;
      if (!body || typeof body.email !== "string" || typeof body.password !== "string") return json(400, { error: "invalid credentials" });
      const candidate = users.find((item) => item.email === body.email);
      const expected = candidate ? Buffer.from(candidate.passwordDigest, "hex") : Buffer.alloc(32);
      if (candidate === undefined || !timingSafeEqual(sha(body.password), expected)) return json(401, { error: "invalid credentials" });
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Object.freeze({ subjectId: candidate.subjectId, tenantId: candidate.tenantId, role: candidate.role, displayName: candidate.displayName, email: candidate.email }));
      return json(200, { displayName: candidate.displayName, role: candidate.role }, { "set-cookie": [`sid=${token}; HttpOnly; SameSite=Strict; Path=/`] });
    }
    const account = accountFor(request);
    if (method === "GET" && url.pathname === "/api/me") {
      return account ? json(200, { subjectId: account.subjectId, tenantId: account.tenantId, role: account.role, displayName: account.displayName, canExport: false }) : json(401, { error: "authentication required" });
    }
    // The mid-step acquisition: the app issues the case's own set of values. The session cookie is swapped for a new one (the old one stays valid), as an app that rotates sessions does.
    if (method === "POST" && url.pathname === "/api/acquire") {
      if (!account) return json(401, { error: "authentication required" });
      const set = sets[String(request.body?.case ?? "")];
      if (!set || !CARRIER_KEYS.every((key) => typeof set[key] === "string" && set[key] !== "")) return json(404, { error: "unknown case" });
      sessions.set(set.cookie, account);
      return json(200, set, { "set-cookie": [`sid=${set.cookie}; HttpOnly; SameSite=Strict; Path=/`] });
    }
    // The page calls this with the Authorization header it was just issued; the app accepts anything (the header is what the test is about).
    if (method === "GET" && url.pathname === "/api/ping") return json(200, { ok: true });
    return json(404, { error: "not found" });
  }
  return Object.freeze({ handle });
}

export function startServer() {
  const dataDir = process.env.ROVARA_DATA_DIR;
  if (!dataDir) throw new Error("ROVARA_DATA_DIR is not set");
  const file = process.env.CARRIERS_FILE;
  if (!file) throw new Error("CARRIERS_FILE is not set");
  const { users } = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8"));
  const app = createApplication({ users, sets: JSON.parse(readFileSync(resolve(file), "utf8")) });
  const port = Number(process.env.APP_PORT ?? 4317);
  const server = createServer((request, response) => {
    const chunks = []; let bytes = 0;
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 65_536) chunks.push(chunk); else request.destroy(); });
    request.on("end", () => {
      let body;
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; } }
      const result = app.handle({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(result.status, result.headers).end(result.body);
    });
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
