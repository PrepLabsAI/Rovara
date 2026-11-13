// TE-F3-b: a hidden round returns at a FIXED wall-clock moment, whatever the runner did (the pause gap is the one thing the paused agent can time).
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentBaseScoreCache, evalCommandFingerprint } from "../../packages/contracts/src/eval-base-cache.js";
import { evalGatePlanHash } from "../../packages/contracts/src/eval-gate-inputs.js";
import { createDocumentHoldoutLedger } from "../../packages/contracts/src/eval-holdout.js";
import { evalFactsAllRun, type EvalClock } from "../../packages/contracts/src/eval-pacing.js";
import { MeasuresFileSchema, type EvalQuestionResult } from "../../packages/contracts/src/measures-file.js";
import { HIDDEN_ROUND_SLOT_MS_DEFAULT, runGatedEvalRoundInSlot, runInHiddenSlot } from "../../packages/worker/src/verification/eval-hidden-slot.js";
import type { GatedEvalRoundInput } from "../../packages/worker/src/verification/eval-gate-round.js";
import { BEFORE_TASK, FIRST_CODE, PLAN, TASK_STARTED, questionSet } from "../support/eval-gate-world.js";

const real: EvalClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const SLOT = 120;
const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => { const t0 = Date.now(); const value = await run(); return { value, ms: Date.now() - t0 }; };

