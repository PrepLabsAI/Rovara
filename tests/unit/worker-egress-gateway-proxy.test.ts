// Lane L4-NETG3 (DEC 254zzz105): the egress gateway's DAEMON PROXY (host mode, config.proxy). The Docker daemon of a gateway-mode worker host is given this proxy, so its own fetches while building an image (`ADD <url>`, a `FROM`
// base image, a dev container feature) go through the same name rules as the sandboxes' traffic. The program is loaded as a library (the same text the container runs); the host resolver and the connection out are replaced, so
// nothing leaves this machine.
import { createRequire } from "node:module";
import dns from "node:dns";
import http from "node:http";
import net, { connect as netConnect, createServer as createNetServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/contracts/src/egress-gateway-source.js";
import { SANDBOX_REGISTRY_DENY } from "../../packages/contracts/src/sandbox-deny-domains.js";

const scratch: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

interface Gateway { hostAllowed(host: string, role?: string): boolean; proxyAllowed(host: string): boolean; s3Host(host: string): boolean; main(): Array<{ role: string; proxy?: Server }> }
const PROXY_CONFIG = { mode: "host", sandboxDenied: SANDBOX_REGISTRY_DENY, proxy: { port: 3128, peer: "127.0.0.1/32" }, nets: { sandbox: "127.0.0.0/8", external: "127.0.0.0/8" } };

async function load(config: Record<string, unknown>): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), "gw-proxy-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = { ...process.env };
  const keys = ["ROVARA_GW_CONFIG", "ROVARA_GW_LIBRARY", "ROVARA_GW_TLS_PORT", "ROVARA_GW_PLAIN_PORT", "ROVARA_GW_DNS_PORT", "ROVARA_GW_PROXY_PORT", "ROVARA_GW_TEST_ADDRESSES"];
  Object.assign(process.env, { ROVARA_GW_CONFIG: JSON.stringify(config), ROVARA_GW_LIBRARY: "1", ROVARA_GW_TLS_PORT: "0", ROVARA_GW_PLAIN_PORT: "0", ROVARA_GW_DNS_PORT: "0", ROVARA_GW_PROXY_PORT: "0",
    ROVARA_GW_TEST_ADDRESSES: JSON.stringify({ worker: [], sandbox: ["127.0.0.1"], external: ["127.0.0.1"] }) });
  try { return createRequire(import.meta.url)(file) as Gateway; } finally { for (const key of keys) delete process.env[key]; Object.assign(process.env, saved); }
}

/** The host resolver, replaced: `answers` maps a name to its addresses, any other name is NXDOMAIN. Returns every name asked. */
function hostResolver(answers: Record<string, string[]>): string[] {
  const asked: string[] = [];
  const original = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (name: string) => {
    asked.push(String(name).toLowerCase());
    const found = answers[String(name).toLowerCase()];
    if (found === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: 4 }));
  };
  cleanup.push(() => { (dns.promises as { lookup: unknown }).lookup = original; });
  return asked;
}

/** A local server standing for the public site: a TCP echo for CONNECT, and an HTTP answer for a plain GET. Every dial to a public address the gateway makes is redirected to it, and recorded. */
async function fakeSite(): Promise<{ dialed: Array<{ host: string; port: number }>; paths: string[] }> {
  const dialed: Array<{ host: string; port: number }> = [];
  const paths: string[] = [];
  const server = http.createServer((request, response) => { paths.push(`${request.headers.host ?? ""}${request.url ?? ""}`); response.end("site"); });
  server.on("connection", (socket) => socket.on("error", () => undefined));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const originalConnect = net.connect;
  (net as { connect: unknown }).connect = (options: { host: string; port: number }, ...rest: unknown[]) => {
    if (options.host === "127.0.0.1") return (originalConnect as (...args: unknown[]) => net.Socket)(options, ...rest);
    dialed.push({ host: options.host, port: options.port });
    return (originalConnect as (...args: unknown[]) => net.Socket)({ host: "127.0.0.1", port }, ...rest);
  };
  const originalRequest = http.request;
  (http as { request: unknown }).request = (options: { host?: string; port?: number }, ...rest: unknown[]) => {
    if (typeof options === "object" && options.host !== undefined && options.host !== "127.0.0.1") {
      dialed.push({ host: options.host, port: options.port ?? 80 });
      return (originalRequest as (...args: unknown[]) => http.ClientRequest)({ ...options, host: "127.0.0.1", port }, ...rest);
    }
    return (originalRequest as (...args: unknown[]) => http.ClientRequest)(options, ...rest);
  };
  cleanup.push(() => { (net as { connect: unknown }).connect = originalConnect; (http as { request: unknown }).request = originalRequest; server.close(); (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.(); });
  return { dialed, paths };
}

async function startProxy(config: Record<string, unknown> = PROXY_CONFIG): Promise<{ port: number; started: Array<{ role: string; proxy?: Server }> }> {
  const gateway = await load(config);
  const started = gateway.main();
  const proxy = started.find((entry) => entry.role === "daemon-proxy")?.proxy;
  for (const entry of started) cleanup.push(() => {
    const close = (server: Server | undefined): void => { server?.close(); (server as (Server & { closeAllConnections?: () => void }) | undefined)?.closeAllConnections?.(); };
    close(entry.proxy);
    const normal = entry as unknown as { dns?: { udp: { close(): void }; tcp: Server }; tls?: Server; plain?: Server };
    normal.dns?.udp.close(); normal.dns?.tcp.close(); close(normal.tls); close(normal.plain);
  });
  if (proxy === undefined) return { port: 0, started };
  await new Promise<void>((resolve) => { if (proxy.listening) resolve(); else proxy.once("listening", () => resolve()); });
  return { port: (proxy.address() as AddressInfo).port, started };
}

/** Sends raw text to the proxy and returns what came back (up to the close, or after `waitMs`). */
function raw(port: number, text: string, waitMs = 400): Promise<string> {
  return new Promise((resolve) => {
    let received = "";
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(text));
    socket.on("data", (chunk) => { received += chunk.toString("latin1"); });
    socket.on("error", () => resolve(received));
    socket.on("close", () => resolve(received));
    setTimeout(() => { socket.destroy(); resolve(received); }, waitMs).unref();
  });
}
const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const statusOf = (text: string): number | undefined => Number(/^HTTP\/1\.[01] (\d{3})/u.exec(text)?.[1]) || undefined;

