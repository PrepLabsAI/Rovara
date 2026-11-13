// TE-F3-b part B: the gated worker round. Real path: files on disk read through A4's reader, the document-store cache and ledger, the gate. No model call: the round is handed the facts of the calls.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentBaseScoreCache, evalCommandFingerprint } from "../../packages/contracts/src/eval-base-cache.js";
import { evalGatePlanHash } from "../../packages/contracts/src/eval-gate-inputs.js";
import { createDocumentHoldoutLedger } from "../../packages/contracts/src/eval-holdout.js";
import { evalFactsAllRun, evalFactsFromClasses } from "../../packages/contracts/src/eval-pacing.js";
import { MeasuresFileSchema, type EvalQuestionResult } from "../../packages/contracts/src/measures-file.js";
import { completeGatedEvalRound, planGatedEvalRound, runGatedEvalRound, type GatedBaseRoundRead, type GatedEvalRoundInput } from "../../packages/worker/src/verification/eval-gate-round.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";
import { PLAN, TASK_STARTED, FIRST_CODE, BEFORE_TASK, questionSet, type SetOptions } from "../support/eval-gate-world.js";

let tripwire: NetworkTripwire;
beforeAll(() => { tripwire = installNetworkTripwire(); });
afterAll(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const COMMIT = "a".repeat(40);
const VISIBLE_HASH = "b".repeat(64);
const HOLDOUT_HASH = "c".repeat(64);
const HIDDEN_HASH = "d".repeat(64);
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const rows = (list: readonly EvalQuestionResult[]) => list.map((row) => ({ id: row.id, category: row.category, score: row.score, run: row.run }));
const fileText = (list: readonly EvalQuestionResult[], seed: string | undefined, over: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 2, eval_set_hash: "f".repeat(64), ...(seed === undefined ? {} : { seed }), measures: [{ name: "accuracy", unit: "fraction", value: 0.5, direction: "up_good" }], questions: rows(list), ...over });
const baseRead = (list: readonly EvalQuestionResult[], seed: string | undefined, over: Partial<Extract<GatedBaseRoundRead, { ok: true }>> = {}): GatedBaseRoundRead => ({ ok: true, measures: MeasuresFileSchema.parse(JSON.parse(fileText(list, seed))), caseCount: 40, facts: evalFactsAllRun(40), attested: true, ...over });

interface Setup { input: GatedEvalRoundInput; counts: { baseVisible: number; baseHoldout: number; opened: number }; held: MemoryDocumentStore; root: string }
async function setup(options: { visible?: SetOptions; holdout?: SetOptions; headVisibleText?: string; modelVersion?: string; held?: MemoryDocumentStore; company?: string; attested?: boolean; baseFacts?: ReturnType<typeof evalFactsFromClasses>; sealed?: boolean; trigger?: boolean; hidden?: boolean } = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "te-f3b-round-"));
  dirs.push(root);
  const visible = questionSet(options.visible);
  const holdout = questionSet({ prefix: "h", ...options.holdout });
  await writeFile(join(root, "visible.json"), options.headVisibleText ?? fileText(visible.head, visible.headSeed));
  await writeFile(join(root, "holdout.json"), fileText(holdout.head, holdout.headSeed));
  const held = options.held ?? new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
  const company = options.company ?? COMPANY;
  const counts = { baseVisible: 0, baseHoldout: 0, opened: 0 };
  const location = (argument: string) => ({ root, cwd: ".", argument, notBeforeMs: Date.now() - 5_000 });
  const attested = options.attested ?? true;
  const input: GatedEvalRoundInput = {
    trigger: { needed: options.trigger ?? true, reason: "changes" }, roundKind: options.sealed === false ? "check_unsealed" : "check_sealed", project: "project-1", task: "task-1",
    key: { company, project: "project-1", baseCommit: COMMIT, commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: options.modelVersion ?? "gemini-small-2026-10-01" },
    cache: createDocumentBaseScoreCache(held, { companyId: company }), ledger: createDocumentHoldoutLedger(held, { companyId: company }),
    ...(options.hidden === false ? {} : { hiddenSet: { exists: () => Promise.resolve(true), open: () => { counts.opened += 1; return Promise.resolve({ hostPath: "/rovara-hidden/set", hash: HIDDEN_HASH }); } } }),
    visible: { report: location("visible.json"), evalSetHash: VISIBLE_HASH, setCommittedAt: BEFORE_TASK, runBaseRound: () => { counts.baseVisible += 1; return Promise.resolve(baseRead(visible.base, visible.baseSeed, { attested, ...(options.baseFacts === undefined ? {} : { facts: options.baseFacts }) })); } },
    holdout: { report: location("holdout.json"), evalSetHash: HOLDOUT_HASH, setCommittedAt: BEFORE_TASK, sampleSize: 30, rotationSecret: "a-rovara-side-secret-value", runBaseRound: () => { counts.baseHoldout += 1; return Promise.resolve(baseRead(holdout.base, holdout.baseSeed, { attested, ...(options.baseFacts === undefined ? {} : { facts: options.baseFacts }) })); } },
    gate: {
      plan: PLAN, recordedPlanHash: evalGatePlanHash(PLAN), times: { taskStartedAt: TASK_STARTED, firstCodeAt: FIRST_CODE }, judge: { kind: "none" }, edits: { status: "known", editedQuestionIds: [], scoringEdited: false, thresholdsEdited: false },
      coverage: { changedItems: ["prompt:system"], exercised: [{ item: "prompt:system", questions: 12 }] },
    },
    facts: evalFactsAllRun(80), today: () => "2026-11-13",
  };
  return { input, counts, held, root };
}

