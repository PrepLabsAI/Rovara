// TE-F1b (M2, release 0.5.19; te-f1 design 3.2 and 3.4; DECISIONS 163b D3): the model helper's 443 and 80 RECORDER. Every model host is pointed at the helper by name (`--add-host`, model-helper-network.ts), so a client that
// ignores its base-URL variable connects to the helper on 443 (TLS) or 80 (plain HTTP). This module reads WHICH name the client asked for, records it, and closes the connection. It NEVER answers: no byte is written to
// the socket, so a client's handshake or request fails, and nothing is made up for it. The evidence then says "not run: client ignored the redirect (called <host>)" (F0a's `findRedirectEscapes`).
//
//   readTlsServerName(bytes)   the server name of a TLS ClientHello (the SNI extension), or undefined
//   readHttpHost(bytes)        the Host header of an HTTP request head, or undefined
//   MODEL_HOST_RECORDER        the two readers as the port the helper loop calls (`observe({ port, firstBytes })`; the shape TE-F2's `ModelHostRecorderPort` has)
//   ModelHostRecorder          the two listeners (the helper program's `--record-escapes`, and the fake helper of the Linux check): the sockets, the source filter, the bounds and the record
//
// What a name may be: one plain lower-case DNS name (letters, digits, hyphen, dot; at most 253 characters), never an address. Anything else is "unreadable", which is still an escape: the connection happened. The names are
// untrusted (customer code chose them); they are only repeated by `findRedirectEscapes` after its own strict check. Bounds: at most 16 KiB read per connection, 3 seconds, 256 distinct names kept (the rest counted).
// Only the sandbox addresses of the helper's network are read at all; any other source is closed without reading a byte.
import net from "node:net";
import { isIP } from "node:net";

/** The most bytes read from one connection (a ClientHello or a request head). */
export const MODEL_HOST_READ_MAX_BYTES = 16 * 1024;
/** How long one connection may take to send its first bytes. */
export const MODEL_HOST_READ_TIMEOUT_MS = 3_000;
/** The most distinct names kept; further new names are counted as `overflow`. */
export const MODEL_HOST_RECORDER_MAX_HOSTS = 256;
/** The most distinct names remembered ONLY to count each overflow name once; past this every further new name counts as one more overflow (memory stays bounded however many names a client invents). */
export const MODEL_HOST_RECORDER_MAX_OVERFLOW_TRACKED = 1024;
/** The most connections open at once; a further one is closed unread. */
const MAX_OPEN_CONNECTIONS = 64;
const HOST_MAX_CHARS = 253;
const PLAIN_NAME = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;

/** A name as one plain lower-case DNS name, or undefined (an address, a space, a non-ASCII byte, an empty label, too long). A trailing dot is removed. */
function plainName(raw: string): string | undefined {
  let name = raw.toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length === 0 || name.length > HOST_MAX_CHARS || isIP(name) !== 0) return undefined;
  return PLAIN_NAME.test(name) ? name : undefined;
}

/** Reads `length` bytes at `at`, or undefined when they are not all there. */
function slice(bytes: Uint8Array, at: number, length: number): Uint8Array | undefined {
  return Number.isInteger(at) && Number.isInteger(length) && at >= 0 && length >= 0 && at + length <= bytes.length ? bytes.subarray(at, at + length) : undefined;
}
const u8 = (bytes: Uint8Array, at: number): number | undefined => (at >= 0 && at < bytes.length ? bytes[at] : undefined);
const u16 = (bytes: Uint8Array, at: number): number | undefined => {
  const high = u8(bytes, at);
  const low = u8(bytes, at + 1);
  return high === undefined || low === undefined ? undefined : high * 256 + low;
};
const u24 = (bytes: Uint8Array, at: number): number | undefined => {
  const high = u8(bytes, at);
  const rest = u16(bytes, at + 1);
  return high === undefined || rest === undefined ? undefined : high * 65_536 + rest;
};

/**
 * The server name of a TLS ClientHello that fits in the first record, or undefined. Reads the record header, the handshake header, then skips the version, the random, the session id, the cipher suites and the compression
 * methods to the extensions, and takes the first host_name of the server_name extension. Every length is checked against what is there; any inconsistency is undefined. Never throws.
 */