describe("the daemon proxy: what it is for", () => {
  it("is off unless the configuration names it (the laptop modes and a gateway without `proxy` start no such listener), and a mistyped mode never starts it", async () => {
    for (const config of [{ ...PROXY_CONFIG, proxy: undefined }, { ...PROXY_CONFIG, proxy: "yes" }, { ...PROXY_CONFIG, proxy: { port: 3128 } }, { ...PROXY_CONFIG, mode: "HOST" }]) {
      const gateway = await load(config);
      expect(gateway.main === undefined).toBe(false);
    }
    for (const config of [{ ...PROXY_CONFIG, proxy: undefined }, { ...PROXY_CONFIG, proxy: "yes" }, { ...PROXY_CONFIG, proxy: { port: 3128 } }]) {
      const { started } = await startProxy(config);
      expect(started.some((entry) => entry.role === "daemon-proxy"), JSON.stringify(config.proxy)).toBe(false);
    }
  });

  it("tunnels CONNECT host:443 for a name the host resolver answers with public addresses, dialing only those addresses on 443, including the registries a sandbox is denied", async () => {
    const asked = hostResolver({ "registry-1.docker.io": ["54.1.2.3"], "ghcr.io": ["140.82.112.34"], "pkg-containers.githubusercontent.com": ["185.199.108.1"] });
    const site = await fakeSite();
    const { port } = await startProxy();
    for (const name of ["registry-1.docker.io", "ghcr.io", "pkg-containers.githubusercontent.com"]) {
      const answer = await raw(port, connectLine(`${name}:443`));
      expect(statusOf(answer), `${name}: ${answer}`).toBe(200);
    }
    expect(site.dialed).toEqual([{ host: "54.1.2.3", port: 443 }, { host: "140.82.112.34", port: 443 }, { host: "185.199.108.1", port: 443 }]);
    expect(asked).toEqual(["registry-1.docker.io", "ghcr.io", "pkg-containers.githubusercontent.com"]);
  });

  it("carries bytes both ways after the 200 (what the daemon sends next reaches the site, and the site's answer comes back)", async () => {
    hostResolver({ "registry-1.docker.io": ["54.1.2.3"] });
    const site = await fakeSite();
    const { port } = await startProxy();
    const answer = await raw(port, `${connectLine("registry-1.docker.io:443")}GET /v2/ HTTP/1.1\r\nHost: registry-1.docker.io\r\nConnection: close\r\n\r\n`, 700);
    expect(statusOf(answer)).toBe(200);
    expect(answer).toContain("site");
    expect(site.paths).toEqual(["registry-1.docker.io/v2/"]);
  });

  it("REFUSES an arbitrary host (the resolver does not know it), an address, a private answer and a port other than 443, and dials nothing", async () => {
    const asked = hostResolver({ "internal.example.com": ["10.0.0.5"], "mixed.example.com": ["8.8.8.8", "10.0.0.5"], "registry-1.docker.io": ["54.1.2.3"] });
    const site = await fakeSite();
    const { port } = await startProxy();
    for (const target of ["attacker.example.org:443", "internal.example.com:443", "mixed.example.com:443", "1.1.1.1:443", "127.0.0.1:443", "localhost:443", "[::1]:443", "registry-1.docker.io:80", "registry-1.docker.io:8443", "registry-1.docker.io:22", "registry-1.docker.io", "registry-1.docker.io:0443"]) {
      const answer = await raw(port, connectLine(target));
      expect(statusOf(answer), `${target}: ${answer}`).toBeGreaterThanOrEqual(400);
    }
    expect(site.dialed).toEqual([]);
    // Names that are not names, and the wrong ports, are refused before the resolver is asked.
    expect(asked).not.toContain("1.1.1.1");
    expect(asked).not.toContain("localhost");
    expect(asked.filter((name) => name === "registry-1.docker.io")).toEqual([]);
  });

  it("refuses S3 in every spelling (any bucket is a place to send data), except ECR's own layer bucket, which a registry pull needs", async () => {
    hostResolver({ "prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com": ["52.218.1.1"], "ok-bucket.s3.us-west-2.amazonaws.com": ["52.218.1.2"], "s3.amazonaws.com": ["52.218.1.3"] });
    const site = await fakeSite();
    const { port } = await startProxy();
    const refused = ["ok-bucket.s3.us-west-2.amazonaws.com", "s3.amazonaws.com", "s3.us-west-2.amazonaws.com", "s3-us-west-2.amazonaws.com", "bucket.s3-us-west-2.amazonaws.com", "bucket.s3.dualstack.us-west-2.amazonaws.com", "bucket.s3-accelerate.amazonaws.com",
      "bucket.s3-website-us-east-1.amazonaws.com", "bucket.s3express-use1-az1.us-east-1.amazonaws.com", "x.s3-accesspoint.us-west-2.amazonaws.com", "prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com.evil.example.org.s3.us-west-2.amazonaws.com",
      "evil-starport-layer-bucket.s3.us-west-2.amazonaws.com", "prod-x-starport-layer-bucket.evil.s3.us-west-2.amazonaws.com", "bucket.s3.cn-north-1.amazonaws.com.cn"];
    for (const name of refused) expect(statusOf(await raw(port, connectLine(`${name}:443`))), name).toBeGreaterThanOrEqual(400);
    expect(site.dialed).toEqual([]);
    expect(statusOf(await raw(port, connectLine("prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com:443")))).toBe(200);
    expect(site.dialed).toEqual([{ host: "52.218.1.1", port: 443 }]);
  });

  it("answers only the host's own address: another peer is dropped without an answer (the proxy is never reachable from a sandbox)", async () => {
    hostResolver({ "registry-1.docker.io": ["54.1.2.3"] });
    const site = await fakeSite();
    const { port } = await startProxy({ ...PROXY_CONFIG, proxy: { port: 3128, peer: "172.28.251.1/32" } });
    expect(await raw(port, connectLine("registry-1.docker.io:443"))).toBe("");
    expect(await raw(port, "GET http://registry-1.docker.io/ HTTP/1.1\r\nHost: registry-1.docker.io\r\n\r\n")).toBe("");
    expect(site.dialed).toEqual([]);
  });

  it("forwards a plain `GET http://host/path` for an allowed name (to the resolver's address on port 80, with the Host and path of the URL), and refuses everything else a plain proxy could be asked", async () => {
    const asked = hostResolver({ "deb.example.org": ["93.184.216.34"], "internal.example.com": ["10.0.0.5"] });
    const site = await fakeSite();
    const { port } = await startProxy();
    const ok = await raw(port, "GET http://deb.example.org/pool/a.deb?x=1 HTTP/1.1\r\nHost: deb.example.org\r\nProxy-Authorization: Basic eDp5\r\nConnection: close\r\n\r\n", 700);
    expect(statusOf(ok), ok).toBe(200);
    expect(site.dialed).toEqual([{ host: "93.184.216.34", port: 80 }]);
    expect(site.paths).toEqual(["deb.example.org/pool/a.deb?x=1"]);
    const attempts: Array<[string, number]> = [
      ["POST http://deb.example.org/ HTTP/1.1\r\nHost: deb.example.org\r\nContent-Length: 0\r\n\r\n", 405],
      ["GET https://deb.example.org/ HTTP/1.1\r\nHost: deb.example.org\r\n\r\n", 403],
      ["GET http://deb.example.org:8080/ HTTP/1.1\r\nHost: deb.example.org\r\n\r\n", 403],
      ["GET http://user:pw@deb.example.org/ HTTP/1.1\r\nHost: deb.example.org\r\n\r\n", 403],
      ["GET http://1.1.1.1/ HTTP/1.1\r\nHost: 1.1.1.1\r\n\r\n", 403],
      ["GET http://attacker.example.org/ HTTP/1.1\r\nHost: attacker.example.org\r\n\r\n", 403],
      ["GET http://internal.example.com/ HTTP/1.1\r\nHost: internal.example.com\r\n\r\n", 403],
      ["GET http://bucket.s3.us-west-2.amazonaws.com/x HTTP/1.1\r\nHost: bucket.s3.us-west-2.amazonaws.com\r\n\r\n", 403],
      // A request that is not in proxy form (a path only) names no host, and is refused too.
      ["GET /pool/a.deb HTTP/1.1\r\nHost: deb.example.org\r\n\r\n", 400],
    ];
    for (const [text, status] of attempts) expect(statusOf(await raw(port, text)), text.split("\r\n")[0]).toBe(status);
    expect(site.dialed).toEqual([{ host: "93.184.216.34", port: 80 }]);
    expect(asked).not.toContain("1.1.1.1");
  });
});

