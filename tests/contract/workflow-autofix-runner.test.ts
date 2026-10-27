// T8 AUTOFIX-WIRING, the unclear browser-and-API fault: each UNKNOWN scenario is settled by its OWN result on the original code (the baseline record of the approved plan). The system moves are
// replaced by spies here, so this file shows what the runner decides and asks, not how the broker starts a coding run (workflow-autofix-flow.test.ts does that for real).
import { describe, expect, it, vi } from "vitest";
import type { WorkflowSnapshot } from "@agentx/contracts";

const moves = vi.hoisted(() => ({ sendBack: vi.fn(async () => "STARTED" as const), retryChecks: vi.fn(async () => "STARTED" as const), retryReviews: vi.fn(async () => "STARTED" as const) }));
vi.mock("../../packages/broker/src/aws/developer-tasks.js", () => ({
  autoSendBackToCodingFromSystem: moves.sendBack, autoRetryChecksFromSystem: moves.retryChecks, autoRetryReviewsFromSystem: moves.retryReviews,
}));

import { runWorkflowAutofix, type AutofixDependencies } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import { AutoFixAskSchema, autoFixCardLines } from "../../packages/broker/src/developer/autofix-messages.js";
import { autofixDayBudgetNeed } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";

const CONTRACT = "c".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";
const row = (scenarioId: string, status: "PASSED" | "FAILED" | "UNKNOWN") => ({ scenarioId, title: scenarioId, kind: "web" as const, accountLabel: "tester", status, mockedOrigins: [] as string[] });

const task = (): DeveloperTaskRecord => ({
  taskId: TASK, workspaceId: "w", closedAt: undefined,
  workflow: {
    stage: "VERIFY", state: "BLOCKED", revision: 9, updatedAt: "2026-10-25T10:00:00.000Z", decisions: [], artifacts: [],
    blockReason: "admitted E2E evidence is incomplete or unknown",
    candidate: { digest: "d".repeat(64), repositories: [] },
    e2e: { required: true, contractDigest: CONTRACT, applicationSelection: {}, currentGroupRunIds: [] },
  },
} as unknown as DeveloperTaskRecord);

type Baseline = { state: string; baseline?: unknown; reason?: string; deadlineAt?: string } | undefined;
function deps(input: { baseline: Baseline; unknown: string[]; spent?: number; now?: number; sourceReady?: boolean; recycle?: (task: DeveloperTaskRecord) => Promise<unknown> }): { deps: AutofixDependencies; writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  const record = input.baseline === undefined ? undefined : { pk: `DEVTASK#${TASK}`, sk: `E2E_BASELINE#${CONTRACT}`, entityType: "WORKFLOW_E2E_BASELINE", taskId: TASK, contractDigest: CONTRACT, purpose: "baseline",
    attempt: 1, requestedAt: "2026-10-25T09:00:00.000Z", ...input.baseline };
  return { writes, deps: {
    config: { enabled: true, capUsd: 15, roundEstimateUsd: 3 },
    route: {} as never,
    store: { tableName: "t", documentClient: { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: (command.input.Key as { sk: string }).sk === "META" ? task() : record };
      writes.push(command.input);
      return {};
    } } as never },
    taskSpendUsd: async () => input.spent ?? 1,
    dayBudgetHasRoom: async () => true,
    scenarioResults: async () => ({ scenarios: input.unknown.map((id) => row(id, "UNKNOWN")) }),
    ownerCancelledChecks: async () => false,
    baselineSourceReady: async () => input.sourceReady === true,
    readArtifactText: async () => undefined,
    ...(input.recycle === undefined ? {} : { recycleWorker: input.recycle }),
    now: () => input.now ?? Date.parse("2026-10-25T10:05:00.000Z"),
    log: () => undefined,
  } };
}
const recorded = (rows: Array<ReturnType<typeof row>>, skipped: string[] = []) => ({ state: "RECORDED", baseline: { status: "PASSED", scenarios: rows, ...(skipped.length === 0 ? {} : { skippedAiScenarios: skipped.map((id) => ({ scenarioId: id, title: id })) }) } });
const run = (d: AutofixDependencies, mutate?: (t: DeveloperTaskRecord) => DeveloperTaskRecord) => runWorkflowAutofix(d, mutate === undefined ? task() : mutate(task()), { expectedRevision: 9, startedAt: "2026-10-25T10:00:00.000Z" });
const asked = (writes: Array<Record<string, unknown>>) => AutoFixAskSchema.parse((writes.at(-1)!.ExpressionAttributeValues as { ":ask": unknown })[":ask"]);

