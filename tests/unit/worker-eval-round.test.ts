// TE-F3 part B: the worker's eval round. It reads `rovara-measures.json` through A4's reader, looks up or fills the base cache (only from Rovara's own base round), keeps the hidden set to the sealed round, and returns the eval check
// for the evidence writer through a typed seam. No model call: the round is handed the facts of the calls that were made (the pacing module and the fake adapter produce them in eval-pacing.test.ts).
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentBaseScoreCache, evalCommandFingerprint, type BaseScoreCache, type EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";
import { MeasuresFileSchema } from "../../packages/contracts/src/measures-file.js";
import { evalFactsAllRun, evalFactsFromClasses } from "../../packages/contracts/src/eval-pacing.js";
import type { HiddenEvalSetSource } from "../../packages/contracts/src/eval-hidden-set.js";
import { runEvalRound, readEvalMeasures, type EvalRoundInput } from "../../packages/worker/src/verification/eval-round.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../packages/testing/src/ports/no-network.js";

let tripwire: NetworkTripwire;
beforeAll(() => { tripwire = installNetworkTripwire(); });
afterAll(() => { tripwire.restore(); expect(tripwire.attempts).toEqual([]); });

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function workspace(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "te-f3-round-")); dirs.push(dir); return dir; }

const SET_HASH = "b".repeat(64);
const HIDDEN_HASH = "d".repeat(64);
const COMMIT = "a".repeat(40);
const measuresText = (over: Record<string, unknown> = {}, extra: Array<Record<string, unknown>> = []) => JSON.stringify({ schemaVersion: 1, eval_set_hash: SET_HASH, measures: [{ name: "accuracy", unit: "fraction", value: 0.82, direction: "up_good", spread: 0.05, count: 50, ...over }, ...extra] });
const baseFile = (value = 0.8, hash = SET_HASH) => MeasuresFileSchema.parse({ schemaVersion: 1, eval_set_hash: hash, measures: [{ name: "accuracy", unit: "fraction", value, direction: "up_good", spread: 0.05, count: 50 }] });

function store() { return new MemoryDocumentStore({ ttlAttribute: "expiresAtSeconds" }); }
const cacheFor = (held: MemoryDocumentStore, company: string): BaseScoreCache => createDocumentBaseScoreCache(held, { companyId: company });

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Setup { root: string; input: Mutable<EvalRoundInput>; baseRuns: { count: number }; cache: BaseScoreCache; held: MemoryDocumentStore }
async function setup(over: Partial<EvalRoundInput> = {}, options: { head?: string; company?: string; held?: MemoryDocumentStore; baseFile?: ReturnType<typeof baseFile> | undefined; baseFacts?: ReturnType<typeof evalFactsAllRun> } = {}): Promise<Setup> {
  const root = await workspace();
  await writeFile(join(root, "rovara-measures.json"), options.head ?? measuresText());
  const held = options.held ?? store();
  const company = options.company ?? "org_aaaaaaaaaaaaaaaaaaaa";
  const cache = cacheFor(held, company);
  const baseRuns = { count: 0 };
  const input: Mutable<EvalRoundInput> = {
    trigger: { needed: true, reason: "changes" },
    roundKind: "check_unsealed",
    report: { root, cwd: ".", argument: "rovara-measures.json", notBeforeMs: Date.now() - 1_000 },
    key: { company, project: "project-1", baseCommit: COMMIT, commandFingerprint: evalCommandFingerprint("npm run eval"), catalogRowId: "gemini", model: "gemini-small", modelVersion: "gemini-small-2026-10-01" },
    cache,
    runBaseRound: () => { baseRuns.count += 1; return Promise.resolve(options.baseFile === undefined && "baseFile" in options ? { ok: false as const } : { ok: true as const, measures: options.baseFile ?? baseFile(), caseCount: 50, facts: options.baseFacts ?? evalFactsAllRun(50) }); },
    facts: evalFactsAllRun(50),
    today: () => "2026-11-13",
    ...over,
  };
  return { root, input, baseRuns, cache, held };
}

describe("the trigger", () => {
  it("does nothing, reads nothing and runs no base round when no eval is needed", async () => {
    const { input, baseRuns } = await setup({ trigger: { needed: false, reason: "none_found" } });
    expect(await runEvalRound(input)).toEqual({ status: "skipped", reason: "none_found" });
    expect(baseRuns.count).toBe(0);
  });
});

