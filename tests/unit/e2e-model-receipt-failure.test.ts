import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { E2EModelReceiptSchema, E2E_MODEL_FAILURE_CLASSES, canonicalJson, type E2EModelReceipt } from "../../packages/contracts/src/index.js";

// M1.4 Task 4.10B, test 20: the receipt's optional `failure`.
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const base = {
  receiptId: "rcpt-1", runId: "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd", caseId: "case-1", stepIndex: 0, callIndex: 0, routeId: "rovara-e2e-default", routeRevision: "r1-1ca517bbc9f9",
  provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5", startedAt: "2026-10-22T10:00:00.000Z", inputTokens: 0, outputTokens: 0, latencyMs: 12,
  servedModelId: null, servedUpstream: null, promptSha256: sha("p"), responseSha256: null, outcome: "provider-error",
};

describe("20. the receipt's failure", () => {
  it("an old receipt (no failure) round-trips through canonicalJson unchanged", () => {
    const stored = canonicalJson(base);
    const parsed = E2EModelReceiptSchema.parse(JSON.parse(stored));
    expect(canonicalJson(parsed)).toBe(stored);
    expect("failure" in parsed).toBe(false);
  });

  it("an old ok receipt and an old refusal also round-trip unchanged", () => {
    for (const old of [{ ...base, outcome: "ok", inputTokens: 100, outputTokens: 10, responseSha256: sha("r") }, { ...base, outcome: "refused-busy" }]) {
      expect(canonicalJson(E2EModelReceiptSchema.parse(JSON.parse(canonicalJson(old))))).toBe(canonicalJson(old));
    }
  });

  it("a failure is accepted on provider-error and timeout, for every class, with a signal or none", () => {
    for (const outcome of ["provider-error", "timeout"] as const) {
      for (const failureClass of E2E_MODEL_FAILURE_CLASSES) {
        const parsed = E2EModelReceiptSchema.parse({ ...base, outcome, failure: { class: failureClass, signal: null } });
        expect(parsed.failure).toEqual({ class: failureClass, signal: null });
      }
    }
    expect(E2EModelReceiptSchema.parse({ ...base, failure: { class: "limit-or-rate-limited", signal: "ThrottlingException" } }).failure?.signal).toBe("ThrottlingException");
    expect(E2EModelReceiptSchema.parse({ ...base, failure: { class: "key-rejected", signal: "secret-unreadable" } }).failure?.signal).toBe("secret-unreadable");
    expect(E2EModelReceiptSchema.parse({ ...base, failure: { class: "unreachable", signal: "UND_ERR_CONNECT_TIMEOUT" } }).failure?.signal).toBe("UND_ERR_CONNECT_TIMEOUT");
  });

  it("a failure is refused on ok, invalid-output, budget and every refusal outcome", () => {
    const failure = { class: "limit-or-rate-limited", signal: null };
    const answered = { responseSha256: sha("r") };
    const cases: Array<Partial<E2EModelReceipt>> = [
      { outcome: "ok", inputTokens: 100, outputTokens: 10, ...answered }, { outcome: "invalid-output", ...answered }, { outcome: "budget" },
      { outcome: "refused-credential-match" }, { outcome: "refused-protocol" }, { outcome: "refused-busy" },
    ];
    for (const over of cases) expect(E2EModelReceiptSchema.safeParse({ ...base, ...over, failure }).success, String(over.outcome)).toBe(false);
  });

  it("an unknown class, extra keys and a signal outside the allow-list are refused", () => {
    for (const failure of [{ class: "weird", signal: null }, { class: "unknown", signal: null, extra: 1 }, { class: "unknown" }, { class: "unknown", signal: "has space" },
      { class: "unknown", signal: "x".repeat(65) }, { class: "unknown", signal: "sk-ant-SECRET:value" }, { class: "unknown", signal: "" }]) {
      expect(E2EModelReceiptSchema.safeParse({ ...base, failure }).success, JSON.stringify(failure)).toBe(false);
    }
  });
});
