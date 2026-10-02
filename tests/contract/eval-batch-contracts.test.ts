import { describe, expect, it } from "vitest";
import {
  EvalBatchFileSchema,
  EvalBatchRecordSchema,
  EvalBatchSummarySchema,
  EvalRunMeasureSchema,
  SwebenchSettingsSchema,
  parseEvalBatchCommand,
  parseSwebenchCommand,
  summarize,
  wilsonInterval,
  type EvalRunMeasure,
} from "@agentx/contracts";

const settings = {
  stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:eval",
  subnetIds: ["subnet-0123456789abcdef0"],
  controlPlaneUrl: "https://control.example.com",
  logGroupName: "/agentx/eval",
};
const IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker@sha256:${"a".repeat(64)}`;
const model = { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" as const };
const file = { benchmark: "verified", tasks: ["django__django-11099", "astropy__astropy-12907"], models: [model], costCapUsd: 50 };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("maxConcurrentEvals (spec 052 FR-005)", () => {
  it("defaults to 4 for stored settings without it, accepts 1-6 and refuses 7 or 0", () => {
    expect(SwebenchSettingsSchema.parse(settings).maxConcurrentEvals).toBe(4);
    expect(SwebenchSettingsSchema.parse({ ...settings, maxConcurrentEvals: 6 }).maxConcurrentEvals).toBe(6);
    expect(SwebenchSettingsSchema.safeParse({ ...settings, maxConcurrentEvals: 7 }).success).toBe(false);
    expect(SwebenchSettingsSchema.safeParse({ ...settings, maxConcurrentEvals: 0 }).success).toBe(false);
  });
});

describe("EvalBatchFileSchema (FR-001, FR-003)", () => {
  it("parses a batch with tasks and applies defaults", () => {
    const parsed = EvalBatchFileSchema.parse(file);
    expect(parsed).toMatchObject({ repeats: 1, order: "cheapest-first" });
    expect(parsed.models[0]).toEqual(model);
  });

  it("takes a sample in place of tasks, but not both or neither", () => {
    expect(EvalBatchFileSchema.safeParse({ ...file, tasks: undefined, sample: { count: 10, seed: 7, strata: ["repo"] } }).success).toBe(true);
    expect(EvalBatchFileSchema.safeParse({ ...file, sample: { count: 10, seed: 7 } }).success).toBe(false);
    expect(EvalBatchFileSchema.safeParse({ ...file, tasks: undefined }).success).toBe(false);
  });

  it("refuses a task that does not fit the dataset", () => {
    const result = EvalBatchFileSchema.safeParse({ ...file, tasks: ["libpng.cve-2018-13785"] });
    expect(result.success).toBe(false);
  });

  it("accepts a provider pin, and refuses an unknown thinking level or extra key", () => {
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [{ ...model, routing: { only: ["anthropic"] } }] }).success).toBe(true);
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [{ ...model, thinkingLevel: "max" }] }).success).toBe(false);
    expect(EvalBatchFileSchema.safeParse({ ...file, extra: 1 }).success).toBe(false);
  });

  it.each([
    ["repeats 0", { repeats: 0 }],
    ["repeats 6", { repeats: 6 }],
    ["concurrency 7", { concurrency: 7 }],
    ["cap 0.5", { costCapUsd: 0.5 }],
    ["cap 1001", { costCapUsd: 1001 }],
    ["unknown order", { order: "random" }],
    ["unpinned image", { runnerImage: "123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-worker:latest" }],
  ])("refuses %s", (_name, patch) => {
    expect(EvalBatchFileSchema.safeParse({ ...file, ...patch }).success).toBe(false);
  });

  it("accepts a digest-pinned image and the cap bounds", () => {
    expect(EvalBatchFileSchema.safeParse({ ...file, runnerImage: IMAGE, costCapUsd: 1, concurrency: 6 }).success).toBe(true);
    expect(EvalBatchFileSchema.safeParse({ ...file, costCapUsd: 1000 }).success).toBe(true);
  });

  it("refuses more than 500 runs in total", () => {
    const models = Array.from({ length: 5 }, (_, i) => ({ ...model, modelId: `m${i}` }));
    const sampled = (count: number, repeats: number) => EvalBatchFileSchema.safeParse({ ...file, tasks: undefined, sample: { count, seed: 1 }, models, repeats });
    expect(sampled(100, 1).success).toBe(true); // 500
    expect(sampled(101, 1).success).toBe(false); // 505
    expect(sampled(50, 3).success).toBe(false); // 750
  });
});

describe("fix round 1 (053 selection, duplicates, claim state)", () => {
  it("requires an explicit thinking level per batch model", () => {
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [{ provider: "anthropic", modelId: "m" }] }).success).toBe(false);
  });
  it("refuses duplicate tasks and duplicate models, but allows two pins of one model", () => {
    expect(EvalBatchFileSchema.safeParse({ ...file, tasks: ["django__django-11099", "django__django-11099"] }).success).toBe(false);
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [model, { ...model }] }).success).toBe(false);
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [{ ...model, routing: { only: ["a"] } }, { ...model, routing: { only: ["b"] } }] }).success).toBe(true);
    expect(EvalBatchFileSchema.safeParse({ ...file, models: [model, { ...model, thinkingLevel: "high" }] }).success).toBe(true);
  });
  it("carries claim state: STARTING entries, claimedAt, version, estimates and the per-run ceiling", () => {
    const base = {
      batchId: uuid(1), file: EvalBatchFileSchema.parse(file), createdBy: { teamId: "T0123ABCD", userId: "U0123ABCD" },
      thread: { teamId: "T0123ABCD", channelId: "C0123ABCD", threadTs: "1700000000.000100" }, status: "RUNNING", spentUsd: 0,
      counts: { queued: 0, starting: 1, running: 0, done: 0, failed: 0, cancelled: 0, notStarted: 0 },
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const entry = { index: 0, task: "django__django-11099", model, repeat: 1, attempt: 1, state: "STARTING", claimedAt: "2026-10-01T00:00:00.000Z", estimatedCostUsd: 1.2 };
    const parsed = EvalBatchRecordSchema.parse({ ...base, queue: [entry], perRunCeilingUsd: 10 });
    expect(parsed.version).toBe(0);
    expect(parsed.queue[0]).toMatchObject({ state: "STARTING", estimatedCostUsd: 1.2 });
    expect(EvalBatchRecordSchema.safeParse({ ...base, queue: [entry], version: -1 }).success).toBe(false);
  });
  it("summarizes all-failed models with a null rate, counts unpriced runs, and keeps pins apart", () => {
    const rows = [
      measure({ runId: uuid(40), modelId: "z", outcome: "FAILED", resolved: undefined, costUsd: null }),
      measure({ runId: uuid(41), modelId: "p", routing: { only: ["a"] } }),
      measure({ runId: uuid(42), modelId: "p", routing: { only: ["b"] }, costUsd: null }),
    ];
    const [z, pa, pb] = summarize(rows);
    expect(z).toMatchObject({ runs: 0, failed: 1, rate: null, wilsonLow: null, wilsonHigh: null, unpricedRuns: 1 });
    expect(pa).toMatchObject({ routing: { only: ["a"] }, unpricedRuns: 0 });
    expect(pb).toMatchObject({ routing: { only: ["b"] }, unpricedRuns: 1, totalCostUsd: 0 });
    expect(EvalBatchSummarySchema.safeParse({ models: [z, pa, pb] }).success).toBe(true);
  });
  it("computes the disagreement rate over graded runs that have a claim (spec 051 FR-011)", () => {
    const rows = [
      measure({ runId: uuid(50), agentClaim: "success", disagrees: true, checkStatus: "regression" }),
      measure({ runId: uuid(51), agentClaim: "success", disagrees: false, checkStatus: "verified" }),
      measure({ runId: uuid(52), agentClaim: "failure", disagrees: false, checkStatus: "verified" }),
      // No claim line, a run from an older runner, and a run that was not graded: none is in the denominator.
      measure({ runId: uuid(53), agentClaim: "none", disagrees: false }),
      measure({ runId: uuid(54) }),
      measure({ runId: uuid(55), outcome: "FAILED", resolved: undefined, agentClaim: "success", disagrees: true }),
      measure({ runId: uuid(56), modelId: "other" }),
    ];
    const [a, other] = summarize(rows);
    expect(a!.disagreementRate).toBeCloseTo(1 / 3);
    expect(other!.disagreementRate).toBeNull();
    expect(EvalBatchSummarySchema.safeParse({ models: [a, other] }).success).toBe(true);
  });
  it("refuses a repeated option in the Slack form", () => {
    for (const tail of ["repeats 2 repeats 3", "cap 5 cap 6", "repeats 2 cap 5 repeats 3"]) {
      const r = parseEvalBatchCommand(`eval batch swebench verified django__django-11099 models Fast ${tail}`);
      expect(r).toMatchObject({ kind: "invalid" });
      expect((r as { message: string }).message).toMatch(/appears twice/);
    }
  });
  it("lets the Slack form omit the thinking level", () => {
    expect(parseEvalBatchCommand("eval batch swebench verified django__django-11099 models Fast")).toMatchObject({ kind: "batch" });
  });
});

describe("EvalBatchRecordSchema", () => {
  const record = {
    batchId: uuid(1),
    file: EvalBatchFileSchema.parse(file),
    createdBy: { teamId: "T0123ABCD", userId: "U0123ABCD" },
    thread: { teamId: "T0123ABCD", channelId: "C0123ABCD", threadTs: "1700000000.000100" },
    status: "RUNNING",
    queue: [{ index: 0, task: "django__django-11099", model, repeat: 1, attempt: 1, state: "RUNNING", runId: uuid(2) }],
    spentUsd: 1.5,
    counts: { queued: 0, starting: 0, running: 1, done: 0, failed: 0, cancelled: 0, notStarted: 0 },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };

  it("parses a record and refuses an unknown status", () => {
    expect(EvalBatchRecordSchema.safeParse(record).success).toBe(true);
    for (const status of ["QUEUED", "RUNNING", "STOPPING", "DONE", "STOPPED", "CAPPED"]) {
      expect(EvalBatchRecordSchema.safeParse({ ...record, status }).success).toBe(true);
    }
    expect(EvalBatchRecordSchema.safeParse({ ...record, status: "PAUSED" }).success).toBe(false);
  });
});

function measure(over: Partial<Record<keyof EvalRunMeasure, unknown>>): EvalRunMeasure {
  const row: Record<string, unknown> = {
    batchId: uuid(1), runId: uuid(2), instanceId: "django__django-11099", provider: "anthropic", modelId: "a", thinkingLevel: "medium",
    repeat: 1, attempt: 1, outcome: "GRADED", resolved: true, stopReason: "finished", agentSeconds: 60,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, costUsd: 1, imageDigest: "sha256:abc",
    ...over,
  };
  row.chargedUsd ??= row.costUsd ?? 0;
  // An override of undefined removes the field, as a row without it is written.
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as EvalRunMeasure;
}

describe("EvalRunMeasureSchema and summarize (FR-010)", () => {
  it("parses a measure row", () => {
    expect(EvalRunMeasureSchema.safeParse(measure({})).success).toBe(true);
    expect(EvalRunMeasureSchema.safeParse({ ...measure({}), surprise: 1 }).success).toBe(false);
  });

  it("sets resolved on graded rows only, and takes every run end", () => {
    for (const outcome of ["FAILED", "CANCELLED", "RETRIED"]) {
      expect(EvalRunMeasureSchema.safeParse(measure({ outcome, resolved: undefined, error: "boom", costUsd: null, chargedUsd: 10, costEstimated: true })).success).toBe(true);
      expect(EvalRunMeasureSchema.safeParse(measure({ outcome, resolved: false })).success).toBe(false);
    }
    expect(EvalRunMeasureSchema.safeParse(measure({ resolved: undefined })).success).toBe(false);
    expect(EvalRunMeasureSchema.safeParse(measure({ attempt: 3 })).success).toBe(false);
  });

  it("rates graded runs only, counts every other end apart, and totals every row's charge", () => {
    const rows = [
      measure({ runId: uuid(50), resolved: true, costUsd: 2 }),
      measure({ runId: uuid(51), resolved: false, costUsd: 3 }),
      measure({ runId: uuid(52), outcome: "RETRIED", resolved: undefined, costUsd: null, chargedUsd: 10, costEstimated: true }),
      measure({ runId: uuid(53), outcome: "FAILED", attempt: 2, resolved: undefined, costUsd: 0.5 }),
      measure({ runId: uuid(54), outcome: "CANCELLED", resolved: undefined, costUsd: 0 }),
    ];
    expect(summarize(rows)).toEqual([expect.objectContaining({
      runs: 2, resolved: 1, rate: 0.5, failed: 1, cancelled: 1, retried: 1, totalCostUsd: 15.5, unpricedRuns: 1, costPerSolvedUsd: 15.5,
    })]);
  });

  it("summarizes per model with rate, interval, cost and cost per solved task", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => measure({ runId: uuid(10 + i), resolved: i < 6, costUsd: 2 })),
      measure({ runId: uuid(30), modelId: "b", resolved: false, costUsd: 3 }),
      measure({ runId: uuid(31), modelId: "b", outcome: "FAILED", resolved: undefined, costUsd: null }),
    ];
    const [a, b] = summarize(rows);
    expect(a).toMatchObject({ modelId: "a", runs: 8, failed: 0, resolved: 6, rate: 0.75, totalCostUsd: 16 });
    expect(a?.wilsonLow).toBeCloseTo(0.409, 3);
    expect(a?.wilsonHigh).toBeCloseTo(0.929, 3);
    expect(a?.costPerSolvedUsd).toBeCloseTo(16 / 6, 10);
    expect(b).toMatchObject({ modelId: "b", runs: 1, failed: 1, resolved: 0, rate: 0, totalCostUsd: 3, costPerSolvedUsd: null });
    expect(EvalBatchSummarySchema.safeParse({ models: [a, b] }).success).toBe(true);
  });
});

describe("wilsonInterval", () => {
  it("matches known values", () => {
    const { low, high } = wilsonInterval(6, 8);
    expect(low).toBeCloseTo(0.409, 3);
    expect(high).toBeCloseTo(0.929, 3);
    const half = wilsonInterval(5, 10);
    expect(half.low).toBeCloseTo(0.237, 3);
    expect(half.high).toBeCloseTo(0.763, 3);
  });
  it("stays inside [0, 1] at the extremes and with no trials", () => {
    expect(wilsonInterval(0, 5).low).toBe(0);
    expect(wilsonInterval(5, 5).high).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("parseEvalBatchCommand (FR-002)", () => {
  it("reads a batch with models, repeats and cap", () => {
    expect(parseEvalBatchCommand("<@U123ABC> eval batch swebench verified django__django-11099 astropy__astropy-12907 models Fast, Deep repeats 2 cap $25")).toEqual({
      kind: "batch", dataset: "verified", instanceIds: ["django__django-11099", "astropy__astropy-12907"], modelSelectors: ["Fast", "Deep"], repeats: 2, costCapUsd: 25,
    });
    expect(parseEvalBatchCommand("eval batch secbench patch libpng.cve-2018-13785 models Fast")).toEqual({
      kind: "batch", dataset: "secbench-patch", instanceIds: ["libpng.cve-2018-13785"], modelSelectors: ["Fast"], repeats: 1,
    });
    expect(parseEvalBatchCommand("eval batch swebench lite django__django-11099 models Fast cap 10 repeats 3.")).toMatchObject({ repeats: 3, costCapUsd: 10 });
  });

  it("does not collide with the single-run commands", () => {
    expect(parseEvalBatchCommand("eval swebench verified django__django-11099")).toBeUndefined();
    expect(parseEvalBatchCommand("eval secbench patch libpng.cve-2018-13785")).toBeUndefined();
    expect(parseSwebenchCommand("eval batch swebench verified django__django-11099 models Fast")).toBeUndefined();
    expect(parseEvalBatchCommand("please eval the batch")).toBeUndefined();
  });

  it.each([
    ["eval batch", /which benchmark/],
    ["eval batch humaneval verified x", /Unknown benchmark “humaneval”/],
    ["eval batch swebench enterprise django__django-11099 models Fast", /Unknown dataset “enterprise”/],
    ["eval batch swebench secbench-patch django__django-11099 models Fast", /Unknown dataset/],
    ["eval batch swebench verified models Fast", /which instances/],
    ["eval batch swebench verified django__django-11099", /after `models`/],
    ["eval batch swebench verified nonsense models Fast", /“nonsense” is not an instance ID/],
    ["eval batch swebench verified django__django-11099 models", /which models/],
    ["eval batch swebench verified django__django-11099 models Fast repeats 9", /1 to 5/],
    ["eval batch swebench verified django__django-11099 models Fast cap $5000", /cap/],
    ["eval batch swebench verified django__django-11099 models A, B, C, D, E repeats 5", /25 runs is more than the 20/],
  ])("explains %s", (text, message) => {
    const result = parseEvalBatchCommand(text);
    expect(result).toMatchObject({ kind: "invalid" });
    expect((result as { message: string }).message).toMatch(message);
    expect((result as { message: string }).message).toMatch(/Use `eval batch/);
  });

  it("allows exactly 20 runs", () => {
    expect(parseEvalBatchCommand("eval batch swebench verified django__django-11099 models A, B, C, D repeats 5")).toMatchObject({ kind: "batch" });
  });
});
