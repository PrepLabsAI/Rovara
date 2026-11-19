// L4-E34 (E3 + E4) in the final-check eval: the stand-in set's version moves the base score's cache identity and nothing the approval binds (a new version re-runs the baseline inside the approved cap, with no new approval), an
// eval with no stand-ins is unchanged, and the one fill-and-re-ask pass asks the questions that hit a missing row again, on both sides, once, inside the same cap.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentBaseScoreCache, evalBaseCacheKey, evalResultFromArtifact, evalSpendInputsDigest, evalSettingsFingerprintOf, standInSetVersion, type EvalBaseCacheKeyParts, type EvalRequest } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const request: EvalRequest = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
const facts = () => ({ status: "verified", candidateDigest: "a".repeat(64), signal: new AbortController().signal });
async function world(newPass = true, n = 4) { const w = await createEvalFinalCheckWorld(newPass, n); roots.push(w.root); return w; }
const reasonOf = (a: unknown) => evalResultFromArtifact(a).notRun?.reason;
const hex = (c: string) => c.repeat(64);
const V1 = standInSetVersion({ images: ["registry.example/postgres@sha256:" + hex("1")], seeds: [hex("a")], generatorVersion: "rows-v1", answerSets: [] });
const V2 = standInSetVersion({ images: ["registry.example/postgres@sha256:" + hex("1")], seeds: [hex("b")], generatorVersion: "rows-v1", answerSets: [] });

/** Records the parts every cache read asked for (the identity of the score looked up). */
function watched(w: Awaited<ReturnType<typeof world>>) {
  const seen: EvalBaseCacheKeyParts[] = []; const read = w.ports.cache.read.bind(w.ports.cache);
  w.ports.cache.read = async parts => { seen.push(parts); return read(parts); };
  return seen;
}