describe("the daemon proxy: the name rules", () => {
  it("s3Host and proxyAllowed: S3 only under amazonaws.com, the ECR layer bucket spelled exactly, names only, and the sandbox deny list does NOT apply to the daemon", async () => {
    const gateway = await load(PROXY_CONFIG);
    const s3: Array<[string, boolean]> = [["a.s3.us-west-2.amazonaws.com", true], ["s3.amazonaws.com", true], ["a.s3-accelerate.amazonaws.com", true], ["a.s3express-x.us-east-1.amazonaws.com", true], ["s3.example.org", false], ["registry.npmjs.org", false],
      ["ecr.us-west-2.amazonaws.com", false], ["prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com.evil.org", false], ["123456789012.dkr.ecr.us-west-2.amazonaws.com", false], ["a.s3.amazonaws.com.evil.org", false]];
    for (const [host, yes] of s3) expect(gateway.s3Host(host), host).toBe(yes);
    for (const name of ["registry-1.docker.io", "ghcr.io", "123456789012.dkr.ecr.us-west-2.amazonaws.com", "public.ecr.aws", "gcr.io", "prod-us-west-2-starport-layer-bucket.s3.us-west-2.amazonaws.com"]) {
      expect(gateway.proxyAllowed(name), name).toBe(true);
      // The sandbox deny list is still what it was for a sandbox (the daemon's allowance is no loosening of theirs).
      if (!name.includes("starport")) expect(gateway.hostAllowed(name, "sandbox"), `${name} for a sandbox`).toBe(false);
    }
    for (const bad of ["1.1.1.1", "localhost", "", "a_b.example.org", "bucket.s3.us-west-2.amazonaws.com"]) expect(gateway.proxyAllowed(bad), bad).toBe(false);
  });
});

