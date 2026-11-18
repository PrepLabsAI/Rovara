// Lane L4-NETG (DEC 254zzz77): the egress gateway program in HOST mode, the mode an EC2 worker host runs for its task sandboxes and devcontainers. The program is loaded as a library (the same text the container runs).
// Host mode has no static allow list: a name is allowed when it is a plain name, is not on the sandbox deny list and the host's own resolver answers it with PUBLIC addresses. The resolver is replaced by a spy here, so nothing
// leaves this machine.
import { createRequire } from "node:module";
import dns from "node:dns";
import net, { connect as netConnect, createServer as createNetServer, type Server } from "node:net";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { connect as tlsConnect } from "node:tls";
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

interface Started { role: string; dns: { udp: DgramSocket; tcp: Server }; tls: Server; plain: Server }
interface Gateway {
  hostAllowed(host: string, role?: string): boolean;
  patternCovers(entry: string, host: string): boolean;
  main(): Started[];
}
const HOST_CONFIG = { mode: "host", sandboxDenied: SANDBOX_REGISTRY_DENY, nets: { sandbox: "127.0.0.0/8", external: "10.9.9.0/24" } };

async function load(config: Record<string, unknown>, environment: Record<string, string> = {}): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), "gw-host-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = { ...process.env };
  const keys = ["ROVARA_GW_CONFIG", "ROVARA_GW_LIBRARY", "ROVARA_GW_TLS_PORT", "ROVARA_GW_PLAIN_PORT", "ROVARA_GW_DNS_PORT", "ROVARA_GW_TEST_ADDRESSES", ...Object.keys(environment)];
  Object.assign(process.env, { ROVARA_GW_CONFIG: JSON.stringify(config), ROVARA_GW_LIBRARY: "1", ROVARA_GW_TLS_PORT: "0", ROVARA_GW_PLAIN_PORT: "0", ROVARA_GW_DNS_PORT: "0", ...environment });
  try {
    return createRequire(import.meta.url)(file) as Gateway;
  } finally {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, saved);
  }
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

function query(name: string, type = 1): Buffer {
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4321, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}
const rcode = (reply: Buffer): number => reply.readUInt16BE(2) & 0xf;
const answers = (reply: Buffer): number => reply.readUInt16BE(6);

/** Starts the gateway in host mode on the loopback (the sandbox network is 127.0.0.0/8) and returns its name server's UDP and TCP ports and its forwarders' ports. */
async function startHost(config: Record<string, unknown> = HOST_CONFIG) {
  const gateway = await load(config, { ROVARA_GW_TEST_ADDRESSES: JSON.stringify({ worker: [], sandbox: ["127.0.0.1"], external: ["10.9.9.2"] }) });
  const started = gateway.main();
  const one = started[0]!;
  cleanup.push(async () => {
    one.dns.udp.close();
    one.dns.tcp.close();
    one.tls.close();
    one.plain.close();
    (one.plain as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  });
  const listening = (server: Server): Promise<number> => new Promise((resolve) => { const done = (): void => resolve((server.address() as AddressInfo).port); if (server.listening) done(); else server.once("listening", done); });
  const bound = (socket: DgramSocket): Promise<number> => new Promise((resolve) => { try { resolve(socket.address().port); } catch { socket.once("listening", () => resolve(socket.address().port)); } });
  return { started, gateway, udp: await bound(one.dns.udp), tcp: await listening(one.dns.tcp), tls: await listening(one.tls), plain: await listening(one.plain) };
}

function ask(port: number, message: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve(undefined); }, 1500);
    socket.on("message", (reply) => { clearTimeout(timer); socket.close(); resolve(reply); });
    socket.send(message, port, "127.0.0.1");
  });
}
function askTcp(port: number, messages: Buffer[]): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const replies: Buffer[] = [];
    let held = Buffer.alloc(0);
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      for (const message of messages) {
        const framed = Buffer.alloc(2);
        framed.writeUInt16BE(message.length, 0);
        socket.write(Buffer.concat([framed, message]));
      }
    });
    socket.on("data", (chunk) => {
      held = Buffer.concat([held, chunk]);
      while (held.length >= 2 && held.length >= 2 + held.readUInt16BE(0)) {
        replies.push(Buffer.from(held.subarray(2, 2 + held.readUInt16BE(0))));
        held = held.subarray(2 + held.readUInt16BE(0));
      }
      if (replies.length === messages.length) { socket.destroy(); resolve(replies); }
    });
    socket.on("error", () => resolve(replies));
    setTimeout(() => { socket.destroy(); resolve(replies); }, 2000).unref();
  });
}

