// TE-F10: the run: old and new calls through the model-egress port (fake adapter), the not-run classes per side, the overrun stop, the caps, the two meters, no socket, and two companies kept apart.
import { describe, expect, it } from "vitest";
import {
  capSentence, modelOutputText, MODEL_EGRESS_OVERRUN_SENTENCE, NOT_RUN_SENTENCES, runSideBySide, SIDE_BY_SIDE_DEFAULT_CALL_CAP, type ModelEgress, type ModelEgressEvent, type ModelEgressSettle, type SideBySideRunInput, type SideBySideRunResult, type SideBySideSummary,
} from "../../packages/contracts/src/index.js";
import { withNetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { twoCompanyChecks, type IsolationSurface, type TwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { RUN_DEFAULTS, canary, COMPANY_A, COMPANY_B, evalCases, geminiBody, recordingJudge, reportNeeded, sbsWorld, source, verdictText } from "../support/side-by-side-world.js";

const policy = { preset: "careful", aiPilot: false, optIn: false } as const;
const enc = (text: string) => new TextEncoder().encode(text);

function ran(result: SideBySideRunResult): SideBySideSummary {
  expect(result.status).toBe("ran");
  if (result.status !== "ran") throw new Error("expected a run");
  return result.summary;
}
/** Wraps an adapter and counts the calls it was handed. */
function counting(inner: ModelEgress): ModelEgress & { calls: number } {
  const held = { calls: 0, capabilities: inner.capabilities, forward: (...args: Parameters<ModelEgress["forward"]>) => { held.calls += 1; return inner.forward(...args); } };
  return held;
}
/** An adapter that answers with scripted settles: for the cases the fake cannot make (an overrun, a missing settle, a throw). */
function stubEgress(steps: Array<{ text?: string; settle?: Partial<ModelEgressSettle>; throws?: boolean; noSettle?: boolean }>): ModelEgress & { calls: number } {
  const held = {
    calls: 0,
    capabilities: { schemes: ["bearer"] as const },
    async *forward(): AsyncGenerator<ModelEgressEvent> {
      const step = steps[held.calls] ?? {};
      held.calls += 1;
      if (step.throws === true) throw new Error(`adapter failed ${canary("adapter-error")}`);
      yield { kind: "head", status: 200, headers: [["content-type", "application/json"]] };
      yield { kind: "chunk", bytes: enc(geminiBody(step.text ?? `answer ${String(held.calls)}`)) };
      if (step.noSettle !== true) yield { kind: "settle", status: 200, class: "ok", costMicros: 1, estimated: false, ...step.settle };
    },
  };
  return held;
}
const okJudge = () => recordingJudge(COMPANY_A, (call) => verdictText(call, "same"));

function input(world: ReturnType<typeof sbsWorld>, over: Partial<SideBySideRunInput> = {}, egress: ModelEgress = world.egress): SideBySideRunInput {
  return { ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress, scope: world.scope, source: source(COMPANY_A, 8), judge: okJudge(), report: reportNeeded(), policy, seed: "run-seed", ...over };
}

describe("a normal run", () => {
  it("makes one old and one new call per case through the port, spends the product key, and judges each case once on the Rovara meter", async () => {
    const world = sbsWorld();
    const judge = recordingJudge(COMPANY_A, (call) => ({ text: verdictText(call, "same"), costMicros: 1_000 }));
    world.answers(...Array.from({ length: 10 }, (_, index) => `answer ${String(index)}`));
    const summary = ran(await runSideBySide(input(world, { judge })));
    expect(summary.cases).toHaveLength(5);
    expect(summary.counts).toMatchObject({ planned: 5, judged: 5, same: 5, better: 0, worse: 0, unclear: 0, notRun: 0, callFailed: 0, judgeNotRun: 0, refused: 0 });
    expect(world.world.provider.calls).toHaveLength(10);
    expect(judge.received).toHaveLength(5);
    // The two meters stay apart: the product meter is the adapter's own, the Rovara meter is the judge's.
    const productSpent = await world.world.meterOf(COMPANY_A);
    expect(summary.meters.product).toEqual({ calls: 10, costMicros: productSpent });
    expect(summary.meters.rovara).toEqual({ calls: 5, costMicros: 5_000 });
    expect(await world.world.meterOf(COMPANY_B)).toBe(0);
  });
  it("is off, with no call at all, when the layer is not on", async () => {
    const world = sbsWorld();
    const egress = counting(world.egress);
    const judge = okJudge();
    const result = await runSideBySide(input(world, { policy: { preset: "balanced", aiPilot: false, optIn: false }, judge }, egress));
    expect(result).toEqual({ status: "off", reason: "not_enabled" });
    expect([egress.calls, judge.received.length]).toEqual([0, 0]);
  });
  it("carries no proof basis and no trust class, and says plainly that it does not count toward proof", async () => {
    const world = sbsWorld();
    world.answers(...Array.from({ length: 10 }, (_, index) => `answer ${String(index)}`));
    const summary = ran(await runSideBySide(input(world)));
    expect(summary.evidence).toEqual({ kind: "side_by_side", countsTowardProof: false });
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/"(?:trust|proofBasis)"/u);
    expect(text).not.toMatch(/real|proves_change|scripted_ai_replies/iu);
    expect(Object.keys(summary).sort()).toEqual(["cases", "counts", "evidence", "judge", "meters", "schemaVersion"]);
  });
  it("counts a case the pairing refused, and makes no call for it", async () => {
    const world = sbsWorld();
    const egress = counting(world.egress);
    const good = await source(COMPANY_A, 1).cases();
    const mixed = { company: COMPANY_A.orgId, kind: "eval_set" as const, cases: () => [good[0]!, { ...good[0]!, caseId: "wrong-row", new: { ...good[0]!.new, row: "openai" } }] };
    world.answers("a", "b");
    const summary = ran(await runSideBySide(input(world, { source: mixed }, egress)));
    expect(summary.counts).toMatchObject({ planned: 1, refused: 1 });
    expect(egress.calls).toBe(2);
  });
});

describe("a call that did not run", () => {
  const classes: Array<[string, { status: number; body: string }, string]> = [
    ["rate_limit", { status: 429, body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "per minute" } }) }, NOT_RUN_SENTENCES.rate_limit],
    ["quota", { status: 429, body: JSON.stringify({ error: { code: "insufficient_quota", message: "daily quota" } }) }, NOT_RUN_SENTENCES.quota],
    ["overloaded", { status: 503, body: "{}" }, NOT_RUN_SENTENCES.overloaded],
    ["key_refused", { status: 401, body: "{}" }, NOT_RUN_SENTENCES.key_refused],
  ];
  for (const [name, behaviour, sentence] of classes) {
    it(`is "not run" with F1-a's sentence for ${name} on the old side, and the new side is never called`, async () => {
      const world = sbsWorld();
      world.world.provider.script(behaviour);
      const egress = counting(world.egress);
      const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1) }, egress)));
      expect(summary.cases).toEqual([{ caseId: "case-1", status: "not_run", side: "old", sentence }]);
      expect(summary.counts).toMatchObject({ planned: 1, notRun: 1, judged: 0 });
      expect(egress.calls).toBe(1);
    });
    it(`is "not run" for ${name} on the new side`, async () => {
      const world = sbsWorld();
      world.world.provider.script({ body: geminiBody("old fine") }, behaviour);
      const judge = okJudge();
      const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1), judge })));
      expect(summary.cases).toEqual([{ caseId: "case-1", status: "not_run", side: "new", sentence }]);
      expect(judge.received).toEqual([]);
    });
  }
  it("is a failed call, not a verdict, for a provider error, and the provider's words are never kept", async () => {
    const world = sbsWorld();
    world.world.provider.script({ status: 500, body: JSON.stringify({ error: { message: `server said ${canary("provider-words")}` } }) });
    const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1) })));
    expect(summary.cases[0]).toMatchObject({ status: "call_failed", side: "old" });
    expect(JSON.stringify(summary)).not.toContain(canary("provider-words"));
  });
  it("is a failed call when the adapter throws, when it sends no settle, or when the answer cannot be read, and none of them leaks its message", async () => {
    const world = sbsWorld();
    for (const step of [{ throws: true }, { noSettle: true }, { text: "" }]) {
      const egress = stubEgress([step]);
      const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1) }, egress)));
      expect(summary.cases[0], JSON.stringify(step)).toMatchObject({ status: "call_failed", side: "old" });
      expect(JSON.stringify(summary)).not.toContain(canary("adapter-error"));
    }
  });
  it("stops at the cap: the case is 'not run' with the budget sentence and no further call is made", async () => {
    const world = sbsWorld();
    await world.world.setCap(COMPANY_A, 0);
    const egress = counting(world.egress);
    const summary = ran(await runSideBySide(input(world, {}, egress)));
    expect(summary.counts).toMatchObject({ planned: 5, notRun: 5, judged: 0 });
    expect(summary.cases.every((item) => item.status === "not_run" && item.sentence === capSentence())).toBe(true);
    expect(egress.calls).toBe(1);
    expect(summary.stoppedBy).toBe("cap");
  });
});