describe("the stand-in version in an eval's identity", () => {
  it("an eval with no stand-ins asks for exactly the score it always did (no version part, the approved fingerprint)", async () => {
    const w = await world(); const seen = watched(w);
    expect(evalResultFromArtifact(await runFinalCheckEval(request, w.ports, facts())).outcome).toBe("ran");
    expect(seen).toHaveLength(1); expect("standInSetVersion" in seen[0]!).toBe(false);
    expect(seen[0]!.settingsFingerprint).toBe(w.plan.inputs.settingsFingerprint);
  });
  it("with a version asks for the score of that version: the version part, and a settings fingerprint bound with it (a sync or an async port)", async () => {
    for (const port of [() => V1, async () => V1]) {
      const w = await world(); const seen = watched(w); w.ports.standInSetVersion = port;
      expect(evalResultFromArtifact(await runFinalCheckEval(request, w.ports, facts())).outcome).toBe("ran");
      expect(seen[0]!.standInSetVersion).toBe(V1);
      expect(seen[0]!.settingsFingerprint).toBe(evalSettingsFingerprint(w.plan.settings, w.plan.judgePin, V1));
      expect(seen[0]!.settingsFingerprint).toBe(evalSettingsFingerprintOf(w.plan.settings, w.plan.judgePin, V1));
      expect(seen[0]!.settingsFingerprint).not.toBe(w.plan.inputs.settingsFingerprint);
    }
  });
  it("a new version needs NO new approval: the grant still binds the plan's own fingerprint, and a grant that bound the version is not the approved one", async () => {
    const w = await world(); w.ports.standInSetVersion = () => V2;
    expect(reasonOf(await runFinalCheckEval(request, w.ports, facts()))).toBeUndefined();
    expect(w.approvals()).toBe(1);
    const other = await world(); other.ports.standInSetVersion = () => V2;
    Object.assign(other.grant, { inputsDigest: evalSpendInputsDigest({ ...other.plan.inputs, settingsFingerprint: evalSettingsFingerprintOf(other.plan.settings, other.plan.judgePin, V2) }) });
    expect(reasonOf(await runFinalCheckEval(request, other.ports, facts()))).toBe("spend_not_approved"); expect(other.holds).toEqual([]); expect(other.calls).toEqual([]);
  });
  it("a version that is not one, or a port that fails, is not_connected with zero calls and no leak", async () => {
    for (const bad of ["", "short", hex("A"), 7 as never, null as never]) {
      const w = await world(); w.ports.standInSetVersion = () => bad;
      expect(reasonOf(await runFinalCheckEval(request, w.ports, facts()))).toBe("not_connected"); expect(w.holds).toEqual([]); expect(w.calls).toEqual([]);
    }
    const w = await world(); w.ports.standInSetVersion = async () => { throw new Error("private-version-failure"); };
    const artifact = await runFinalCheckEval(request, w.ports, facts());
    expect(reasonOf(artifact)).toBe("not_connected"); expect(JSON.stringify(artifact)).not.toContain("private-version-failure"); expect(w.holds).toEqual([]);
  });
  it("a seed change misses the cache and re-baselines (once); an unchanged set hits it", async () => {
    const w = await world(true, 1); w.ports.cache = createDocumentBaseScoreCache(new MemoryDocumentStore(), { companyId: "company-a" }); w.ports.baselines = createEvalBaselines();
    const seen = watched(w);
    w.ports.standInSetVersion = () => V1;
    expect(evalResultFromArtifact(await runFinalCheckEval(request, w.ports, facts())).outcome).toBe("ran");
    expect(w.calls).toHaveLength(4); // 3 baseline runs on the old code + the change's one run
    expect(evalResultFromArtifact(await runFinalCheckEval(request, w.ports, facts())).outcome).toBe("ran");
    expect(w.calls).toHaveLength(5); // the same set: a hit, only the change's run
    w.ports.standInSetVersion = () => V2;
    expect(evalResultFromArtifact(await runFinalCheckEval(request, w.ports, facts())).outcome).toBe("ran");
    expect(w.calls).toHaveLength(9); // a new version: the baseline is measured again
    const keys = new Set(seen.map(parts => evalBaseCacheKey(parts)));
    expect(keys.size).toBe(2);
  });
  it("the re-baseline stays inside the approved cap: with no room for the three runs it is a cap refusal with zero calls, while the same set still hits", async () => {
    const w = await world(true, 1); w.ports.cache = createDocumentBaseScoreCache(new MemoryDocumentStore(), { companyId: "company-a" }); w.ports.baselines = createEvalBaselines();
    w.ports.standInSetVersion = () => V1;
    await runFinalCheckEval(request, w.ports, facts()); const used = w.calls.length;
    const tight = { ...request, evalPass: 2 as const, callsAlreadyUsed: 398 };
    expect(evalResultFromArtifact(await runFinalCheckEval(tight, w.ports, facts())).outcome).toBe("ran");
    expect(w.calls.length).toBe(used + 1);
    w.ports.standInSetVersion = () => V2;
    expect(reasonOf(await runFinalCheckEval(tight, w.ports, facts()))).toBe("cap"); expect(w.calls.length).toBe(used + 1);
  });
  it("two companies: a company's stand-in score is never read for another", async () => {
    const store = new MemoryDocumentStore();
    const a = await world(true, 1); a.ports.cache = createDocumentBaseScoreCache(store, { companyId: "company-a" }); a.ports.baselines = createEvalBaselines(); a.ports.standInSetVersion = () => V1;
    await runFinalCheckEval(request, a.ports, facts()); expect(a.calls).toHaveLength(4);
    const b = await world(true, 1); b.plan.company = "company-b"; b.plan.key = { ...b.plan.key, company: "company-b" }; Object.assign(b.grant, { company: "company-b" }); b.ports.standInSetVersion = () => V1;
    b.ports.cache = createDocumentBaseScoreCache(store, { companyId: "company-b" }); b.ports.baselines = createEvalBaselines();
    await runFinalCheckEval(request, b.ports, facts()); expect(b.calls).toHaveLength(4); // its own baseline, not company-a's
  });
});

