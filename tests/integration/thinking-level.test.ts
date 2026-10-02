import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { resolveTaskModel } from "../../packages/worker/src/task-model.js";
import { createTaskUsageTelemetry } from "../../packages/worker/src/usage.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

async function open(runtimeModel: { reasoning?: boolean }, model: { provider?: string; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }) {
  const { modelRuntime } = await fauxModelRuntime(runtimeModel);
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-thinking-"));
  return createWorkspacePiSession(
    { rootPath, model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId, ...model } },
    createDefaultPiSessionAdapter({ modelRuntime: async (m) => ({ runtime: modelRuntime, model: m }) }),
  );
}

describe("the worker resolves the thinking level once (spec 053)", () => {
  it("uses the level it is given and reports it back", async () => {
    const session = await open({ reasoning: true }, { thinkingLevel: "high" });
    try {
      expect(session.getModel().thinkingLevel).toBe("high");
      // Pi's own level, unfiltered, for result.json (which records even a level outside AgentX's six).
      expect(session.piThinkingLevel?.()).toBe("high");
    } finally { session.dispose(); }
  });

  it("defaults a reasoning model to medium", async () => {
    const session = await open({ reasoning: true }, {});
    try { expect(session.getModel().thinkingLevel).toBe("medium"); } finally { session.dispose(); }
  });

  it("defaults a non-reasoning model to off", async () => {
    const session = await open({ reasoning: false }, {});
    try { expect(session.getModel().thinkingLevel).toBe("off"); } finally { session.dispose(); }
  });

  it("refuses a non-off level on a non-reasoning model", async () => {
    await expect(open({ reasoning: false }, { thinkingLevel: "high" })).rejects.toMatchObject({
      code: "CONFIG_INVALID", message: "CONFIG_INVALID: the selected model does not support reasoning; set thinkingLevel to off",
    });
    const session = await open({ reasoning: false }, { thinkingLevel: "off" });
    session.dispose();
  });

  it("resolves a non-OpenRouter, non-reasoning model with no level to off, through resolveTaskModel (the old task-model forced medium)", async () => {
    const resolved = resolveTaskModel({ provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, {});
    expect(resolved).not.toHaveProperty("thinkingLevel");
    const { modelRuntime } = await fauxModelRuntime({ reasoning: false });
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-thinking-"));
    const session = await createWorkspacePiSession({ rootPath, model: resolved }, createDefaultPiSessionAdapter({ modelRuntime: async (m) => ({ runtime: modelRuntime, model: m }) }));
    try { expect(session.getModel().thinkingLevel).toBe("off"); } finally { session.dispose(); }
  });

  it("carries the session-reported level into createTaskUsageTelemetry", async () => {
    const session = await open({ reasoning: true }, {});
    try {
      const usage = createTaskUsageTelemetry(session.getSessionStats(), { ...session.getModel() }, "SUCCEEDED");
      expect(usage.thinkingLevel).toBe("medium");
    } finally { session.dispose(); }
  });
});
