// L4-EVC (DEC 254zzz20 D5, D6, D8): the eval's ONE setup card. One approval in plain dollars (the confirm and the spend approval in one act, through the existing approvers); a changed eval set rides on the
// earlier approval while it stays inside the approved limit, and asks again (with its reason) when it does not; the health run is opt-in. Every guard has a named mutant in
// briefs/lead4/L4-EVC-MUTANTS-20261118.md, each broken by hand and seen to fail one of these tests.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvalDiscoveryConfirmBodySchema, EvalSpendApprovalRecordSchema, evalCommandFingerprintOf, evalQuestionHash, type Principal } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { dollarRangeOf, dollarsOf, evalDollarsOf } from "../../packages/broker/src/core/setup-agent/eval-cost.js";
import { readEvalCard } from "../../packages/broker/src/core/setup-agent/eval-card.js";
import { readEvalDiscovery } from "../../packages/broker/src/core/setup-agent/eval-discovery.js";
import { evalHealthState, finishEvalHealthRequest, readEvalHealthRequest, requestEvalHealthCheck } from "../../packages/broker/src/core/setup-agent/eval-health-request.js";
import { evalSpendKey, proposeEvalSpendApproval, readApprovedEvalPlan } from "../../packages/broker/src/core/setup-agent/eval-spend.js";
import { A, B, CAP, COST_PER_CASE, MODEL, NOW, ROLES, VERSION, command, company, filesOf, person, project, reportOf, reportPath, type Role } from "../support/eval-card-world.js";

describe("the dollars on the card", () => {
  it("never goes above the approved per-check ceiling and says 'under $0.01' for a figure too small to show", () => {
    // 100 cases at $0.10 cost $30 for the three runs, so the confirm's ceiling is that estimate ($30), and a check is never shown above it.
    const capped = evalDollarsOf({ questions: 100, costMicrosPerQuestion: COST_PER_CASE, maximumMicros: 30_000_000, monthlyCapMicros: CAP })!;
    expect(capped).toEqual({ perCheckLowMicros: 10_000_000, perCheckHighMicros: 30_000_000, monthlyCapMicros: CAP });
    // A ceiling below the natural high is the high; a ceiling below one run is no card at all.
    expect(evalDollarsOf({ questions: 2, costMicrosPerQuestion: COST_PER_CASE, maximumMicros: 1_000_000, monthlyCapMicros: CAP })!.perCheckHighMicros).toBe(1_000_000);
    expect(evalDollarsOf({ questions: 2, costMicrosPerQuestion: COST_PER_CASE, maximumMicros: 100_000, monthlyCapMicros: CAP })).toBeUndefined();
    expect(dollarsOf(4_000_000)).toBe("$4.00");
    expect(dollarRangeOf(20, 180)).toBe("under $0.01");
    expect(dollarRangeOf(20, 50_000)).toBe("up to $0.05");
  });
  it("refuses a figure that is not a whole positive number", () => {
    for (const bad of [{ questions: 0 }, { costMicrosPerQuestion: 1.5 }, { maximumMicros: -1 }, { monthlyCapMicros: Number.NaN }]) {
      expect(evalDollarsOf({ questions: 2, costMicrosPerQuestion: COST_PER_CASE, maximumMicros: 4_000_000, monthlyCapMicros: CAP, ...bad })).toBeUndefined();
    }
  });
});

