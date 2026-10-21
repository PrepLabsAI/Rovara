import { createHash, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { Socket } from "node:net";
import type { E2EApiMockFixture } from "@agentx/contracts";

// This file imports no package: it runs in a container with a 128 MiB limit and half a CPU, where loading the contracts barrel takes ten seconds and most of that memory. It
// holds its own copy of the two small things it would take from there (canonical JSON, and the check of a fixture's shape); the tests compare both with the contracts' own.

/**
 * The in-network mock of one approved external origin, and the sinkhole every other declared origin points at. Both run from the executor image
 * (`node entry.js --mock [/mock/fixture.json] --origin <ref>`) on the run's `--internal` network only. The mock serves exactly the approved fixture's method and path and
 * picks the variant whose `inputValue` equals the query parameter named by `inputField`. Anything else, and every call to the sinkhole (which has no fixture), is answered
 * 599 and recorded as a call no approved mock matched. Every request is written to the ledger before it is answered, so no answer can be seen without its record.
 */
export const MOCK_LEDGER_MAX_LINES = 2048;
export const MOCK_UNMOCKED_STATUS = 599;
export const MOCK_UNMOCKED_BODY = '{"error":"rovara-unmocked"}';
const MAX_PATH_CHARS = 512;
const MAX_METHOD_CHARS = 16;
const MAX_INPUT_CHARS = 128;
const MAX_CONNECTIONS = 64;
const SAFE_ORIGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;

/** One recorded request, exactly as it is appended to `/out/mock/<originRef>.jsonl`. */
export type MockLedgerLine = Readonly<{ requestId: string; method: string; path: string; inputValue: string | null; variantId: "success" | "refusal" | "invalid-data" | null;
  status: number; requestSha256: string; responseSha256: string; observedAt: string;
  /** The address the connection came from (an IPv4-mapped IPv6 address written as IPv4); the host accepts a consumption only from the application container's. */
  remoteAddress: string }>;

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** What the ledger's `requestSha256` covers; the host recomputes it from the line's own fields. */
export const mockRequestDigest = (request: { method: string; path: string; inputValue: string | null }): string =>
  sha(canonicalJson({ method: request.method, path: request.path, inputValue: request.inputValue }));
/** What the ledger's `responseSha256` covers; the host recomputes it from the approved fixture's variant (or the fixed 599 answer). */
export const mockResponseDigest = (response: { status: number; body: unknown }): string => sha(canonicalJson({ status: response.status, body: response.body }));
export const MOCK_UNMOCKED_RESPONSE_DIGEST = mockResponseDigest({ status: MOCK_UNMOCKED_STATUS, body: { error: "rovara-unmocked" } });

const clip = (value: string, max: number) => (value.length <= max ? value : value.slice(0, max));

/** JSON text with the keys of every object in alphabetical order, as `canonicalJson` in the contracts writes it. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}
function canonicalJson(value: unknown): string { return JSON.stringify(sortKeys(value)); }

const VARIANT_IDS = ["success", "refusal", "invalid-data"];
/** The same shape the contracts' `E2EApiMockFixtureSchema` accepts: nothing more, nothing less. */
export function parseMockFixture(value: unknown): E2EApiMockFixture {
  const fail = (): never => { throw new Error("mock fixture is not a source-backed API fixture"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const fixture = value as Record<string, unknown>;
  if (Object.keys(fixture).sort().join(",") !== "inputField,method,operationId,path,schemaVersion,variants") return fail();
  if (fixture.schemaVersion !== "source-backed-api-fixtures/v1" || fixture.method !== "GET" || typeof fixture.operationId !== "string" || fixture.operationId.length < 1 || fixture.operationId.length > 120) return fail();
  if (typeof fixture.path !== "string" || !/^\/[A-Za-z0-9._~/-]{1,511}$/.test(fixture.path) || fixture.path.includes("..") || fixture.path.includes("//")) return fail();
  if (typeof fixture.inputField !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(fixture.inputField)) return fail();
  const variants = fixture.variants;
  if (!Array.isArray(variants) || variants.length !== 3) return fail();
  for (const variant of variants as Record<string, unknown>[]) {
    if (typeof variant !== "object" || variant === null || Array.isArray(variant)) return fail();
    if (Object.keys(variant).sort().join(",") !== "body,id,inputValue,status") return fail();
    if (!VARIANT_IDS.includes(variant.id as string) || typeof variant.inputValue !== "string" || variant.inputValue.length > 128
      || !Number.isInteger(variant.status) || (variant.status as number) < 100 || (variant.status as number) > 599) return fail();
  }
  const rows = variants as { id: string; inputValue: string }[];
  if (new Set(rows.map((item) => item.id)).size !== 3 || new Set(rows.map((item) => item.inputValue)).size !== 3) return fail();
  return value as E2EApiMockFixture;
}

export type MockServerOptions = Readonly<{
  /** The approved fixture; null makes the sinkhole. */
  fixture: E2EApiMockFixture | null;
  ledgerPath: string;
  host?: string;
  port?: number;
  /** More ports the same server listens on (the sinkhole answers on 80 and 443 as well, since a name that resolves to it may be asked on either). */
  additionalPorts?: readonly number[];
  /** Test seams. */
  maxLines?: number;
  maxConnections?: number;
  /** How long a connection may stay quiet (no byte received) without a parsed request before it is recorded as one. */
  connectionGraceMs?: number;
  /** The longest a connection may stay open without having become a request before it is recorded, however steadily it sends; default three times the grace. */
  connectionCeilingMs?: number;
  now?: () => Date;
  /** Called once when the ledger cannot be written; the server has already stopped answering. The entry point exits the process. */
  onFatal?: (error: unknown) => void;
}>;

export type RunningMockServer = Readonly<{ server: Server; servers: readonly Server[]; port: number; ports: readonly number[]; close(): Promise<void> }>;

/**
 * How long a connection may be quiet, without having become a request, before it is recorded as an unparsed call (and, at three times this, however much it sends).
 * A connection is also recorded when it closes. The host stops a mock with `docker kill` before it reads the ledger, so the one gap is a connection still open and unparsed at
 * that moment: it is within 1 s of its last byte and 3 s of its opening, so only a connection the app opened in the last seconds before the executor finished can be lost, and it never
 * parsed as a request, so it was never answered.
 */
const CONNECTION_GRACE_MS = 1_000;
type SocketState = { parsed: boolean; recorded: boolean };
/** The address a connection came from, as the host compares it with the application container's. */
const addressOf = (raw: string | undefined): string => clip(raw === undefined ? "unknown" : raw.startsWith("::ffff:") ? raw.slice(7) : raw, 64);

/**
 * Starts the server. The ledger is opened for appending first, so a ledger that cannot be written never serves a request. Every connection ends up in the ledger: a parsed request as
 * the request it was, and anything that never becomes one (TLS, h2c, CONNECT, an Upgrade, a malformed or oversized request, a header timeout, a silent connection, a connection past the
 * cap) as a call no mock matched. Nothing here is ever a consumption unless it is a parsed, plain request that matches the fixture exactly.
 */
export async function startMockServer(options: MockServerOptions): Promise<RunningMockServer> {
  const fixture = options.fixture === null ? null : parseMockFixture(options.fixture);
  const maxLines = options.maxLines ?? MOCK_LEDGER_MAX_LINES;
  const grace = options.connectionGraceMs ?? CONNECTION_GRACE_MS;
  const ceilingMs = options.connectionCeilingMs ?? grace * 3;
  const now = options.now ?? (() => new Date());
  const fd = openSync(options.ledgerPath, "a", 0o644);
  let lines = 0;
  let overflowed = false;
  let failed = false;
  const servers: Server[] = [];
  const states = new WeakMap<Socket, SocketState>();

  const stop = (error: unknown): void => {
    if (failed) return;
    failed = true;
    for (const server of servers) server.close();
    options.onFatal?.(error);
  };
  /** Writes one line and returns what to answer; null when the ledger could not be written (the server has then stopped). */
  const record = (input: { method: string; rawPath: string; inputValue: string | null; variant: NonNullable<typeof fixture>["variants"][number] | null; remote: string | undefined }) => {
    const recorded = { method: clip(input.method, MAX_METHOD_CHARS), path: clip(input.rawPath, MAX_PATH_CHARS), inputValue: input.inputValue === null ? null : clip(input.inputValue, MAX_INPUT_CHARS) };
    // At the ledger bound the last slot records the overflow as an unmatched call, and nothing is answered from the fixture any more: a flood is never silent.
    const full = lines >= maxLines - 1;
    const served = !full && input.variant !== null ? input.variant : null;
    const answer = served !== null ? { status: served.status, body: (served.body ?? null) as unknown, text: JSON.stringify(served.body ?? null) }
      : { status: MOCK_UNMOCKED_STATUS, body: { error: "rovara-unmocked" } as unknown, text: MOCK_UNMOCKED_BODY };
    try {
      if (!full || !overflowed) {
        const line: MockLedgerLine = { requestId: `req-${randomUUID()}`, ...recorded, variantId: served === null ? null : served.id, status: answer.status,
          requestSha256: mockRequestDigest(recorded), responseSha256: mockResponseDigest(answer), observedAt: now().toISOString(), remoteAddress: addressOf(input.remote) };
        writeSync(fd, `${JSON.stringify(line)}\n`);
        lines += 1;
        if (full) overflowed = true;
      }
    } catch (error) { stop(error); return null; }
    return answer;
  };
  /** What a request is: its method, its raw path (no decoding, no normalising), and the value of the one query parameter the fixture selects by, only when that is the only parameter. */
  const describe = (request: IncomingMessage) => {
    const rawUrl = String(request.url ?? "");
    const originForm = rawUrl.startsWith("/") && !rawUrl.startsWith("//");
    const queryStart = rawUrl.indexOf("?");
    const rawPath = !originForm ? clip(rawUrl, MAX_PATH_CHARS) : queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const query = !originForm || queryStart === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(queryStart + 1));
    const values = fixture === null ? [] : query.getAll(fixture.inputField);
    // The input is the one selecting parameter given once and alone: an extra parameter is a request the approved fixture does not describe.
    const input = values.length === 1 ? values[0]! : null;
    const alone = input !== null && [...query.keys()].length === 1;
    return { method: String(request.method ?? ""), rawPath, originForm, input, alone };
  };
  const unparsed = (socket: Socket, method: string, force = false): void => {
    const state = states.get(socket);
    if (state !== undefined && (state.recorded || (state.parsed && !force))) return;
    if (state !== undefined) state.recorded = true;
    record({ method, rawPath: "/", inputValue: null, variant: null, remote: socket.remoteAddress });
  };

  const build = (): Server => {
    const server = createServer((request, response) => {
      // The body is never read; it is drained so the connection ends, and the answer closes the connection.
      request.resume();
      const state = states.get(request.socket);
      if (state !== undefined) state.parsed = true;
      if (failed) { response.destroy(); return; }
      const call = describe(request);
      const variant = fixture !== null && call.originForm && call.method === fixture.method && call.rawPath === fixture.path && call.alone
        ? fixture.variants.find((candidate) => candidate.inputValue === call.input) ?? null : null;
      const answer = record({ method: call.method, rawPath: call.rawPath, inputValue: call.input, variant, remote: request.socket.remoteAddress });
      if (answer === null) { response.destroy(); return; }
      response.writeHead(answer.status, { "content-type": "application/json", "content-length": Buffer.byteLength(answer.text), connection: "close" });
      response.end(answer.text);
    });
    server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 64;
    server.on("connection", (socket: Socket) => {
      states.set(socket, { parsed: false, recorded: false });
      // The connection is a call that never became a request when it has been quiet for the grace after its last byte, or has been open for the ceiling whatever it sends.
      // The check is made after the loop has read what is waiting: a stall that outlasts the timer must not turn a request already in the socket into an unparsed call.
      const fire = (): void => { setImmediate(() => unparsed(socket, "UNPARSED")); };
      const quiet = setTimeout(fire, grace);
      const ceiling = setTimeout(fire, ceilingMs);
      quiet.unref(); ceiling.unref();
      socket.on("data", () => { quiet.refresh(); });
      socket.once("close", () => { clearTimeout(quiet); clearTimeout(ceiling); unparsed(socket, "UNPARSED"); });
      socket.on("error", () => undefined);
    });
    // Anything the HTTP parser refuses (TLS, h2c, a malformed or oversized request) is a call, not a silence.
    server.on("clientError", (_error: Error, socket: Socket) => {
      unparsed(socket, "UNPARSED", true);
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else socket.destroy();
    });
    // CONNECT and Upgrade are never answered from the fixture, however well the rest of the request matches it.
    const refuse = (request: IncomingMessage, socket: Socket): void => {
      const state = states.get(socket);
      if (state !== undefined) state.parsed = true;
      const call = describe(request);
      record({ method: call.method, rawPath: call.rawPath, inputValue: call.input, variant: null, remote: socket.remoteAddress });
      if (socket.writable) socket.end(`HTTP/1.1 ${MOCK_UNMOCKED_STATUS} Unmocked\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(MOCK_UNMOCKED_BODY)}\r\nconnection: close\r\n\r\n${MOCK_UNMOCKED_BODY}`);
      else socket.destroy();
    };
    server.on("connect", refuse);
    server.on("upgrade", refuse);
    // A connection past the cap is dropped by the server; the drop is recorded.
    server.on("drop", (data?: { remoteAddress?: string }) => {
      record({ method: "DROPPED", rawPath: "/", inputValue: null, variant: null, remote: data?.remoteAddress });
    });
    servers.push(server);
    return server;
  };

  const ports = [options.port ?? 8080, ...(options.additionalPorts ?? [])];
  const listening: number[] = [];
  try {
    for (const port of ports) {
      const server = build();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, options.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("mock server has no listening port");
      listening.push(address.port);
    }
  } catch (error) {
    for (const server of servers) server.close();
    try { closeSync(fd); } catch { /* already closed */ }
    throw error;
  }
  return Object.freeze({ server: servers[0]!, servers: Object.freeze([...servers]), port: listening[0]!, ports: Object.freeze(listening), close: async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    try { closeSync(fd); } catch { /* already closed */ }
  } });
}

/** The address of this container on its network: the one the sinkhole's resolver gives for every name. */
function ownAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return null;
}

