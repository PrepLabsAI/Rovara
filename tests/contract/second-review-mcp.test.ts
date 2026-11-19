// The MCP tool that reads the second review's state. It only reads (the owner changes the model and the mode on the local page); its text is Rovara's words, and what the models say about themselves is data.
import { describe, expect, it, vi } from "vitest";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/index.js";

const state = {
  mode: "shadow", modes: { company: "shadow", project: null, effective: "shadow" }, pendingLowering: false, evidence: null, trackRecord: null,
  notice: { key: "a".repeat(32), code: "no-candidate", seen: false, lines: ["No allowed model from a different AI company can be used for the second opinion, so it is not running."], createdAt: "2026-11-10T10:00:00.000Z" },
  context: "change_only", alsoSees: null, suggested: [{ provider: "openai", modelId: "gpt-5.5" }], typicalReview: { input: 60000, output: 4000 }, choice: null, projectNarrowing: null, fitKnown: false,
  models: [{ model: { provider: "openai", modelId: "gpt-5.5" }, company: "openai", costUsd: 0.2, eligible: true, notes: [], suggested: true }, { model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, company: "anthropic", eligible: false, ineligibleWhy: "same-company", notes: [], suggested: false }],
  current: { source: "default", models: [{ provider: "openai", modelId: "gpt-5.5" }], line: "Using default: gpt-5.5 (change)" },
};

describe("agentx_get_second_review", () => {
  const tool = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_second_review")!;

  it("is a read: it asks the control plane for the state and says who reviews, the notice, and where the owner changes it", async () => {
    const client = { getSecondReview: vi.fn(async () => state) };
    const result = await tool.handler({ client } as never, { project: "web", builder: ["anthropic:claude-sonnet-4-6"] }, {} as never);
    expect(client.getSecondReview).toHaveBeenCalledWith({ project: "web", builder: ["anthropic:claude-sonnet-4-6"] });
    expect(result.structured).toMatchObject({ mode: "shadow", company_mode: "shadow", reviewing_now: "Using default: gpt-5.5 (change)", choice: [], models: [{ model: "openai:gpt-5.5", eligible: true, suggested: true, cost_usd: 0.2 }, { model: "anthropic:claude-sonnet-4-6", eligible: false }] });
    expect(result.text).toContain("Second review mode: shadow (company: shadow).");
    expect(result.text).toContain("not running");
    expect(result.text).toContain("rovara open second-review");
  });

  it("takes no input that changes anything", () => {
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["builder", "project"]);
    expect(tool.description).toContain("only reads");
  });
});
