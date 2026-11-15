// F9: trusted, injected ports only. No production caller, token issuance or artifact I/O here.
import { z } from "zod";
import {
  EVAL_NOT_RUN_CLASSES, EVAL_PACING_DEFAULTS, REAL_MODEL_NOT_RUN, TEST_ID_MAX, isRerunnableTestId,
  type EvalMeterReservation, type EvalSpendApproval, type EvalSpendGrant, type MonthlyMeter,
  type RealModelCheckWriteSchema, type RealModelNotRunReason, type EvalRoundKind,
} from "@agentx/contracts";
import { withStepTimeout } from "../agent-step.js";
import { tierRequestsEval, type EvalTrigger, type EvalRoundInput } from "./eval-round.js";
import { testFileOf, type ChangedPath } from "./selection.js";
import { RERUN_COMMANDS_MAX } from "./test-ids.js";

export interface ScriptedAiTest { checkId: string; test: string; modelCalls: number | "unknown"; modelFiles?: readonly string[] | undefined }
export interface ChangedAiTestsInput { changes: readonly ChangedPath[]; tests: readonly ScriptedAiTest[]; attribution: "test" | "check" }
export type ChangedAiTests = { status: "selected"; tests: ScriptedAiTest[] } | { status: "not_run"; reason: RealModelNotRunReason; count?: number };
const INPUT_ITEMS_MAX = 10_000;
const INPUT_BYTES_MAX = 2 * 1024 * 1024;
const TIME_LIMIT_MS = 5 * 60 * 1000;
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const record = (raw: unknown): raw is Record<string, unknown> => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const pathSchema = z.string().min(1).max(1024).refine(path => !path.startsWith("/") && !path.split("/").includes("..") && !/[\p{Cc}\p{Cf}\\]/u.test(path));
const scriptedSchema = z.object({ checkId: z.string().min(1).max(64), test: z.string().min(1).max(TEST_ID_MAX).refine(isRerunnableTestId), modelCalls: z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.literal("unknown")]), modelFiles: z.array(pathSchema).optional() });
const selectionSchema = z.object({ changes: z.array(z.object({ path: pathSchema, status: z.enum(["added", "modified", "deleted", "renamed"]), oldPath: pathSchema.optional() })), tests: z.array(scriptedSchema), attribution: z.enum(["test", "check"]) });

/** One total inventory/byte/file budget, checked before parsing. Linear indexed matching, never patterns × tests. */
export function selectChangedAiTests(raw: unknown): ChangedAiTests {
  const refuse = (reason: RealModelNotRunReason): ChangedAiTests => ({ status: "not_run", reason });
  if (!record(raw) || !Array.isArray(raw.changes) || !Array.isArray(raw.tests)) return refuse("invalid_input");
  if (raw.changes.length + raw.tests.length > INPUT_ITEMS_MAX) return refuse("input_limit");
  let bytes = 0; let files = raw.changes.length;
  const add = (value: unknown): boolean => {
    if (typeof value !== "string") return true; // The schema rejects wrong types.
    if (value.length > INPUT_BYTES_MAX - bytes) return false;
    bytes += Buffer.byteLength(value, "utf8");
    return bytes <= INPUT_BYTES_MAX;
  };
  for (const row of raw.changes as unknown[]) {
    if (!record(row) || !add(row.path) || !add(row.oldPath)) return refuse("input_limit");
  }
  for (const row of raw.tests as unknown[]) {
    if (!record(row) || !add(row.checkId) || !add(row.test)) return refuse("input_limit");
    if (Array.isArray(row.modelFiles)) {
      files += row.modelFiles.length;
      if (files > INPUT_ITEMS_MAX) return refuse("input_limit");
      for (const file of row.modelFiles as unknown[]) if (!add(file)) return refuse("input_limit");
    }
  }
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) return refuse("invalid_input");
  const input = parsed.data;
  const changed = new Set(input.changes.filter(p => p.status !== "deleted").map(p => p.path));
  const modelChanged = new Set(input.changes.flatMap(p => p.oldPath === undefined ? [p.path] : [p.path, p.oldPath]));
  const seen = new Set<string>(); const selected: ScriptedAiTest[] = [];
  for (const item of input.tests) {
    const key = JSON.stringify([item.checkId, item.test]);
    if (seen.has(key)) return refuse("invalid_input");
    seen.add(key);
    const relevant = changed.has(testFileOf(item.test)) || (input.attribution === "test" && item.modelFiles?.some(path => modelChanged.has(path)) === true);
    if (!relevant) continue;
    if (item.modelCalls === "unknown") return refuse("call_count_unknown");
    if (item.modelCalls > 0) selected.push(item);
  }
  if (selected.length > RERUN_COMMANDS_MAX) return { status: "not_run", reason: "too_many_tests", count: selected.length };
  return selected.length === 0 ? refuse("attribution_unknown") : { status: "selected", tests: selected };
}

