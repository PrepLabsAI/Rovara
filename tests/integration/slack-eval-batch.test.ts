// Spec 052 Task 6: eval batches in Slack. The batch form starts a batch in its thread (FR-002,
// FR-003), and the batch watcher posts the batch's progress and its summary table there (FR-010),
// opening the thread of a batch started from the CLI (Ruling 19), with a fake clock and stubbed APIs.
import { describe, expect, it, vi } from "vitest";
import type {
  EvalBatchSlackStartResult,
  EvalBatchSummary,
  EvalBatchWatchChange,
  EvalBatchWatched,
  ProjectModelOptions,
  SlackRequestMessage,
} from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import {
  EVAL_BATCH_CLAIM_MS,
  EVAL_BATCH_FAILURE_BACKOFF_MS,
  EVAL_BATCH_PROGRESS_INTERVAL_MS,
  EVAL_BATCH_WATCH_POLL_MS,
  PERMANENT_SLACK_ERRORS,
  SlackApiError,
  createEvalBatchWatcherState,
  runEvalBatchWatcher,
  watchEvalBatchesOnce,
  type EvalBatchWatchApi,
} from "../../packages/slack-service/src/eval-batch-watcher.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const batchId = "8d4f2c1e-5b7a-4c3d-9e8f-1a2b3c4d5e6f";
const glm = { provider: "openrouter", modelId: "z-ai/glm-5.3", thinkingLevel: "high" as const, routing: { only: ["fireworks"] } };
const minimax = { provider: "openrouter", modelId: "minimax/minimax-m3", thinkingLevel: "medium" as const };

function batch(overrides: Partial<EvalBatchWatched> = {}): EvalBatchWatched {
  return {
    batchId, thread, createdBy: { teamId: thread.teamId, userId: "U0123456789" }, status: "RUNNING", benchmark: "secbench-patch",
    tasks: 2, repeats: 2, costCapUsd: 20, perRunCeilingUsd: 2, runs: 8, finished: 0, resolved: 0, notStarted: 0, spentUsd: 0,
    models: [
      { model: glm, runs: 4, finished: 0, resolved: 0, ended: false },
      { model: minimax, runs: 4, finished: 0, resolved: 0, ended: false },
    ],
    watch: { revision: 0 }, resultsWritten: false,
    ...overrides,
  };
}

const START_LINES = [
  "8 runs of SEC-bench patch task: 2 tasks × 2 models × 2 repeats, with a cost cap of $20.00 (each run's ceiling is $2.00).",
  "Models: `openrouter/z-ai/glm-5.3` (thinking high, via fireworks), `openrouter/minimax/minimax-m3` (thinking medium)",
  "I'll post progress here and a summary table when it ends; say `stop` in this thread to stop the batch.",
];

// --- The Slack form ------------------------------------------------------------------------------

const projectModels: ProjectModelOptions = {
  projectName: "payments",
  approved: [
    { provider: "openrouter", modelId: "z-ai/glm-5.3", label: "GLM 5.3" },
    { provider: "openrouter", modelId: "minimax/minimax-m3", label: "MiniMax M3" },
  ],
  current: { provider: "openrouter", modelId: "z-ai/glm-5.3", label: "GLM 5.3" },
  source: "default",
};

function message(text: string, eventId = "EvBATCH0001"): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: "U0123456789", text, receivedAt: "2026-10-02T12:00:00.000Z" };
}

function formHarness(answer: EvalBatchSlackStartResult = { outcome: "STARTED", created: true, batch: batch() }) {
  const posts: string[] = [];
  const startEvalBatch = vi.fn(async () => answer);
  const updateEvalBatchWatch = vi.fn(async (_batchId: string, revision: number, change: EvalBatchWatchChange) => ({ updated: true, watch: { revision: revision + 1, ...change } }));
  const runTurn = vi.fn();
  const ensureWorkspace = vi.fn();
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace, startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
      listProjectModels: async () => projectModels,
      startEvalBatch,
      updateEvalBatchWatch,
    }),
    threads: { load: vi.fn(), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
    now: () => Date.parse("2026-10-02T12:00:00.000Z"),
  };
  return { dependencies, posts, startEvalBatch, updateEvalBatchWatch, runTurn, ensureWorkspace };
}

