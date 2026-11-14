import { attestRovaraOnlyBaseCheckout, ModelEgressFrameSchema, evalCaseCallVia, runEvalCasesPaced } from "@agentx/contracts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runEvalRound, type EvalRoundInput } from "../../packages/worker/src/verification/eval-round.js";
import { evalFactsAllRun } from "../../packages/contracts/src/eval-pacing.js";
import { evalCommandFingerprint, type EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";
import { fakeModelEgressWorld, COMPANY_A, COMPANY_B } from "../../packages/testing/src/ports/model-egress-world.js";
import { validFrame } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
let tripwire: NetworkTripwire;
beforeAll(() => { tripwire = installNetworkTripwire(); });
afterAll(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const hash = "b".repeat(64);
const samples = (pass: boolean, count: number) => Array.from({ length: count }, () => ({ pass, answer: pass ? "old answer" : "new answer" }));
async function setup(n = 3) {
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "te-f3c-round-")); roots.push(root);
  const ids = Array.from({ length: n }, (_, i) => `q${i}`);
  const record: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }], caseCount: n, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1, questions: ids.map(id => ({ id, samples: samples(true, 3) })) };
  const requests: Array<{ side: string; ids: readonly string[]; runs: number }> = [];
  let first = true;
  const input: EvalRoundInput = {
    trigger: { needed: true, reason: "changes" }, roundKind: "check_unsealed",
    key: { company: "org-a", project: "project-a", baseCommit: "a".repeat(40), commandFingerprint: evalCommandFingerprint("eval"), catalogRowId: "gemini", model: "model-a", modelVersion: "version-a" },
    settings: { runs: 3, seed: "legacy", repeats: 3, imageDigest: "image", route: "customer" },
    evalSetHash: hash, report: { root, cwd: ".", argument: "unused.json", notBeforeMs: Date.now() - 1000 }, facts: evalFactsAllRun(n),
    cache: { read: async () => record, write: async () => "stored" }, runBaseRound: async () => ({ ok: false }), today: () => "2026-11-13",
    questionPlan: {
      company: "org-a", provider: "customer", connected: true, previousPasses: 0,
      judgePin: hash, baselineJudgePin: hash, subsetSupported: true,
      questions: ids.map(id => ({ id, category: "ordinary", baseHash: hash, headHash: hash })),
      maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 100,
      run: async request => {
        requests.push(request);
        const fail = request.side === "new";
        const path = `run-${requests.length}.json`;
        await writeFile(join(root, path), JSON.stringify({ schemaVersion: 1, measures: record.measures, questions: request.ids.map(id => ({ id, samples: samples(!fail, request.runs) })) }));
        const changed = first && request.side === "new"; first = false;
        return { attestation: attestRovaraOnlyBaseCheckout({ baseCommit: input.key.baseCommit }), report: { root, cwd: ".", argument: path, notBeforeMs: Date.now() - 1000 }, facts: evalFactsAllRun(request.ids.length * request.runs), calls: request.ids.length * request.runs, costMicros: 100 * request.ids.length * request.runs, changedPromptCalls: changed ? n : 0 };
      },
    },
  };
  return { root, input, requests, record };
}
describe("worker question round", () => {
  it("uses the saved baseline, asks suspects three times on each side and returns normal PR/red check", async () => {
    const { input, requests } = await setup();
    const result = await runEvalRound(input);
    expect(result).toMatchObject({ status: "done", cache: "hit", result: { label: "Worse on eval", disposition: { draft: false, check: "failure" }, questions: [{ change: "broke" }, { change: "broke" }, { change: "broke" }] } });
    expect(requests.slice(0, 3)).toEqual([{ side: "new", ids: ["q0", "q1", "q2"], runs: 1 }, { side: "old", ids: ["q0", "q1", "q2"], runs: 3 }, { side: "new", ids: ["q0", "q1", "q2"], runs: 3 }]);
  });
  it("accepts tier eval_hint reasons, never a kind or a duplicate filename classifier", async () => {
    const { input, requests } = await setup();
    expect(await runEvalRound({ ...input, trigger: { needed: false, reason: "none_found" }, tier: { reasons: ["eval_hint"] } })).toMatchObject({ status: "done", result: { label: "Worse on eval" } });
    expect(requests.length).toBeGreaterThan(0);
    requests.length = 0;
    expect(await runEvalRound({ ...input, trigger: { needed: false, reason: "none_found" }, tier: { reasons: [] } })).toEqual({ status: "skipped", reason: "none_found" });
    expect(requests).toHaveLength(0);
  });
  it.each(["calls", "cost", "key", "scope", "judge", "round", "working"])("refuses %s before spending", async guard => {
    const { input, requests } = await setup();
    const plan = input.questionPlan!;
    const changed = { ...plan, ...(guard === "calls" ? { limits: { maxCalls: 1 } } : {}), ...(guard === "cost" ? { limits: { maxCostMicros: 1 } } : {}), ...(guard === "key" ? { connected: false } : {}), ...(guard === "scope" ? { company: "org-b" } : {}), ...(guard === "judge" ? { judgePin: "c".repeat(64) } : {}), ...(guard === "round" ? { previousPasses: 2 } : {}) };
    expect(await runEvalRound({ ...input, roundKind: guard === "working" ? "working" : input.roundKind, questionPlan: changed })).toMatchObject({ status: "done", result: { label: "Not run", disposition: { check: "neutral", retry: true } } });
    expect(requests).toHaveLength(0);
  });
  it("does not turn a legacy aggregate cache record into invented three-run evidence", async () => {
    const { input, requests, record } = await setup();
    const legacy = { ...record };
    delete legacy.questions;
    expect(await runEvalRound({ ...input, cache: { ...input.cache, read: async () => legacy } })).toMatchObject({ status: "done", result: { label: "Not run" } });
    expect(requests).toHaveLength(0);
  });
});

