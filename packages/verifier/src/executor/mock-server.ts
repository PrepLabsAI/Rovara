import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { E2EApiMockFixture } from "@rovara-code/contracts";
import { CORE_LEDGER_MAX_LINES, clip, startCore, type CoreAnswer, type CoreStrategy, type RunningCore } from "../service-mocks/fake-core.js";

// This file imports no package: it runs in a container with a 128 MiB limit and half a CPU, where loading the contracts barrel takes ten seconds and most of that memory. It
// holds its own copy of the two small things it would take from there (canonical JSON, and the check of a fixture's shape); the tests compare both with the contracts' own.
// Test services TS23: the sockets, the limits and the request ledger are the shared fake core's (`service-mocks/fake-core.ts`, equally package-free); what is left here is what THIS mock
// answers (the E2E checker's GET variants) and the sinkhole's resolver. The same fixture served as a FixtureSet v2 by the fake server answers the same variants (a test holds the two together).

/**
 * The in-network mock of one approved external origin, and the sinkhole every other declared origin points at. Both run from the executor image
 * (`node entry.js --mock [/mock/fixture.json] --origin <ref>`) on the run's `--internal` network only. The mock serves exactly the approved fixture's method and path and
 * picks the variant whose `inputValue` equals the query parameter named by `inputField`. Anything else, and every call to the sinkhole (which has no fixture), is answered
 * 599 and recorded as a call no approved mock matched. Every request is written to the ledger before it is answered, so no answer can be seen without its record.
 */
export const MOCK_LEDGER_MAX_LINES = CORE_LEDGER_MAX_LINES;
export const MOCK_UNMOCKED_STATUS = 599;
export const MOCK_UNMOCKED_BODY = '{"error":"rovara-unmocked"}';
const MAX_PATH_CHARS = 512;
const MAX_METHOD_CHARS = 16;
const MAX_INPUT_CHARS = 128;
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

export type RunningMockServer = RunningCore;

const UNMOCKED_ANSWER = { status: MOCK_UNMOCKED_STATUS, contentType: "application/json", text: MOCK_UNMOCKED_BODY, headers: { connection: "close" } } as const;

/** The one query parameter the fixture selects by, only when it is given once: an extra parameter is a request the approved fixture does not describe. */
function describeQuery(fixture: E2EApiMockFixture | null, rawQuery: string): { input: string | null; alone: boolean } {
  const query = new URLSearchParams(rawQuery);
  const values = fixture === null ? [] : query.getAll(fixture.inputField);
  const input = values.length === 1 ? values[0]! : null;
  return { input, alone: input !== null && [...query.keys()].length === 1 };
}

/**
 * What the E2E checker's mock answers (the first strategy of the shared fake core, `service-mocks/fake-core.ts`): the fixture's method and path, and the variant whose `inputValue` equals the one query
 * parameter. The ledger line keeps its own shape (`inputValue`, `variantId`, and the two content hashes) because the host reads it back against the approved fixture.
 */
function e2eStrategy(fixture: E2EApiMockFixture | null): CoreStrategy {
  const unmatchedLine = (call: { method: string; rawPath: string; input: string | null }): CoreAnswer => {
    const recorded = { method: clip(call.method, MAX_METHOD_CHARS), path: clip(call.rawPath, MAX_PATH_CHARS), inputValue: call.input === null ? null : clip(call.input, MAX_INPUT_CHARS) };
    return { ...UNMOCKED_ANSWER, ledger: { inputValue: recorded.inputValue, variantId: null, requestSha256: mockRequestDigest(recorded), responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST } };
  };
  return {
    maxBodyBytes: 0,
    decide(request, context) {
      const { input, alone } = describeQuery(fixture, request.rawQuery);
      // At the ledger bound nothing is answered from the fixture any more: a flood is never silent.
      const variant = !context.full && fixture !== null && request.originForm && request.method === fixture.method && request.rawPath === fixture.path && alone
        ? fixture.variants.find((candidate) => candidate.inputValue === input) ?? null : null;
      if (variant === null) return unmatchedLine({ method: request.method, rawPath: request.rawPath, input });
      const recorded = { method: clip(request.method, MAX_METHOD_CHARS), path: clip(request.rawPath, MAX_PATH_CHARS), inputValue: input === null ? null : clip(input, MAX_INPUT_CHARS) };
      return { status: variant.status, contentType: "application/json", text: JSON.stringify(variant.body ?? null), headers: { connection: "close" },
        ledger: { inputValue: recorded.inputValue, variantId: variant.id, requestSha256: mockRequestDigest(recorded), responseSha256: mockResponseDigest({ status: variant.status, body: variant.body ?? null }) } };
    },
    refuse(call) { return unmatchedLine({ method: call.method, rawPath: call.rawPath, input: describeQuery(fixture, call.rawQuery).input }); },
  };
}

/**
 * Starts the server. The ledger is opened for appending first, so a ledger that cannot be written never serves a request. Every connection ends up in the ledger: a parsed request as
 * the request it was, and anything that never becomes one (TLS, h2c, CONNECT, an Upgrade, a malformed or oversized request, a header timeout, a silent connection, a connection past the
 * cap) as a call no mock matched. Nothing here is ever a consumption unless it is a parsed, plain request that matches the fixture exactly. The sockets and the ledger are the shared core's.
 */
export async function startMockServer(options: MockServerOptions): Promise<RunningMockServer> {
  const fixture = options.fixture === null ? null : parseMockFixture(options.fixture);
  return startCore({
    strategy: e2eStrategy(fixture), ledgerPath: options.ledgerPath, host: options.host ?? "0.0.0.0", port: options.port ?? 8080,
    ...(options.additionalPorts === undefined ? {} : { additionalPorts: options.additionalPorts }),
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }), ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.connectionGraceMs === undefined ? {} : { connectionGraceMs: options.connectionGraceMs }), ...(options.connectionCeilingMs === undefined ? {} : { connectionCeilingMs: options.connectionCeilingMs }),
    ...(options.now === undefined ? {} : { now: options.now }), ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  });
}

/** The address of this container on its network: the one the sinkhole's resolver gives for every name. */
function ownAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return null;
}

/**
 * A resolver that answers every A query with the sinkhole's own address and every other query with an empty answer. The app is pointed at it, so a name that nothing in the run
 * serves (a hard-coded real host, an SDK's default endpoint) reaches the sinkhole and is recorded instead of failing to resolve in silence. The app's /etc/resolv.conf names this
 * resolver directly (Docker 25 would not forward to it from an internal-only container), so it is asked for every name; the run's own names (the mocks, the sinkhole, `app`) never
 * reach it because the host writes them into the app's hosts file.
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
