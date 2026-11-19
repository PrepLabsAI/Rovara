// Design review stage: the broker verifies a worker's report against the packet it built.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { READ_ONLY_TOOLS, REVIEWER_VERIFY_FAILURES, ReviewerRunSchema, inputProofSentence } from "@agentx/contracts";
import { buildReviewerPacket, packetDigestOf, type PacketReaders } from "../../packages/broker/src/core/design-review/packet.js";
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

describe("verifyReviewerReport: a clean run", () => {
  it("passes when digest, session, tools, key and first call all hold, and says the proxy confirmed the input", async () => {
    await expect(verifyReviewerReport(input())).resolves.toEqual({ verified: true, sessionId: "ses_1", filesRead: ["src/a.ts"], inputProof: "proxy_first_call", firstCallInputTokens: 10_000 });
  });

  it("accepts every read-only tool the platform defines, and a reviewer that read no files", async () => {
    const result = await verifyReviewerReport(input({ report: report({ tools: [...READ_ONLY_TOOLS], filesRead: [] }) }));
    expect(result.verified).toBe(true);
  });

  it("asks the proxy for the key the broker minted, not a key the worker names", async () => {
    const r = reader();
    await verifyReviewerReport(input({ usage: proxy(r), report: report({ modelKeyId: KEY }) }));
    expect(r.firstCall).toHaveBeenCalledWith(KEY);
  });
});

