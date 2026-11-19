// General fakes slice 2b: the set the worker writes for the hosted fake-helper container and the summary the helper prints (contracts general-fakes-set.ts, openapi-fake.ts serialization). The set is bound to one company and
// one task and pinned by a digest; anything that is not exactly that is refused as a whole.
import { describe, expect, it } from "vitest";
import {
  GENERAL_FAKES_SET_MAX_BYTES, GENERAL_FAKES_SUMMARY_MAX_COUNT, UNTRUSTED_GENERAL_FAKES_SUMMARY, answerOpenApiFake, buildGeneralFakesSetBytes, buildOpenApiFake, parseGeneralFakesSetBytes, parseGeneralFakesSummaryText,
  reviveOpenApiFake, serializeOpenApiFake, sha256HexOfBytes, type GeneralFakeServiceFake, type OpenApiFake,
} from "@agentx/contracts";

const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
const DOCUMENT = {
  openapi: "3.0.3", info: { title: "pets", version: "1" }, servers: [{ url: "https://pets.example.test/v1" }],
  paths: {
    "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 }, name: { type: "string" } } } } } } } } },
    "/pets": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } } } }, delete: { responses: { "204": { description: "gone" } } } },
    "/odd": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "string", enum: ["a"] } } } } } } },
    "/shared": { $ref: "#/components/pathItems/x" },
  },
};
const built = (): OpenApiFake => buildOpenApiFake(DOCUMENT, "openapi.json");
const PROBES: readonly (readonly [string, string])[] = [["GET", "/pets/4"], ["GET", "/v1/pets/4"], ["GET", "/pets"], ["DELETE", "/pets"], ["POST", "/pets"], ["GET", "/odd"], ["GET", "/shared"], ["GET", "/nothing"], ["GET", "/pets/4?x=1"]];
const fakes = (): GeneralFakeServiceFake[] => [{ status: "built", fake: built() }, { status: "not_built", reason: "no_spec" }];
const setOf = () => buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: fakes() })!;
const expectation = (digest: string) => ({ digest, workspaceId: WORKSPACE, operationId: OPERATION });

describe("the serialized fake", () => {
  it("answers every probe exactly as the fake it was made from, after a trip through JSON", () => {
    const original = built();
    const stored = serializeOpenApiFake(original)!;
    const revived = reviveOpenApiFake(JSON.parse(JSON.stringify(stored)) as unknown)!;
    expect(revived.status).toBe("built");
    for (const [method, path] of PROBES) expect(answerOpenApiFake(revived, method, path), `${method} ${path}`).toEqual(answerOpenApiFake(original, method, path));
    // Control: the probes are not all the same answer.
    expect(new Set(PROBES.map(([method, path]) => JSON.stringify(answerOpenApiFake(original, method, path)))).size).toBeGreaterThan(3);
  });

  it("stores templates, never a regular expression, and nothing for a fake that is not built", () => {
    const text = JSON.stringify(serializeOpenApiFake(built()));
    expect(text).toContain('"template":"/pets/{id}"');
    expect(text).not.toMatch(/pattern|\^\//u);
    expect(serializeOpenApiFake({ status: "not_built", reason: "spec_unreadable" })).toBeUndefined();
  });

  it("refuses, as a whole, anything the builder could not have made", () => {
    const good = JSON.parse(JSON.stringify(serializeOpenApiFake(built()))) as { status: string; basePath: string; operations: Array<{ method: string; template: string; answer: unknown }> };
    const mutate = (change: (copy: typeof good) => void) => { const copy = structuredClone(good); change(copy); return reviveOpenApiFake(copy); };
    expect(reviveOpenApiFake(good)).toBeDefined();
    expect(mutate((copy) => { copy.operations[0]!.method = "FETCH"; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations[0]!.template = "pets"; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations[0]!.template = `/${"a".repeat(3_000)}`; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations[0]!.answer = { status: 500, body: {} }; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations[0]!.answer = { status: 2.5 }; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations[0]!.answer = "other"; })).toBeUndefined();
    // A real method on a template this adapter cannot match segment by segment would never have been built.
    expect(mutate((copy) => { copy.operations[0]!.template = "/a/{b}{c}x{"; copy.operations[0]!.method = "get"; })).toBeUndefined();
    // "*" is only ever an operation that cannot be answered.
    expect(mutate((copy) => { copy.operations[0]!.method = "*"; })).toBeUndefined();
    expect(mutate((copy) => { copy.operations = Array.from({ length: 257 }, () => copy.operations[0]!); })).toBeUndefined();
    expect(mutate((copy) => { copy.status = "not_built"; })).toBeUndefined();
    expect(reviveOpenApiFake(null)).toBeUndefined();
    expect(reviveOpenApiFake({ status: "built", basePath: 1, operations: [] })).toBeUndefined();
  });
});

describe("the set", () => {
  it("round-trips: the helper's fakes answer as the worker's, in the order of the setting", () => {
    const { bytes, digest } = setOf();
    expect(digest).toBe(sha256HexOfBytes(bytes));
    const parsed = parseGeneralFakesSetBytes(bytes, expectation(digest))!;
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({ status: "not_built", reason: "no_spec" });
    const first = parsed[0]!;
    expect(first.status).toBe("built");
    for (const [method, path] of PROBES) expect(answerOpenApiFake((first as { fake: OpenApiFake }).fake, method, path)).toEqual(answerOpenApiFake(built(), method, path));
  });

  it("is refused when it is not the pinned bytes, or is bound to another company or task (each alone)", () => {
    const { bytes, digest } = setOf();
    expect(parseGeneralFakesSetBytes(bytes, expectation(digest))).toBeDefined();
    expect(parseGeneralFakesSetBytes(bytes, { ...expectation(digest), digest: "0".repeat(64) })).toBeUndefined();
    expect(parseGeneralFakesSetBytes(bytes, { ...expectation(digest), digest: digest.toUpperCase() })).toBeUndefined();
    expect(parseGeneralFakesSetBytes(bytes, { ...expectation(digest), workspaceId: "11111111-1111-4111-8111-111111111111" })).toBeUndefined();
    expect(parseGeneralFakesSetBytes(bytes, { ...expectation(digest), operationId: "11111111-1111-4111-8111-111111111111" })).toBeUndefined();
    // One byte changed: the digest no longer matches, even though the bytes still parse.
    const changed = new Uint8Array(bytes);
    changed[changed.length - 3] = changed[changed.length - 3] === 0x20 ? 0x21 : 0x20;
    expect(parseGeneralFakesSetBytes(changed, expectation(digest))).toBeUndefined();
    expect(parseGeneralFakesSetBytes(new Uint8Array(), expectation(sha256HexOfBytes(new Uint8Array())))).toBeUndefined();
  });

  it("a set whose own ids differ from its digest-pinned arguments is refused even when the digest is right for those bytes", () => {
    const other = buildGeneralFakesSetBytes({ workspaceId: "22222222-2222-4222-8222-222222222222", operationId: OPERATION, fakes: fakes() })!;
    expect(parseGeneralFakesSetBytes(other.bytes, { digest: other.digest, workspaceId: WORKSPACE, operationId: OPERATION })).toBeUndefined();
  });

  it("is not built for fakes that cannot be stored, ids that are not UUIDs, more services than allowed, or past the size limit", () => {
    expect(buildGeneralFakesSetBytes({ workspaceId: "not-a-uuid", operationId: OPERATION, fakes: fakes() })).toBeUndefined();
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: "x", fakes: fakes() })).toBeUndefined();
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: [] })).toBeUndefined();
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: Array.from({ length: 9 }, () => ({ status: "no_spec" }) as never) })).toBeUndefined();
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: [{ status: "not_built", reason: "start_failed" }] })).toBeUndefined();
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: [{ status: "not_built", reason: "operation_unknown" }] })).toBeUndefined();
    const huge: OpenApiFake = { status: "built", basePath: "", operations: Array.from({ length: 200 }, (_x, index) => ({ method: "get", template: `/a${String(index)}`, pattern: new RegExp(`^/a${String(index)}$`, "u"), literalSegments: 1, segments: 1, answer: { status: 200, body: "x".repeat(30_000) } })) } as never;
    expect(buildGeneralFakesSetBytes({ workspaceId: WORKSPACE, operationId: OPERATION, fakes: [{ status: "built", fake: huge }] })).toBeUndefined();
    expect(GENERAL_FAKES_SET_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it("a set with a tampered fake (not parseable as one) is refused even with a matching digest", () => {
    const text = JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, operationId: OPERATION, services: [{ status: "built", fake: { status: "built", basePath: "", operations: [{ method: "get", template: "nope", answer: "unsupported" }] } }] });
    const bytes = new TextEncoder().encode(text);
    expect(parseGeneralFakesSetBytes(bytes, expectation(sha256HexOfBytes(bytes)))).toBeUndefined();
    const extra = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, operationId: OPERATION, services: [{ status: "not_built", reason: "no_spec" }], extra: 1 }));
    expect(parseGeneralFakesSetBytes(extra, expectation(sha256HexOfBytes(extra)))).toBeUndefined();
  });
});

