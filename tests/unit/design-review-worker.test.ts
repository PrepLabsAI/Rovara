// Design review stage: the worker runs every reviewer in a NEW read-only session, in parallel, then the merge step.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DesignReviewBindingSchema, DesignReviewRoundSchema, DesignReviewWorkerResultSchema, PacketDeliverySchema, READ_ONLY_TOOLS, WorkerInvocationSchema, MODEL_NOT_ENABLED_CODE, modelFailureCodeOf, reviewerMessagesOf, type DesignReviewBinding, type DesignReviewTier, type ReviewerRole, type WorkerInvocation,
} from "@agentx/contracts";
import { buildReviewerPacket, type PacketReaders } from "../../packages/broker/src/core/design-review/packet.js";
import { WorkerReportSchema } from "../../packages/broker/src/core/design-review/verify.js";
import { assembleRoundFindings } from "../../packages/broker/src/core/design-review/round-findings.js";
import { lostBlockerFindings, withOwnFindings } from "../../packages/broker/src/core/design-review/own-findings.js";
import { designCardFactsOf } from "../../packages/broker/src/core/design-review/card-source.js";
import { designApprovalProofLine, designApprovalReason } from "../../packages/broker/src/core/design-review/approval.js";
/** The reason rule of an approval (who may approve is the approval gate's, tested with the gate). */
const decideDesignApproval = (input: { openBlockers: number; blockerReason?: string | undefined }) => { const answer = designApprovalReason(input); return answer.ok ? { ok: true as const, ...(answer.proofReason === undefined ? {} : { proofReason: answer.proofReason }) } : { ok: false as const, code: answer.code }; };
import { riskTierOf } from "../../packages/broker/src/core/decisions/risk-tier.js";
import { DESIGN_REVIEW_LOST_FINDINGS_PROBLEM, designReviewRetryPrompt, modelKeyIdOf, runDesignReview, sentDigestOf, type DesignReviewPorts, type DesignReviewSession, type OpenDesignReviewSession } from "../../packages/worker/src/design-review.js";
import { createReviewSessionOpener, designReviewBindingOf, runDesignReviewOperation, slotRuntimeFor } from "../../packages/worker/src/design-review-sessions.js";
import { failedTurn } from "../../packages/worker/src/session-events.js";
import { OperationJournal, createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/index.js";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const DESIGN = "## §3 Proposed design\nR1: add the endpoint.\n";
const readers: PacketReaders = { readRepoFile: async () => undefined, readMetaFile: async () => undefined, fetchMcpItem: async () => ({ ok: false }) };

async function packetFor(role: ReviewerRole, tier?: DesignReviewTier) {
  // The role prompt is not an input: the builder takes it from the registry by role (and tier).
  const built = await buildReviewerPacket({
    role, ...(tier === undefined ? {} : { tier }),
    design: { ref: "design.md", revision: "r1", text: DESIGN }, requirements: { ref: "requirements.md", revision: "r1", text: "R1: an endpoint." },
    ...(role === "comprehension" ? { requestText: "Please add an endpoint." } : {}), baseCommits: {}, sources: [],
  }, readers);
  return built;
}

const block = (findings: unknown[], paraphrase?: unknown): string => `Done.\n\n\`\`\`rovara-design-review\n${JSON.stringify({ ...(paraphrase === undefined ? {} : { paraphrase }), findings })}\n\`\`\`\n`;
const finding = (id: string, over: Record<string, unknown> = {}) => ({ id, severity: "major", section: "§3", text: `Problem ${id}.`, citations: [{ kind: "design", section: "§3" }], ...over });
const mergeBlock = (merged: unknown[]): string => `\`\`\`rovara-design-merge\n${JSON.stringify({ merged })}\n\`\`\``;

interface Script {
  /** Answers given to the first and later prompts of a session, by the system prompt it was opened with or "merge". */
  answers: Record<string, Array<string | Error>>;
  /** Messages the first request claims to hold (default 2). */
  messages?: number;
  alterFirstUser?: boolean;
  /** Text the harness adds after the role prompt in the system text (pi's cwd and date sections). */
  harnessSystem?: string;
  /** Replaces the system text altogether. */
  replaceSystem?: string;
  systemObserved?: boolean;
}

function fakePorts(script: Script, deliveries: Map<string, unknown>) {
  const opened: Array<{ input: OpenDesignReviewSession; session: DesignReviewSession; prompts: string[]; aborted: boolean; disposed: boolean; keyId: string }> = [];
  let counter = 0;
  const ports: DesignReviewPorts = {
    loadPacket: async ({ keySlot }) => deliveries.get(keySlot),
    openSession: async (input) => {
      const id = `sess-${++counter}`;
      const state = { input, prompts: [] as string[], aborted: false, disposed: false, keyId: sha(`key-${input.keySlot}`) } as (typeof opened)[number];
      const answers = script.answers[input.purpose === "merge" ? "merge" : input.keySlot] ?? [];
      let first: { system: string; user: string; messages: number; systemObserved?: boolean } | undefined;
      const session: DesignReviewSession = {
        sessionId: id,
        prompt: async (text) => {
          state.prompts.push(text);
          if (first === undefined) first = { system: script.replaceSystem ?? `${input.system}${script.harnessSystem ?? ""}`, user: script.alterFirstUser === true ? `${text} (extra)` : text, messages: script.messages ?? 2, ...(script.systemObserved === undefined ? {} : { systemObserved: script.systemObserved }) };
          const next = answers[state.prompts.length - 1];
          if (next === "hang") return new Promise<string>(() => undefined);
          if (next instanceof Error) throw next;
          return next;
        },
        firstRequest: () => first,
        filesRead: () => ["src/a.ts"],
        tools: () => [...input.tools],
        keyId: async () => state.keyId,
        usage: () => ({ tokensIn: 1000 + counter, tokensOut: 200, costUsd: 0.01 }),
        abort: async () => { state.aborted = true; },
        dispose: () => { state.disposed = true; },
      };
      state.session = session;
      opened.push(state);
      return session;
    },
  };
  return { ports, opened };
}

async function setup(roles: ReviewerRole[], withMerge = true, tier?: DesignReviewTier) {
  const deliveries = new Map<string, unknown>();
  const binding: DesignReviewBinding = { version: 1, round: 1, reviewers: [], ...(withMerge ? { merge: { keySlot: "merge", model: { provider: "p", modelId: "fast" }, prompt: { id: "merge", version: 1, text: "MERGE RULES\n=== MATERIAL ===\n" } } } : {}) };
  const packets = new Map<ReviewerRole, Awaited<ReturnType<typeof packetFor>>>();
  for (const role of roles) {
    const built = await packetFor(role, tier);
    packets.set(role, built);
    const delivery = { role, rolePrompt: { id: built.rolePrompt.id, version: built.rolePrompt.version, text: built.rolePrompt.text }, documents: built.documents, ...(built.request === undefined ? {} : { request: built.request }) };
    deliveries.set(`slot-${role}`, delivery);
    binding.reviewers.push({ role, keySlot: `slot-${role}`, packetDigest: built.packetDigest, model: { provider: "p", modelId: "strong" } });
  }
  return { binding, deliveries, packets };
}

describe("runDesignReview: fresh sessions", () => {

  it("ends the entire round on the install pause instead of hiding it as an unusable model", async () => {
    const paused = "Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.";
    const { binding, deliveries } = await setup(["critic"]);
    // Use the same error the session's failedTurn returns, rather than provider text.
    const actual = failedTurn({ stopReason: "error", errorMessage: paused })!;
    const { ports, opened } = fakePorts({ answers: { "slot-critic": [actual] } }, deliveries);
    await expect(runDesignReview(binding, ports)).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${paused}` });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.prompts).toHaveLength(1);
    expect(opened[0]!.disposed).toBe(true);
  });

  it("refuses to send anything when the packet it fetched does not hash to the digest the broker built", async () => {
    const { binding, deliveries } = await setup(["critic", "codebase"]);
    const delivery = deliveries.get("slot-critic") as { documents: Array<{ text: string }> };
    delivery.documents[0]!.text += "\nSneaked in.";
    const { ports, opened } = fakePorts({ answers: { "slot-codebase": [block([])] } }, deliveries);
    const result = await runDesignReview(binding, ports);
    expect(result.reviewers.find((r) => r.role === "critic")).toMatchObject({ status: "no_result", failure: "packet_changed" });
    expect(opened.map((o) => o.input.keySlot)).toEqual(["slot-codebase"]);
    expect(result.reviewers.find((r) => r.role === "codebase")!.status).toBe("answered");
  });

  it("refuses a packet that is not the strict shape", async () => {
    const { binding, deliveries } = await setup(["critic"]);
    deliveries.set("slot-critic", { ...(deliveries.get("slot-critic") as object), history: ["earlier chat"] });
    const { ports, opened } = fakePorts({ answers: {} }, deliveries);
    const result = await runDesignReview(binding, ports);
    expect(result.reviewers[0]).toMatchObject({ status: "no_result", failure: "packet_changed" });
    expect(opened).toHaveLength(0);
  });

  it("a session that did not send exactly the packet (a changed user message) is not counted", async () => {
    const { binding, deliveries } = await setup(["critic"]);
    const { ports } = fakePorts({ answers: { "slot-critic": [block([finding("1")])] }, alterFirstUser: true }, deliveries);
    const result = await runDesignReview(binding, ports);
    expect(result.reviewers[0]).toMatchObject({ status: "no_result", failure: "sent_mismatch" });
    expect(result.findings).toEqual([]);
  });
});

describe("runDesignReview: model keys and tools", () => {

  it("slotRuntimeFor asks the broker for the slot's key and reports a hash of that key; a slot the binding does not hold is refused", async () => {
    const { binding } = await setup(["critic", "codebase"]);
    const asked: string[] = [];
    const fetchStub = vi.fn(async (url: string) => {
      asked.push(url);
      const slot = new URL(url).searchParams.get("slot");
      return new Response(JSON.stringify({ baseUrl: "https://proxy.invalid", apiKey: `key-for-${slot}`, expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    }) as unknown as typeof fetch;
    const runtimeFor = slotRuntimeFor({ controlPlaneUrl: "http://broker.invalid", capability: "c".repeat(64), proxyUrl: "https://proxy.invalid", binding, environment: {}, fetch: fetchStub });
    const critic = runtimeFor({ purpose: "reviewer", keySlot: "slot-critic", model: { provider: "p", modelId: "strong" }, system: "s", tools: [] });
    expect(await critic.keyId!()).toBe(modelKeyIdOf("key-for-slot-critic"));
    expect(asked).toEqual(["http://broker.invalid/v1/internal/model-access?slot=slot-critic"]);
    const codebase = runtimeFor({ purpose: "reviewer", keySlot: "slot-codebase", model: { provider: "p", modelId: "strong" }, system: "s", tools: [] });
    expect(await codebase.keyId!()).toBe(modelKeyIdOf("key-for-slot-codebase"));
    expect(() => runtimeFor({ purpose: "reviewer", keySlot: "slot-other", model: { provider: "p", modelId: "strong" }, system: "s", tools: [] })).toThrow(/slot/);
  });

  it("ends a reviewer on a gateway 401 without another turn or a replacement session", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const refused = failedTurn({ stopReason: "error", errorMessage: "Anthropic request failed; HTTP 401 authentication_error", provider: "anthropic" })!;
    const { ports, opened } = fakePorts({ answers: { "slot-critic": [refused, block([finding("1")])] } }, deliveries);
    const result = await runDesignReview(binding, ports);
    expect(result.reviewers[0]).toMatchObject({ status: "no_result", failure: "model_failed" });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.prompts).toHaveLength(1);
    expect(opened[0]).toMatchObject({ aborted: true, disposed: true });
    expect(result.findings).toEqual([]);
  });

  it("modelAccessSource without a slot asks the operation's own key, as before", async () => {
    const urls: string[] = [];
    const fetchStub = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ baseUrl: "https://p.invalid", apiKey: "k", expiresAt: Date.now() + 3_600_000 })); }) as typeof fetch;
    await modelAccessSource({ controlPlaneUrl: "http://b.invalid/", capability: "c", fetch: fetchStub })();
    expect(urls).toEqual(["http://b.invalid/v1/internal/model-access"]);
  });
});

describe("runDesignReview: timeouts and partial results", () => {

  it("the stage limit ends a reviewer that is still running and says so", async () => {
    const { binding, deliveries } = await setup(["critic", "codebase"], false);
    const { ports } = fakePorts({ answers: { "slot-critic": ["hang"], "slot-codebase": [block([])] } }, deliveries);
    const result = await runDesignReview(binding, ports, { reviewerTimeoutMs: 5_000, stageTimeoutMs: 40 });
    expect(result.reviewers.find((r) => r.role === "critic")).toMatchObject({ status: "no_result", failure: "stage_timeout" });
    expect(result.stageTimedOut).toBe(true);
    expect(result.reviewers.find((r) => r.role === "codebase")!.status).toBe("answered");
  });

  it("a cancel ends every reviewer with 'cancelled'", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const controller = new AbortController();
    const { ports } = fakePorts({ answers: { "slot-critic": ["hang"] } }, deliveries);
    setTimeout(() => controller.abort(), 20);
    const result = await runDesignReview(binding, ports, { signal: controller.signal });
    expect(result.reviewers[0]).toMatchObject({ status: "no_result", failure: "cancelled" });
  });
});

describe("runDesignReview: unreadable blocks", () => {

  it("a readable block that lost a finding is asked again once with the fixed rules, and the better answer is the one kept and stored", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const lost = finding("2", { severity: "blocker", citations: [] });
    const first = block([finding("1"), lost]);
    const second = block([finding("1"), finding("2", { severity: "blocker" })]);
    const { ports, opened } = fakePorts({ answers: { "slot-critic": [first, second] } }, deliveries);
    const result = await runDesignReview(binding, ports);
    expect(opened[0]!.prompts[1]).toBe(designReviewRetryPrompt(DESIGN_REVIEW_LOST_FINDINGS_PROBLEM));
    expect(result.reviewers[0]).toMatchObject({ status: "answered", retried: true, answer: second });
    expect(result.findings.flatMap((f) => f.rawIds).sort()).toEqual(["critic-1", "critic-2"]);
    expect(result.droppedFindings).toEqual([]);
  });

  it("a retry that fails after a readable first answer keeps the first read: not a timeout, the blocker is counted and its loss is recorded; after an unreadable first answer it is still the reviewer's failure", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const first = block([finding("1", { severity: "blocker" }), { nonsense: true }]);
    for (const retry of [new Error("model call failed"), "hang"] as const) {
      const { ports, opened } = fakePorts({ answers: { "slot-critic": [first, retry] } }, deliveries);
      const result = await runDesignReview(binding, ports, { reviewerTimeoutMs: 60, stageTimeoutMs: 5_000 });
      expect(result.reviewers[0], String(retry)).toMatchObject({ status: "answered", retried: true, answer: first });
      expect(result.reviewers[0]!.failure).toBeUndefined();
      expect(result.findings.map((f) => [f.rawIds[0], f.severity])).toEqual([["critic-1", "blocker"]]);
      expect(opened[0]!.aborted).toBe(true);
    }
    // an unreadable first answer keeps today's behaviour: a failed retry is the reviewer's failure
    const { ports } = fakePorts({ answers: { "slot-critic": ["no block here", new Error("model call failed")] } }, deliveries);
    expect((await runDesignReview(binding, ports)).reviewers[0]).toMatchObject({ status: "no_result", failure: "model_failed" });
    const { ports: hung } = fakePorts({ answers: { "slot-critic": ["no block here", "hang"] } }, deliveries);
    expect((await runDesignReview(binding, hung, { reviewerTimeoutMs: 60, stageTimeoutMs: 5_000 })).reviewers[0]).toMatchObject({ status: "no_result", failure: "timeout" });
  });

  it("a retry must not drop a section that held a blocker in the first read, even with as many blockers", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const first = block([finding("1", { severity: "blocker", section: "§3" }), finding("2", { severity: "blocker", section: "§4", citations: [] })]);
    const second = block([finding("1", { severity: "blocker", section: "§3" }), finding("2", { severity: "blocker", section: "§3", text: "Another." })]);
    const { ports } = fakePorts({ answers: { "slot-critic": [first, second] } }, deliveries);
    expect((await runDesignReview(binding, ports)).reviewers[0]).toMatchObject({ answer: first });
    const kept = block([finding("1", { severity: "blocker", section: "§3" }), finding("2", { severity: "blocker", section: "§4" })]);
    const { ports: better } = fakePorts({ answers: { "slot-critic": [first, kept] } }, deliveries);
    expect((await runDesignReview(binding, better)).reviewers[0]).toMatchObject({ answer: kept });
  });
});

describe("runDesignReview: citations and the merge", () => {

  it("falls back when the merge session fails or hangs, and still returns every finding", async () => {
    const { binding, deliveries } = await setup(["critic", "codebase"]);
    const { ports } = fakePorts({ answers: { "slot-critic": [block([finding("1")])], "slot-codebase": [block([finding("2")])], merge: ["hang"] } }, deliveries);
    const result = await runDesignReview(binding, ports, { reviewerTimeoutMs: 60 });
    expect(result.merge).toMatchObject({ status: "no_result", failure: "timeout" });
    expect(result.mergeSource).toBe("code");
    expect(result.findings).toHaveLength(2);
  });
});

describe("N2: what the worker records as sent", () => {
  const harness = "\n<cwd>\n/work\n</cwd>\nDate: 2026-11-03";
  it("accepts the harness's own system text after the role prompt, digests what was really sent, and records how much the harness added", async () => {
    const { binding, deliveries } = await setup(["critic"], false);
    const result = await runDesignReview(binding, fakePorts({ answers: { "slot-critic": [block([])] }, harnessSystem: harness }, deliveries).ports);
    const outcome = result.reviewers[0]!;
    expect(outcome).toMatchObject({ status: "answered" });
    expect(outcome.failure).toBeUndefined();
    const delivery = PacketDeliverySchema.parse(deliveries.get("slot-critic"));
    const messages = reviewerMessagesOf(delivery);
    expect(outcome.report!.harnessSystemChars).toBe(harness.length);
    expect(outcome.report!.sentDigest).toBe(sentDigestOf({ system: messages.system + harness, user: messages.user }));
    // the digest of what the model got is not the packet digest, and a different harness text gives a different one
    expect(outcome.report!.sentDigest).not.toBe(outcome.report!.packetDigest);
    const other = await runDesignReview(binding, fakePorts({ answers: { "slot-critic": [block([])] }, harnessSystem: "\nother" }, deliveries).ports);
    expect(other.reviewers[0]!.report!.sentDigest).not.toBe(outcome.report!.sentDigest);
    expect(WorkerReportSchema.safeParse(outcome.report).success).toBe(true);
    expect(DesignReviewWorkerResultSchema.safeParse(result).success).toBe(true);
  });

  it("the real opener records the system text pi holds for the call, not the text it was asked to use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-sent-"));
    const held = "ROLE PROMPT\n<cwd>/work</cwd>";
    let seenSystem: string | undefined;
    const adapter: PiSessionAdapter = {
      async create(input) {
        seenSystem = input.agentRun?.systemPrompt;
        const sessionFile = join(input.sessionDirectory, "f.jsonl");
        await writeFile(sessionFile, "");
        return {
          sessionFile, conversationId: "f", prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }),
          getSessionStats: () => ({ sessionFile, sessionId: "f", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
          systemPromptText: () => held, subscribe: () => () => undefined, dispose: () => undefined,
        };
      },
    };
    const open = createReviewSessionOpener({ rootPath: dir, localFileTools: true, runtimeFor: () => ({ model: { provider: "p", modelId: "m" }, piAdapter: adapter }) });
    const session = await open({ purpose: "reviewer", keySlot: "slot-critic", model: { provider: "p", modelId: "m" }, system: "ROLE PROMPT", tools: [...READ_ONLY_TOOLS] });
    await session.prompt("the user message");
    expect(seenSystem).toBe("ROLE PROMPT");
    expect(session.firstRequest()).toEqual({ system: held, user: "the user message", messages: 2, systemObserved: true });
    session.dispose();
    // a handle that cannot read its system text back is recorded as not observed
    const blind: PiSessionAdapter = { create: async (input) => { const handle = await adapter.create(input); const rest: PiSessionHandle = Object.assign({}, handle); delete rest.systemPromptText; return rest; } };
    const opener2 = createReviewSessionOpener({ rootPath: dir, localFileTools: true, runtimeFor: () => ({ model: { provider: "p", modelId: "m" }, piAdapter: blind }) });
    const second = await opener2({ purpose: "reviewer", keySlot: "slot-critic", model: { provider: "p", modelId: "m" }, system: "ROLE PROMPT", tools: [...READ_ONLY_TOOLS] });
    await second.prompt("u");
    expect(second.firstRequest()).toMatchObject({ systemObserved: false });
    second.dispose();
  });

});

describe("broker side: assembleRoundFindings", () => {
  const ok = (inputProof: "digest_only" | "proxy_first_call" = "digest_only") => ({ verified: true as const, sessionId: "s", filesRead: [], inputProof });
  async function round(roles: ReviewerRole[], answers: Record<string, Array<string | Error>>) {
    const made = await setup(roles, false);
    const result = await runDesignReview(made.binding, fakePorts({ answers }, made.deliveries).ports);
    const packets = new Map([...made.packets].map(([role, p]) => [role, p.items] as const));
    const verification = new Map(roles.map((role) => [role, ok()] as const));
    return { ...made, result, packets, verification };
  }

  it("N3: a duplicated role is refused as a whole without throwing; every reviewer counts as no result", async () => {
    const made = await round(["critic", "codebase"], { "slot-critic": [block([finding("1")])], "slot-codebase": [block([finding("2")])] });
    const critic = made.result.reviewers[0]!;
    const dup = { ...made.result, reviewers: [critic, { ...critic, answer: block([finding("9", { text: "A different problem." })]) }, made.result.reviewers[1]!] };
    const out = assembleRoundFindings({ binding: made.binding, result: dup, verification: made.verification, packets: made.packets, pins: {} });
    expect(out.refused).toBe("duplicate_role");
    expect(out.findings).toEqual([]);
    expect(out.reviewers.map((r) => [r.role, r.counted, r.verified, r.verifyFailure])).toEqual([["critic", false, false, "unreadable_output"], ["codebase", false, false, "unreadable_output"]]);
  });

  it("N3: an unknown role and a key slot that is not the binding's are refused; reviewers missing from the result are not counted; the order is the binding's", async () => {
    const made = await round(["critic", "codebase"], { "slot-critic": [block([finding("1")])], "slot-codebase": [block([finding("2")])] });
    const [critic, codebase] = made.result.reviewers as [typeof made.result.reviewers[number], typeof made.result.reviewers[number]];
    const base = { binding: made.binding, verification: made.verification, packets: made.packets, pins: {} };
    expect(assembleRoundFindings({ ...base, result: { ...made.result, reviewers: [critic, codebase, { ...critic, role: "zoom_out" as const, keySlot: "slot-zoom_out" }] } }).refused).toBe("unknown_role");
    expect(assembleRoundFindings({ ...base, result: { ...made.result, reviewers: [{ ...critic, keySlot: "slot-codebase" }, codebase] } }).refused).toBe("key_slot_mismatch");
    const partial = assembleRoundFindings({ ...base, result: { ...made.result, reviewers: [codebase] } });
    expect(partial.refused).toBeUndefined();
    expect(partial.reviewers.map((r) => [r.role, r.counted])).toEqual([["critic", false], ["codebase", true]]);
    const swapped = assembleRoundFindings({ ...base, result: { ...made.result, reviewers: [codebase, critic] } });
    expect(swapped.reviewers.map((r) => r.role)).toEqual(["critic", "codebase"]);
  });

  it("a reviewer whose findings were ALL lost is not counted as a clean review, and the loss is counted on the round", async () => {
    const lostAnswer = block([finding("1", { severity: "blocker", citations: [] }), finding("2", { severity: "high" })]);
    const made = await round(["critic", "codebase"], { "slot-critic": [lostAnswer, lostAnswer], "slot-codebase": [block([finding("3")])] });
    const out = assembleRoundFindings({ binding: made.binding, result: made.result, verification: made.verification, packets: made.packets, pins: {} });
    expect(out.reviewers.map((r) => [r.role, r.counted, r.notUsed])).toEqual([["critic", false, "worker_flagged"], ["codebase", true, undefined]]);
    expect(out.findings.flatMap((f) => f.rawIds)).toEqual(["codebase-3"]);
    // the worker refused this reviewer, so nothing else of its answer is used, but the broker reads it once more for the blockers it lost: they stay visible
    expect(out.droppedFindings).toEqual([{ rawId: "~critic-dropped-1", role: "critic", severity: "blocker", section: "§3", reason: "no_valid_citation" }]);
    expect(out.readDroppedFindings).toEqual(out.droppedFindings);
    expect(out.unreadableFindings).toBe(1);
    expect(out.unreadableMaybeBlockers).toBe(1);
    // the broker reading a stored answer the worker did not retry (an older worker) reaches the same decision
    const stored = { ...made.result, reviewers: made.result.reviewers.map((r) => (r.role === "critic" ? { ...r, status: "answered" as const, failure: undefined, answer: lostAnswer } : r)) };
    const reread = assembleRoundFindings({ binding: made.binding, result: stored, verification: made.verification, packets: made.packets, pins: {} });
    expect(reread.reviewers[0]).toMatchObject({ counted: false, notUsed: "unreadable_output" });
    expect(reread.findings.flatMap((f) => f.rawIds)).toEqual(["codebase-3"]);
    expect(reread.droppedFindings).toEqual([{ rawId: "~critic-dropped-1", role: "critic", severity: "blocker", section: "§3", reason: "no_valid_citation" }]);
    expect(reread.readDroppedFindings).toEqual(reread.droppedFindings);
    expect(reread.unreadableFindings).toBe(1);
    expect(reread.unreadableMaybeBlockers).toBe(1);
  });

  it("a blocker that was lost becomes an open blocker on the card: no clean review, and approving needs a reason", async () => {
    const lost = block([finding("1"), finding("2", { severity: "blocker", section: "§5.2", citations: [] }), finding("3", { severity: "Critical" })]);
    const made = await round(["critic", "codebase"], { "slot-critic": [lost, lost], "slot-codebase": [block([finding("4")])] });
    const out = assembleRoundFindings({ binding: made.binding, result: made.result, verification: made.verification, packets: made.packets, pins: {} });
    expect(out.reviewers.every((r) => r.counted)).toBe(true);
    const own = lostBlockerFindings({ dropped: out.readDroppedFindings, unreadableMaybeBlockers: out.unreadableMaybeBlockers });
    expect(own.map((f) => [f.id, f.severity, f.section, f.origin])).toEqual([["rovara~lost-5", "blocker", "§5", "rovara"], ["rovara~lost-unread", "blocker", "§3", "rovara"]]);
    expect(own.map((f) => f.text).join(" ")).not.toMatch(/Critical|Problem/);
    const merged = withOwnFindings(out.findings, own);
    const hex = (seed: string) => seed.repeat(64).slice(0, 64);
    const runOf = (role: "critic" | "codebase") => ({ role, promptId: "p", promptVersion: 1, promptDigest: hex("a"), model: { provider: "anthropic", modelId: "m" }, sourceId: "s", sessionId: `ses-${role}`, modelKeyId: "k", packetDigest: hex("b"), packet: [], filesRead: [], verified: true, inputProof: "digest_only" as const, tokensIn: 1, tokensOut: 1, costUsd: 0.1, startedAt: "2026-11-03T10:00:00.000Z", endedAt: "2026-11-03T10:01:00.000Z" });
    const stored = DesignReviewRoundSchema.parse({ round: 1, designDigest: hex("c"), reviewers: [runOf("critic"), runOf("codebase")], findings: merged.findings, resolutions: [], droppedFindings: out.droppedFindings.map((d) => ({ role: d.role, severity: d.severity, section: d.section })), unreadableFindings: out.unreadableFindings });
    const review = { decidedBy: "auto" as const, reasons: [], status: "done" as const, tier: "standard" as const, spentUsd: 0.5, rounds: [stored] };
    const facts = designCardFactsOf(review, []);
    expect(facts.blockers).toHaveLength(2);
    expect(riskTierOf("approve_design", { design: { files: ["src/a.ts"], review: facts } }, {}).reasons).toContain("2 blockers are still open.");
    const decide = (blockerReason?: string) => decideDesignApproval({ openBlockers: facts.blockers.length, blockerReason });
    expect(decide()).toEqual({ ok: false, code: "reason_required" });
    expect(decide("Reviewed by hand")).toMatchObject({ ok: true, proofReason: "Reviewed by hand" });
    expect(designApprovalProofLine(facts.blockers.length, "Reviewed by hand")).toContain("2 open blockers");
    // control: the same round with nothing lost has no blocker, so the lost-blocker path is what raised them
    const clean = assembleRoundFindings({ binding: made.binding, result: (await round(["critic", "codebase"], { "slot-critic": [block([finding("1")])], "slot-codebase": [block([finding("4")])] })).result, verification: made.verification, packets: made.packets, pins: {} });
    expect(lostBlockerFindings({ dropped: clean.readDroppedFindings, unreadableMaybeBlockers: clean.unreadableMaybeBlockers })).toEqual([]);
  });

  it("a reviewer whose ONLY blocker was made unreadable still leaves an open blocker: the 2-of-3 round is not approvable without a reason", async () => {
    const hostile = block([{ id: "1", severity: "blocker", section: "§3", text: "The auth check is missing.", citations: [{ kind: "design", section: "§12" }] }]);
    const made = await round(["comprehension", "critic", "codebase"], { "slot-comprehension": [block([finding("1")], { proposes: "a", today: "b" })], "slot-critic": [hostile, hostile], "slot-codebase": [block([finding("2")])] });
    const out = assembleRoundFindings({ binding: made.binding, result: made.result, verification: made.verification, packets: made.packets, pins: {} });
    expect(out.reviewers.map((r) => [r.role, r.counted])).toEqual([["comprehension", true], ["critic", false], ["codebase", true]]);
    expect(out.readDroppedFindings).toEqual([{ rawId: "~critic-dropped-1", role: "critic", severity: "blocker", section: "§3", reason: "no_valid_citation" }]);
    const own = lostBlockerFindings({ dropped: out.readDroppedFindings, unreadableMaybeBlockers: out.unreadableMaybeBlockers });
    expect(own.map((f) => f.id)).toEqual(["rovara~lost-3"]);
    const hex = (seed: string) => seed.repeat(64).slice(0, 64);
    const runOf = (role: "comprehension" | "critic" | "codebase", verified: boolean) => ({ role, promptId: "p", promptVersion: 1, promptDigest: hex("a"), model: { provider: "anthropic", modelId: "m" }, sourceId: "s", sessionId: `ses-${role}`, modelKeyId: "k", packetDigest: hex("b"), packet: [], filesRead: [], verified, ...(verified ? { inputProof: "digest_only" as const } : { verifyFailure: "unreadable_output" as const }), tokensIn: 1, tokensOut: 1, costUsd: 0.1, startedAt: "2026-11-03T10:00:00.000Z", endedAt: "2026-11-03T10:01:00.000Z" });
    const stored = DesignReviewRoundSchema.parse({ round: 1, designDigest: hex("c"), reviewers: [runOf("comprehension", true), runOf("critic", false), runOf("codebase", true)], findings: withOwnFindings(out.findings, own).findings, resolutions: [] });
    const facts = designCardFactsOf({ decidedBy: "auto", reasons: [], status: "done", tier: "standard", spentUsd: 0.5, rounds: [stored] }, []);
    expect(facts.reviewers).toEqual({ planned: 3, verified: 2 });
    expect(facts.blockers).toHaveLength(1);
    const decide = (blockerReason?: string) => decideDesignApproval({ openBlockers: facts.blockers.length, blockerReason });
    expect(decide()).toEqual({ ok: false, code: "reason_required" });
    expect(decide("Checked the auth path by hand")).toMatchObject({ ok: true });
  });

  it("N5: a verified reviewer whose answer is missing or unreadable is not verified, and the round has no verified reviewer", async () => {
    const made = await round(["critic", "codebase"], { "slot-critic": [block([finding("1")])], "slot-codebase": [block([finding("2")])] });
    const unreadable = { ...made.result, reviewers: made.result.reviewers.map((r) => ({ ...r, answer: "no block here" })) };
    const out = assembleRoundFindings({ binding: made.binding, result: unreadable, verification: made.verification, packets: made.packets, pins: {} });
    expect(out.reviewers.every((r) => !r.verified && !r.counted && r.verifyFailure === "unreadable_output")).toBe(true);
    const missing = { ...made.result, reviewers: made.result.reviewers.map((entry) => ({ ...entry, answer: undefined })) };
    expect(assembleRoundFindings({ binding: made.binding, result: missing, verification: made.verification, packets: made.packets, pins: {} }).reviewers.every((r) => !r.verified)).toBe(true);
  });
});

describe("the binding and the feature", () => {
  const model = { provider: "p", modelId: "m" };
  const reviewer = (role: string, slot: string) => ({ role, keySlot: slot, packetDigest: "a".repeat(64), model });
  it("parses a binding, and refuses a repeated role, a repeated key slot, an unknown field and a model written by a reviewer-shaped extra", () => {
    expect(DesignReviewBindingSchema.safeParse({ version: 1, round: 1, reviewers: [reviewer("critic", "a"), reviewer("codebase", "b")] }).success).toBe(true);
    expect(DesignReviewBindingSchema.safeParse({ version: 1, round: 1, reviewers: [reviewer("critic", "a"), reviewer("critic", "b")] }).success).toBe(false);
    expect(DesignReviewBindingSchema.safeParse({ version: 1, round: 1, reviewers: [reviewer("critic", "a"), reviewer("codebase", "a")] }).success).toBe(false);
    expect(DesignReviewBindingSchema.safeParse({ version: 1, round: 1, reviewers: [{ ...reviewer("critic", "a"), tier: "light" }] }).success).toBe(false);
    expect(DesignReviewBindingSchema.safeParse({ version: 1, round: 1, reviewers: [reviewer("critic", "a")], merge: { keySlot: "a", model, prompt: { id: "m", version: 1, text: "t" } } }).success).toBe(false);
  });

  it("an invocation carries the binding only in plan-check mode, and the worker acts on it only then", () => {
    const base = { protocolVersion: 1, kind: "task", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const binding = { version: 1, round: 1, reviewers: [reviewer("critic", "a")] };
    const task = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ ...base, payload: { prompt: "x", conversationId: "33333333-3333-4333-8333-333333333333", conversationStarted: false, ...payload } });
    expect(task({ workflowMode: "PLAN_CRITIQUE", designReview: binding }).success).toBe(true);
    expect(task({ workflowMode: "PLAN", designReview: binding }).success).toBe(false);
    expect(task({ workflowMode: "PLAN_CRITIQUE" }).success).toBe(true);
    expect(designReviewBindingOf({ workflowMode: "PLAN_CRITIQUE" })).toBeUndefined();
    expect(designReviewBindingOf({ workflowMode: "PLAN_CRITIQUE", designReview: DesignReviewBindingSchema.parse(binding) })).toEqual(binding);
  });
});

describe("integration of the proof fixes", () => {
  const para = { proposes: "An endpoint.", today: "None." };

  it("broker side: rawFindings and inputProof survive the round assembly, a voided reviewer's raw findings are not merged, and the Light Critic is read with its paraphrase only for its prompt", async () => {
    const { binding, deliveries, packets } = await setup(["critic", "codebase"]);
    const answers = { "slot-critic": [block([finding("1", { severity: "blocker", text: "Retries are unbounded." })])], "slot-codebase": [block([finding("2", { text: "Retries have no limit." })])], merge: [mergeBlock([{ rawIds: ["critic-1", "codebase-2"], severity: "blocker", section: "§3", text: "Retries are unbounded." }])] };
    const result = await runDesignReview(binding, fakePorts({ answers }, deliveries).ports);
    const verification = new Map([
      ["critic" as const, { verified: true as const, sessionId: "s1", filesRead: [], inputProof: "proxy_first_call" as const }],
      ["codebase" as const, { verified: true as const, sessionId: "s2", filesRead: [], inputProof: "digest_only" as const }],
    ]);
    const round = assembleRoundFindings({ binding, result, verification, packets: new Map([...packets].map(([role, p]) => [role, p.items])), pins: {} });
    expect(round.reviewers.map((r) => [r.role, r.inputProof])).toEqual([["critic", "proxy_first_call"], ["codebase", "digest_only"]]);
    expect(round.mergeSource).toBe("model");
    expect(round.findings[0]!.rawFindings!.map((raw) => raw.text).sort()).toEqual(["Retries are unbounded.", "Retries have no limit."]);

    // the Light Critic's answer has a paraphrase: read with it only when the broker's packet for that role carried the Light prompt
    const light = await setup(["critic"], false, "light");
    const lightResult = await runDesignReview(light.binding, fakePorts({ answers: { "slot-critic": [block([finding("1")], para)] } }, light.deliveries).ports);
    const input = { binding: light.binding, result: lightResult, verification: new Map([["critic" as const, { verified: true as const, sessionId: "s", filesRead: [], inputProof: "digest_only" as const }]]), packets: new Map([["critic" as const, light.packets.get("critic")!.items]]), pins: {} };
    const withPrompt = assembleRoundFindings({ ...input, promptIds: new Map([["critic" as const, light.packets.get("critic")!.rolePrompt.id]]) });
    expect(withPrompt.reviewers[0]).toMatchObject({ counted: true, verified: true });
    expect(withPrompt.reviewers[0]!.paraphrase).toContain("An endpoint.");
    expect(assembleRoundFindings({ ...input, promptIds: new Map([["critic" as const, "design-review-critic"]]) }).reviewers[0]).toMatchObject({ counted: false, verified: false, verifyFailure: "unreadable_output", notUsed: "unreadable_output" });
    expect(assembleRoundFindings(input).reviewers[0]).toMatchObject({ counted: false, verified: false, verifyFailure: "unreadable_output", notUsed: "unreadable_output" });
  });
});

describe("a round whose every reviewer's model was not enabled, through the worker server", () => {
  it("ends the operation FAILED with modelFailureCode on its result (server.ts), from the reviewers' own coded errors", async () => {
    const { binding, deliveries } = await setup(["critic", "codebase"], false);
    // What a reviewer session throws for the proxy's 403 "not available for this account" (model-runtime's fixed sentence, classified by the worker).
    const refused = () => failedTurn({ stopReason: "error", errorMessage: "Anthropic request failed; the model is not available for this account", provider: "amazon-bedrock" })!;
    expect(modelFailureCodeOf(refused())).toBe(MODEL_NOT_ENABLED_CODE);
    const { ports } = fakePorts({ answers: { "slot-critic": [refused()], "slot-codebase": [refused()] } }, deliveries);
    const uploaded: string[] = [];
    const terminal: Array<Record<string, unknown>> = [];
    const state = createWorkerServerState(new OperationJournal(await mkdtemp(join(tmpdir(), "agentx-dr-terminal-"))), {
      execute: async () => { await runDesignReviewOperation({ binding, ports, artifactSink: async (artifact) => { uploaded.push(String(artifact.content)); } }); return undefined; },
    }, { onTerminal: async (result) => { terminal.push(result as unknown as Record<string, unknown>); } });
    const invocation: WorkerInvocation = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "Review the design" } };
    await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invocation) }), state);
    await vi.waitFor(() => expect(terminal).toHaveLength(1));
    expect(terminal[0]).toMatchObject({ status: "FAILED", result: { modelFailureCode: MODEL_NOT_ENABLED_CODE } });
    expect(String(terminal[0]!.error)).toContain("the model call failed: key-rejected ModelNotEnabled");
    // The round's result was uploaded first, with each reviewer's failure as the fixed code.
    expect((JSON.parse(uploaded[0]!) as { reviewers: Array<{ failure?: string }> }).reviewers.map((reviewer) => reviewer.failure)).toEqual(["model_not_enabled", "model_not_enabled"]);
  });
});
