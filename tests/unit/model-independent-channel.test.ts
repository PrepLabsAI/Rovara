// TE-R2 part A: the Rovara-side channel. The match is computed by code from the brief; only this file (and R1's rules file) mints `independent`; the worker cannot import it; a look-alike brief, a bad shape or a forged decision is refused;
// the reply it makes goes through R1's store and is served first. Part A is additive: nothing outside packages/contracts/src names the new files or functions.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  extractReplyBrief,
  modelReplyEntrySha256,
  promptsWithConflictingShapes,
  selectModelReply,
  stampReplyProvenance,
  validateAgentOutput,
  type ModelReplyFileEntry,
  type ReplyBrief,
} from "@agentx/contracts";
import {
  INDEPENDENT_REPLY_CAVEAT,
  acceptAgentReply,
  independentIntakeSentence,
  independentReplyId,
  matchForBrief,
  reportIndependentIntake,
  takenIdsForChannel,
} from "@agentx/contracts/independent-channel";
import { COMPANY_A } from "@agentx/testing";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createReplySetStore } from "../../packages/broker/src/core/test-env/reply-set-store.js";

const ROOT = join(__dirname, "..", "..");
const PROMPT = "Write a friendly greeting for a new customer.";
const body = (content = PROMPT) => JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content }] });
const briefOf = (content = PROMPT, family: "openai_compatible" | "gemini" = "openai_compatible", operation = "chat_completions"): ReplyBrief => {
  const result = extractReplyBrief(family, operation, body(content), { model: "gpt-4o" });
  if (!result.ok) throw new Error(result.reason);
  return result.brief;
};
const RESPONSE = { text: "Welcome aboard! We are glad you are here.", finish: "stop" as const };