describe("reading the runner's measures", () => {
  it("reads the named file through A4's reader, including the A4 fixture as it is", async () => {
    const root = await workspace();
    const { readFile } = await import("node:fs/promises");
    await writeFile(join(root, "m.json"), await readFile(new URL("../fixtures/report-adapters/measures.json", import.meta.url)));
    const read = await readEvalMeasures({ root, cwd: ".", argument: "m.json", notBeforeMs: Date.now() - 1_000 });
    expect(read).toMatchObject({ ok: true, measures: { eval_set_hash: "a".repeat(64), measures: [{ name: "accuracy", value: 0.9 }] } });
  });
  it("says 'not run: no readable measures file' for a missing, stale, malformed, newer or test-report file, never a score", async () => {
    for (const [name, text, stale] of [["missing", undefined, false], ["stale", measuresText(), true], ["malformed", "{not json", false], ["newer", JSON.stringify({ schemaVersion: 9, measures: [] }), false], ["junit", "<testsuite/>", false]] as const) {
      const { root, input } = await setup();
      if (text === undefined) await rm(join(root, "rovara-measures.json"));
      else await writeFile(join(root, "rovara-measures.json"), text);
      // A file left from before the round: the round started an hour after it was written.
      if (stale) input.report = { ...input.report, notBeforeMs: Date.now() + 3_600_000 };
      const out = await runEvalRound(input);
      expect(out, name).toMatchObject({ status: "done", result: { outcome: "not_run", notRun: { reason: "no_measures_file" } }, feedback: { measures: [] } });
    }
  });
});

