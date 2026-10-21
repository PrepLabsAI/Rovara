import { createHash } from "node:crypto";
import { Resolver } from "node:dns";
import { existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2EApiMockFixtureSchema, canonicalJson, type E2EApiMockFixture } from "../../packages/contracts/src/index.js";
import { MOCK_LEDGER_MAX_LINES, MOCK_UNMOCKED_BODY, MOCK_UNMOCKED_STATUS, mockRequestDigest, mockResponseDigest, parseMockFixture, parseMockModeArguments, runMockMode, startMockServer, startSinkholeDns, type MockLedgerLine } from "../../packages/verifier/src/executor/mock-server.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture: E2EApiMockFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getStock", method: "GET", path: "/v1/stock", inputField: "orderId", variants: [
  { id: "success", inputValue: "a1", status: 200, body: { status: "in-stock" } },
  { id: "refusal", inputValue: "a2", status: 404, body: { error: "unknown order" } },
  { id: "invalid-data", inputValue: "b1", status: 200, body: { status: 7 } },
] };

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(options: { fixture?: E2EApiMockFixture | null; maxLines?: number; maxConnections?: number; connectionGraceMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mock-server-"));
  roots.push(dir);
  const ledgerPath = join(dir, "inventory-v1.jsonl");
  const server = await startMockServer({ fixture: options.fixture === undefined ? fixture : options.fixture, ledgerPath, host: "127.0.0.1", port: 0,
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }), ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.connectionGraceMs === undefined ? {} : { connectionGraceMs: options.connectionGraceMs }) });
  closers.push(server.close);
  const get = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") };
  };
  const lines = async (): Promise<MockLedgerLine[]> => (await readFile(ledgerPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as MockLedgerLine);
  return { server, get, lines, ledgerPath };
}

describe("the in-network mock server", () => {
  it("answers the success, refusal and invalid-data variant by the value of the fixture's input field", async () => {
    const mock = await start();
    expect(await mock.get("/v1/stock?orderId=a1")).toMatchObject({ status: 200, text: JSON.stringify({ status: "in-stock" }), contentType: "application/json" });
    expect(await mock.get("/v1/stock?orderId=a2")).toMatchObject({ status: 404, text: JSON.stringify({ error: "unknown order" }) });
    expect(await mock.get("/v1/stock?orderId=b1")).toMatchObject({ status: 200, text: JSON.stringify({ status: 7 }) });
    const lines = await mock.lines();
    expect(lines.map((line) => [line.method, line.path, line.inputValue, line.variantId, line.status])).toEqual([
      ["GET", "/v1/stock", "a1", "success", 200], ["GET", "/v1/stock", "a2", "refusal", 404], ["GET", "/v1/stock", "b1", "invalid-data", 200]]);
  });

  it("records one line per request with the exact fields, content hashes and unique request ids", async () => {
    const mock = await start();
    await mock.get("/v1/stock?orderId=a1");
    await mock.get("/v1/stock?orderId=a1");
    const lines = await mock.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(["inputValue", "method", "observedAt", "path", "remoteAddress", "requestId", "requestSha256", "responseSha256", "status", "variantId"]);
      expect(line.requestSha256).toBe(sha(canonicalJson({ method: "GET", path: "/v1/stock", inputValue: "a1" })));
      expect(line.responseSha256).toBe(sha(canonicalJson({ status: 200, body: { status: "in-stock" } })));
      expect(new Date(line.observedAt).toISOString()).toBe(line.observedAt);
      // Every line says who called: the address of the connection, which the host holds against the application container's.
      expect(line.remoteAddress).toBe("127.0.0.1");
    }
    expect(new Set(lines.map((line) => line.requestId)).size).toBe(2);
  });

  it.each([
    ["a wrong path", "/v1/other?orderId=a1", {}],
    ["a longer path", "/v1/stock/extra?orderId=a1", {}],
    ["an encoded path", "/v1/%73tock?orderId=a1", {}],
    ["a wrong method", "/v1/stock?orderId=a1", { method: "POST", body: "{}" }],
    ["a missing input field", "/v1/stock", {}],
    ["a differently named input field", "/v1/stock?order=a1", {}],
    ["an unknown input value", "/v1/stock?orderId=zz", {}],
    ["an input field given twice", "/v1/stock?orderId=a1&orderId=a2", {}],
    ["an extra query parameter", "/v1/stock?orderId=a1&debug=1", {}],
    ["an extra query parameter before the input field", "/v1/stock?debug=1&orderId=a1", {}],
    ["a differently cased input value", "/v1/stock?orderId=A1", {}],
  ])("answers %s with 599 and records it as an unmatched call", async (_label, path, init) => {
    const mock = await start();
    const answer = await mock.get(path, init);
    expect(answer.status).toBe(MOCK_UNMOCKED_STATUS);
    expect(answer.text).toBe(MOCK_UNMOCKED_BODY);
    expect(MOCK_UNMOCKED_BODY).toBe('{"error":"rovara-unmocked"}');
    const [line, ...rest] = await mock.lines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ variantId: null, status: 599 });
    expect(line!.responseSha256).toBe(sha(canonicalJson({ status: 599, body: { error: "rovara-unmocked" } })));
  });

  it("is a sinkhole without a fixture: everything is 599 and every call is recorded", async () => {
    const mock = await start({ fixture: null });
    expect((await mock.get("/v1/stock?orderId=a1")).status).toBe(599);
    expect((await mock.get("/")).status).toBe(599);
    expect((await mock.lines()).map((line) => [line.path, line.variantId, line.status])).toEqual([["/v1/stock", null, 599], ["/", null, 599]]);
  });

  it("bounds what it records per request, so a hostile caller cannot grow a line without limit", async () => {
    const mock = await start();
    await mock.get(`/${"x".repeat(4_000)}?orderId=${"y".repeat(3_000)}`);
    const [line] = await mock.lines();
    expect(line!.path.length).toBeLessThanOrEqual(512);
    expect((line!.inputValue ?? "").length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(line).length).toBeLessThan(2_048);
  });

  it("stops recording at the ledger bound and records the overflow itself as an unmatched call, so a flood is never silent", async () => {
    const mock = await start({ maxLines: 5 });
    for (let index = 0; index < 8; index += 1) await mock.get("/v1/stock?orderId=a1");
    const lines = await mock.lines();
    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 4).every((line) => line.variantId === "success")).toBe(true);
    expect(lines[4]).toMatchObject({ variantId: null, status: 599 });
    // After the bound even a call that would match is refused: the ledger no longer shows it.
    expect((await mock.get("/v1/stock?orderId=a1")).status).toBe(599);
    expect(await mock.lines()).toHaveLength(5);
    expect(MOCK_LEDGER_MAX_LINES).toBe(2048);
  });
});