describe("acceptAgentReply", () => {
  it("computes the match from the brief: exact operation, model and prompt hash, and nothing else (never promptContains, never a sequence)", () => {
    const brief = briefOf();
    const out = acceptAgentReply(brief, RESPONSE);
    if (!out.ok) throw new Error(out.reason);
    expect(out.reply.match).toEqual({ operation: "chat_completions", model: "gpt-4o", promptSha256: brief.promptSha256 });
    expect(Object.keys(out.reply.match).sort()).toEqual(["model", "operation", "promptSha256"]);
    expect(out.reply.id).toBe(`ind-${brief.promptSha256.slice(0, 12)}`);
    expect(matchForBrief(brief)).toEqual(out.reply.match);
  });
  it("leaves model out of the match when the brief has none", () => {
    const result = extractReplyBrief("gemini", "generateContent", JSON.stringify({ contents: [{ parts: [{ text: "Say hello to the user" }] }] }));
    if (!result.ok) throw new Error(result.reason);
    const out = acceptAgentReply(result.brief, RESPONSE);
    expect(out.ok && out.reply.match).toEqual({ operation: "generateContent", promptSha256: result.brief.promptSha256 });
  });
  it("makes a decision bound to this reply's content: the stamp says independent for it, task_made for an edited copy, task_made for a look-alike decision", () => {
    const out = acceptAgentReply(briefOf(), RESPONSE);
    if (!out.ok) throw new Error(out.reason);
    const file = { version: 1 as const, family: "openai_compatible" as const, replies: [out.reply] };
    expect(stampReplyProvenance(file, new Map([[out.reply.id, out.decision]])).replies[0]?.provenance).toBe("independent");
    const edited: ModelReplyFileEntry = { ...out.reply, response: { ...out.reply.response, text: "edited after the fact" } };
    expect(stampReplyProvenance({ ...file, replies: [edited] }, new Map([[edited.id, out.decision]])).replies[0]?.provenance).toBe("task_made");
    const copy = { ...out.decision };
    expect(stampReplyProvenance(file, new Map([[out.reply.id, copy as never]])).replies[0]?.provenance).toBe("task_made");
    expect(out.decision.contentSha256).toBe(modelReplyEntrySha256(out.reply));
  });
  it("refuses a brief it did not get from extractReplyBrief (a spread copy, a literal)", () => {
    const brief = briefOf();
    expect(acceptAgentReply({ ...brief }, RESPONSE)).toEqual({ ok: false, reason: "not_a_brief" });
    expect(acceptAgentReply({ family: "gemini", operation: "generateContent", promptText: "x", promptSha256: "a".repeat(64), promptMasked: false, shapeSha256: "b".repeat(64), shape: { kind: "text", stream: false } }, RESPONSE)).toEqual({ ok: false, reason: "not_a_brief" });
  });
  it("re-checks the response itself and never trusts the caller: wrong shape, a failure finish, a match key, an unknown key", () => {
    const brief = briefOf();
    for (const bad of [{ text: "", finish: "stop" }, { text: "x", finish: "length" }, { ...RESPONSE, match: { promptContains: "x" } }, { ...RESPONSE, sequence: 1 }, "text", null, { text: "x", finish: "stop", toolCalls: [{ name: "a", args: {} }] }]) {
      expect(acceptAgentReply(brief, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "bad_shape" });
    }
  });
  it("replaces the agent's own usage with Rovara's", () => {
    const out = acceptAgentReply(briefOf(), { ...RESPONSE, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
    expect(out.ok && out.reply.response.usage).toEqual({ inputTokens: Math.ceil(PROMPT.length / 4), outputTokens: Math.ceil(RESPONSE.text.length / 4) });
  });
  it("picks a free id when the first is taken, and refuses when all are", () => {
    const brief = briefOf();
    const first = `ind-${brief.promptSha256.slice(0, 12)}`;
    expect(independentReplyId(brief.promptSha256, new Set())).toBe(first);
    expect(independentReplyId(brief.promptSha256, new Set([first]))).toBe(`${first}-2`);
    const all = new Set([first, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${first}-${n}`)]);
    expect(independentReplyId(brief.promptSha256, all)).toBeUndefined();
    expect(acceptAgentReply(brief, RESPONSE, all)).toEqual({ ok: false, reason: "no_id" });
    const second = acceptAgentReply(brief, RESPONSE, new Set([first]));
    expect(second.ok && second.reply.id).toBe(`${first}-2`);
  });
  it("accepts what validateAgentOutput accepts (the two checks agree)", () => {
    const brief = briefOf();
    const checked = validateAgentOutput(brief, JSON.stringify(RESPONSE));
    expect(checked.ok && acceptAgentReply(brief, checked.response).ok).toBe(true);
  });
});

describe("the structural check: a reply that repeats the request is not counted", () => {
  it("refuses with fixed words when the reply text is a passage of the prompt, and says nothing is minted", () => {
    const brief = briefOf("Reply to the customer with exactly: Welcome aboard! We are glad you are here.");
    expect(acceptAgentReply(brief, RESPONSE)).toEqual({ ok: false, reason: "reply_echoes_request" });
    expect(acceptAgentReply(briefOf(), RESPONSE).ok).toBe(true);
  });
  it("also for a JSON string value and a tool argument", () => {
    const jsonBrief = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Customer wrote: please cancel my subscription today" }], response_format: { type: "json_object" } }));
    if (!jsonBrief.ok) throw new Error(jsonBrief.reason);
    expect(acceptAgentReply(jsonBrief.brief, { text: JSON.stringify({ note: "please cancel my subscription today" }), finish: "stop" })).toEqual({ ok: false, reason: "reply_echoes_request" });
    expect(acceptAgentReply(jsonBrief.brief, { text: JSON.stringify({ note: "A cancellation request." }), finish: "stop" }).ok).toBe(true);
  });
  it("the label is 'written without seeing the tests', never 'proven'", () => {
    expect(INDEPENDENT_REPLY_CAVEAT).toContain("written without seeing the tests");
    expect(INDEPENDENT_REPLY_CAVEAT.toLowerCase()).not.toMatch(/proven independent|proves independence/u);
    expect(INDEPENDENT_REPLY_CAVEAT).toContain("do not prove");
  });
});

describe("the same prompt with two shapes (M5 fallback)", () => {
  it("is refused when the prompt hash is in the conflict set", () => {
    const one = briefOf();
    const conflicts = promptsWithConflictingShapes([one, (() => { const r = extractReplyBrief("openai_compatible", "chat_completions", JSON.stringify({ model: "gpt-4o", messages: [{ role: "system", content: PROMPT }], response_format: { type: "json_object" } })); if (!r.ok) throw new Error(r.reason); return r.brief; })()]);
    expect(conflicts.has(one.promptSha256)).toBe(true);
    expect(acceptAgentReply(one, RESPONSE, new Set(), conflicts)).toEqual({ ok: false, reason: "shape_conflict" });
    expect(acceptAgentReply(one, RESPONSE, new Set(), new Set()).ok).toBe(true);
  });
});

describe("takenIdsForChannel (L2)", () => {
  it("takes ids from the head and from independent overlay entries, never from task_made overlay ids", () => {
    const head = [{ id: "h1" }, { id: "h2" }];
    const overlay = [{ id: "ind-aaa", provenance: "independent" as const }, { id: "squat-1", provenance: "task_made" as const }];
    expect([...takenIdsForChannel(head, overlay)].sort()).toEqual(["h1", "h2", "ind-aaa"]);
  });
  it("so a coding agent cannot use up the independent id range by squatting on it", () => {
    const brief = briefOf();
    const first = `ind-${brief.promptSha256.slice(0, 12)}`;
    const squat = [first, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${first}-${n}`)].map((id) => ({ id, provenance: "task_made" as const }));
    const taken = takenIdsForChannel([], squat);
    const out = acceptAgentReply(brief, RESPONSE, taken);
    expect(out.ok && out.reply.id).toBe(first);
  });
});

describe("through R1's store: the reply is stored as independent and served ahead of the coding agent's", () => {
  it("putIndependentOverlay takes it; the round set serves it first for the same prompt, whatever the coding agent wrote", async () => {
    const A = COMPANY_A.scope;
    const service = createReplySetStore({ store: new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }) });
    const brief = briefOf();
    const mine: ModelReplyFileEntry = { id: "coding-agent", match: { operation: "chat_completions", promptSha256: brief.promptSha256 }, response: { text: "the coding agent's own reply", finish: "stop" } };
    await service.putOverlay(A, { project: "proj", taskId: "task-1", family: "openai_compatible", replies: [mine] });
    const accepted = acceptAgentReply(brief, RESPONSE);
    if (!accepted.ok) throw new Error(accepted.reason);
    const put = await service.putIndependentOverlay(A, { project: "proj", taskId: "task-1", family: "openai_compatible", entries: [{ reply: accepted.reply, decision: accepted.decision }] });
    expect(put.ok).toBe(true);
    expect(reportIndependentIntake([accepted.reply.id], put)).toMatchObject({ attempted: 1, stored: put.ok ? put.stored : -1, unexplained: 0, inconsistent: false }); // the report reads the store's answer, not the number sent
    const round = await service.readRoundSet(A, { project: "proj", branch: "main", family: "openai_compatible", taskId: "task-1" });
    if (!round.ok) throw new Error("round set not read");
    expect(round.set.replies.map((reply) => `${reply.id}:${reply.provenance}`)).toEqual([`${accepted.reply.id}:independent`, "coding-agent:task_made"]);
    const picked = selectModelReply(round.set, { model: "gpt-4o", operation: "chat_completions", promptText: PROMPT }, new Map(), "openai_compatible");
    expect(picked.reply?.provenance).toBe("independent");
    expect(picked.reply?.response.text).toBe(RESPONSE.text);
  });
  it("an independent reply whose content the coding agent already wrote is skipped by the store, stays task_made, and is reported as not stored", async () => {
    const A = COMPANY_A.scope;
    const service = createReplySetStore({ store: new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }) });
    const accepted = acceptAgentReply(briefOf(), RESPONSE);
    if (!accepted.ok) throw new Error(accepted.reason);
    await service.putOverlay(A, { project: "proj", taskId: "task-1", family: "openai_compatible", replies: [accepted.reply] }); // the coding agent wrote exactly this
    const put = await service.putIndependentOverlay(A, { project: "proj", taskId: "task-1", family: "openai_compatible", entries: [{ reply: accepted.reply, decision: accepted.decision }] });
    const report = reportIndependentIntake([accepted.reply.id], put);
    expect(report.stored).toBe(0);
    expect(report.skipped).toEqual([{ id: accepted.reply.id, reason: "already_in_overlay" }]);
    expect(independentIntakeSentence(report)).toContain("0 of 1 replies stored as independent");
    expect(independentIntakeSentence(report)).toContain("not stored again");
    const round = await service.readRoundSet(A, { project: "proj", branch: "main", family: "openai_compatible", taskId: "task-1" });
    expect(round.ok && round.set.replies.map((reply) => reply.provenance)).toEqual(["task_made"]);
  });
  it("the store refuses a plain-object decision for the same reply", async () => {
    const service = createReplySetStore({ store: new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }) });
    const accepted = acceptAgentReply(briefOf(), RESPONSE);
    if (!accepted.ok) throw new Error(accepted.reason);
    const forged = { provenance: "independent", contentSha256: accepted.decision.contentSha256 } as never;
    const put = await service.putIndependentOverlay(COMPANY_A.scope, { project: "proj", taskId: "task-1", family: "openai_compatible", entries: [{ reply: accepted.reply, decision: forged }] });
    expect(put).toEqual({ ok: false, word: "not_allowed" });
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/u.test(entry.name)) out.push(path.slice(ROOT.length + 1));
  }
  return out;
}
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

