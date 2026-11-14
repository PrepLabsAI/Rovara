// Test services TS27 (design test-services.md 4.3; owner decisions Q3 and Q8): the test-account PROXY. A sealed check round has no internet at all; the one way out is this proxy, which lets the round's code reach the
// hosts of the customer test accounts the round was approved to use, and nothing else.
//
// WHAT IT IS. A plain HTTP CONNECT proxy, run as a helper on the run's services network (the proxy's address in the slot, `RunNetwork.proxyIp`, .8) with its own egress bridge. It never terminates TLS, never sees a
// request or a response body (after the tunnel is up it only moves bytes), and records host, port, bytes and connection count for the evidence. The sealed check sandbox reaches it through `HTTPS_PROXY`/`HTTP_PROXY`
// (`testAccountProxyEnv`); code that ignores those variables reaches the DNS helper, gets the sinkhole and is recorded as an unexpected outbound call (that part is the sealed sandbox's, not this module's).
//
// WHAT IT REFUSES, each with a fixed reason and a status code, none of them echoing what was asked for (the request is repository-controlled text):
//   - `source`: a caller whose address is not in `allowedSources` (the check sandbox's address; the working sandbox and the helpers are never on the list);
//   - `not_connect`: anything but CONNECT (a plain HTTP request through the proxy would show its body to it);
//   - `bad_request`: a CONNECT target that is not exactly `host:443`, with userinfo, a path, a space or a control character in it;
//   - `ip_literal`: a target that is or could be read as an address: dotted, short, decimal, hex or octal IPv4, any IPv6, a name whose last label has no letter, `localhost`, a name with no dot;
//   - `denied`: a name on the production deny list (the caller passes the check; the account was also checked at save and at every run, so this is the third look);
//   - `not_allowed`: a name that is not on the list of THIS run's accounts' hosts (at most 8, exact names, no wildcard);
//   - `cap`: more connections than the run's cap (`maxConnections`, from the account: default 2,000), or more at once than `maxConcurrent`;
//   - `private_address`: a name that RESOLVES to a loopback, private, link-local, shared (100.64/10), metadata, multicast or reserved address (any one of its answers is enough). The proxy connects to the address it
//     checked, not to the name again, so a name that answers differently the second time cannot move it (DNS rebinding);
//   - `upstream`: the host did not answer in time or reset the connection.
// Only port 443 is allowed: an account's hosts are plain names, never a name and a port.
//
// LIMITS. Headers are held to 4 KB and 10 seconds; a connect takes at most `connectTimeoutMs`; a tunnel closes after `idleTimeoutMs` without bytes, after `maxTunnelMs` in all, and once it has carried `maxTunnelBytes` (both directions; the snapshot says how many were cut and how many bytes passed, which the day's use records); both ends are destroyed together.
//
// NOT DONE HERE. This module opens no network of its own, adds no firewall rule, and is not run by this build (no Docker): the Linux check TS-L5 (the proxy's egress bridge reaches only allowed names through the DNS
// firewall, and a private range fails) must pass on linux-runtime or a staging worker before `ta` is on. The sealed sandbox (check-sandbox.ts, lane ts-sealed) starts it through `startTestAccountProxy` and reads its
// `snapshot()` for the evidence.
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { TEST_ACCOUNT_LIMITS, TEST_ACCOUNT_LIMIT_DEFAULTS, prodDenyMatchesHost, type TestEnvProdDeny } from "@agentx/contracts";

export const PROXY_PORT = 443;
export const PROXY_LISTEN_PORT = 3128;
export const PROXY_REFUSALS = ["source", "not_connect", "bad_request", "ip_literal", "denied", "not_allowed", "cap", "private_address", "upstream"] as const;
export type ProxyRefusal = (typeof PROXY_REFUSALS)[number];
const STATUS: Record<ProxyRefusal, number> = { source: 403, not_connect: 405, bad_request: 400, ip_literal: 403, denied: 403, not_allowed: 403, cap: 429, private_address: 403, upstream: 502 };
const WORDS: Record<ProxyRefusal, string> = {
  source: "not a caller of this proxy", not_connect: "only CONNECT is allowed", bad_request: "not a host and port", ip_literal: "not a name", denied: "not allowed", not_allowed: "not allowed",
  cap: "too many connections", private_address: "not allowed", upstream: "could not connect",
};