/**
 * A resolver that answers every A query with the sinkhole's own address and every other query with an empty answer. The app is pointed at it, so a name that nothing in the run
 * serves (a hard-coded real host, an SDK's default endpoint) reaches the sinkhole and is recorded instead of failing to resolve in silence. Docker's own resolver still answers
 * for the run's containers first; this one is asked only for the rest.
 */
export function startSinkholeDns(options: { host?: string; port?: number; address: () => string | null }): Promise<{ port: number; close(): Promise<void> }> {
  const socket = createSocket("udp4");
  socket.on("message", (query, remote) => {
    const reply = dnsAnswer(query, options.address());
    if (reply !== null) socket.send(reply, remote.port, remote.address);
  });
  socket.on("error", () => undefined);
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(options.port ?? 53, options.host ?? "0.0.0.0", () => {
      socket.off("error", reject);
      resolve({ port: socket.address().port, close: () => new Promise<void>((done) => { socket.close(() => done()); }) });
    });
  });
}
/** The reply to one single-question query, or null for a packet that is not one. */
export function dnsAnswer(query: Buffer, address: string | null): Buffer | null {
  if (query.length < 17 || query.length > 512) return null;
  const flags = query.readUInt16BE(2);
  if ((flags & 0x8000) !== 0 || ((flags >> 11) & 0xf) !== 0 || query.readUInt16BE(4) !== 1) return null;
  let offset = 12;
  for (;;) {
    const length = query[offset];
    if (length === undefined) return null;
    if (length === 0) { offset += 1; break; }
    if (length > 63) return null;
    offset += 1 + length;
  }
  if (offset + 4 > query.length) return null;
  const type = query.readUInt16BE(offset); const questionClass = query.readUInt16BE(offset + 2);
  const octets = address === null ? [] : address.split(".").map(Number);
  const answerA = type === 1 && questionClass === 1 && octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(answerA ? 1 : 0, 6);
  const answer = answerA ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, ...octets]) : Buffer.alloc(0);
  return Buffer.concat([header, query.subarray(12, offset + 4), answer]);
}

