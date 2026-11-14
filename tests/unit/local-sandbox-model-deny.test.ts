// FIX-0518 (security, 7a 2026-11-13): on a laptop the egress gateway served ONE allow list to the worker network and the sandbox network, and that list holds the model hosts. So customer test code and the agent's shell commands in a
// task sandbox could reach api.openai.com and the rest: an exfiltration channel (upload workspace data with an attacker's key) and uncapped spend on a key committed to a repository. The agent's own model loop runs in the WORKER, through
// the broker's key proxy, so the block is SANDBOX-ONLY. ON by default; the owner's config turns it off for one project; the evidence says so when it is off.
//
// These tests drive the real gateway program (DNS, the TLS hello's server name and the HTTP Host header), the real machine adapter against a simulated Docker, the real runtime with a config file, and the real evidence keeper.
import { createRequire } from "node:module";
import dns from "node:dns";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE, PluginConfigSchema, builtinModelCatalog, type CheckEntry } from "@agentx/contracts";
import { EGRESS_GATEWAY_SOURCE } from "../../packages/broker/src/local/isolation/egress-gateway-source.js";
import { gatewayConfig, type GatewayInput } from "../../packages/broker/src/local/isolation/stack.js";
import { LOCAL_DEFAULT_ALLOW_DOMAINS, hostIsAllowed } from "../../packages/broker/src/local/isolation/allow-list.js";
import { SANDBOX_DENY_LEAVES_OUT, SANDBOX_PINNED_MODEL_HOSTS, laptopSandboxDenyList, sandboxModelHostsAllowed } from "../../packages/broker/src/local/isolation/sandbox-model-deny.js";
import { DockerWorkerMachines, SANDBOX_MODEL_HOSTS_ENV } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { startLocalRuntime, parsePluginConfigText, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { createLocalEvidence, MODEL_HOSTS_ALLOWED_ITEM } from "../../packages/broker/src/local/app/evidence.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { keepEvidence, loadEvidencePack } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { createDocumentEvidenceBlobStore, createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { scanTextForTests } from "../support/evidence-scan.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const scratch: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const FIVE = ["api.openai.com", "api.anthropic.com", "auth.openai.com", "openrouter.ai", "chatgpt.com"];
const catalogHosts = (): string[] => builtinModelCatalog().rows.flatMap((row) => [...row.hosts]);

// ---- the gateway program, loaded as a library --------------------------------------------------------------------------------------------------------------------

interface Gateway {
  hostAllowed(host: string, role?: string): boolean;
  answerFor(message: Buffer, localIp: string, role?: string): Buffer | undefined;
  startTlsForwarder(ip: string, cidr: string, role?: string): Server;
  startPlainForwarder(ip: string, cidr: string, role?: string): Server;
  main(): Array<{ role: string; dns: { udp: DgramSocket; tcp: Server }; tls: Server; plain: Server }>;
}
async function load(config: Record<string, unknown>, extraEnvironment: Record<string, string> = {}): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), "gw-deny-"));
  scratch.push(directory);
  const file = join(directory, "program.cjs");
  await writeFile(file, EGRESS_GATEWAY_SOURCE);
  const saved = { ...process.env };
  Object.assign(process.env, { ROVARA_GW_CONFIG: JSON.stringify(config), ROVARA_GW_LIBRARY: "1", ROVARA_GW_TLS_PORT: "0", ROVARA_GW_PLAIN_PORT: "0", ROVARA_GW_DNS_PORT: "0", ...extraEnvironment });
  try {
    return createRequire(import.meta.url)(file) as Gateway;
  } finally {
    for (const key of ["ROVARA_GW_CONFIG", "ROVARA_GW_LIBRARY", "ROVARA_GW_TLS_PORT", "ROVARA_GW_PLAIN_PORT", "ROVARA_GW_DNS_PORT", ...Object.keys(extraEnvironment)]) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
/** A DNS query for an A record of `name` (any case). */
function query(name: string): Buffer {
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}
const rcode = (reply: Buffer | undefined): number | undefined => (reply === undefined ? undefined : reply.readUInt16BE(2) & 0xf);

/** The first bytes a real TLS client sends, with this server name. */
function helloFor(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = createNetServer((socket) => { socket.once("data", (data) => { resolve(data); socket.destroy(); server.close(); }); }).listen(0, "127.0.0.1", () => {
      const client = tlsConnect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, rejectUnauthorized: false, servername });
      client.on("error", () => undefined);
    });
  });
}

