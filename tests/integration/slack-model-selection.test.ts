import { describe, expect, it, vi } from "vitest";
import type { ProjectModelOptions, SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { ProjectModelOptionsSchema } from "../../packages/contracts/src/index.js";
import { modelOptionsMessage } from "../../packages/slack-service/src/model-command.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";

const options: ProjectModelOptions = {
  projectName: "payments",
  approved: [
    { provider: "amazon-bedrock", modelId: "balanced-v1", label: "Balanced" },
    { provider: "amazon-bedrock", modelId: "fast-v1", label: "Fast" },
  ],
  current: { provider: "amazon-bedrock", modelId: "balanced-v1", label: "Balanced" },
  source: "default",
};

function message(text: string): SlackRequestMessage {
  return {
    version: 1, eventId: "EvMODEL0001",
    thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" },
    userId: "U0123456789", text, receivedAt: "2026-09-27T10:00:00.000Z",
  };
}

function harness() {
  const posts: string[] = [];
  const ensureWorkspace = vi.fn();
  const runTurn = vi.fn();
  const selectProjectModel = vi.fn(async () => ({ ...options, current: options.approved[1]!, source: "selection" as const }));
  const finish = vi.fn(async () => undefined);
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace,
      startClose: vi.fn(), completeClose: vi.fn(), waitForOperation: vi.fn(), createConversation: vi.fn(),
      listProjectModels: async () => options,
      selectProjectModel,
    }),
    threads: {
      load: vi.fn(), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish,
    },
    runTurn,
    post: async (_thread, text) => { posts.push(text); },
  };
  return { dependencies, posts, ensureWorkspace, runTurn, selectProjectModel, finish };
}

describe("Slack project model commands", () => {
  it("shows the thinking level on approved entries that carry one and leaves the others unchanged", () => {
    const parsed = ProjectModelOptionsSchema.parse({
      projectName: "payments",
      approved: [
        { provider: "openrouter", modelId: "z-ai/glm-5.3", label: "GLM 5.3", thinkingLevel: "medium" },
        { provider: "amazon-bedrock", modelId: "fast-v1", label: "Fast" },
      ],
      current: { provider: "openrouter", modelId: "z-ai/glm-5.3", label: "GLM 5.3", thinkingLevel: "medium" },
      source: "default",
    });
    expect(modelOptionsMessage(parsed).split("\n").slice(1, 3)).toEqual([
      "• GLM 5.3 (thinking: medium) — `openrouter/z-ai/glm-5.3` _(current)_",
      "• Fast — `amazon-bedrock/fast-v1`",
    ]);
  });

  it("distinguishes approved OpenRouter and Bedrock models by provider", async () => {
    const h = harness();
    const mixed = { ...options, approved: [options.approved[0]!, { provider: "openrouter", modelId: "balanced-v1", label: "Router" }] };
    const api = h.dependencies.api;
    h.dependencies.api = (...args) => ({ ...api(...args), listProjectModels: async () => mixed });
    await processSlackRequest(message("<@UAGENTX> models"), h.dependencies, { finalAttempt: false });
    expect(h.posts[0]).toContain("openrouter/balanced-v1");
    await processSlackRequest(message("<@UAGENTX> use balanced-v1"), h.dependencies, { finalAttempt: false });
    expect(h.selectProjectModel).not.toHaveBeenCalled();
    await processSlackRequest(message("<@UAGENTX> use openrouter/balanced-v1"), h.dependencies, { finalAttempt: false });
    expect(h.selectProjectModel).toHaveBeenCalledWith({ provider: "openrouter", modelId: "balanced-v1" });
  });
  it("lists approved models without creating a workspace or invoking the orchestrator", async () => {
    const h = harness();
    await processSlackRequest(message("<@UAGENTX> models"), h.dependencies, { finalAttempt: false });
    expect(h.posts[0]).toContain("Approved coding models for this project:");
    expect(h.posts[0]).toContain("Balanced");
    expect(h.posts[0]).toContain("(current)");
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it("selects by label and states the project-wide next-turn scope", async () => {
    const h = harness();
    await processSlackRequest(message("<@UAGENTX> use fast"), h.dependencies, { finalAttempt: false });
    expect(h.selectProjectModel).toHaveBeenCalledWith({ provider: "amazon-bedrock", modelId: "fast-v1" });
    expect(h.posts).toEqual([expect.stringContaining("every Slack workspace in the project on its next turn")]);
    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.runTurn).not.toHaveBeenCalled();
  });

  it("does not change the selection for an unknown, ambiguous, or missing name", async () => {
    for (const text of ["<@UAGENTX> use missing", "<@UAGENTX> use a", "<@UAGENTX> use"]) {
      const h = harness();
      await processSlackRequest(message(text), h.dependencies, { finalAttempt: false });
      expect(h.selectProjectModel).not.toHaveBeenCalled();
      expect(h.posts[0]).toContain("Choose one with");
    }
  });
});
