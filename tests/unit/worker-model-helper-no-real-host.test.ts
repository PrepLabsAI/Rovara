// TE-F2 part B, THE REQUIRED TEST (7a, 2026-11-13; te-f1 design 3.4): the lane fails if any request reaches a real model host during a scripted-replies run. Offline layer, every PR:
//   - a network tripwire is installed (connect, dns, http(s).request and fetch to a non-loopback name or address are refused and recorded);
//   - the model hosts of F0a's `modelHostBlockList` plus a test-only canary name resolve to the helper (as F1-b's `--add-host` block does), and port 443 and 80 are the helper's recorder listeners;
//   - a fake client that IGNORES its base URL dials those hosts; the recorder (a test double behind `ModelHostRecorderPort`) logs the NAME, `findRedirectEscapes` names it, and the round result is "not run", never a pass;
//   - nothing was refused by the tripwire, every real socket went to loopback, and the program's own files import nothing that could open an outbound socket.
// The Linux and staging layers are F1-b's script and F1-g's canary.
import { readFileSync } from "node:fs";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModelCatalog, findRedirectEscapes, modelHostBlockList } from "../../packages/contracts/src/index.js";
import { modelHelperEvidence } from "../../packages/worker/src/model-helper-round.js";
import { nameReadingRecorder } from "../support/model-escape-recorder-double.js";
import { installModelNetworkTripwire } from "../support/model-network-tripwire.js";
import { OPENAI_BODY, cleanupWorlds, request, stampSet, startWorld, type World } from "../support/model-helper-world.js";

afterEach(cleanupWorlds);
const CANARY = "model-canary.rovara-canary.dev";
const BLOCK_LIST = [...modelHostBlockList(builtinModelCatalog().rows, []), CANARY].sort();
const SET = stampSet("openai_compatible", [{ id: "chat", response: { text: "Hello from the script.", finish: "stop" } }]);

const dialTls = (host: string): Promise<void> =>
  new Promise((resolveDial) => {
    try {
      const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
      socket.on("error", () => resolveDial());
      socket.on("close", () => resolveDial());
    } catch {
      resolveDial();
    }
  });
const dialPlain = (host: string): Promise<void> =>
  new Promise((resolveDial) => {
    try {
      const req = http.request({ host, port: 80, path: "/v1/models", headers: { host } }, (res) => {
        res.resume();
        res.on("end", () => resolveDial());
      });
      req.on("error", () => resolveDial());
      req.end();
    } catch {
      resolveDial();
    }
  });
const settle = async (world: World, wanted: number): Promise<void> => {
  for (let i = 0; i < 200 && world.summary().escapes.count < wanted; i += 1) await new Promise((r) => setTimeout(r, 25));
};

