import { describe, expect, it } from "vitest";
import type { E2EApiMockFixture } from "../../packages/contracts/src/index.js";
import { MOCK_UNMOCKED_RESPONSE_DIGEST, mockRequestDigest, mockResponseDigest, type MockLedgerLine } from "../../packages/verifier/src/executor/mock-server.js";
import { MOCK_LEDGER_WITHHELD, bindMockLedgers, parseMockLedger, withholdMockLedgerCredentials, type ParsedMockLedger } from "../../packages/verifier/src/host/mock-ledger.js";
import { buildMockProofs } from "../../packages/verifier/src/host/mock-proofs.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";

const fixture: E2EApiMockFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getStock", method: "GET", path: "/v1/stock", inputField: "orderId", variants: [
  { id: "success", inputValue: "a1", status: 200, body: { status: "in-stock" } },
  { id: "refusal", inputValue: "a2", status: 404, body: { error: "unknown order" } },
  { id: "invalid-data", inputValue: "b1", status: 200, body: { status: 7 } },
] };
const APP = "172.30.0.2";
const at = (ms: number) => new Date(Date.parse("2026-10-20T12:00:00.000Z") + ms).toISOString();

let counter = 0;
function matched(variantId: "success" | "refusal" | "invalid-data", ms: number): MockLedgerLine {
  const variant = fixture.variants.find((item) => item.id === variantId)!;
  counter += 1;
  return { requestId: `req-${counter}`, method: "GET", path: "/v1/stock", inputValue: variant.inputValue, variantId, status: variant.status,
    requestSha256: mockRequestDigest({ method: "GET", path: "/v1/stock", inputValue: variant.inputValue }), responseSha256: mockResponseDigest({ status: variant.status, body: variant.body }), observedAt: at(ms), remoteAddress: APP };
}
function unmatched(ms: number, path = "/internal/admin"): MockLedgerLine {
  counter += 1;
  return { requestId: `req-${counter}`, method: "GET", path, inputValue: null, variantId: null, status: 599,
    requestSha256: mockRequestDigest({ method: "GET", path, inputValue: null }), responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST, observedAt: at(ms), remoteAddress: APP };
}
const bytes = (...rows: unknown[]) => Buffer.from(rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n");
const mocked = (...rows: unknown[]) => parseMockLedger({ appAddress: APP, origin: "inventory-v1", componentId: "api-schema-aaaaaaaaaaaa", fixture, bytes: bytes(...rows) });
const sink = (...rows: unknown[]) => parseMockLedger({ appAddress: APP, origin: "unbound", componentId: null, fixture: null, bytes: bytes(...rows) });

describe("reading a mock ledger the host did not write", () => {
  it("accepts a line only when every field agrees with the approved fixture's variant", () => {
    const parsed = mocked(matched("success", 10), matched("refusal", 20), matched("invalid-data", 30), unmatched(40));
    expect(parsed.malformed).toBe(0);
    expect(parsed.lines.map((line) => [line.kind, line.line.variantId])).toEqual([["consumption", "success"], ["consumption", "refusal"], ["consumption", "invalid-data"], ["unmatched", null]]);
  });

  it.each([
    ["not JSON", "{nope"],
    ["an extra member", { ...matched("success", 10), extra: 1 }],
    ["a missing member", (() => { const { status: _status, ...rest } = matched("success", 10); void _status; return rest; })()],
    ["a variant the fixture does not have", { ...matched("success", 10), variantId: "other" }],
    ["a status that is not the variant's", { ...matched("success", 10), status: 500 }],
    ["an input value that is not the variant's", { ...matched("success", 10), inputValue: "a2" }],
    ["a path that is not the fixture's", { ...matched("success", 10), path: "/v1/other" }],
    ["a response hash that is not the variant's", { ...matched("success", 10), responseSha256: "0".repeat(64) }],
    ["a request hash that is not its own fields'", { ...matched("success", 10), requestSha256: "0".repeat(64) }],
    ["a 599 line that claims a variant", { ...unmatched(10), variantId: "success" }],
    ["an unmatched line with a status other than 599", { ...unmatched(10), status: 200 }],
    ["an unmatched line with the wrong response hash", { ...unmatched(10), responseSha256: "1".repeat(64) }],
    ["a time that is not an ISO instant", { ...matched("success", 10), observedAt: "yesterday" }],
  ])("counts %s as malformed, never as a consumption", (_label, row) => {
    const parsed = mocked(row);
    expect(parsed.lines).toEqual([]);
    expect(parsed.malformed).toBe(1);
  });

  it("accepts a consumption only from the application container's address: from anywhere else it is a call no mock matched", () => {
    for (const caller of ["172.30.0.3", "127.0.0.1", "unknown", "::1"]) {
      const parsed = mocked({ ...matched("success", 10), remoteAddress: caller });
      expect(parsed.malformed).toBe(0);
      expect(parsed.lines.map((line) => [line.kind, line.kind === "unmatched" ? line.reason : undefined])).toEqual([["unmatched", "foreign-caller"]]);
    }
    // Without a known application address nothing can be a consumption.
    const unknownApp = parseMockLedger({ origin: "inventory-v1", componentId: "api-schema-aaaaaaaaaaaa", fixture, appAddress: null, bytes: bytes(matched("success", 10)) });
    expect(unknownApp.lines.map((line) => line.kind)).toEqual(["unmatched"]);
  });

  it("binds a foreign caller's consumption as an unmatched call of the case whose window holds it, with its own kind", () => {
    const windows = [{ caseId: "case-a", startMs: Date.parse(at(100)), endMs: Date.parse(at(200)) }];
    const bound = bindMockLedgers({ ledgers: [mocked({ ...matched("success", 150), remoteAddress: "172.30.0.3" })], windows, caseIds: ["case-a"] });
    expect(bound.get("case-a")!.consumptions).toEqual([]);
    expect(bound.get("case-a")!.unmocked.map((row) => row.kind)).toEqual(["foreign-caller"]);
  });

  it("counts a line without the caller's address as malformed", () => {
    const { remoteAddress: _address, ...without } = matched("success", 10);
    void _address;
    expect(mocked(without).malformed).toBe(1);
  });

  it("treats every line of the sinkhole as an unmatched call, whatever it says", () => {
    const parsed = sink(unmatched(10, "/"), { ...matched("success", 20), variantId: null, status: 599, responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST });
    expect(parsed.lines.map((line) => line.kind)).toEqual(["unmatched", "unmatched"]);
    // A sinkhole line that claims it served a variant is not a sinkhole line at all.
    expect(sink(matched("success", 10)).malformed).toBe(1);
  });

  it("turns lines past the bound into an overflow instead of reading them", () => {
    const rows = Array.from({ length: 2_048 + 3 }, (_, index) => matched("success", index));
    const parsed = mocked(...rows);
    expect(parsed.lines.filter((line) => line.kind === "consumption")).toHaveLength(2_048);
    expect(parsed.overflowed).toBe(true);
  });
});

describe("binding ledger lines to cases by the time window of the executor's actions", () => {
  const windows = [{ caseId: "case-a", startMs: Date.parse(at(100)), endMs: Date.parse(at(200)) }, { caseId: "case-b", startMs: Date.parse(at(300)), endMs: Date.parse(at(400)) }];
  const bind = (...ledgers: ParsedMockLedger[]) => bindMockLedgers({ ledgers, windows, caseIds: ["case-a", "case-b"] });

  it("gives a consumption to the case whose window holds it, and drops one outside every window", () => {
    const bound = bind(mocked(matched("success", 150), matched("refusal", 350), matched("success", 250), matched("success", 99), matched("success", 401)));
    expect(bound.get("case-a")!.consumptions.map((row) => row.line.variantId)).toEqual(["success"]);
    expect(bound.get("case-b")!.consumptions.map((row) => row.line.variantId)).toEqual(["refusal"]);
    expect(bound.get("case-a")!.unmocked).toEqual([]);
  });

  it("includes the first and last instant of a window", () => {
    const bound = bind(mocked(matched("success", 100), matched("success", 200)));
    expect(bound.get("case-a")!.consumptions).toHaveLength(2);
  });

  it("gives an unmatched call inside a window to that case only", () => {
    const bound = bind(mocked(unmatched(150)));
    expect(bound.get("case-a")!.unmocked.map((row) => [row.origin, row.kind, row.path])).toEqual([["inventory-v1", "unmatched", "/internal/admin"]]);
    expect(bound.get("case-b")!.unmocked).toEqual([]);
  });

  it("gives an unmatched call outside every window to every case: a call at an unknown moment is never ignored", () => {
    const bound = bind(sink(unmatched(250)));
    for (const caseId of ["case-a", "case-b"]) expect(bound.get(caseId)!.unmocked.map((row) => [row.origin, row.kind])).toEqual([["unbound", "unmatched"]]);
  });

  it("gives a malformed line, and an overflow, to every case", () => {
    const bound = bind(mocked("{nope"), parseMockLedger({ appAddress: APP, origin: "inventory-v1", componentId: "api-schema-aaaaaaaaaaaa", fixture, bytes: bytes(...Array.from({ length: 2_049 }, (_, index) => matched("success", 1_000 + index))) }));
    for (const caseId of ["case-a", "case-b"]) expect(bound.get(caseId)!.unmocked.map((row) => row.kind).sort()).toEqual(["ledger-overflow", "malformed"]);
  });

  it("gives a consumption that two windows hold to neither: it cannot be attributed", () => {
    const overlapping = [{ caseId: "case-a", startMs: Date.parse(at(100)), endMs: Date.parse(at(300)) }, { caseId: "case-b", startMs: Date.parse(at(200)), endMs: Date.parse(at(400)) }];
    const bound = bindMockLedgers({ ledgers: [mocked(matched("success", 250))], windows: overlapping, caseIds: ["case-a", "case-b"] });
    expect(bound.get("case-a")!.consumptions).toEqual([]);
    expect(bound.get("case-b")!.consumptions).toEqual([]);
  });

  it("keeps at most 100 consumptions for a case and says the rest were not kept", () => {
    const bound = bind(mocked(...Array.from({ length: 105 }, (_, index) => matched("success", 100 + index % 90))));
    expect(bound.get("case-a")!.consumptions).toHaveLength(100);
    expect(bound.get("case-a")!.unmocked.map((row) => row.kind)).toEqual(["ledger-overflow"]);
  });
});

describe("keeping run credentials out of what the mocks recorded", () => {
  const PASSWORD = "Zq3xV9pL2mN8bR4tY6wK1sD7fG5hJ0cE";
  const EMAIL = "owner-7f3a@accounts.rovara.test";
  const redactor = createCredentialRedactor([{ profileId: "owner", email: EMAIL, password: PASSWORD }]);
  const withhold = (ledger: ParsedMockLedger) => withholdMockLedgerCredentials(ledger, (value) => redactor.contains(value));
  const line = (ms: number, method: string, path: string, inputValue: string | null, remoteAddress = APP): MockLedgerLine => {
    counter += 1;
    return { requestId: `req-${counter}`, method, path, inputValue, variantId: null, status: 599, requestSha256: mockRequestDigest({ method, path, inputValue }),
      responseSha256: MOCK_UNMOCKED_RESPONSE_DIGEST, observedAt: at(ms), remoteAddress };
  };

  it("replaces a path, method or input that carries a credential, raw or percent-encoded, and keeps every call as an unmatched one", () => {
    const ledger = withhold(sink(line(10, "GET", `/${PASSWORD}`, null), line(20, "GET", `/x?u=${encodeURIComponent(EMAIL)}`, null), line(30, "POST", "/plain", null),
      line(40, "GET", "/a", PASSWORD)));
    expect(JSON.stringify(ledger)).not.toContain(PASSWORD);
    expect(JSON.stringify(ledger)).not.toContain(EMAIL);
    expect(JSON.stringify(ledger)).not.toContain(encodeURIComponent(EMAIL));
    expect(ledger.lines.map((item) => [item.kind, item.line.method, item.line.path, item.line.inputValue])).toEqual([
      ["unmatched", "GET", MOCK_LEDGER_WITHHELD, null], ["unmatched", "GET", MOCK_LEDGER_WITHHELD, null], ["unmatched", "POST", "/plain", null], ["unmatched", "GET", "/a", MOCK_LEDGER_WITHHELD]]);
  });

  it("leaves a ledger without a credential exactly as it was, consumptions included", () => {
    const parsed = mocked(matched("success", 10), unmatched(20));
    expect(withhold(parsed)).toEqual(parsed);
  });

  it("binds withheld calls, from the app or from another caller, into the case's unmocked-call frame without the credential", () => {
    const foreign = withhold(sink(line(150, "GET", `/${PASSWORD}`, null, "172.30.0.9")));
    const parsed = parseMockLedger({ appAddress: APP, origin: "unbound", componentId: null, fixture: null, bytes: bytes(line(160, "GET", `/${PASSWORD}`, null)) });
    const bound = bindMockLedgers({ ledgers: [foreign, withhold(parsed)], windows: [{ caseId: "case-a", startMs: Date.parse(at(100)), endMs: Date.parse(at(200)) }], caseIds: ["case-a"] });
    expect(bound.get("case-a")!.unmocked.map((call) => [call.kind, call.path])).toEqual([["unmatched", MOCK_LEDGER_WITHHELD], ["unmatched", MOCK_LEDGER_WITHHELD]]);
    const proof = (value: unknown, mediaType: string, artifactId: string) => {
      const encoded = Buffer.from(JSON.stringify(value));
      return { ref: { artifactId, sha256: "0".repeat(64), byteLength: encoded.byteLength, mediaType }, bytes: encoded };
    };
    const proofs = buildMockProofs({ runId: "11111111-1111-4111-8111-111111111111", mockManifestDigest: "c".repeat(64), lifecycleId: "rovara-executor-x", context: {}, producer: {},
      cases: [{ caseId: "case-a", shardId: "shard", upstreamRunId: "u" }], bound, proof });
    // One unmocked-call frame for the case (so it is UNKNOWN `unmocked-external-call`), and no frame carries the credential.
    expect(proofs.unmockedEntries.map((entry) => entry.caseId)).toEqual(["case-a"]);
    for (const frame of proofs.frames) expect(Buffer.from(frame.bytes).toString("utf8")).not.toContain(PASSWORD);
  });
});