export function readTlsServerName(bytes: Uint8Array): string | undefined {
  try {
    const view = bytes.length > MODEL_HOST_READ_MAX_BYTES ? bytes.subarray(0, MODEL_HOST_READ_MAX_BYTES) : bytes;
    // Record header: handshake (0x16), a 3.x version, the record's length.
    if (u8(view, 0) !== 0x16 || u8(view, 1) !== 0x03) return undefined;
    const recordLength = u16(view, 3);
    if (recordLength === undefined || recordLength < 42) return undefined;
    const record = slice(view, 5, recordLength);
    if (record === undefined) return undefined;
    // Handshake header: client_hello (0x01) and a 3-byte length that fits the record.
    if (u8(record, 0) !== 0x01) return undefined;
    const helloLength = u24(record, 1);
    if (helloLength === undefined || helloLength + 4 > record.length) return undefined;
    const hello = record.subarray(4, 4 + helloLength);
    // version (2), random (32), session id (1 + n), cipher suites (2 + n), compression methods (1 + n), extensions (2 + n).
    let at = 34;
    const sessionLength = u8(hello, at);
    if (sessionLength === undefined) return undefined;
    at += 1 + sessionLength;
    const suitesLength = u16(hello, at);
    if (suitesLength === undefined) return undefined;
    at += 2 + suitesLength;
    const compressionLength = u8(hello, at);
    if (compressionLength === undefined) return undefined;
    at += 1 + compressionLength;
    const extensionsLength = u16(hello, at);
    if (extensionsLength === undefined) return undefined;
    at += 2;
    const extensions = slice(hello, at, extensionsLength);
    if (extensions === undefined) return undefined;
    let position = 0;
    while (position + 4 <= extensions.length) {
      const type = u16(extensions, position);
      const length = u16(extensions, position + 2);
      if (type === undefined || length === undefined) return undefined;
      const data = slice(extensions, position + 4, length);
      if (data === undefined) return undefined;
      position += 4 + length;
      if (type !== 0) continue;
      // server_name_list: a list length, then (name type, name length, name).
      const listLength = u16(data, 0);
      if (listLength === undefined || listLength + 2 > data.length) return undefined;
      let entry = 2;
      while (entry + 3 <= 2 + listLength) {
        const nameType = u8(data, entry);
        const nameLength = u16(data, entry + 1);
        if (nameType === undefined || nameLength === undefined) return undefined;
        const name = slice(data, entry + 3, nameLength);
        if (name === undefined || entry + 3 + nameLength > 2 + listLength) return undefined;
        entry += 3 + nameLength;
        if (nameType !== 0) continue;
        // Only a plain ASCII name is a name: a byte over 0x7e or under 0x21 is not one.
        for (const byte of name) if (byte < 0x21 || byte > 0x7e) return undefined;
        return plainName(Buffer.from(name).toString("latin1"));
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Host header of an HTTP request head, or undefined. Only the head is read (up to the blank line; a head that is not finished is undefined, and so is a body that looks like a header). Exactly one Host header, once
 * its port (`:80`) and a trailing dot are removed, must be one plain name; an address, a bracketed address, a space or a second different Host header is undefined. Never throws.
 */
export function readHttpHost(bytes: Uint8Array): string | undefined {
  try {
    const view = bytes.length > MODEL_HOST_READ_MAX_BYTES ? bytes.subarray(0, MODEL_HOST_READ_MAX_BYTES) : bytes;
    const text = Buffer.from(view).toString("latin1");
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return undefined;
    const lines = text.slice(0, end).split("\r\n");
    const found = new Set<string>();
    let sawHost = false;
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0 || line.slice(0, colon).toLowerCase() !== "host") continue;
      sawHost = true;
      let value = line.slice(colon + 1).trim();
      if (value.startsWith("[")) return undefined;
      value = value.replace(/:[0-9]{1,5}$/u, "");
      const name = plainName(value);
      if (name === undefined) return undefined;
      found.add(name);
    }
    return sawHost && found.size === 1 ? [...found][0] : undefined;
  } catch {
    return undefined;
  }
}

/** True when the bytes are not a TLS handshake record at all (so nothing more is worth waiting for), or the first record is whole. */
function firstTlsRecordIsWhole(bytes: Uint8Array): boolean {
  if (bytes.length >= 1 && (u8(bytes, 0) !== 0x16)) return true;
  if (bytes.length >= 2 && u8(bytes, 1) !== 0x03) return true;
  const length = u16(bytes, 3);
  return length !== undefined && bytes.length >= 5 + length;
}

export const MODEL_ESCAPE_PORTS = [443, 80] as const;
export type ModelEscapePort = (typeof MODEL_ESCAPE_PORTS)[number];

/** The port the helper loop calls with the first bytes of a connection to 443 or 80. The same shape as TE-F2's `ModelHostRecorderPort`: a host as plain text, or `undefined` when no name could be read. */
export interface ModelHostObserver {
  observe(connection: { readonly port: ModelEscapePort; readonly firstBytes: Uint8Array }): { readonly host: string | undefined };
}

export const MODEL_HOST_RECORDER: ModelHostObserver = {
  observe: (connection) => ({ host: connection.port === 443 ? readTlsServerName(connection.firstBytes) : readHttpHost(connection.firstBytes) }),
};

export interface ModelHostRecord {
  /** The name, or undefined when none could be read. */
  readonly host: string | undefined;
  readonly port: number;
}

export interface ModelHostRecorderOptions {
  /** The helper's own address on its network (.9): a single IPv4 address, never a wildcard. */
  listenAddress: string;
  /** The only addresses read: the sandbox's address on the helper's network (.3 or .4). At least one. */
  allowedSources: readonly string[];
  /** Default 443. 0 picks a free port (a loopback address only: tests). */
  tlsPort?: number;
  /** Default 80. */
  httpPort?: number;
  readTimeoutMs?: number;
  maxHosts?: number;
  /** Called once per connection that was read (a name or not). A throw is ignored. */
  onRecord?: (record: ModelHostRecord) => void;
}

export interface ModelHostRecorderSnapshot {
  /** The distinct names seen, sorted. */
  readonly hosts: string[];
  /** Connections read (from an allowed source). */
  readonly connections: number;
  /** Connections whose name could not be read: still an escape. */
  readonly unreadable: number;
  /** Distinct names not kept because the list was full. */
  readonly overflow: number;
  /** Connections from a source that is not allowed: closed unread. */
  readonly refusedSources: number;
}

/** The two listeners. Writes nothing, ever. */
export class ModelHostRecorder {
  private readonly servers: net.Server[] = [];
  private readonly open = new Set<net.Socket>();
  private readonly hosts = new Set<string>();
  private connections = 0;
  private unreadable = 0;
  private overflow = 0;
  private refusedSources = 0;
  private readonly overflowed = new Set<string>();

  constructor(private readonly options: ModelHostRecorderOptions) {
    if (isIP(options.listenAddress) !== 4 || options.listenAddress === "0.0.0.0") throw new RangeError("the recorder listens on one IPv4 address");
    if (options.allowedSources.length === 0 || options.allowedSources.some((source) => isIP(source) !== 4)) throw new RangeError("the recorder serves IPv4 sandbox addresses");
  }

  /** Starts both listeners and answers the ports they have. */
  async start(): Promise<{ tls: number; http: number }> {
    const tlsPort = await this.listen(this.options.tlsPort ?? 443, 443);
    const httpPort = await this.listen(this.options.httpPort ?? 80, 80);
    return { tls: tlsPort, http: httpPort };
  }

  private listen(port: number, nominal: ModelEscapePort): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false }, (socket) => this.accept(socket, nominal));
      server.on("error", reject);
      server.listen(port, this.options.listenAddress, () => {
        server.off("error", reject);
        server.on("error", () => undefined);
        this.servers.push(server);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  private accept(socket: net.Socket, port: ModelEscapePort): void {
    socket.on("error", () => undefined);
    if (!this.options.allowedSources.includes(socket.remoteAddress ?? "")) {
      this.refusedSources += 1;
      socket.destroy();
      return;
    }
    if (this.open.size >= MAX_OPEN_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.open.add(socket);
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.open.delete(socket);
      const firstBytes = Buffer.concat(chunks, total);
      this.record(port, MODEL_HOST_RECORDER.observe({ port, firstBytes }).host);
      // Closed without a single byte written: a model request is never answered.
      socket.destroy();
    };
    const timer = setTimeout(finish, this.options.readTimeoutMs ?? MODEL_HOST_READ_TIMEOUT_MS);
    socket.on("close", () => { this.open.delete(socket); finish(); });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= MODEL_HOST_READ_MAX_BYTES) { finish(); return; }
      const soFar = Buffer.concat(chunks, total);
      // As soon as the first TLS record is whole, or the request head is finished, there is nothing more to wait for.
      if (port === 443 ? firstTlsRecordIsWhole(soFar) : soFar.includes("\r\n\r\n")) finish();
    });
  }

  /** Records one observation as a connection would (the sockets call this; so can a test or a helper loop that read the name itself). */
  record(port: ModelEscapePort, host: string | undefined): void {
    this.connections += 1;
    if (host === undefined) this.unreadable += 1;
    else if (this.hosts.has(host)) { /* counted as a connection only */ }
    else if (this.hosts.size < (this.options.maxHosts ?? MODEL_HOST_RECORDER_MAX_HOSTS)) this.hosts.add(host);
    else if (this.overflowed.has(host)) { /* counted once already */ }
    else {
      this.overflow += 1;
      if (this.overflowed.size < MODEL_HOST_RECORDER_MAX_OVERFLOW_TRACKED) this.overflowed.add(host);
    }
    try { this.options.onRecord?.({ host, port }); } catch { /* a callback that throws never stops the recorder */ }
  }

  /** How many names are held in memory (the kept list plus the names remembered to count an overflow once): never more than `maxHosts` plus `MODEL_HOST_RECORDER_MAX_OVERFLOW_TRACKED`. */
  trackedNames(): number {
    return this.hosts.size + this.overflowed.size;
  }

  snapshot(): ModelHostRecorderSnapshot {
    return { hosts: [...this.hosts].sort(), connections: this.connections, unreadable: this.unreadable, overflow: this.overflow, refusedSources: this.refusedSources };
  }

  async stop(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    await Promise.all(this.servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  }
}