describe("the overrun stop (DECISIONS 165)", () => {
  it("makes no further call after a call that settled over the cap: the case that tripped it is kept, the rest are 'not run', and the cap was passed by one call only", async () => {
    const world = sbsWorld();
    const egress = stubEgress([{}, { settle: { overrun: true } }]);
    const judge = okJudge();
    const summary = ran(await runSideBySide(input(world, { judge }, egress)));
    expect(egress.calls).toBe(2);
    expect(summary.stoppedBy).toBe("overrun");
    expect(summary.cases[0]).toMatchObject({ status: "judged" });
    expect(summary.cases.slice(1).every((item) => item.status === "not_run" && item.sentence === MODEL_EGRESS_OVERRUN_SENTENCE)).toBe(true);
    expect(judge.received).toHaveLength(1);
  });
  it("does not even make the new call when the OLD call overran", async () => {
    const world = sbsWorld();
    const egress = stubEgress([{ settle: { overrun: true } }]);
    const summary = ran(await runSideBySide(input(world, {}, egress)));
    expect(egress.calls).toBe(1);
    expect(summary.cases.every((item) => item.status === "not_run" && item.sentence === MODEL_EGRESS_OVERRUN_SENTENCE)).toBe(true);
  });
  it("stops the same way on the fake adapter when the spend passes the cap", async () => {
    const world = sbsWorld();
    await world.world.setCap(COMPANY_A, 20_000);
    world.world.provider.script(...Array.from({ length: 10 }, () => ({ body: geminiBody("big", { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }) })));
    const egress = counting(world.egress);
    const summary = ran(await runSideBySide(input(world, {}, egress)));
    expect(egress.calls).toBeLessThanOrEqual(3);
    expect(world.world.provider.calls.length).toBeLessThanOrEqual(2);
    expect(summary.stoppedBy === "overrun" || summary.stoppedBy === "cap").toBe(true);
  });
  it("applies a per-task call limit as defence in depth: 10 by default, and a case that cannot get both its calls is not started", async () => {
    expect(SIDE_BY_SIDE_DEFAULT_CALL_CAP).toBe(10);
    const world = sbsWorld();
    const egress = stubEgress([]);
    const summary = ran(await runSideBySide(input(world, { maxProductCalls: 3 }, egress)));
    expect(egress.calls).toBe(2);
    expect(summary.counts).toMatchObject({ judged: 1, notRun: 4 });
    expect(summary.stoppedBy).toBe("call_limit");
    expect(summary.cases.slice(1).every((item) => item.status === "not_run" && /call limit/iu.test(item.sentence))).toBe(true);
  });
});