describe("the fixed slot", () => {
  it("returns at the slot's end whether the runner finished at once, crashed, or never finished (and then aborts it)", async () => {
    const quick = await timed(() => runInHiddenSlot({ slotMs: SLOT, clock: real, run: () => Promise.resolve("ok") }));
    const crash = await timed(() => runInHiddenSlot({ slotMs: SLOT, clock: real, run: () => Promise.reject(new Error("x")) }));
    let aborted = false;
    const slow = await timed(() => runInHiddenSlot({ slotMs: SLOT, clock: real, run: (signal) => new Promise<string>((resolve) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve("late"), 2_000); }) }));
    expect(quick.value).toEqual({ status: "done", value: "ok" });
    expect(crash.value).toEqual({ status: "failed" });
    expect(slow.value).toEqual({ status: "timed_out" });
    expect(aborted).toBe(true);
    for (const run of [quick, crash, slow]) { expect(run.ms).toBeGreaterThanOrEqual(SLOT - 15); expect(run.ms).toBeLessThan(SLOT + 400); }
  });
  it("uses the injected clock, and a default of ten minutes for a slot that is not a whole number", async () => {
    let now = 0;
    const slept: number[] = [];
    const clock: EvalClock = { now: () => now, sleep: (ms) => { slept.push(ms); now += ms; return Promise.resolve(); } };
    await runInHiddenSlot({ slotMs: 500, clock, run: () => Promise.resolve(1) });
    expect(slept.at(-1)).toBe(500);
    slept.length = 0;
    await runInHiddenSlot({ slotMs: Number.NaN, clock, run: () => Promise.resolve(1) });
    expect(slept.at(-1)).toBe(600_000);
    expect(HIDDEN_ROUND_SLOT_MS_DEFAULT).toBe(600_000);
  });
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const rows = (list: readonly EvalQuestionResult[]) => list.map((row) => ({ id: row.id, category: row.category, score: row.score, run: row.run }));
const text = (list: readonly EvalQuestionResult[], seed: string | undefined) => JSON.stringify({ schemaVersion: 2, seed, measures: [{ name: "accuracy", unit: "fraction", value: 0.5, direction: "up_good" }], questions: rows(list) });
async function round(): Promise<GatedEvalRoundInput> {
  const root = await mkdtemp(join(tmpdir(), "te-f3b-slot-"));
  dirs.push(root);
  const visible = questionSet();
  const holdout = questionSet({ prefix: "h" });
  await writeFile(join(root, "visible.json"), text(visible.head, visible.headSeed));
  await writeFile(join(root, "holdout.json"), text(holdout.head, holdout.headSeed));
  await mkdir(join(root, "hidden"));
  const hidden = join(await realpath(root), "hidden");
  const at = (argument: string) => ({ root, cwd: ".", argument, notBeforeMs: Date.now() - 5_000 });
  const attestation = { checkout: "rovara_only", workingSandboxPaused: true, baseCommit: "a".repeat(40) } as const;
  const read = (list: readonly EvalQuestionResult[], seed: string | undefined, hash: string) => Promise.resolve({ ok: true as const, measures: MeasuresFileSchema.parse(JSON.parse(text(list, seed))), caseCount: 40, facts: evalFactsAllRun(40), evalSetHash: hash, attestation });
  const held = new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" });
  return {
    trigger: { needed: true, reason: "changes" }, roundKind: "check_sealed", project: "project-1", task: "task-1",
    key: { company: "org_aaaaaaaaaaaaaaaaaaaa", project: "project-1", baseCommit: "a".repeat(40), commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01" },
    settings: { imageDigest: `runner@sha256:${"1".repeat(64)}`, route: "gateway" }, hashHiddenSet: () => Promise.resolve("d".repeat(64)),
    cache: createDocumentBaseScoreCache(held, { companyId: "org_aaaaaaaaaaaaaaaaaaaa" }), ledger: createDocumentHoldoutLedger(held, { companyId: "org_aaaaaaaaaaaaaaaaaaaa", limit: 1 }),
    hiddenSet: { exists: () => Promise.resolve(true), open: () => Promise.resolve({ hostPath: hidden, hash: "d".repeat(64) }) },
    visible: { report: at("visible.json"), baseEvalSetHash: "b".repeat(64), headEvalSetHash: "b".repeat(64), setCommittedAt: BEFORE_TASK, runBaseRound: () => read(visible.base, visible.baseSeed, "b".repeat(64)) },
    holdout: { report: at("holdout.json"), baseEvalSetHash: "c".repeat(64), headEvalSetHash: "c".repeat(64), setCommittedAt: BEFORE_TASK, sampleSize: 30, rotationSecret: "a-rovara-side-secret-value", runBaseRound: () => read(holdout.base, holdout.baseSeed, "c".repeat(64)) },
    gate: { plan: PLAN, recordedPlanHash: evalGatePlanHash(PLAN), times: { taskStartedAt: TASK_STARTED, firstCodeAt: FIRST_CODE }, judge: { kind: "none" }, edits: { status: "known", editedQuestionIds: [], scoringEdited: false, thresholdsEdited: false }, coverage: { changedItems: ["p"], exercised: [{ item: "p", questions: 9 }] } },
    facts: evalFactsAllRun(80), holdoutFacts: evalFactsAllRun(80), today: () => "2026-11-13",
  };
}

describe("the gated round in its slot", () => {
  it("takes the same wall-clock time for a pass, for a used-up check limit and for a runner that never ends", async () => {
    const input = await round();
    const ran = await timed(() => runGatedEvalRoundInSlot(input, () => Promise.resolve(), { slotMs: SLOT, clock: real }));
    expect(ran.value).toMatchObject({ status: "done", gate: { qualified: true }, feedback: { result: "pass" } });
    const usedUp = await timed(() => runGatedEvalRoundInSlot(input, () => Promise.resolve(), { slotMs: SLOT, clock: real }));
    expect(usedUp.value).toMatchObject({ gate: { detail: "holdout_checks_used_up" }, feedback: { result: "not_run" } });
    const fresh = await round();
    const never = await timed(() => runGatedEvalRoundInSlot(fresh, (_plan, signal) => new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve()); }), { slotMs: SLOT, clock: real }));
    expect(never.value).toMatchObject({ gate: { detail: "hidden_round_timed_out" }, feedback: { result: "not_run" } });
    const crashRound = await round();
    const crash = await timed(() => runGatedEvalRoundInSlot(crashRound, () => Promise.reject(new Error("runner failed")), { slotMs: SLOT, clock: real }));
    expect(crash.value).toMatchObject({ gate: { qualified: false }, feedback: { result: "not_run" } });
    for (const run of [ran, usedUp, never, crash]) { expect(run.ms).toBeGreaterThanOrEqual(SLOT - 15); expect(run.ms).toBeLessThan(SLOT + 500); }
  });
  it("counts the hidden round against the limit even when its runner timed out, and does not touch a round that needs no eval", async () => {
    const input = await round();
    await runGatedEvalRoundInSlot(input, () => new Promise<void>(() => undefined), { slotMs: 40, clock: real });
    const second = await runGatedEvalRoundInSlot(input, () => Promise.resolve(), { slotMs: 40, clock: real });
    expect(second).toMatchObject({ gate: { detail: "holdout_checks_used_up" } });
    const skip = await timed(() => runGatedEvalRoundInSlot({ ...input, trigger: { needed: false, reason: "none_found" } }, () => Promise.resolve(), { slotMs: SLOT, clock: real }));
    expect(skip.value).toEqual({ status: "skipped", reason: "none_found" });
    expect(skip.ms).toBeLessThan(SLOT);
  });
});