describe("the mock server's own copies of what the contracts define", () => {
  const variants = fixture.variants;
  const cases: [string, unknown][] = [
    ["the approved fixture", fixture], ["a variant without a body member", { ...fixture, variants: [{ id: "success", inputValue: "a1", status: 200 }, variants[1], variants[2]] }],
    ["a variant with a null body", { ...fixture, variants: [{ ...variants[0], body: null }, variants[1], variants[2]] }],
    ["an unknown member", { ...fixture, extra: 1 }], ["a missing member", { ...fixture, inputField: undefined }], ["another schema version", { ...fixture, schemaVersion: "source-backed-api-fixtures/v2" }],
    ["a POST fixture", { ...fixture, method: "POST" }], ["a path with dot segments", { ...fixture, path: "/v1/../stock" }], ["a path with a double slash", { ...fixture, path: "/v1//stock" }],
    ["a relative path", { ...fixture, path: "v1/stock" }], ["an input field with a dash", { ...fixture, inputField: "order-id" }], ["two variants", { ...fixture, variants: variants.slice(0, 2) }],
    ["a repeated variant id", { ...fixture, variants: [variants[0], variants[0], variants[2]] }],
    ["a repeated input value", { ...fixture, variants: [variants[0], { ...variants[1], inputValue: "a1" }, variants[2]] }],
    ["a status of 99", { ...fixture, variants: [{ ...variants[0], status: 99 }, variants[1], variants[2]] }],
    ["a status of 600", { ...fixture, variants: [{ ...variants[0], status: 600 }, variants[1], variants[2]] }],
    ["a variant with an unknown member", { ...fixture, variants: [{ ...variants[0], note: "x" }, variants[1], variants[2]] }],
    ["an unknown variant id", { ...fixture, variants: [{ ...variants[0], id: "partial" }, variants[1], variants[2]] }],
    ["an array", []], ["null", null],
  ];
  it.each(cases)("accepts and refuses exactly what the contracts' fixture schema does: %s", (_label, value) => {
    const expected = E2EApiMockFixtureSchema.safeParse(value).success;
    let actual = true;
    try { parseMockFixture(value); } catch { actual = false; }
    expect(actual).toBe(expected);
  });

  it("writes the same canonical JSON as the contracts, for the hashes both sides compute", () => {
    const value = { b: [{ z: 1, a: { y: null, x: [3, { d: 1, c: 2 }] } }], a: "text", undefinedMember: undefined };
    expect(sha(JSON.stringify(sortedForTest(value)))).toBe(sha(canonicalJson(value)));
    expect(mockResponseDigest({ status: 200, body: value })).toBe(sha(canonicalJson({ status: 200, body: value })));
    expect(mockRequestDigest({ method: "GET", path: "/p", inputValue: null })).toBe(sha(canonicalJson({ method: "GET", path: "/p", inputValue: null })));
  });
});
const sortedForTest = (value: unknown): unknown => (Array.isArray(value) ? value.map(sortedForTest) : typeof value === "object" && value !== null
  ? Object.fromEntries(Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => [key, sortedForTest((value as Record<string, unknown>)[key])])) : value);