describe("no request reaches a real model host during a scripted-replies run", () => {
  it("a client that ignores its redirect lands on the helper by NAME, the round is not run, and nothing leaves loopback", async () => {
    const world = await startWorld({ sets: [SET], escapes: { recorder: nameReadingRecorder, ports: { tls: 0, plain: 0 } }, blockState: "by_name" });
    const ports = world.loop.escapePorts as { tls: number; plain: number };
    const tripwire = installModelNetworkTripwire({ resolver: new Set(BLOCK_LIST), ports: { 443: ports.tls, 80: ports.plain } });
    try {
      // a client that honours its base URL gets the scripted reply
      const honoured = await request(`${world.base}/p/openai/v1/chat/completions`, { method: "POST", body: OPENAI_BODY });
      expect(honoured.status).toBe(200);
      // clients that ignore it: two real model hosts over TLS, one over plain HTTP, and the canary
      await Promise.all([dialTls("generativelanguage.googleapis.com"), dialTls("api.openai.com"), dialPlain("api.anthropic.com"), dialTls(CANARY)]);
      // the global fetch of Node (undici) too
      await fetch("https://api.cohere.com/v2/chat", { method: "POST" }).catch(() => undefined);
      await settle(world, 5);
    } finally {
      tripwire.restore();
    }
    const summary = world.summary();
    await world.close();
    // the tripwire refused nothing: every dial was to a name the block points at the helper, and every real socket went to loopback
    expect(tripwire.refused).toEqual([]);
    expect(tripwire.opened.every((address) => address.startsWith("127."))).toBe(true);
    expect(new Set(tripwire.dials.map((dial) => dial.host))).toEqual(new Set(["generativelanguage.googleapis.com", "api.openai.com", "api.anthropic.com", CANARY, "api.cohere.com"]));
    // the recorder logged the NAMES
    expect(summary.trusted).toBe(true);
    expect(summary.escapes.hosts).toEqual(["api.anthropic.com", "api.cohere.com", "api.openai.com", CANARY, "generativelanguage.googleapis.com"].sort());
    expect(summary.escapes.unreadable).toBe(0);
    // the finder reads the same hosts, and the round result is "not run"
    const escapes = findRedirectEscapes(BLOCK_LIST, summary.escapes.hosts);
    expect(escapes.map((escape) => escape.sentence)).toContain("not run: client ignored the redirect (called generativelanguage.googleapis.com)");
    expect(escapes.map((escape) => escape.sentence)).toContain("not run: client ignored the redirect (called api.openai.com)");
    const evidence = modelHelperEvidence(summary, BLOCK_LIST);
    expect(evidence.result).toBe("not_run");
    expect(evidence.lines).toContain("not run: client ignored the redirect (called generativelanguage.googleapis.com)");
    expect(evidence.lines).toContain("not sealed; model hosts blocked by name only");
    expect(evidence.lines.join("\n")).not.toMatch(/sealed(?!;)/u);
    // the honoured call still counts as a scripted call
    expect(summary.scripted.before_task).toBe(1);
  });

  it("the whole block list: every host of modelHostBlockList plus the canary, dialed one by one, is recorded by name and never reaches out", async () => {
    const world = await startWorld({ sets: [SET], escapes: { recorder: nameReadingRecorder, ports: { tls: 0, plain: 0 } } });
    const ports = world.loop.escapePorts as { tls: number; plain: number };
    const tripwire = installModelNetworkTripwire({ resolver: new Set(BLOCK_LIST), ports: { 443: ports.tls, 80: ports.plain } });
    try {
      await Promise.all(BLOCK_LIST.map((host) => dialTls(host)));
      await settle(world, BLOCK_LIST.length);
    } finally {
      tripwire.restore();
    }
    const summary = world.summary();
    await world.close();
    expect(tripwire.refused).toEqual([]);
    expect(summary.escapes.hosts).toEqual(BLOCK_LIST);
    expect(findRedirectEscapes(BLOCK_LIST, summary.escapes.hosts)).toHaveLength(BLOCK_LIST.length);
  });

  it("positive control: the tripwire does refuse and record a dial to a host the block does not cover", async () => {
    const tripwire = installModelNetworkTripwire({ resolver: new Set(), ports: { 443: 1, 80: 1 } });
    try {
      await dialTls("api.openai.com");
      await fetch("https://generativelanguage.googleapis.com/v1/models").catch(() => undefined);
      await dialPlain("api.cohere.com");
    } finally {
      tripwire.restore();
    }
    expect(new Set(tripwire.refused.map((entry) => entry.door))).toEqual(new Set(["socket", "fetch", "http"]));
    expect(tripwire.refused.length).toBeGreaterThanOrEqual(3);
    expect(tripwire.opened).toEqual([]);
  });

  it("L3: the tripwire also refuses dns.resolve*, dns.promises, UDP and HTTP/2 to a host the block does not cover", async () => {
    const tripwire = installModelNetworkTripwire({ resolver: new Set(), ports: { 443: 1, 80: 1 } });
    const attempt = async (body: () => unknown): Promise<void> => {
      try {
        await body();
      } catch {
        // refused: recorded by the tripwire
      }
    };
    try {
      await attempt(() => dns.resolve4("api.openai.com", () => undefined));
      await attempt(() => dns.promises.resolve("generativelanguage.googleapis.com"));
      await attempt(() => dns.promises.lookup("api.anthropic.com"));
      await attempt(() => dns.reverse("8.8.8.8", () => undefined));
      await attempt(() => { const socket = dgram.createSocket("udp4"); socket.on("error", () => undefined); try { socket.send(Buffer.from("x"), 53, "8.8.8.8"); } finally { socket.close(); } });
      await attempt(() => http2.connect("https://api.cohere.com"));
    } finally {
      tripwire.restore();
    }
    expect(new Set(tripwire.refused.map((entry) => entry.door))).toEqual(new Set(["dns", "udp", "http2"]));
    expect(tripwire.refused.length).toBeGreaterThanOrEqual(6);
  });

  it("a client that ignores its redirect on a connection the recorder cannot name is still an escape: not run (host unreadable)", async () => {
    const world = await startWorld({ sets: [SET], escapes: { recorder: { observe: () => ({ host: undefined }) }, ports: { tls: 0, plain: 0 } } });
    const ports = world.loop.escapePorts as { tls: number; plain: number };
    await new Promise<void>((done) => {
      const socket = tls.connect({ host: "127.0.0.1", port: ports.tls, servername: "api.openai.com", rejectUnauthorized: false });
      socket.on("error", () => done());
      socket.on("close", () => done());
    });
    await settle(world, 1);
    const summary = world.summary();
    await world.close();
    expect(summary.escapes).toMatchObject({ count: 1, unreadable: 1, hosts: [] });
    const evidence = modelHelperEvidence(summary, BLOCK_LIST);
    expect(evidence.result).toBe("not_run");
    expect(evidence.lines).toContain("not run: client ignored the redirect (host unreadable)");
  });

  it("L1: a connection that never sends a byte is in the ledger as an escape the moment it is accepted (not after the read times out)", async () => {
    const world = await startWorld({ sets: [SET], escapes: { recorder: nameReadingRecorder, ports: { tls: 0, plain: 0 } } });
    const ports = world.loop.escapePorts as { tls: number; plain: number };
    const socket = net.connect(ports.tls, "127.0.0.1");
    await new Promise<void>((done) => socket.on("connect", () => done()));
    // well inside the 3 s read timeout: the row was written on accept
    await new Promise((done) => setTimeout(done, 300));
    expect(world.summary().escapes).toMatchObject({ count: 1, unreadable: 1 });
    socket.destroy();
    await world.close();
  });

  it("a name the recorder returns that is not a plain public host (a path, an address, a URL with userinfo) is not written: the escape is unreadable, never repeated", async () => {
    const world = await startWorld({ sets: [SET], escapes: { recorder: { observe: () => ({ host: "evil.example.com/../x user@host" }) }, ports: { tls: 0, plain: 0 } } });
    const ports = world.loop.escapePorts as { tls: number; plain: number };
    await new Promise<void>((done) => {
      const socket = tls.connect({ host: "127.0.0.1", port: ports.tls, servername: "api.openai.com", rejectUnauthorized: false });
      socket.on("error", () => done());
      socket.on("close", () => done());
    });
    await settle(world, 1);
    const summary = world.summary();
    await world.close();
    expect(summary.escapes).toMatchObject({ count: 1, unreadable: 1, hosts: [] });
    expect(world.ledgerText()).not.toContain("evil");
  });
});

