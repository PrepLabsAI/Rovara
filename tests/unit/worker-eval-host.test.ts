// The eval host binding end to end on fakes: the composed ports drive `runFinalCheckEval`; the model-access port is a script
// and the sandbox exec is a script that sends its model traffic through the egress it is given. No network, no real clock.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, evalProofBasis, evalResultFromArtifact, EvalRoundArtifactSchema, type EvalRequest, type ModelEgressEvent } from "@agentx/contracts";
import { createEvalFinalCheckPorts, type EvalHostCapabilities } from "../../packages/worker/src/verification/eval-host.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import type { EvalSandboxExec } from "../../packages/worker/src/verification/eval-runner.js";
import { createEvalFinalCheckWorld } from "../support/eval-final-check.js";
import { answer, classAnswer, frame, scriptedAccess, type Script } from "../support/eval-model-access.js";
import { rm } from "node:fs/promises";

const request: EvalRequest = { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = "b".repeat(64);
const collect = async (iter: AsyncIterable<ModelEgressEvent>) => { for await (const _ of iter) void _; };

async function bound(options: { newPass?: boolean; script?: Script; exec?: (inner: EvalSandboxExec) => EvalSandboxExec; n?: number } = {}) {
  const w = await createEvalFinalCheckWorld(options.newPass ?? true, options.n ?? 4); roots.push(w.root);
  const access = scriptedAccess(options.script); const stages: Array<{ side: string; runs: number; ids: readonly string[] }> = [];
  let reports = 0;
  const inner: EvalSandboxExec = { run: async r => {
    stages.push({ side: r.side, runs: r.runs, ids: r.ids });
    for (const id of r.ids) for (let i = 0; i < r.runs; i++) await collect(r.egress.forward(r.scope, frame(id), { signal: r.signal }));
    const file = `host-report-${++reports}.json`;
    await writeFile(join(w.root, file), JSON.stringify({ schemaVersion: 1, eval_set_hash: hash, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }],
      questions: r.ids.map(id => ({ id, samples: Array.from({ length: r.runs }, () => ({ pass: r.side === "old" || (options.newPass ?? true), answer: r.side === "old" ? "old" : "new" })) })) }));
    return { report: { root: w.root, cwd: ".", argument: file, notBeforeMs: Date.now() - 1000 }, changedPromptCalls: r.side === "new" ? r.ids.length : 0, attestation: attestRovaraOnlyBaseCheckout({ baseCommit: w.plan.key.baseCommit }) };
  } };
  const capabilities: EvalHostCapabilities = { roundKind: "check_unsealed", plan: () => w.ports.plan(), approval: w.ports.approval, cache: w.ports.cache, baselines: w.ports.baselines, modelAccess: access.access, exec: options.exec?.(inner) ?? inner };
  const ports = createEvalFinalCheckPorts(capabilities)!;
  const facts = (signal = new AbortController().signal) => ({ status: "verified", candidateDigest: "a".repeat(64), signal });
  return { w, access, stages, ports, capabilities, facts };
}
const read = (a: unknown) => EvalRoundArtifactSchema.parse(a);

describe("createEvalFinalCheckPorts", () => {
  it("binds nothing for a missing set or any missing capability", async () => {
    const { capabilities } = await bound();
    expect(createEvalFinalCheckPorts(undefined)).toBeUndefined(); expect(createEvalFinalCheckPorts(null as never)).toBeUndefined();
    for (const field of ["plan", "approval", "cache", "baselines", "modelAccess", "exec"] as const) expect(createEvalFinalCheckPorts({ ...capabilities, [field]: undefined }), field).toBeUndefined();
    expect(createEvalFinalCheckPorts({ ...capabilities, modelAccess: {} as never })).toBeUndefined();
    expect(createEvalFinalCheckPorts({ ...capabilities, exec: {} as never })).toBeUndefined();
    expect(createEvalFinalCheckPorts({ ...capabilities, cache: { read: async () => undefined } as never })).toBeUndefined();
  });
  it("passes the trusted capabilities through untouched and carries the round kind", async () => {
    const { w, capabilities, ports } = await bound();
    expect(await ports.plan()).toBe(w.plan); expect(ports.approval).toBe(capabilities.approval); expect(ports.cache).toBe(capabilities.cache); expect(ports.baselines).toBe(capabilities.baselines);
    expect(ports.roundKind).toBe("check_unsealed");
    expect(createEvalFinalCheckPorts({ ...capabilities, roundKind: undefined })).not.toHaveProperty("roundKind");
  });
  it("an unbound request is not run, with no call and no hold", async () => {
    const { access, facts } = await bound();
    const artifact = await runFinalCheckEval(request, createEvalFinalCheckPorts(undefined), facts());
    expect(evalResultFromArtifact(artifact).notRun?.reason).toBe("not_connected");
    expect(access.holds).toEqual([]); expect(access.forwarded).toEqual([]);
  });
  it("a working-sandbox round reads needs a fresh sandbox and holds nothing", async () => {
    const { access, capabilities, facts } = await bound();
    const artifact = await runFinalCheckEval(request, createEvalFinalCheckPorts({ ...capabilities, roundKind: "working" }), facts());
    expect(evalResultFromArtifact(artifact).notRun?.reason).toBe("needs_fresh_sandbox"); expect(access.holds).toEqual([]);
  });
});

