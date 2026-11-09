// Port lane L4b: the Docker socket guard of one local worker.
// This is the program that runs inside the helper container (`node -e`), kept as text so the broker needs no build step for it and
// tests can run the very same text. It uses only Node built-ins. Edit it here; there is no other copy.
export const DOCKER_SOCKET_GUARD_SOURCE = String.raw`"use strict";
// Rovara local Docker socket guard (lane L4b). One per worker. It is the only container that holds the host's Docker socket.
// The worker talks to it over TCP on its own internal network (DOCKER_HOST=tcp://...) and never sees the socket. It lets the
// worker do what the worker does on EC2 with the socket (start, run commands in, stop and remove the task sandboxes of its own
// workspace) and nothing else: every other call is refused, and a sandbox is created only from a body this file rebuilds
// to the rules below (the worker's image, the worker's workspace as the only mount, no privilege, no host namespace,
// the worker's own sandbox network and name server).
const http = require("http");
const net = require("net");

const policy = JSON.parse(process.env.ROVARA_SOCK_POLICY || "{}");
const OWNER = "rovara.local.owner";
const SANDBOX = "rovara.local.sandbox";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BODY = 262144;
const execs = new Map(); // exec id -> container id, for the execs this worker made in its own sandboxes
let logged = 0;
let logWindow = Date.now();

function log(event, fields) {
  const now = Date.now();
  if (now - logWindow > 60000) { logWindow = now; logged = 0; }
  if (++logged > 40) return;
  process.stdout.write(JSON.stringify(Object.assign({ component: "docker-socket-guard", event: event }, fields || {})) + "\n");
}

// ---- asking the real daemon ourselves (ownership, counts)
function ask(method, path, body) {
  return new Promise(function (resolve, reject) {
    const headers = { host: "docker" };
    if (body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(body)); }
    const request = http.request({ socketPath: policy.upstream, method: method, path: path, headers: headers, timeout: 30000 }, function (response) {
      const chunks = [];
      response.on("data", function (chunk) { chunks.push(chunk); });
      response.on("end", function () { resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
    });
    request.on("timeout", function () { request.destroy(new Error("timeout")); });
    request.on("error", reject);
    request.end(body);
  });
}
// The container's id when it is a sandbox of this worker, otherwise undefined.
async function ownedContainer(reference) {
  if (!NAME.test(reference)) return undefined;
  const answer = await ask("GET", "/containers/" + encodeURIComponent(reference) + "/json");
  if (answer.status !== 200) return undefined;
  let parsed;
  try { parsed = JSON.parse(answer.body); } catch (error) { return undefined; }
  const labels = (parsed && parsed.Config && parsed.Config.Labels) || {};
  return labels[OWNER] === policy.owner && labels[SANDBOX] === "1" && typeof parsed.Id === "string" ? parsed.Id : undefined;
}

// ---- the rules for a sandbox
// A setting that says nothing: absent, empty, zero or false. An object is empty only when it has no keys, so {"x": ""} (a sysctl set to
// nothing, a volume at /data) is not. An array of numbers or strings is empty when each of them is (ConsoleSize is [0, 0]).
function emptyish(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.every(function (entry) { return entry === 0 || entry === "" || entry === false || entry === null; });
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
function inside(path) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.indexOf("\0") !== -1) return false;
  if (path.split("/").indexOf("..") !== -1) return false;
  const base = policy.workspaceDir;
  return path === base || path.indexOf(base + "/") === 0;
}
function stringList(value, limit) {
  return Array.isArray(value) && value.length <= limit && value.every(function (entry) { return typeof entry === "string" && entry.length <= 32768 && entry.indexOf("\0") === -1; });
}
class Refusal extends Error {}
function deny(rule) { throw new Refusal(rule); }

const NUMBER_KEYS = ["Memory", "MemorySwap", "MemoryReservation", "NanoCpus", "CpuShares", "CpuQuota", "CpuPeriod", "ShmSize", "BlkioWeight", "CpuCount", "CpuPercent"];
const BOOLEAN_KEYS = ["ReadonlyRootfs", "Init", "AutoRemove", "OomKillDisable"];
const HOST_VALIDATED = new Set(["Binds", "Tmpfs", "NetworkMode", "CapAdd", "CapDrop", "SecurityOpt", "Privileged", "Dns", "PidsLimit", "LogConfig", "RestartPolicy", "Ulimits", "CpusetCpus", "CgroupnsMode", "Isolation", "MaskedPaths", "ReadonlyPaths", "MemorySwappiness"]
  .concat(NUMBER_KEYS, BOOLEAN_KEYS));
const TOP_VALIDATED = new Set(["Image", "Cmd", "Entrypoint", "Env", "User", "WorkingDir", "Labels", "HostConfig", "NetworkingConfig", "Tty", "OpenStdin", "AttachStdin", "AttachStdout", "AttachStderr", "StdinOnce", "StopSignal", "StopTimeout"]);

function checkHostConfig(host) {
  if (host === null || typeof host !== "object" || Array.isArray(host)) deny("host config is missing");
  Object.keys(host).forEach(function (key) {
    if (!HOST_VALIDATED.has(key) && !emptyish(host[key])) deny("host setting " + key + " is not allowed");
  });
  if (host.Privileged === true) deny("privileged mode is not allowed");
  if (host.NetworkMode !== policy.network) deny("only the sandbox network is allowed");
  if (!emptyish(host.CapAdd)) deny("capabilities cannot be added");
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.some(function (cap) { return String(cap).toUpperCase() === "ALL"; })) deny("all capabilities must be dropped");
  if (!stringList(host.SecurityOpt, 8) || host.SecurityOpt.length === 0 || !host.SecurityOpt.every(function (entry) { return /^no-new-privileges(:true|=true)?$/.test(entry); })) deny("only no-new-privileges is allowed as a security option");
  // Null (the default masks) is the only safe value: an empty list switches the masks off.
  if (host.MaskedPaths !== null && host.MaskedPaths !== undefined) deny("masked paths cannot be changed");
  if (host.ReadonlyPaths !== null && host.ReadonlyPaths !== undefined) deny("read-only paths cannot be changed");
  const binds = host.Binds === null || host.Binds === undefined ? [] : host.Binds;
  const mount = policy.workspaceDir + ":" + policy.workspaceDir;
  if (!stringList(binds, 4) || !binds.every(function (bind) { return bind === mount || bind === mount + ":rw"; })) deny("only the workspace folder may be mounted");
  const tmpfs = host.Tmpfs === null || host.Tmpfs === undefined ? {} : host.Tmpfs;
  if (typeof tmpfs !== "object" || Array.isArray(tmpfs)) deny("tmpfs is not valid");
  Object.keys(tmpfs).forEach(function (path) {
    if (!inside(path) || path === policy.workspaceDir || typeof tmpfs[path] !== "string" || !/^[a-z0-9=,_-]{0,100}$/.test(tmpfs[path])) deny("a tmpfs may only cover a folder inside the workspace");
  });
  NUMBER_KEYS.forEach(function (key) { if (host[key] !== undefined && host[key] !== null && !(typeof host[key] === "number" && host[key] >= 0)) deny(key + " is not valid"); });
  BOOLEAN_KEYS.forEach(function (key) { if (host[key] !== undefined && host[key] !== null && typeof host[key] !== "boolean") deny(key + " is not valid"); });
  // No limit (absent, 0 or -1) would let one command fork until the VM stops; a sandbox always gets one.
  if (host.PidsLimit !== undefined && host.PidsLimit !== null && typeof host.PidsLimit !== "number") deny("the process limit is not valid");
  if (typeof host.PidsLimit === "number" && host.PidsLimit > 65536) deny("the process limit is too high");
  if (host.MemorySwappiness !== undefined && host.MemorySwappiness !== null && !(typeof host.MemorySwappiness === "number" && host.MemorySwappiness >= -1 && host.MemorySwappiness <= 100)) deny("MemorySwappiness is not valid");
  if (typeof host.CpusetCpus === "string" && !/^[0-9,-]{0,64}$/.test(host.CpusetCpus)) deny("cpuset is not valid");
  const logType = host.LogConfig && host.LogConfig.Type;
  if (logType !== undefined && logType !== "" && logType !== "json-file" && logType !== "local") deny("only the default log driver is allowed");
  const restart = host.RestartPolicy && host.RestartPolicy.Name;
  if (restart !== undefined && restart !== "" && restart !== "no") deny("a sandbox does not restart");
  if (host.CgroupnsMode !== undefined && host.CgroupnsMode !== "" && host.CgroupnsMode !== "private") deny("the cgroup namespace cannot be changed");
  if (host.Isolation !== undefined && host.Isolation !== "" && host.Isolation !== "default") deny("isolation cannot be changed");
  if (host.Ulimits !== undefined && host.Ulimits !== null && !(Array.isArray(host.Ulimits) && host.Ulimits.length <= 16 && host.Ulimits.every(function (entry) { return entry && /^[a-z]{3,16}$/.test(entry.Name) && typeof entry.Soft === "number" && typeof entry.Hard === "number"; }))) deny("ulimits are not valid");
}

function transformCreate(query, text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  Array.from(query.keys()).forEach(function (key) { if (key !== "name") deny("create option " + key + " is not allowed"); });
  const name = query.get("name");
  if (name === null || !/^agentx-task-[A-Za-z0-9_.-]{1,100}$/.test(name)) deny("a sandbox name starts with agentx-task-");
  Object.keys(body).forEach(function (key) {
    if (!TOP_VALIDATED.has(key) && !emptyish(body[key])) deny("setting " + key + " is not allowed");
  });
  if (body.Image !== policy.image) deny("only the worker's image may be started");
  if (body.User !== policy.user) deny("the sandbox user is fixed");
  if (body.WorkingDir !== undefined && body.WorkingDir !== "" && !inside(body.WorkingDir)) deny("the working folder must be inside the workspace");
  ["Cmd", "Entrypoint"].forEach(function (key) { if (body[key] !== undefined && body[key] !== null && !stringList(body[key], 256)) deny(key + " is not valid"); });
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, 500)) deny("Env is not valid");
  checkHostConfig(body.HostConfig);
  const labels = body.Labels === null || body.Labels === undefined ? {} : body.Labels;
  if (typeof labels !== "object" || Array.isArray(labels)) deny("labels are not valid");
  if (labels["agentx.workspace"] !== policy.workspaceKey) deny("a sandbox carries its workspace's label");
  if (typeof labels["agentx.task"] !== "string" || labels["agentx.task"] === "") deny("a sandbox carries its task's label");
  const kept = {};
  Object.keys(labels).forEach(function (key) {
    if (key.indexOf("rovara.") === 0) return;
    if (typeof labels[key] !== "string" || labels[key].length > 512) deny("labels are not valid");
    kept[key] = labels[key];
  });
  kept[OWNER] = policy.owner;
  kept[SANDBOX] = "1";
  body.Labels = kept;
  body.HostConfig.Dns = policy.dns;
  if (!(typeof body.HostConfig.PidsLimit === "number" && body.HostConfig.PidsLimit > 0)) body.HostConfig.PidsLimit = 4096;
  body.NetworkingConfig = { EndpointsConfig: {} };
  body.NetworkingConfig.EndpointsConfig[policy.network] = {};
  return JSON.stringify(body);
}

function checkExecBody(text) {
  let body;
  try { body = JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) deny("the body is not an object");
  const allowed = new Set(["AttachStdin", "AttachStdout", "AttachStderr", "Cmd", "Env", "WorkingDir", "User", "Tty", "DetachKeys", "ConsoleSize"]);
  Object.keys(body).forEach(function (key) {
    if (!allowed.has(key) && !(key === "Privileged" && body[key] === false) && !emptyish(body[key])) deny("exec setting " + key + " is not allowed");
  });
  if (body.Privileged === true) deny("privileged exec is not allowed");
  if (body.User !== undefined && body.User !== "" && body.User !== policy.user && body.User !== policy.user.split(":")[0]) deny("a command runs as the sandbox user");
  if (!stringList(body.Cmd, 4096) || body.Cmd.length === 0) deny("Cmd is not valid");
  if (body.Env !== undefined && body.Env !== null && !stringList(body.Env, 500)) deny("Env is not valid");
}

// ---- the routes
function readBody(request) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    request.on("data", function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); return reject(new Refusal("the body is too large")); }
      chunks.push(chunk);
    });
    request.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", reject);
  });
}
function send(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ message: "rovara: " + message }));
}
function forward(request, response, path, body, inspectAnswer) {
  const headers = {};
  Object.keys(request.headers).forEach(function (name) { if (name !== "host" && name !== "connection" && name !== "content-length" && name !== "transfer-encoding") headers[name] = request.headers[name]; });
  headers.host = "docker";
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const upstream = http.request({ socketPath: policy.upstream, method: request.method, path: path, headers: headers }, function (answer) {
    if (inspectAnswer) {
      const chunks = [];
      answer.on("data", function (chunk) { chunks.push(chunk); });
      answer.on("end", function () {
        const text = Buffer.concat(chunks);
        try { inspectAnswer(answer.statusCode, text.toString("utf8")); } catch (error) { /* the answer is passed on regardless */ }
        response.writeHead(answer.statusCode, answer.headers);
        response.end(text);
      });
      return;
    }
    response.writeHead(answer.statusCode, answer.headers);
    // Docker sends the headers of a wait at once and the docker CLI waits for them before it starts the container.
    response.flushHeaders();
    answer.pipe(response);
  });
  upstream.on("error", function () { send(response, 502, "the Docker daemon does not answer"); });
  response.on("close", function () { upstream.destroy(); });
  if (body !== undefined) upstream.end(body);
  else request.pipe(upstream);
}
function onlyQuery(query, names) {
  Array.from(query.keys()).forEach(function (key) { if (names.indexOf(key) === -1) deny("option " + key + " is not allowed"); });
}
function rebuilt(path, query) {
  const text = query.toString();
  return text === "" ? path : path + "?" + text;
}

async function route(request, response) {
  const target = new URL(request.url || "/", "http://docker");
  const path = target.pathname.replace(/^\/v[0-9]+(\.[0-9]+)?(?=\/)/, "");
  const query = target.searchParams;
  const method = request.method || "GET";
  let match;

  if ((method === "GET" || method === "HEAD") && path === "/_ping") return forward(request, response, "/_ping");
  if (method === "GET" && path === "/version") return forward(request, response, "/version");

  if (method === "GET" && path === "/containers/json") {
    onlyQuery(query, ["all", "limit", "size", "filters"]);
    let filters = {};
    if (query.has("filters")) {
      try { filters = JSON.parse(query.get("filters")); } catch (error) { deny("filters are not valid"); }
    }
    // Docker takes {"label":{"a=b":true}} (the old {"label":["a=b"]} form is refused by newer daemons); both are read, the map is sent.
    const asMap = function (value) {
      if (Array.isArray(value)) { const map = {}; value.forEach(function (entry) { map[String(entry)] = true; }); return map; }
      return value === undefined || value === null || typeof value !== "object" ? {} : value;
    };
    if (filters === null || typeof filters !== "object" || Array.isArray(filters)) deny("filters are not valid");
    Object.keys(filters).forEach(function (key) { filters[key] = asMap(filters[key]); });
    filters.label = filters.label || {};
    filters.label[OWNER + "=" + policy.owner] = true;
    filters.label[SANDBOX + "=1"] = true;
    query.set("filters", JSON.stringify(filters));
    return forward(request, response, rebuilt("/containers/json", query));
  }

  if (method === "POST" && path === "/containers/create") {
    const text = await readBody(request);
    const body = transformCreate(query, text);
    const ownedLabels = {};
    ownedLabels[OWNER + "=" + policy.owner] = true;
    ownedLabels[SANDBOX + "=1"] = true;
    const owned = await ask("GET", "/containers/json?all=1&filters=" + encodeURIComponent(JSON.stringify({ label: ownedLabels })));
    let count = 0;
    try { count = JSON.parse(owned.body).length; } catch (error) { count = 0; }
    if (count >= (policy.maxSandboxes || 16)) {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: "rovara: too many task sandboxes at once" }));
    }
    const created = new URLSearchParams();
    created.set("name", query.get("name"));
    return forward(request, response, "/containers/create?" + created.toString(), body);
  }

  match = /^\/containers\/([^/]+)\/(json|logs|start|stop|kill|restart|wait)$/.exec(path);
  if (match !== null) {
    const verb = match[2];
    const wants = (verb === "json" || verb === "logs") ? "GET" : "POST";
    if (method !== wants) deny("method not allowed");
    const allowedQuery = { json: ["size"], logs: ["follow", "stdout", "stderr", "since", "until", "timestamps", "tail"], start: ["detachKeys"], stop: ["t", "signal"], kill: ["signal"], restart: ["t", "signal"], wait: ["condition"] }[verb];
    onlyQuery(query, allowedQuery);
    const id = await ownedContainer(decodeURIComponent(match[1]));
    if (id === undefined) return send(response, 404, "no such sandbox of this worker");
    return forward(request, response, rebuilt("/containers/" + id + "/" + verb, query));
  }

  match = /^\/containers\/([^/]+)$/.exec(path);
  if (match !== null && method === "DELETE") {
    onlyQuery(query, ["force", "v"]);
    const id = await ownedContainer(decodeURIComponent(match[1]));
    if (id === undefined) return send(response, 404, "no such sandbox of this worker");
    return forward(request, response, rebuilt("/containers/" + id, query));
  }

  match = /^\/containers\/([^/]+)\/exec$/.exec(path);
  if (match !== null && method === "POST") {
    onlyQuery(query, []);
    const id = await ownedContainer(decodeURIComponent(match[1]));
    if (id === undefined) return send(response, 404, "no such sandbox of this worker");
    const text = await readBody(request);
    checkExecBody(text);
    return forward(request, response, "/containers/" + id + "/exec", text, function (status, answer) {
      if (status !== 201) return;
      const created = JSON.parse(answer);
      if (typeof created.Id === "string" && NAME.test(created.Id)) {
        execs.set(created.Id, id);
        if (execs.size > 2000) execs.delete(execs.keys().next().value);
      }
    });
  }

  match = /^\/exec\/([^/]+)\/(start|json|resize)$/.exec(path);
  if (match !== null) {
    const verb = match[2];
    if (method !== (verb === "json" ? "GET" : "POST")) deny("method not allowed");
    onlyQuery(query, verb === "resize" ? ["h", "w"] : []);
    const id = decodeURIComponent(match[1]);
    if (!execs.has(id)) return send(response, 404, "no such command of this worker");
    if (verb === "start") {
      const text = await readBody(request);
      let body = {};
      try { body = text === "" ? {} : JSON.parse(text); } catch (error) { deny("the body is not JSON"); }
      Object.keys(body).forEach(function (key) { if (key !== "Detach" && key !== "Tty" && key !== "ConsoleSize") deny("exec start option " + key + " is not allowed"); });
      return forward(request, response, "/exec/" + id + "/start", text);
    }
    return forward(request, response, rebuilt("/exec/" + id + "/" + verb, query));
  }

  match = /^\/images\/(.+)\/json$/.exec(path);
  if (match !== null && method === "GET") {
    onlyQuery(query, []);
    let name;
    try { name = decodeURIComponent(match[1]); } catch (error) { deny("image name is not valid"); }
    if (name !== policy.image) deny("only the worker's image may be inspected");
    return forward(request, response, "/images/" + encodeURIComponent(name) + "/json");
  }

  match = /^\/networks\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    onlyQuery(query, []);
    if (decodeURIComponent(match[1]) !== policy.network) deny("only the sandbox network may be inspected");
    return forward(request, response, "/networks/" + encodeURIComponent(policy.network));
  }

  deny("this request is not allowed");
}

function onRequest(request, response) {
  if (process.env.ROVARA_SOCK_DEBUG === "1") log("request", { method: request.method, url: String(request.url).slice(0, 200) });
  route(request, response).catch(function (error) {
    if (error instanceof Refusal) {
      log("refused", { method: request.method, route: String(request.url || "").split("?")[0].replace(/[^A-Za-z0-9/_.:-]/g, "?").slice(0, 80), rule: error.message });
      return send(response, 403, error.message);
    }
    log("error", { reason: String(error && error.message).slice(0, 80) });
    send(response, 502, "the request could not be handled");
  });
}

// A command's input and output travel over an upgraded connection (docker exec).
function onUpgrade(request, socket, head) {
  const target = new URL(request.url || "/", "http://docker");
  const path = target.pathname.replace(/^\/v[0-9]+(\.[0-9]+)?(?=\/)/, "");
  const match = /^\/exec\/([^/]+)\/start$/.exec(path);
  if (request.method !== "POST" || match === null || !execs.has(decodeURIComponent(match[1]))) {
    log("refused", { method: request.method, route: "upgrade", rule: "not an exec of this worker" });
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ message: "rovara: this upgrade is not allowed" }));
    return;
  }
  const upstream = net.connect({ path: policy.upstream });
  upstream.on("error", function () { socket.destroy(); });
  socket.on("error", function () { upstream.destroy(); });
  upstream.on("connect", function () {
    let text = "POST /exec/" + decodeURIComponent(match[1]) + "/start HTTP/1.1\r\nHost: docker\r\n";
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      if (name.toLowerCase() === "host") continue;
      if (/[\r\n]/.test(name) || /[\r\n]/.test(request.rawHeaders[index + 1])) return socket.destroy();
      text += name + ": " + request.rawHeaders[index + 1] + "\r\n";
    }
    upstream.write(text + "\r\n");
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  socket.on("close", function () { upstream.destroy(); });
  upstream.on("close", function () { socket.destroy(); });
}

function main() {
  const server = http.createServer({ maxHeaderSize: 16384 }, onRequest);
  server.on("upgrade", onUpgrade);
  server.on("clientError", function (error, socket) { socket.destroy(); });
  server.headersTimeout = 10000;
  server.listen(policy.port || 2375, "0.0.0.0", function () { process.stdout.write(JSON.stringify({ component: "docker-socket-guard", event: "ready" }) + "\n"); });
  process.on("uncaughtException", function (error) { log("error", { reason: String(error && error.code) }); });
  process.on("SIGTERM", function () { process.exit(0); });
}

if (process.env.ROVARA_SOCK_LIBRARY === "1") {
  module.exports = { transformCreate: transformCreate, checkExecBody: checkExecBody, Refusal: Refusal, policy: policy };
} else {
  main();
}
`;