describe("an unclear browser and API fault is settled by each UNKNOWN scenario's own result on the original code", () => {
  it("sends back when every UNKNOWN scenario passed on the original code", async () => {
    moves.sendBack.mockClear();
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED"), row("b", "PASSED"), row("c", "FAILED")]), unknown: ["a", "b"] });
    expect(await run(d)).toBe("SENT_BACK");
    expect(moves.sendBack).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("asks and lists EVERY UNKNOWN scenario when one of them also fails, or was not run, on the original code", async () => {
    moves.sendBack.mockClear();
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED"), row("b", "FAILED")]), unknown: ["a", "b", "c"] });
    expect(await run(d)).toBe("ASKED");
    expect(moves.sendBack).not.toHaveBeenCalled();
    const ask = asked(writes);
    expect(ask).toMatchObject({ workflowRevision: 9, reason: "original-code-also-fails", groupCount: 3 });
    expect(ask.groups).toEqual([{ id: "a", original: "passed" }, { id: "b", original: "failed" }, { id: "c", original: "skipped" }]);
  });

  it("never decides a scenario the original-code round skipped (AI-navigated) on another scenario's result", async () => {
    moves.sendBack.mockClear();
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED")], ["b"]), unknown: ["a", "b"] });
    expect(await run(d)).toBe("ASKED");
    expect(moves.sendBack).not.toHaveBeenCalled();
    expect(asked(writes)).toMatchObject({ reason: "unclear-fault" });
  });

  it("waits while the original-code round is running, then asks once the wait is spent; a round that cannot run asks at once", async () => {
    moves.sendBack.mockClear();
    const pending = deps({ baseline: { state: "STARTED", deadlineAt: "2026-10-25T10:30:00.000Z" }, unknown: ["a"] });
    expect(await run(pending.deps)).toBe("WAITING");
    const late = deps({ baseline: { state: "STARTED", deadlineAt: "2026-10-25T12:00:00.000Z" }, unknown: ["a"], now: Date.parse("2026-10-25T10:50:00.000Z") });
    expect(await run(late.deps)).toBe("ASKED");
    expect(asked(late.writes)).toMatchObject({ reason: "unclear-fault", groups: [{ id: "a", original: "pending" }] });
    // A round past its own deadline and grace is one that could not be run (the baseline's existing rule).
    const lapsed = deps({ baseline: { state: "STARTED", deadlineAt: "2026-10-25T10:30:00.000Z" }, unknown: ["a"], now: Date.parse("2026-10-25T11:00:00.000Z") });
    expect(await run(lapsed.deps)).toBe("ASKED");
    expect(asked(lapsed.writes)).toMatchObject({ reason: "original-code-also-fails", groups: [{ id: "a", original: "cannot-run" }] });
    const unavailable = deps({ baseline: { state: "UNAVAILABLE", reason: "run-failed" }, unknown: ["a"] });
    expect(await run(unavailable.deps)).toBe("ASKED");
    expect(asked(unavailable.writes)).toMatchObject({ reason: "original-code-also-fails", groups: [{ id: "a", original: "cannot-run" }] });
    expect(moves.sendBack).not.toHaveBeenCalled();
  });

  it("asks, never sending back, when no original-code round was ever asked for (it cannot be started after the block)", async () => {
    moves.sendBack.mockClear();
    const { deps: d, writes } = deps({ baseline: undefined, unknown: ["a", "b"] });
    expect(await run(d)).toBe("ASKED");
    expect(asked(writes)).toMatchObject({ reason: "unclear-fault", groups: [{ id: "a", original: "not-run" }, { id: "b", original: "not-run" }] });
    expect(moves.sendBack).not.toHaveBeenCalled();
  });

  it("runs the original-code round first, with the one automatic Retry checks, when it was requested but never started and its code is exported", async () => {
    moves.sendBack.mockClear(); moves.retryChecks.mockClear();
    const { deps: d, writes } = deps({ baseline: { state: "REQUESTED" }, unknown: ["a"], sourceReady: true });
    expect(await run(d)).toBe("RETRIED");
    expect(moves.retryChecks).toHaveBeenCalledTimes(1);
    expect(moves.retryChecks).toHaveBeenCalledWith(expect.anything(), TASK, expect.objectContaining({ expectedRevision: 9, reason: expect.stringContaining("unchanged code is checked first") as string }));
    expect(moves.sendBack).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("asks at once, never waiting, when the requested round cannot run (no exported code), was already retried for this code, or the money forbids a retry", async () => {
    moves.retryChecks.mockClear();
    const noSource = deps({ baseline: { state: "REQUESTED" }, unknown: ["a"], sourceReady: false });
    expect(await run(noSource.deps)).toBe("ASKED");
    expect(asked(noSource.writes)).toMatchObject({ reason: "unclear-fault", groups: [{ id: "a", original: "not-run" }] });
    const retried = deps({ baseline: { state: "REQUESTED" }, unknown: ["a"], sourceReady: true });
    expect(await run(retried.deps, (t) => ({ ...t, workflow: { ...t.workflow!, decisions: [{ requestId: "r", workflowRevision: 8, decision: "REQUEST_CHANGES", actorId: "x", actorRole: "AGENTX", reason: "x", source: "AUTO_RETRY",
      auto: { stage: "VERIFY", candidateDigest: "d".repeat(64) }, at: "2026-10-25T09:00:00.000Z" }] } } as unknown as DeveloperTaskRecord))).toBe("ASKED");
    const poor = deps({ baseline: { state: "REQUESTED" }, unknown: ["a"], sourceReady: true, spent: 14 });
    expect(await run(poor.deps)).toBe("ASKED");
    expect(asked(poor.writes)).toMatchObject({ reason: "unclear-fault" });
    expect(moves.retryChecks).not.toHaveBeenCalled();
  });

  it("lists every UNKNOWN scenario of the round, however many, and says the original code could not be checked when none actually failed there", async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `s${index}`);
    const { deps: d, writes } = deps({ baseline: { state: "UNAVAILABLE", reason: "not-exported" }, unknown: ids });
    expect(await run(d)).toBe("ASKED");
    const ask = asked(writes);
    expect(ask.groups).toHaveLength(40);
    const lines = autoFixCardLines({ decisions: [], revision: 9 }, ask);
    expect(lines.filter((line) => line.startsWith("• s"))).toHaveLength(40);
    expect(lines.join("\n")).not.toContain("And ");
    expect(lines.join("\n")).toContain("The original code could not be checked, so I can't tell whether new code would fix it.");
    expect(lines.join("\n")).not.toContain("also fail on the original code");
    // When a scenario really failed on the original code, the card says so.
    const failed = deps({ baseline: recorded([row("a", "FAILED")]), unknown: ["a"] });
    await run(failed.deps);
    expect(autoFixCardLines({ decisions: [], revision: 9 }, asked(failed.writes)).join("\n")).toContain("also fail on the original code");
  });

  it("asks when a guard in the move refuses although the policy allowed it, instead of leaving the card without an ask", async () => {
    moves.sendBack.mockClear();
    moves.sendBack.mockResolvedValueOnce("STALE" as never);
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED")]), unknown: ["a"] });
    expect(await run(d)).toBe("ASKED");
    // POLISH-1: a refused move is not "spend unreadable": the card must not say it could not read the spend.
    expect(asked(writes)).toMatchObject({ reason: "needs-a-person" });
    expect(moves.sendBack).toHaveBeenCalledTimes(1);
  });

  it("asks the day budget for what one round needs (a group's worst case), not for a single call", () => {
    expect(autofixDayBudgetNeed({ maxModelCallsPerGroup: 40, maxInputTokensPerGroup: 300_000 })).toEqual({ calls: 40, inputTokens: 300_000 });
  });

  it("asks when the whole task's spend is unreadable, before any move", async () => {
    moves.sendBack.mockClear();
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED")]), unknown: ["a"] });
    d.taskSpendUsd = async () => undefined;
    expect(await run(d)).toBe("ASKED");
    expect(asked(writes)).toMatchObject({ reason: "inputs-missing" });
    expect(moves.sendBack).not.toHaveBeenCalled();
  });

  it("leaves a block older than the cut-off, and a task that moved on, alone", async () => {
    const { deps: d, writes } = deps({ baseline: recorded([row("a", "PASSED")]), unknown: ["a"] });
    expect(await run({ ...d, config: { ...d.config, since: "2026-10-26T00:00:00.000Z" } })).toBe("STALE");
    expect(await runWorkflowAutofix(d, task(), { expectedRevision: 8, startedAt: "2026-10-25T10:00:00.000Z" })).toBe("STALE");
    expect(await run({ ...d, config: { ...d.config, enabled: false } })).toBe("DISABLED");
    expect(writes).toEqual([]);
    const stage: WorkflowSnapshot["stage"] = "PLAN_REVIEW";
    const other = { ...task(), workflow: { ...task().workflow!, stage } } as DeveloperTaskRecord;
    expect(await runWorkflowAutofix(d, other, { expectedRevision: 9, startedAt: "2026-10-25T10:00:00.000Z" })).toBe("STALE");
  });
});

describe("AUTOREQUALIFY: the worker is recycled before the one retry of a kernel mismatch", () => {
  const drifted = (t: DeveloperTaskRecord) => ({ ...t, workflow: { ...t.workflow!, blockReason: "admitted E2E evidence is incomplete or unknown (g1: runtime-environment-drifted)" } } as unknown as DeveloperTaskRecord);

  it("stops the worker first, then retries the checks, in that order", async () => {
    moves.retryChecks.mockClear();
    const order: string[] = [];
    moves.retryChecks.mockImplementationOnce(async () => { order.push("retry"); return "STARTED" as const; });
    const { deps: d } = deps({ baseline: undefined, unknown: [], recycle: async () => { order.push("recycle"); } });
    expect(await run(d, drifted)).toBe("RETRIED");
    expect(order).toEqual(["recycle", "retry"]);
  });

  it("does not recycle for any other retry", async () => {
    moves.retryChecks.mockClear();
    const recycle = vi.fn(async () => undefined);
    const { deps: d } = deps({ baseline: { state: "REQUESTED" }, unknown: ["a"], sourceReady: true, recycle });
    expect(await run(d)).toBe("RETRIED");
    expect(recycle).not.toHaveBeenCalled();
  });
});