/** Every name the gateway tried to resolve (it resolves a name only after it judged it allowed); the lookup itself always fails, so nothing leaves this machine. */
function spyOnResolution(): string[] {
  const names: string[] = [];
  const original = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (name: string) => { names.push(String(name).toLowerCase()); throw Object.assign(new Error("spy"), { code: "ENOTFOUND" }); };
  cleanup.push(() => { (dns.promises as { lookup: unknown }).lookup = original; });
  return names;
}
const listening = (server: Server): Promise<number> => new Promise((resolve) => { const done = (): void => resolve((server.address() as AddressInfo).port); if (server.listening) done(); else server.once("listening", done); });
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the gateway's TLS (443) and plain (80) forwarders for one network's role on free ports of the loopback. */
async function forwarders(config: Record<string, unknown>, role: "sandbox" | "worker") {
  const gateway = await load(config);
  const tls = gateway.startTlsForwarder("127.0.0.1", "127.0.0.0/8", role);
  const plain = gateway.startPlainForwarder("127.0.0.1", "127.0.0.0/8", role);
  cleanup.push(() => new Promise<void>((resolve) => { tls.close(); plain.close(); (plain as Server & { closeAllConnections?: () => void }).closeAllConnections?.(); resolve(); }));
  return { tlsPort: await listening(tls), plainPort: await listening(plain) };
}
/** Sends a hello for `servername` and says whether the gateway closed the connection without a byte. Whether it went on is read from `names` (the resolution spy). */
async function sendHello(port: number, servername: string): Promise<{ answered: boolean }> {
  const hello = await helloFor(servername);
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(hello));
    let answered = false;
    socket.on("data", () => { answered = true; });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve({ answered }));
    setTimeout(() => { socket.destroy(); }, 1500).unref();
  });
}
/** Sends one raw HTTP request with exactly this Host header value and returns the status code. */
function sendHttp(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("latin1"); });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]) || undefined));
    setTimeout(() => socket.destroy(), 1500).unref();
  });
}

// The list a laptop serves today: the cloud's default list (the model hosts are on it), plus what a project allowed, plus the Azure wildcard a project may have added, plus Google's token hosts.
const SHARED_LIST = [...LOCAL_DEFAULT_ALLOW_DOMAINS, ...catalogHosts(), "*.openai.azure.com", "github.com", "registry.npmjs.org", "files.pythonhosted.org", "oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"];
const DENY = laptopSandboxDenyList();
const CONFIG = { allowed: SHARED_LIST, sandboxDenied: DENY };
/** A project's list that allows a whole family (`*.openai.com`): the reviewer's probe. */
const WIDE_LIST = [...SHARED_LIST, "*.openai.com", "*.chatgpt.com", "*.anthropic.com", "*.openrouter.ai", "*.api.openai.com"];
const SUBDOMAINS = ["eu.api.openai.com", "us.api.openai.com", "ab.chatgpt.com", "x.anthropic.com", "x.openrouter.ai", "a.b.api.openai.com", "platform.openai.com", "EU.API.OPENAI.COM"];

describe("the problem: one list for both networks", () => {
  it("the cloud's default list, which the laptop copies, holds the five model hosts", () => {
    for (const host of FIVE) expect(hostIsAllowed(host, LOCAL_DEFAULT_ALLOW_DOMAINS), host).toBe(true);
  });
});

describe("the deny list", () => {
  it("is on by default in the runtime: the five hosts, every catalog host, and the Azure suffix as a wildcard", () => {
    for (const host of FIVE) expect(DENY, host).toContain(host);
    expect([...SANDBOX_PINNED_MODEL_HOSTS].sort()).toEqual([...FIVE].sort());
    for (const host of catalogHosts()) if (!SANDBOX_DENY_LEAVES_OUT.includes(host)) expect(DENY, host).toContain(host);
    expect(DENY).toContain("*.openai.azure.com");
    expect(new Set(DENY).size).toBe(DENY.length);
    expect([...DENY].sort()).toEqual(DENY);
  });
  it("holds a `*.<host>` wildcard for every pinned and catalog host, and the registrable parents of the pinned five (M1)", () => {
    for (const host of [...FIVE, ...catalogHosts().filter((entry) => !SANDBOX_DENY_LEAVES_OUT.includes(entry))]) expect(DENY, `*.${host}`).toContain(`*.${host}`);
    for (const wildcard of ["*.api.openai.com", "*.openai.com", "*.anthropic.com", "*.openrouter.ai", "*.chatgpt.com", "*.api.anthropic.com"]) expect(DENY, wildcard).toContain(wildcard);
    for (const left of SANDBOX_DENY_LEAVES_OUT) expect(DENY, `*.${left}`).not.toContain(`*.${left}`);
    expect(DENY).not.toContain("*.googleapis.com");
  });
  it("never holds Google's token hosts (a separate owner decision removes them everywhere)", () => {
    for (const host of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) expect(DENY, host).not.toContain(host);
    expect(SANDBOX_DENY_LEAVES_OUT).toEqual(["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"]);
  });
  it("adds extra rows and a company gateway host to the built-in catalog and never shrinks it", () => {
    const list = laptopSandboxDenyList([{ hosts: ["New.Example.com"], authHosts: [], hostSuffixes: ["models.example.net"] }], [{ host: "LLM.acme.dev" }]);
    expect(list).toEqual(expect.arrayContaining(["new.example.com", "llm.acme.dev", "*.models.example.net", ...FIVE, "*.openai.azure.com"]));
  });
});

describe("subdomains of the model hosts are denied too (M1)", () => {
  it("with `*.openai.com` and the other families on the project's list, the sandbox is refused every subdomain by DNS, SNI and Host, and the worker still reaches them", async () => {
    const config = { allowed: WIDE_LIST, sandboxDenied: DENY };
    const gateway = await load(config);
    for (const host of SUBDOMAINS) {
      expect(gateway.hostAllowed(host.toLowerCase(), "sandbox"), `${host} sandbox`).toBe(false);
      expect(gateway.hostAllowed(host.toLowerCase(), "worker"), `${host} worker`).toBe(true);
      expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "sandbox")), `${host} dns`).toBe(3);
    }
    const names = spyOnResolution();
    const sandbox = await forwarders(config, "sandbox");
    for (const host of SUBDOMAINS) { await sendHello(sandbox.tlsPort, host); expect(await sendHttp(sandbox.plainPort, host), host).toBe(403); }
    await settle();
    expect(names).toEqual([]);
  });
  it("a name that only looks like a subdomain is not denied", async () => {
    const gateway = await load({ allowed: [...WIDE_LIST, "*.openai.com.evil.dev", "notopenai.com", "x.notopenai.com"], sandboxDenied: DENY });
    for (const host of ["a.openai.com.evil.dev", "notopenai.com", "x.notopenai.com"]) expect(gateway.hostAllowed(host, "sandbox"), host).toBe(true);
  });
});