describe("the helper program has no outbound socket", () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/worker/src");
  // the helper's own files: its program, its loop, its args, its ledger, its bundle reader and the recorder port
  const FILES = ["model-helper.ts", "model-helper-http.ts", "model-helper-metadata.ts", "model-helper-args.ts", "model-helper-ledger.ts", "model-reply-bundle.ts", "model-helper-recorder-port.ts"];
  const source = (file: string): string => readFileSync(join(dir, file), "utf8").replace(/^\s*\/\/.*$/gmu, "");
  it("never imports net.connect, dns, tls, https, http2, dgram, child_process, an HTTP client or fetch", () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/from "node:(dns|dns\/promises|tls|https|http2|dgram|child_process|cluster|worker_threads|vm)"/u);
      expect(text, file).not.toMatch(/\bfetch\s*\(|undici|createConnection|\.connect\s*\(|http\.request|http\.get|new Agent|XMLHttpRequest|WebSocket/u);
      // `node:net` and `node:http` only for servers
      for (const match of text.matchAll(/import \{([^}]*)\} from "node:(net|http)"/gu)) {
        const names = (match[1] as string).split(",").map((name) => name.trim().replace(/^type /u, "").replace(/ as .*$/u, ""));
        expect(names.filter((name) => !["createServer", "Server", "Socket", "IncomingMessage", "ServerResponse", "isIP"].includes(name)), `${file} imports ${match[1] as string}`).toEqual([]);
      }
    }
  });
});