describe("verifyReviewerReport: each failure voids the run with its own code", () => {
  it("packet digest mismatch", async () => {
    const r = reader();
    await expect(verifyReviewerReport(input({ report: report({ packetDigest: "e".repeat(64) }), usage: proxy(r) }))).resolves.toEqual({ verified: false, failure: "packet_digest_mismatch" });
    expect(r.firstCall).not.toHaveBeenCalled();
  });

  it("accepts the reviewer's own answer tool beside the read-only tools, and nothing else that is not read-only", async () => {
    await expect(verifyReviewerReport(input({ report: report({ tools: [...READ_ONLY_TOOLS, "submit_design_review"] }) }))).resolves.toMatchObject({ verified: true });
    // Only that one name: the merge step's tool, a look-alike and the code review's tool are not read-only tools.
    for (const tool of ["submit_design_merge", "submit_review", "submit_design_review2", "Submit_design_review"]) {
      await expect(verifyReviewerReport(input({ report: report({ tools: ["read", tool] }) })), tool).resolves.toEqual({ verified: false, failure: "tool_not_read_only" });
    }
    await expect(verifyReviewerReport(input({ report: report({ tools: ["submit_design_review", "bash"] }) }))).resolves.toEqual({ verified: false, failure: "tool_not_read_only" });
  });

  it("a session id already used in this task is refused", async () => {
    await expect(verifyReviewerReport(input({ usedSessionIds: new Set(["ses_0", "ses_1"]) }))).resolves.toEqual({ verified: false, failure: "session_reused" });
  });

  it("any tool outside READ_ONLY_TOOLS is refused, whatever else is on the list", async () => {
    for (const tool of ["bash", "write", "edit", "Read", "mcp__x__y", ""]) {
      const result = await verifyReviewerReport(input({ report: report({ tools: ["read", tool] }) }));
      expect(result, tool).toEqual({ verified: false, failure: tool === "" ? "unreadable_output" : "tool_not_read_only" });
    }
  });

  it("a model key that is another reviewer's is refused", async () => {
    await expect(verifyReviewerReport(input({ modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]), operationKeyId: OPERATION_KEY } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a worker that names a different key than the one minted is refused", async () => {
    await expect(verifyReviewerReport(input({ report: report({ modelKeyId: keyOf("other") }) }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a key id that is not a proxy token id is refused", async () => {
    await expect(verifyReviewerReport(input({ modelKey: { keyId: "key_1", otherReviewerKeyIds: new Set(), operationKeyId: OPERATION_KEY } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
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

  it("an unreadable report is unreadable_output: wrong types, missing fields, extra fields, not an object", async () => {
    for (const bad of [null, "text", 5, [], {}, report({ sessionId: 5 }), report({ filesRead: "a" }), report({ tools: undefined }), { ...report(), extra: true }, report({ firstRequestMessages: "2" }), report({ filesRead: Array.from({ length: 201 }, () => "a") })]) {
      await expect(verifyReviewerReport(input({ report: bad })), JSON.stringify(bad)).resolves.toEqual({ verified: false, failure: "unreadable_output" });
    }
  });

  it("checks run in a fixed order: the digest is judged before the session, tools and key", async () => {
    const result = await verifyReviewerReport(input({
      report: report({ packetDigest: "e".repeat(64), tools: ["bash"] }), usedSessionIds: new Set(["ses_1"]), modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]), operationKeyId: OPERATION_KEY },
    }));
    expect(result).toEqual({ verified: false, failure: "packet_digest_mismatch" });
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

  it("B1: runVerdictOf carries the input proof into a ReviewerRun that parses, for both proofs", async () => {
    const base = {
      role: "critic", promptId: "p", promptVersion: 1, promptDigest: DIGEST, model: { provider: "a", modelId: "m" }, sourceId: "s", sessionId: "ses_1", modelKeyId: KEY, packetDigest: DIGEST,
      packet: [], filesRead: [], tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z",
    };
    const digestOnly = await verifyReviewerReport(input({ usage: { kind: "unavailable" } }));
    const viaProxy = await verifyReviewerReport(input());
    expect(runVerdictOf(digestOnly)).toEqual({ verified: true, inputProof: "digest_only" });
    expect(runVerdictOf(viaProxy)).toEqual({ verified: true, inputProof: "proxy_first_call" });
    for (const result of [digestOnly, viaProxy]) expect(ReviewerRunSchema.safeParse({ ...base, ...runVerdictOf(result) }).success).toBe(true);
    // a record built from a digest-only result never reads as proxy-confirmed
    const stored = ReviewerRunSchema.parse({ ...base, ...runVerdictOf(digestOnly) });
    expect(inputProofSentence(stored.inputProof!)).not.toContain("and the proxy's first call");
  });

  it("does not carry any text from the report or the proxy error into the result", async () => {
    const result = await verifyReviewerReport(input({ usage: proxy(reader("throw")) }));
    expect(JSON.stringify(result)).not.toContain("sk-SECRET");
  });
});

describe("verifyReviewerReport: no usage reader installed", () => {
  it("passes on the digest alone and says so, so the card can say so", async () => {
    await expect(verifyReviewerReport(input({ usage: { kind: "unavailable" } }))).resolves.toEqual({ verified: true, sessionId: "ses_1", filesRead: ["src/a.ts"], inputProof: "digest_only" });
  });

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

  it("verifies each reviewer on its own report and key, in order (per-case attribution)", async () => {
    const r = reader();
    const results = await verifyRound({ reviewers: [reviewer("a"), reviewer("b", { tools: ["bash"] }), reviewer("c")], priorSessionIds: new Set(), priorKeyIds: new Set(), operationKeyId: OPERATION_KEY, usage: proxy(r) });
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "tool_not_read_only", "ok"]);
    expect(results[0]).toMatchObject({ sessionId: "ses_a" });
    expect(results[2]).toMatchObject({ sessionId: "ses_c" });
    expect(r.firstCall.mock.calls.map((call) => call[0])).toEqual([keys.a, keys.c]);
  });

  it("voids both reviewers that report the same session id", async () => {
    const results = await round([reviewer("a", { sessionId: "ses_same" }), reviewer("b", { sessionId: "ses_same" }), reviewer("c")]);
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["session_reused", "session_reused", "ok"]);
  });

  it("refuses a session id used in an earlier round", async () => {
    const results = await round([reviewer("a"), reviewer("b")], { priorSessionIds: new Set(["ses_b"]) });
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "session_reused"]);
  });

  it("voids every reviewer that shares a model key with another reviewer, or with an earlier run", async () => {
    const shared = await round([reviewer("a"), reviewer("b", {}, keys.a), reviewer("c")]);
    expect(shared.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["model_key_mismatch", "model_key_mismatch", "ok"]);
    const reused = await round([reviewer("a"), reviewer("b")], { priorKeyIds: new Set([keys.b]) });
    expect(reused.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "model_key_mismatch"]);
  });
});

describe("N4: the reviewer's key is its own", () => {
  it("a report that names no model key is refused (it could have run on the operation's key or the install's credential)", async () => {
    const { modelKeyId: _omit, ...without } = report();
    void _omit;
    await expect(verifyReviewerReport(input({ report: without, usage: { kind: "unavailable" } }))).resolves.toEqual({ verified: false, failure: "unreadable_output" });
    await expect(verifyReviewerReport(input({ report: report({ modelKeyId: keyOf("other") }), usage: { kind: "unavailable" } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a slot key equal to the operation's key is refused, even when the report names it", async () => {
    await expect(verifyReviewerReport(input({
      report: report({ modelKeyId: OPERATION_KEY }), modelKey: { keyId: OPERATION_KEY, otherReviewerKeyIds: new Set(), operationKeyId: OPERATION_KEY }, usage: { kind: "unavailable" },
    }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
    await expect(verifyReviewerReport(input({ modelKey: { keyId: KEY, otherReviewerKeyIds: new Set(), operationKeyId: "not-a-key" }, usage: { kind: "unavailable" } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

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

describe("end to end with a real packet", () => {
  const readers: PacketReaders = { readRepoFile: async () => "code", readMetaFile: async () => "meta", fetchMcpItem: async () => ({ ok: false }) };
  const build = () => buildReviewerPacket({
    role: "critic", design: { ref: "design.md", revision: "r1", text: "design" }, requirements: { ref: "requirements.md", revision: "r1", text: "reqs" },
    baseCommits: { api: "a".repeat(40) }, sources: [{ kind: "repo_file", repo: "api", path: "src/a.ts" }],
  }, readers);

  it("passes when the worker recomputes the digest from the packet it was sent", async () => {
    const built = await build();
    const result = await verifyReviewerReport(input({ packet: built, report: report({ packetDigest: packetDigestOf(built) }), usage: proxy(reader({ firstCallInputTokens: built.estimatedInputTokens, calls: 1 })) }));
    expect(result.verified).toBe(true);
  });

  it("voids a worker that sent a different document and recomputed honestly", async () => {
    const built = await build();
    const sent = { ...built, documents: built.documents.map((document, index) => (index === 0 ? { ...document, text: `${document.text} plus the planner's reasoning` } : document)) };
    const result = await verifyReviewerReport(input({ packet: built, report: report({ packetDigest: packetDigestOf(sent) }), usage: { kind: "unavailable" } }));
    expect(result).toEqual({ verified: false, failure: "packet_digest_mismatch" });
  });
});