describe("a prompt change runs the eval through the model-access port", () => {
  it("no drop: every call went through the port under a whole-stage hold, and the proof row says what was measured", async () => {
    const { w, access, ports, facts } = await bound({ newPass: true });
    const artifact = read(await runFinalCheckEval(request, ports, facts()));
    expect(artifact).toMatchObject({ outcome: "done", roundKind: "check_unsealed", cache: "hit" });
    expect(evalResultFromArtifact(artifact).label).toBe("No drop found");
    expect(access.holds[0]).toEqual({ grant: w.grant, calls: 4, costMicros: 40 });
    expect(access.forwarded).toHaveLength(4);
    expect(new Set(access.scopes).size).toBe(1);
    expect(access.released).toEqual([{ calls: 4, costMicros: 40, unknown: false }]);
    expect(artifact.usage).toEqual({ calls: 4, costMicros: 40 });
    expect(artifact.basis).toEqual({ evalSetHash: hash, judgePin: hash, model: "model-a", modelVersion: "v1", oldRuns: 3 });
    const row = evalProofBasis(artifact)!;
    expect(row).toMatchObject({ outcome: "ran", cases: { total: 4, compared: 4, excluded: 0 }, passed: { old: { passed: 12, of: 12 }, new: { passed: 4, of: 4 } }, judge: { pin: hash, sameFamily: false }, baseline: { oldRuns: 3, cache: "hit", model: "model-a", modelVersion: "v1" } });
    expect(row.slices).toEqual([{ category: "ordinary", questions: 4, oldPassed: 12, oldOf: 12, newPassed: 4, newOf: 4 }]);
  });
  it("worse: the re-ask stages are held and charged too, and every hold is released with what it spent", async () => {
    const { access, ports, stages, facts } = await bound({ newPass: false });
    const artifact = read(await runFinalCheckEval(request, ports, facts()));
    expect(evalResultFromArtifact(artifact)).toMatchObject({ label: "Worse on eval", fixRequested: true, disposition: { check: "failure" } });
    expect(stages.length).toBeGreaterThan(1);
    expect(access.holds.length).toBe(stages.length);
    expect(access.forwarded.length).toBe(access.holds.reduce((n, h) => n + h.calls, 0));
    expect(access.released).toEqual(access.holds.map(h => ({ calls: h.calls, costMicros: h.costMicros, unknown: false })));
    expect(artifact.usage?.calls).toBe(access.forwarded.length);
  });
  it("hands the exec neither the grant nor the hold: only the egress path", async () => {
    let keys: string[] = [];
    const { ports, facts } = await bound({ exec: inner => ({ run: async r => { keys = Object.keys(r).sort(); return inner.run(r); } }) });
    await runFinalCheckEval(request, ports, facts());
    expect(keys).toEqual(["egress", "ids", "runs", "scope", "side", "signal"]);
  });
  it("asks the port only for the grant the approval returned, never another company's", async () => {
    const { w, access, capabilities, facts } = await bound();
    const ports = createEvalFinalCheckPorts({ ...capabilities, approval: { read: async () => ({ ...w.grant, company: "company-b" }) } })!;
    expect(evalResultFromArtifact(await runFinalCheckEval(request, ports, facts())).notRun?.reason).toBe("spend_not_approved");
    expect(access.holds).toEqual([]); expect(access.forwarded).toEqual([]);
  });
});