/** The first bytes a real TLS client sends, with this server name. */
function helloFor(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = createNetServer((socket) => { socket.once("data", (data) => { resolve(data); socket.destroy(); server.close(); }); }).listen(0, "127.0.0.1", () => {
      const client = tlsConnect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, rejectUnauthorized: false, servername });
      client.on("error", () => undefined);
    });
  });
}
/** Sends a hello for `servername` and says whether the gateway answered a byte (it never does for a refusal). */
async function sendHello(port: number, servername: string): Promise<boolean> {
  const hello = await helloFor(servername);
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(hello));
    let answered = false;
    socket.on("data", () => { answered = true; });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(answered));
    setTimeout(() => socket.destroy(), 1200).unref();
  });
}
function sendHttp(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("latin1"); });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(text)?.[1]) || undefined));
    setTimeout(() => socket.destroy(), 1200).unref();
  });
}
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REGISTRIES = [
  "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com", "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  "docker.io", "index.docker.io", "ghcr.io", "pkg.ghcr.io", "pkg-containers.githubusercontent.com", "gcr.io", "eu.gcr.io", "us-docker.pkg.dev", "europe-west1-docker.pkg.dev", "quay.io", "cdn.quay.io", "public.ecr.aws",
  "api.ecr-public.us-east-1.amazonaws.com", "123456789012.dkr.ecr.us-west-2.amazonaws.com", "api.ecr.us-west-2.amazonaws.com", "ecr.us-west-2.amazonaws.com",
];

describe("host mode: the deny list and the host resolver decide, nothing else", () => {
  it("refuses every push-capable registry name for a sandbox, and answers a plain name before the resolver is asked", async () => {
    const gateway = await load(HOST_CONFIG);
    for (const name of REGISTRIES) expect(gateway.hostAllowed(name, "sandbox"), name).toBe(false);
    for (const name of ["registry.npmjs.org", "github.com", "pypi.org", "files.pythonhosted.org", "s3.us-west-2.amazonaws.com", "mcr.microsoft.com", "api.anthropic.com", "dl-cdn.alpinelinux.org"]) expect(gateway.hostAllowed(name, "sandbox"), name).toBe(true);
    // Not a name at all (an address, a single label, a bad label): never allowed, resolver or not.
    for (const bad of ["1.1.1.1", "127.0.0.1", "localhost", "a_b.example.com", "", "2130706433", "0x7f.1"]) expect(gateway.hostAllowed(bad, "sandbox"), bad).toBe(false);
  });

  it("fails closed on a missing or odd role (only exactly `worker` is exempt from the deny, and a host-mode gateway has no worker network)", async () => {
    const gateway = await load(HOST_CONFIG);
    expect(gateway.hostAllowed("ghcr.io")).toBe(false);
    expect(gateway.hostAllowed("ghcr.io", "")).toBe(false);
    expect(gateway.hostAllowed("ghcr.io", "Worker")).toBe(false);
  });

  it("a mode that is not exactly `host` is the laptop mode: an empty allow list refuses every name (a typo never opens the list)", async () => {
    for (const mode of ["HOST", "hots", "", undefined]) {
      const gateway = await load({ ...HOST_CONFIG, mode, allowed: [] });
      expect(gateway.hostAllowed("registry.npmjs.org", "sandbox"), String(mode)).toBe(false);
    }
  });

  it("a one-label `*` is exactly one label and a leading `*` is one or more (the ECR patterns cannot cover other AWS names)", async () => {
    const gateway = await load(HOST_CONFIG);
    const cases: Array<[string, string, boolean]> = [
      ["*.dkr.ecr.*.amazonaws.com", "123456789012.dkr.ecr.us-west-2.amazonaws.com", true],
      ["*.dkr.ecr.*.amazonaws.com", "dkr.ecr.us-west-2.amazonaws.com", false],
      ["*.dkr.ecr.*.amazonaws.com", "123456789012.dkr.ecr.amazonaws.com", false],
      ["*.dkr.ecr.*.amazonaws.com", "123456789012.dkr.ecr.a.b.amazonaws.com", false],
      ["*.dkr.ecr.*.amazonaws.com", "s3.us-west-2.amazonaws.com", false],
      ["api.ecr.*.amazonaws.com", "api.ecr.us-west-2.amazonaws.com", true],
      ["api.ecr.*.amazonaws.com", "api.ecr.us-west-2.amazonaws.com.evil.dev", false],
      ["*.pkg.dev", "us-docker.pkg.dev", true], ["*.pkg.dev", "pkg.dev", false], ["*.pkg.dev", "a.b.pkg.dev", true],
    ];
    for (const [entry, host, covered] of cases) expect(gateway.patternCovers(entry, host), `${entry} ${host}`).toBe(covered);
  });
});