describe("one approval (D8)", () => {
  it.each(["owner", "admin", "maintainer"])("%s confirms the eval and approves its spend in one act, bound to the dollars they saw", async who => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    const answer = await r.approve(person(A, who));
    expect(w.approved).toHaveLength(1);
    expect(answer.evalSpend).toMatchObject({ state: "approved", label: "Run your evals on each AI change", budget: "about $0.20-$1.80 per PR, at most $50.00 a month." });
    const record = (await w.record())!;
    expect(EvalSpendApprovalRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({ state: "approved", approvedBy: { personId: who }, setupRevision: 7, plan: { dollars: { perCheckLowMicros: 200_000, perCheckHighMicros: 1_800_000, monthlyCapMicros: CAP } } });
    expect((await readApprovedEvalPlan({ store: w.store, companyId: A }, project))?.plan.selection).toBe("evals/demo");
  });
  it.each(["member", "contributor", "revoked"])("%s may neither confirm nor approve: nothing is marked, kept or approved", async who => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    await expect(r.approve(person(A, who))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.approved).toEqual([]);
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))?.state).toBe("reported");
  });
  it("a yes that was shown different dollars is refused before anything is marked (the card said one thing, the broker holds another)", async () => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    for (const seen of [{ perCheckHighMicros: 1_799_999, monthlyCapMicros: CAP }, { perCheckHighMicros: 1_800_000, monthlyCapMicros: CAP + 1 }, { perCheckHighMicros: 900_000, monthlyCapMicros: CAP }]) {
      await expect(r.approve(person(A, "admin"), { seen })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    }
    expect(w.approved).toEqual([]);
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))?.state).toBe("reported");
  });
  it("a body that approves must name what it saw, and a body that names it must approve", () => {
    const base = { taskId: "t".repeat(8), reportDigest: "a".repeat(64), selection: "s", paths: ["a.txt"] };
    expect(EvalDiscoveryConfirmBodySchema.safeParse(base).success).toBe(true);
    expect(EvalDiscoveryConfirmBodySchema.safeParse({ ...base, approve: true }).success).toBe(false);
    expect(EvalDiscoveryConfirmBodySchema.safeParse({ ...base, seen: { perCheckHighMicros: 1, monthlyCapMicros: 1 } }).success).toBe(false);
    expect(EvalDiscoveryConfirmBodySchema.safeParse({ ...base, approve: true, seen: { perCheckHighMicros: 1, monthlyCapMicros: 1 } }).success).toBe(true);
    expect(EvalDiscoveryConfirmBodySchema.safeParse({ ...base, approve: false, seen: { perCheckHighMicros: 1, monthlyCapMicros: 1 } }).success).toBe(false);
  });
  it("a host with no approval path refuses a body that asks to approve, before anything is read or marked", async () => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    await expect(r.approve(person(A, "admin"), {}, { approve: undefined })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await w.store.get(evalSpendKey(A, project))).toBeUndefined();
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))?.state).toBe("reported");
  });
  it("a refused approval step puts the report back to 'reported' so the person can approve again, and the second try approves the same waiting item", async () => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    await expect(r.approve(person(A, "admin"), {}, { approve: async () => { throw new Error("refused:sign_in_not_fresh"); } })).rejects.toThrow("sign_in_not_fresh");
    expect((await readEvalDiscovery({ store: w.store, companyId: A }, project))?.state).toBe("reported");
    const waiting = (await w.record())!;
    expect(waiting.state).toBe("waiting");
    await r.approve(person(A, "admin"));
    expect((await w.record())).toMatchObject({ state: "approved", digest: waiting.digest, revision: waiting.revision });
  });
  it("the card after approval shows the approved dollars and the opt-in health button with its cost", async () => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf());
    await r.approve();
    const after = await readEvalCard({ store: w.store, companyId: A, members: w.members, monthlyCap: async () => CAP, healthRuns: true }, project, person(A, "admin"));
    expect(after.spend).toMatchObject({ state: "approved", perPr: "about $0.20-$1.80", monthly: "$50.00" });
    expect(after.health).toMatchObject({ state: "none", label: "Check my evals now (about $0.60)", cost: "$0.60", seenCostMicros: 600_000 });
  });
});