describe("a provider or gateway fault is Not run, never a pass and never Worse", () => {
  const notRun = (artifact: unknown) => { const result = evalResultFromArtifact(artifact); expect(result.label).toBe("Not run"); expect(result.disposition).toMatchObject({ check: "neutral", retry: true, draft: false }); return result.notRun!.reason; };
  it.each([
    ["rate limit", classAnswer("rate_limit", 429), "rate_limit"], ["quota", classAnswer("quota", 429), "quota"], ["overloaded", classAnswer("overloaded", 503), "overloaded"],
    ["refused key", classAnswer("key_refused", 401), "key_refused"], ["adapter refusal", classAnswer("refused", 403), "refused"], ["gateway cap", classAnswer("cap", 429), "cap"], ["provider error", classAnswer("provider_error", 502), "provider_error"],
  ])("%s on the second call", async (_name, bad, reason) => {
    const { access, ports, facts } = await bound({ newPass: false, script: (_f, i) => (i === 1 ? bad : answer()) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe(reason);
    expect(access.forwarded.length).toBe(2);
    expect(JSON.stringify(artifact)).not.toContain("questions");
  });
  it("a cut-off answer retains the spend as unknown and stops", async () => {
    const { access, ports, facts } = await bound({ script: (_f, i) => (i === 0 ? answer() : [{ kind: "head", status: 200, headers: [] }, { kind: "chunk", bytes: new Uint8Array(3) }]) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("provider_error");
    expect(access.released.at(-1)).toMatchObject({ unknown: true }); expect(access.forwarded.length).toBe(2);
  });
  it("a thrown gateway fault never reaches the artifact", async () => {
    const { ports, facts } = await bound({ script: () => Promise.reject(new Error("gateway-secret key-CANARY")) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("provider_error"); expect(JSON.stringify(artifact)).not.toContain("CANARY");
  });
  it("a refused hold is over budget, with no call", async () => {
    const { access, ports, facts } = await bound(); access.refuse("undefined");
    expect(notRun(await runFinalCheckEval(request, ports, facts()))).toBe("cap");
    expect(access.forwarded).toEqual([]);
  });
  it("a throwing hold is over budget too and says nothing of why", async () => {
    const { access, ports, facts } = await bound(); access.refuse("throw");
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("cap"); expect(JSON.stringify(artifact)).not.toContain("gateway-secret");
  });
  it("a failing exec is Not run and the hold is still released", async () => {
    const { access, ports, facts } = await bound({ exec: () => ({ run: async () => { throw new Error("docker-secret"); } }) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("provider_error"); expect(JSON.stringify(artifact)).not.toContain("docker-secret");
    expect(access.released).toHaveLength(access.holds.length);
  });
  it("an overrun settle stops the stage and is not a pass", async () => {
    const { access, ports, facts } = await bound({ script: () => answer({ overrun: true }) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("provider_error"); expect(access.forwarded.length).toBe(1);
  });
  it("an eval that makes more calls than its stage was held for is over budget, never graded on what it wrote", async () => {
    const { access, ports, facts } = await bound({ newPass: false, exec: inner => ({ run: async r => { await collect(r.egress.forward(r.scope, frame("extra"))); for (let i = 0; i < r.ids.length * r.runs; i++) await collect(r.egress.forward(r.scope, frame("again"))); return inner.run(r); } }) });
    const artifact = await runFinalCheckEval(request, ports, facts());
    expect(notRun(artifact)).toBe("cap"); expect(JSON.stringify(artifact)).not.toContain("questions");
    expect(access.released.every(r => !r.unknown)).toBe(true);
  });
  it("a stop that lands while the exec is still running is Not run, never Worse, whatever the report says", async () => {
    const controller = new AbortController();
    const { ports, facts } = await bound({ newPass: false, exec: inner => ({ run: async r => { controller.abort(); return inner.run(r); } }) });
    expect(notRun(await runFinalCheckEval(request, ports, facts(controller.signal)))).toBe("stopped");
  });
  it("a stop during the first stage is Not run: stopped, and nothing is held after it", async () => {
    const controller = new AbortController();
    const { access, ports, facts } = await bound({ exec: inner => ({ run: async r => { const out = await inner.run(r); controller.abort(); return out; } }) });
    const artifact = await runFinalCheckEval(request, ports, facts(controller.signal));
    expect(notRun(artifact)).toBe("stopped"); expect(access.holds).toHaveLength(1); expect(access.released).toHaveLength(1);
  });
});

describe("the proof row carries no basis when nothing was compared", () => {
  it("a Not run round and an unconfigured eval carry none", async () => {
    const { ports, facts } = await bound({ script: () => classAnswer("rate_limit", 429) });
    const a = read(await runFinalCheckEval(request, ports, facts()));
    expect(a.basis).toBeUndefined();
    const { w, capabilities } = await bound();
    const ports2 = createEvalFinalCheckPorts({ ...capabilities, plan: async () => ({ ...w.plan, evalConfigured: false }) })!;
    const none = read(await runFinalCheckEval(request, ports2, { status: "verified", candidateDigest: "a".repeat(64), signal: new AbortController().signal }));
    expect(none.basis).toBeUndefined(); expect(none.notRunReason).toBe("no_eval_configured");
  });
});
