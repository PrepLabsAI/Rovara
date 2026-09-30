import { describe, expect, it, vi } from "vitest";
import type { ProjectModelOptions, SlackRequestMessage, SwebenchRun } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { resultMessage } from "../../packages/slack-service/src/swebench-command.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const usage = {
  schemaVersion: 1 as const, outcome: "SUCCEEDED" as const, provider: "amazon-bedrock", modelId: "balanced-v1", cacheRetention: "long" as const,
  tokens: { input: 900_000, output: 30_000, cacheRead: 700_000, cacheWrite: 50_000, total: 1_680_000 }, cacheReadRatio: 0.4, costUsd: 1.8421,
};

function run(overrides: Partial<SwebenchRun> = {}): SwebenchRun {
  return {
    runId: "3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11", dataset: "verified", instanceId: "django__django-11099",
    model: { provider: "amazon-bedrock", modelId: "balanced-v1" }, maxCostUsd: 10, thread,
    requestedBy: { teamId: thread.teamId, userId: "U0123456789" }, status: "STARTING",
    createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

const graded = run({
  status: "SUCCEEDED",
  finishedAt: "2026-09-30T10:20:00.000Z",
  result: {
    outcome: "GRADED", resolved: true, stopReason: "finished", patchBytes: 899,
    failToPass: { passed: 3, total: 3 }, passToPass: { passed: 19, total: 19 },
    agentSeconds: 425, imageDigest: "swebench/x@sha256:abc", usage, artifactsPrefix: "evals/3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11/",
  },
});

const models: ProjectModelOptions = {
  projectName: "payments",
  approved: [
    { provider: "amazon-bedrock", modelId: "balanced-v1", label: "Balanced" },
    { provider: "amazon-bedrock", modelId: "fast-v1", label: "Fast" },
  ],
  current: { provider: "amazon-bedrock", modelId: "balanced-v1", label: "Balanced" },
  source: "default",
};

function message(text: string, eventId = "EvSWEBENCH01"): SlackRequestMessage {
  return { version: 1, eventId, thread, userId: "U0123456789", text, receivedAt: "2026-09-30T10:00:00.000Z" };
}

function harness(polls: SwebenchRun[] = [run({ status: "RUNNING" }), graded], start: () => Promise<unknown> = async () => ({ outcome: "STARTED", run: run() })) {
  const posts: string[] = [];
  const startSwebenchRun = vi.fn(start);
  const getSwebenchRun = vi.fn(async () => polls.shift()!);
  const sleep = vi.fn(async () => undefined);
  const runTurn = vi.fn();
  const ensureWorkspace = vi.fn();
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace,
      startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
      listProjectModels: async () => models,
      startSwebenchRun: startSwebenchRun as never,
      getSwebenchRun,
    }),
    threads: { load: vi.fn(), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
    sleep,
  };
  return { dependencies, posts, startSwebenchRun, getSwebenchRun, sleep, runTurn, ensureWorkspace };
}