it("runs fake customer ModelEgress with pacing and charges only that company; outage has no pass/fail", async () => {
  const { input } = await setup(1);
  const world = fakeModelEgressWorld(); const model = world.rows.gemini!;
  let time = 0;
  const call = evalCaseCallVia(world.adapter, world.scope(COMPANY_A, model.id), () => ModelEgressFrameSchema.parse(validFrame(model, world.connection)));
  const config = input.questionPlan!;
  const run: typeof config.run = async request => {
    const pacing = await runEvalCasesPaced({ cases: request.ids.length * request.runs, call, clock: { now: () => time, sleep: async ms => { time += ms; } } });
    const report = await config.run(request);
    return { ...report, facts: pacing.facts, calls: pacing.started, costMicros: pacing.spentMicros };
  };
  const result = await runEvalRound({ ...input, questionPlan: { ...config, maxCostMicrosPerQuestion: 100_000, run } });
  expect(result).toMatchObject({ result: { label: "No drop found", questions: [{ change: "broke" }] } });
  expect(world.provider.calls).toHaveLength(7);
  expect(await world.meterOf(COMPANY_A)).not.toEqual(await world.meterOf(COMPANY_B));
  world.provider.script({ status: 500, body: "{}" });
  expect(await runEvalRound({ ...input, questionPlan: { ...config, maxCostMicrosPerQuestion: 100_000, run } })).toMatchObject({ result: { label: "Not run", disposition: { check: "neutral" } } });
});
it("preserves first-look Worse after a provider failure on re-asks", async () => {
  const { input } = await setup(4); const plan = input.questionPlan!;
  expect(await runEvalRound({ ...input, questionPlan: { ...plan, run: request => request.side === "old" ? Promise.reject(new Error("customer-secret")) : plan.run(request) } })).toMatchObject({ result: { label: "Worse on eval", disposition: { check: "failure" } } });
});
it("whole-set second look works without subsets and a missing later report cannot become No drop", async () => {
  const { input, requests } = await setup(2); const plan = input.questionPlan!;
  expect(await runEvalRound({ ...input, questionPlan: { ...plan, subsetSupported: false } })).toMatchObject({ result: { label: "Worse on eval", notices: ["Question re-asks skipped: the runner cannot run a subset."] } });
  expect(requests.map(r => [r.side, r.runs])).toEqual([["new", 1], ["new", 2]]);
  expect(await runEvalRound({ ...input, questionPlan: { ...plan, subsetSupported: false, run: request => request.runs === 2 ? Promise.reject(new Error("outage")) : plan.run(request) } })).toMatchObject({ result: { label: "Not run" } });
});
it("records edited questions separately and never lets their broken answers drive the verdict", async () => {
  const { input } = await setup(3); const plan = input.questionPlan!;
  const result = await runEvalRound({ ...input, questionPlan: { ...plan, questions: plan.questions.map(q => ({ ...q, headHash: "c".repeat(64) })) } });
  expect(result).toMatchObject({ result: { label: "Not run", excluded: [{ id: "q0", reason: "edited" }, { id: "q1", reason: "edited" }, { id: "q2", reason: "edited" }] } });
});
it("missing question ids, extra ids and invalid spend fail closed", async () => {
  for (const mode of ["missing", "extra", "spend"] as const) {
    const { input } = await setup(3); const plan = input.questionPlan!;
    const result = await runEvalRound({ ...input, questionPlan: { ...plan, run: async request => {
      const answer = await plan.run({ ...request, ids: mode === "missing" ? request.ids.slice(1) : mode === "extra" ? [...request.ids, "rogue"] : request.ids });
      return { ...answer, facts: evalFactsAllRun(request.ids.length * request.runs), ...(mode === "spend" ? { costMicros: NaN } : {}) };
    } } });
    expect(result, mode).toMatchObject({ result: { label: "Not run" } });
  }
});