const FORM = "<@UAGENTX> eval batch secbench patch njs.cve-2022-32414 gpac.cve-2023-5586 models GLM 5.3, MiniMax M3 repeats 2 cap $20";

describe("the eval batch form in Slack (spec 052 FR-002)", () => {
  it("resolves the models, starts the batch and posts its start message, without a workspace or the orchestrator", async () => {
    const h = formHarness();
    await processSlackRequest(message(FORM), h.dependencies, { finalAttempt: false });
    expect(h.startEvalBatch).toHaveBeenCalledWith({
      dataset: "secbench-patch",
      instanceIds: ["njs.cve-2022-32414", "gpac.cve-2023-5586"],
      models: [{ provider: "openrouter", modelId: "z-ai/glm-5.3" }, { provider: "openrouter", modelId: "minimax/minimax-m3" }],
      selectors: ["GLM 5.3", "MiniMax M3"],
      repeats: 2,
      costCapUsd: 20,
    });
    expect(h.posts).toEqual([[`Started eval batch \`${batchId}\`: ${START_LINES[0]}`, START_LINES[1], START_LINES[2]].join("\n")]);
    // The start message is recorded on the batch, so a redelivery knows it was posted.
    expect(h.updateEvalBatchWatch).toHaveBeenCalledWith(batchId, 0, { startPostedAt: "2026-10-02T12:00:00.000Z" });
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("posts nothing more for a redelivered event whose start message was posted, and says so to a repeated message", async () => {
    const h = formHarness({ outcome: "STARTED", created: false, batch: batch({ watch: { revision: 1, startPostedAt: "2026-10-02T11:59:00.000Z" } }) });
    await processSlackRequest(message(FORM), h.dependencies, { finalAttempt: false, redelivered: true });
    expect(h.startEvalBatch).toHaveBeenCalledTimes(1);
    expect(h.posts).toEqual([]);
    await processSlackRequest(message(FORM, "EvBATCH0002"), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([`This thread already started eval batch \`${batchId}\` (RUNNING); its progress is posted here.`]);
  });

  it("posts the start message on a redelivery whose first delivery created the batch but did not post it (M-3)", async () => {
    const h = formHarness({ outcome: "STARTED", created: false, batch: batch() });
    await processSlackRequest(message(FORM), h.dependencies, { finalAttempt: false, redelivered: true });
    expect(h.posts).toEqual([[`Started eval batch \`${batchId}\`: ${START_LINES[0]}`, START_LINES[1], START_LINES[2]].join("\n")]);
    expect(h.updateEvalBatchWatch).toHaveBeenCalledWith(batchId, 0, expect.objectContaining({ startPostedAt: expect.any(String) as unknown }) as unknown);
  });

  it("posts the broker's refusal with its reason (FR-003)", async () => {
    const h = formHarness({ outcome: "REFUSED", message: "the cost cap of $2 is below one run's reservation of $5.5" });
    await processSlackRequest(message(FORM), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual(["I couldn't start this batch: the cost cap of $2 is below one run's reservation of $5.5"]);
  });

  it("refuses a model the project does not approve, listing the approved ones, and starts nothing", async () => {
    const h = formHarness();
    await processSlackRequest(message("eval batch secbench patch njs.cve-2022-32414 models GLM 5.3, Opus 9"), h.dependencies, { finalAttempt: false });
    expect(h.startEvalBatch).not.toHaveBeenCalled();
    expect(h.posts[0]).toContain("No approved coding model matches “Opus 9”.");
    expect(h.posts[0]).toContain("GLM 5.3");
  });

  it("posts the form's own error, such as more than 20 runs", async () => {
    const h = formHarness();
    await processSlackRequest(message("eval batch swebench verified django__django-11099 django__django-11100 django__django-11101 models GLM 5.3, MiniMax M3 repeats 4"), h.dependencies, { finalAttempt: false });
    expect(h.startEvalBatch).not.toHaveBeenCalled();
    expect(h.posts).toEqual([expect.stringContaining("24 runs is more than the 20 a Slack message may start") as unknown]);
  });
});

// --- The watcher ---------------------------------------------------------------------------------

/** A broker stub with the routes' semantics: one thread per batch, and changes checked against the revision read. */
function broker(initial: EvalBatchWatched[]) {
  const state = new Map(initial.map((entry) => [entry.batchId, structuredClone(entry)]));
  const events: string[] = [];
  const api: EvalBatchWatchApi = {
    listBatches: vi.fn(async () => ({
      batches: [...state.values()].filter((entry) => entry.watch.summaryPostedAt === undefined && entry.watch.droppedAt === undefined).map((entry) => structuredClone(entry)),
      dropped: [] as Array<{ batchId: string; reason: "channel_unbound" | "channel_moved" | "ended_over_7_days" }>,
    })),
    recordThread: vi.fn(async (seen: EvalBatchWatched, threadTs: string) => {
      const current = state.get(seen.batchId)!;
      events.push(`record ${threadTs}`);
      if (!current.thread.threadTs.startsWith("00")) return { recorded: false, thread: current.thread };
      current.thread = { ...current.thread, threadTs };
      return { recorded: true, thread: current.thread };
    }),
    updateWatch: vi.fn(async (seen: EvalBatchWatched, revision: number, change: EvalBatchWatchChange) => {
      const current = state.get(seen.batchId)!;
      if (current.watch.revision !== revision) return { updated: false, watch: current.watch };
      current.watch = { ...current.watch, ...change, revision: revision + 1 };
      return { updated: true, watch: current.watch };
    }),
    dropWatch: vi.fn(async (seen: EvalBatchWatched, reason: string) => {
      const current = state.get(seen.batchId)!;
      current.watch = { ...current.watch, revision: current.watch.revision + 1, droppedAt: "2026-10-02T12:00:00.000Z", dropReason: reason };
      return { dropped: true };
    }),
  };
  return { state, api, events, set: (id: string, change: Partial<EvalBatchWatched>) => Object.assign(state.get(id)!, change) };
}

function slackStub(events: string[]) {
  const posts: Array<{ channelId: string; threadTs: string | undefined; text: string }> = [];
  let sequence = 0;
  const slack = {
    post: vi.fn(async (channelId: string, threadTs: string | undefined, text: string) => {
      if (threadTs?.startsWith("00")) throw new Error(`posted with the placeholder ${threadTs}`);
      sequence += 1;
      const ts = `1695700000.${String(sequence).padStart(6, "0")}`;
      events.push(threadTs === undefined ? `open ${ts}` : `post ${threadTs}`);
      posts.push({ channelId, threadTs, text });
      return ts;
    }),
    delete: vi.fn(async () => undefined),
  };
  return { slack, posts };
}

function watcher(initial: EvalBatchWatched[]) {
  const b = broker(initial);
  const s = slackStub(b.events);
  let clock = Date.parse("2026-10-02T12:00:00.000Z");
  const log = vi.fn();
  const logError = vi.fn();
  const dependencies = { api: b.api, slack: s.slack, now: () => clock, log, logError, state: createEvalBatchWatcherState() };
  return {
    ...b, ...s, log, logError, dependencies,
    advance: (milliseconds: number) => { clock += milliseconds; },
    once: () => watchEvalBatchesOnce(dependencies),
  };
}

const summary: EvalBatchSummary = {
  batchId,
  models: [
    {
      provider: "openrouter", modelId: "z-ai/glm-5.3", thinkingLevel: "high", routing: { only: ["fireworks"] },
      runs: 4, failed: 0, cancelled: 0, retried: 1, resolved: 3, rate: 0.75, wilsonLow: 0.3006, wilsonHigh: 0.9544,
      totalCostUsd: 6.1, unpricedRuns: 0, costPerSolvedUsd: 6.1 / 3,
    },
    {
      provider: "openrouter", modelId: "minimax/minimax-m3", thinkingLevel: "medium",
      runs: 3, failed: 1, cancelled: 0, retried: 0, resolved: 0, rate: 0, wilsonLow: 0, wilsonHigh: 0.5615,
      totalCostUsd: 8.1, unpricedRuns: 1, costPerSolvedUsd: null,
    },
  ],
};

const ended = (overrides: Partial<EvalBatchWatched> = {}) => batch({
  status: "DONE", finished: 8, resolved: 3, spentUsd: 14.2, resultsWritten: true, summary,
  models: [
    { model: glm, runs: 4, finished: 4, resolved: 3, ended: true },
    { model: minimax, runs: 4, finished: 4, resolved: 0, ended: true },
  ],
  ...overrides,
});

const SUMMARY_TABLE = [
  "```",
  "Model                                       Graded  Resolved  Rate (95% CI)  Failed  Cost    Per solved",
  "openrouter/z-ai/glm-5.3 high via fireworks  4       3         75% (30-95%)   0       $6.10   $2.03",
  "openrouter/minimax/minimax-m3 medium        3       0         0% (0-56%)     1       $8.10*  -",
  "```",
  "* includes runs that reported no cost, charged at their ceiling.",
  `Results: \`evals/batches/${batchId}/results.csv\` in the artifact bucket; \`agentx admin eval batch results ${batchId} --csv <path>\` downloads it.`,
].join("\n");

describe("the batch watcher's thread for a batch started from the CLI (spec 052 Ruling 19)", () => {
  const placeholder = { ...thread, threadTs: "0012345678.901234" };

  it("opens the thread in the batch's channel with a start message, records it, and only then posts in it", async () => {
    const w = watcher([batch({ thread: placeholder, createdBy: { teamId: thread.teamId, userId: "UAGENTXCLI" }, finished: 1, resolved: 1, spentUsd: 1.5 })]);
    await w.once();
    expect(w.posts[0]).toEqual({
      channelId: thread.channelId,
      threadTs: undefined,
      text: [`Eval batch \`${batchId}\` started from the CLI: ${START_LINES[0]}`, START_LINES[1], START_LINES[2]].join("\n"),
    });
    expect(w.events).toEqual(["open 1695700000.000001", "record 1695700000.000001", "post 1695700000.000001"]);
    expect(w.posts[1]).toEqual({ channelId: thread.channelId, threadTs: "1695700000.000001", text: "Batch progress: 1/8 done, 1 resolved, $1.50 spent of the $20.00 cap." });
    // The thread is recorded: the next pass opens nothing more.
    w.advance(EVAL_BATCH_WATCH_POLL_MS);
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(2);
    expect(w.logError).not.toHaveBeenCalled();
  });

  it("deletes its own opener when another watcher recorded the thread first", async () => {
    const w = watcher([batch({ thread: placeholder, finished: 1 })]);
    // Another watcher records its thread between this one's list and its record.
    vi.mocked(w.api.recordThread).mockImplementationOnce(async () => ({ recorded: false, thread: { ...thread, threadTs: "1695600000.000100" } }));
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(1);
    expect(w.slack.delete).toHaveBeenCalledWith(thread.channelId, "1695700000.000001");
    expect(w.posts.filter((post) => post.threadTs !== undefined)).toEqual([]);
  });

  it("never posts in a placeholder thread, even for an ended batch", async () => {
    const w = watcher([ended({ thread: placeholder })]);
    await w.once();
    expect(w.posts.map((post) => post.threadTs)).toEqual([undefined, "1695700000.000001"]);
    expect(w.posts[1]!.text).toContain("is done");
  });
});

describe("the batch watcher's progress posts (spec 052 Task 6)", () => {
  it("posts when the counts change, at most once per 5 minutes, plus once per model that finishes", async () => {
    const w = watcher([batch()]);
    await w.once();
    // Nothing has finished yet.
    expect(w.posts).toEqual([]);
    w.set(batchId, { finished: 1, resolved: 1, spentUsd: 1.5 });
    await w.once();
    expect(w.posts.map((post) => post.text)).toEqual(["Batch progress: 1/8 done, 1 resolved, $1.50 spent of the $20.00 cap."]);
    expect(w.posts[0]!.threadTs).toBe(thread.threadTs);
    // A minute later the counts change again: too soon.
    w.advance(60_000);
    w.set(batchId, { finished: 2, resolved: 1, spentUsd: 3 });
    await w.once();
    expect(w.posts).toHaveLength(1);
    // A model finishing is posted at once.
    w.advance(60_000);
    w.set(batchId, {
      finished: 4, resolved: 3, spentUsd: 6.1,
      models: [{ model: glm, runs: 4, finished: 4, resolved: 3, ended: true }, { model: minimax, runs: 4, finished: 0, resolved: 0, ended: false }],
    });
    await w.once();
    expect(w.posts[1]!.text).toBe([
      "Batch progress: 4/8 done, 3 resolved, $6.10 spent of the $20.00 cap.",
      "`openrouter/z-ai/glm-5.3` (thinking high, via fireworks) is done: 4 runs, 3 resolved.",
    ].join("\n"));
    // The model's finish is posted once; other changes wait out the 5 minutes since the last post.
    w.advance(60_000);
    w.set(batchId, { finished: 5 });
    await w.once();
    expect(w.posts).toHaveLength(2);
    w.advance(EVAL_BATCH_PROGRESS_INTERVAL_MS - 60_000);
    await w.once();
    expect(w.posts[2]!.text).toBe("Batch progress: 5/8 done, 3 resolved, $6.10 spent of the $20.00 cap.");
    // Unchanged counts are never posted, however long it has been.
    w.advance(EVAL_BATCH_PROGRESS_INTERVAL_MS * 3);
    await w.once();
    expect(w.posts).toHaveLength(3);
  });

  it("survives a restart: a new watcher reads what was posted from the record and posts nothing again", async () => {
    const w = watcher([batch({ finished: 1, resolved: 1, spentUsd: 1.5 })]);
    await w.once();
    expect(w.posts).toHaveLength(1);
    // A restarted watcher keeps nothing in memory; it has only the broker's record.
    const restarted = { ...w.dependencies, log: vi.fn(), logError: vi.fn(), state: createEvalBatchWatcherState() };
    w.advance(EVAL_BATCH_PROGRESS_INTERVAL_MS * 2);
    await watchEvalBatchesOnce(restarted);
    expect(w.posts).toHaveLength(1);
  });

  it("claims a post before making it, so a second watcher that read the same revision posts nothing", async () => {
    const w = watcher([batch({ finished: 1 })]);
    const listed = await w.api.listBatches();
    // Each pass reads the same stale list, as a second watcher would.
    vi.mocked(w.api.listBatches).mockResolvedValueOnce(listed).mockResolvedValueOnce(structuredClone(listed));
    await w.once();
    await w.once();
    expect(w.posts).toHaveLength(1);
  });
});

describe("the batch watcher's summary (spec 052 FR-010, Ruling 11)", () => {
  it("posts the summary table once, when the batch has ended and its results are written", async () => {
    const w = watcher([ended({ resultsWritten: false, summary: undefined })]);
    // Ended by its status, but the results are not written: nothing yet.
    await w.once();
    expect(w.posts).toEqual([]);
    w.set(batchId, { resultsWritten: true, summary });
    await w.once();
    expect(w.posts.map((post) => post.text)).toEqual([`Eval batch \`${batchId}\` is done: 8/8 runs finished, 3 resolved, $14.20 spent of the $20.00 cap.\n${SUMMARY_TABLE}`]);
    expect(w.state.get(batchId)!.watch).toMatchObject({ summaryPostedAt: "2026-10-02T12:00:00.000Z" });
    w.advance(EVAL_BATCH_WATCH_POLL_MS);
    await w.once();
    await watchEvalBatchesOnce({ ...w.dependencies, state: createEvalBatchWatcherState() });
    expect(w.posts).toHaveLength(1);
  });

  it("says when a stop or the cost cap ended the batch, and how many runs did not start", async () => {
    const stopped = watcher([ended({ status: "STOPPED", finished: 5 })]);
    await stopped.once();
    expect(stopped.posts[0]!.text.split("\n")[0]).toBe(`Eval batch \`${batchId}\` was stopped: 5/8 runs finished, 3 resolved, $14.20 spent of the $20.00 cap.`);
    const capped = watcher([ended({ status: "CAPPED", finished: 6, notStarted: 2, spentUsd: 19.1 })]);
    await capped.once();
    expect(capped.posts[0]!.text.split("\n")[0]).toBe(`Eval batch \`${batchId}\` stopped at its cost cap: 6/8 runs finished, 3 resolved, $19.10 spent of the $20.00 cap; 2 runs did not start.`);
  });

  it("leaves a summary another watcher claimed recently, and takes over a claim that went stale", async () => {
    const w = watcher([ended({ watch: { revision: 3, summaryClaimedAt: "2026-10-02T11:58:00.000Z" } })]);
    await w.once();
    expect(w.posts).toEqual([]);
    w.advance(10 * 60_000);
    await w.once();
    expect(w.posts).toHaveLength(1);
    expect(w.state.get(batchId)!.watch).toMatchObject({ revision: 5, summaryPostedAt: "2026-10-02T12:10:00.000Z" });
  });
});

describe("the batch watcher fails loudly (spec 052 Task 6)", () => {
  it("logs one batch's failure as an error and still posts for the others", async () => {
    const other = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const w = watcher([batch({ finished: 1 }), batch({ batchId: other, finished: 2 })]);
    vi.mocked(w.api.updateWatch).mockRejectedValueOnce(new Error("broker unavailable"));
    await w.once();
    expect(w.posts.map((post) => post.text)).toEqual(["Batch progress: 2/8 done, 0 resolved, $0.00 spent of the $20.00 cap."]);
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.batch_failed", { batchId, error: "broker unavailable" });
  });

  it("logs a failed list as an error, and the loop polls every 30 seconds until stopped", async () => {
    const w = watcher([]);
    vi.mocked(w.api.listBatches).mockRejectedValueOnce(new Error("signature expired"));
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) controller.abort();
    });
    await runEvalBatchWatcher({ ...w.dependencies, sleep, signal: controller.signal });
    expect(w.api.listBatches).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(EVAL_BATCH_WATCH_POLL_MS, controller.signal);
    expect(EVAL_BATCH_WATCH_POLL_MS).toBe(30_000);
    expect(EVAL_BATCH_PROGRESS_INTERVAL_MS).toBe(5 * 60_000);
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.list_failed", { error: "signature expired" });
  });
});

describe("the batch watcher's opener (spec 052 Ruling 24, M-1)", () => {
  const placeholder = { ...thread, threadTs: "0012345678.901234" };

  it("claims the opener and stores its timestamp, so a failed thread record retries the record, never the post", async () => {
    const w = watcher([batch({ thread: placeholder })]);
    vi.mocked(w.api.recordThread).mockRejectedValueOnce(new Error("broker unavailable"));
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(1);
    expect(w.state.get(batchId)!.watch).toMatchObject({ openerClaimedAt: "2026-10-02T12:00:00.000Z", openerTs: "1695700000.000001" });
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.batch_failed", { batchId, error: "broker unavailable" });
    // A restarted watcher, after the back-off, records the stored opener and posts nothing new.
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS);
    await watchEvalBatchesOnce({ ...w.dependencies, state: createEvalBatchWatcherState() });
    expect(w.slack.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.api.recordThread).mock.calls.map((call) => call[1])).toEqual(["1695700000.000001", "1695700000.000001"]);
    expect(w.state.get(batchId)!.thread.threadTs).toBe("1695700000.000001");
  });

  it("posts no opener while another watcher's claim on it is fresh", async () => {
    const w = watcher([batch({ thread: placeholder, watch: { revision: 2, openerClaimedAt: "2026-10-02T11:59:30.000Z" } })]);
    await w.once();
    expect(w.slack.post).not.toHaveBeenCalled();
  });

  it("keeps the opener's timestamp in memory when storing it fails, and records it on the next pass", async () => {
    const w = watcher([batch({ thread: placeholder })]);
    const update = vi.mocked(w.api.updateWatch);
    const real = update.getMockImplementation()!;
    update.mockImplementation(async (seen, revision, change) => {
      if (change.openerTs !== undefined) throw new Error("throttled");
      return real(seen, revision, change);
    });
    vi.mocked(w.api.recordThread).mockRejectedValueOnce(new Error("broker unavailable"));
    await w.once();
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS);
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(1);
    expect(w.state.get(batchId)!.thread.threadTs).toBe("1695700000.000001");
  });
});

