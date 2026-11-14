// TS16: the sealed check sandbox's name server (SealedDnsHelper, setup-dns-watch.ts; test-services.md 4.0.3). A static table, the sinkhole for every other name, no upstream, and only the run's own sandbox addresses
// are served. Real sockets on 127.0.0.1; no Docker. (The setup run's watch is covered by setup-dns-watch.test.ts and proven unchanged by setup-dns-watch-setup-mode-frozen.test.ts.)
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SEALED_DNS_TABLE_MAX, SEALED_DNS_TTL_SECONDS, SEALED_RECORD_NAME_MAX, SealedDnsHelper, isSealedDnsName, parseDnsPacket, type SealedDnsOptions } from "../../packages/worker/src/setup-dns-watch.js";
import { tableFromArguments } from "../../packages/worker/src/sealed-dns-helper.js";
import { sealedDnsHelperRunArgs } from "../../packages/worker/src/check-sandbox.js";
import { runNetworkAddresses, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";

const TYPE = { A: 1, AAAA: 28, TXT: 16, HTTPS: 65, ANY: 255 } as const;
const SINKHOLE = "172.30.5.16";
const TABLE = { postgres: "172.30.5.17", aws: "172.30.5.18", "fake-payments.internal": "172.30.5.19", sinkhole: SINKHOLE };

function query(name: string, type: number = TYPE.A, id = 0x1234, options: { klass?: number; flags?: number } = {}): Buffer {
  const labels = name.split(".");
  const question = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0]), Buffer.from([type >> 8, type & 0xff, 0, options.klass ?? 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(options.flags ?? 0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}
function labelsQuery(labels: string[], type: number = TYPE.A, id = 0x2222): Buffer {
  const question = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0]), Buffer.from([type >> 8, type & 0xff, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}
interface Reply { id: number; flags: number; rcode: number; answers: number; address?: string; ttl?: number; question: Buffer }
function read(reply: Buffer): Reply {
  const answers = reply.readUInt16BE(6);
  let end = 12;
  while (reply[end] !== 0) end += reply[end]! + 1;
  end += 5;
  const out: Reply = { id: reply.readUInt16BE(0), flags: reply.readUInt16BE(2), rcode: reply.readUInt16BE(2) & 0xf, answers, question: reply.subarray(12, end) };
  if (answers === 1) {
    expect(reply.subarray(end, end + 6)).toEqual(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1]));
    out.ttl = reply.readUInt32BE(end + 6);
    expect(reply.readUInt16BE(end + 10)).toBe(4);
    out.address = [...reply.subarray(end + 12, end + 16)].join(".");
    expect(reply.length).toBe(end + 16);
  } else {
    expect(reply.length).toBe(end);
  }
  return out;
}

function ask(port: number, packet: Buffer, waitMs = 400): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const client = createSocket("udp4");
    const timer = setTimeout(() => { client.close(); resolve(undefined); }, waitMs);
    client.on("message", (message) => { clearTimeout(timer); client.close(); resolve(message); });
    client.send(packet, port, "127.0.0.1");
  });
}
function askTcp(port: number, packets: Buffer[], waitMs = 600): Promise<{ replies: Buffer[]; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = Buffer.alloc(0);
    const replies: Buffer[] = [];
    let closed = false;
    const done = () => { clearTimeout(timer); socket.destroy(); resolve({ replies, closed }); };
    const timer = setTimeout(done, waitMs);
    socket.on("connect", () => { for (const packet of packets) socket.write(Buffer.concat([Buffer.from([packet.length >> 8, packet.length & 0xff]), packet])); });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
        replies.push(buffered.subarray(2, 2 + buffered.readUInt16BE(0)));
        buffered = buffered.subarray(2 + buffered.readUInt16BE(0));
      }
      if (replies.length >= packets.length) done();
    });
    socket.on("close", () => { closed = true; done(); });
    socket.on("error", () => { closed = true; done(); });
  });
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function sealed(options: Partial<SealedDnsOptions> = {}) {
  const helper = new SealedDnsHelper({ listenAddress: "127.0.0.1", allowLoopback: true, port: 0, names: TABLE, sinkholeAddress: SINKHOLE, allowedSources: ["127.0.0.1"], ...options });
  const { port } = await helper.start();
  closers.push(() => helper.stop());
  return { helper, port };
}