describe("the sandbox network cannot reach a model host: DNS", () => {
  it("answers NXDOMAIN for each denied host, in any case, and for the Azure suffix at any depth; the worker's name server answers", async () => {
    const gateway = await load(CONFIG);
    for (const host of DENY.filter((entry) => !entry.startsWith("*."))) {
      expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "sandbox")), `${host} sandbox`).toBe(3);
      expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "worker")), `${host} worker`).toBe(0);
    }
    for (const host of ["API.OpenAI.com", "Api.Anthropic.COM", "OPENROUTER.ai", "ChatGPT.com", "Auth.OpenAI.com", "My-Resource.OpenAI.Azure.com", "a.b.c.openai.azure.com"]) {
      expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "sandbox")), `${host} sandbox`).toBe(3);
      expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "worker")), `${host} worker`).toBe(0);
    }
  });
  it("still answers everything else for the sandbox, Google's token hosts included, and a name that only ends like a model host", async () => {
    const gateway = await load(CONFIG);
    for (const host of ["github.com", "registry.npmjs.org", "files.pythonhosted.org", "oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) expect(rcode(gateway.answerFor(query(host), "172.20.0.2", "sandbox")), host).toBe(0);
    const extra = await load({ allowed: [...SHARED_LIST, "api.openai.com.evil.dev", "notopenai.com", "openai.azure.com.evil.dev"], sandboxDenied: DENY });
    for (const host of ["api.openai.com.evil.dev", "notopenai.com", "openai.azure.com.evil.dev"]) expect(rcode(extra.answerFor(query(host), "172.20.0.2", "sandbox")), host).toBe(0);
  });
  it("a project that lists a model host among its own allowed websites does not get it in the sandbox", async () => {
    const gateway = await load({ allowed: [...SHARED_LIST, "api.openai.com", "*.openai.azure.com"], sandboxDenied: DENY });
    expect(gateway.hostAllowed("api.openai.com", "sandbox")).toBe(false);
    expect(gateway.hostAllowed("x.openai.azure.com", "sandbox")).toBe(false);
  });
});

describe("the sandbox network cannot reach a model host: the TLS server name (SNI)", () => {
  it("the sandbox's forwarder closes the connection for every case variant and the Azure suffix, and never resolves the name; the worker's forwarder goes on to resolve it", async () => {
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    const hosts = [...FIVE, "API.OpenAI.COM", "Api.Anthropic.com", "my-resource.openai.azure.com", "My-Resource.OpenAI.Azure.Com", "deep.name.openai.azure.com", "generativelanguage.googleapis.com", "us-central1-aiplatform.googleapis.com"];
    for (const host of hosts) expect((await sendHello(sandbox.tlsPort, host)).answered, host).toBe(false);
    await settle();
    expect(names).toEqual([]);
    const worker = await forwarders(CONFIG, "worker");
    for (const host of ["API.OpenAI.COM", "my-resource.openai.azure.com", "chatgpt.com"]) await sendHello(worker.tlsPort, host);
    await settle();
    expect(names).toEqual(expect.arrayContaining(["api.openai.com", "my-resource.openai.azure.com", "chatgpt.com"]));
  });
  it("lets the sandbox go on to an allowed name (the deny is not a general block)", async () => {
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    await sendHello(sandbox.tlsPort, "github.com");
    await sendHello(sandbox.tlsPort, "oauth2.googleapis.com");
    await settle();
    expect(names).toEqual(expect.arrayContaining(["github.com", "oauth2.googleapis.com"]));
  });
  it("a trailing dot in the server name does not get a model host through", async () => {
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    await sendHello(sandbox.tlsPort, "api.openai.com.");
    await settle();
    expect(names).toEqual([]);
  });
});