/** `--mock [fixture] --origin <ref>`: the fixture path is absent for the sinkhole; the origin names the ledger file. */
export function parseMockModeArguments(argv: readonly string[]): { fixturePath: string | null; origin: string } {
  if (argv[0] !== "--mock") throw new Error("mock mode starts with --mock");
  let index = 1;
  let fixturePath: string | null = null;
  if (argv[index] !== undefined && !argv[index]!.startsWith("--")) { fixturePath = argv[index]!; index += 1; }
  if (argv[index] !== "--origin" || argv[index + 1] === undefined || argv.length !== index + 2) throw new Error("mock mode takes exactly --origin <ref> after the fixture");
  const origin = argv[index + 1]!;
  if (!SAFE_ORIGIN.test(origin)) throw new Error("mock origin is not a plain identifier");
  if (fixturePath !== null && (!fixturePath.startsWith("/") || fixturePath.includes(".."))) throw new Error("mock fixture path must be absolute");
  return { fixturePath, origin };
}

/**
 * The entry point's mock mode: reads the approved fixture (if any), serves, and records to `/out/mock/<ref>.jsonl` until stopped. A mock serves on 8080. The sinkhole serves on 8080, 80 and
 * 443 and runs the resolver on 53. The host's readiness marker `<ref>.ready` is written last, once everything listens, so a call made as soon as the marker exists is never refused.
 */