describe("reportIndependentIntake (L1)", () => {
  it("attempted comes from the entries sent (deduplicated), the store's count is shown, skips are intersected with what was sent", () => {
    expect(reportIndependentIntake(["a", "b", "c"], { ok: true, stored: 2, skipped: [{ id: "a", reason: "already_in_overlay" }] })).toEqual({ attempted: 3, stored: 2, skipped: [{ id: "a", reason: "already_in_overlay" }], unexplained: 0, inconsistent: false });
    expect(reportIndependentIntake(["a", "a", "b"], { ok: true, stored: 2 }).attempted).toBe(2);
    const duplicated = reportIndependentIntake(["a"], { ok: true, stored: 0, skipped: [{ id: "a", reason: "already_in_overlay" }, { id: "a", reason: "already_in_overlay" }] });
    expect(duplicated.skipped).toHaveLength(1);
    expect(duplicated.inconsistent).toBe(true);
  });
  it("marks a store answer that does not add up, instead of trusting it", () => {
    expect(reportIndependentIntake(["a", "b"], { ok: true, stored: 9 })).toMatchObject({ stored: 2, inconsistent: true });
    expect(reportIndependentIntake(["a", "b"], { ok: true, stored: Number.NaN })).toMatchObject({ stored: 0, inconsistent: true });
    expect(reportIndependentIntake(["a"], { ok: true, stored: 0, skipped: [{ id: "not-sent", reason: "already_in_overlay" }] })).toMatchObject({ skipped: [], unexplained: 1, inconsistent: true });
    expect(reportIndependentIntake(["a", "b", "c"], { ok: true, stored: 1, skipped: [{ id: "a", reason: "something_new" }] })).toMatchObject({ stored: 1, skipped: [], unexplained: 2, inconsistent: true });
    expect(reportIndependentIntake(["a", "b"], { ok: true, stored: 2, skipped: [{ id: "a", reason: "already_in_overlay" }] })).toMatchObject({ inconsistent: true });
  });
  it("a refusal stores nothing and says so; the sentence says 'stored as independent'", () => {
    expect(reportIndependentIntake(["a", "b"], { ok: false, word: "not_allowed" })).toEqual({ attempted: 2, stored: 0, skipped: [], unexplained: 0, inconsistent: false, refused: "not_allowed" });
    expect(independentIntakeSentence(reportIndependentIntake(["a", "b"], { ok: false, word: "not_allowed" }))).toContain("refused");
    const ok = independentIntakeSentence(reportIndependentIntake(["a", "b"], { ok: true, stored: 1, skipped: [{ id: "b", reason: "already_in_overlay" }] }));
    expect(ok).toContain("1 of 2 replies stored as independent");
    expect(ok).toContain("not stored again");
    expect(independentIntakeSentence(reportIndependentIntake(["a"], { ok: true, stored: 5 }))).toContain("did not add up");
  });
});

