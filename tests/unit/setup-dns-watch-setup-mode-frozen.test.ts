// TS16: the setup run's DNS watch (SetupDnsWatch) must stay exactly as it was when the sealed mode was added beside it (setup-dns-watch.ts). Two proofs, on top of the existing tests in setup-dns-watch.test.ts:
//   1. a source proof: everything in the file BEFORE the sealed-mode marker hashes to the value it had at the base (34887c318). Adding the sealed mode may only append after the marker;
//   2. a behaviour snapshot: a fixed set of queries sent through the watch to a fake resolver gives these exact reply bytes, these recorded names and these counters; the helper program's arguments and the
//      setup helper's docker arguments are pinned too.
// If you change the setup mode on purpose, update both numbers here in the same commit and say why ("Replaces: ...").
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SetupDnsWatch } from "../../packages/worker/src/setup-dns-watch.js";
import { helperRunArgs, setupNetworkAddresses } from "../../packages/worker/src/setup-network.js";

const SOURCE = new URL("../../packages/worker/src/setup-dns-watch.ts", import.meta.url);
const SEALED_MARKER = "// ===== SEALED MODE (TS16): appended after the setup mode; the setup mode above this line is frozen (tests/unit/setup-dns-watch-setup-mode-frozen.test.ts) =====\n";
// Replaces c68b6a76... (2026-11-04, fix/053-linux-2): the only change above the marker is the contracts import, now `@agentx/contracts/dns-helper` instead of the barrel, so the helper fits its 128 MB limit
// (the barrel got the sealed helper OOM-killed on linux-runtime; tests/unit/worker-dns-helper-footprint.test.ts). The behaviour snapshot below is unchanged.
const SETUP_MODE_SHA256 = "068992ab451f0058868d3731dc57ba927bb4f6a8075cec5e2fec49d88ac0d481";
const HELPER_SOURCE = new URL("../../packages/worker/src/setup-dns-watch-helper.ts", import.meta.url);
const HELPER_SHA256 = "822da350f1a8864ec02edcd008564b13bf0eb303d43f955e21250c544df61c55";
const NETWORK_SOURCE = new URL("../../packages/worker/src/setup-network.ts", import.meta.url);
const NETWORK_SHA256 = "5ba47b5940e5ad5b0c9826d7e875de8938906f376ce7b6238c19fba77eecca0e";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function query(name: string, type: number, id: number): Buffer {
  const question = Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0]), Buffer.from([type >> 8, type & 0xff, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}
/** The upstream's answer: NXDOMAIN for names starting `blocked`, REFUSED for names starting `refused`, otherwise one A record. */
function answer(request: Buffer, name: string): Buffer {
  const copy = Buffer.from(request);
  const rcode = name.startsWith("blocked") ? 3 : name.startsWith("refused") ? 5 : 0;
  copy.writeUInt16BE(0x8180 | rcode, 2);
  if (rcode !== 0) return copy;
  copy.writeUInt16BE(1, 6);
  return Buffer.concat([copy, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34])]);
}
function nameOf(packet: Buffer): string {
  const labels: string[] = [];
  for (let at = 12; packet[at] !== 0; at += packet[at]! + 1) labels.push(packet.toString("latin1", at + 1, at + 1 + packet[at]!));
  return labels.join(".");
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

function ask(port: number, packet: Buffer, waitMs = 500): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const client = createSocket("udp4");
    const timer = setTimeout(() => { client.close(); resolve(undefined); }, waitMs);
    client.on("message", (message) => { clearTimeout(timer); client.close(); resolve(message); });
    client.send(packet, port, "127.0.0.1");
  });
}

