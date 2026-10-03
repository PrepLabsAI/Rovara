import { describe, expect, it, vi } from "vitest";
import { SLACK_REPLY_INSTRUCTIONS } from "../../packages/orchestrator/src/orchestrator.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";

describe("hosted Slack runtime reply style", () => {
  it("gives the Slack orchestrator the Slack reply style", async () => {
    const api = { submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), pullRequestResult: vi.fn() };
    const runtime = await createHostedSlackRuntime({
      message: {
        version: 1, eventId: "EvSTYLE00001", receivedAt: "2026-09-25T10:00:00.000Z", userId: "U0123456789",
        thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "what's open?",
      },
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      conversationId: "33333333-3333-4333-8333-333333333333",
      orchestratorInstructions: "Delegate work.",
      requestId: () => "44444444-4444-4444-8444-444444444444",
    }, { stateDirectory: await createFixtureDirectory("agentx-slack-style-"), api: api as never, model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" } });
    try {
      for (const line of SLACK_REPLY_INSTRUCTIONS) expect(runtime.session.systemPrompt).toContain(line);
    } finally { await runtime.dispose(); }
  });
});