describe("the gated round", () => {
  it("measures the base on a miss, caches the clean attested rounds, and answers the agent pass or fail only", async () => {
    const { input, counts } = await setup();
    const out = await runGatedEvalRound(input);
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.gate).toMatchObject({ label: "no_regression_eval", qualified: true });
    expect(out.feedback).toEqual({ result: "pass" });
    expect(out.cache).toEqual({ visible: "filled", holdout: "filled" });
    expect(out.hiddenMount).toEqual({ hostPath: "/rovara-hidden/set", containerPath: "/rovara/hidden-eval", readOnly: true });
    expect(counts).toMatchObject({ baseVisible: 1, baseHoldout: 1 });
    expect(out.gate.holdout?.questions).toBe(30);
    expect(JSON.stringify(out.feedback)).not.toMatch(/\d/u);
  });
  it("uses the cached baseline the second time: the old code is not run again", async () => {
    const first = await setup();
    await runGatedEvalRound(first.input);
    const second = await setup({ held: first.held });
    const out = await runGatedEvalRound({ ...second.input, task: "task-2" });
    expect(second.counts).toMatchObject({ baseVisible: 0, baseHoldout: 0 });
    expect(out).toMatchObject({ status: "done", cache: { visible: "hit", holdout: "hit" }, gate: { qualified: true } });
  });
  it("re-runs the old code when the model version changed, and not for another reason", async () => {
    const first = await setup();
    await runGatedEvalRound(first.input);
    const changed = await setup({ held: first.held, modelVersion: "gemini-small-2026-11-01" });
    const out = await runGatedEvalRound({ ...changed.input, task: "task-3" });
    expect(changed.counts).toMatchObject({ baseVisible: 1, baseHoldout: 1 });
    expect(out).toMatchObject({ status: "done", gate: { qualified: true } });
  });
  it("does not use a cached baseline that was run with another seed: the old code is run again", async () => {
    const first = await setup({ visible: { baseSeed: "an-older-seed" }, holdout: { baseSeed: "an-older-seed" } });
    expect(await runGatedEvalRound(first.input)).toMatchObject({ gate: { qualified: false, detail: "baseline_too_old" } });
    const second = await setup({ held: first.held });
    await runGatedEvalRound({ ...second.input, task: "task-2" });
    expect(second.counts).toMatchObject({ baseVisible: 1, baseHoldout: 1 });
  });
  it("never caches a base round Rovara did not attest to, or one with cases left unrun", async () => {
    const unattested = await setup({ attested: false });
    expect(await runGatedEvalRound(unattested.input)).toMatchObject({ cache: { visible: "not_filled", holdout: "not_filled" }, gate: { qualified: true } });
    const again = await setup({ held: unattested.held, attested: false });
    await runGatedEvalRound({ ...again.input, task: "task-2" });
    expect(again.counts.baseVisible).toBe(1);
    const dirty = await setup({ baseFacts: evalFactsFromClasses([...Array.from({ length: 20 }, () => "ok"), ...Array.from({ length: 20 }, () => "rate_limit")]) });
    const out = await runGatedEvalRound(dirty.input);
    expect(out).toMatchObject({ cache: { visible: "not_filled" }, gate: { qualified: false, detail: "provider_outage" }, feedback: { result: "not_run" } });
  });
  it("keeps one company's baseline from another (the key holds the company)", async () => {
    const first = await setup();
    await runGatedEvalRound(first.input);
    const other = await setup({ held: first.held, company: "org_bbbbbbbbbbbbbbbbbbbb" });
    await runGatedEvalRound(other.input);
    expect(other.counts).toMatchObject({ baseVisible: 1, baseHoldout: 1 });
  });
  it("uses the eval set hash Rovara computed, never the head file's own word", async () => {
    const { input } = await setup();
    const out = await runGatedEvalRound({ ...input, visible: { ...input.visible, evalSetHash: "e".repeat(64) } });
    expect(out).toMatchObject({ status: "done", gate: { qualified: true } });
    const keyed = await setup();
    await runGatedEvalRound(keyed.input);
    const other = await setup({ held: keyed.held });
    await runGatedEvalRound({ ...other.input, task: "task-9", visible: { ...other.input.visible, evalSetHash: "e".repeat(64) } });
    expect(other.counts.baseVisible).toBe(1);
    expect(other.counts.baseHoldout).toBe(0);
  });
  it("tells the agent fail for a drop on either set, without saying which or by how much", async () => {
    const { input } = await setup({ holdout: { delta: () => -0.05 } });
    const out = await runGatedEvalRound(input);
    expect(out).toMatchObject({ gate: { regression: true }, feedback: { result: "fail" } });
  });
  it("is not run when the head file is a newer version, a v1 file with no questions, or missing", async () => {
    const newer = await setup({ headVisibleText: JSON.stringify({ schemaVersion: 3, measures: [] }) });
    expect(await runGatedEvalRound(newer.input)).toMatchObject({ gate: { qualified: false, detail: "inputs_unreadable" }, feedback: { result: "not_run" } });
    const v1 = await setup({ headVisibleText: JSON.stringify({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.5, direction: "up_good" }] }) });
    expect(await runGatedEvalRound(v1.input)).toMatchObject({ gate: { qualified: false }, feedback: { result: "not_run" } });
    const missing = await setup();
    await rm(join(missing.root, "visible.json"));
    expect(await runGatedEvalRound(missing.input)).toMatchObject({ gate: { detail: "inputs_unreadable" } });
  });
});