describe("a changed eval set (D6)", () => {
  async function approvedOnce(over: { cap?: number } = {}) {
    const w = company(A); if (over.cap !== undefined) w.state.cap = over.cap;
    const first = await w.run(filesOf(2), reportOf(2));
    await first.approve();
    const before = (await w.record())!;
    return { w, first, before };
  }
  it("edited cases that stay inside the approved limit ride on the earlier approval: no new approval, the same approver, the new questions' hashes", async () => {
    const { w, before } = await approvedOnce();
    const second = await w.run(filesOf(2, { "evals/demo/q1.txt": "question q1, reworded\n" }), reportOf(2));
    const answer = await second.approve(person(A, "owner"));
    expect(w.approved).toHaveLength(1);
    expect(answer.evalSpend).toMatchObject({ state: "approved", card: { carried: true } });
    const after = (await w.record())!;
    expect(after).toMatchObject({ state: "approved", carriedFrom: before.revision, revision: before.revision + 1, approvedBy: before.approvedBy });
    expect(after.plan.inputs.evalSetHash).not.toBe(before.plan.inputs.evalSetHash);
    expect(after.plan.budget).toEqual(before.plan.budget);
    expect(after.plan.dollars).toEqual(before.plan.dollars);
    const found = await readApprovedEvalPlan({ store: w.store, companyId: A }, project);
    expect(found?.plan.questions.find(q => q.id === "q1")?.hash).toBe(evalQuestionHash(Buffer.from("question q1, reworded\n")));
  });
  it("a set that grew past the approved limit asks again: the eval reads 'Needs approval: your eval set grew past the approved $X' and its spend stops until a new card is approved", async () => {
    const { w } = await approvedOnce();
    const second = await w.run(filesOf(3), reportOf(3));
    const preview = (await second.card()).suites[0]!;
    expect(preview.versusApproved).toEqual({ within: false, words: "Needs approval: your eval set grew past the approved $1.80" });
    const answer = await second.confirmOnly();
    expect(answer.evalSpend).toMatchObject({ state: "waiting", card: { needsApproval: "Needs approval: your eval set grew past the approved $1.80", perPr: "about $0.30-$2.70" } });
    expect(await readApprovedEvalPlan({ store: w.store, companyId: A }, project)).toBeUndefined();
    expect(w.approved).toHaveLength(1);
    const card = await readEvalCard({ store: w.store, companyId: A, members: w.members, monthlyCap: async () => CAP }, project, person(A, "admin"));
    expect(card.spend).toMatchObject({ state: "waiting", needsApproval: "Needs approval: your eval set grew past the approved $1.80" });
  });
  it("more calls than the approved ceiling ask again even when the dollars stay small (calls are held to the approved ceiling too)", async () => {
    const { w } = await approvedOnce();
    // 30 cases at 20 calls and a micro-dollar each: the dollars are tiny and inside the approved high figure, the calls (1,800) are past the approved 400.
    const second = await w.run(filesOf(30), reportOf(30, { maxCallsPerQuestion: 20, maxCostMicrosPerQuestion: 1 }));
    const preview = (await second.card()).suites[0]!;
    expect(preview.seen.perCheckHighMicros).toBeLessThan(1_800_000);
    expect(preview.versusApproved).toMatchObject({ within: false });
    const answer = await second.confirmOnly();
    expect(answer.evalSpend).toMatchObject({ state: "waiting", card: { needsApproval: "Needs approval: your eval set grew past the approved $1.80" } });
    expect(w.approved).toHaveLength(1);
  });
  it.each([
    ["the judge's scoring file changed", filesOf(2, { "evals/demo/score.txt": "score: a different rule\n" }), reportOf(2)],
    ["the model changed", filesOf(2), reportOf(2, { model: "gemini-2.5-pro", modelVersion: "gemini-2.5-pro-001" })],
    ["the command changed", filesOf(2), (() => { const c = { ...command, args: ["evals/run.js", "--fast", "--out", "rovara-measures.json"] }; return reportOf(2, { command: c, commandFingerprint: evalCommandFingerprintOf(c, reportPath) }); })()],
  ])("%s: not an edit to the cases, so it asks again and says why", async (_name, files, report) => {
    const { w } = await approvedOnce();
    const second = await w.run(files, report);
    const answer = await second.confirmOnly();
    expect(answer.evalSpend).toMatchObject({ state: "waiting", card: { needsApproval: "Needs approval: the model, judge or command of your eval changed" } });
    expect(await readApprovedEvalPlan({ store: w.store, companyId: A }, project)).toBeUndefined();
  });
  it("an approval whose approver may no longer approve is not carried", async () => {
    const roles: Record<string, Role> = { ...ROLES, ada: { company: "admin" }, bob: { company: "admin" } };
    const w = company(A, roles);
    const first = await w.run(filesOf(2), reportOf(2));
    await first.approve(person(A, "ada"));
    roles["ada"] = { company: "member" };
    const second = await w.run(filesOf(2, { "evals/demo/q1.txt": "edited\n" }), reportOf(2));
    const answer = await second.confirmOnly(person(A, "bob"));
    expect(answer.evalSpend?.state).toBe("waiting");
    expect((await w.record())?.carriedFrom).toBeUndefined();
    expect((await w.record())?.asksAgain).toBeUndefined();
  });
  it("an item approved before dollars existed is never carried", async () => {
    const w = company(A);
    const inputs = { evalSetHash: "1".repeat(64), judgePin: "2".repeat(64), modelVersion: VERSION, model: MODEL, catalogRowId: "gemini", commandFingerprint: "3".repeat(64), settingsFingerprint: "4".repeat(64) };
    const table = { store: w.store, companyId: A, members: w.members, monthlyCapMicros: CAP };
    const legacy = await proposeEvalSpendApproval(table, project, { selection: "evals/demo", inputs, estimate: { calls: 12, costMicros: 600_000 } });
    expect(legacy.plan.dollars).toBeUndefined();
    await w.decide({ requestId: `eval-${legacy.digest.slice(0, 40)}-${legacy.revision}`, revision: legacy.revision, artifactDigest: legacy.digest }, person(A, "admin"));
    expect((await w.record())?.state).toBe("approved");
    const again = await proposeEvalSpendApproval(table, project, { selection: "evals/demo", inputs: { ...inputs, evalSetHash: "9".repeat(64) }, estimate: { calls: 12, costMicros: 600_000 }, dollars: { perCheckLowMicros: 200_000, perCheckHighMicros: 1_800_000, monthlyCapMicros: CAP } });
    expect(again.state).toBe("waiting");
    expect(again.carriedFrom).toBeUndefined();
  });
});