describe("the judge's side of a run", () => {
  it("is 'judge not run' for an answer that is not the strict verdict, a throw, or a cost that is not a whole number; the outputs are kept and no verdict is guessed", async () => {
    let step = -1;
    for (const make of [() => "Looks good to me", () => { throw new Error(`boom ${canary("judge-error")}`); }, (call: Parameters<Parameters<typeof recordingJudge>[1]>[0]) => ({ text: verdictText(call, "same"), costMicros: -1 }), (call: Parameters<Parameters<typeof recordingJudge>[1]>[0]) => ({ text: verdictText(call, "same"), costMicros: Number.NaN })]) {
      const world = sbsWorld();
      world.answers("old out", "new out");
      const judge = recordingJudge(COMPANY_A, make);
      const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1), judge })));
      expect(summary.cases[0]).toMatchObject({ status: "judge_not_run", oldText: "old out", newText: "new out" });
      expect(summary.counts).toMatchObject({ judgeNotRun: 1, judged: 0 });
      expect(JSON.stringify(summary)).not.toContain(canary("judge-error"));
      // The call that answered with prose still cost what it cost; a throw and a cost that is not a whole number cost nothing on the meter.
      step += 1;
      expect(summary.meters.rovara.costMicros).toBe(step === 0 ? 7 : 0);
    }
  });
  it("keeps no free text from the judge: an extra field with a canary makes the whole answer 'judge not run' and the canary is nowhere in the result", async () => {
    const world = sbsWorld();
    world.answers("a", "b");
    const judge = recordingJudge(COMPANY_A, (call) => JSON.stringify({ verdicts: [{ caseId: call.cases[0]!.caseId, verdict: "same", reason: canary("judge-reason") }] }));
    const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1), judge })));
    expect(summary.cases[0]).toMatchObject({ status: "judge_not_run" });
    expect(JSON.stringify(summary)).not.toContain(canary("judge-reason"));
  });
  it("has its own call limit (the Rovara source's cap, separate from the product key's)", async () => {
    const world = sbsWorld();
    world.answers(...Array.from({ length: 10 }, (_, index) => `answer ${String(index)}`));
    const judge = okJudge();
    const summary = ran(await runSideBySide(input(world, { judge, maxJudgeCalls: 2 })));
    expect(judge.received).toHaveLength(2);
    expect(summary.counts).toMatchObject({ judged: 2, judgeNotRun: 3 });
  });
});