describe("the setup run's DNS watch is unchanged by the sealed mode", () => {
  it("everything above the sealed-mode marker is the base file, byte for byte", () => {
    const text = readFileSync(SOURCE, "utf8");
    const at = text.indexOf(SEALED_MARKER);
    expect(at).toBeGreaterThan(0);
    expect(text.indexOf(SEALED_MARKER, at + 1)).toBe(-1);
    expect(sha(text.slice(0, at))).toBe(SETUP_MODE_SHA256);
  });

  it("the setup helper program and the setup network module are the base files, byte for byte", () => {
    expect(sha(readFileSync(HELPER_SOURCE, "utf8"))).toBe(HELPER_SHA256);
    expect(sha(readFileSync(NETWORK_SOURCE, "utf8"))).toBe(NETWORK_SHA256);
  });

  it("the setup helper's docker arguments are unchanged", () => {
    const args = helperRunArgs({ name: "agentx-setup-aaaaaaaaaaaa-dns", network: "agentx-setup-aaaaaaaaaaaa", taskId: "task-1", workspace: "0123456789abcdef", image: "worker:img", addresses: setupNetworkAddresses(5), upstream: "127.0.0.11" });
    expect(args.join(" ")).toMatchInlineSnapshot(`"run --detach --name agentx-setup-aaaaaaaaaaaa-dns --label agentx.setup-run=agentx-setup-cba5c3d77d4a --label agentx.setup-workspace=0123456789abcdef --network agentx-setup-aaaaaaaaaaaa --ip 172.29.5.2 --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only --sysctl net.ipv4.ip_unprivileged_port_start=53 --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --tmpfs /state:rw,noexec,nosuid,size=1m,uid=1000,gid=1000 --entrypoint /usr/local/bin/node worker:img /opt/agentx/packages/worker/dist/setup-dns-watch-helper.js --listen 172.29.5.2 --source 172.29.5.3 --upstream 127.0.0.11 --state /state/blocked.json"`);
  });

  it("a fixed set of queries gives the same reply bytes, recorded names and counters", async () => {
    const upstream = createSocket("udp4");
    upstream.on("message", (message, remote) => { upstream.send(answer(message, nameOf(message)), remote.port, remote.address); });
    await new Promise<void>((resolve) => upstream.bind(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const watch = new SetupDnsWatch({ listenAddress: "127.0.0.1", allowLoopback: true, allowedSources: ["127.0.0.1"], port: 0, upstream: { address: "127.0.0.1", port: upstream.address().port }, upstreamTimeoutMs: 300 });
    const { port } = await watch.start();
    closers.push(() => watch.stop());
    const lines: string[] = [];
    let id = 0x4000;
    for (const [name, type] of [["ok.example.org", 1], ["blocked.example.org", 1], ["refused.example.net", 28], ["blocked.example.org", 65], ["blocked-txt.example.org", 16], ["registry.example.com", 1], ["blockedtwo.example.org", 1]] as const) {
      id += 1;
      const reply = await ask(port, query(name, type, id));
      lines.push(`${name}/${String(type)} -> ${reply === undefined ? "none" : reply.toString("hex")}`);
    }
    lines.push(`blocked=${JSON.stringify(watch.blockedHosts())}`, `taken=${JSON.stringify(watch.takeBlocked())}`, `again=${JSON.stringify(watch.takeBlocked())}`, `droppedNames=${String(watch.droppedNames())}`, `droppedQueries=${String(watch.droppedQueries())}`);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "ok.example.org/1 -> 400181800001000100000000026f6b076578616d706c65036f72670000010001c00c000100010000003c00045db8d822
      blocked.example.org/1 -> 40028183000100000000000007626c6f636b6564076578616d706c65036f72670000010001
      refused.example.net/28 -> 4003818500010000000000000772656675736564076578616d706c65036e657400001c0001
      blocked.example.org/65 -> 40048183000100000000000007626c6f636b6564076578616d706c65036f72670000410001
      blocked-txt.example.org/16 -> 4005818300010000000000000b626c6f636b65642d747874076578616d706c65036f72670000100001
      registry.example.com/1 -> 400681800001000100000000087265676973747279076578616d706c6503636f6d0000010001c00c000100010000003c00045db8d822
      blockedtwo.example.org/1 -> 4007818300010000000000000a626c6f636b656474776f076578616d706c65036f72670000010001
      blocked=["blocked.example.org","refused.example.net","blockedtwo.example.org"]
      taken=["blocked.example.org","refused.example.net","blockedtwo.example.org"]
      again=[]
      droppedNames=0
      droppedQueries=0"
    `);
  });
});
