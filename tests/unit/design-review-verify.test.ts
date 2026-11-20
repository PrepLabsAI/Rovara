// Design review stage: the broker verifies a worker's report against the packet it built.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { REVIEWER_VERIFY_FAILURES, ReviewerRunSchema } from "@agentx/contracts";
import {
  verifyReviewerReport, verifyRound, runVerdictOf, type FirstCallUsageReader, type UsageCheck, type VerifyReviewerInput,
} from "../../packages/broker/src/core/design-review/verify.js";

const keyOf = (name: string): string => createHash("sha256").update(name).digest("hex");
const KEY = keyOf("critic-key");
const DIGEST = "d".repeat(64);
const OPERATION_KEY = keyOf("operation-key");
const packet = { packetDigest: DIGEST, estimatedInputTokens: 10_000 };
const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: "ses_1", packetDigest: DIGEST, firstRequestMessages: 2, filesRead: ["src/a.ts"], tools: ["read", "grep"], modelKeyId: KEY, ...overrides,
});
const reader = (record: Awaited<ReturnType<FirstCallUsageReader["firstCall"]>> | "throw" | "none" = { firstCallInputTokens: 10_000, calls: 3 }) => {
  const firstCall = vi.fn<FirstCallUsageReader["firstCall"]>(async () => {
    if (record === "throw") throw new Error("proxy down: token sk-SECRET");
    return record === "none" ? undefined : record;
  });
  return { reader: { firstCall } satisfies FirstCallUsageReader, firstCall };
};
const proxy = (r = reader()): UsageCheck => ({ kind: "proxy", reader: r.reader });
const input = (overrides: Partial<VerifyReviewerInput> = {}): VerifyReviewerInput => ({
  packet, report: report(), usedSessionIds: new Set(), modelKey: { keyId: KEY, otherReviewerKeyIds: new Set(), operationKeyId: OPERATION_KEY }, usage: proxy(), ...overrides,
});

describe("verifyReviewerReport: each failure voids the run with its own code", () => {

  it("any tool outside READ_ONLY_TOOLS is refused, whatever else is on the list", async () => {
    for (const tool of ["bash", "write", "edit", "Read", "mcp__x__y", ""]) {
      const result = await verifyReviewerReport(input({ report: report({ tools: ["read", tool] }) }));
      expect(result, tool).toEqual({ verified: false, failure: tool === "" ? "unreadable_output" : "tool_not_read_only" });
    }
  });

  it("a first request with history (more than system + one user message) does not match the packet", async () => {
    for (const messages of [1, 3, 20]) {
      await expect(verifyReviewerReport(input({ report: report({ firstRequestMessages: messages }) }))).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
    }
  });

  it("a first call outside 10% of the estimate, either way, is refused; at the edge it passes", async () => {
    for (const tokens of [8_999, 11_001, 40_000, 1]) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader({ firstCallInputTokens: tokens, calls: 1 })) })), String(tokens)).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
    }
    for (const tokens of [9_000, 11_000]) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader({ firstCallInputTokens: tokens, calls: 1 })) })), String(tokens)).resolves.toMatchObject({ verified: true });
    }
  });

  it("minor 1: a tolerance that is NaN, infinite, negative or above 1 is a failure, never a pass", async () => {
    for (const tolerance of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5]) {
      await expect(verifyReviewerReport(input({ tolerance, usage: proxy(reader({ firstCallInputTokens: 999_999, calls: 1 })) })), String(tolerance)).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
      await expect(verifyReviewerReport(input({ tolerance, usage: proxy(reader({ firstCallInputTokens: 10_000, calls: 1 })) })), String(tolerance)).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
    }
    await expect(verifyReviewerReport(input({ tolerance: 0, usage: proxy(reader({ firstCallInputTokens: 10_000, calls: 1 })) }))).resolves.toMatchObject({ verified: true });
  });

  it("minor 2: filesRead loses bidi and control characters, and an entry that is only such characters is dropped", async () => {
    const result = await verifyReviewerReport(input({ report: report({ filesRead: ["\u202eevil.ts", "ok\u0007.ts", "\u200b\u202e", "src/a.ts"] }) }));
    expect(result).toMatchObject({ verified: true, filesRead: ["evil.ts", "ok.ts", "src/a.ts"] });
    const run = ReviewerRunSchema.safeParse({
      role: "critic", promptId: "p", promptVersion: 1, promptDigest: DIGEST, model: { provider: "a", modelId: "m" }, sourceId: "s", sessionId: "ses_1", modelKeyId: KEY, packetDigest: DIGEST,
      packet: [], filesRead: result.verified ? result.filesRead : [], tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z", ...runVerdictOf(result),
    });
    expect(run.success).toBe(true);
  });

  it("a key with no usage record is no_usage_record, never a pass; so is a reader that throws or returns nonsense", async () => {
    for (const record of ["none", "throw", { firstCallInputTokens: 0, calls: 1 }, { firstCallInputTokens: Number.NaN, calls: 1 }, { firstCallInputTokens: 10_000, calls: 0 }] as const) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader(record as never)) }))).resolves.toEqual({ verified: false, failure: "no_usage_record" });
    }
  });

  it("every failure is one of the contract's fixed codes, and fills a valid ReviewerRun verdict", async () => {
    const result = await verifyReviewerReport(input({ report: report({ tools: ["bash"] }) }));
    if (result.verified) throw new Error("expected a void");
    expect(REVIEWER_VERIFY_FAILURES).toContain(result.failure);
    const run = {
      role: "critic", promptId: "p", promptVersion: 1, promptDigest: DIGEST, model: { provider: "a", modelId: "m" }, sourceId: "s", sessionId: "ses_1", modelKeyId: KEY, packetDigest: DIGEST,
      packet: [], filesRead: [], tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z", ...runVerdictOf(result),
    };
    expect(ReviewerRunSchema.safeParse(run).success).toBe(true);
    // a void's verdict plus a "verified" verdict is contradictory
    expect(ReviewerRunSchema.safeParse({ ...run, ...runVerdictOf({ verified: true, sessionId: "s", filesRead: [], inputProof: "digest_only" }), verifyFailure: "timeout" }).success).toBe(false);
  });
});