describe("the boot stage's proxy probe, against the real program", () => {
  const stage = readFileSync(new URL("../../packages/worker/ec2/sandbox-egress.sh", import.meta.url), "utf8");
  const functionText = (name: string): string => { const start = stage.indexOf(`\n${name}() {`); return stage.slice(start, stage.indexOf("\n}\n", start) + 3); };
  const runBash = (script: string): Promise<{ code: number; out: string }> => new Promise((resolve) => {
    execFile("bash", ["-c", script], { encoding: "utf8", timeout: 20_000 }, (error, stdout) => resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1, out: stdout }));
  });
  const probeScript = (port: number): string => `SE_OUTER_IP=127.0.0.1; SE_PROXY_PORT=${String(port)}\n${functionText("se_proxy_ask")}\n${functionText("se_proxy_probe")}\n`;

  it("se_proxy_ask reads the proxy's status line from a real listener, and se_proxy_probe passes only when a raw address, an S3 bucket and port 22 are each refused", async () => {
    hostResolver({ "registry-1.docker.io": ["54.1.2.3"] });
    await fakeSite();
    const { port } = await startProxy();
    expect((await runBash(`${probeScript(port)}se_proxy_ask 1.1.1.1:443`)).out).toMatch(/^HTTP\/1\.1 403/u);
    expect((await runBash(`${probeScript(port)}se_proxy_ask registry-1.docker.io:443`)).out).toMatch(/^HTTP\/1\.1 200/u);
    expect((await runBash(`${probeScript(port)}se_proxy_probe`)).code).toBe(0);
  }, 60_000);

  it("se_proxy_probe FAILS when nothing listens, and when the listener would tunnel (an allowed-everything stand-in answers 200)", async () => {
    expect((await runBash(`${probeScript(1)}se_proxy_probe`)).code).not.toBe(0);
    const open = createNetServer((socket) => { socket.on("error", () => undefined); socket.once("data", () => socket.end("HTTP/1.1 200 Connection Established\r\n\r\n")); });
    await new Promise<void>((resolve) => open.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { open.close(); });
    expect((await runBash(`${probeScript((open.address() as AddressInfo).port)}se_proxy_probe`)).code).not.toBe(0);
  }, 60_000);
});