describe("the batch watcher drops a batch it cannot post for (spec 052 Ruling 24)", () => {
  // Changed by Ruling 26: only an ended batch is dropped on a permanent Slack error.
  it.each([...PERMANENT_SLACK_ERRORS])("drops an ended batch on Slack's %s, logging an error that names it", async (code) => {
    const w = watcher([ended()]);
    w.slack.post.mockRejectedValueOnce(new SlackApiError("chat.postMessage", code));
    await w.once();
    expect(w.api.dropWatch).toHaveBeenCalledWith(expect.objectContaining({ batchId }) as unknown, `slack:${code}`);
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.dropped", { batchId, reason: `slack:${code}` });
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS);
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(1);
  });

  it.each([...PERMANENT_SLACK_ERRORS])("backs off, and does not drop, a running batch on Slack's %s", async (code) => {
    const w = watcher([batch({ finished: 1 })]);
    w.slack.post.mockRejectedValueOnce(new SlackApiError("chat.postMessage", code));
    await w.once();
    expect(w.api.dropWatch).not.toHaveBeenCalled();
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.batch_failed", { batchId, error: `Slack chat.postMessage failed: ${code}` });
    w.advance(EVAL_BATCH_WATCH_POLL_MS);
    await w.once();
    expect(w.slack.post).toHaveBeenCalledTimes(1);
  });

  it.each(["not_in_channel", "restricted_action"])("never drops a batch on Slack's %s, which an admin can fix", async (code) => {
    expect(PERMANENT_SLACK_ERRORS).not.toContain(code);
    const w = watcher([ended()]);
    w.slack.post.mockRejectedValueOnce(new SlackApiError("chat.postMessage", code));
    await w.once();
    expect(w.api.dropWatch).not.toHaveBeenCalled();
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS + EVAL_BATCH_CLAIM_MS);
    await w.once();
    expect(w.posts).toHaveLength(1);
  });

  // Changed by Ruling 26: a CLI batch is dropped for a missing channel only once it has ended.
  it("drops an ended CLI batch whose channel is gone before its opener", async () => {
    const w = watcher([ended({ thread: { ...thread, threadTs: "0012345678.901234" } })]);
    w.slack.post.mockRejectedValueOnce(new SlackApiError("chat.postMessage", "channel_not_found"));
    await w.once();
    expect(w.state.get(batchId)!.watch).toMatchObject({ dropReason: "slack:channel_not_found" });
  });

  it("logs as an error each batch the broker's list dropped", async () => {
    const w = watcher([]);
    vi.mocked(w.api.listBatches).mockResolvedValueOnce({ batches: [], dropped: [{ batchId, reason: "channel_moved" }] });
    await w.once();
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.dropped", { batchId, reason: "channel_moved" });
  });

  it("backs off a batch for 10 minutes after a failure that may pass, then tries again", async () => {
    const w = watcher([batch({ finished: 1 })]);
    vi.mocked(w.api.updateWatch).mockRejectedValueOnce(new Error("throttled"));
    await w.once();
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.batch_failed", { batchId, error: "throttled" });
    w.advance(EVAL_BATCH_WATCH_POLL_MS);
    await w.once();
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS - EVAL_BATCH_WATCH_POLL_MS - 1);
    await w.once();
    expect(w.api.updateWatch).toHaveBeenCalledTimes(1);
    expect(w.slack.post).not.toHaveBeenCalled();
    w.advance(1);
    await w.once();
    expect(w.posts.map((post) => post.text)).toEqual(["Batch progress: 1/8 done, 0 resolved, $0.00 spent of the $20.00 cap."]);
    expect(EVAL_BATCH_FAILURE_BACKOFF_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("does not drop a batch on a Slack error that may pass, such as rate limiting", async () => {
    const w = watcher([batch({ finished: 1 })]);
    w.slack.post.mockRejectedValueOnce(new SlackApiError("chat.postMessage", "ratelimited"));
    await w.once();
    expect(w.api.dropWatch).not.toHaveBeenCalled();
    expect(w.logError).toHaveBeenCalledWith("eval_batch_watch.batch_failed", { batchId, error: "Slack chat.postMessage failed: ratelimited" });
  });
});

describe("the batch watcher's summary record (spec 052 M-2)", () => {
  it("records a posted summary that failed to record, on the next pass, without posting it again", async () => {
    const w = watcher([ended()]);
    const update = vi.mocked(w.api.updateWatch);
    const real = update.getMockImplementation()!;
    update.mockImplementation(async (seen, revision, change) => {
      if (change.summaryPostedAt !== undefined && update.mock.calls.filter((call) => call[2].summaryPostedAt !== undefined).length === 1) throw new Error("timeout");
      return real(seen, revision, change);
    });
    await w.once();
    expect(w.posts).toHaveLength(1);
    w.advance(EVAL_BATCH_FAILURE_BACKOFF_MS);
    await w.once();
    expect(w.posts).toHaveLength(1);
    expect(w.state.get(batchId)!.watch).toMatchObject({ summaryPostedAt: expect.any(String) as unknown, summaryTs: "1695700000.000001" });
  });
});