describe("outputs", () => {
  it("reads the answer text for each family and refuses what it cannot read", () => {
    expect(modelOutputText("gemini", enc(geminiBody("hello")))).toBe("hello");
    expect(modelOutputText("anthropic_messages", enc(JSON.stringify({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })))).toBe("ab");
    expect(modelOutputText("openai_compatible", enc(JSON.stringify({ choices: [{ message: { content: "c" } }] })))).toBe("c");
    expect(modelOutputText("cohere", enc(JSON.stringify({ text: "d" })))).toBe("d");
    for (const bad of ["", "not json", "[]", "{}", JSON.stringify({ candidates: [] })]) expect(modelOutputText("gemini", enc(bad)), bad).toBeUndefined();
  });
  it("bounds what it keeps from a huge answer, so a hostile megabyte cannot grow the summary", async () => {
    const world = sbsWorld();
    world.answers("x".repeat(1_000_000), "y".repeat(1_000_000));
    const summary = ran(await runSideBySide(input(world, { source: source(COMPANY_A, 1) })));
    const item = summary.cases[0]!;
    expect(item.status === "judged" && item.oldText.length).toBeLessThanOrEqual(8_000);
  });
});

describe("no real call", () => {
  it("opens no socket to a non-loopback address in a whole run", async () => {
    const world = sbsWorld();
    world.answers(...Array.from({ length: 10 }, (_, index) => `answer ${String(index)}`));
    const outcome = await withNetworkTripwire(() => runSideBySide(input(world)));
    expect(outcome.attempts).toEqual([]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.status).toBe("ran");
  });
});

describe("two companies", () => {
  it("refuses a case source or a judge of another company, with no call and nothing of either company in the answer", async () => {
    const world = sbsWorld();
    const egress = counting(world.egress);
    const judgeB = recordingJudge(COMPANY_B, (call) => verdictText(call, "same"));
    const foreignSource = await runSideBySide(input(world, { source: source(COMPANY_B, 3, { prefix: canary("b-case") }) }, egress));
    expect(foreignSource).toEqual({ status: "refused", reason: "company_mismatch" });
    const foreignJudge = await runSideBySide(input(world, { judge: judgeB }, egress));
    expect(foreignJudge).toEqual({ status: "refused", reason: "company_mismatch" });
    expect(egress.calls).toBe(0);
    expect(judgeB.received).toEqual([]);
    expect(JSON.stringify([foreignSource, foreignJudge])).not.toContain(COMPANY_B.canary);
  });
  it("passes the shared two-company kit: each company sees only its own run, and the other's source or judge is refused under shared raw ids", async () => {
    const surface: IsolationSurface = {
      kind: "read",
      name: "side-by-side run",
      async plant(me) {
        return { handle: { source: source(me, 2, { inputs: evalCases(2, `shared-${me.label}`) }), judge: recordingJudge(me, (call) => verdictText(call, "same")) }, markers: [me.canary] };
      },
      async observe(as, planted) {
        const mine = planted.byCompany[as.label] as { source: ReturnType<typeof source>; judge: ReturnType<typeof recordingJudge> };
        const theirs = planted.byCompany[as.label === "A" ? "B" : "A"] as typeof mine;
        const world = sbsWorld(as);
        world.answers(`${as.canary} old one`, `${as.canary} new one`, `${as.canary} old two`, `${as.canary} new two`);
        const own = await runSideBySide({ ...RUN_DEFAULTS, company: as.orgId, egress: world.egress, scope: world.scope, source: mine.source, judge: mine.judge, report: reportNeeded(), policy, seed: "kit" });
        const judgeCallsBefore = theirs.judge.received.length;
        const crossSource = await runSideBySide({ ...RUN_DEFAULTS, company: as.orgId, egress: world.egress, scope: world.scope, source: theirs.source, judge: mine.judge, report: reportNeeded(), policy, seed: "kit" });
        const crossJudge = await runSideBySide({ ...RUN_DEFAULTS, company: as.orgId, egress: world.egress, scope: world.scope, source: mine.source, judge: theirs.judge, report: reportNeeded(), policy, seed: "kit" });
        return { own: JSON.stringify(own), crossSource, crossJudge, callsToTheirJudge: theirs.judge.received.length - judgeCallsBefore };
      },
    };
    const isolation: TwoCompanyIsolation = { surfaces: [surface] };
    const world = sbsWorld();
    const mine = recordingJudge(COMPANY_A, (call) => verdictText(call, "same"));
    const foreign = recordingJudge(COMPANY_B, (call) => verdictText(call, "same"));
    expect(await runSideBySide({ ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 1), judge: foreign, report: reportNeeded(), policy, seed: "k" })).toEqual({ status: "refused", reason: "company_mismatch" });
    expect([mine.received.length, foreign.received.length]).toEqual([0, 0]);
    for (const check of twoCompanyChecks<{ isolation?: TwoCompanyIsolation }>()) {
      if (check.needs?.({ isolation }) === false) continue;
      await check.run({ isolation });
    }
  });
});