describe("the base score cache in the round", () => {
  it("fills from Rovara's own base round on a miss, and the next round is a hit that runs no base round", async () => {
    const first = await setup();
    const out1 = await runEvalRound(first.input);
    expect(out1).toMatchObject({ status: "done", cache: "filled", result: { verdicts: [{ verdict: "no_detectable_change" }] } });
    expect(first.baseRuns.count).toBe(1);
    const second = await setup({}, { held: first.held });
    const out2 = await runEvalRound(second.input);
    expect(out2).toMatchObject({ status: "done", cache: "hit", result: { verdicts: [{ verdict: "no_detectable_change" }] } });
    expect(second.baseRuns.count).toBe(0);
  });
  it("is a fresh base run when the commit, eval set, hidden set, command, model or catalog row changes", async () => {
    const first = await setup();
    await runEvalRound(first.input);
    for (const change of [{ baseCommit: "c".repeat(40) }, { commandFingerprint: evalCommandFingerprint("other") }, { model: "m2" }, { modelVersion: "gemini-small-2026-11-01" }, { catalogRowId: "openai" }, { project: "p2" }]) {
      const next = await setup({}, { held: first.held });
      next.input.key = { ...next.input.key, ...change };
      expect(await runEvalRound(next.input), JSON.stringify(change)).toMatchObject({ status: "done", cache: "filled" });
      expect(next.baseRuns.count, JSON.stringify(change)).toBe(1);
    }
    const changedSet = await setup({}, { held: first.held, head: measuresText().replace(SET_HASH, "e".repeat(64)) });
    expect(await runEvalRound(changedSet.input)).toMatchObject({ status: "done", result: { notRun: { reason: "eval_set_changed" } } });
    expect(changedSet.baseRuns.count).toBe(1);
  });
  it("never uses another company's cached base: company B runs its own base round", async () => {
    const a = await setup();
    await runEvalRound(a.input);
    const b = await setup({}, { held: a.held, company: "org_bbbbbbbbbbbbbbbbbbbb" });
    const out = await runEvalRound(b.input);
    expect(out).toMatchObject({ status: "done", cache: "filled" });
    expect(b.baseRuns.count).toBe(1);
  });
  it("never caches a value from the head round: the cache holds only what the base round measured", async () => {
    const { input, held } = await setup({}, { head: measuresText({ value: 0.8123456 }) });
    await runEvalRound(input);
    const docs = (await held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items;
    expect(docs).toHaveLength(1);
    expect(JSON.stringify(docs)).not.toContain("0.8123456");
    expect(JSON.stringify(docs)).toContain("0.8");
  });
  it("does not fill the cache from a failed base round, from a base round with not-run cases, or from a working round, and compares nothing then", async () => {
    const failed = await setup({}, { baseFile: undefined });
    expect(await runEvalRound(failed.input)).toMatchObject({ status: "done", cache: "not_filled", result: { notRun: { reason: "no_base_score" } } });
    expect((await failed.held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items).toHaveLength(0);
    const partial = await setup({}, { baseFacts: evalFactsFromClasses(["rate_limit", ...Array.from({ length: 49 }, () => "ok")]) });
    expect(await runEvalRound(partial.input)).toMatchObject({ status: "done", cache: "not_filled", result: { outcome: "not_run", notRun: { reason: "no_base_score" }, measures: [] } });
    expect((await partial.held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items).toHaveLength(0);
    const working = await setup({ roundKind: "working" });
    expect(await runEvalRound(working.input)).toMatchObject({ status: "done", cache: "not_filled", result: { outcome: "passed" } });
    expect((await working.held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items).toHaveLength(0);
  });
  it("refuses to compare when the base round ran another eval set than the head, but still caches that base under its own hash", async () => {
    const odd = await setup({}, { baseFile: baseFile(0.8, "f".repeat(64)) });
    const out = await runEvalRound(odd.input);
    expect(out).toMatchObject({ status: "done", cache: "filled", result: { outcome: "not_run", notRun: { reason: "eval_set_changed" } } });
    expect((await odd.held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items).toHaveLength(1);
  });
  it("judges nothing when the head did not say which eval set it ran", async () => {
    const { input, baseRuns } = await setup({}, { head: JSON.stringify({ schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.82, direction: "up_good", spread: 0.05 }] }) });
    expect(await runEvalRound(input)).toMatchObject({ status: "done", cache: "not_used", result: { notRun: { reason: "eval_set_unknown" } } });
    expect(baseRuns.count).toBe(0);
  });
  it("a cache that fails to read is a miss and the round still completes", async () => {
    const broken: BaseScoreCache = { read: () => Promise.reject(new Error("down")), write: () => Promise.reject(new Error("down")) };
    const { input } = await setup({ cache: broken });
    expect(await runEvalRound(input)).toMatchObject({ status: "done", result: { verdicts: [{ verdict: "no_detectable_change" }] } });
  });
});

describe("the eval check for the evidence writer", () => {
  it("carries the measures, the verdict words and the summary line, and is never a change proof", async () => {
    const { input } = await setup({}, { head: measuresText({ value: 0.99 }) });
    const out = await runEvalRound(input);
    if (out.status !== "done") throw new Error("expected a done round");
    expect(out.result.summary).toBe("Eval (your runner): accuracy 0.99 fraction (main 0.8 fraction) · better than main beyond the noise band");
    expect(out.result.measures[0]).toMatchObject({ base: 0.8, head: 0.99, band: { low: 0.7, high: 0.9 } });
    expect("countsTowardProof" in out.result).toBe(false);
  });
  it("429s in the round are 'not run': a score over the run cases only, and not-run cases never lower it", async () => {
    const facts = evalFactsFromClasses([...Array.from({ length: 3 }, () => "rate_limit"), ...Array.from({ length: 47 }, () => "ok")]);
    const counted = await setup({ facts }, { head: measuresText({ count: 47 }) });
    const out = await runEvalRound(counted.input);
    expect(out).toMatchObject({ status: "done", result: { casesRun: 47, casesTotal: 50, verdicts: [{ verdict: "no_detectable_change" }] } });
    const lots = await setup({ facts: evalFactsFromClasses([...Array.from({ length: 20 }, () => "quota"), ...Array.from({ length: 30 }, () => "ok")]) });
    expect(await runEvalRound(lots.input)).toMatchObject({ status: "done", result: { outcome: "not_run", summary: "Eval (your runner): not run: provider quota used up" } });
  });
});

describe("the hidden eval set", () => {
  const canary = () => `c-${randomBytes(4).toString("hex")}`;
  function hidden(): { source: HiddenEvalSetSource; calls: { exists: number; open: number } } {
    const calls = { exists: 0, open: 0 };
    return { calls, source: { exists: () => { calls.exists += 1; return Promise.resolve(true); }, open: () => { calls.open += 1; return Promise.resolve({ hostPath: "/var/lib/rovara/hidden/project-1", hash: HIDDEN_HASH }); } } };
  }
  it("round matrix: the working and unsealed rounds are told to use the sealed round, never open the set, never read the runner's file, never run a base round, and mount nothing", async () => {
    for (const roundKind of ["working", "check_unsealed"] as const) {
      const { source, calls } = hidden();
      const { input, baseRuns } = await setup({ roundKind, hiddenSet: source });
      input.report = { ...input.report, argument: "does-not-exist.json" };
      const out = await runEvalRound(input);
      expect(out).toMatchObject({ status: "done", result: { outcome: "not_run", summary: "Eval (your runner): not run: the hidden eval set needs the sealed round" }, feedback: { measures: [] } });
      expect(out.status === "done" ? out.hiddenMount : "x").toBeUndefined();
      expect(calls.open, roundKind).toBe(0);
      expect(baseRuns.count).toBe(0);
    }
  });
  it("the sealed round opens the set once and hands back a read-only mount for the sealed plan, only there", async () => {
    const { source, calls } = hidden();
    const { input } = await setup({ roundKind: "check_sealed", hiddenSet: source });
    const out = await runEvalRound(input);
    expect(calls.open).toBe(1);
    expect(out).toMatchObject({ status: "done", hiddenMount: { hostPath: "/var/lib/rovara/hidden/project-1", containerPath: "/rovara/hidden-eval", readOnly: true } });
  });
  it("keys the cache by the hidden set's hash too: a different hidden set is a fresh base run", async () => {
    const first = hidden();
    const a = await setup({ roundKind: "check_sealed", hiddenSet: first.source });
    await runEvalRound(a.input);
    const other: HiddenEvalSetSource = { exists: () => Promise.resolve(true), open: () => Promise.resolve({ hostPath: "/var/lib/rovara/hidden/project-1", hash: "e".repeat(64) }) };
    const b = await setup({ roundKind: "check_sealed", hiddenSet: other }, { held: a.held });
    await runEvalRound(b.input);
    expect(b.baseRuns.count).toBe(1);
    const same = await setup({ roundKind: "check_sealed", hiddenSet: first.source }, { held: a.held });
    await runEvalRound(same.input);
    expect(same.baseRuns.count).toBe(0);
  });
  it("fails closed when the sealed round cannot open the set", async () => {
    const source: HiddenEvalSetSource = { exists: () => Promise.resolve(true), open: () => Promise.reject(new Error("no")) };
    const { input, baseRuns } = await setup({ roundKind: "check_sealed", hiddenSet: source });
    expect(await runEvalRound(input)).toMatchObject({ status: "done", result: { outcome: "not_run", notRun: { reason: "hidden_set_unavailable" } } });
    expect(baseRuns.count).toBe(0);
  });
  it("a canary in the runner's own words (name, unit, an extra measure) never reaches the feedback, the evidence measures, the summary, the cache or anything the round returns", async () => {
    const marker = canary();
    const { source } = hidden();
    const head = measuresText({}, [{ name: marker, unit: marker, value: 0.4, direction: "up_good", spread: 0.1, count: 50 }]);
    const { input, held } = await setup({ roundKind: "check_sealed", hiddenSet: source }, { head });
    const out = await runEvalRound(input);
    expect(JSON.stringify(out)).not.toContain(marker);
    const stored = (await held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items;
    expect(JSON.stringify(stored)).not.toContain(marker);
    if (out.status !== "done") throw new Error("expected done");
    expect(out.feedback.measures.map((entry) => Object.keys(entry))).toEqual([["index", "score", "count"], ["index", "score", "count"]]);
  });
  it("the round holds no log of its own: a canary in the hidden set's path never appears in what it returns beyond the one mount path", async () => {
    const marker = canary();
    const source: HiddenEvalSetSource = { exists: () => Promise.resolve(true), open: () => Promise.resolve({ hostPath: "/var/lib/rovara/hidden/project-1", hash: HIDDEN_HASH }) };
    const { input } = await setup({ roundKind: "check_sealed", hiddenSet: source });
    const out = await runEvalRound(input);
    expect(JSON.stringify(out)).not.toContain(marker);
    expect(JSON.stringify(out.status === "done" ? { ...out, hiddenMount: undefined } : out)).not.toContain("/var/lib/rovara/hidden");
  });
});

describe("speed and shape", () => {
  it("handles a one-megabyte runner file and 50 measures without delay", async () => {
    const measures = Array.from({ length: 50 }, (_, index) => ({ name: `m${String(index)}`, unit: "u", value: index, direction: "up_good", spread: 1 }));
    const text = JSON.stringify({ schemaVersion: 1, eval_set_hash: SET_HASH, measures, padding_is_refused: "x".repeat(1_000_000) });
    const { input, root } = await setup();
    await writeFile(join(root, "rovara-measures.json"), text);
    const started = Date.now();
    const out = await runEvalRound(input);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toMatchObject({ status: "done", result: { notRun: { reason: "no_measures_file" } } });
  });
  it("accepts a stored record shaped exactly like today's writer produces", async () => {
    const record: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05, count: 50 }], caseCount: 50, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1 };
    const a = await setup();
    await runEvalRound(a.input);
    const [doc] = (await a.held.query({ pk: "ORG#org_aaaaaaaaaaaaaaaaaaaa#EVALBASE" })).items;
    expect(doc!["record"]).toEqual(record);
  });
});
