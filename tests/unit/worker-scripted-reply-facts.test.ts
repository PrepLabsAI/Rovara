import { describe, expect, it, vi } from "vitest";
import { expectLinearScalingAsync } from "../support/scaling.js";
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
  it.each([
["task count decreases", summary(0, 2)], ["unknown mode", { ...summary(), mode: "other" }],
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
    const full = fixture(Array.from({ length: 200 }, (_, i) => summary(i + 1)));
    await round(full.wrapped, 200);
    expect(facts(full.results)).toEqual(Array.from({ length: 200 }, (_, i) => fact(i, 1)));
    const tooMany = fixture([summary()]);
    await round(tooMany.wrapped, 201);
    expect(facts(tooMany.results)).toBe("unknown");
    // A scaling check, not a wall-clock bound: refusing a summary with 900 escape hosts and one with 7,200 (about 34 bytes a host: the 8N input stays at or under 256 KiB so it stays in CPU cache) may take about eight times as long, never sixty-four. The old 100,000-host summary is refused once, un-timed.
    let refused: unknown;
    const refuseHosts = (hostCount: number) => {
      const hosts = Array.from({ length: hostCount }, () => "x".repeat(10));
      const oversized = { ...summary(), escapes: { count: 0, hosts, unreadable: 0 } };
      return async () => {
        const huge = fixture([oversized]);
        await round(huge.wrapped, 1);
        refused = facts(huge.results);
      };
    };
    await expectLinearScalingAsync(refuseHosts, { n: 900, unitBytes: 34, label: "oversized escape-host summary" });
    expect(refused).toBe("unknown");
    refused = undefined;
    await refuseHosts(100_000)();
    expect(refused).toBe("unknown");
  });
});

it("separate bounded allowances stop stalled per-check and final summary reads", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture([summary()]);
    f.helper.readSummary = () => new Promise(() => undefined);
    const running = round(withModelHelperRound(f.plan, f.base), 3);
    await vi.advanceTimersByTimeAsync(2100);
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
  expect(f.results[0]?.summary).toEqual(wide);
  expect(f.results[0]?.evidence.result).toBe("ran");
});


it.each(["unknown"])("refuses invalid runtime check id %j with fixed unknown facts", async (bad) => {
  const f = fixture([summary()]);
  begin(f.wrapped, bad);
  await f.wrapped.runProjectCommand(command, signal);
  await f.wrapped.endRound?.();
  expect(facts(f.results)).toBe("unknown");
});

describe("independent replies (parked by DEC 192a) never count", () => {
  const withIndependent = (independent: number, taskMade = 0, counted = 0): ModelHelperSummary => ({ ...summary(taskMade, counted), scripted: { before_task: counted, independent, task_made: taskMade } });
  it("is recorded per check as its own count, never folded into `counted`, and absent when there is none", async () => {
    const f = fixture([withIndependent(2), withIndependent(2, 1, 1), withIndependent(2, 1, 1)]);
    await round(f.wrapped, 2);
    expect(facts(f.results)).toEqual([{ ...fact(0, 0, 0), independent: 2 }, { ...fact(1, 1, 1) }]);
  });
});


