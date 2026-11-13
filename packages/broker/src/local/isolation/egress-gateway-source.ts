// Port lane L4b: the egress gateway of one local worker.
// This is the program that runs inside the helper container (`node -e`), kept as text so the broker needs no build step for it and
// tests can run the very same text. It uses only Node built-ins. Edit it here; there is no other copy.
export const EGRESS_GATEWAY_SOURCE = String.raw`"use strict";
// Rovara local egress gateway (lane L4b). One per worker. Runs in a container on three Docker networks:
//   worker network   (internal): the worker. Name server, web forwarder, callback relay.
//   sandbox network  (internal): the task sandboxes. Name server and web forwarder only.
//   external network (bridge):   the way out to the internet, and the published port the broker reaches the worker through.
// Neither internal network has a route, a gateway address or a host address, so a container on it can reach only what is
// on the same network. This process is the one way out: it answers names only for the allow-listed domains (everything
// else is NXDOMAIN, as the DNS firewall does on EC2), forwards port 443 by the name in the TLS hello and port 80 by the
// Host header, and connects only to public addresses it resolved and checked itself.
const net = require("net");
const dgram = require("dgram");
const http = require("http");
const dns = require("dns");
const os = require("os");

const config = JSON.parse(process.env.ROVARA_GW_CONFIG || "{}");
const LIMITS = Object.assign({ maxConnections: 1024, idleMs: 600000, connectMs: 15000, helloMs: 10000, maxBodyBytes: 16777216 }, config.limits || {});
const ALLOWED = (config.allowed || []).map(function (entry) { return String(entry).toLowerCase(); });
// Names the SANDBOX network may not reach even when they are on the list (the model hosts: a product's model call goes through the model bridge with the user's own key, never straight out). The worker's network ignores it.
const SANDBOX_DENIED = (config.sandboxDenied || []).map(function (entry) { return String(entry).toLowerCase(); });
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const stats = { dnsAllowed: 0, dnsRefused: 0, webAllowed: 0, webRefused: 0 };

// ---- logging: refusals only, at most 40 lines a minute, names cleaned (a name is repository-controlled text)
const QUIET = process.env.ROVARA_GW_LIBRARY === "1"; // loaded as a library by the tests: say nothing
// Library mode only: the tests open the 443 and 80 forwarders on a port of their own (0 for any free one). A running gateway always uses 443 and 80.
const TLS_PORT = QUIET && process.env.ROVARA_GW_TLS_PORT !== undefined ? Number(process.env.ROVARA_GW_TLS_PORT) : 443;
const PLAIN_PORT = QUIET && process.env.ROVARA_GW_PLAIN_PORT !== undefined ? Number(process.env.ROVARA_GW_PLAIN_PORT) : 80;
const TEST_ADDRESSES = QUIET ? process.env.ROVARA_GW_TEST_ADDRESSES : undefined;
const DNS_PORT = QUIET && process.env.ROVARA_GW_DNS_PORT !== undefined ? Number(process.env.ROVARA_GW_DNS_PORT) : 53;
let logged = 0;
let logWindow = Date.now();
function log(event, fields) {
  if (QUIET) return;
  const now = Date.now();
  if (now - logWindow > 60000) { logWindow = now; logged = 0; }
  if (++logged > 40) return;
  const line = Object.assign({ component: "egress-gateway", event: event }, fields || {});
  if (typeof line.host === "string") line.host = line.host.replace(/[^a-z0-9.*-]/gi, "?").slice(0, 100);
  process.stdout.write(JSON.stringify(line) + "\n");
}

// ---- names and the allow-list
function validName(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  for (let i = 0; i < labels.length; i++) if (!LABEL.test(labels[i])) return false;
  // A real top-level name has a letter, so 127.1, 0x7f.1 and 2130706433 are never names.
  return /[a-z]/.test(labels[labels.length - 1]);
}
function listCovers(list, host) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry.charAt(0) === "*" && entry.charAt(1) === ".") {
      const suffix = entry.slice(1);
      if (host.length > suffix.length && host.endsWith(suffix)) return true;
    } else if (host === entry) return true;
  }
  return false;
}
function hostAllowed(host, role) {
  if (!validName(host)) return false;
  // Fail closed: only a caller that says exactly "worker" is exempt from the sandbox deny, so a missing or odd role is a sandbox.
  if (role !== "worker" && listCovers(SANDBOX_DENIED, host)) return false;
  for (let i = 0; i < ALLOWED.length; i++) {
    const entry = ALLOWED[i];
    if (entry.charAt(0) === "*" && entry.charAt(1) === ".") {
      const suffix = entry.slice(1);
      if (host.length > suffix.length && host.endsWith(suffix)) return true;
    } else if (host === entry) return true;
  }
  return false;
}

// ---- addresses
function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (!/^[0-9]{1,3}$/.test(parts[i]) || Number(parts[i]) > 255) return undefined;
    value = value * 256 + Number(parts[i]);
  }
  return value;
}
function inCidr(ip, cidr) {
  const slash = String(cidr).indexOf("/");
  const base = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  const value = ipv4ToInt(ip);
  if (base === undefined || value === undefined || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const size = Math.pow(2, 32 - bits);
  return Math.floor(base / size) === Math.floor(value / size);
}
const NOT_PUBLIC = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
function publicAddress(ip) {
  if (ipv4ToInt(ip) === undefined) return false;
  for (let i = 0; i < NOT_PUBLIC.length; i++) if (inCidr(ip, NOT_PUBLIC[i])) return false;
  return true;
}

// Linux delivers a packet addressed to ANY of this container's addresses whichever interface it arrived on, so a process on the sandbox
// network that can route through the gateway (it would need NET_ADMIN, which a sandbox does not have) could talk to a service bound to
// the gateway's worker-network or external address. Every service therefore answers only peers on the network it was opened for.
function peerIn(address, cidr) {
  return typeof address === "string" && inCidr(address.replace(/^::ffff:/, ""), cidr);
}

// Where the interfaces are: a role per network, by the subnet the broker read from Docker.
function localAddresses() {
  // Library mode only: a test names the addresses (the loopback is an "internal" interface and is skipped below).
  if (TEST_ADDRESSES) return JSON.parse(TEST_ADDRESSES);
  const found = { worker: [], sandbox: [], external: [] };
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach(function (name) {
    (interfaces[name] || []).forEach(function (entry) {
      if (entry.family !== "IPv4" || entry.internal) return;
      Object.keys(found).forEach(function (role) {
        if (config.nets && config.nets[role] && inCidr(entry.address, config.nets[role])) found[role].push(entry.address);
      });
    });
  });
  return found;
}

// ---- name server: an allowed name answers with the gateway's own address on the asking network, everything else is NXDOMAIN
function parseQuestion(message) {
  if (message.length < 17) return undefined;
  const flags = message.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return undefined; // a response, not a query
  if (message.readUInt16BE(4) !== 1) return undefined;
  const labels = [];
  let offset = 12;
  for (;;) {
    if (offset >= message.length) return undefined;
    const length = message[offset];
    if (length === 0) { offset += 1; break; }
    if (length > 63) return undefined; // a compressed or malformed name
    if (offset + 1 + length > message.length) return undefined;
    labels.push(message.toString("latin1", offset + 1, offset + 1 + length).toLowerCase());
    offset += 1 + length;
  }
  if (offset + 4 > message.length) return undefined;
  return { name: labels.join("."), type: message.readUInt16BE(offset), end: offset + 4, opcode: (flags >> 11) & 0xf, recursion: (flags & 0x0100) !== 0 };
}
function answerFor(message, localIp, role) {
  const question = parseQuestion(message);
  if (question === undefined) return undefined;
  const header = Buffer.from(message.subarray(0, 12));
  const echoed = message.subarray(12, question.end);
  let rcode = 0;
  let answers = 0;
  let body = Buffer.alloc(0);
  if (question.opcode !== 0) rcode = 4;
  else if (!hostAllowed(question.name, role)) { rcode = 3; stats.dnsRefused += 1; }
  else {
    stats.dnsAllowed += 1;
    if (question.type === 1) {
      const octets = String(localIp).split(".").map(Number);
      body = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, octets[0], octets[1], octets[2], octets[3]]);
      answers = 1;
    }
  }
  if (rcode === 3) log("dns_refused", { host: question.name });
  header.writeUInt16BE(0x8000 | (question.opcode << 11) | (question.recursion ? 0x0100 : 0) | 0x0080 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, echoed, body]);
}
function startNameServer(ip, cidr, role) {
  const udp = dgram.createSocket("udp4");
  udp.on("message", function (message, remote) {
    if (!peerIn(remote.address, cidr)) return;
    const reply = answerFor(message, ip, role);
    if (reply !== undefined) udp.send(reply, remote.port, remote.address);
  });
  udp.on("error", function (error) { log("dns_error", { reason: error.code }); });
  udp.bind(DNS_PORT, ip);
  const tcp = net.createServer(function (socket) {
    if (!peerIn(socket.remoteAddress, cidr)) return socket.destroy();
    let held = Buffer.alloc(0);
    socket.setTimeout(10000, function () { socket.destroy(); });
    socket.on("error", function () {});
    socket.on("data", function (chunk) {
      held = Buffer.concat([held, chunk]);
      if (held.length > 4096) return socket.destroy();
      while (held.length >= 2 && held.length >= 2 + held.readUInt16BE(0)) {
        const size = held.readUInt16BE(0);
        const reply = answerFor(held.subarray(2, 2 + size), ip, role);
        held = held.subarray(2 + size);
        if (reply === undefined) return socket.destroy();
        const framed = Buffer.alloc(2);
        framed.writeUInt16BE(reply.length, 0);
        socket.write(Buffer.concat([framed, reply]));
      }
    });
  });
  tcp.on("error", function (error) { log("dns_error", { reason: error.code }); });
  tcp.listen(DNS_PORT, ip);
  return { udp: udp, tcp: tcp };
}

// ---- the way out
let open = 0;
async function resolvePublic(host) {
  const found = await dns.promises.lookup(host, { all: true, family: 4 });
  if (found.length === 0) throw new Error("unresolved");
  // One bad answer is enough to refuse the name: a name that points into a private range is not a public site.
  for (let i = 0; i < found.length; i++) if (!publicAddress(found[i].address)) throw new Error("private_address");
  return found.map(function (entry) { return entry.address; });
}
function connectOne(address, port) {
  return new Promise(function (resolve, reject) {
    const socket = net.connect({ host: address, port: port, family: 4 });
    const timer = setTimeout(function () { socket.destroy(); reject(new Error("timeout")); }, LIMITS.connectMs);
    socket.once("connect", function () { clearTimeout(timer); socket.removeAllListeners("error"); resolve(socket); });
    socket.once("error", function (error) { clearTimeout(timer); reject(error); });
  });
}
async function connectPublic(host, port) {
  const addresses = await resolvePublic(host);
  let failure = new Error("unreachable");
  for (let i = 0; i < addresses.length; i++) {
    try { return await connectOne(addresses[i], port); } catch (error) { failure = error; }
  }
  throw failure;
}
function tie(left, right) {
  const end = function () { left.destroy(); right.destroy(); };
  left.on("error", end);
  right.on("error", end);
  left.on("close", end);
  right.on("close", end);
  left.setTimeout(LIMITS.idleMs, end);
  right.setTimeout(LIMITS.idleMs, end);
  left.pipe(right);
  right.pipe(left);
}

// The server name in a TLS ClientHello, or why there is none.
function serverNameOf(buffer) {
  if (buffer.length < 5) return { more: true };
  if (buffer[0] !== 0x16 || buffer[1] !== 3) return { error: "not_tls" };
  const recordLength = buffer.readUInt16BE(3);
  if (recordLength < 40 || recordLength > 16384) return { error: "bad_record" };
  if (buffer.length < 5 + recordLength) return { more: true };
  if (buffer[5] !== 1) return { error: "not_client_hello" };
  const helloLength = (buffer[6] << 16) | (buffer[7] << 8) | buffer[8];
  if (helloLength + 4 > recordLength) return { error: "fragmented_hello" };
  const end = 5 + 4 + helloLength;
  let offset = 5 + 4 + 2 + 32;
  const need = function (size) { return offset + size <= end; };
  if (!need(1)) return { error: "bad_hello" };
  offset += 1 + buffer[offset];
  if (!need(2)) return { error: "bad_hello" };
  offset += 2 + buffer.readUInt16BE(offset);
  if (!need(1)) return { error: "bad_hello" };
  offset += 1 + buffer[offset];
  if (!need(2)) return { error: "no_name" };
  const extensionsEnd = offset + 2 + buffer.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > end) return { error: "bad_hello" };
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { error: "bad_hello" };
    if (type === 0) {
      if (length < 5) return { error: "bad_name" };
      const listEnd = offset + 2 + buffer.readUInt16BE(offset);
      let cursor = offset + 2;
      if (listEnd > offset + length) return { error: "bad_name" };
      while (cursor + 3 <= listEnd) {
        const nameType = buffer[cursor];
        const nameLength = buffer.readUInt16BE(cursor + 1);
        cursor += 3;
        if (cursor + nameLength > listEnd) return { error: "bad_name" };
        if (nameType === 0) return { name: buffer.toString("latin1", cursor, cursor + nameLength).toLowerCase().replace(/\.$/, "") };
        cursor += nameLength;
      }
    }
    offset += length;
  }
  return { error: "no_name" };
}

function startTlsForwarder(ip, cidr, role) {
  const server = net.createServer(function (client) {
    if (!peerIn(client.remoteAddress, cidr)) return client.destroy();
    if (open >= LIMITS.maxConnections) return client.destroy();
    open += 1;
    client.on("close", function () { open -= 1; });
    client.on("error", function () {});
    let held = Buffer.alloc(0);
    let decided = false;
    const timer = setTimeout(function () { client.destroy(); }, LIMITS.helloMs);
    const refuse = function (reason, host) {
      decided = true;
      clearTimeout(timer);
      stats.webRefused += 1;
      log("refused", { port: 443, reason: reason, host: host });
      client.destroy();
    };
    client.on("data", function onData(chunk) {
      if (decided) return;
      held = Buffer.concat([held, chunk]);
      const parsed = serverNameOf(held);
      if (parsed.more) return held.length > 16389 ? refuse("bad_record") : undefined;
      if (parsed.error) return refuse(parsed.error);
      if (!hostAllowed(parsed.name, role)) return refuse("not_allowed", parsed.name);
      decided = true;
      clearTimeout(timer);
      client.pause();
      client.removeListener("data", onData);
      connectPublic(parsed.name, 443).then(function (upstream) {
        stats.webAllowed += 1;
        upstream.write(held);
        tie(client, upstream);
        client.resume();
      }, function (error) {
        stats.webRefused += 1;
        log("refused", { port: 443, reason: error.message === "private_address" ? "private_address" : "upstream", host: parsed.name });
        client.destroy();
      });
    });
  });
  server.on("error", function (error) { log("listen_error", { port: 443, reason: error.code }); });
  server.listen(TLS_PORT, ip);
  return server;
}

// Port 80: every request is read and judged on its own, so a connection kept open cannot change its Host after the first.
function startPlainForwarder(ip, cidr, role) {
  const server = http.createServer({ maxHeaderSize: 16384 }, function (request, response) {
    const refuse = function (status, reason, host) {
      stats.webRefused += 1;
      log("refused", { port: 80, reason: reason, host: host });
      response.writeHead(status, { "content-type": "text/plain", connection: "close" });
      response.end("not allowed\n");
    };
    if (!peerIn(request.socket.remoteAddress, cidr)) return request.socket.destroy();
    const hosts = request.headersDistinct && request.headersDistinct.host;
    if (!hosts || hosts.length !== 1) return refuse(400, "bad_host");
    const host = hosts[0].toLowerCase().replace(/:80$/, "").replace(/\.$/, "");
    if (!hostAllowed(host, role)) return refuse(403, "not_allowed", host);
    if (typeof request.url !== "string" || request.url.charAt(0) !== "/") return refuse(400, "bad_target", host);
    if (request.headers.upgrade !== undefined) return refuse(400, "upgrade", host);
    resolvePublic(host).then(function (addresses) {
      stats.webAllowed += 1;
      const headers = Object.assign({}, request.headers);
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers["keep-alive"];
      const upstream = http.request({ host: addresses[0], port: 80, method: request.method, path: request.url, headers: headers, agent: false, timeout: LIMITS.connectMs }, function (answer) {
        response.writeHead(answer.statusCode || 502, answer.headers);
        answer.pipe(response);
      });
      upstream.setTimeout(LIMITS.idleMs, function () { upstream.destroy(); });
      upstream.on("error", function () { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    }, function (error) {
      refuse(403, error.message === "private_address" ? "private_address" : "upstream", host);
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 600000;
  server.maxConnections = LIMITS.maxConnections;
  server.on("clientError", function (error, socket) { socket.destroy(); });
  server.on("error", function (error) { log("listen_error", { port: 80, reason: error.code }); });
  server.listen(PLAIN_PORT, ip);
  return server;
}

// ---- the callback relay: the worker's calls to the broker, and only those
// Four families. (1) The operation callbacks, POST. (2) The model proxy (lane L9a): POST to the three model routes; the broker's proxy holds the
// model key and the worker holds only a short-lived token. (3) GET /v1/internal/model-access, where the worker asks for that token with its callback
// capability. The relay stamps the worker's own workspace id on (2) and (3) and removes any such header the worker sent, so a token taken from one
// worker is refused when another worker's relay carries it. (4) A stage's sources: the two context-tools routes and the one MCP endpoint, stamped the same way.
const CALLBACK_PATH = /^\/v1\/internal\/(workspaces|project-setups)\/([A-Za-z0-9-]{1,64})\/operations\/([A-Za-z0-9._-]{1,128})\/([a-z0-9][a-z0-9\/_-]{0,120})$/;
const MODEL_ACCESS_PATH = /^\/v1\/internal\/model-access(\?slot=[a-z0-9][a-z0-9_-]{0,31})?$/;
const DESIGN_REVIEW_PACKET_PATH = /^\/v1\/internal\/design-review\/packet\?slot=[a-z0-9][a-z0-9_-]{0,31}$/;
const CONTEXT_TOOLS_LIST_PATH = /^\/v1\/internal\/context-tools$/;
const CONTEXT_TOOLS_CALL_PATH = /^\/v1\/internal\/context-tools\/call$/;
// The same tools as ONE MCP server for the agent's own MCP client (streamable HTTP in its JSON-answer form): POST on one exact path, the workspace stamped.
// No GET stream and no session to end, so GET and DELETE are refused here.
const GATEWAY_MCP_PATH = /^\/v1\/internal\/mcp$/;
const MODEL_PROXY_PATH = /^\/v1\/internal\/model-proxy\/v1\/(messages|responses|chat\/completions)(\?beta=true)?$/;
const WORKSPACE_STAMP = "x-rovara-workspace";
const MODEL_TIMEOUT_MS = 600000;
const HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"];
// What a request may be: { kind } when relayed, { status, reason } when refused.
function callbackRoute(method, url, workspaceId) {
  const target = url || "";
  if (MODEL_ACCESS_PATH.test(target)) return method === "GET" ? { kind: "model-access" } : { status: 405, reason: "method_not_allowed" };
  if (DESIGN_REVIEW_PACKET_PATH.test(target)) return method === "GET" ? { kind: "packet" } : { status: 405, reason: "method_not_allowed" };
  if (CONTEXT_TOOLS_LIST_PATH.test(target)) return method === "GET" ? { kind: "context-tools" } : { status: 405, reason: "method_not_allowed" };
  if (CONTEXT_TOOLS_CALL_PATH.test(target)) return method === "POST" ? { kind: "context-tools" } : { status: 405, reason: "method_not_allowed" };
  if (GATEWAY_MCP_PATH.test(target)) return method === "POST" ? { kind: "mcp" } : { status: 405, reason: "method_not_allowed" };
  if (MODEL_PROXY_PATH.test(target)) return method === "POST" ? { kind: "model-call" } : { status: 405, reason: "method_not_allowed" };
  if (method !== "POST") return { status: 405, reason: "method_not_allowed" };
  const match = CALLBACK_PATH.exec(target);
  if (match === null) return { status: 404, reason: "path_not_allowed" };
  if (match[1] === "workspaces" && match[2] !== workspaceId) return { status: 403, reason: "other_workspace" };
  return { kind: "callback" };
}
function relayCallback(request, response) {
  if (!peerIn(request.socket.remoteAddress, config.nets.worker)) return request.socket.destroy();
  const refuse = function (status, reason) {
    log("callback_refused", { reason: reason });
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ error: { code: reason } }));
  };
  const route = callbackRoute(request.method, request.url, config.callback.workspaceId);
  if (route.status) return refuse(route.status, route.reason);
  const chunks = [];
  let size = 0;
  request.on("data", function (chunk) {
    size += chunk.length;
    if (size > LIMITS.maxBodyBytes) { request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("error", function () {});
  request.on("end", function () {
    const body = Buffer.concat(chunks);
    const headers = {};
    Object.keys(request.headers).forEach(function (name) { if (HOP.indexOf(name) === -1 && name !== WORKSPACE_STAMP) headers[name] = request.headers[name]; });
    if (route.kind !== "callback") headers[WORKSPACE_STAMP] = config.callback.workspaceId;
    headers.host = config.callback.hostHeader;
    headers["content-length"] = String(body.length);
    headers.connection = "close";
    const targets = config.callback.targets || [];
    const attempt = function (index) {
      if (index >= targets.length) return refuse(502, "broker_unreachable");
      const target = targets[index];
      const options = Object.assign({ method: request.method, path: request.url, headers: headers, agent: false, timeout: route.kind === "model-call" ? MODEL_TIMEOUT_MS : 60000 }, target.unix ? { socketPath: target.unix } : { host: target.host, port: target.port });
      const upstream = http.request(options, function (answer) {
        const out = { "content-type": answer.headers["content-type"] || "application/json", connection: "close" };
        if (answer.headers["retry-after"]) out["retry-after"] = answer.headers["retry-after"];
        if (answer.headers["cache-control"]) out["cache-control"] = answer.headers["cache-control"];
        response.writeHead(answer.statusCode || 502, out);
        answer.pipe(response);
        // A worker that goes away ends the broker's call, which stops the provider's.
        response.on("close", function () { answer.destroy(); upstream.destroy(); });
      });
      upstream.on("timeout", function () { upstream.destroy(new Error("timeout")); });
      upstream.on("error", function () { if (!response.headersSent) attempt(index + 1); else response.destroy(); });
      upstream.end(body);
    };
    attempt(0);
  });
}
function startCallbackRelay(ip) {
  const server = http.createServer({ maxHeaderSize: 16384 }, relayCallback);
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.on("clientError", function (error, socket) { socket.destroy(); });
  server.on("error", function (error) { log("listen_error", { port: config.callback.port, reason: error.code }); });
  server.listen(config.callback.port, ip);
  return server;
}

// ---- the published port: the broker reaches the worker through here
function startIngress(ip) {
  const server = net.createServer(function (client) {
    if (!peerIn(client.remoteAddress, config.nets.external)) return client.destroy();
    client.on("error", function () {});
    dns.promises.lookup(config.ingress.target, { family: 4 }).then(function (found) {
      if (!inCidr(found.address, config.nets.worker)) return client.destroy();
      const upstream = net.connect({ host: found.address, port: config.ingress.targetPort, family: 4 });
      upstream.on("error", function () { client.destroy(); });
      upstream.once("connect", function () { tie(client, upstream); });
    }, function () { client.destroy(); });
  });
  server.maxConnections = 64;
  server.on("error", function (error) { log("listen_error", { port: config.ingress.port, reason: error.code }); });
  server.listen(config.ingress.port, ip);
}

// What one network's role gets: its name server and its TLS and plain forwarders, all judged for that role.
function startNetwork(role, ip, cidr) {
  return { role: role, dns: startNameServer(ip, cidr, role), tls: startTlsForwarder(ip, cidr, role), plain: startPlainForwarder(ip, cidr, role) };
}
function main() {
  const addresses = localAddresses();
  if (addresses.worker.length === 0 || addresses.sandbox.length === 0 || addresses.external.length === 0) {
    process.stderr.write("egress gateway: the three networks are not all attached\n");
    process.exit(2);
  }
  const started = [];
  addresses.worker.forEach(function (ip) { started.push(startNetwork("worker", ip, config.nets.worker)); startCallbackRelay(ip); });
  addresses.sandbox.forEach(function (ip) { started.push(startNetwork("sandbox", ip, config.nets.sandbox)); });
  addresses.external.forEach(function (ip) { startIngress(ip); });
  if (QUIET) return started;
  process.on("uncaughtException", function (error) { log("error", { reason: String(error && error.code) }); });
  process.on("SIGTERM", function () { process.exit(0); });
  process.stdout.write(JSON.stringify({ component: "egress-gateway", event: "ready", worker: addresses.worker, sandbox: addresses.sandbox }) + "\n");
  return started;
}

if (process.env.ROVARA_GW_LIBRARY === "1") {
  module.exports = { callbackRoute: callbackRoute, startCallbackRelay: startCallbackRelay, hostAllowed: hostAllowed, startTlsForwarder: startTlsForwarder, startPlainForwarder: startPlainForwarder, main: main, validName: validName, publicAddress: publicAddress, serverNameOf: serverNameOf, answerFor: answerFor, peerIn: peerIn, parseQuestion: parseQuestion, inCidr: inCidr, stats: stats };
} else {
  main();
}
`;