describe("two companies", () => {
  it("a person of company B can neither confirm nor approve company A's eval, and B's card shows nothing of A's", async () => {
    const store = new MemoryDocumentStore();
    const a = company(A, { ...ROLES }, store); const b = company(B, { ...ROLES }, store);
    const ra = await a.run(filesOf(2), reportOf(2));
    await expect(ra.approve(person(B, "admin"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await store.get(evalSpendKey(A, project))).toBeUndefined();
    await ra.approve(person(A, "admin"));
    const card = await readEvalCard({ store, companyId: B, members: b.members, monthlyCap: async () => CAP }, project, person(B, "admin"));
    expect(card.state).toBe("none"); expect(card.spend).toBeUndefined(); expect(card.suites).toEqual([]); expect(card.report).toBeUndefined();
    expect(await requestEvalHealthCheck({ store, companyId: B, now: () => NOW, members: b.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000 }, person(B, "admin")).catch(e => (e as { code: string }).code)).toBe("CHANGE_STALE");
  });
});

describe("the health run is opt-in (D5)", () => {
  const ask = (w: ReturnType<typeof company>, as: Principal = person(A, "admin"), body: Record<string, unknown> = {}) =>
    requestEvalHealthCheck({ store: w.store, companyId: A, now: () => NOW, members: w.members }, project, { requestId: randomUUID(), seenCostMicros: 600_000, ...body }, as);
  const reader = (w: ReturnType<typeof company>) => readEvalHealthRequest({ store: w.store, companyId: A, members: w.members }, project);
  async function approved() { const w = company(A); const r = await w.run(filesOf(2), reportOf(2)); await r.approve(); return { w, r }; }
  it("a yes records one request with the cost the person was shown, and the runner reads it", async () => {
    const { w } = await approved();
    const id = randomUUID();
    expect(await ask(w, person(A, "maintainer"), { requestId: id })).toEqual({ requested: true, duplicate: false, cost: "$0.60" });
    expect(await reader(w)).toMatchObject({ requestId: id, estimateMicros: 600_000, state: "requested", requestedBy: { personId: "maintainer", role: "maintainer" } });
    expect(await evalHealthState({ store: w.store, companyId: A, members: w.members }, project)).toBe("requested");
    expect(await ask(w, person(A, "maintainer"), { requestId: id })).toMatchObject({ duplicate: true });
    await expect(ask(w)).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("is refused without an approved spend, for a person who may not approve it, for a stale cost and for another company", async () => {
    const w = company(A); const r = await w.run(filesOf(2), reportOf(2));
    await expect(ask(w)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await r.confirmOnly();
    await expect(ask(w)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    const o = await approved();
    for (const who of ["member", "contributor", "revoked", "auditor"]) await expect(ask(o.w, person(A, who))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ask(o.w, person(A, "admin"), { seenCostMicros: 599_999 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(ask(o.w, person(B, "admin"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ask(o.w, person(A, "admin"), { requestId: "not-a-uuid" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await reader(o.w)).toBeUndefined();
  });
  it("a request is void once the approval it was made under is replaced (an eval that grew asks again), and the runner no longer reads it", async () => {
    const { w } = await approved();
    await ask(w);
    expect(await reader(w)).toBeDefined();
    const bigger = await w.run(filesOf(3), reportOf(3));
    await bigger.confirmOnly();
    expect(await reader(w)).toBeUndefined();
    expect(await evalHealthState({ store: w.store, companyId: A, members: w.members }, project)).toBe("none");
  });
  it("the runner finishes a request once, by its own id", async () => {
    const { w } = await approved();
    const id = randomUUID(); await ask(w, person(A, "admin"), { requestId: id });
    expect(await finishEvalHealthRequest({ store: w.store, companyId: A }, project, randomUUID())).toBe(false);
    expect(await finishEvalHealthRequest({ store: w.store, companyId: A }, project, id)).toBe(true);
    expect(await finishEvalHealthRequest({ store: w.store, companyId: A }, project, id)).toBe(false);
    expect(await reader(w)).toBeUndefined();
    expect(await evalHealthState({ store: w.store, companyId: A, members: w.members }, project)).toBe("finished");
    // Saying yes again after a finished one makes a new request.
    // A stale retry of the finished click is the same answer and queues nothing again.
    expect(await ask(w, person(A, "admin"), { requestId: id })).toMatchObject({ requested: true, duplicate: true });
    expect(await reader(w)).toBeUndefined();
    expect(await ask(w)).toMatchObject({ requested: true, duplicate: false });
  });
});

// L4-T3 (G2, G3): the card names the AI provider the evals call, from what discovery found, and says whether the company's own connection to it stands (the bound adapter's answer, the one the spend gate's
// authority rests on). Unknown (a laptop, a gateway that does not say) says neither. Mutants: briefs/lead4/l4-t3/MUTANTS.md.
describe("the eval card names the provider and its connection (L4-T3)", () => {
  const read = (w: ReturnType<typeof company>, providerConnected: ((scope: { company: string; project: string }) => Promise<boolean | undefined>) | undefined, role = "admin", companyId: string = A) =>
    readEvalCard({ store: w.store, companyId, members: w.members, monthlyCap: async () => CAP, ...(providerConnected === undefined ? {} : { providerConnected }) }, project, person(companyId, role));
  it.each([["gemini", "Google Gemini"], ["vertex", "Vertex AI"]])("a reported %s eval says it calls %s, before and after the approval", async (row, label) => {
    const w = company(A); const run = await w.run(filesOf(2), reportOf(2, { catalogRowId: row }));
    const before = await read(w, async () => false);
    expect(before).toMatchObject({ state: "propose", provider: label, connected: false }); expect(before.suites[0]).toMatchObject({ provider: label });
    await run.approve();
    expect(await read(w, async () => false)).toMatchObject({ state: "approved", provider: label, connected: false });
    expect(await read(w, async () => true)).toMatchObject({ state: "approved", provider: label, connected: true });
  });
  it.each([["no source (a laptop)", undefined], ["no answer", async () => undefined], ["a fault", async () => { throw new Error("private gateway detail"); }], ["a non-boolean", async () => "yes" as never]])("%s: `connected` is absent, the provider is still named, and nothing leaks", async (_name, source) => {
    const w = company(A); await w.run(filesOf(2), reportOf(2));
    const card = await read(w, source);
    expect(card.provider).toBe("Google Gemini"); expect(card).not.toHaveProperty("connected"); expect(JSON.stringify(card)).not.toContain("private gateway detail");
  });
  it("a rejected eval says nothing about a provider or a connection (there is nothing to connect for)", async () => {
    const w = company(A); const run = await w.run(filesOf(2), reportOf(2)); await run.approve();
    const raw = (await w.store.get(evalSpendKey(A, project)))!; const { approvedBy: _gone, ...rest } = raw as Record<string, unknown>; void _gone;
    await w.store.put({ item: { ...rest, state: "rejected" } as never });
    const card = await read(w, async () => false);
    expect(card.state).toBe("rejected"); expect(card).not.toHaveProperty("provider"); expect(card).not.toHaveProperty("connected");
  });
});