// ---- names

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A host as the proxy compares it: lower case, no trailing dot, plain DNS labels, at least two of them, and a last label that has a letter (so `127.1`, `0x7f.1`, `2130706433` and `1.2.3.4` are never names).
 * Undefined when the text is not such a name. An address of any spelling is not a name.
 */
export function proxyHostName(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 253 || /[^\x21-\x7e]/u.test(raw)) return undefined;
  const name = raw.toLowerCase().replace(/\.$/u, "");
  if (name === "" || isIP(name) !== 0 || name.includes(":") || name.includes("[") || name.includes("%")) return undefined;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return undefined;
  const tld = labels[labels.length - 1] as string;
  if (!/[a-z]/u.test(tld)) return undefined;
  // `xn--` is a legitimate label (an internationalized name); a label made of hex digits behind `0x` is not.
  if (labels.some((label) => /^0x[0-9a-f]*$/u.test(label))) return undefined;
  return name;
}

/** Whether the text is, or can be read as, an address: any IP spelling, a bracketed IPv6, a name with no letter in its last label, or a name with no dot (`localhost`). */
export function looksLikeAddress(raw: string): boolean {
  const name = raw.toLowerCase().replace(/\.$/u, "");
  if (name.startsWith("[") || name.includes(":") || isIP(name) !== 0) return true;
  if (/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/u.test(name)) return true;
  const labels = name.split(".");
  return labels.length < 2 || !/[a-z]/u.test(labels[labels.length - 1] ?? "");
}