describe("the mock mode command line", () => {
  it("accepts `--mock <fixture> --origin <ref>` and a sinkhole without a fixture", () => {
    expect(parseMockModeArguments(["--mock", "/mock/fixture.json", "--origin", "inventory-v1"])).toEqual({ fixturePath: "/mock/fixture.json", origin: "inventory-v1" });
    expect(parseMockModeArguments(["--mock", "--origin", "unbound"])).toEqual({ fixturePath: null, origin: "unbound" });
  });

  it.each([[["--mock"]], [["--mock", "/mock/fixture.json"]], [["--mock", "/mock/fixture.json", "--origin", "../x"]], [["--mock", "/mock/fixture.json", "--origin", "a b"]],
    [["--mock", "/mock/fixture.json", "--origin", "inventory-v1", "--extra"]], [["--origin", "inventory-v1"]]])("refuses %j", (argv) => {
    expect(() => parseMockModeArguments(argv)).toThrow();
  });
});

/** Opens a TCP connection, writes `bytes` (nothing for an idle one) and returns once the server has closed it or `holdMs` passed. */
function rawConnection(port: number, bytes: string | Buffer | null, holdMs = 1_500): Promise<{ socket: Socket; received: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.on("data", (chunk: Buffer) => { received += chunk.toString("latin1"); });
    socket.on("error", () => undefined);
    socket.once("connect", () => { if (bytes !== null) socket.write(bytes); });
    const done = () => resolve({ socket, received });
    socket.once("close", done);
    setTimeout(() => { done(); socket.destroy(); }, holdMs).unref();
  });
}
const until = async (check: () => Promise<boolean>, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((done) => setTimeout(done, 25)); } return check(); };

describe("every connection to a mock or the sinkhole is recorded, parsed or not", () => {
  const unmatched = (lines: MockLedgerLine[]) => lines.filter((line) => line.variantId === null && line.status === 599);

  it.each([
    ["a TLS ClientHello (HTTPS to a plain HTTP origin)", () => Buffer.from("160301020001", "hex")],
    ["h2c with prior knowledge", () => "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"],
    ["a malformed request line", () => "GET\r\n\r\n"],
    ["garbage bytes", () => Buffer.from([0, 1, 2, 3, 255, 254, 253, 10, 10])],
    ["a request with an oversized header", () => `GET /v1/stock?orderId=a1 HTTP/1.1\r\nx: ${"a".repeat(70_000)}\r\n\r\n`],
  ])("records %s as a call no mock matched", async (_label, bytes) => {
    const mock = await start();
    await rawConnection(mock.server.port, bytes());
    expect(await until(async () => unmatched(await mock.lines()).length >= 1)).toBe(true);
    const [line] = unmatched(await mock.lines());
    expect(line).toMatchObject({ variantId: null, status: 599, remoteAddress: "127.0.0.1" });
    expect((await mock.lines()).filter((item) => item.variantId !== null)).toEqual([]);
  });

  it("records a real HTTPS request to the mock", async () => {
    const mock = await start();
    await new Promise<void>((resolve) => { const req = httpsRequest({ host: "127.0.0.1", port: mock.server.port, path: "/v1/stock?orderId=a1", rejectUnauthorized: false }, () => resolve()); req.on("error", () => resolve()); req.end(); });
    expect(await until(async () => unmatched(await mock.lines()).length >= 1)).toBe(true);
    expect((await mock.lines()).some((line) => line.variantId === "success")).toBe(false);
  });

  it("records a CONNECT request", async () => {
    const mock = await start();
    await rawConnection(mock.server.port, "CONNECT example.com:443 HTTP/1.1\r\nhost: example.com:443\r\n\r\n");
    expect(await until(async () => unmatched(await mock.lines()).some((line) => line.method === "CONNECT"))).toBe(true);
  });

  it("never counts a WebSocket Upgrade as a consumption, however well its path and input match", async () => {
    const mock = await start();
    const upgrade = "GET /v1/stock?orderId=a1 HTTP/1.1\r\nhost: mock\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n";
    await rawConnection(mock.server.port, upgrade);
    expect(await until(async () => unmatched(await mock.lines()).length >= 1)).toBe(true);
    const lines = await mock.lines();
    expect(lines.filter((line) => line.variantId !== null)).toEqual([]);
    expect(unmatched(lines)[0]).toMatchObject({ method: "GET", path: "/v1/stock", inputValue: "a1" });
  });

  it("records a connection that opens and sends nothing once, and a normal request adds no connection line", async () => {
    const mock = await start({ connectionGraceMs: 150 });
    const idle = rawConnection(mock.server.port, null, 600);
    expect(await until(async () => unmatched(await mock.lines()).length === 1)).toBe(true);
    await idle;
    expect(unmatched(await mock.lines())).toHaveLength(1);
    await mock.get("/v1/stock?orderId=a1");
    await new Promise((done) => setTimeout(done, 400));
    expect((await mock.lines()).filter((line) => line.variantId === "success")).toHaveLength(1);
    expect(unmatched(await mock.lines())).toHaveLength(1);
  });

  it("records each connection past the connection cap as an unmatched call instead of dropping it silently", async () => {
    const mock = await start({ maxConnections: 1, connectionGraceMs: 10_000 });
    const held = rawConnection(mock.server.port, null, 2_500);
    await new Promise((done) => setTimeout(done, 200));
    await rawConnection(mock.server.port, null, 500);
    expect(await until(async () => unmatched(await mock.lines()).length >= 1)).toBe(true);
    await held;
  });
});

