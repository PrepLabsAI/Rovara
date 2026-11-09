// Test services TS27: the test-account proxy. Real sockets on loopback; the resolver and the upstream connection are fakes, so nothing leaves the machine.
import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  denyChecker, isForbiddenAddress, looksLikeAddress, parseConnectTarget, proxyHostName, startTestAccountProxy, testAccountProxyEnv, type TestAccountProxy, type TestAccountProxyOptions,
} from "../../packages/worker/src/test-account-proxy.js";

const PUBLIC_IP = "93.184.216.34";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

/** An upstream that echoes. */
async function echo(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => { sockets.add(socket); socket.on("data", (chunk: Buffer) => { received.push(chunk); socket.write(chunk); }); socket.on("error", () => undefined); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }));
  return { port: (server.address() as { port: number }).port, received };
}

interface Rig { proxy: TestAccountProxy; connects: Array<{ address: string; port: number }>; resolved: string[]; upstream: { port: number; received: Buffer[] } }

async function rig(over: Partial<TestAccountProxyOptions> & { answers?: Record<string, string[]> } = {}): Promise<Rig> {
  const upstream = await echo();
  const connects: Array<{ address: string; port: number }> = [];
  const resolved: string[] = [];
  const { answers, ...options } = over;
  const proxy = await startTestAccountProxy({
    hosts: ["api.example-pay.com", "files.example-pay.com"],
    isDenied: denyChecker({ accountIds: [], hosts: ["*.prod.example.com", "billing.example-pay.com"], arnPrefixes: [] }),
    maxConnections: 50,
    listenAddress: "127.0.0.1",
    listenPort: 0,
    allowedSources: ["127.0.0.1"],
    resolve: (host) => { resolved.push(host); return Promise.resolve(answers?.[host] ?? [PUBLIC_IP]); },
    connect: (address, port) => { connects.push({ address, port }); return connect({ host: "127.0.0.1", port: upstream.port }); },
    ...options,
  });
  cleanup.push(() => proxy.close());
  return { proxy, connects, resolved, upstream };
}

