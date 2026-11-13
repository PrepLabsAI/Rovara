// TE-F1b: the 443/80 recorder of the model helper. On 443 it reads the TLS server name out of the ClientHello, records it and closes; on 80 it reads the Host header, records it and closes; it never answers a model request.
// Offline: every socket is on loopback, and the network tripwire (packages/testing) proves nothing else is dialled. ClientHellos are made at runtime by Node's own TLS client (no captured bytes in the repository).
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { installNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import {
  MODEL_HOST_RECORDER, ModelHostRecorder, readHttpHost, readTlsServerName, MODEL_HOST_READ_MAX_BYTES,
} from "../../packages/worker/src/model-helper-recorder.js";

/** The first bytes Node's TLS client sends for `servername` (a real ClientHello), caught by a plain TCP server. */
async function captureHello(servername: string | undefined, extra: tls.ConnectionOptions = {}): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => { socket.destroy(); server.close(); resolve(new Uint8Array(chunk)); });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      const client = tls.connect({ host: "127.0.0.1", port, ...(servername === undefined ? {} : { servername }), ...extra });
      client.on("error", () => undefined);
    });
    server.on("error", reject);
  });
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
let recorders: ModelHostRecorder[] = [];
afterEach(async () => {
  await Promise.all(recorders.map((recorder) => recorder.stop()));
  recorders = [];
});