it("validates the cached samples before spending, even with a custom cache adapter", async () => {
  const { input, requests, record } = await setup();
  const malformed = { ...record, questions: record.questions!.map(q => ({ ...q, samples: q.samples.map(a => ({ ...a, pass: .7 })) })) };
  expect(await runEvalRound({ ...input, cache: { ...input.cache, read: async () => malformed as never } })).toMatchObject({ result: { label: "Not run" } });
  expect(requests).toHaveLength(0);
});
it("pacing caps include earlier task spend and both permitted passes", async () => {
  const { input, requests } = await setup(1); const plan = input.questionPlan!;
  expect(await runEvalRound({ ...input, questionPlan: { ...plan, previousPasses: 1, callsAlreadyUsed: 195 } })).toMatchObject({ result: { notRun: { reason: "cap" } } });
  expect(requests).toHaveLength(0);
  expect(await runEvalRound({ ...input, questionPlan: { ...plan, previousPasses: 1 } })).toMatchObject({ result: { label: "No drop found" } });
});

it("requests just one fix round, then reports the remaining break without another fix request", async () => {
  const { input } = await setup(1);
  expect(await runEvalRound(input)).toMatchObject({ result: { fixRequested: true } });
  const second = await setup(1);
  expect(await runEvalRound({ ...second.input, questionPlan: { ...second.input.questionPlan!, previousPasses: 1 } })).toMatchObject({ result: { label: "No drop found", fixRequested: false } });
});
it.each(["rate_limit", "quota", "overloaded", "key_refused"] as const)("keeps the provider's %s not-run class", async reason => {
  const { input } = await setup(1); const plan = input.questionPlan!;
  const result = await runEvalRound({ ...input, questionPlan: { ...plan, run: async request => ({ ...await plan.run(request), facts: { total: 1, run: 0, notRun: 1, byClass: { [reason]: 1 }, overrunStop: false } }) } });
  expect(result).toMatchObject({ result: { label: "Not run", notRun: { reason } } });
});
it.each(["manifest", "duplicate", "budget", "provider", "set"])("rejects invalid %s before a model call", async mode => {
  const { input, requests } = await setup(mode === "duplicate" ? 2 : 1); const plan = input.questionPlan!;
  const config = { ...plan, ...(mode === "manifest" ? { questions: plan.questions.map(q => ({ ...q, baseHash: "bad" })) } : {}), ...(mode === "duplicate" ? { questions: [plan.questions[0]!, plan.questions[0]!] } : {}), ...(mode === "budget" ? { limits: { maxCalls: Infinity } } : {}), ...(mode === "provider" ? { provider: "agent" as never } : {}) };
  const result = await runEvalRound({ ...input, ...(mode === "set" ? { evalSetHash: undefined } : {}), questionPlan: config } as EvalRoundInput);
  expect(result).toMatchObject({ result: { label: "Not run" } });
  expect(requests).toHaveLength(0);
});

it("fresh old-code samples require the real checkout attestation for the requested base commit", async () => {
  for (const mode of ["missing", "forged", "wrong_commit"] as const) {
    const { input } = await setup(3); const plan = input.questionPlan!;
    const result = await runEvalRound({ ...input, questionPlan: { ...plan, run: async request => {
      const output = await plan.run(request);
      if (request.side !== "old") return output;
      const attestation = mode === "missing" ? undefined : mode === "forged" ? { checkout: "rovara_only", workingSandboxPaused: true, baseCommit: input.key.baseCommit } : attestRovaraOnlyBaseCheckout({ baseCommit: "c".repeat(40) });
      return { ...output, attestation } as Awaited<ReturnType<typeof plan.run>>;
    } } });
    expect(result, mode).toMatchObject({ result: { label: "Not run", notRun: { reason: "base_round_unattested" } } });
  }
});
it("supports its 1000-question bound with a configured cap and records every re-ask omission", async () => {
  const { input } = await setup(1000);
  const result = await runEvalRound({ ...input, questionPlan: { ...input.questionPlan!, limits: { maxCalls: 4000 } } });
  expect(result).toMatchObject({ result: { label: "Worse on eval", casesRun: 1000 } });
  if (result.status === "done") expect(result.result.excluded).toHaveLength(990);
});
it.each(["estimate", "task_cap", "overrun"])("keeps a fully answered first-run failure after %s, and starts no more calls", async mode => {
  const { input, requests } = await setup(4); const plan = input.questionPlan!;
  const result = await runEvalRound({ ...input, questionPlan: { ...plan, run: async request => {
    const output = await plan.run(request);
    return { ...output, ...(mode === "estimate" ? { costMicros: 1000 } : mode === "task_cap" ? { costMicros: 3_000_000 } : { facts: { ...output.facts, overrunStop: true } }) };
  } } });
  expect(result).toMatchObject({ result: { label: "Worse on eval", disposition: { check: "failure" } } });
  expect(requests).toHaveLength(1);
});

