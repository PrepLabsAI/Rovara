import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash("sha256").update(value, "utf8").digest();
const json = (status, value, headers = {}) => ({ status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(value) });
// A cell that a spreadsheet would read as a formula is prefixed with a quote; a cell with a separator is quoted.
const csvCell = (value) => {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const tableCsv = (header, rows) => [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
const csvResponse = (filename, body) => ({ status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` }, body });
const cookieValue = (header, name) => String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const STOCK_STATUSES = new Set(["in-stock", "low", "out"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value) => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export function createOrdersApplication({ seed, orders, fetchDependency = async () => ({ status: 200, body: { healthy: true } }) }) {
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
  const sessions = new Map();
  const staticFiles = new Map([["/", "public/index.html"], ["/app.js", "public/app.js"]]);
  function accountFor(request) {
    const token = cookieValue(request.headers?.cookie, "orders_session");
    return token ? sessions.get(token) ?? null : null;
  }
  // The inventory service answers one order at a time. Anything but a well-formed stock status reads as "unavailable".
  async function stockStatus(orderId, request) {
    try {
      const result = await fetchDependency("inventory-v1", `/v1/stock?orderId=${encodeURIComponent(orderId)}`, request);
      const status = result.body?.status;
      return result.status === 200 && STOCK_STATUSES.has(status) ? status : "unavailable";
    } catch { return "unavailable"; }
  }
  async function tenantOrders(account, request) {
    const own = orders.orders.filter((item) => item.tenantId === account.tenantId);
    const inventory = await Promise.all(own.map((item) => stockStatus(item.id, request)));
    return own.map((item, index) => ({ ...item, inventory: inventory[index] }));
  }
  async function handle(request) {
    const method = String(request.method ?? "GET").toUpperCase();
    const rawUrl = String(request.url ?? "/");
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return json(400, { error: "relative path required" });
    const url = new URL(rawUrl, "http://owned.invalid");
    if (url.origin !== "http://owned.invalid" || url.hash) return json(400, { error: "canonical path required" });
    if (url.search && !(method === "GET" && url.pathname === "/api/orders.csv")) return json(400, { error: "canonical path required" });
    if (method === "GET" && staticFiles.has(url.pathname)) return { status: 200, headers: { "content-type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }, body: readFileSync(join(root, staticFiles.get(url.pathname)), "utf8") };
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
      return account ? json(200, { subjectId: account.subjectId, tenantId: account.tenantId, role: account.role, displayName: account.displayName }) : json(401, { error: "authentication required" });
    }
    if (method === "GET" && url.pathname === "/api/orders.csv") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      if (account.role !== "owner") return json(403, { error: "owner role required" });
      const keys = [...url.searchParams.keys()];
      const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
      if (keys.some((key) => key !== "from" && key !== "to") || new Set(keys).size !== keys.length
        || (from !== null && !validDay(from)) || (to !== null && !validDay(to))) return json(400, { error: "from and to must be dates" });
      const rows = (await tenantOrders(account, request)).filter((item) => (from === null || item.placedOn >= from) && (to === null || item.placedOn <= to));
      return csvResponse("orders.csv", tableCsv(["id", "customer", "total", "state", "inventory"], rows.map((row) => [row.id, row.customer, row.total, row.state, row.inventory])));
    }
    // fixture-variant:local-only:begin
    if (method === "GET" && url.pathname === "/api/invoices.csv") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      if (account.role !== "owner") return json(403, { error: "owner role required" });
      const rows = orders.orders.filter((item) => item.tenantId === account.tenantId);
      return csvResponse("invoices.csv", tableCsv(["invoice", "customer", "amount", "status"], rows.map((row) => [`inv-${row.id}`, row.customer, row.total, "paid"])));
    }
    // fixture-variant:local-only:end
    if (method === "GET" && url.pathname === "/api/orders/state") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      return json(200, { ...orders.state });
    }
    const tenantPath = /^\/api\/tenants\/([^/]+)\/orders$/.exec(url.pathname);
    if (method === "GET" && tenantPath) {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      if (tenantPath[1] !== account.tenantId) return json(403, { error: "tenant access refused" });
      return json(200, { orders: (await tenantOrders(account, request)).map(({ id, customer, total, state, inventory }) => ({ id, customer, total, state, inventory })) });
    }
    if (method === "GET" && url.pathname === "/api/inventory/status") {
      const account = accountFor(request);
      if (!account) return json(401, { error: "authentication required" });
      const result = await fetchDependency("inventory-v1", "/health", request);
      return result.status === 200 ? json(200, result.body) : json(502, { error: "inventory dependency unavailable" });
    }
    return json(404, { error: "not found" });
  }
  return Object.freeze({ handle, sessionCount: () => sessions.size });
}

function readOptionalJson(path) {
  if (!path) return null;
  const absolute = resolve(path);
  if (!absolute.startsWith(root + "/.owned/")) throw new Error("runtime seed input must be under the owned application data mount");
  return JSON.parse(readFileSync(absolute, "utf8"));
}

const INVENTORY_PATH = /^(?:\/health|\/v1\/stock\?orderId=[A-Za-z0-9_-]{1,64})$/;

export function startOrdersServer() {
  const fixtureOrders = JSON.parse(readFileSync(join(root, "fixtures/orders.json"), "utf8"));
  const seed = readOptionalJson(process.env.ORDERS_TEST_SEED_FILE);
  const app = createOrdersApplication({ seed, orders: fixtureOrders,
    fetchDependency: async (originRef, path) => {
      if (originRef !== "inventory-v1" || !INVENTORY_PATH.test(path) || !process.env.INVENTORY_ORIGIN) return { status: 503, body: {} };
      const response = await fetch(new URL(path, process.env.INVENTORY_ORIGIN), { signal: AbortSignal.timeout(5000) });
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
