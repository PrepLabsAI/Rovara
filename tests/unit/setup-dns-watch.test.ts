// Setup agent (design setup-test-health 3.3, task SH9): the setup sandbox gets its own DNS forwarder. It passes every query on to the real resolver, hands the answer back unchanged, and
// remembers (at most 50 names per run) the names the resolver refused: NXDOMAIN or REFUSED. A command's output is never read for host names; only the questions the sandbox itself asked
// the resolver, with the answer the resolver gave. These tests use real sockets on 127.0.0.1 and a fake upstream resolver; no Docker.
import { createSocket } from "node:dgram";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_BLOCKED_HOSTS_MAX } from "../../packages/contracts/src/setup-run.js";
import { SetupDnsWatch, parseDnsPacket } from "../../packages/worker/src/setup-dns-watch.js";

const TYPE = { A: 1, AAAA: 28, MX: 15, TXT: 16, PTR: 12, HTTPS: 65 } as const;
const RCODE = { ok: 0, servfail: 2, nxdomain: 3, refused: 5 } as const;

/** A DNS query packet for one name. */
function query(name: string, type: number = TYPE.A, id = 0x1234): Buffer {
  const labels = name === "" ? [] : name.split(".");
  const question = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0]), Buffer.from([type >> 8, type & 0xff, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}
/** A query whose question is the given labels exactly (a label may contain a dot). */
function rawQuery(labels: string[], type: number = TYPE.A, id = 0x2222): Buffer {
  const question = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0]), Buffer.from([type >> 8, type & 0xff, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}
/** The answer to a query: the same id and question, the response bit, the given rcode, and one A record when it is NOERROR. */
function answer(request: Buffer, rcode: number, extra?: { truncated?: boolean }): Buffer {
  const copy = Buffer.from(request);
  const flags = 0x8180 | rcode | (extra?.truncated === true ? 0x0200 : 0);
  copy.writeUInt16BE(flags, 2);
  if (rcode !== RCODE.ok) return copy;
  copy.writeUInt16BE(1, 6);
  return Buffer.concat([copy, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34])]);
}

interface FakeUpstream { port: number; seen: string[]; tcpConnects: () => number; close(): Promise<void> }
/** A resolver that answers by a table: name -> rcode (anything not in the table is NOERROR). `silent` names get no answer at all. */
async function upstream(rcodes: Record<string, number>, options: { silent?: string[]; truncate?: string[]; wrongId?: string[]; wrongQuestion?: string[]; bigTcp?: string[] } = {}): Promise<FakeUpstream> {
  const seen: string[] = [];
  const udp = createSocket("udp4");
  const handle = (request: Buffer): Buffer | undefined => {
    const parsed = parseDnsPacket(request);
    if (parsed === undefined) return undefined;
    seen.push(`${parsed.name}/${String(parsed.type)}`);
    if (options.silent?.includes(parsed.name)) return undefined;
    let reply = answer(request, rcodes[parsed.name] ?? RCODE.ok, { truncated: options.truncate?.includes(parsed.name) === true });
    if (options.bigTcp?.includes(parsed.name)) reply = Buffer.concat([reply, Buffer.alloc(6_000)]);
    if (options.wrongId?.includes(parsed.name)) reply.writeUInt16BE((parsed.id + 1) & 0xffff, 0);
    if (options.wrongQuestion?.includes(parsed.name)) reply = answer(query("other.example.org", parsed.type, parsed.id), rcodes[parsed.name] ?? RCODE.ok);
    return reply;
  };
  udp.on("message", (message, remote) => {
    const reply = handle(message);
    if (reply !== undefined && reply.length > 4_096) return;
    if (reply !== undefined) udp.send(reply, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const port = udp.address().port;
  let tcpConnects = 0;
  const tcp = createServer((socket) => {
    tcpConnects += 1;
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
        const length = buffered.readUInt16BE(0);
        const reply = handle(buffered.subarray(2, 2 + length));
        buffered = buffered.subarray(2 + length);
        if (reply !== undefined) socket.write(Buffer.concat([Buffer.from([reply.length >> 8, reply.length & 0xff]), reply]));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => tcp.listen(port, "127.0.0.1", resolve));
  return { port, seen, tcpConnects: () => tcpConnects, close: () => Promise.all([new Promise<void>((resolve) => udp.close(() => resolve())), new Promise<void>((resolve) => tcp.close(() => resolve()))]).then(() => undefined) };
}

/** Asks the forwarder over UDP and returns the reply (undefined when none comes in `waitMs`). */
function ask(port: number, packet: Buffer, waitMs = 600): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const client = createSocket("udp4");
    const timer = setTimeout(() => { client.close(); resolve(undefined); }, waitMs);
    client.on("message", (message) => { clearTimeout(timer); client.close(); resolve(message); });
    client.send(packet, port, "127.0.0.1");
  });
}
function askTcp(port: number, packet: Buffer, waitMs = 800): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, waitMs);
    socket.on("connect", () => socket.write(Buffer.concat([Buffer.from([packet.length >> 8, packet.length & 0xff]), packet])));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) { clearTimeout(timer); socket.destroy(); resolve(buffered.subarray(2, 2 + buffered.readUInt16BE(0))); }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(undefined); });
  });
}
const rcodeOf = (reply: Buffer | undefined) => (reply === undefined ? undefined : reply.readUInt16BE(2) & 0xf);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function forwarder(rcodes: Record<string, number>, upstreamOptions: Parameters<typeof upstream>[1] = {}, options: Partial<ConstructorParameters<typeof SetupDnsWatch>[0]> = {}) {
  const fake = await upstream(rcodes, upstreamOptions);
  closers.push(() => fake.close());
  const watch = new SetupDnsWatch({ listenAddress: "127.0.0.1", allowLoopback: true, allowedSources: ["127.0.0.1"], port: 0, upstream: { address: "127.0.0.1", port: fake.port }, upstreamTimeoutMs: 300, ...options });
  const bound = await watch.start();
  closers.push(() => watch.stop());
  return { watch, fake, port: bound.port };
}