describe("verifyReviewerReport: no usage reader installed", () => {

  it("still fails the digest, session, tool and key checks", async () => {
    const usage: UsageCheck = { kind: "unavailable" };
    await expect(verifyReviewerReport(input({ usage, report: report({ packetDigest: "e".repeat(64) }) }))).resolves.toMatchObject({ failure: "packet_digest_mismatch" });
    await expect(verifyReviewerReport(input({ usage, usedSessionIds: new Set(["ses_1"]) }))).resolves.toMatchObject({ failure: "session_reused" });
    await expect(verifyReviewerReport(input({ usage, report: report({ tools: ["bash"] }) }))).resolves.toMatchObject({ failure: "tool_not_read_only" });
    await expect(verifyReviewerReport(input({ usage, modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]), operationKeyId: OPERATION_KEY } }))).resolves.toMatchObject({ failure: "model_key_mismatch" });
  });
});

describe("verifyRound: a whole round", () => {
  const keys = { a: keyOf("a"), b: keyOf("b"), c: keyOf("c") };
  const reviewer = (name: "a" | "b" | "c", reportOverrides: Record<string, unknown> = {}, keyId = keys[name]) => ({ role: name, packet, report: report({ sessionId: `ses_${name}`, modelKeyId: keyId, ...reportOverrides }), keyId });
  const round = (reviewers: ReturnType<typeof reviewer>[], extra: { priorSessionIds?: Set<string>; priorKeyIds?: Set<string> } = {}) =>
    verifyRound({ reviewers, priorSessionIds: extra.priorSessionIds ?? new Set(), priorKeyIds: extra.priorKeyIds ?? new Set(), operationKeyId: OPERATION_KEY, usage: proxy() });

  it("voids both reviewers that report the same session id", async () => {
    const results = await round([reviewer("a", { sessionId: "ses_same" }), reviewer("b", { sessionId: "ses_same" }), reviewer("c")]);
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["session_reused", "session_reused", "ok"]);
  });
});

describe("N4: the reviewer's key is its own", () => {

  it("verifyRound refuses a key shared across slots, the merge step's key, and the operation's key; a clean round passes as the control", async () => {
    const k = { a: keyOf("a2"), b: keyOf("b2"), c: keyOf("c2"), merge: keyOf("merge2") };
    const mk = (name: "a" | "b" | "c", keyId: string) => ({ role: name, packet, report: report({ sessionId: `ses_${name}`, modelKeyId: keyId }), keyId });
    const run = (reviewers: ReturnType<typeof mk>[], mergeKeyId?: string) => verifyRound({ reviewers, priorSessionIds: new Set(), priorKeyIds: new Set(), operationKeyId: OPERATION_KEY, ...(mergeKeyId === undefined ? {} : { mergeKeyId }), usage: { kind: "unavailable" } });
    const outcome = (results: Awaited<ReturnType<typeof run>>) => results.map((result) => (result.verified ? "ok" : result.failure));
    expect(outcome(await run([mk("a", k.a), mk("b", k.b), mk("c", k.c)], k.merge))).toEqual(["ok", "ok", "ok"]);
    expect(outcome(await run([mk("a", k.a), mk("b", k.a), mk("c", k.c)]))).toEqual(["model_key_mismatch", "model_key_mismatch", "ok"]);
    expect(outcome(await run([mk("a", k.a), mk("b", k.merge), mk("c", k.c)], k.merge))).toEqual(["ok", "model_key_mismatch", "ok"]);
    expect(outcome(await run([mk("a", k.a), mk("b", OPERATION_KEY), mk("c", k.c)], k.merge))).toEqual(["ok", "model_key_mismatch", "ok"]);
  });
});
