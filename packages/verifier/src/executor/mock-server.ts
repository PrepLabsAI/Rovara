import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  status: number; requestSha256: string; responseSha256: string; observedAt: string }>;

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
  /** Test seams. */
  maxLines?: number;
  now?: () => Date;
  /** Called once when the ledger cannot be written; the server has already stopped answering. The entry point exits the process. */
  onFatal?: (error: unknown) => void;
}>;

export type RunningMockServer = Readonly<{ server: Server; port: number; close(): Promise<void> }>;

/** Starts the server. The ledger is opened for appending first, so a ledger that cannot be written never serves a request. */
export async function startMockServer(options: MockServerOptions): Promise<RunningMockServer> {
  const fixture = options.fixture === null ? null : parseMockFixture(options.fixture);
  const maxLines = options.maxLines ?? MOCK_LEDGER_MAX_LINES;
  const now = options.now ?? (() => new Date());
  const fd = openSync(options.ledgerPath, "a", 0o644);
  let lines = 0;
  let overflowed = false;
  let failed = false;

  const append = (line: MockLedgerLine): void => { writeSync(fd, `${JSON.stringify(line)}\n`); lines += 1; };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // The body is never read; it is drained so the connection ends, and the answer closes the connection.
    request.resume();
    if (failed) { response.destroy(); return; }
    const method = clip(String(request.method ?? ""), MAX_METHOD_CHARS);
    const rawUrl = String(request.url ?? "");
    const originForm = rawUrl.startsWith("/") && !rawUrl.startsWith("//");
    const queryStart = rawUrl.indexOf("?");
    const rawPath = !originForm ? "" : queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const query = !originForm || queryStart === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(queryStart + 1));
    const values = fixture === null ? [] : query.getAll(fixture.inputField);
    const input = values.length === 1 ? values[0]! : null;
    const variant = fixture !== null && originForm && request.method === fixture.method && rawPath === fixture.path && input !== null
      ? fixture.variants.find((candidate) => candidate.inputValue === input) ?? null : null;

    const recorded = { method, path: clip(rawPath, MAX_PATH_CHARS), inputValue: input === null ? null : clip(input, MAX_INPUT_CHARS) };
    // At the ledger bound the last slot records the overflow as an unmatched call, and nothing is answered from the fixture any more: a flood is never silent.
    const full = lines >= maxLines - 1;
    const answer = !full && variant !== null ? { status: variant.status, body: (variant.body ?? null) as unknown, text: JSON.stringify(variant.body ?? null) }
      : { status: MOCK_UNMOCKED_STATUS, body: { error: "rovara-unmocked" } as unknown, text: MOCK_UNMOCKED_BODY };
    try {
      if (!full || !overflowed) {
        append({ requestId: `req-${randomUUID()}`, ...recorded, variantId: !full && variant !== null ? variant.id : null, status: answer.status,
          requestSha256: mockRequestDigest(recorded), responseSha256: mockResponseDigest(answer), observedAt: now().toISOString() });
        if (full) overflowed = true;
      }
    } catch (error) {
      failed = true;
      response.destroy();
      server.close();
      options.onFatal?.(error);
      return;
    }
    response.writeHead(answer.status, { "content-type": "application/json", "content-length": Buffer.byteLength(answer.text), connection: "close" });
    response.end(answer.text);
  };

  const server = createServer(handle);
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server has no listening port");
  return Object.freeze({ server, port: address.port, close: () => new Promise<void>((resolve) => {
    server.close(() => { try { closeSync(fd); } catch { /* already closed */ } resolve(); });
    server.closeAllConnections();
  }) });
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

/** The entry point's mock mode: reads the approved fixture (if any), serves on 8080 and records to `/out/mock/<ref>.jsonl` until stopped. */
export async function runMockMode(argv: readonly string[], dependencies: { ledgerDirectory?: string; host?: string; port?: number } = {}): Promise<RunningMockServer> {
  const { fixturePath, origin } = parseMockModeArguments(argv);
  const fixture = fixturePath === null ? null : parseMockFixture(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(fixturePath))));
  return startMockServer({ fixture, ledgerPath: `${dependencies.ledgerDirectory ?? "/out/mock"}/${origin}.jsonl`,
    ...(dependencies.host === undefined ? {} : { host: dependencies.host }), ...(dependencies.port === undefined ? {} : { port: dependencies.port }),
    onFatal: (error) => { process.stderr.write(`mock ledger cannot be written: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(2); } });
}