/** `host:443`, both parts plain. Undefined for anything else (userinfo, a path, a port other than 443, a space, an empty part). */
export function parseConnectTarget(target: string): { host: string; port: number } | { refusal: "bad_request" | "ip_literal" } {
  if (target.length === 0 || target.length > 300 || /[\s/\\@?#]/u.test(target) || [...target].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return { refusal: "bad_request" };
  if (target.startsWith("[")) return { refusal: "ip_literal" };
  const parts = target.split(":");
  if (parts.length > 2) return { refusal: "ip_literal" };
  const [hostPart, portPart] = parts as [string, string | undefined];
  if (portPart === undefined || !/^[0-9]{1,5}$/u.test(portPart) || Number(portPart) !== PROXY_PORT || hostPart === "") return { refusal: "bad_request" };
  if (looksLikeAddress(hostPart)) return { refusal: "ip_literal" };
  const host = proxyHostName(hostPart);
  return host === undefined ? { refusal: "bad_request" } : { host, port: PROXY_PORT };
}

// ---- addresses

/** The 16 bytes of an IPv6 address (compressed, with an embedded dotted IPv4 tail, or with a zone), or undefined. Node's `isIP` has already said it is IPv6. */
function ipv6Bytes(address: string): number[] | undefined {
  const text = address.split("%")[0] as string;
  let head = text;
  let tail4: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (dotted !== null) {
    tail4 = dotted.slice(1, 5).map(Number);
    if (tail4.some((part) => part > 255)) return undefined;
    head = `${text.slice(0, text.length - (dotted[0]).length)}0:0`;
  }
  const sides = head.split("::");
  if (sides.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":").map((group) => (/^[0-9a-f]{1,4}$/iu.test(group) ? Number.parseInt(group, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? undefined : groups;
  };
  const left = parse(sides[0] as string);
  const right = sides.length === 2 ? parse(sides[1] as string) : [];
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if (sides.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...left, ...Array.from({ length: sides.length === 2 ? missing : 0 }, () => 0), ...right];
  if (tail4.length === 4) {
    groups[6] = (tail4[0] as number) * 256 + (tail4[1] as number);
    groups[7] = (tail4[2] as number) * 256 + (tail4[3] as number);
  }
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/**
 * Whether an address is one a test account must never be reached at: loopback, private, link-local (the metadata address included), shared, multicast, reserved, unspecified. For IPv6, by prefix on the 16 bytes:
 * ::/96 (unspecified, loopback and IPv4-compatible), ::ffff:0:0/96 (every IPv4-mapped address, whatever its IPv4), 64:ff9b::/96 and 64:ff9b:1::/48 (translation), 100::/64, 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4: it carries an
 * IPv4 address that could be anything), fc00::/7, fe80::/10, fec0::/10 (deprecated site-local) and ff00::/8. Anything that is not an address at all is forbidden.
 */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 0) return true;
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true;
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  const first = (bytes[0] as number) * 256 + (bytes[1] as number);
  const second = (bytes[2] as number) * 256 + (bytes[3] as number);
  return zeros(0, 12) // ::/96
    || (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) // ::ffff:0:0/96
    || (first === 0x0064 && second === 0xff9b && zeros(4, 12)) // 64:ff9b::/96
    || (first === 0x0064 && second === 0xff9b && bytes[4] === 0x00 && bytes[5] === 0x01) // 64:ff9b:1::/48 (RFC 8215 local-use translation)
    || (first === 0x0100 && zeros(2, 8)) // 100::/64
    || (first === 0x2001 && second === 0x0000) // 2001::/32
    || (first === 0x2001 && second === 0x0db8) // 2001:db8::/32
    || first === 0x2002 // 2002::/16
    || (first & 0xfe00) === 0xfc00 // fc00::/7
    || (first & 0xffc0) === 0xfe80 // fe80::/10
    || (first & 0xffc0) === 0xfec0 // fec0::/10
    || (first & 0xff00) === 0xff00; // ff00::/8
}

const callerAddress = (raw: string | undefined): string => (raw ?? "").replace(/^::ffff:/iu, "");

// ---- the proxy

export interface TestAccountProxyOptions {
  /** The hosts of the accounts THIS run may use: exact names, at most 8. */
  hosts: readonly string[];
  /** The production deny check (a closure over the company's list: `denyChecker`). True for a name that must never be reached. */
  isDenied: (host: string) => boolean;
  /** The cap on connections for this run. */
  maxConnections: number;
  /** The address to listen on: the proxy's address on the services network. A wildcard address is refused. */
  listenAddress: string;
  listenPort?: number;
  /** Who may use the proxy: the check sandbox's address. Not empty. */
  allowedSources: readonly string[];
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** The longest one tunnel lives (default 5 minutes). */
  maxTunnelMs?: number;
  /** The most bytes one tunnel carries, both directions together (default 256 MiB): past it the tunnel is cut. */
  maxTunnelBytes?: number;
  /** All the addresses of a name. Default: the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the upstream connection to an address that has been checked. Default: `net.connect`. */
  connect?: (address: string, port: number) => Socket;
}

export interface ProxyHostStats { host: string; connections: number; bytesUp: number; bytesDown: number }
export interface ProxySnapshot {
  /** Connections that were allowed (the number the cap counts). */
  connections: number;
  hosts: ProxyHostStats[];
  /** Bytes through all tunnels, both directions: what the day's use records. */
  bytes: number;
  /** Tunnels the proxy cut for passing a per-tunnel cap. */
  cut: { bytes: number; duration: number };
  /** How many requests were refused, by reason. Never what was asked for. */
  refused: Record<ProxyRefusal, number>;
  capReached: boolean;
}

export interface TestAccountProxy {
  address: string;
  port: number;
  snapshot(): ProxySnapshot;
  close(): Promise<void>;
}

const DEFAULTS = { maxConcurrent: 32, idleTimeoutMs: 60_000, connectTimeoutMs: 10_000, maxTunnelMs: 300_000, maxTunnelBytes: 256 * 1024 * 1024 };

/** The deny check as a closure over the company's list. */
export const denyChecker = (deny: TestEnvProdDeny) => (host: string): boolean => prodDenyMatchesHost(deny, host);

function validate(options: TestAccountProxyOptions): { hosts: Set<string> } {
  if (options.hosts.length === 0 || options.hosts.length > TEST_ACCOUNT_LIMITS.hosts) throw new RangeError("the proxy takes 1 to 8 hosts");
  const hosts = new Set<string>();
  for (const raw of options.hosts) {
    const name = proxyHostName(raw);
    // The names in an allow-list are the same plain names the proxy accepts: a wildcard, an address or a port in the list is a mistake, refused when the proxy is made.
    if (name === undefined || name !== raw) throw new RangeError("a proxy host is a plain lower-case name");
    hosts.add(name);
  }
  if (options.maxTunnelBytes !== undefined && (!Number.isSafeInteger(options.maxTunnelBytes) || options.maxTunnelBytes < 1)) throw new RangeError("the per-tunnel byte cap is a positive whole number");
  if (options.maxTunnelMs !== undefined && (!Number.isSafeInteger(options.maxTunnelMs) || options.maxTunnelMs < 1)) throw new RangeError("the per-tunnel time cap is a positive whole number");
  if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1 || options.maxConnections > 20_000) throw new RangeError("the connection cap is 1 to 20,000");
  if (options.allowedSources.length === 0) throw new RangeError("the proxy needs the address of the sandbox that may use it");
  if (isIP(options.listenAddress) === 0 || ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"].includes(options.listenAddress)) throw new RangeError("the proxy listens on one address, never a wildcard");
  return { hosts };
}

/** Starts the proxy. Resolves when it is listening. */
export async function startTestAccountProxy(options: TestAccountProxyOptions): Promise<TestAccountProxy> {
  const { hosts } = validate(options);
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
  const open = options.connect ?? ((address: string, port: number) => netConnect({ host: address, port }));
  const maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const maxTunnelMs = options.maxTunnelMs ?? DEFAULTS.maxTunnelMs;
  const maxTunnelBytes = options.maxTunnelBytes ?? DEFAULTS.maxTunnelBytes;
  const cut = { bytes: 0, duration: 0 };
  const sources = new Set(options.allowedSources.map(callerAddress));
  const stats = new Map<string, ProxyHostStats>();
  const refused = Object.fromEntries(PROXY_REFUSALS.map((reason) => [reason, 0])) as Record<ProxyRefusal, number>;
  const live = new Set<Socket>();
  let accepted = 0;
  let active = 0;
  let capReached = false;

  const refuse = (client: Socket, reason: ProxyRefusal): void => {
    refused[reason] += 1;
    if (reason === "cap") capReached = true;
    if (client.writable) client.end(`HTTP/1.1 ${String(STATUS[reason])} ${WORDS[reason]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else client.destroy();
  };

  const server: Server = createServer({ maxHeaderSize: 4_096, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 1 }, (request: IncomingMessage, response) => {
    // A request that is not a CONNECT: refused at once, without reading a body.
    refused[sources.has(callerAddress(request.socket.remoteAddress)) ? "not_connect" : "source"] += 1;
    response.writeHead(sources.has(callerAddress(request.socket.remoteAddress)) ? STATUS.not_connect : STATUS.source, { Connection: "close", "Content-Length": "0" });
    response.end(() => request.socket.destroy());
  });
  server.on("clientError", (_error, socket) => { refused.bad_request += 1; socket.destroy(); });

  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    live.add(client);
    client.once("close", () => live.delete(client));
    client.on("error", () => client.destroy());
    if (!sources.has(callerAddress(client.remoteAddress))) return refuse(client, "source");
    const target = parseConnectTarget(request.url ?? "");
    if ("refusal" in target) return refuse(client, target.refusal);
    const { host } = target;
    if (options.isDenied(host)) return refuse(client, "denied");
    if (!hosts.has(host)) return refuse(client, "not_allowed");
    if (accepted >= options.maxConnections || active >= maxConcurrent) return refuse(client, "cap");
    accepted += 1;
    active += 1;
    const entry = stats.get(host) ?? { host, connections: 0, bytesUp: 0, bytesDown: 0 };
    entry.connections += 1;
    stats.set(host, entry);
    let released = false;
    const release = (): void => { if (!released) { released = true; active -= 1; } };
    client.once("close", release);

    void (async () => {
      let addresses: string[];
      try {
        // A name server that never answers must not hold a connection slot open for ever.
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("resolve timeout")), connectTimeoutMs); });
        addresses = await Promise.race([resolve(host), timeout]).finally(() => clearTimeout(timer));
      } catch {
        return refuse(client, "upstream");
      }
      // Any answer in a forbidden range refuses the name: a name that is also private is not one to guess the safe answer of.
      if (addresses.length === 0 || addresses.some(isForbiddenAddress)) return refuse(client, "private_address");
      const upstream = open(addresses[0] as string, PROXY_PORT);
      live.add(upstream);
      upstream.once("close", () => live.delete(upstream));
      let tunnelled = false;
      const fail = (): void => { upstream.destroy(); if (!client.destroyed && client.writable && !tunnelled) refuse(client, "upstream"); else client.destroy(); };
      const connectTimer = setTimeout(fail, connectTimeoutMs);
      upstream.once("error", () => { clearTimeout(connectTimer); fail(); });
      upstream.once("connect", () => {
        clearTimeout(connectTimer);
        // The caller gave up while the host was answering: nothing to tunnel.
        if (client.destroyed) { upstream.destroy(); return; }
        tunnelled = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.setTimeout(idleTimeoutMs, () => { upstream.destroy(); client.destroy(); });
        client.setTimeout(idleTimeoutMs, () => { upstream.destroy(); client.destroy(); });
        const limit = setTimeout(() => { cut.duration += 1; upstream.destroy(); client.destroy(); }, maxTunnelMs);
        let carried = 0;
        const count = (length: number): boolean => {
          carried += length;
          if (carried <= maxTunnelBytes) return true;
          cut.bytes += 1;
          upstream.destroy();
          client.destroy();
          return false;
        };
        const end = (): void => { clearTimeout(limit); upstream.destroy(); client.destroy(); };
        client.once("close", end);
        upstream.once("close", end);
        client.on("data", (chunk: Buffer) => { if (count(chunk.length)) entry.bytesUp += chunk.length; });
        upstream.on("data", (chunk: Buffer) => { if (count(chunk.length)) entry.bytesDown += chunk.length; });
        if (head.length > 0 && count(head.length)) { entry.bytesUp += head.length; upstream.write(head); }
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })();
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen({ host: options.listenAddress, port: options.listenPort ?? PROXY_LISTEN_PORT }, () => { server.off("error", fail); done(); });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("the proxy did not bind an address");

  return {
    address: bound.address,
    port: bound.port,
    snapshot: () => ({ connections: accepted, hosts: [...stats.values()].map((each) => ({ ...each })), bytes: [...stats.values()].reduce((sum, each) => sum + each.bytesUp + each.bytesDown, 0), cut: { ...cut }, refused: { ...refused }, capReached }),
    close: () => new Promise<void>((done) => {
      for (const socket of live) socket.destroy();
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

// ---- how the sealed sandbox points at it

const NO_PROXY_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/u;

/**
 * The proxy variables for the sealed check sandbox: both spellings of each (tools differ in which they read). `noProxy` lists the run's OWN aliases (the services network's names), plain names, so a call to the
 * run's own Postgres does not go through the proxy; anything else the code reaches by name goes to the proxy, and by anything that ignores these variables to the sinkhole. A name that is not plain is refused.
 */
export function testAccountProxyEnv(input: { address: string; port?: number; noProxy: readonly string[] }): Record<string, string> {
  if (isIP(input.address) === 0) throw new RangeError("the proxy's address is an IP address");
  const port = input.port ?? PROXY_LISTEN_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError("not a port");
  if (input.noProxy.some((name) => !NO_PROXY_NAME.test(name))) throw new RangeError("a no-proxy entry is a plain name");
  const url = `http://${input.address.includes(":") ? `[${input.address}]` : input.address}:${String(port)}`;
  const noProxy = input.noProxy.join(",");
  return { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy };
}

// ---- the helper container's program

interface HelperConfig {
  hosts: string[];
  deny: TestEnvProdDeny;
  maxConnections: number;
  listen: string;
  port: number;
  sources: string[];
  state: string;
}

function readHelperConfig(path: string): HelperConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HelperConfig>;
  if (!Array.isArray(raw.hosts) || raw.deny === undefined || typeof raw.listen !== "string" || !Array.isArray(raw.sources) || typeof raw.state !== "string") throw new Error("the proxy's config is incomplete");
  return {
    hosts: raw.hosts, deny: raw.deny, maxConnections: raw.maxConnections ?? TEST_ACCOUNT_LIMIT_DEFAULTS.maxConnectionsPerRun, listen: raw.listen, port: raw.port ?? PROXY_LISTEN_PORT, sources: raw.sources, state: raw.state,
  };
}

/** The helper container's program: reads its config file (hosts, deny list, cap, addresses), runs the proxy, and writes its snapshot beside and renames it over, so the worker never reads half a file. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const at = argv.indexOf("--config");
  const path = at < 0 ? undefined : argv[at + 1];
  if (path === undefined || path.startsWith("--")) throw new Error("missing --config");
  const config = readHelperConfig(path);
  const proxy = await startTestAccountProxy({ hosts: config.hosts, isDenied: denyChecker(config.deny), maxConnections: config.maxConnections, listenAddress: config.listen, listenPort: config.port, allowedSources: config.sources });
  let written = "";
  const flush = (): void => {
    const next = JSON.stringify(proxy.snapshot());
    if (next === written) return;
    written = next;
    writeFileSync(`${config.state}.tmp`, next);
    renameSync(`${config.state}.tmp`, config.state);
  };
  flush();
  const timer = setInterval(flush, 1_000);
  const end = (): void => { clearInterval(timer); flush(); void proxy.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("test-account-proxy.js")) void main();