describe("readTlsServerName", () => {
  it("reads the server name of a real ClientHello, lower-cased, without a trailing dot", async () => {
    expect(readTlsServerName(await captureHello("generativelanguage.googleapis.com"))).toBe("generativelanguage.googleapis.com");
    expect(readTlsServerName(await captureHello("API.OpenAI.com"))).toBe("api.openai.com");
  });
  it("reads a long name and a regional Vertex name", async () => {
    const name = `us-central1-aiplatform.googleapis.com`;
    expect(readTlsServerName(await captureHello(name))).toBe(name);
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example-model-host.com`;
    expect(readTlsServerName(await captureHello(long))).toBe(long);
  });
  it("answers undefined for a hello with no server name (an address as the name sends none)", async () => {
    expect(readTlsServerName(await captureHello(undefined))).toBeUndefined();
  });
  it("answers undefined, never throws, for every prefix of a real hello and for garbage", async () => {
    const hello = await captureHello("api.openai.com");
    for (let length = 0; length < hello.length; length += 1) expect(() => readTlsServerName(hello.slice(0, length))).not.toThrow();
    for (let length = 0; length < hello.length - 1; length += 1) expect(readTlsServerName(hello.slice(0, length))).toBeUndefined();
    expect(readTlsServerName(new Uint8Array(0))).toBeUndefined();
    expect(readTlsServerName(text("GET / HTTP/1.1\r\nHost: api.openai.com\r\n\r\n"))).toBeUndefined();
    expect(readTlsServerName(new Uint8Array(MODEL_HOST_READ_MAX_BYTES).fill(0x16))).toBeUndefined();
  });
  it("refuses a server name that is not a plain DNS name (an address, a space, a non-ASCII byte, an oversized label list)", async () => {
    for (const bad of ["127.0.0.1", "[::1]"]) expect(readTlsServerName(await captureHello(bad))).toBeUndefined();
    const hello = await captureHello("abcdefghijk.example.com");
    // Overwrite one byte of the name with a space, then with 0xff.
    const at = Buffer.from(hello).indexOf("abcdefghijk.example.com");
    expect(at).toBeGreaterThan(0);
    const spaced = new Uint8Array(hello);
    spaced[at + 3] = 0x20;
    expect(readTlsServerName(spaced)).toBeUndefined();
    const high = new Uint8Array(hello);
    high[at + 3] = 0xff;
    expect(readTlsServerName(high)).toBeUndefined();
  });
});

describe("readHttpHost", () => {
  it("reads the Host header, lower-cased, with a port or a trailing dot removed", () => {
    expect(readHttpHost(text("POST /v1beta/models/x:generateContent HTTP/1.1\r\nHost: Generativelanguage.googleapis.com\r\nContent-Length: 2\r\n\r\n{}"))).toBe("generativelanguage.googleapis.com");
    expect(readHttpHost(text("GET / HTTP/1.1\r\nhost: api.openai.com:80\r\n\r\n"))).toBe("api.openai.com");
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: api.openai.com.\r\n\r\n"))).toBe("api.openai.com");
  });
  it("answers undefined for no host, two different hosts, an address, a bracketed address, a bad name, or a header that is not finished", () => {
    expect(readHttpHost(text("GET / HTTP/1.1\r\nAccept: */*\r\n\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: a.example.com\r\nHost: b.example.com\r\n\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: [::1]:80\r\n\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: a b.example.com\r\n\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nHost: api.openai.com"))).toBeUndefined();
    expect(readHttpHost(new Uint8Array(0))).toBeUndefined();
  });
  it("does not read a Host header out of the body or out of a header line that only contains the word", () => {
    expect(readHttpHost(text("POST / HTTP/1.1\r\nContent-Length: 40\r\n\r\nHost: api.openai.com\r\n"))).toBeUndefined();
    expect(readHttpHost(text("GET / HTTP/1.1\r\nX-Not-Host: api.openai.com\r\n\r\n"))).toBeUndefined();
  });
});

describe("MODEL_HOST_RECORDER (the port the helper loop calls)", () => {
  it("reads a name on 443 and on 80, and answers undefined host for bytes it cannot read", async () => {
    expect(MODEL_HOST_RECORDER.observe({ port: 443, firstBytes: await captureHello("api.openai.com") })).toEqual({ host: "api.openai.com" });
    expect(MODEL_HOST_RECORDER.observe({ port: 80, firstBytes: text("GET / HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n") })).toEqual({ host: "api.anthropic.com" });
    expect(MODEL_HOST_RECORDER.observe({ port: 443, firstBytes: text("hello") })).toEqual({ host: undefined });
    expect(MODEL_HOST_RECORDER.observe({ port: 80, firstBytes: new Uint8Array(0) })).toEqual({ host: undefined });
  });
});

async function startRecorder(options: Partial<ConstructorParameters<typeof ModelHostRecorder>[0]> = {}) {
  const recorder = new ModelHostRecorder({ listenAddress: "127.0.0.1", allowedSources: ["127.0.0.1"], tlsPort: 0, httpPort: 0, readTimeoutMs: 400, ...options });
  recorders.push(recorder);
  const ports = await recorder.start();
  return { recorder, ports };
}

/** Connects, sends `bytes`, and answers everything the server wrote back plus how the connection ended. */
async function talk(port: number, bytes: Uint8Array | undefined): Promise<{ received: Buffer; ended: "closed" | "reset" | "timeout" }> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const done = (ended: "closed" | "reset" | "timeout"): void => { socket.destroy(); resolve({ received: Buffer.concat(chunks), ended }); };
    socket.on("connect", () => { if (bytes !== undefined) socket.write(bytes); });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => done("closed"));
    socket.on("error", (error) => done((error as { code?: string }).code === "ECONNRESET" ? "reset" : "closed"));
    setTimeout(() => done("timeout"), 3_000);
  });
}

describe("ModelHostRecorder: real sockets on loopback", () => {
  it("records the name of a TLS client and a plain HTTP client, answers nothing, and closes", async () => {
    const tripwire = installNetworkTripwire();
    try {
      const { recorder, ports } = await startRecorder();
      const hello = await captureHello("generativelanguage.googleapis.com");
      const tlsResult = await talk(ports.tls, hello);
      const httpResult = await talk(ports.http, text("POST /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\nContent-Length: 0\r\n\r\n"));
      expect(tlsResult.received.length).toBe(0);
      expect(httpResult.received.length).toBe(0);
      expect(tlsResult.ended).not.toBe("timeout");
      expect(httpResult.ended).not.toBe("timeout");
      const snapshot = recorder.snapshot();
      expect(snapshot.hosts).toEqual(["api.openai.com", "generativelanguage.googleapis.com"]);
      expect(snapshot.connections).toBe(2);
      expect(snapshot.unreadable).toBe(0);
    } finally {
      tripwire.restore();
    }
    expect(tripwire.attempts).toEqual([]);
  });
  it("counts a connection whose name cannot be read as unreadable (still an escape), and one that sends nothing", async () => {
    const { recorder, ports } = await startRecorder();
    await talk(ports.tls, text("not a hello at all"));
    await talk(ports.http, text("GET / HTTP/1.1\r\n\r\n"));
    await talk(ports.http, undefined);
    const snapshot = recorder.snapshot();
    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.connections).toBe(3);
    expect(snapshot.unreadable).toBe(3);
  });
  it("never answers a real TLS handshake: a client sees its handshake fail", async () => {
    const { recorder, ports } = await startRecorder();
    const outcome = await new Promise<string>((resolve) => {
      const client = tls.connect({ host: "127.0.0.1", port: ports.tls, servername: "api.openai.com" });
      client.on("secureConnect", () => { client.destroy(); resolve("connected"); });
      client.on("error", () => resolve("failed"));
      client.on("close", () => resolve("failed"));
    });
    expect(outcome).toBe("failed");
    expect(recorder.snapshot().hosts).toEqual(["api.openai.com"]);
  });
  it("ignores a source that is not allowed: nothing is read, nothing is recorded, the connection is closed", async () => {
    const { recorder, ports } = await startRecorder({ allowedSources: ["172.30.9.3"] });
    const result = await talk(ports.http, text("GET / HTTP/1.1\r\nHost: api.openai.com\r\n\r\n"));
    expect(result.received.length).toBe(0);
    const snapshot = recorder.snapshot();
    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.connections).toBe(0);
    expect(snapshot.refusedSources).toBe(1);
  });
  it("reads at most 16 KiB and stops: a client that sends more is closed, unreadable", async () => {
    const { recorder, ports } = await startRecorder();
    const result = await talk(ports.http, text(`GET / HTTP/1.1\r\nX-Fill: ${"a".repeat(MODEL_HOST_READ_MAX_BYTES + 100)}\r\nHost: api.openai.com\r\n\r\n`));
    expect(result.ended).not.toBe("timeout");
    expect(recorder.snapshot().hosts).toEqual([]);
    expect(recorder.snapshot().unreadable).toBe(1);
  });
  it("stops reading at 16 KiB without waiting for the read timeout, even when the request head never ends", async () => {
    const { recorder, ports } = await startRecorder({ readTimeoutMs: 5_000 });
    const started = Date.now();
    const result = await talk(ports.http, text("a".repeat(MODEL_HOST_READ_MAX_BYTES + 100)));
    expect(result.ended).not.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(recorder.snapshot().unreadable).toBe(1);
  });
  it("keeps at most `maxHosts` distinct names and counts the rest as overflow", async () => {
    const { recorder, ports } = await startRecorder({ maxHosts: 2 });
    for (const host of ["a.example.com", "b.example.com", "c.example.com", "a.example.com"]) await talk(ports.http, text(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    const snapshot = recorder.snapshot();
    expect(snapshot.hosts).toEqual(["a.example.com", "b.example.com"]);
    expect(snapshot.overflow).toBe(1);
  });
  it("calls the onRecord callback with the name and the port, once per connection", async () => {
    const seen: Array<{ host: string | undefined; port: number }> = [];
    const { ports } = await startRecorder({ onRecord: (entry) => { seen.push(entry); } });
    await talk(ports.http, text("GET / HTTP/1.1\r\nHost: api.openai.com\r\n\r\n"));
    await talk(ports.tls, await captureHello("openrouter.ai"));
    expect(seen).toEqual([{ host: "api.openai.com", port: 80 }, { host: "openrouter.ai", port: 443 }]);
  });
  it("refuses a listen address that is not one IPv4 address, and a wildcard", () => {
    for (const bad of ["0.0.0.0", "::", "localhost", "api.openai.com", ""]) expect(() => new ModelHostRecorder({ listenAddress: bad, allowedSources: ["127.0.0.1"] })).toThrow();
    expect(() => new ModelHostRecorder({ listenAddress: "127.0.0.1", allowedSources: [] })).toThrow();
    expect(() => new ModelHostRecorder({ listenAddress: "127.0.0.1", allowedSources: ["not-an-address"] })).toThrow();
  });
});