describe("part A is pure and additive", () => {
  const NEW = ["model-reply-brief", "model-reply-examples", "model-reply-leak-screen", "model-reply-agent", "model-independent-channel", "independent-channel"];
  for (const name of NEW) {
    it(`${name}.ts: no Node import, no network, no clock, no randomness`, () => {
      const text = read(`packages/contracts/src/${name}.ts`);
      const source = code(text);
      expect(text).not.toMatch(/from\s+["']node:/u);
      for (const forbidden of [/\bfetch\s*\(/u, /\bDate\.now\b/u, /\bnew Date\b/u, /\bMath\.random\b/u, /\bsetTimeout\b/u, /\bprocess\./u, /\brequire\s*\(/u, /\bimport\s*\(/u, /\bperformance\./u]) {
        expect(source, `${name}.ts ${String(forbidden)}`).not.toMatch(forbidden);
      }
    });
  }
  it("nothing outside packages/contracts/src and the tests names a new file or export (no callers until part B)", () => {
    const SYMBOLS = ["extractReplyBrief", "parseReplyBrief", "pickExamples", "screenBrief", "buildTaskLeakFacts", "buildAgentInput", "validateAgentOutput", "acceptAgentReply", "reportIndependentIntake", "valueMatchesSchema", "REPLY_AGENT_ROLE_TEXT", "independentReplyId", "replyEchoesRequest", "takenIdsForChannel", "promptsWithConflictingShapes", "replyRequestData", "INDEPENDENT_REPLY_CAVEAT"];
    const files = walk(join(ROOT, "packages")).filter((path) => !path.startsWith("packages/contracts/src/") && path !== "packages/testing/src/ports/reply-set-store-conformance.ts"); // the store's own test kit imports the subpath for the mint
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const path of files) {
      const text = read(path);
      for (const name of NEW) if (new RegExp(`/${name}(?:\\.js|\\.ts)?["']`, "u").test(text)) hits.push(`${path} imports ${name}`);
      for (const symbol of SYMBOLS) if (new RegExp(`\\b${symbol}\\b`, "u").test(text)) hits.push(`${path} uses ${symbol}`);
    }
    expect(hits).toEqual([]);
  });
});