// ---- the standalone program: the fake helper of the Linux check, and what `--record-escapes` of TE-F2's helper does in its own process

function argumentValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] !== `--${name}`) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.push(value);
  }
  return values;
}

/**
 * `node dist/model-helper-recorder.js --listen <ip> --source <ip> [--source <ip> ...] --state <file> [--tls-port <n>] [--http-port <n>]`: runs the two listeners and writes the snapshot (JSON: hosts, connections, unreadable,
 * overflow, refusedSources) beside the state file and renames it over, once a second and on exit, so a reader never sees half a file. It writes nothing to any socket. Only names and counts are in the file.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const single = (name: string): string => {
    const values = argumentValues(argv, name);
    if (values.length !== 1) throw new Error(`need exactly one --${name}`);
    return values[0]!;
  };
  const optionalPort = (name: string): number | undefined => {
    const values = argumentValues(argv, name);
    return values.length === 0 ? undefined : /^\d{1,5}$/u.test(values[0]!) ? Number(values[0]) : (() => { throw new Error(`--${name} is a port`); })();
  };
  const state = single("state");
  const tlsPort = optionalPort("tls-port");
  const httpPort = optionalPort("http-port");
  const recorder = new ModelHostRecorder({ listenAddress: single("listen"), allowedSources: argumentValues(argv, "source"), ...(tlsPort === undefined ? {} : { tlsPort }), ...(httpPort === undefined ? {} : { httpPort }) });
  await recorder.start();
  const { writeFileSync, renameSync } = await import("node:fs");
  let written = "";
  const flush = (): void => {
    const next = JSON.stringify(recorder.snapshot());
    if (next === written) return;
    written = next;
    writeFileSync(`${state}.tmp`, next);
    renameSync(`${state}.tmp`, state);
  };
  flush();
  const timer = setInterval(flush, 500);
  const end = (): void => { clearInterval(timer); flush(); void recorder.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("model-helper-recorder.js")) void main();
