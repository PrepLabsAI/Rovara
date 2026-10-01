import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
    createDefaultPiSessionAdapter({ modelRuntime }),
  );
}

describe("the worker resolves the thinking level once (spec 053)", () => {
  it("uses the level it is given and reports it back", async () => {
    const session = await open({ reasoning: true }, { thinkingLevel: "high" });
    try { expect(session.getModel().thinkingLevel).toBe("high"); } finally { session.dispose(); }
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
    await expect(open({ reasoning: false }, { thinkingLevel: "high" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const session = await open({ reasoning: false }, { thinkingLevel: "off" });
    session.dispose();
  });

  it("gives an OpenRouter selection without a level medium, where Pi's own default was high", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "qwen/qwen3-coder", reasoning: true }] });
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    modelRuntime.registerNativeProvider(faux.provider);
    const resolved = resolveTaskModel({ provider: "openrouter", modelId: "qwen/qwen3-coder" }, {});
    expect(resolved).not.toHaveProperty("thinkingLevel");
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-thinking-"));
    const session = await createWorkspacePiSession({ rootPath, model: resolved }, createDefaultPiSessionAdapter({ modelRuntime }));
    try { expect(session.getModel().thinkingLevel).toBe("medium"); } finally { session.dispose(); }
  });

  it("records the level the session used in usage telemetry", async () => {
    const session = await open({ reasoning: true }, {});
    try {
      const usage = createTaskUsageTelemetry(session.getSessionStats(), { ...session.getModel() }, "SUCCEEDED");
      expect(usage.thinkingLevel).toBe("medium");
    } finally { session.dispose(); }
  });
});