describe("the holdout's limits in the round", () => {
  it("counts the check before it runs: three checks per task, then used up with no base round and no mount", async () => {
    const first = await setup();
    for (let index = 0; index < 3; index += 1) {
      const round = await setup({ held: first.held });
      expect((await runGatedEvalRound(round.input)).status).toBe("done");
    }
    const fourth = await setup({ held: first.held });
    const out = await runGatedEvalRound(fourth.input);
    expect(out).toMatchObject({ status: "done", gate: { qualified: false, detail: "holdout_checks_used_up" }, feedback: { result: "not_run" } });
    expect(out.status === "done" ? out.hiddenMount : "x").toBeUndefined();
    expect(fourth.counts).toMatchObject({ baseVisible: 0, baseHoldout: 0 });
    const otherTask = await setup({ held: first.held });
    expect(await runGatedEvalRound({ ...otherTask.input, task: "task-other" })).toMatchObject({ gate: { qualified: true } });
  });
  it("counts a check even when the round then fails (a half-run check cannot be retried for free)", async () => {
    const first = await setup();
    await rm(join(first.root, "holdout.json"));
    await runGatedEvalRound(first.input);
    await runGatedEvalRound(first.input);
    await runGatedEvalRound(first.input);
    expect(await runGatedEvalRound(first.input)).toMatchObject({ gate: { detail: "holdout_checks_used_up" } });
  });
  it("numbers the checks of one task, so the rotation moves to other holdout questions each time", async () => {
    const { input } = await setup();
    expect(await planGatedEvalRound(input)).toMatchObject({ status: "ready", checkIndex: 0 });
    expect(await planGatedEvalRound(input)).toMatchObject({ status: "ready", checkIndex: 1 });
    expect(await planGatedEvalRound(input)).toMatchObject({ status: "ready", checkIndex: 2 });
    expect(await planGatedEvalRound(input)).toMatchObject({ status: "stopped" });
    const out = await runGatedEvalRound((await setup()).input);
    expect(out.status === "done" && out.gate.holdout?.excluded.notSelected).toBe(10);
  });
  it("opens the hidden set only in the sealed round: any other round answers 'no holdout', counts nothing and opens nothing", async () => {
    const round = await setup({ sealed: false });
    const out = await runGatedEvalRound(round.input);
    expect(out).toMatchObject({ status: "done", gate: { qualified: false, detail: "no_holdout" }, feedback: { result: "not_run" } });
    expect(round.counts.opened).toBe(0);
    expect(round.counts).toMatchObject({ baseVisible: 0, baseHoldout: 0 });
    // Nothing was counted: all three checks of the task are still there.
    const next = await setup({ held: round.held });
    expect(await planGatedEvalRound(next.input)).toMatchObject({ status: "ready", checkIndex: 0 });
  });
  it("does nothing, reads nothing and counts nothing when no eval is needed, and says 'no holdout' when the project keeps none", async () => {
    const skip = await setup({ trigger: false });
    expect(await runGatedEvalRound(skip.input)).toEqual({ status: "skipped", reason: "changes" });
    expect(skip.counts).toMatchObject({ baseVisible: 0, opened: 0 });
    const none = await setup({ hidden: false });
    expect(await runGatedEvalRound(none.input)).toMatchObject({ gate: { detail: "no_holdout" } });
  });
  it("plans first (ledger + mount), then completes: the plan carries the check number and the read-only mount", async () => {
    const { input } = await setup();
    const plan = await planGatedEvalRound(input);
    expect(plan).toMatchObject({ status: "ready", checkIndex: 0, hiddenHash: HIDDEN_HASH, hiddenMount: { readOnly: true } });
    if (plan.status !== "ready") return;
    expect(await completeGatedEvalRound(input, plan)).toMatchObject({ status: "done", gate: { qualified: true } });
  });
});
