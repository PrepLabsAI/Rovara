import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { E2EApiMockFixtureSchema, canonicalJson, type E2EApiMockFixture } from "../../packages/contracts/src/index.js";
import { MOCK_LEDGER_MAX_LINES, MOCK_UNMOCKED_BODY, MOCK_UNMOCKED_STATUS, mockRequestDigest, mockResponseDigest, parseMockFixture, parseMockModeArguments, startMockServer, type MockLedgerLine } from "../../packages/verifier/src/executor/mock-server.js";

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

async function start(options: { fixture?: E2EApiMockFixture | null; maxLines?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mock-server-"));
  roots.push(dir);
  const ledgerPath = join(dir, "inventory-v1.jsonl");
  const server = await startMockServer({ fixture: options.fixture === undefined ? fixture : options.fixture, ledgerPath, host: "127.0.0.1", port: 0,
    ...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }) });
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
      expect(Object.keys(line).sort()).toEqual(["inputValue", "method", "observedAt", "path", "requestId", "requestSha256", "responseSha256", "status", "variantId"]);
      expect(line.requestSha256).toBe(sha(canonicalJson({ method: "GET", path: "/v1/stock", inputValue: "a1" })));
      expect(line.responseSha256).toBe(sha(canonicalJson({ status: 200, body: { status: "in-stock" } })));
      expect(new Date(line.observedAt).toISOString()).toBe(line.observedAt);
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