describe("the static table", () => {
  it("answers a run name with its address, echoing the id and the question as asked", async () => {
    const { port } = await sealed();
    const reply = read((await ask(port, query("postgres", TYPE.A, 0xbeef)))!);
    expect(reply).toMatchObject({ id: 0xbeef, rcode: 0, answers: 1, address: "172.30.5.17", ttl: SEALED_DNS_TTL_SECONDS });
    expect(reply.flags & 0x8000).toBe(0x8000); // a response
    expect(reply.flags & 0x0100).toBe(0x0100); // recursion desired is echoed
    expect(read((await ask(port, query("fake-payments.internal")))!).address).toBe("172.30.5.19");
  });

  it("matches without regard to case and echoes the case that was asked (0x20 randomisation)", async () => {
    const { port, helper } = await sealed();
    const raw = (await ask(port, query("PoStGrEs")))!;
    expect(read(raw).address).toBe("172.30.5.17");
    expect(raw.subarray(13, 21).toString("latin1")).toBe("PoStGrEs");
    expect(helper.unknownNames()).toEqual([]);
  });

  it("answers an AAAA, HTTPS or ANY question of a run name with an empty NOERROR answer, and does not count it", async () => {
    const { port, helper } = await sealed();
    for (const type of [TYPE.AAAA, TYPE.HTTPS, TYPE.ANY, TYPE.TXT]) expect(read((await ask(port, query("postgres", type)))!)).toMatchObject({ rcode: 0, answers: 0 });
    expect(helper.unknownNames()).toEqual([]);
  });

  it("refuses a table that holds a bad name, a public or loopback address, a bad sinkhole, or too many names", () => {
    const base = { listenAddress: "127.0.0.1", allowLoopback: true, sinkholeAddress: SINKHOLE, allowedSources: ["127.0.0.1"] } as const;
    const make = (names: Record<string, string>, extra: Partial<SealedDnsOptions> = {}) => () => new SealedDnsHelper({ ...base, names, ...extra });
    expect(make({ postgres: "172.30.5.17" })).not.toThrow();
    for (const bad of ["Postgres", "-bad", "a..b", "under_score", "", "a".repeat(64), "pg.", "__proto__"]) expect(make({ [bad]: "172.30.5.17" }), bad).toThrow(/plain lower-case host name/u);
    for (const address of ["8.8.8.8", "127.0.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "93.184.216.34", "::1", "fd00::1", "not-an-ip", ""]) expect(make({ postgres: address }), address).toThrow(/private IPv4/u);
    for (const address of ["8.8.8.8", "127.0.0.1", "0.0.0.0", "fd00::1", "nope"]) expect(make({}, { sinkholeAddress: address }), address).toThrow(/sinkhole/u);
    const many = Object.fromEntries(Array.from({ length: SEALED_DNS_TABLE_MAX + 1 }, (_, index) => [`n${String(index)}`, "172.30.5.17"]));
    expect(make(many)).toThrow(/too long/u);
  });

  it("knows what a plain table name is", () => {
    expect(isSealedDnsName("postgres")).toBe(true);
    expect(isSealedDnsName("a.b-c.d1")).toBe(true);
    for (const bad of ["", "A", "a b", "a_b", ".a", "a.", "-a", "a-", "x".repeat(254)]) expect(isSealedDnsName(bad), bad).toBe(false);
  });
});

describe("a name outside the table goes to the sinkhole and is counted", () => {
  it("answers an A question with the sinkhole's address and counts the name", async () => {
    const { port, helper } = await sealed();
    expect(read((await ask(port, query("api.example-pay.com")))!)).toMatchObject({ rcode: 0, answers: 1, address: SINKHOLE });
    expect(read((await ask(port, query("api.example-pay.com", TYPE.A, 7)))!).address).toBe(SINKHOLE);
    expect(read((await ask(port, query("sts.us-east-1.amazonaws.com")))!).address).toBe(SINKHOLE);
    expect(helper.unknownNames()).toEqual([{ name: "api.example-pay.com", queries: 2 }, { name: "sts.us-east-1.amazonaws.com", queries: 1 }]);
  });

  it("answers a single-label name outside the table (a mistyped alias) with the sinkhole and records it", async () => {
    const { port, helper } = await sealed();
    expect(read((await ask(port, query("postgress")))!).address).toBe(SINKHOLE);
    expect(helper.unknownNames()).toEqual([{ name: "postgress", queries: 1 }]);
  });

  it("answers AAAA and HTTPS of an unknown name with an empty NOERROR answer (so the client uses the A record), counted; other types are neither answered with an address nor counted", async () => {
    const { port, helper } = await sealed();
    for (const type of [TYPE.AAAA, TYPE.HTTPS]) expect(read((await ask(port, query("unknown.example.org", type)))!)).toMatchObject({ rcode: 0, answers: 0 });
    for (const type of [TYPE.TXT, TYPE.ANY]) expect(read((await ask(port, query("unknown.example.org", type)))!)).toMatchObject({ rcode: 0, answers: 0 });
    expect(helper.unknownNames()).toEqual([{ name: "unknown.example.org", queries: 2 }]);
  });

  it("never answers a name with anything but the table's addresses and the sinkhole's", async () => {
    const { port } = await sealed();
    const allowed = new Set([...Object.values(TABLE), SINKHOLE]);
    for (const name of ["example.com", "localhost", "metadata.google.internal", "169.254.169.254", "a.b.c.d.e.f", "postgres.evil.test", "xn--bcher-kva.example", "x".repeat(63)]) {
      const reply = read((await ask(port, query(name)))!);
      expect(allowed.has(reply.address ?? SINKHOLE), name).toBe(true);
    }
  });

  it("keeps at most maxUnknownNames distinct names, counts the rest, and keeps counting the names it holds", async () => {
    const { port, helper } = await sealed({ maxUnknownNames: 2 });
    for (const name of ["one.test", "two.test", "three.test", "one.test", "four.test"]) await ask(port, query(name));
    expect(helper.unknownNames()).toEqual([{ name: "one.test", queries: 2 }, { name: "two.test", queries: 1 }]);
    expect(helper.droppedNames()).toBe(2);
  });

  it("answers a name whose text is not a plain name with the sinkhole, counts it, and never keeps its text", async () => {
    const { port, helper } = await sealed();
    expect(read((await ask(port, labelsQuery(["has.dot", "example", "org"])))!).address).toBe(SINKHOLE);
    expect(read((await ask(port, labelsQuery(["ev il", "org"])))!).address).toBe(SINKHOLE);
    expect(read((await ask(port, labelsQuery(["a\u0001b", "org"])))!).address).toBe(SINKHOLE);
    expect(helper.unknownNames()).toEqual([]);
    expect(helper.unrecordedQueries()).toBe(3);
  });

  it("a dotted label cannot pretend to be a table name", async () => {
    const { port, helper } = await sealed();
    // The single label "fake-payments.internal" is not the two-label name; it must not return the table's address.
    expect(read((await ask(port, labelsQuery(["fake-payments.internal"])))!).address).toBe(SINKHOLE);
    expect(helper.unrecordedQueries()).toBe(1);
  });
});

describe("who is served, and what is dropped", () => {
  it("serves only the addresses it was made with: another caller gets no answer and is not counted", async () => {
    const { port, helper } = await sealed({ allowedSources: ["172.30.5.3", "172.30.5.4"] });
    expect(await ask(port, query("postgres"))).toBeUndefined();
    expect(await ask(port, query("unknown.example.org"))).toBeUndefined();
    const tcp = await askTcp(port, [query("postgres")]);
    expect(tcp.replies).toEqual([]);
    expect(tcp.closed).toBe(true);
    expect(helper.unknownNames()).toEqual([]);
  });

  it("compares the caller's address exactly, not by prefix", async () => {
    const { port, helper } = await sealed({ allowedSources: ["127.0.0.2", "127.0.0.10"] });
    expect(await ask(port, query("postgres"))).toBeUndefined();
    expect(await ask(port, query("unknown.example.org"))).toBeUndefined();
    expect(helper.unknownNames()).toEqual([]);
  });

  it("refuses an empty, unspecified, multicast or oversized list of served addresses, and has no way to widen the list afterwards", () => {
    const make = (allowedSources: string[]) => () => new SealedDnsHelper({ listenAddress: "127.0.0.1", allowLoopback: true, names: TABLE, sinkholeAddress: SINKHOLE, allowedSources });
    expect(make(["127.0.0.1"])).not.toThrow();
    for (const bad of [[], ["0.0.0.0"], ["::"], ["224.0.0.1"], ["nope"], Array.from({ length: 17 }, (_, i) => `10.0.0.${String(i + 1)}`)]) expect(make(bad), JSON.stringify(bad)).toThrow(/sixteen explicit IP/u);
    const helper = new SealedDnsHelper({ listenAddress: "127.0.0.1", allowLoopback: true, names: TABLE, sinkholeAddress: SINKHOLE, allowedSources: ["127.0.0.1"] });
    expect("setAllowedSources" in helper).toBe(false);
  });

  it("listens only on one explicit private address", () => {
    const make = (listenAddress: string, allowLoopback = false) => () => new SealedDnsHelper({ listenAddress, allowLoopback, names: TABLE, sinkholeAddress: SINKHOLE, allowedSources: ["172.30.5.4"] });
    expect(make("172.30.5.2")).not.toThrow();
    for (const bad of ["0.0.0.0", "::", "8.8.8.8", "127.0.0.1", "224.0.0.1", "nope"]) expect(make(bad), bad).toThrow(/listens on/u);
    expect(make("127.0.0.1", true)).not.toThrow();
  });

  it("drops anything that is not one standard query: responses, other opcodes, several questions, compression pointers, truncated or empty packets", async () => {
    const { port, helper } = await sealed();
    expect(await ask(port, query("unknown.test", TYPE.A, 1, { flags: 0x8100 }))).toBeUndefined(); // a response
    expect(await ask(port, query("unknown.test", TYPE.A, 2, { flags: 0x2100 }))).toBeUndefined(); // opcode 4 (notify)
    const two = query("unknown.test");
    two.writeUInt16BE(2, 4);
    expect(await ask(port, two)).toBeUndefined();
    const pointer = Buffer.from(query("unknown.test"));
    pointer[12] = 0xc0;
    expect(await ask(port, pointer)).toBeUndefined();
    expect(await ask(port, query("unknown.test").subarray(0, 14))).toBeUndefined();
    expect(await ask(port, Buffer.alloc(0))).toBeUndefined();
    expect(helper.unknownNames()).toEqual([]);
  });

  it("refuses a question of a class other than IN, without counting it", async () => {
    const { port, helper } = await sealed();
    expect(read((await ask(port, query("unknown.test", TYPE.A, 9, { klass: 3 })))!).rcode).toBe(5);
    expect(helper.unknownNames()).toEqual([]);
  });

  it("answers over TCP the same way, in order, for an allowed caller", async () => {
    const { port, helper } = await sealed();
    const { replies } = await askTcp(port, [query("postgres", TYPE.A, 1), query("elsewhere.test", TYPE.A, 2), query("elsewhere.test", TYPE.AAAA, 3)]);
    expect(replies.map(read).map((r) => [r.id, r.answers, r.address])).toEqual([[1, 1, "172.30.5.17"], [2, 1, SINKHOLE], [3, 0, undefined]]);
    expect(helper.unknownNames()).toEqual([{ name: "elsewhere.test", queries: 2 }]);
  });

  it("closes a TCP connection that sends a flood of questions", async () => {
    const { port } = await sealed();
    const { replies, closed } = await askTcp(port, Array.from({ length: 200 }, (_, index) => query("postgres", TYPE.A, index + 1)), 1_000);
    expect(closed).toBe(true);
    expect(replies.length).toBeLessThan(200);
  });

  it("can be started once and stopped, and a stopped helper answers nothing", async () => {
    const { port, helper } = await sealed();
    await expect(helper.start()).rejects.toThrow(/already started/u);
    await helper.stop();
    await helper.stop();
    expect(await ask(port, query("postgres"), 200)).toBeUndefined();
    await expect(helper.start()).rejects.toThrow(/already stopped/u);
  });
});

describe("it has no way to ask anyone else", () => {
  const source = readFileSync(new URL("../../packages/worker/src/setup-dns-watch.ts", import.meta.url), "utf8");
  const marker = "// ===== SEALED MODE (TS16)";
  // The code of the sealed part, without its comments (which say what it does not do).
  const sealedPart = source.slice(source.indexOf(marker)).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");

  it("has no upstream option, and the sealed part opens no outbound connection or forwarding socket", () => {
    expect(sealedPart).not.toMatch(/upstream/iu);
    expect(sealedPart).not.toMatch(/\bconnect\(/u);
    expect(sealedPart).not.toMatch(/forward/iu);
    expect(sealedPart.match(/createSocket\(/gu)?.length).toBe(1); // the one UDP listener
    expect(sealedPart.match(/createServer\(/gu)?.length).toBe(1); // the one TCP listener
    expect(sealedPart.match(/\.send\(/gu)?.length).toBe(1); // the one reply to the caller
  });

  it("does not accept an upstream (type level and at run time)", async () => {
    // @ts-expect-error SealedDnsOptions has no upstream
    const options: SealedDnsOptions = { listenAddress: "127.0.0.1", allowLoopback: true, port: 0, names: TABLE, sinkholeAddress: SINKHOLE, allowedSources: ["127.0.0.1"], upstream: { address: "127.0.0.1", port: 1 } };
    const helper = new SealedDnsHelper(options);
    const { port } = await helper.start();
    closers.push(() => helper.stop());
    // An unknown name is answered at once with the sinkhole, with nothing listening anywhere to ask.
    expect(read((await ask(port, query("unknown.example.org")))!).address).toBe(SINKHOLE);
  });

  it("parses the replies it builds with the same parser the setup watch uses", async () => {
    const { port } = await sealed();
    const parsed = parseDnsPacket((await ask(port, query("postgres", TYPE.A, 0x77)))!);
    expect(parsed).toMatchObject({ id: 0x77, response: true, rcode: 0, name: "postgres", type: TYPE.A });
  });
});

describe("the helper program's arguments", () => {
  it("turns --host pairs into a table and refuses a malformed or repeated one", () => {
    expect(tableFromArguments(["postgres=172.30.5.17", "aws=172.30.5.18"])).toEqual({ postgres: "172.30.5.17", aws: "172.30.5.18" });
    for (const bad of [["postgres"], ["postgres="], ["=1.2.3.4"], ["a=b=c"], ["a=1.2.3.4", "a=1.2.3.5"]]) expect(() => tableFromArguments(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("the working sandbox at .3 is not served (review M2)", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  const addresses = runNetworkAddresses(5);
  const net = {
    name: runNetworkName(RUN), slot: 5, subnet: addresses.subnet, dnsHelperIp: addresses.dnsHelperIp, workingSandboxIp: addresses.workingSandboxIp, checkSandboxIp: addresses.checkSandboxIp,
    labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1, expiresAt: 2 }),
  };
  const args = sealedDnsHelperRunArgs({ net, image: "img", helpers: [{ alias: "postgres", address: "172.30.5.17" }], sinkholeIp: SINKHOLE });
  const sources = args.flatMap((arg, index) => (args[index - 1] === "--source" ? [arg] : []));

  it("names the check sandbox's address alone as a served source", () => {
    expect(sources).toEqual([addresses.checkSandboxIp]);
    expect(sources).not.toContain(addresses.workingSandboxIp);
  });

  it("a caller that is not on that list (here: the loopback standing for .3) gets no answer and is not recorded, over UDP and TCP", async () => {
    const { port, helper } = await sealed({ allowedSources: sources });
    expect(await ask(port, query("postgres"))).toBeUndefined();
    expect(await ask(port, query("api.unknown-vendor.com"))).toBeUndefined();
    expect((await askTcp(port, [query("api.unknown-vendor.com")])).replies).toEqual([]);
    expect(helper.unknownNames()).toEqual([]);
    expect(helper.droppedNames()).toBe(0);
    expect(helper.unrecordedQueries()).toBe(0);
  });
});

describe("a recorded name is cut to 64 characters (review M4)", () => {
  it("keeps the first 64 characters of a longer name, counting both names under the one record", async () => {
    const head = `${"a".repeat(60)}.bbb`;
    expect(head).toHaveLength(SEALED_RECORD_NAME_MAX);
    const { port, helper } = await sealed();
    await ask(port, query(`${head}.${"c".repeat(40)}.test`));
    await ask(port, query(`${head}.${"d".repeat(30)}.test`));
    await ask(port, query("short.test"));
    expect(helper.unknownNames()).toEqual([{ name: head, queries: 2 }, { name: "short.test", queries: 1 }]);
    expect(SEALED_RECORD_NAME_MAX).toBe(64);
  });
});