describe("the sandbox network cannot reach a model host: the HTTP Host header", () => {
  it("the sandbox's port-80 forwarder refuses each denied Host, in any case, with a port or a trailing dot, and never resolves it; the worker's goes on to resolve it", async () => {
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    for (const host of [...FIVE, "API.OPENAI.COM", "Api.Anthropic.Com:80", "openrouter.ai.", "my-resource.openai.azure.com", "My-Resource.OpenAI.Azure.Com", "a.b.openai.azure.com:80", "chatgpt.com.:80"]) {
      expect(await sendHttp(sandbox.plainPort, host), host).toBe(403);
    }
    await settle();
    expect(names).toEqual([]);
    const worker = await forwarders(CONFIG, "worker");
    for (const host of ["API.OPENAI.COM", "my-resource.openai.azure.com"]) await sendHttp(worker.plainPort, host);
    await settle();
    expect(names).toEqual(expect.arrayContaining(["api.openai.com", "my-resource.openai.azure.com"]));
  });
  it("domain fronting: a request whose Host names a model host is refused whatever else the connection carries, and a Host with a stray port or a second Host header is refused too", async () => {
    // On port 80 the Host header IS the destination (the gateway resolves it), so a front cannot hide a model host there: the Host check is the whole check.
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    expect(await sendHttp(sandbox.plainPort, "api.openai.com:8080")).toBe(403);
    expect(await sendHttp(sandbox.plainPort, "github.com, api.openai.com")).toBe(403);
    const twoHosts = await new Promise<number | undefined>((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port: sandbox.plainPort }, () => socket.write("GET / HTTP/1.1\r\nHost: github.com\r\nHost: api.openai.com\r\nConnection: close\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => { text += chunk.toString("latin1"); });
      socket.on("error", () => undefined);
      socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]) || undefined));
    });
    expect(twoHosts).toBe(400);
    await settle();
    expect(names).toEqual([]);
  });
  it("known limit, written down: over TLS the gateway reads the server name only (it does not open the encrypted request), so a front that serves a model host behind an allowed name is not seen", async () => {
    // The gateway connects to the SERVER NAME'S address and nowhere else, so the only way to a model host through TLS is an allowed name whose own address also serves it. The name list is the defence; docs/local.md says so.
    const names = spyOnResolution();
    const sandbox = await forwarders(CONFIG, "sandbox");
    await sendHello(sandbox.tlsPort, "github.com");
    await settle();
    expect(names).toEqual(["github.com"]);
  });
});

describe("with no deny list nothing changes for anyone", () => {
  it("the sandbox reaches the model hosts as before", async () => {
    const gateway = await load({ allowed: SHARED_LIST });
    for (const host of FIVE) expect(gateway.hostAllowed(host, "sandbox"), host).toBe(true);
    expect(rcode(gateway.answerFor(query("api.openai.com"), "172.20.0.2", "sandbox"))).toBe(0);
    const empty = await load({ allowed: SHARED_LIST, sandboxDenied: [] });
    expect(empty.hostAllowed("api.openai.com", "sandbox")).toBe(true);
  });
  it("the worker's network always reaches them, with the deny set", async () => {
    const gateway = await load(CONFIG);
    for (const host of FIVE) expect(gateway.hostAllowed(host, "worker"), host).toBe(true);
    expect(gateway.hostAllowed("x.openai.azure.com", "worker")).toBe(true);
  });
  it("a caller that names no role, or a role that is not exactly `worker`, is treated as the sandbox (L1: fail closed)", async () => {
    const gateway = await load(CONFIG);
    for (const role of [undefined, "", "Worker", "WORKER", "sandbox", "worker ", "other"]) {
      for (const host of ["api.openai.com", "eu.api.openai.com", "x.openai.azure.com"]) expect(gateway.hostAllowed(host, role), `${host} ${String(role)}`).toBe(false);
      expect(gateway.hostAllowed("github.com", role), `github ${String(role)}`).toBe(true);
      expect(rcode(gateway.answerFor(query("api.openai.com"), "172.20.0.2", role)), `dns ${String(role)}`).toBe(3);
    }
  });
  it("the gateway's own start-up gives the SANDBOX network's listeners the sandbox role and the WORKER network's the worker role (main, not only the forwarders)", async () => {
    const config = {
      allowed: WIDE_LIST, sandboxDenied: DENY, nets: { worker: "127.0.0.0/8", sandbox: "127.0.0.0/8", external: "127.0.0.0/8" },
      callback: { port: 0, workspaceId: "w", hostHeader: "host.docker.internal:1", targets: [{ host: "127.0.0.1", port: 1 }] }, ingress: { port: 0, target: "worker", targetPort: 1 },
    };
    const gateway = await load(config, { ROVARA_GW_TEST_ADDRESSES: JSON.stringify({ worker: ["127.0.0.1"], sandbox: ["127.0.0.1"], external: ["127.0.0.1"] }) });
    const names = spyOnResolution();
    const started = gateway.main();
    cleanup.push(() => { for (const entry of started) { entry.dns.udp.close(); entry.dns.tcp.close(); entry.tls.close(); entry.plain.close(); } });
    expect(started.map((entry) => entry.role)).toEqual(["worker", "sandbox"]);
    const [worker, sandbox] = started as [(typeof started)[number], (typeof started)[number]];
    const ports = async (entry: typeof worker) => ({ tls: await listening(entry.tls), plain: await listening(entry.plain), udp: entry.dns.udp.address().port });
    const w = await ports(worker);
    const sb = await ports(sandbox);
    const ask = (port: number, name: string): Promise<number | undefined> => new Promise((resolve) => {
      const socket = createSocket("udp4");
      socket.on("message", (message) => { socket.close(); resolve(rcode(message)); });
      socket.send(query(name), port, "127.0.0.1");
      setTimeout(() => { try { socket.close(); } catch { /* already closed */ } resolve(undefined); }, 1500).unref();
    });
    for (const host of ["api.openai.com", "eu.api.openai.com", "x.openai.azure.com"]) {
      expect(await ask(sb.udp, host), `dns sandbox ${host}`).toBe(3);
      expect(await ask(w.udp, host), `dns worker ${host}`).toBe(0);
      expect((await sendHello(sb.tls, host)).answered).toBe(false);
      expect(await sendHttp(sb.plain, host), `host sandbox ${host}`).toBe(403);
    }
    await settle();
    expect(names).toEqual([]);
    await sendHello(w.tls, "eu.api.openai.com");
    await sendHttp(w.plain, "api.openai.com");
    await settle();
    expect(names).toEqual(expect.arrayContaining(["eu.api.openai.com", "api.openai.com"]));
  });
});