/** Sends one request line and reads the response head; returns the status and the open socket. */
function request(proxy: TestAccountProxy, text: string): Promise<{ status: number; head: string; socket: Socket; rest: Buffer }> {
  return new Promise((done, fail) => {
    const socket = connect({ host: proxy.address, port: proxy.port });
    cleanup.push(() => { socket.destroy(); });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      const head = buffer.subarray(0, end).toString("utf8");
      done({ status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1]), head, socket, rest: buffer.subarray(end + 4) });
    });
    socket.on("error", fail);
    socket.on("close", () => { if (buffer.indexOf("\r\n\r\n") < 0) done({ status: 0, head: buffer.toString("utf8"), socket, rest: Buffer.alloc(0) }); });
    socket.write(text);
  });
}
const connectTo = (proxy: TestAccountProxy, target: string) => request(proxy, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
const refusedTotal = (proxy: TestAccountProxy) => Object.values(proxy.snapshot().refused).reduce((sum, count) => sum + count, 0);

describe("names and addresses", () => {
  it("accepts plain names, in any case and with a trailing dot, and nothing that can be read as an address", () => {
    expect(proxyHostName("API.Example-Pay.com.")).toBe("api.example-pay.com");
    for (const bad of ["", "localhost", "127.0.0.1", "127.1", "0x7f.1", "0x7f000001", "2130706433", "1.2.3.4", "01.02.03.04", "::1", "[::1]", "fe80::1%eth0", "a_b.example.com", "-a.example.com", "a..example.com", "*.example.com", "exa mple.com", "example.com/x", "a.b.123", "é.example.com", "1.0x7f", "0x7f.0x1", "0xa.0x0.0x0.0x1", "x".repeat(64) + ".example.com", `${"a.".repeat(130)}com`]) {
      expect(proxyHostName(bad), JSON.stringify(bad)).toBeUndefined();
    }
    for (const address of ["127.0.0.1", "127.1", "0x7f.1", "2130706433", "017700000001", "[::1]", "::1", "localhost", "intranet", "1.2.3", "10.0.0.1.", "fe80::1"]) expect(looksLikeAddress(address), address).toBe(true);
    for (const name of ["api.example-pay.com", "a.b.example.io", "xn--bcher-kva.example.com"]) expect(looksLikeAddress(name), name).toBe(false);
  });

  it("parses a CONNECT target as exactly host:443", () => {
    expect(parseConnectTarget("api.example-pay.com:443")).toEqual({ host: "api.example-pay.com", port: 443 });
    expect(parseConnectTarget("API.Example-Pay.com.:443")).toEqual({ host: "api.example-pay.com", port: 443 });
    for (const bad of ["", "api.example-pay.com", "api.example-pay.com:80", "api.example-pay.com:8443", "api.example-pay.com:0443x", "api.example-pay.com:443:443", ":443", "user@api.example-pay.com:443", "api.example-pay.com:443/x", "api.example-pay.com :443", "api.example-pay.com:443\r\nX: y", "api.example-pay.com\\:443"]) {
      const result = parseConnectTarget(bad);
      expect("refusal" in result && ["bad_request", "ip_literal"].includes(result.refusal), JSON.stringify(bad)).toBe(true);
    }
    for (const literal of ["127.0.0.1:443", "[::1]:443", "[2001:db8::1]:443", "2130706433:443", "0x7f.1:443", "localhost:443", "10.1.2.3:443", "::1:443"]) expect(parseConnectTarget(literal), literal).toEqual({ refusal: "ip_literal" });
  });

  it("L2: denies every IPv6 range that can carry or translate to a private address, in any spelling", () => {
    const probes: Array<[string, string]> = [
      ["::/96 unspecified", "::"], ["::/96 loopback", "::1"], ["::/96 loopback spelled out", "0:0:0:0:0:0:0:1"], ["::/96 low address", "::2"], ["::/96 IPv4-compatible dotted", "::7f00:1"], ["::/96 IPv4-compatible tail", "::127.0.0.1"],
      ["::/96 compatible public", "::8.8.8.8"], ["::/96 hex", "0:0:0:0:0:0:808:808"],
      ["::ffff:0:0/96 public dotted", "::ffff:8.8.8.8"], ["::ffff:0:0/96 public hex", "::ffff:808:808"], ["::ffff:0:0/96 private", "::ffff:10.0.0.1"], ["::ffff:0:0/96 metadata", "::ffff:169.254.169.254"],
      ["::ffff:0:0/96 spelled out", "0:0:0:0:0:ffff:808:808"], ["::ffff:0:0/96 upper case", "::FFFF:8.8.8.8"],
      ["64:ff9b::/96", "64:ff9b::808:808"], ["64:ff9b:1::/48 local-use NAT64", "64:ff9b:1::1"], ["64:ff9b:1::/48 upper end", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"], ["64:ff9b:1::/48 dotted tail", "64:ff9b:1::8.8.8.8"], ["64:ff9b:1::/48 inside", "64:ff9b:1:abcd::1"], ["64:ff9b::/96 dotted", "64:ff9b::8.8.8.8"], ["100::/64", "100::1"],
      ["fec0::/10 site-local", "fec0::1"], ["fec0::/10 upper end", "feff:ffff::1"], ["fe80::/10 link-local", "fe80::1"], ["fe80::/10 with a zone", "fe80::1%eth0"], ["fe80::/10 upper end", "febf::1"],
      ["2002::/16 6to4 public", "2002:808:808::1"], ["2002::/16 6to4 private", "2002:a00:1::1"], ["2002::/16 6to4 metadata", "2002:a9fe:a9fe::"], ["2002::/16 first", "2002::"], ["2002::/16 last", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["2001::/32 Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"], ["2001::/32 first", "2001::"], ["2001::/32 compressed", "2001::1"], ["2001:db8::/32 documentation", "2001:db8::1"],
      ["fc00::/7 unique local", "fd12:3456::1"], ["fc00::/7 first", "fc00::"], ["ff00::/8 multicast", "ff02::1"],
    ];
    for (const [label, address] of probes) expect(isForbiddenAddress(address), `${label}: ${address}`).toBe(true);
    // The neighbours of those ranges are public addresses and stay reachable.
    for (const address of ["2001:1::1", "2001:4860:4860::8888", "2003::1", "2001:db9::1", "fe00::1", "ec00::1", "fbff::1", "64:ff9a::1", "64:ff9b:2::1", "64:ff9b:101::1", "64:ff9b:ffff::1", "64:ff9c:1::1", "101::1", "100:0:0:1::1", "1::1", "::ff00:808:808", "::fffe:808:808", "::ff:808:808"]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
    for (const notAnAddress of ["", "not-an-address", "1.2.3", "::g", ":::", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1"]) expect(isForbiddenAddress(notAnAddress), notAnAddress).toBe(true);
  });

  it("calls loopback, private, link-local, metadata, shared, multicast, reserved and mapped addresses forbidden, and a public one fine", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:a00:1", "2001:db8::1", "not-an-address"]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2620:0:860:2::1"]) expect(isForbiddenAddress(address), address).toBe(false);
  });
});

describe("the proxy", () => {
  it("tunnels an allowed host over 443 to the address it checked, never terminating TLS, and counts connections and bytes", async () => {
    const { proxy, connects, resolved, upstream } = await rig();
    const tunnel = await connectTo(proxy, "api.example-pay.com:443");
    expect(tunnel.status).toBe(200);
    const reply = new Promise<string>((done) => tunnel.socket.once("data", (chunk: Buffer) => done(chunk.toString("utf8"))));
    tunnel.socket.write("\u0016\u0003\u0001 hello");
    expect(await reply).toBe("\u0016\u0003\u0001 hello");
    expect(connects).toEqual([{ address: PUBLIC_IP, port: 443 }]);
    expect(resolved).toEqual(["api.example-pay.com"]);
    expect(Buffer.concat(upstream.received).toString("utf8")).toBe("\u0016\u0003\u0001 hello");
    tunnel.socket.end();
    const snapshot = proxy.snapshot();
    expect(snapshot.connections).toBe(1);
    expect(snapshot.hosts).toEqual([{ host: "api.example-pay.com", connections: 1, bytesUp: 9, bytesDown: 9 }]);
    expect(refusedTotal(proxy)).toBe(0);
  });

  it("forwards bytes the client sent in the same packet as its CONNECT", async () => {
    const { proxy, upstream } = await rig();
    const tunnel = await request(proxy, "CONNECT files.example-pay.com:443 HTTP/1.1\r\nHost: files.example-pay.com:443\r\n\r\nEARLY");
    expect(tunnel.status).toBe(200);
    await new Promise((done) => setTimeout(done, 50));
    expect(Buffer.concat(upstream.received).toString("utf8")).toBe("EARLY");
  });

  it("refuses every address spelling, a wrong port and a bad target, without opening anything or resolving a name", async () => {
    const { proxy, connects, resolved } = await rig();
    for (const target of ["127.0.0.1:443", "[::1]:443", "2130706433:443", "0x7f.1:443", "localhost:443", "10.0.0.5:443", "93.184.216.34:443", "api.example-pay.com:80", "api.example-pay.com:8443", "u@api.example-pay.com:443", "api.example-pay.com"]) {
      const result = await connectTo(proxy, target);
      expect([400, 403], target).toContain(result.status);
    }
    expect(connects).toEqual([]);
    expect(resolved).toEqual([]);
    expect(proxy.snapshot().refused.ip_literal).toBeGreaterThanOrEqual(7);
    expect(proxy.snapshot().connections).toBe(0);
  });

  it("refuses a name that is not on the run's list, a name that only starts or ends like one, and a name on the production deny list even if the list has it", async () => {
    const { proxy, connects } = await rig({ hosts: ["api.example-pay.com", "billing.example-pay.com"] });
    for (const target of ["other.example-pay.com:443", "api.example-pay.com.evil.com:443", "evilapi.example-pay.com:443", "example-pay.com:443", "x.api.example-pay.com:443", "billing.example-pay.com:443", "a.prod.example.com:443"]) {
      expect((await connectTo(proxy, target)).status, target).toBe(403);
    }
    expect(connects).toEqual([]);
    const refused = proxy.snapshot().refused;
    expect(refused.denied).toBe(2);
    expect(refused.not_allowed).toBe(5);
  });

  it("matches the name in any case and with a trailing dot", async () => {
    const { proxy } = await rig();
    expect((await connectTo(proxy, "API.EXAMPLE-PAY.COM.:443")).status).toBe(200);
  });

  it("refuses anything but CONNECT and keeps the request to itself", async () => {
    const { proxy, connects } = await rig();
    const get = await request(proxy, "GET http://api.example-pay.com/v1 HTTP/1.1\r\nHost: api.example-pay.com\r\n\r\n");
    expect(get.status).toBe(405);
    const post = await request(proxy, "POST http://api.example-pay.com/v1 HTTP/1.1\r\nHost: api.example-pay.com\r\nContent-Length: 4\r\n\r\nbody");
    expect(post.status).toBe(405);
    expect(connects).toEqual([]);
    expect(proxy.snapshot().refused.not_connect).toBe(2);
  });

  it("serves only the sandbox's address", async () => {
    const { proxy, connects } = await rig({ allowedSources: ["10.30.7.4"] });
    expect((await connectTo(proxy, "api.example-pay.com:443")).status).toBe(403);
    expect((await request(proxy, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")).status).toBe(403);
    expect(connects).toEqual([]);
    expect(proxy.snapshot().refused.source).toBe(2);
    // An IPv4-mapped spelling of the sandbox's address is the same caller.
    const mapped = await rig({ allowedSources: ["::ffff:127.0.0.1"] });
    expect((await connectTo(mapped.proxy, "api.example-pay.com:443")).status).toBe(200);
  });

  it("caps the run's connections, then refuses with 429 and says so", async () => {
    const { proxy } = await rig({ maxConnections: 2 });
    const first = await connectTo(proxy, "api.example-pay.com:443");
    const second = await connectTo(proxy, "api.example-pay.com:443");
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await connectTo(proxy, "api.example-pay.com:443")).status).toBe(429);
    const snapshot = proxy.snapshot();
    expect(snapshot).toMatchObject({ connections: 2, capReached: true });
    expect(snapshot.refused.cap).toBe(1);
  });

  it("holds the connections open at once to its limit", async () => {
    const { proxy } = await rig({ maxConcurrent: 2 });
    const a = await connectTo(proxy, "api.example-pay.com:443");
    const b = await connectTo(proxy, "api.example-pay.com:443");
    expect((await connectTo(proxy, "api.example-pay.com:443")).status).toBe(429);
    a.socket.destroy();
    await new Promise((done) => setTimeout(done, 50));
    expect((await connectTo(proxy, "api.example-pay.com:443")).status).toBe(200);
    b.socket.destroy();
  });

  it("refuses a name that resolves to any private, loopback or metadata address, and connects to nothing", async () => {
    const answers: Record<string, string[]> = {
      "api.example-pay.com": ["10.1.2.3"], "files.example-pay.com": [PUBLIC_IP, "169.254.169.254"], "third.example-pay.com": ["::1"], "fourth.example-pay.com": ["::ffff:127.0.0.1"], "fifth.example-pay.com": [],
    };
    const { proxy, connects } = await rig({ hosts: Object.keys(answers), answers });
    for (const host of Object.keys(answers)) expect((await connectTo(proxy, `${host}:443`)).status, host).toBe(host === "fifth.example-pay.com" ? 403 : 403);
    expect(connects).toEqual([]);
    expect(proxy.snapshot().refused.private_address).toBe(5);
  });

  it("answers 502 when the name does not resolve or the upstream does not answer, and never connects a second time by name", async () => {
    const failing = await rig({ resolve: () => Promise.reject(new Error("ENOTFOUND api.example-pay.com")) });
    const unresolved = await connectTo(failing.proxy, "api.example-pay.com:443");
    expect(unresolved.status).toBe(502);
    expect(unresolved.head).not.toContain("ENOTFOUND");
    const dead = await rig({ connect: () => connect({ host: "127.0.0.1", port: 1 }) });
    expect((await connectTo(dead.proxy, "api.example-pay.com:443")).status).toBe(502);
    expect(dead.proxy.snapshot().refused.upstream).toBe(1);
  });

  it("does not hold a slot for a name server that never answers", async () => {
    const { proxy } = await rig({ resolve: () => new Promise<string[]>(() => undefined), connectTimeoutMs: 60 });
    const started = Date.now();
    expect((await connectTo(proxy, "api.example-pay.com:443")).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(proxy.snapshot().refused.upstream).toBe(1);
  });

  it("opens nothing for a caller that has already gone", async () => {
    let release: (addresses: string[]) => void = () => undefined;
    const { proxy, connects } = await rig({ resolve: () => new Promise<string[]>((done) => { release = done; }) });
    const socket = connect({ host: proxy.address, port: proxy.port });
    cleanup.push(() => { socket.destroy(); });
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write("CONNECT api.example-pay.com:443 HTTP/1.1\r\nHost: api.example-pay.com:443\r\n\r\n");
    await new Promise((done) => setTimeout(done, 50));
    socket.destroy();
    await new Promise((done) => setTimeout(done, 50));
    release([PUBLIC_IP]);
    await new Promise((done) => setTimeout(done, 100));
    expect(connects.length <= 1).toBe(true);
    expect(proxy.snapshot().connections).toBe(1);
  });

  it("never puts what was asked for in an answer or in the snapshot", async () => {
    const { proxy } = await rig();
    const secretHost = "attacker-controlled.evil.example";
    const result = await connectTo(proxy, `${secretHost}:443`);
    expect(result.head).not.toContain(secretHost);
    expect(JSON.stringify(proxy.snapshot())).not.toContain(secretHost);
    const pasted = ["sk", "test", "ABCDEF1234567890"].join("_");
    const bad = await connectTo(proxy, `paste-of-a-key-${pasted}:443`);
    expect(bad.head).not.toContain(pasted);
    expect(JSON.stringify(proxy.snapshot())).not.toContain(pasted);
  });

  it("L1: cuts a tunnel that carries more than its byte cap, and counts what passed before the cut", async () => {
    const { proxy } = await rig({ maxTunnelBytes: 100 });
    const tunnel = await connectTo(proxy, "api.example-pay.com:443");
    expect(tunnel.status).toBe(200);
    const closed = new Promise<boolean>((done) => { tunnel.socket.once("close", () => done(true)); setTimeout(() => done(false), 1_500); });
    tunnel.socket.write("x".repeat(60)); // 60 up, and the echo makes 120 together: past 100
    expect(await closed).toBe(true);
    const snapshot = proxy.snapshot();
    expect(snapshot.cut).toEqual({ bytes: 1, duration: 0 });
    expect(snapshot.hosts[0]).toMatchObject({ bytesUp: 60, bytesDown: 0 });
    expect(snapshot.bytes).toBe(60);
  });

  it("L1: lets a tunnel carry up to its cap, and counts every connection's bytes in the snapshot total", async () => {
    const { proxy } = await rig({ maxTunnelBytes: 100 });
    for (const host of ["api.example-pay.com", "files.example-pay.com"]) {
      const tunnel = await connectTo(proxy, `${host}:443`);
      const reply = new Promise<string>((done) => tunnel.socket.once("data", (chunk: Buffer) => done(chunk.toString("utf8"))));
      tunnel.socket.write("y".repeat(50)); // 50 up and 50 echoed: exactly 100
      expect(await reply).toBe("y".repeat(50));
      tunnel.socket.end();
    }
    await new Promise((done) => setTimeout(done, 50));
    const snapshot = proxy.snapshot();
    expect(snapshot.bytes).toBe(200);
    expect(snapshot.cut).toEqual({ bytes: 0, duration: 0 });
  });

  it("L1: cuts a tunnel that lives longer than its time cap", async () => {
    const { proxy } = await rig({ maxTunnelMs: 80 });
    const tunnel = await connectTo(proxy, "api.example-pay.com:443");
    const closed = await new Promise<boolean>((done) => { tunnel.socket.once("close", () => done(true)); setTimeout(() => done(false), 1_500); });
    expect(closed).toBe(true);
    expect(proxy.snapshot().cut).toEqual({ bytes: 0, duration: 1 });
  });

  it("L1: refuses a per-tunnel cap that is not a positive whole number", async () => {
    const base: TestAccountProxyOptions = { hosts: ["api.example-pay.com"], isDenied: () => false, maxConnections: 10, listenAddress: "127.0.0.1", listenPort: 0, allowedSources: ["127.0.0.1"] };
    for (const over of [{ maxTunnelBytes: 0 }, { maxTunnelBytes: -1 }, { maxTunnelBytes: 1.5 }, { maxTunnelMs: 0 }, { maxTunnelMs: Number.NaN }]) {
      await expect(startTestAccountProxy({ ...base, ...over })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("closes an idle tunnel", async () => {
    const { proxy } = await rig({ idleTimeoutMs: 80 });
    const tunnel = await connectTo(proxy, "api.example-pay.com:443");
    expect(tunnel.status).toBe(200);
    const closed = await new Promise<boolean>((done) => { tunnel.socket.once("close", () => done(true)); setTimeout(() => done(false), 1_500); });
    expect(closed).toBe(true);
  });

  it("is made only for one address, a small plain list, a bounded cap and a named sandbox", async () => {
    const base: TestAccountProxyOptions = { hosts: ["api.example-pay.com"], isDenied: () => false, maxConnections: 10, listenAddress: "127.0.0.1", listenPort: 0, allowedSources: ["127.0.0.1"] };
    const refuses = async (over: Partial<TestAccountProxyOptions>) => { await expect(startTestAccountProxy({ ...base, ...over })).rejects.toBeInstanceOf(RangeError); };
    await refuses({ listenAddress: "0.0.0.0" });
    await refuses({ listenAddress: "::" });
    await refuses({ listenAddress: "not-an-address" });
    await refuses({ hosts: [] });
    await refuses({ hosts: Array.from({ length: 9 }, (_, i) => `h${String(i)}.example.com`) });
    await refuses({ hosts: ["*.example.com"] });
    await refuses({ hosts: ["10.0.0.1"] });
    await refuses({ hosts: ["api.example-pay.com:443"] });
    await refuses({ hosts: ["API.example-pay.com"] });
    await refuses({ maxConnections: 0 });
    await refuses({ maxConnections: 20_001 });
    await refuses({ allowedSources: [] });
  });
});

describe("the sandbox's proxy variables", () => {
  it("sets both spellings and lists only the run's own plain names", () => {
    const env = testAccountProxyEnv({ address: "172.30.5.8", noProxy: ["postgres", "redis", "fake-payments"] });
    expect(env).toEqual({
      HTTPS_PROXY: "http://172.30.5.8:3128", HTTP_PROXY: "http://172.30.5.8:3128", https_proxy: "http://172.30.5.8:3128", http_proxy: "http://172.30.5.8:3128",
      NO_PROXY: "postgres,redis,fake-payments", no_proxy: "postgres,redis,fake-payments",
    });
    expect(testAccountProxyEnv({ address: "172.30.5.8", port: 8080, noProxy: [] }).HTTPS_PROXY).toBe("http://172.30.5.8:8080");
    for (const bad of [{ address: "proxy.local", noProxy: [] }, { address: "172.30.5.8", noProxy: ["a,b"] }, { address: "172.30.5.8", noProxy: ["*"] }, { address: "172.30.5.8", noProxy: ["http://x"] }, { address: "172.30.5.8", port: 0, noProxy: [] }]) {
      expect(() => testAccountProxyEnv(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});