describe("parsing a DNS packet", () => {
  it("reads the id, the question name (lower-cased, no trailing dot), its type and the response code", () => {
    expect(parseDnsPacket(query("Pypi.ORG", TYPE.AAAA, 7))).toMatchObject({ id: 7, name: "pypi.org", type: TYPE.AAAA, response: false, rcode: 0 });
    expect(parseDnsPacket(answer(query("x.example.com"), RCODE.nxdomain))).toMatchObject({ name: "x.example.com", response: true, rcode: RCODE.nxdomain });
  });

  it("refuses a packet it cannot read exactly: short, two questions, a compressed question name, a label over 63 bytes, a name over 253", () => {
    expect(parseDnsPacket(Buffer.alloc(5))).toBeUndefined();
    const two = query("a.example.com");
    two.writeUInt16BE(2, 4);
    expect(parseDnsPacket(two)).toBeUndefined();
    const pointer = Buffer.concat([query("a.example.com").subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
    expect(parseDnsPacket(pointer)).toBeUndefined();
    expect(parseDnsPacket(query(`${"a".repeat(64)}.example.com`))).toBeUndefined();
    expect(parseDnsPacket(query(`${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(30)}.com`))).toBeUndefined();
    const cut = query("a.example.com");
    expect(parseDnsPacket(cut.subarray(0, cut.length - 3))).toBeUndefined();
  });
});

describe("the setup sandbox's DNS forwarder", () => {
  it("passes an allowed name through unchanged and records nothing", async () => {
    const { watch, port } = await forwarder({});
    const request = query("pypi.org", TYPE.A, 0x0a0b);
    const reply = await ask(port, request);
    expect(reply).toBeDefined();
    expect(reply!.readUInt16BE(0)).toBe(0x0a0b);
    expect(rcodeOf(reply)).toBe(RCODE.ok);
    expect(reply!.subarray(-4)).toEqual(Buffer.from([93, 184, 216, 34]));
    expect(watch.blockedHosts()).toEqual([]);
  });

  it("records a name the resolver answers NXDOMAIN or REFUSED, hands the answer back unchanged, and lower-cases the name", async () => {
    const { watch, port } = await forwarder({ "artifactory.corp.example": RCODE.nxdomain, "files.pkg-host.example": RCODE.refused });
    expect(rcodeOf(await ask(port, query("Artifactory.Corp.Example")))).toBe(RCODE.nxdomain);
    expect(rcodeOf(await ask(port, query("files.pkg-host.example", TYPE.AAAA)))).toBe(RCODE.refused);
    expect(watch.blockedHosts()).toEqual(["artifactory.corp.example", "files.pkg-host.example"]);
  });

  it("does not record a name for any other answer: SERVFAIL, NOERROR, or no answer at all", async () => {
    const { watch, port } = await forwarder({ "flaky.example.com": RCODE.servfail }, { silent: ["quiet.example.com"] });
    expect(rcodeOf(await ask(port, query("flaky.example.com")))).toBe(RCODE.servfail);
    expect(await ask(port, query("quiet.example.com"), 700)).toBeUndefined();
    expect(watch.blockedHosts()).toEqual([]);
  });

  it("records only address lookups (A, AAAA, HTTPS): a refused TXT, MX or reverse lookup is not a host the setup needs", async () => {
    const { watch, port } = await forwarder({ "txt.example.com": RCODE.nxdomain, "4.3.2.1.in-addr.arpa": RCODE.nxdomain, "mx.example.com": RCODE.nxdomain, "web.example.com": RCODE.nxdomain });
    await ask(port, query("txt.example.com", TYPE.TXT));
    await ask(port, query("4.3.2.1.in-addr.arpa", TYPE.PTR));
    await ask(port, query("mx.example.com", TYPE.MX));
    await ask(port, query("web.example.com", TYPE.HTTPS));
    expect(watch.blockedHosts()).toEqual(["web.example.com"]);
  });

  it("records only names that are plain host names: a single label, an underscore name and an address literal are left out", async () => {
    const { watch, port } = await forwarder({ localhost2: RCODE.nxdomain, "_dmarc.example.com": RCODE.nxdomain, "10.0.0.5": RCODE.nxdomain, "real.example.com": RCODE.nxdomain });
    for (const name of ["localhost2", "_dmarc.example.com", "10.0.0.5", "real.example.com"]) await ask(port, query(name));
    expect(watch.blockedHosts()).toEqual(["real.example.com"]);
  });

  it("keeps each name once, however often it is asked", async () => {
    const { watch, port } = await forwarder({ "a.example.com": RCODE.nxdomain });
    for (let i = 0; i < 4; i += 1) await ask(port, query("a.example.com", i % 2 === 0 ? TYPE.A : TYPE.AAAA, i));
    expect(watch.blockedHosts()).toEqual(["a.example.com"]);
  });

  it("remembers at most 50 names per run, counts the ones it dropped, and still answers them", async () => {
    const rcodes: Record<string, number> = {};
    for (let i = 0; i < SETUP_BLOCKED_HOSTS_MAX + 5; i += 1) rcodes[`h${String(i)}.example.com`] = RCODE.nxdomain;
    const { watch, port } = await forwarder(rcodes);
    expect(SETUP_BLOCKED_HOSTS_MAX).toBe(50);
    for (let i = 0; i < SETUP_BLOCKED_HOSTS_MAX + 5; i += 1) expect(rcodeOf(await ask(port, query(`h${String(i)}.example.com`)))).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toHaveLength(50);
    expect(watch.blockedHosts()[49]).toBe("h49.example.com");
    expect(watch.droppedNames()).toBe(5);
  });

  it("hands each command the names refused since the last command, while the run keeps the whole list", async () => {
    const { watch, port } = await forwarder({ "one.example.com": RCODE.nxdomain, "two.example.com": RCODE.nxdomain });
    await ask(port, query("one.example.com"));
    expect(watch.takeBlocked()).toEqual(["one.example.com"]);
    expect(watch.takeBlocked()).toEqual([]);
    await ask(port, query("two.example.com"));
    await ask(port, query("one.example.com"));
    expect(watch.takeBlocked().sort()).toEqual(["one.example.com", "two.example.com"]);
    expect(watch.blockedHosts()).toEqual(["one.example.com", "two.example.com"]);
  });

  it("ignores an answer that is not for the question asked: another id, or another question", async () => {
    const { watch, port } = await forwarder({ "id.example.com": RCODE.nxdomain, "q.example.com": RCODE.nxdomain }, { wrongId: ["id.example.com"], wrongQuestion: ["q.example.com"] });
    expect(await ask(port, query("id.example.com"), 700)).toBeUndefined();
    expect(await ask(port, query("q.example.com"), 700)).toBeUndefined();
    expect(watch.blockedHosts()).toEqual([]);
  });

  it("serves a query over TCP as well, so a truncated answer can be asked again", async () => {
    const { watch, port } = await forwarder({ "big.example.com": RCODE.nxdomain, "tcp.example.com": RCODE.nxdomain }, { truncate: ["big.example.com"] });
    const udpReply = await ask(port, query("big.example.com"));
    expect(udpReply!.readUInt16BE(2) & 0x0200).toBe(0x0200);
    const reply = await askTcp(port, query("tcp.example.com", TYPE.A, 0x0042));
    expect(reply!.readUInt16BE(0)).toBe(0x0042);
    expect(rcodeOf(reply)).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toContain("tcp.example.com");
  });

  it("answers only the sources it was given, and drops the rest without recording them", async () => {
    const { watch, port } = await forwarder({ "x.example.com": RCODE.nxdomain }, {}, { allowedSources: ["10.9.8.7"] });
    expect(await ask(port, query("x.example.com"), 500)).toBeUndefined();
    expect(watch.blockedHosts()).toEqual([]);
    expect(await askTcp(port, query("x.example.com"), 500)).toBeUndefined();
  });

  it("drops a packet it cannot read, a response sent to it as a query, and a query of a kind other than a standard one", async () => {
    const { watch, fake, port } = await forwarder({ "x.example.com": RCODE.nxdomain });
    await ask(port, Buffer.from("not dns"), 300);
    await ask(port, answer(query("x.example.com"), RCODE.nxdomain), 300);
    const status = query("x.example.com");
    status.writeUInt16BE(0x1100, 2); // opcode 2 (status)
    await ask(port, status, 300);
    expect(fake.seen).toEqual([]);
    expect(watch.blockedHosts()).toEqual([]);
  });

  it("never reads a command's output: nothing but the resolver's answers can add a name", async () => {
    const { watch, port } = await forwarder({});
    // A name written in a log line is just text: the forwarder has no way to receive it, and the names it keeps are exactly the refused queries.
    expect(typeof (watch as unknown as { observeOutput?: unknown }).observeOutput).toBe("undefined");
    await ask(port, query("fine.example.com"));
    expect(watch.blockedHosts()).toEqual([]);
  });

  it("bounds the queries in flight: past the bound a query is dropped, not queued", async () => {
    const { watch, port } = await forwarder({}, { silent: ["s1.example.com", "s2.example.com", "s3.example.com"] }, { maxInFlight: 2, upstreamTimeoutMs: 1_000 });
    const slow = [ask(port, query("s1.example.com"), 400), ask(port, query("s2.example.com"), 400)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await ask(port, query("s3.example.com"), 300)).toBeUndefined();
    expect(watch.droppedQueries()).toBeGreaterThanOrEqual(1);
    await Promise.all(slow);
    // Once the slots are free again, queries are answered.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(rcodeOf(await ask(port, query("ok.example.com")))).toBe(RCODE.ok);
  });

  it("stops listening when stopped, and a second stop does nothing", async () => {
    const { watch, port } = await forwarder({});
    await watch.stop();
    expect(await ask(port, query("pypi.org"), 300)).toBeUndefined();
    await expect(watch.stop()).resolves.toBeUndefined();
  });

  it("refuses to start with an address that is not a literal IP, or an upstream that is not", async () => {
    expect(() => new SetupDnsWatch({ listenAddress: "localhost", upstream: { address: "127.0.0.1" } })).toThrow(/IP address/u);
    expect(() => new SetupDnsWatch({ listenAddress: "10.0.0.1", upstream: { address: "dns.example.com" } })).toThrow(/IP address/u);
  });

  it("listens only on an explicit private address: not 0.0.0.0 or ::, not multicast, not a public address, and not loopback unless a test asks", () => {
    const upstreamOption = { address: "10.0.0.2" };
    for (const bad of ["0.0.0.0", "::", "224.0.0.1", "239.1.2.3", "ff02::1", "8.8.8.8", "2001:4860:4860::8888", "127.0.0.1", "::1", "255.255.255.255", "::ffff:10.0.0.1"]) {
      expect(() => new SetupDnsWatch({ listenAddress: bad, upstream: upstreamOption }), bad).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
    for (const good of ["10.0.0.1", "172.18.0.1", "172.31.255.1", "192.168.1.1", "fd00::1", "fe80::1"]) {
      expect(() => new SetupDnsWatch({ listenAddress: good, upstream: upstreamOption }), good).not.toThrow();
    }
    for (const bad of ["172.15.0.1", "172.32.0.1", "11.0.0.1"]) expect(() => new SetupDnsWatch({ listenAddress: bad, upstream: upstreamOption }), bad).toThrow();
    expect(() => new SetupDnsWatch({ listenAddress: "127.0.0.1", allowLoopback: true, upstream: upstreamOption })).not.toThrow();
    expect(() => new SetupDnsWatch({ listenAddress: "0.0.0.0", allowLoopback: true, upstream: upstreamOption })).toThrow();
  });

  it("serves and records nothing until its allowed sources are set, then only those; the sources are replaced by the next call, and must be IP addresses", async () => {
    const fake = await upstream({ "x.example.com": RCODE.nxdomain });
    closers.push(() => fake.close());
    const watch = new SetupDnsWatch({ listenAddress: "127.0.0.1", allowLoopback: true, port: 0, upstream: { address: "127.0.0.1", port: fake.port }, upstreamTimeoutMs: 300 });
    const { port } = await watch.start();
    closers.push(() => watch.stop());
    expect(await ask(port, query("x.example.com"), 400)).toBeUndefined();
    expect(await askTcp(port, query("x.example.com"), 400)).toBeUndefined();
    expect(fake.seen).toEqual([]);
    expect(watch.blockedHosts()).toEqual([]);
    watch.setAllowedSources(["10.9.8.7"]);
    expect(await ask(port, query("x.example.com"), 400)).toBeUndefined();
    expect(watch.blockedHosts()).toEqual([]);
    watch.setAllowedSources(["127.0.0.1"]);
    expect(rcodeOf(await ask(port, query("x.example.com")))).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toEqual(["x.example.com"]);
    for (const bad of [[], ["sandbox"], ["0.0.0.0"], ["::"], ["224.0.0.1"], ["127.0.0.1", "nope"]]) expect(() => watch.setAllowedSources(bad), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => new SetupDnsWatch({ listenAddress: "10.0.0.1", allowedSources: [], upstream: { address: "10.0.0.2" } })).toThrow();
  });
});

describe("the TCP path is bounded", () => {
  /** Opens one connection and writes `count` queries back to back. */
  function flood(port: number, count: number): Promise<{ closed: Promise<void>; socket: ReturnType<typeof connect> }> {
    return new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      const closed = new Promise<void>((done) => { socket.on("close", () => done()); socket.on("error", () => undefined); });
      socket.on("connect", () => {
        const parts: Buffer[] = [];
        for (let i = 0; i < count; i += 1) { const q = query("silent.example.com", TYPE.A, i); parts.push(Buffer.from([q.length >> 8, q.length & 0xff]), q); }
        socket.write(Buffer.concat(parts));
        resolve({ closed, socket });
      });
    });
  }

  it("closes a connection that queues more than 8 queries at once, and forwards at most 8 of them upstream", async () => {
    const { watch, fake, port } = await forwarder({}, { silent: ["silent.example.com"] }, { upstreamTimeoutMs: 100 });
    const { closed } = await flood(port, 2_000);
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.tcpConnects()).toBeLessThanOrEqual(8);
    await watch.stop();
    const atStop = fake.tcpConnects();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.tcpConnects()).toBe(atStop);
  });

  it("makes no upstream connection after stop(), even for queries already queued when the client leaves", async () => {
    const { watch, fake, port } = await forwarder({}, { silent: ["silent.example.com"] }, { upstreamTimeoutMs: 200 });
    const { socket } = await flood(port, 6);
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await watch.stop();
    const atStop = fake.tcpConnects();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fake.tcpConnects()).toBe(atStop);
  });

  it("relays a TCP answer larger than 4096 bytes (queries stay capped at 4096)", async () => {
    const { watch, port } = await forwarder({ "big.example.com": RCODE.nxdomain }, { bigTcp: ["big.example.com"] });
    const reply = await askTcp(port, query("big.example.com"));
    expect(reply).toBeDefined();
    expect(reply!.length).toBeGreaterThan(6_000);
    expect(rcodeOf(reply)).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toEqual(["big.example.com"]);
    const oversized = Buffer.concat([query("q.example.com"), Buffer.alloc(5_000)]);
    expect(await askTcp(port, oversized, 400)).toBeUndefined();
  });
});

describe("a name the resolver was not asked for by its dotted form", () => {
  it("is not recorded when one label contains a dot (the joined name would read as a different host), but the answer is still relayed", async () => {
    const { watch, port } = await forwarder({ "a.b.example.com": RCODE.nxdomain });
    expect(rcodeOf(await ask(port, rawQuery(["a.b", "example", "com"])))).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toEqual([]);
    expect(rcodeOf(await ask(port, rawQuery(["a", "b", "example", "com"])))).toBe(RCODE.nxdomain);
    expect(watch.blockedHosts()).toEqual(["a.b.example.com"]);
  });
});

describe("sockets are the only way in", () => {
  it("is not an open resolver: it forwards only to its one upstream", async () => {
    const other = await upstream({ "x.example.com": RCODE.nxdomain });
    closers.push(() => other.close());
    const { port } = await forwarder({});
    await ask(port, query("x.example.com"));
    expect(other.seen).toEqual([]);
  });
});