describe("the eval swebench command in the Slack service (spec 043)", () => {
  it("starts the run, says so, waits for it, and posts the result, without a workspace or the orchestrator", async () => {
    const h = harness();
    await processSlackRequest(message("<@UAGENTX> eval swebench verified django__django-11099"), h.dependencies, { finalAttempt: false });
    expect(h.startSwebenchRun).toHaveBeenCalledWith({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, dataset: "verified", instanceId: "django__django-11099" });
    expect(h.posts[0]).toContain("Started a SWE-bench run of `django__django-11099` from SWE-bench Verified on `amazon-bedrock/balanced-v1`, with a cost ceiling of $10.00.");
    expect(h.posts[0]).toContain("say `stop` to cancel it");
    expect(h.getSwebenchRun).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(30_000);
    expect(h.posts[1]).toBe(resultMessage(graded));
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("uses the same request ID for a redelivered event, so the broker returns the same run", async () => {
    const first = harness();
    await processSlackRequest(message("eval swebench verified django__django-11099"), first.dependencies, { finalAttempt: false });
    const again = harness();
    await processSlackRequest(message("eval swebench verified django__django-11099"), again.dependencies, { finalAttempt: false, redelivered: true });
    expect(again.startSwebenchRun.mock.calls[0]).toEqual(first.startSwebenchRun.mock.calls[0]);
    // It resumes waiting without announcing the run a second time.
    expect(again.posts).toEqual([resultMessage(graded)]);
  });

  it("resolves a model by its approved label, and lists the choices for an unknown one", async () => {
    const h = harness();
    await processSlackRequest(message("eval swebench lite django__django-11099 model fast"), h.dependencies, { finalAttempt: false });
    expect(h.startSwebenchRun).toHaveBeenCalledWith(expect.objectContaining({ dataset: "lite", model: { provider: "amazon-bedrock", modelId: "fast-v1" } }));
    const unknown = harness();
    await processSlackRequest(message("eval swebench lite django__django-11099 model opus"), unknown.dependencies, { finalAttempt: false });
    expect(unknown.startSwebenchRun).not.toHaveBeenCalled();
    expect(unknown.posts[0]).toContain("No approved coding model matches “opus”.");
  });

  it("posts the broker's refusal, and a usage hint for a malformed command", async () => {
    const refused = harness([], async () => ({ outcome: "REFUSED", reason: "NOT_ENABLED", message: "SWE-bench runs are not enabled in this channel." }));
    await processSlackRequest(message("eval swebench verified django__django-11099"), refused.dependencies, { finalAttempt: false });
    expect(refused.posts).toEqual(["SWE-bench runs are not enabled in this channel."]);
    expect(refused.getSwebenchRun).not.toHaveBeenCalled();
    const invalid = harness();
    await processSlackRequest(message("eval swebench pro django__django-11099"), invalid.dependencies, { finalAttempt: false });
    expect(invalid.posts[0]).toContain("Unknown dataset “pro”");
    expect(invalid.startSwebenchRun).not.toHaveBeenCalled();
  });
});

describe("the result message (spec 043 SC-003)", () => {
  it("states resolution, tests, why the agent stopped, time, cost and artifacts", () => {
    expect(resultMessage(graded).split("\n")).toEqual([
      "*Resolved* `django__django-11099` (SWE-bench Verified).",
      "• Tests: FAIL_TO_PASS 3/3, PASS_TO_PASS 19/19",
      "• Agent: finished after 7m 05s",
      "• Cost: $1.84 for 1,680,000 tokens on `amazon-bedrock/balanced-v1`",
      "• Patch, transcript and harness logs: `evals/3f0c2a4e-8a51-4b8e-9d57-0e5f4f5b1c11/` in the artifact bucket",
    ]);
  });

  it("explains a capped run with no patch, a failure and a cancellation", () => {
    const capped = run({ status: "SUCCEEDED", result: { ...graded.result!, resolved: false, stopReason: "cost_ceiling", stopDetail: "the run reached its cost ceiling of 10.00 USD", patchBytes: 0, failToPass: undefined, passToPass: undefined } });
    const lines = resultMessage(capped).split("\n");
    expect(lines[0]).toBe("*Not resolved:* `django__django-11099` (SWE-bench Verified).");
    expect(lines[1]).toBe("• Tests: not run, because the agent changed nothing");
    expect(lines[2]).toBe("• Agent: stopped at the cost ceiling after 7m 05s (the run reached its cost ceiling of 10.00 USD)");
    expect(resultMessage(run({ status: "FAILED", error: "could not pull <image>" }))).toBe("The SWE-bench run of `django__django-11099` failed: could not pull &lt;image&gt;");
    expect(resultMessage(run({ status: "CANCELLED" }))).toBe("The SWE-bench run of `django__django-11099` was cancelled and its instance terminated.");
  });
});
