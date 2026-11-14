import { describe, expect, it, vi } from "vitest";
import { type ProjectCommand } from "../../packages/contracts/src/index.js";
import { runChecks, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { withModelHelperRound, type ModelHelperRoundResult, type StartedModelHelper } from "../../packages/worker/src/model-helper-round.js";
import { UNTRUSTED_MODEL_SUMMARY, type ModelHelperSummary } from "../../packages/worker/src/model-helper-ledger.js";

const digest = "a".repeat(64);
const signal = new AbortController().signal;
const command: ProjectCommand = { cwd: ".", executable: "npm", args: ["test"], timeoutSeconds: 5 };
const summary = (taskMade = 0, counted = 0): ModelHelperSummary => ({ ...UNTRUSTED_MODEL_SUMMARY, trusted: true, mode: "scripted", blockState: "by_name", replySetDigest: digest, scripted: { before_task: counted, independent: 0, task_made: taskMade }, countsTowardProof: counted });
const fact = (id: number, taskMade: number, counted = 0) => ({ checkId: `readiness:${String(id)}`, taskMade, counted });
const facts = (results: ModelHelperRoundResult[]) => (results.at(-1) as ModelHelperRoundResult & { scriptedReplies?: unknown } | undefined)?.scriptedReplies;
const begin = (runners: CheckRunners, id: string) => (runners as CheckRunners & { beginCheck?: (id: string) => void }).beginCheck?.(id);
function fixture(reads: (ModelHelperSummary | undefined | Error)[], overrides: Partial<CheckRunners> = {}) {
  const results: ModelHelperRoundResult[] = [];
  let index = 0;
  const readSummary = vi.fn(async () => {
    const next = reads[Math.min(index++, reads.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  const stop = vi.fn(async () => undefined);
  const helper: StartedModelHelper = { pinnedDigest: digest, commandEnvironment: {}, unsetEnvironment: [], readSummary, stop };
  const runProjectCommand = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }));
  const base: CheckRunners = { runProjectCommand, runAgentCommand: vi.fn(async () => ({ exitCode: 0, timedOut: false, output: "" })), ...overrides };
  const plan = { blockList: [], start: async () => helper, onResult: (result: ModelHelperRoundResult) => { results.push(result); } };
  return { wrapped: withModelHelperRound(plan, base), results, readSummary, helper, base, plan, stop, runProjectCommand };
}
const round = (runners: CheckRunners, count = 3, now?: () => number) => runChecks({ source: "project", readiness: Array.from({ length: count }, () => command), projectBefore: [] }, runners, { budgetMs: 60_000, signal, ...(now === undefined ? {} : { now }) });

describe("candidate reply facts", () => {
  it("attributes deltas using the actual readiness id, including zero-use checks", async () => {
    const f = fixture([summary(2, 1), summary(2, 3), summary(3, 3)]);
    expect((await round(f.wrapped)).entries.map((entry) => entry.after)).toEqual(["passed", "passed", "passed"]);
    expect(facts(f.results)).toEqual([fact(0, 2, 1), fact(1, 0, 2), fact(2, 1)]);
    expect(f.readSummary).toHaveBeenCalledTimes(4);
  });
  it("a budget-skipped middle check does not shift attribution to its plan position", async () => {
    const f = fixture([summary(2), summary(3)]);
    // A deterministic clock makes only the middle admission run out of budget.
    const times = [0, 0, 0, 0, 60_000, 0, 0, 0];
    const result = await round(f.wrapped, 3, () => times.shift() ?? 0);
    expect(result.entries.map((entry) => entry.after)).toEqual(["passed", "not_run", "passed"]);
    expect(facts(f.results)).toEqual([fact(0, 2), fact(2, 1)]);
  });
  it.each([
    ["unreadable", undefined], ["rejected", new Error("private cause")], ["untrusted", UNTRUSTED_MODEL_SUMMARY],
    ["foreign digest", { ...summary(), replySetDigest: "b".repeat(64) }], ["task count decreases", summary(0, 2)], ["counted decreases", summary(2, 0)],
    ["unknown mode", { ...summary(), mode: "other" }], ["wrong count type", { ...summary(), countsTowardProof: "1" }], ["missing scripted", { ...summary(), scripted: undefined }],
  ])("%s per-check read marks the whole round unknown", async (_name, bad) => {
    const f = fixture([summary(1, 1), bad as ModelHelperSummary, summary(3, 3)]);
    await round(f.wrapped);
    expect(facts(f.results)).toBe("unknown");
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("an escape discovered only at the final read marks the whole round", async () => {
    const f = fixture([summary(), { ...summary(), escapes: { count: 1, hosts: [], unreadable: 1 } }]);
    expect((await round(f.wrapped, 1)).entries[0]?.after).toBe("passed");
    expect(facts(f.results)).toBe("unknown");
  });
  it("unattributed commands and late unattributed increments mark the entire round", async () => {
    const f = fixture([summary(1)]);
    await f.wrapped.runProjectCommand(command, signal);
    await f.wrapped.endRound?.();
    expect(facts(f.results)).toBe("unknown");
    const late = fixture([summary(), summary(1)]);
    await round(late.wrapped, 1);
    expect(facts(late.results)).toBe("unknown");
  });
  it("reads after a rejected command without changing its failed status", async () => {
    const f = fixture([summary(2)], { runProjectCommand: async () => { throw new Error("command failed"); } });
    expect((await round(f.wrapped, 1)).entries[0]?.after).toBe("failed");
    expect(facts(f.results)).toEqual([fact(0, 2)]);
  });
  it("agent commands are attributed too and each round starts at zero", async () => {
    const f = fixture([summary(2)]);
    begin(f.wrapped, "agent:4");
    await f.wrapped.runAgentCommand("npm test", 1000, signal);
    await f.wrapped.endRound?.();
    expect(facts(f.results)).toEqual([{ checkId: "agent:4", taskMade: 2, counted: 0 }]);
    await round(f.wrapped, 1);
    expect(facts(f.results)).toEqual([fact(0, 2)]);
  });
  it("no plan or no reply set yields no result and leaves command bytes alone", async () => {
    const f = fixture([]);
    expect(withModelHelperRound(undefined, f.base)).toBe(f.base);
    await round(withModelHelperRound({ ...f.plan, start: async () => undefined }, f.base), 1);
    expect(f.results).toEqual([]);
    expect(f.runProjectCommand).toHaveBeenCalledWith(command, expect.any(AbortSignal));
  });
  it("L1/L3: an inner scopeRound passes wrapped runners, forwarding every scoped member", async () => {
    const f = fixture([summary(2)]);
    const prepareRound = vi.fn(async () => undefined);
    const scoped = { ...f.base, prepareRound, kind: "sandbox" as const, reportRoot: () => "/reports", originalCode: vi.fn() };
    const outer = { ...f.base, scopeRound: async (_plan: unknown, _signal: AbortSignal, run: (runners: CheckRunners) => Promise<unknown>) => run(scoped) } as CheckRunners;
    const wrapped = withModelHelperRound(f.plan, outer);
    await wrapped.scopeRound!({ source: "project" }, signal, async (received) => {
      expect(received).not.toBe(scoped);
      expect(received.kind).toBe("sandbox");
      expect(received.reportRoot?.()).toBe("/reports");
      expect(received.originalCode).toBe(scoped.originalCode);
      expect(received).toHaveProperty("prepareRound", prepareRound);
      return round(received, 1);
    }, () => 60_000);
    expect(prepareRound).toHaveBeenCalledOnce();
    expect(facts(f.results)).toEqual([fact(0, 2)]);
  });
  it("supports 200 checks and refuses oversized summaries and fact collections in bounded time", async () => {
    const started = performance.now();
    const full = fixture(Array.from({ length: 200 }, (_, i) => summary(i + 1)));
    await round(full.wrapped, 200);
    expect(facts(full.results)).toEqual(Array.from({ length: 200 }, (_, i) => fact(i, 1)));
    const tooMany = fixture([summary()]);
    await round(tooMany.wrapped, 201);
    expect(facts(tooMany.results)).toBe("unknown");
    const huge = fixture([{ ...summary(), escapes: { count: 0, hosts: Array.from({ length: 100_000 }, () => "x".repeat(10)), unreadable: 0 } }]);
    await round(huge.wrapped, 1);
    expect(facts(huge.results)).toBe("unknown");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

it("one TOTAL read-time allowance bounds stalled summaries, including finalization", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture([summary()]);
    f.helper.readSummary = () => new Promise(() => undefined);
    const running = round(withModelHelperRound(f.plan, f.base), 3);
    await vi.advanceTimersByTimeAsync(1100);
    await running;
    expect(facts(f.results)).toBe("unknown");
    expect(f.stop).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("a TOTAL summary byte allowance refuses repeated large summaries", async () => {
  const wide = { ...summary(), escapes: { count: 0, hosts: Array.from({ length: 256 }, () => `${"a".repeat(60)}.example.com`), unreadable: 0 } };
  const f = fixture([wide]);
  await round(f.wrapped, 200);
  expect(facts(f.results)).toBe("unknown");
  expect(f.readSummary.mock.calls.length).toBeLessThan(200);
});

it.each([
  ["untrusted", UNTRUSTED_MODEL_SUMMARY],
  ["foreign", { ...summary(), replySetDigest: "b".repeat(64) }],
  ["runtime enum", { ...summary(), mode: "future" }],
  ["runtime type", { ...summary(), countsTowardProof: "0" }],
])("%s is refused even with zero counts and a later healthy read", async (_name, bad) => {
  const f = fixture([summary(), bad as ModelHelperSummary, summary()]);
  await round(f.wrapped);
  expect(facts(f.results)).toBe("unknown");
});

it("a command without beginCheck is unknown even when its summary says zero calls", async () => {
  const f = fixture([summary()]);
  await f.wrapped.runProjectCommand(command, signal);
  await f.wrapped.endRound?.();
  expect(facts(f.results)).toBe("unknown");
});

it.each(["unknown", "readiness:-1", "readiness:01", "agent:1000000", 3, null])("refuses invalid runtime check id %j with fixed unknown facts", async (bad) => {
  const f = fixture([summary()]);
  begin(f.wrapped, bad as string);
  await f.wrapped.runProjectCommand(command, signal);
  await f.wrapped.endRound?.();
  expect(facts(f.results)).toBe("unknown");
});

it("caps TOTAL reads even when every command belongs to the same check", async () => {
  const f = fixture([summary()]);
  for (let i = 0; i < 202; i++) {
    begin(f.wrapped, "readiness:0");
    await f.wrapped.runProjectCommand(command, signal);
  }
  await f.wrapped.endRound?.();
  expect(facts(f.results)).toBe("unknown");
  expect(f.readSummary.mock.calls.length).toBeLessThanOrEqual(201);
});