describe("the summary", () => {
  const trusted = { schemaVersion: 1, trusted: true, workspaceId: WORKSPACE, operationId: OPERATION, digest: "a".repeat(64), served: 2, cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 1, operation_unsupported: 0 }, foreign: 0, unrouted: 0, refused: 0, saturated: false };
  it("reads one line, and nothing else", () => {
    expect(parseGeneralFakesSummaryText(`${JSON.stringify(trusted)}\n`)).toEqual(trusted);
    expect(parseGeneralFakesSummaryText(JSON.stringify(UNTRUSTED_GENERAL_FAKES_SUMMARY))).toEqual(UNTRUSTED_GENERAL_FAKES_SUMMARY);
    expect(parseGeneralFakesSummaryText("")).toBeUndefined();
    expect(parseGeneralFakesSummaryText(`${JSON.stringify(trusted)}\n${JSON.stringify(trusted)}\n`)).toBeUndefined();
    expect(parseGeneralFakesSummaryText("not json")).toBeUndefined();
    expect(parseGeneralFakesSummaryText(`${JSON.stringify(trusted)} extra`)).toBeUndefined();
  });
  it("refuses a count past its bound, a negative or fractional one, an unknown field, a bad id and an untrusted summary that carries counts", () => {
    const text = (change: object) => parseGeneralFakesSummaryText(JSON.stringify({ ...trusted, ...change }));
    expect(text({ served: GENERAL_FAKES_SUMMARY_MAX_COUNT + 1 })).toBeUndefined();
    expect(text({ served: -1 })).toBeUndefined();
    expect(text({ served: 1.5 })).toBeUndefined();
    expect(text({ extra: 1 })).toBeUndefined();
    expect(text({ workspaceId: "x" })).toBeUndefined();
    expect(text({ digest: "abc" })).toBeUndefined();
    expect(text({ cannotAnswer: { ...trusted.cannotAnswer, start_failed: 1 } })).toBeUndefined();
    expect(text({ trusted: false })).toBeUndefined();
    expect(parseGeneralFakesSummaryText("x".repeat(5_000))).toBeUndefined();
  });
});