// ---- the gateway's configuration and the machine that sets it -----------------------------------------------------------------------------------------------------

describe("the gateway configuration", () => {
  const input = (extra: Partial<GatewayInput> = {}): GatewayInput => ({
    image: "x", labels: [], names: {} as never, nets: { worker: { subnet: "172.20.0.0/24" }, sandbox: { subnet: "172.21.0.0/24" }, external: { subnet: "172.22.0.0/24" } }, allowed: ["github.com"], workspaceId: "w", callback: { tcpPort: 1 }, user: "1000:1000", ...extra,
  });
  it("is exactly what it was when no deny list is given (unset, empty), and carries the list when one is", () => {
    const before = gatewayConfig(input());
    expect(before).not.toHaveProperty("sandboxDenied");
    expect(gatewayConfig(input({ sandboxDenied: [] }))).toEqual(before);
    expect(gatewayConfig(input({ sandboxDenied: ["api.openai.com"] }))).toEqual({ ...before, sandboxDenied: ["api.openai.com"] });
  });
});

describe("the machine", () => {
  const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
  async function world(options: { denied?: readonly string[]; allowedFor?: (project: string | undefined) => boolean | Promise<boolean> } = {}) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-deny-"));
    scratch.push(stateDirectory);
    const docker = new FakeDocker();
    const signer = createEphemeralInvokeSigner();
    const start = async (key = "ws-deny", project?: string, denied = options.denied, allowedFor = options.allowedFor) => {
      const machines = new DockerWorkerMachines({
        image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer, docker, fetch: docker.fetch,
        ...(denied === undefined ? {} : { modelHostsDeniedInSandbox: denied }), ...(allowedFor === undefined ? {} : { sandboxModelHostsAllowed: allowedFor }),
      });
      const handle = await machines.start({ machineKey: key, companyId: COMPANY, ...(project === undefined ? {} : { projectName: project }) });
      const hash = handle.machineId.slice("rovara-worker-".length);
      const gateway = docker.containers.get(`rovara-gw-${hash}`)!;
      const worker = docker.containers.get(handle.machineId)!;
      return { handle, worker, gateway, config: JSON.parse(gateway.environment.ROVARA_GW_CONFIG!) as Record<string, unknown>, args: JSON.stringify(gateway.args), digest: worker.labels["rovara.config"] ?? JSON.stringify(worker.labels), machines };
    };
    return { start, docker };
  }
  it("told to deny, starts a gateway that does and tells the worker `denied`; told nothing, or an empty list, starts what it always started (same gateway command, same configuration, no new variable, same digest)", async () => {
    const w = await world();
    const plain = await w.start("ws-a");
    const empty = await w.start("ws-b", undefined, []);
    expect(plain.config).not.toHaveProperty("sandboxDenied");
    expect(empty.config).not.toHaveProperty("sandboxDenied");
    expect(plain.worker.environment[SANDBOX_MODEL_HOSTS_ENV]).toBeUndefined();
    expect(empty.worker.environment[SANDBOX_MODEL_HOSTS_ENV]).toBeUndefined();
    const denying = await w.start("ws-c", undefined, DENY);
    expect(denying.config.sandboxDenied).toEqual(DENY);
    expect(denying.worker.environment[SANDBOX_MODEL_HOSTS_ENV]).toBe("denied");
  });
  it("the isolation digest is the same with the deny unset (or empty) and different when it is set", async () => {
    const w = await world();
    const a = await w.start("ws-d");
    const stateDigest = (c: { worker: { labels: Record<string, string> } }) => Object.entries(c.worker.labels).filter(([name]) => /config/i.test(name)).map(([, value]) => value).join("|");
    expect(stateDigest(a)).not.toBe("");
    // The same machine started again with no deny rule, or an empty one, is the machine that is already there (no re-create).
    const createsBefore = w.docker.calls.filter((call) => call[0] === "create").length;
    await w.start("ws-d");
    await w.start("ws-d", undefined, []);
    expect(w.docker.calls.filter((call) => call[0] === "create").length).toBe(createsBefore);
    // Set: an idle machine is re-created (with the new gateway).
    const set = await w.start("ws-d", undefined, DENY);
    expect(stateDigest(set)).not.toBe(stateDigest(a));
    expect(w.docker.calls.filter((call) => call[0] === "create").length).toBeGreaterThan(createsBefore);
    expect(set.config.sandboxDenied).toEqual(DENY);
    // And set again, the same: nothing more to re-create.
    const createsNow = w.docker.calls.filter((call) => call[0] === "create").length;
    await w.start("ws-d", undefined, DENY);
    expect(w.docker.calls.filter((call) => call[0] === "create").length).toBe(createsNow);
  });
  it("a project the owner allowed gets a gateway with no deny list and a worker told `allowed`; any other project, and a machine with no project, is denied; a reader that throws or does not say true leaves the deny on", async () => {
    const w = await world({ denied: DENY, allowedFor: (project) => project === "my-app" });
    const allowed = await w.start("ws-e", "my-app");
    expect(allowed.config).not.toHaveProperty("sandboxDenied");
    expect(allowed.worker.environment[SANDBOX_MODEL_HOSTS_ENV]).toBe("allowed");
    for (const project of ["other-app", undefined]) {
      const denied = await w.start(`ws-f-${project ?? "none"}`, project);
      expect(denied.config.sandboxDenied, String(project)).toEqual(DENY);
      expect(denied.worker.environment[SANDBOX_MODEL_HOSTS_ENV]).toBe("denied");
    }
    for (const [index, reader] of [(): boolean => { throw new Error("boom"); }, async (): Promise<boolean> => { throw new Error("boom"); }, (): boolean => "yes" as never, (): boolean => 1 as never].entries()) {
      const odd = await (await world({ denied: DENY, allowedFor: reader })).start(`ws-g-${String(index)}`, "my-app");
      expect(odd.config.sandboxDenied, String(index)).toEqual(DENY);
    }
  });
  it("changing the owner's setting re-creates an idle machine on its next start, both ways", async () => {
    let allowed = false;
    const w = await world({ denied: DENY, allowedFor: () => allowed });
    const first = await w.start("ws-h", "my-app");
    expect(first.config.sandboxDenied).toEqual(DENY);
    allowed = true;
    const second = await w.start("ws-h", "my-app");
    expect(second.config).not.toHaveProperty("sandboxDenied");
    allowed = false;
    const third = await w.start("ws-h", "my-app");
    expect(third.config.sandboxDenied).toEqual(DENY);
  });
  it("says which state a machine was created with, from its own label (L2): denied, allowed, or nothing for a machine with no deny rule, an unknown machine or a name that is not a machine's", async () => {
    const w = await world({ denied: DENY, allowedFor: (project) => project === "my-app" });
    const denied = await w.start("ws-j", "other-app");
    const allowed = await w.start("ws-k", "my-app");
    expect(await denied.machines.sandboxModelHostsOf(denied.handle.machineId)).toBe("denied");
    expect(await allowed.machines.sandboxModelHostsOf(allowed.handle.machineId)).toBe("allowed");
    expect(await denied.machines.sandboxModelHostsOf(`rovara-worker-${"0".repeat(24)}`)).toBeUndefined();
    for (const bad of ["", "x", "rovara-worker-../../etc", "rovara-gw-aaaaaaaaaaaaaaaaaaaaaaaa", `rovara-worker-${"A".repeat(24)}`]) expect(await denied.machines.sandboxModelHostsOf(bad), bad).toBeUndefined();
    // A container that is not a worker, even with the label on it, is not read.
    const gatewayName = `rovara-gw-${denied.handle.machineId.slice("rovara-worker-".length)}`;
    denied.gateway.labels["rovara.local.sandbox-model-hosts"] = "allowed";
    expect(w.docker.containers.get(gatewayName)?.labels["rovara.local.sandbox-model-hosts"]).toBe("allowed");
    expect(await denied.machines.sandboxModelHostsOf(gatewayName)).toBeUndefined();
    const none = await (await world()).start("ws-l");
    expect(await none.machines.sandboxModelHostsOf(none.handle.machineId)).toBeUndefined();
    // The state is the one the machine was created with: a setting changed since then does not change it until the machine is re-created.
    let now = false;
    const moving = await world({ denied: DENY, allowedFor: () => now });
    const first = await moving.start("ws-m", "my-app");
    now = true;
    expect(await first.machines.sandboxModelHostsOf(first.handle.machineId)).toBe("denied");
  });
  it("a project's own environment cannot set what the worker is told about the model hosts", async () => {
    const w = await world({ denied: DENY });
    const envDirectory = await mkdtemp(join(tmpdir(), "rovara-deny-env-"));
    scratch.push(envDirectory);
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory: envDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker: w.docker, fetch: w.docker.fetch, modelHostsDeniedInSandbox: DENY });
    await expect(machines.start({ machineKey: "ws-i", companyId: COMPANY, environment: { [SANDBOX_MODEL_HOSTS_ENV]: "allowed" } })).rejects.toThrow(/not allowed/);
  });
});