describe("host mode: the name server", () => {
  it("answers an allowed name with the gateway's own address after the host resolver gave public addresses, and NXDOMAIN for everything else", async () => {
    const asked = hostResolver({ "registry.npmjs.org": ["104.16.1.1"], "ghcr.io": ["140.82.112.34"], "internal.example.com": ["10.0.0.5"], "mixed.example.com": ["8.8.8.8", "10.0.0.5"] });
    const { udp } = await startHost();
    const allowed = (await ask(udp, query("registry.npmjs.org")))!;
    expect(rcode(allowed)).toBe(0);
    expect(answers(allowed)).toBe(1);
    expect([...allowed.subarray(allowed.length - 4)]).toEqual([127, 0, 0, 1]);
    // On the deny list: NXDOMAIN, and the resolver is never asked (the real address of a registry is never fetched for a sandbox).
    for (const name of ["ghcr.io", "registry-1.docker.io", "123456789012.dkr.ecr.us-west-2.amazonaws.com"]) expect(rcode((await ask(udp, query(name)))!), name).toBe(3);
    expect(asked).toEqual(["registry.npmjs.org"]);
    // The host resolver does not know it (the DNS firewall's NXDOMAIN): NXDOMAIN here too. A private address, or one private address among public ones: refused.
    expect(rcode((await ask(udp, query("blocked-by-firewall.example.org")))!)).toBe(3);
    expect(rcode((await ask(udp, query("internal.example.com")))!)).toBe(3);
    expect(rcode((await ask(udp, query("mixed.example.com")))!)).toBe(3);
  });

  it("answers an AAAA question for an allowed name with no data (the sandbox network has no IPv6), and the same over TCP, in order", async () => {
    hostResolver({ "registry.npmjs.org": ["104.16.1.1"] });
    const { udp, tcp } = await startHost();
    const aaaa = (await ask(udp, query("registry.npmjs.org", 28)))!;
    expect(rcode(aaaa)).toBe(0);
    expect(answers(aaaa)).toBe(0);
    const replies = await askTcp(tcp, [query("ghcr.io"), query("registry.npmjs.org"), query("nowhere.example.org")]);
    expect(replies.map(rcode)).toEqual([3, 0, 3]);
    expect(replies.map(answers)).toEqual([0, 1, 0]);
  });

  it("does not answer a question from outside the sandbox network", async () => {
    hostResolver({ "registry.npmjs.org": ["104.16.1.1"] });
    // The sandbox network is declared as 10.77.0.0/16, but the asker is the loopback: no answer at all.
    const { udp } = await startHost({ ...HOST_CONFIG, nets: { sandbox: "10.77.0.0/16", external: "10.9.9.0/24" } });
    expect(await ask(udp, query("registry.npmjs.org"))).toBeUndefined();
  });
});

describe("host mode: the web forwarders", () => {
  it("refuses a denied or unresolvable name at the TLS hello and at the Host header, and connects only to the public addresses the host resolver gave for an allowed one", async () => {
    const asked = hostResolver({ "registry.npmjs.org": ["104.16.1.1"], "ghcr.io": ["140.82.112.34"] });
    // The connection out is replaced: it records where the gateway would connect, and fails.
    const dialed: Array<{ host: string; port: number }> = [];
    const original = net.connect;
    (net as { connect: unknown }).connect = (options: { host: string; port: number }, ...rest: unknown[]) => {
      if (options.host === "127.0.0.1") return (original as (...args: unknown[]) => net.Socket)(options, ...rest);
      dialed.push({ host: options.host, port: options.port });
      const fake = new net.Socket();
      setImmediate(() => fake.destroy(Object.assign(new Error("no network in a test"), { code: "ENETUNREACH" })));
      return fake;
    };
    cleanup.push(() => { (net as { connect: unknown }).connect = original; });
    const { tls, plain } = await startHost();
    expect(await sendHello(tls, "ghcr.io")).toBe(false);
    expect(await sendHello(tls, "123456789012.dkr.ecr.us-west-2.amazonaws.com")).toBe(false);
    expect(await sendHello(tls, "not-known.example.org")).toBe(false);
    expect(await sendHttp(plain, "ghcr.io")).toBe(403);
    expect(await sendHttp(plain, "registry-1.docker.io")).toBe(403);
    expect(await sendHttp(plain, "not-known.example.org")).toBe(403);
    expect(dialed).toEqual([]);
    // An allowed name: the gateway resolves it itself and dials that address on 443, never a name or an address the sandbox gave.
    await sendHello(tls, "registry.npmjs.org");
    await settle();
    expect(dialed).toEqual([{ host: "104.16.1.1", port: 443 }]);
    expect(asked).not.toContain("ghcr.io");
  });
});

describe("host mode: the networks it needs", () => {
  it("starts on its two networks only, and refuses to start with a worker network attached or a network missing", async () => {
    const exits: number[] = [];
    const realExit = process.exit.bind(process);
    (process as { exit: unknown }).exit = (code?: number) => { exits.push(code ?? 0); throw new Error("exit"); };
    cleanup.push(() => { (process as { exit: unknown }).exit = realExit; });
    for (const addresses of [
      { worker: ["172.28.0.2"], sandbox: ["127.0.0.1"], external: ["10.9.9.2"] },
      { worker: [], sandbox: [], external: ["10.9.9.2"] },
      { worker: [], sandbox: ["127.0.0.1"], external: [] },
    ]) {
      const gateway = await load(HOST_CONFIG, { ROVARA_GW_TEST_ADDRESSES: JSON.stringify(addresses) });
      expect(() => gateway.main()).toThrow("exit");
    }
    expect(exits).toEqual([2, 2, 2]);
  });
});