export async function runMockMode(argv: readonly string[], dependencies: { ledgerDirectory?: string; host?: string; ports?: readonly number[]; dnsPort?: number | null } = {}): Promise<RunningMockServer> {
  const { fixturePath, origin } = parseMockModeArguments(argv);
  const fixture = fixturePath === null ? null : parseMockFixture(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(fixturePath))));
  const directory = dependencies.ledgerDirectory ?? "/out/mock";
  const ports = dependencies.ports ?? (fixture === null ? [8080, 80, 443] : [8080]);
  const dnsPort = dependencies.dnsPort === undefined ? (fixture === null ? 53 : null) : dependencies.dnsPort;
  const running = await startMockServer({ fixture, ledgerPath: `${directory}/${origin}.jsonl`, port: ports[0]!, additionalPorts: ports.slice(1),
    ...(dependencies.host === undefined ? {} : { host: dependencies.host }),
    onFatal: (error) => { process.stderr.write(`mock ledger cannot be written: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(2); } });
  let dns: Awaited<ReturnType<typeof startSinkholeDns>> | null = null;
  try {
    if (dnsPort !== null) dns = await startSinkholeDns({ port: dnsPort, ...(dependencies.host === undefined ? {} : { host: dependencies.host }), address: ownAddress });
    writeFileSync(`${directory}/${origin}.ready`, "ready\n", { mode: 0o644 });
  } catch (error) {
    await running.close();
    throw error;
  }
  return Object.freeze({ ...running, close: async () => { await dns?.close(); await running.close(); } });
}