// ---- the owner's setting ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the setting: projectSettings.<project>.sandboxModelHosts in the owner's config", () => {
  const text = (extra: Record<string, unknown>): string => JSON.stringify({ version: 1, plugins: [], ...extra });
  it("reads allow and deny for a named project, and nothing else; absent is deny", () => {
    const config = parsePluginConfigText(text({ projectSettings: { "my-app": { sandboxModelHosts: "allow" }, "quiet-app": { sandboxModelHosts: "deny" }, "empty-app": {} } }));
    expect(sandboxModelHostsAllowed(config, "my-app")).toBe(true);
    for (const project of ["quiet-app", "empty-app", "unknown-app", undefined]) expect(sandboxModelHostsAllowed(config, project), String(project)).toBe(false);
    expect(sandboxModelHostsAllowed(parsePluginConfigText(text({})), "my-app")).toBe(false);
    expect(sandboxModelHostsAllowed(undefined, "my-app")).toBe(false);
  });
  it("refuses a value that is not allow or deny, an unknown key, a bad project name and a prototype name; a name that is not an own key is never read", () => {
    for (const bad of [{ "my-app": { sandboxModelHosts: true } }, { "my-app": { sandboxModelHosts: "ALLOW" } }, { "my-app": { sandboxModelHosts: "allow", other: 1 } }, { "My App": { sandboxModelHosts: "allow" } }, { "my-app": "allow" }]) {
      expect(() => parsePluginConfigText(text({ projectSettings: bad })), JSON.stringify(bad)).toThrow();
    }
    // A `__proto__` key in the file is never an own entry of the parsed settings, and no project name reads as allowed from it.
    const sneaky = PluginConfigSchema.safeParse(JSON.parse('{"version":1,"plugins":[],"projectSettings":{"__proto__":{"sandboxModelHosts":"allow"}}}'));
    if (sneaky.success) {
      expect(Object.hasOwn(sneaky.data.projectSettings ?? {}, "__proto__")).toBe(false);
      for (const project of ["__proto__", "my-app", "constructor", undefined]) expect(sandboxModelHostsAllowed(sneaky.data, project), String(project)).toBe(false);
    }
    expect(sandboxModelHostsAllowed({ projectSettings: { "my-app": { sandboxModelHosts: "allow" } } }, "constructor")).toBe(false);
    expect(sandboxModelHostsAllowed({ projectSettings: { "my-app": { sandboxModelHosts: "allow" } } }, "__proto__")).toBe(false);
  });
});

