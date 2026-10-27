import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A small orders app for the generic account paths (Task 3.2): its users come from the seed command's records in ROVARA_DATA_DIR, it signs people in through its own form, and the
// owner of a tenant may export that tenant's orders. A viewer sees no export button and is refused the file, unless the seeded `viewer-access/v1` defect is switched on.
const root = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash("sha256").update(value, "utf8").digest();
const json = (status, value, headers = {}) => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(value) });
const cookieValue = (header, name) => String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const csvCell = (value) => { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function readDefect() {
  const path = process.env.ORDERS_TEST_DEFECT_FILE;
  if (!path) return null;
  const absolute = resolve(path);
  if (!absolute.startsWith(`${root}/.owned/`)) throw new Error("the defect file must be under the owned mount");
  const value = JSON.parse(readFileSync(absolute, "utf8"));
  const known = { "viewer-access/v1": "allow-viewer-export", "echo-session/v1": "show-session-token", "echo-email/v1": "show-account-email", "rotate-echo/v1": "rotate-session-and-show-it", "storage-echo/v1": "write-token-to-storage-and-show-it", "weak-echo/v1": "keep-opaque-id-in-storage-and-show-it" };
  if (known[value?.defectId] !== value?.mutation) throw new Error("unknown defect");
  return value;
}

export function createApplication({ users, orders, defect = null }) {
  const sessions = new Map();
  // The two echo defects are a careless page: it prints the session token, or the account's email, where only the name and role belong.
  const identityText = (token, account) => `${account.displayName} (${account.role})${defect?.defectId === "echo-session/v1" || defect?.defectId === "rotate-echo/v1" || defect?.defectId === "storage-echo/v1" || defect?.defectId === "weak-echo/v1" ? ` ${token}` : defect?.defectId === "echo-email/v1" ? ` ${account.email}` : ""}`;
  const canExport = (account) => account.role === "owner" || (defect?.defectId === "viewer-access/v1" && account.role === "viewer");
  const tokenOf = (request) => cookieValue(request.headers?.cookie, "sid");
  const accountFor = (request) => { const token = tokenOf(request); return token ? sessions.get(token) ?? null : null; };
  const rowsOf = (account) => orders.orders.filter((item) => item.tenantId === account.tenantId);
  function handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const url = new URL(String(request.url ?? "/"), "http://owned.invalid");
    if (method === "GET" && url.pathname === "/health") return json(200, { status: "ready" });
    if (method === "GET" && url.pathname === "/app.js") return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8" }, body: readFileSync(join(root, "public/app.js"), "utf8") };
    if (method === "GET" && url.pathname === "/") {
      // The page is rendered for the signed-in account (its name and role, never its email, its tenant's orders and the export button only when it may export), or shows the login form.
      const account = accountFor(request);
      // The rotate-echo defect: the app swaps the session cookie for a new one on every page (the old one stays valid) and prints the new one, as a careless app that rotates sessions might.
      let rotated = null;
      if (account !== null && defect?.defectId === "rotate-echo/v1") { rotated = randomBytes(32).toString("base64url"); sessions.set(rotated, account); }
      // The storage-echo defect: the page keeps a fresh token in local storage on every load (a refresh token the app issues while the case runs) and prints it, as a careless app might.
      const refresh = account !== null && defect?.defectId === "storage-echo/v1" ? randomBytes(24).toString("base64url") : null;
      // The weak-echo defect: the page keeps an opaque document id (20 letters and digits, under a neutral key: not a credential) in local storage and prints it. It is app data, not a secret.
      const documentId = account !== null && defect?.defectId === "weak-echo/v1" ? `Doc${randomBytes(12).toString("hex").slice(0, 17)}` : null;
      const section = account === null
        ? '<form id="login"><label>Email <input data-testid="email" name="email" autocomplete="username"></label><label>Password <input data-testid="password" name="password" type="password" autocomplete="current-password"></label><button data-testid="login-submit" type="submit">Sign in</button></form>'
        : `<p data-testid="identity"${refresh === null ? "" : ` data-refresh="${escapeHtml(refresh)}"`}${documentId === null ? "" : ` data-doc="${escapeHtml(documentId)}"`}>${escapeHtml(identityText(documentId ?? refresh ?? rotated ?? tokenOf(request), account))}</p>${canExport(account) ? '<button data-testid="export-csv" type="button">Export orders CSV</button>' : ""}`
          + `<table data-testid="orders-table"><tbody>${rowsOf(account).map((row) => `<tr data-testid="order-row-${escapeHtml(row.id)}"><td>${[row.id, row.customer, row.total, row.state].map((value) => escapeHtml(String(value))).join("</td><td>")}</td></tr>`).join("")}</tbody></table>`;
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...(rotated === null ? {} : { "set-cookie": `sid=${rotated}; HttpOnly; SameSite=Strict; Path=/` }) }, body: readFileSync(join(root, "public/index.html"), "utf8").replace("<!--ACCOUNT-->", section) };
    }
    if (method === "POST" && url.pathname === "/api/login") {
      const body = request.body;
      if (!body || typeof body.email !== "string" || typeof body.password !== "string") return json(400, { error: "invalid credentials" });
      const candidate = users.find((item) => item.email === body.email);
      const expected = candidate ? Buffer.from(candidate.passwordDigest, "hex") : Buffer.alloc(32);
      if (candidate === undefined || !timingSafeEqual(sha(body.password), expected)) return json(401, { error: "invalid credentials" });
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Object.freeze({ subjectId: candidate.subjectId, tenantId: candidate.tenantId, role: candidate.role, displayName: candidate.displayName, email: candidate.email }));
      return json(200, { displayName: candidate.displayName, role: candidate.role }, { "set-cookie": [`sid=${token}; HttpOnly; SameSite=Strict; Path=/`, "consent=1; Path=/", "ok=true; Path=/", "cookie_consent=accepted; Path=/", "theme=dark; Path=/"] });
    }
    const account = accountFor(request);
    if (method === "GET" && url.pathname === "/api/me") {
      return account ? json(200, { subjectId: account.subjectId, tenantId: account.tenantId, role: account.role, displayName: account.displayName, canExport: canExport(account) }) : json(401, { error: "authentication required" });
    }
    if (method === "GET" && url.pathname === "/api/orders") {
      return account ? json(200, { orders: rowsOf(account).map(({ id, customer, total, state }) => ({ id, customer, total, state })) }) : json(401, { error: "authentication required" });
    }
    if (method === "GET" && url.pathname === "/api/orders.csv") {
      if (!account) return json(401, { error: "authentication required" });
      if (!canExport(account)) return json(403, { error: "owner role required" });
      const lines = [["id", "customer", "total", "state"], ...rowsOf(account).map((row) => [row.id, row.customer, row.total, row.state])];
      return { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="orders.csv"' }, body: `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n` };
    }
    return json(404, { error: "not found" });
  }
  return Object.freeze({ handle });
}

export function startServer() {
  const dataDir = process.env.ROVARA_DATA_DIR;
  if (!dataDir) throw new Error("ROVARA_DATA_DIR is not set");
  const { users } = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8"));
  const app = createApplication({ users, orders: JSON.parse(readFileSync(join(root, "fixtures/orders.json"), "utf8")), defect: readDefect() });
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
