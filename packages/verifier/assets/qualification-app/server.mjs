import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash("sha256").update(value, "utf8").digest();
const json = (status, value, headers = {}) => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(value) });
const csvCell = (value) => { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
const csv = (rows) => ["id,customer,total,state", ...rows.map((row) => [row.id, row.customer, row.total, row.state].map(csvCell).join(","))].join("\r\n") + "\r\n";
const csvWithInventory = (rows) => ["id,customer,total,state,inventory", ...rows.map((row) => [row.id, row.customer, row.total, row.state, row.inventory].map(csvCell).join(","))].join("\r\n") + "\r\n";
const cookieValue = (header, name) => String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

function validDefect(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture defect must be a fixed data record");
  const allowed = {
    "extra-order/v1": ["defectId", "mutation", "order"],
    "viewer-access/v1": ["defectId", "mutation"],
    "state-contract/v1": ["defectId", "mutation", "version"],
    "dependency-route/v1": ["defectId", "mutation", "path"],
    "swallow-dependency/v1": ["defectId", "mutation"],
  };
  const expectedMutation = { "extra-order/v1": "append-order", "viewer-access/v1": "allow-viewer-export",
    "state-contract/v1": "change-state-version", "dependency-route/v1": "request-wrong-health-path",
    "swallow-dependency/v1": "ignore-dependency-failure" };
  if (!allowed[value.defectId] || expectedMutation[value.defectId] !== value.mutation
    || Object.keys(value).some((key) => !allowed[value.defectId].includes(key))) throw new Error("fixture defect is not in the fixed causal defect registry");
  if (value.defectId === "extra-order/v1" && (!value.order || value.order.id !== "a3" || value.order.tenantId !== "tenant-a" || value.order.state !== "ready")) throw new Error("extra-order defect does not bind the fixed out-of-range row");
  if (value.defectId === "state-contract/v1" && value.version !== 2) throw new Error("state-contract defect does not bind its fixed incorrect version");
  if (value.defectId === "dependency-route/v1" && value.path !== "/internal/admin") throw new Error("dependency-route defect does not bind its fixed wrong path");
  return value;
}

// Optional third-party references for egress tests. They are plain https URLs from the environment, injected as a
// stylesheet link and as the target of the page's outbound probe; neither is set in normal use.
function externalUrl(name) {
  const value = process.env[name];
  if (!value) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${name} must be an https URL`);
  return parsed.href;
}
function withOptionalExternals(html) {
  const font = externalUrl("FIXTURE_EXTERNAL_FONT");
  const probe = externalUrl("FIXTURE_EGRESS_PROBE_URL");
  let result = html;
  if (font) result = result.replace("</head>", `<link rel="stylesheet" href="${font}"></head>`);
  if (probe) result = result.replace("</head>", `<meta name="egress-probe" content="${probe}"></head>`);
  return result;
}

export function createOrdersApplication({ seed, orders, defect: rawDefect = null, fetchDependency = async () => ({ status: 200, body: { healthy: true } }) }) {
  if (!seed || !Array.isArray(seed.accounts) || seed.accounts.length < 1 || seed.accounts.length > 32
    || !Array.isArray(orders?.orders) || !orders.state) throw new Error("orders application requires the owned seed and fixture records");
  const accountEmails = new Set(); const subjectIds = new Set();
  for (const account of seed.accounts) {
    if (!account || typeof account.email !== "string" || account.email.length > 256 || !/^[a-f0-9]{64}$/.test(account.passwordDigest)
      || typeof account.subjectId !== "string" || typeof account.tenantId !== "string" || !["owner", "viewer"].includes(account.role)
      || typeof account.displayName !== "string" || account.displayName.length > 120 || accountEmails.has(account.email) || subjectIds.has(account.subjectId)) {
      throw new Error("owned seed account inventory is malformed or duplicated");
    }
    accountEmails.add(account.email); subjectIds.add(account.subjectId);
  }
  const defect = validDefect(rawDefect);
  const sessions = new Map();
  const staticFiles = new Map([["/", "public/index.html"], ["/app.js", "public/app.js"]]);
  function accountFor(request) {
    const token = cookieValue(request.headers?.cookie, "orders_session");
    return token ? sessions.get(token) ?? null : null;
  }
  async function handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const rawUrl = String(request.url ?? "/");
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return json(400, { error: "relative path required" });
    const url = new URL(rawUrl, "http://owned.invalid");
    if (url.origin !== "http://owned.invalid" || url.search || url.hash) return json(400, { error: "canonical path required" });
    if (method === "GET" && staticFiles.has(url.pathname)) {
      const text = readFileSync(join(root, staticFiles.get(url.pathname)), "utf8");
      return { status: 200, headers: { "content-type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" },
        body: url.pathname === "/" ? withOptionalExternals(text) : text };
    }
    if (method === "GET" && url.pathname === "/health") return json(200, { status: "ready" });
    if (method === "POST" && url.pathname === "/api/login") {
      const body = request.body;
      if (!body || typeof body.email !== "string" || typeof body.password !== "string" || body.email.length > 256 || body.password.length > 256) return json(400, { error: "invalid credentials" });
      const candidate = seed.accounts.find((item) => item.email === body.email);
      const supplied = sha(body.password);
      const expected = candidate && /^[a-f0-9]{64}$/.test(candidate.passwordDigest) ? Buffer.from(candidate.passwordDigest, "hex") : Buffer.alloc(32);
      const matches = timingSafeEqual(supplied, expected) && candidate !== undefined;
      if (!matches) return json(401, { error: "invalid credentials" });
      const token = randomBytes(32).toString("base64url");
      const session = Object.freeze({ subjectId: candidate.subjectId, tenantId: candidate.tenantId, role: candidate.role, displayName: candidate.displayName });
      sessions.set(token, session);
      return json(200, { displayName: session.displayName, role: session.role }, { "set-cookie": `orders_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (method === "POST" && url.pathname === "/api/logout") {
      const token = cookieValue(request.headers?.cookie, "orders_session");
      if (token) sessions.delete(token);
      return json(204, null, { "set-cookie": "orders_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }
    if (method === "GET" && url.pathname === "/api/me") {
      const account = accountFor(request);
      return account ? json(200, { subjectId: account.subjectId, tenantId: account.tenantId, role: account.role }) : json(401, { error: "authentication required" });
    }
    if (method === "GET" && url.pathname === "/api/orders.csv") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      const viewerBypass = defect?.defectId === "viewer-access/v1" && account.role === "viewer";
      if (account.role !== "owner" && !viewerBypass) return json(403, { error: "owner role required" });
      let rows = orders.orders.filter((item) => item.tenantId === account.tenantId);
      if (defect?.defectId === "extra-order/v1") rows = [...rows, defect.order];
      return { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="orders.csv"' }, body: csv(rows) };
    }
    if (method === "GET" && url.pathname === "/api/orders-inventory.csv") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      if (account.role !== "owner") return json(403, { error: "owner role required" });
      // One call to the external inventory origin per order; an order the service refuses is shown as unavailable.
      const rows = [];
      for (const order of orders.orders.filter((item) => item.tenantId === account.tenantId)) {
        const result = await fetchDependency("inventory-v1", `/v1/stock?orderId=${encodeURIComponent(order.id)}`, request);
        rows.push({ ...order, inventory: result.status === 200 && typeof result.body?.status === "string" ? result.body.status : "unavailable" });
      }
      return { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="orders-inventory.csv"' }, body: csvWithInventory(rows) };
    }
    if (method === "GET" && url.pathname === "/api/orders/state") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      const state = { ...orders.state };
      if (defect?.defectId === "state-contract/v1") state.version = defect.version;
      return json(200, state);
    }
    const tenantPath = /^\/api\/tenants\/([^/]+)\/orders$/.exec(url.pathname);
    if (method === "GET" && tenantPath) {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      if (tenantPath[1] !== account.tenantId) return json(403, { error: "tenant access refused" });
      return json(200, { orders: orders.orders.filter((item) => item.tenantId === account.tenantId).map(({ id, customer, total, state }) => ({ id, customer, total, state })) });
    }
    if (method === "GET" && (url.pathname === "/api/inventory/status" || url.pathname === "/inventory")) {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      // The inventory service is an external origin: the approved mock answers `GET /v1/stock?orderId=a1` with the order's stock status.
      const path = defect?.defectId === "dependency-route/v1" ? defect.path : "/v1/stock?orderId=a1";
      const result = await fetchDependency("inventory-v1", path, request);
      // The seeded defect hides a failed dependency behind a plausible answer, so the page looks right while the call it made was never approved.
      const stock = result.status === 200 ? result.body : defect?.defectId === "swallow-dependency/v1" ? { status: "in-stock" } : null;
      if (url.pathname === "/api/inventory/status") return stock === null ? json(502, { error: "inventory dependency unavailable" }) : json(200, stock);
      // The page is a navigation of its own, so the browser has the answer when the click that asked for it returns.
      const shown = stock === null ? "unavailable" : String(stock.status ?? "unavailable").replace(/[^A-Za-z0-9 _-]/g, "");
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inventory</title></head><body><main><h1>Inventory</h1><p data-testid="inventory-status">${shown}</p></main></body></html>` };
    }
    return json(404, { error: "not found" });
  }
  return Object.freeze({ handle, sessionCount: () => sessions.size });
}

function readOptionalJson(path) {
  if (!path) return null;
  const absolute = resolve(path);
  if (!absolute.startsWith(root + "/.owned/")) throw new Error("runtime seed or defect input must be under the owned application data mount");
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export function startOrdersServer() {
  const fixtureOrders = JSON.parse(readFileSync(join(root, "fixtures/orders.json"), "utf8"));
  const seed = readOptionalJson(process.env.ORDERS_TEST_SEED_FILE);
  const defect = readOptionalJson(process.env.ORDERS_TEST_DEFECT_FILE);
  const app = createOrdersApplication({ seed, orders: fixtureOrders, defect,
    fetchDependency: async (originRef, path) => {
      // `INVENTORY_ORIGIN` is set by the host to this run's own mock (or sinkhole); `FIXTURE_INVENTORY_ORIGIN` lets an egress test aim the app at an outside host.
      const origin = process.env.FIXTURE_INVENTORY_ORIGIN ?? process.env.INVENTORY_ORIGIN;
      if (originRef !== "inventory-v1" || !path.startsWith("/") || !origin) return { status: 503, body: {} };
      const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5_000) });
      let body = {}; try { body = await response.json(); } catch { /* malformed dependency remains unavailable */ }
      return { status: response.status, body };
    },
  });
  const port = Number(process.env.APP_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("APP_PORT is outside the approved source service range");
  const server = createServer((request, response) => {
    let bytes = 0; const chunks = [];
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 65_536) chunks.push(chunk); else request.destroy(); });
    request.on("end", async () => {
      let body = undefined;
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; } }
      try {
        const result = await app.handle({ method: request.method, url: request.url, headers: request.headers, body });
        response.writeHead(result.status, result.headers).end(result.body);
      } catch { response.writeHead(500, { "content-type": "application/json" }).end('{"error":"request failed"}'); }
    });
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startOrdersServer();