describe("the runtime: deny is the default; the config turns it off for one project", () => {
  async function launch(config?: unknown) {
    const root = await mkdtemp(join(tmpdir(), "rovara-deny-run-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { mkdir } = await import("node:fs/promises");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    if (config !== undefined) await writeFile(join(stateDirectory, "config.json"), JSON.stringify(config), { mode: 0o600 });
    const docker = new FakeDocker();
    const runtime: LocalRuntime = await startLocalRuntime({ stateDirectory, cwd: join(root, "project"), environment: {}, workerImage: "worker:test", docker, version: "9.9.9", gh: async () => undefined });
    cleanup.push(() => runtime.stop());
    const start = async (key: string, project: string | undefined) => {
      const handle = await runtime.registry.require("worker-machines", "docker").start({ machineKey: key, companyId: IMPLICIT_COMPANY_ID, ...(project === undefined ? {} : { projectName: project }) });
      const hash = handle.machineId.slice("rovara-worker-".length);
      return { config: JSON.parse(docker.containers.get(`rovara-gw-${hash}`)!.environment.ROVARA_GW_CONFIG!) as Record<string, unknown>, env: docker.containers.get(handle.machineId)!.environment };
    };
    const startHandle = (key: string, project: string) => runtime.registry.require("worker-machines", "docker").start({ machineKey: key, companyId: IMPLICIT_COMPANY_ID, projectName: project });
    return { start, startHandle, runtime };
  }
  it("with no setting, every project's sandbox is denied the five hosts and the Azure suffix, and the worker is told `denied`", async () => {
    const run = await launch(undefined);
    for (const [key, project] of [["ws-1", "my-app"], ["ws-2", undefined]] as const) {
      const machine = await run.start(key, project);
      const denied = machine.config.sandboxDenied as string[];
      for (const host of [...FIVE, "*.openai.azure.com"]) expect(denied, host).toContain(host);
      expect(machine.env[SANDBOX_MODEL_HOSTS_ENV]).toBe("denied");
      // The worker's own allow list still holds the hosts: the agent's model loop runs there.
      for (const host of FIVE) expect(machine.config.allowed as string[], host).toContain(host);
    }
  });
  it("hands the project's deny list to the setup agent (empty for an allowed project), and its evidence reads the state the machine was created with", async () => {
    const run = await launch({ version: 1, plugins: [], projectSettings: { "my-app": { sandboxModelHosts: "allow" } } });
    expect(run.runtime.app.setupAgent.callback.sandboxDenied?.("my-app")).toEqual([]);
    expect(run.runtime.app.setupAgent.callback.sandboxDenied?.("other-app")).toEqual(laptopSandboxDenyList());
    // A machine started for "my-app" is created allowed; a workspace record that names ANOTHER project but that machine gets the sentence only if the evidence asks the machine.
    const started = await run.startHandle("ws-ev", "my-app");
    const store = run.runtime.registry.require("storage");
    await store.put({ item: { pk: "WORKSPACE#ws-ev", sk: "META", entityType: "WORKSPACE", id: "ws-ev", projectName: "other-app", machine: { machineId: started.machineId, machineKey: "ws-ev" } } });
    const digest = "9".repeat(64);
    const task = { ownerKey: "owner-1", workspaceId: "ws-ev", taskId: "task-1" };
    await run.runtime.app.evidence.keepAfterChecks({ task: task as never, operation: { id: "op-1" } as never, workflow: { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } } as never, candidateDigest: digest, checks: [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 7, exitCode: 0 }] });
    expect((await run.runtime.app.evidence.packOf(task, digest))?.notTested.map((item) => item.text)).toContain("model hosts allowed in the test sandbox by project setting");
  });
  it("the config's allow turns the deny off for that project only", async () => {
    const run = await launch({ version: 1, plugins: [], projectSettings: { "my-app": { sandboxModelHosts: "allow" } } });
    const mine = await run.start("ws-3", "my-app");
    expect(mine.config).not.toHaveProperty("sandboxDenied");
    expect(mine.env[SANDBOX_MODEL_HOSTS_ENV]).toBe("allowed");
    const other = await run.start("ws-4", "other-app");
    expect(other.config.sandboxDenied as string[]).toContain("api.openai.com");
    expect(other.env[SANDBOX_MODEL_HOSTS_ENV]).toBe("denied");
  });
});