describe("the mock mode of the image", () => {
  it("writes its ready marker only once it is listening, and the sinkhole listens on every port a name that resolves to it may be asked on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mock-mode-"));
    roots.push(dir);
    const running = await runMockMode(["--mock", "--origin", "unbound"], { ledgerDirectory: dir, host: "127.0.0.1", ports: [0, 0, 0], dnsPort: null });
    closers.push(running.close);
    expect(existsSync(join(dir, "unbound.ready"))).toBe(true);
    expect(running.ports).toHaveLength(3);
    for (const port of running.ports) expect((await fetch(`http://127.0.0.1:${port}/anything`)).status).toBe(599);
    expect((await readFile(join(dir, "unbound.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("is not ready, and writes no marker, when it cannot listen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mock-mode-"));
    roots.push(dir);
    const first = await startMockServer({ fixture: null, ledgerPath: join(dir, "a.jsonl"), host: "127.0.0.1", port: 0 });
    closers.push(first.close);
    await expect(runMockMode(["--mock", "--origin", "unbound"], { ledgerDirectory: dir, host: "127.0.0.1", ports: [first.port], dnsPort: null })).rejects.toThrow();
    expect(existsSync(join(dir, "unbound.ready"))).toBe(false);
  });
});

describe("the sinkhole's resolver", () => {
  it("answers an A query for any name with the sinkhole's address and everything else with an empty answer", async () => {
    const dns = await startSinkholeDns({ host: "127.0.0.1", port: 0, address: () => "10.9.8.7" });
    closers.push(() => dns.close());
    const resolver = new Resolver({ timeout: 1_000, tries: 1 });
    resolver.setServers([`127.0.0.1:${dns.port}`]);
    const resolve4 = (name: string) => new Promise<string[]>((resolve, reject) => { resolver.resolve4(name, (error, addresses) => (error ? reject(error) : resolve(addresses))); });
    expect(await resolve4("api.example.com")).toEqual(["10.9.8.7"]);
    expect(await resolve4("a.very.deep.name.example.org")).toEqual(["10.9.8.7"]);
    const resolve6 = () => new Promise<string[]>((resolve, reject) => { resolver.resolve6("api.example.com", (error, addresses) => (error ? reject(error) : resolve(addresses))); });
    const failure = await resolve6().then(() => null, (error: NodeJS.ErrnoException) => error);
    expect(failure?.code).toMatch(/ENODATA|ENOTFOUND/);
  });

  it("ignores packets that are not a single well-formed question", async () => {
    const dns = await startSinkholeDns({ host: "127.0.0.1", port: 0, address: () => "10.9.8.7" });
    closers.push(() => dns.close());
    const { createSocket } = await import("node:dgram");
    const socket = createSocket("udp4");
    const answered = await new Promise<boolean>((resolve) => {
      socket.on("message", () => resolve(true));
      socket.send(Buffer.from([1, 2, 3]), dns.port, "127.0.0.1");
      setTimeout(() => resolve(false), 400);
    });
    socket.close();
    expect(answered).toBe(false);
  });
});