type TestIdentity = Pick<ScriptedAiTest, "checkId" | "test">;
type WrittenCheck = z.infer<typeof RealModelCheckWriteSchema>;
export interface RealModelTestsInput {
  candidateDigest: string; company: string; project: string;
  trigger: EvalTrigger; tier?: EvalRoundInput["tier"]; roundKind: EvalRoundKind;
  selection: ChangedAiTestsInput;
  maxCostMicrosPerCall: number;
  callsAlreadyUsed: number; costAlreadyUsedMicros: number;
  approval?: EvalSpendApproval; meter?: MonthlyMeter;
  /** Trusted adapter: use the existing check timeout/abort guard, join its sandbox, and report every id.
   * A provider refusal must produce not_run, not an assertion failure. No stdout/errors/keys returned.
   * Approval/meter ports retain their bounded-deadline and uncertain-usage retention contracts. */
  run(request: { ids: readonly TestIdentity[]; attempt: 1 | 2; call: EvalMeterReservation["call"]; signal: AbortSignal }): Promise<{
    model: string; items: Array<TestIdentity & { result: "passed" | "failed" | "not_run"; reason?: RealModelNotRunReason }>;
  }>;
}
const headerSchema = z.object({
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), company: z.string().min(1).max(160), project: z.string().min(1).max(160),
  trigger: z.object({ needed: z.boolean(), reason: z.enum(["incomplete", "changes", "none_found"]) }),
  tier: z.object({ reasons: z.array(z.object({ code: z.string().max(64), path: z.string().max(1024).optional() })).max(100) }).optional(),
  maxCostMicrosPerCall: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  callsAlreadyUsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), costAlreadyUsedMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const grantSchema = z.object({ company: z.string(), project: z.string(), selection: z.literal("real-model-tests"), inputsDigest: z.string().regex(/^[a-f0-9]{64}$/u), role: z.enum(["owner", "maintainer", "admin"]), provider: z.literal("customer"), connected: z.boolean(), maxCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), maxCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const outputSchema = z.object({ model: z.string().min(1).max(160), items: z.array(z.object({ checkId: z.string().min(1).max(64), test: z.string().min(1).max(TEST_ID_MAX), result: z.enum(["passed", "failed", "not_run"]), reason: z.enum(Object.keys(REAL_MODEL_NOT_RUN) as [RealModelNotRunReason, ...RealModelNotRunReason[]]).optional() })).max(RERUN_COMMANDS_MAX) });
const identity = (item: TestIdentity): string => JSON.stringify([item.checkId, item.test]);

/** Run once and re-run just failures once. The stage holds only its own estimate; task use is cumulative. */
export async function runRealModelTests(raw: RealModelTestsInput): Promise<WrittenCheck> {
  const valid = headerSchema.safeParse(raw);
  const candidateDigest = valid.success ? valid.data.candidateDigest : "0".repeat(64);
  let items: Array<WrittenCheck["items"][number] & TestIdentity> = []; let calls = 0; let costMicros = 0; let model: string | null = null;
  const finish = (reason?: RealModelNotRunReason, tooManyCount?: number, skipped = false): WrittenCheck => {
    const totals = { selected: items.length, passed: 0, passedOnRerun: 0, failed: 0, notRun: 0 };
    for (const item of items) totals[item.result === "passed_on_rerun" ? "passedOnRerun" : item.result === "not_run" ? "notRun" : item.result] += 1;
    const status = skipped ? "skipped" : totals.selected === totals.notRun ? "not_run" : reason !== undefined || totals.notRun > 0 || items.some(i => i.result === "failed" && i.reason !== undefined) ? "partly_run" : "completed";
    return { schemaVersion: 1, candidateDigest, status, items, totals, calls, costMicros, model, ...(reason === undefined ? {} : { reason }), ...(tooManyCount === undefined ? {} : { tooManyCount }) };
  };
  if (!valid.success) return finish("invalid_input");
  const input = valid.data;
  if (!input.trigger.needed && !tierRequestsEval(input.tier === undefined ? undefined : { reasons: input.tier.reasons.map(r => ({ code: r.code })) })) return finish(undefined, undefined, true);
  if (typeof raw.approval?.read !== "function" || typeof raw.meter?.reserve !== "function") return finish("ports_missing");
  if (raw.roundKind !== "check_unsealed" && raw.roundKind !== "check_sealed") return finish("round_kind");
  if (typeof raw.run !== "function") return finish("invalid_input");
  const selection = selectChangedAiTests(raw.selection);
  if (selection.status === "not_run") return finish(selection.reason, selection.count);
  const selected = selection.tests;
  items = selected.map(i => ({ checkId: i.checkId, test: i.test, result: "not_run", reason: "run_unavailable" }));
  const controller = new AbortController();
  const deadline = Date.now() + TIME_LIMIT_MS;
  // Use the worker's existing guard with ONE deadline shared by both stages and call admission.
  // Abort fences every later dispatch. Bounded adapter cleanup joins calls before closing their hold.
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted || Date.now() >= deadline) { controller.abort(); throw new Error("real model time limit"); }
    return withStepTimeout({ abort: async () => { controller.abort(); } }, deadline - Date.now(), () => Promise.resolve().then(run));
  };
  const mark = (stage: readonly ScriptedAiTest[], reason: RealModelNotRunReason, attempt: 1 | 2): void => {
    const keys = new Set(stage.map(identity));
    items = items.map(item => keys.has(identity(item)) ? { checkId: item.checkId, test: item.test, result: attempt === 2 ? "failed" : "not_run", reason } : item);
  };
  let stageReason: RealModelNotRunReason | undefined;
  for (const attempt of [1, 2] as const) {
    const failed = new Set(items.filter(i => i.result === "failed").map(identity));
    const stage = attempt === 1 ? selected : selected.filter(i => failed.has(identity(i)));
    if (stage.length === 0) break;
    const refuse = (reason: RealModelNotRunReason): void => { stageReason = reason; mark(stage, reason, attempt); };
    const estimateCalls = 2 * stage.reduce((total, i) => total + (i.modelCalls === "unknown" ? NaN : i.modelCalls), 0);
    const estimateCost = estimateCalls * input.maxCostMicrosPerCall;
    let reservation: EvalMeterReservation | undefined;
    let grant: EvalSpendGrant;
    try {
      const granted = await timed(() => raw.approval!.read());
      if (granted === undefined) { refuse("approval_missing"); break; }
      const parsed = grantSchema.safeParse(granted);
      if (!parsed.success || parsed.data.company !== input.company || parsed.data.project !== input.project) { refuse("approval_invalid"); break; }
      grant = parsed.data;
      if (!grant.connected) { refuse("no_product_key"); break; }
      if (![estimateCalls, estimateCost].every(whole)) { refuse("invalid_input"); break; }
      if (estimateCalls > EVAL_PACING_DEFAULTS.maxCalls - input.callsAlreadyUsed - calls || estimateCost > EVAL_PACING_DEFAULTS.maxCostMicros - input.costAlreadyUsedMicros - costMicros) { refuse("task_cap"); break; }
      // For this selection the grant ceilings are the project's per-task caps, including prior use.
      if (estimateCalls > grant.maxCalls - input.callsAlreadyUsed - calls || estimateCost > grant.maxCostMicros - input.costAlreadyUsedMicros - costMicros) { refuse("grant_cap"); break; }
      // A late reservation still belongs to this operation and must be closed, even after the deadline.
      const reserving = raw.meter.reserve({ approval: grant, calls: estimateCalls, costMicros: estimateCost });
      try { reservation = await timed(() => reserving); }
      catch { reservation = await reserving; if (reservation !== undefined) await reservation.close(); throw new Error("real model reservation unavailable"); }
      if (reservation === undefined) { refuse("monthly_cap"); break; }
    } catch { refuse(controller.signal.aborted ? "timed_out" : "approval_missing"); break; }
    let accepting = true; let requested = 0; let successes = 0;
    let halt: RealModelNotRunReason | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    const stop = (reason: RealModelNotRunReason): never => { halt ??= reason; throw new Error("real model call unavailable"); };
    const call: EvalMeterReservation["call"] = frame => {
      if (!accepting || controller.signal.aborted || requested >= estimateCalls) return Promise.reject(new Error("real model call unavailable"));
      requested += 1;
      // Serial dispatch makes the one-call overrun rule hold even if an adapter submits concurrently.
      const work = tail.then(async () => {
        if (controller.signal.aborted) return stop("timed_out");
        if (halt !== undefined) return stop(halt);
        if (calls + input.callsAlreadyUsed >= EVAL_PACING_DEFAULTS.maxCalls || costMicros + input.costAlreadyUsedMicros >= EVAL_PACING_DEFAULTS.maxCostMicros) return stop("task_cap");
        if (calls + input.callsAlreadyUsed >= grant.maxCalls || costMicros + input.costAlreadyUsedMicros >= grant.maxCostMicros) return stop("grant_cap");
        let outcome;
        try { outcome = await reservation.call(frame); } catch { return stop("provider_error"); }
        if (!record(outcome) || !whole(outcome.calls) || !whole(outcome.costMicros) || !whole(calls + outcome.calls) || !whole(costMicros + outcome.costMicros)) return stop("invalid_usage");
        calls += outcome.calls; costMicros += outcome.costMicros;
        if (outcome.calls !== 1) return stop("invalid_usage");
        if (outcome.class !== "ok") return stop((EVAL_NOT_RUN_CLASSES as readonly string[]).includes(outcome.class) ? outcome.class : "invalid_usage");
        successes += 1;
        if (costMicros + input.costAlreadyUsedMicros > EVAL_PACING_DEFAULTS.maxCostMicros) halt = "task_cap";
        else if (costMicros + input.costAlreadyUsedMicros > grant.maxCostMicros) halt = "grant_cap";
        return outcome;
      });
      tail = work.catch(() => undefined);
      return work;
    };
    let output: unknown;
    let running: Promise<unknown> | undefined;
    let closeFailed = false;
    let failure: RealModelNotRunReason | undefined;
    try {
      output = await timed(() => {
        running = raw.run({ ids: stage.map(i => ({ checkId: i.checkId, test: i.test })), attempt, call, signal: controller.signal });
        return running;
      });
    } catch { failure = controller.signal.aborted ? "timed_out" : halt ?? "run_unavailable"; }
    finally {
      // Drain already submitted calls, but fence new late submissions immediately.
      accepting = false;
      if (controller.signal.aborted) await running?.catch(() => undefined);
      const joined = tail;
      // Queued dispatches remain permitted until joined unless a timeout/refusal halted them.
      try { await timed(() => joined); }
      catch { failure ??= "timed_out"; await joined; }
      try { await reservation.close(); } catch { closeFailed = true; }
    }
    if (failure !== undefined) { refuse(failure); break; }
    if (!record(output) || !Array.isArray(output.items) || output.items.length !== stage.length) { refuse("invalid_results"); break; }
    const parsed = outputSchema.safeParse(output);
    if (!parsed.success) { refuse("invalid_results"); break; }
    const rows = parsed.data.items;
    const keys = new Set(stage.map(identity));
    const resultKeys = new Set(rows.map(identity));
    if (resultKeys.size !== stage.length || rows.some(i => !keys.has(identity(i))) || rows.filter(i => i.result !== "not_run").length > successes || (model !== null && model !== parsed.data.model)) { refuse(halt ?? "invalid_results"); break; }
    model = parsed.data.model;
    const byId = new Map(rows.map(i => [identity(i), i]));
    items = items.map(item => {
      const row = byId.get(identity(item));
      if (row === undefined) return item;
      if (row.result === "not_run") return { checkId: item.checkId, test: item.test, result: attempt === 2 ? "failed" : "not_run", reason: halt ?? row.reason ?? "run_unavailable" };
      return { checkId: item.checkId, test: item.test, result: row.result === "passed" && attempt === 2 ? "passed_on_rerun" : row.result };
    });
    if (closeFailed) {
      stageReason = "close_unavailable";
      if (attempt === 1) mark(selected.filter(i => items.some(row => identity(row) === identity(i) && row.result === "failed")), stageReason, 2);
      break;
    }
    if (halt !== undefined || items.some(i => i.result === "not_run")) {
      stageReason = halt ?? items.find(i => i.result === "not_run")!.reason;
      // Do not erase a first failure or spend again after a provider refusal.
      if (attempt === 1) mark(selected.filter(i => items.some(row => identity(row) === identity(i) && row.result === "failed")), stageReason ?? "run_unavailable", 2);
      break;
    }
  }
  return finish(stageReason);
}
