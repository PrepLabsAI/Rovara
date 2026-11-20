// L4-E34 (E3 + E4) in the final-check eval: the stand-in set's version moves the base score's cache identity and nothing the approval binds (a new version re-runs the baseline inside the approved cap, with no new approval), an
// eval with no stand-ins is unchanged, and the one fill-and-re-ask pass asks the questions that hit a missing row again, on both sides, once, inside the same cap.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentBaseScoreCache, evalResultFromArtifact, evalSpendInputsDigest, evalSettingsFingerprintOf, standInSetVersion, type EvalRequest } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createEvalBaselines } from "../../packages/worker/src/verification/eval-baseline-refresh.js";
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

describe("the stand-in version in an eval's identity", () => {
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
});

describe("the fill-and-re-ask pass", () => {
  it("a pass that finds nothing, names an unknown question, throws or is not asked changes nothing (a missing row never stops an eval)", async () => {
    for (const fill of [async () => [], async () => ["zz"], async () => { throw new Error("private-fill-failure"); }]) {
      const w = await world(); w.ports.fillMissingRows = fill;
      const artifact = await runFinalCheckEval(request, w.ports, facts());
      expect(evalResultFromArtifact(artifact).outcome).toBe("ran"); expect(w.stages).toHaveLength(1); expect(JSON.stringify(artifact)).not.toContain("private-fill-failure");
    }
    const whole = await world(); whole.plan.subsetSupported = false; let called = 0; whole.ports.fillMissingRows = async () => { called += 1; return ["q1"]; };
    await runFinalCheckEval(request, whole.ports, facts()); expect(called).toBe(0);
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
});