// ---- the evidence ------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the evidence", () => {
  const DIGEST = "c".repeat(64);
  const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
  const check = (): CheckEntry => ({ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });

  it("the fixed sentence is the one 7a asked for", () => {
    expect(MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE).toBe("model hosts allowed in the test sandbox by project setting");
    expect(MODEL_HOSTS_ALLOWED_ITEM.text).toBe(MODEL_HOSTS_ALLOWED_BY_SETTING_SENTENCE);
  });
  it("the keeper puts a given fixed item on the pack, first, and the pack still validates; with none given the pack says nothing about model hosts", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
    const deps = { scan: scanTextForTests, actions: { artifacts: async () => [], readArtifact: async () => "" }, store: { blobs } };
    const input = { orgId: "org-a", task: TASK, operationId: "op-1", candidateDigest: DIGEST, checks: [check()] };
    expect(await keepEvidence(deps, { ...input, extraNotTested: [MODEL_HOSTS_ALLOWED_ITEM] })).toMatchObject({ kept: true });
    const withIt = await loadEvidencePack(blobs, TASK, DIGEST);
    expect(withIt?.notTested[0]).toMatchObject({ kind: "environment", id: "sandbox_model_hosts", text: "model hosts allowed in the test sandbox by project setting" });
    expect(await keepEvidence(deps, input)).toMatchObject({ kept: true });
    const without = await loadEvidencePack(blobs, TASK, DIGEST);
    expect(JSON.stringify(without)).not.toContain("model hosts");
  });
  it("the laptop keeper reads the state the task's MACHINE was created with, and falls back to the config only when the machine cannot say (L2)", async () => {
    const documents = new MemoryDocumentStore();
    const objects = createDocumentObjectStorage(documents, { companyId: IMPLICIT_COMPANY_ID });
    const sentence = "model hosts allowed in the test sandbox by project setting";
    const put = async (id: string, machine: boolean) => documents.put({ item: { pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE", id, projectName: "my-app", ...(machine ? { machine: { machineId: `rovara-worker-${"a".repeat(24)}`, machineKey: id } } : {}) } });
    type State = "denied" | "allowed" | undefined;
    const run = async (id: string, digest: string, options: { machine: State | "throws"; config: boolean; hasMachine?: boolean }) => {
      await put(id, options.hasMachine !== false);
      const evidence = createLocalEvidence({
        flow: { store: documents, companyId: IMPLICIT_COMPANY_ID, log: () => undefined }, blobs: objects,
        sandboxModelHostsAllowed: () => options.config,
        sandboxModelHostsOf: async () => { if (options.machine === "throws") throw new Error("docker is down"); return options.machine; },
      });
      const task = { ownerKey: "owner-1", workspaceId: id, taskId: "task-1" };
      const result = await evidence.keepAfterChecks({ task: task as never, operation: { id: "op-1" } as never, workflow: { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } } as never, candidateDigest: digest, checks: [check()] });
      expect(result).toMatchObject({ kept: true });
      return (await evidence.packOf(task, digest))?.notTested.map((item) => item.text) ?? [];
    };
    expect(await run("ws-a", "1".repeat(64), { machine: "allowed", config: false })).toContain(sentence);
    expect(await run("ws-b", "2".repeat(64), { machine: "denied", config: true })).not.toContain(sentence);
    expect(await run("ws-c", "3".repeat(64), { machine: undefined, config: true })).toContain(sentence);
    expect(await run("ws-d", "4".repeat(64), { machine: undefined, config: false })).not.toContain(sentence);
    expect(await run("ws-e", "5".repeat(64), { machine: "throws", config: true })).toContain(sentence);
    expect(await run("ws-f", "6".repeat(64), { machine: "throws", config: false })).not.toContain(sentence);
    expect(await run("ws-g", "7".repeat(64), { machine: "denied", config: true, hasMachine: false })).toContain(sentence);
  });
  it("the laptop keeper adds it when the owner's setting allows the task's project, and not otherwise (default, deny, unreadable)", async () => {
    const documents = new MemoryDocumentStore();
    const objects = createDocumentObjectStorage(documents, { companyId: IMPLICIT_COMPANY_ID });
    await documents.put({ item: { pk: "WORKSPACE#ws-1", sk: "META", entityType: "WORKSPACE", id: "ws-1", projectName: "my-app" } });
    const run = async (allowedFor: ((project: string) => boolean) | undefined, digest: string) => {
      const evidence = createLocalEvidence({ flow: { store: documents, companyId: IMPLICIT_COMPANY_ID, log: () => undefined }, blobs: objects, ...(allowedFor === undefined ? {} : { sandboxModelHostsAllowed: allowedFor }) });
      const checks = [check()];
      const result = await evidence.keepAfterChecks({ task: { ...TASK, taskId: "task-1" } as never, operation: { id: "op-1" } as never, workflow: { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } } as never, candidateDigest: digest, checks });
      expect(result).toMatchObject({ kept: true });
      return (await evidence.packOf(TASK, digest))?.notTested.map((item) => item.text) ?? [];
    };
    expect(await run((project) => project === "my-app", "a".repeat(64))).toContain("model hosts allowed in the test sandbox by project setting");
    expect(await run(undefined, "b".repeat(64))).not.toContain("model hosts allowed in the test sandbox by project setting");
    expect(await run(() => false, "d".repeat(64))).not.toContain("model hosts allowed in the test sandbox by project setting");
    expect(await run((project) => project === "other-app", "e".repeat(64))).not.toContain("model hosts allowed in the test sandbox by project setting");
    expect(await run(() => { throw new Error("boom"); }, "f".repeat(64))).not.toContain("model hosts allowed in the test sandbox by project setting");
  });
});