it("reports actual calls and cost for public questions and no numeric usage for a private set", async () => {
  const publicRound = await setup(3);
  expect(await runEvalRound(publicRound.input)).toMatchObject({ usage: { calls: 21, costMicros: 2100 } });
  const { root, input } = await setup(3);
  const result = await runEvalRound({ ...input, roundKind: "check_sealed", hiddenSet: { exists: async () => true, open: async () => ({ hostPath: root, hash }) }, hashHiddenSet: async () => hash });
  expect(result).toMatchObject({ status: "done", feedback: { pass: false }, result: { questions: [], casesRun: 0 } });
  expect(result).not.toHaveProperty("usage");
});

it("reads the original-set baseline when questions were edited, comparing only untouched questions", async () => {
  const { input, record } = await setup(3); const plan = input.questionPlan!; const headHash = "c".repeat(64);
  const result = await runEvalRound({ ...input, evalSetHash: headHash, cache: { ...input.cache, read: async parts => parts.evalSetHash === hash ? record : undefined }, questionPlan: {
    ...plan, baseEvalSetHash: hash,
    questions: plan.questions.map((q, i) => ({ ...q, headHash: i === 0 ? headHash : hash })),
    run: async request => {
      const output = await plan.run(request);
      const path = join(output.report.root, output.report.argument);
      const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...file, eval_set_hash: request.side === "old" ? hash : headHash }));
      return output;
    },
  } });
  expect(result).toMatchObject({ result: { label: "Worse on eval", casesRun: 2, excluded: [{ id: "q0", reason: "edited" }] } });
});
it("distinguishes a missing product key from a provider refusing a key", async () => {
  const { input, requests } = await setup(1);
  expect(await runEvalRound({ ...input, questionPlan: { ...input.questionPlan!, connected: false } })).toMatchObject({ result: { notRun: { reason: "no_product_key" } } });
  expect(requests).toHaveLength(0);
});

it("shows the no-eval prompt-change notice only when absence is known", async () => {
  const { input, requests } = await setup();
  const { questionPlan, ...withoutPlan } = input;
  expect(questionPlan).toBeDefined();
  const absent = { ...withoutPlan, tier: { reasons: ["eval_hint"] }, evalConfigured: false, trigger: { needed: false, reason: "none_found" as const } };
  const notice = "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.";
  expect(await runEvalRound(absent)).toMatchObject({ status: "done", result: { label: "Not run", notices: [notice], disposition: { check: "neutral", retry: true } } });
  expect(requests).toEqual([]);
  expect(await runEvalRound({ ...withoutPlan, tier: { reasons: ["eval_hint"] } })).toMatchObject({ result: { notices: [] } });
  expect(await runEvalRound({ ...absent, tier: { reasons: [] } })).toEqual({ status: "skipped", reason: "none_found" });
});

it.each(["calls", "coverage_negative", "coverage_excess", "report_hash", "report_missing", "sample_count", "baseline_ids"] as const)("refuses invalid %s at the question boundary", async mode => {
  const { input, record, requests } = await setup(1); const plan = input.questionPlan!;
  const result = await runEvalRound({ ...input,
    cache: { ...input.cache, read: async () => mode === "baseline_ids" ? { ...record, questions: record.questions!.map(q => ({ ...q, id: "other" })) } : record },
    questionPlan: { ...plan, run: async request => {
      const output = await plan.run(request);
      if (mode === "calls") return { ...output, calls: NaN };
      if (mode === "coverage_negative") return { ...output, changedPromptCalls: -1 };
      if (mode === "coverage_excess") return { ...output, changedPromptCalls: output.calls + 1 };
      const path = join(output.report.root, output.report.argument);
      if (mode === "report_missing") await rm(path);
      if (mode === "report_hash" || mode === "sample_count") {
        const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(path, JSON.stringify({ ...file, ...(mode === "report_hash" ? { eval_set_hash: "d".repeat(64) } : { questions: request.ids.map(id => ({ id, samples: samples(false, 2) })) }) }));
      }
      return output;
    } },
  });
  expect(result).toMatchObject({ result: { label: "Not run", notRun: { reason: mode === "report_hash" ? "eval_set_changed" : mode === "report_missing" ? "no_measures_file" : "invalid_question_data" } } });
  expect(requests).toHaveLength(mode === "baseline_ids" ? 0 : 1);
});
