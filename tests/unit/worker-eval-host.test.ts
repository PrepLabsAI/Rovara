// The eval host binding end to end on fakes: the composed ports drive `runFinalCheckEval`; the model-access port is a script
// and the sandbox exec is a script that sends its model traffic through the egress it is given. No network, no real clock.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, evalResultFromArtifact, EvalRoundArtifactSchema, type EvalRequest, type ModelEgressEvent } from "@agentx/contracts";
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
});

describe("a provider or gateway fault is Not run, never a pass and never Worse", () => {
  const notRun = (artifact: unknown) => { const result = evalResultFromArtifact(artifact); expect(result.label).toBe("Not run"); expect(result.disposition).toMatchObject({ check: "neutral", retry: true, draft: false }); return result.notRun!.reason; };
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