describe("the fill-and-re-ask pass", () => {
  it("without one the round is what it was (one stage); with one it asks the questions that hit a missing row again on BOTH sides, once", async () => {
    const plain = await world(); await runFinalCheckEval(request, plain.ports, facts());
    expect(plain.stages.map(s => [s.side, s.ids.length, s.runs])).toEqual([["new", 4, 1]]);
    const w = await world(); const asked: Array<readonly string[]> = [];
    w.ports.fillMissingRows = async r => { asked.push(r.ids); return ["q1", "q2"]; };
    const artifact = await runFinalCheckEval(request, w.ports, facts());
    expect(evalResultFromArtifact(artifact).outcome).toBe("ran");
    expect(asked).toEqual([["q0", "q1", "q2", "q3"]]);
    expect(w.stages.map(s => [s.side, [...s.ids], s.runs])).toEqual([["new", ["q0", "q1", "q2", "q3"], 1], ["old", ["q1", "q2"], 3], ["new", ["q1", "q2"], 1]]);
    expect(w.holds.map(h => [h.calls, h.costMicros])).toEqual([[4, 40], [6, 60], [2, 20]]);
  });
  it("the refreshed old answers replace the saved ones for those questions only: a question the saved baseline failed (no row to read) is not a suspect once it is asked afresh", async () => {
    const saved = (w: Awaited<ReturnType<typeof world>>) => { w.record.questions!.find(q => q.id === "q1")!.samples = Array.from({ length: 3 }, () => ({ pass: false, answer: "old" })); };
    const without = await world(); saved(without); await runFinalCheckEval(request, without.ports, facts());
    // the saved failures make q1 an improvement to confirm: the usual re-asks run on it
    expect(without.stages.length).toBeGreaterThan(1); expect(without.stages.some(s => s.ids.includes("q1") && s.runs === 3 && s.side === "new")).toBe(true);
    const w = await world(); saved(w); w.ports.fillMissingRows = async () => ["q1"];
    const artifact = await runFinalCheckEval(request, w.ports, facts());
    expect(w.stages.map(s => [s.side, [...s.ids], s.runs])).toEqual([["new", ["q0", "q1", "q2", "q3"], 1], ["old", ["q1"], 3], ["new", ["q1"], 1]]);
    expect(evalResultFromArtifact(artifact).outcome).toBe("ran");
  });
  it("a pass that finds nothing, names an unknown question, throws or is not asked changes nothing (a missing row never stops an eval)", async () => {
    for (const fill of [async () => [], async () => ["zz"], async () => { throw new Error("private-fill-failure"); }]) {
      const w = await world(); w.ports.fillMissingRows = fill;
      const artifact = await runFinalCheckEval(request, w.ports, facts());
      expect(evalResultFromArtifact(artifact).outcome).toBe("ran"); expect(w.stages).toHaveLength(1); expect(JSON.stringify(artifact)).not.toContain("private-fill-failure");
    }
    const whole = await world(); whole.plan.subsetSupported = false; let called = 0; whole.ports.fillMissingRows = async () => { called += 1; return ["q1"]; };
    await runFinalCheckEval(request, whole.ports, facts()); expect(called).toBe(0);
  });
  it("is optional work: when the re-ask does not fit the call budget (with the suspect re-asks it could cause) the pass is skipped and the round is exactly what it would have been", async () => {
    const without = await world(); Object.assign(without.grant, { maxCalls: 10 }); const plain = await runFinalCheckEval(request, without.ports, facts());
    const w = await world(); Object.assign(w.grant, { maxCalls: 10 }); w.ports.fillMissingRows = async () => ["q1", "q2"];
    const artifact = await runFinalCheckEval(request, w.ports, facts());
    expect(evalResultFromArtifact(artifact).outcome).toBe("ran"); expect(evalResultFromArtifact(artifact).label).toBe(evalResultFromArtifact(plain).label);
    expect(w.stages).toHaveLength(1); expect(w.calls).toHaveLength(4);
  });
  it("a regression only the suspect re-asks can confirm is still confirmed when the fill pass would have used the budget those re-asks need", async () => {
    // two broken SAFETY questions of four: only the suspect re-asks can confirm them (4 + 12 calls, the whole budget), and a fill pass on a THIRD question (4 calls) would leave them too little
    const broken = async (withFill: boolean) => {
      const w = await world(true, 4); Object.assign(w.grant, { maxCalls: 16 }); for (const i of [0, 2]) (w.plan.questions[i] as { category: string }).category = "safety";
      const run = w.ports.runner;
      w.ports.runner = async r => {
        const out = await run(r);
        if (r.side === "new") { const file = join(out.report.root, out.report.argument); const body = JSON.parse(await readFile(file, "utf8")) as { questions: Array<{ id: string; samples: Array<{ pass: boolean; answer: string }> }> }; for (const q of body.questions) if (q.id === "q0" || q.id === "q2") q.samples = q.samples.map(() => ({ pass: false, answer: "new" })); await writeFile(file, JSON.stringify(body)); }
        return out;
      };
      if (withFill) w.ports.fillMissingRows = async () => ["q1"];
      return { artifact: await runFinalCheckEval(request, w.ports, facts()), stages: w.stages };
    };
    const plain = await broken(false);
    expect(evalResultFromArtifact(plain.artifact).label).toBe("Worse on eval"); expect(plain.stages.length).toBeGreaterThan(1);
    const filled = await broken(true);
    expect(evalResultFromArtifact(filled.artifact).label).toBe("Worse on eval");
    expect(filled.stages.some(s => s.ids.length === 1 && s.ids[0] === "q1" && s.runs === 3)).toBe(false); // the fill pass was skipped: no room
  });
  it("a refused meter hold or a failed re-ask drops the pass; it never turns a finished round into Not run", async () => {
    const w = await world(); const reserve = w.ports.meter.reserve.bind(w.ports.meter); let holds = 0; w.ports.fillMissingRows = async () => ["q1"];
    w.ports.meter.reserve = r => ++holds === 1 ? reserve(r) : Promise.resolve(undefined);
    const artifact = await runFinalCheckEval(request, w.ports, facts());
    expect(evalResultFromArtifact(artifact).outcome).toBe("ran"); expect(w.stages).toHaveLength(1);
    const failing = await world(); failing.ports.fillMissingRows = async () => ["q1"]; const run = failing.ports.runner;
    failing.ports.runner = async r => { if (r.side === "old") throw new Error("private-provider-error"); return run(r); };
    const out = await runFinalCheckEval(request, failing.ports, facts());
    expect(evalResultFromArtifact(out).outcome).toBe("ran"); expect(JSON.stringify(out)).not.toContain("private-provider-error");
  });
  it("hostile pass results (not a list, non-string ids, huge or repeated lists) are contained: no throw, no extra spend beyond the asked questions", async () => {
    for (const hostile of [7, { length: 2 }, "q1", null, [1, {}, null], Array.from({ length: 5000 }, () => "q1")]) {
      const w = await world(); w.ports.fillMissingRows = (async () => hostile) as never;
      const artifact = await runFinalCheckEval(request, w.ports, facts());
      expect(evalResultFromArtifact(artifact).outcome).toBe("ran");
      if (Array.isArray(hostile) && hostile.length === 5000) expect(w.stages.map(s => [s.side, [...s.ids], s.runs])).toEqual([["new", ["q0", "q1", "q2", "q3"], 1], ["old", ["q1"], 3], ["new", ["q1"], 1]]);
      else expect(w.stages).toHaveLength(1);
    }
  });
});
