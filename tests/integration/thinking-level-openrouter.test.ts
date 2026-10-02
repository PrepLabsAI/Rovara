import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { resolveTaskModel } from "../../packages/worker/src/task-model.js";

const environment = { AGENTX_OPENROUTER_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openrouter-AbCdEf", AGENTX_OPENROUTER_PROVIDERS: "z-ai" };
const chunks = [
  { id: "g", model: "z-ai/glm-5.3", provider: "Z.AI", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
];

async function run(selection: { provider: string; modelId: string; thinkingLevel?: "high" | "medium" | "low" }) {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  const adapter = createDefaultPiSessionAdapter({
    modelRuntime: async (model) => ({ runtime: await createConfiguredModelRuntime(model, { environment, readSecret: async () => "sk-or-test", fetch: transport }), model }),
  });
  const session = await createWorkspacePiSession({ rootPath: await mkdtemp(join(tmpdir(), "agentx-or-")), model: resolveTaskModel(selection, {}) }, adapter);
  try {
    await session.prompt("hi");
    return { level: session.getModel().thinkingLevel, effort: (bodies[0]?.reasoning as { effort?: string } | undefined)?.effort };
  } finally { session.dispose(); }
}

// Root cause of the pilot's "high" on GLM 5.3: Pi's catalog marks medium unsupported for z-ai/glm-5.3
// (thinkingLevelMap.medium is null), so createAgentSession clamps AgentX's default medium up to high.
// The worker records what the session reports, so the recorded level and the request agree.
describe("a real OpenRouter session resolves its thinking level (spec 053)", () => {
  it("runs z-ai/glm-5.3 without a level at high, because Pi clamps the unsupported medium; the request agrees", async () => {
    expect(await run({ provider: "openrouter", modelId: "z-ai/glm-5.3" })).toEqual({ level: "high", effort: "high" });
  });
  it("runs a requested medium on z-ai/glm-5.3 at the clamped high, and records high", async () => {
    expect(await run({ provider: "openrouter", modelId: "z-ai/glm-5.3", thinkingLevel: "medium" })).toEqual({ level: "high", effort: "high" });
  });
  it("sends a supported explicit level as the request's reasoning effort", async () => {
    expect(await run({ provider: "openrouter", modelId: "z-ai/glm-5.3", thinkingLevel: "low" })).toEqual({ level: "low", effort: "low" });
  });
});
