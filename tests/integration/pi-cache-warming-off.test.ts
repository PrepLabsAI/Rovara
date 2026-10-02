// tests/integration/pi-cache-warming-off.test.ts
// Spec 050 phase 2: Pi 0.86+ keeps prompt caches warm by re-sending the last request (maxTokens 1) while a tool runs,
// and "streaming" is its default. 0.85.1 made no such request, and each costs money, so AgentX turns it off for the
// worker and the orchestrator. Offline: Pi's scripted model, given a cache lifetime just over Pi's 10-second floor
// (so a warm-up is due 10 ms after a request) and prices that make warming worth it by Pi's own rule.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, type BashOperations } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createDefaultPiSessionAdapter, createWorkerResources, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const MODEL = { provider: "agentx-warm", modelId: "cached", thinkingLevel: "off" } as const;
/** A warm-up would be due 10 ms after each request; the tool runs this long, a hundred times that, while one could happen. */
const WINDOW_MS = 1_000;
const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function cachedModelRuntime() {
  // Prices per million tokens: a cache miss costs far more than a cache read, so Pi's rule says "warm".
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId, cost: { input: 1_000, output: 1, cacheRead: 0.001, cacheWrite: 0 } }] });
  // Pi's prompt-cache lifetime metadata (seconds); the faux definition has no field for it.
  Object.assign(faux.models[0], { promptCache: { short: 10.01 } });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  return { modelRuntime, faux };
}

/** A tool that runs until `done` resolves, recording how many model requests were made while it ran. */
function slowTool(done: () => Promise<void>, seen: number[], count: () => number) {
  return {
    name: "slow", label: "Slow", description: "Takes a while", parameters: Type.Object({}),
    execute: async () => { const before = count(); await done(); seen.push(count() - before); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
  };
}

describe("Pi 1.0's prompt-cache warming stays off", () => {
  it("control: the same orchestrator session with Pi's default mode sends a warm-up while the tool runs", async () => {
    // protects this file's probe: the scripted model and prices really make Pi warm the cache
    const { modelRuntime, faux } = await cachedModelRuntime();
    const seen: number[] = [];
    // The tool waits for the warm-up request itself, so the control needs no timer.
    const warmed = () => new Promise<void>((resolve) => { const poll = () => (faux.state.callCount >= 2 ? resolve() : setImmediate(poll)); poll(); });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }), fauxAssistantMessage("warm"), fauxAssistantMessage("Done.")]);
    const runtime = await createPiSessionRuntime({ stateDirectory: await createFixtureDirectory("agentx-warm-control-"), modelRuntime, model: MODEL, systemPrompt: "Test. ".repeat(500),
      extensions: [], customTools: [slowTool(warmed, seen, () => faux.state.callCount)] });
    try {
      runtime.session.setCacheWarmingMode("streaming");
      expect(await runOrchestratorTurn(runtime, "run the slow tool")).toBe("Done.");
    } finally { await runtime.dispose(); }
    expect(seen).toEqual([1]);
  });

  it("in the orchestrator: no warm-up request while a tool runs, and Pi reports warming disabled", async () => {
    // protects packages/orchestrator/src/orchestrator.ts (setCacheWarmingMode("off"))
    const { modelRuntime, faux } = await cachedModelRuntime();
    const seen: number[] = [];
    const statuses: unknown[] = [];
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
    const runtime = await createPiSessionRuntime({ stateDirectory: await createFixtureDirectory("agentx-warm-orchestrator-"), modelRuntime, model: MODEL, systemPrompt: "Test. ".repeat(500),
      extensions: [], customTools: [slowTool(async () => { statuses.push(runtime.session.cacheWarmingStatus); await pause(WINDOW_MS); }, seen, () => faux.state.callCount)] });
    try {
      expect(await runOrchestratorTurn(runtime, "run the slow tool")).toBe("Done.");
    } finally { await runtime.dispose(); }
    expect(seen).toEqual([0]);
    expect(statuses).toEqual([{ state: "inactive", reason: "cache warming disabled" }]);
    expect(faux.state.callCount).toBe(2);
  });

  it("in the worker: the settings say off, and no warm-up request is made while a bash call runs", async () => {
    // protects packages/worker/src/pi-session.ts (createWorkerResources setCacheWarmingMode("off"))
    const rootPath = await createFixtureDirectory("agentx-warm-worker-");
    await mkdir(join(rootPath, ".agentx"));
    await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
      schemaVersion: 2, projectName: "warm", projectRevision: 1, repositories: [], completedSetupSteps: [],
      readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
    }));
    const { settingsManager } = await createWorkerResources({ cwd: rootPath, agentDirectory: join(rootPath, ".agentx/pi"), contextFiles: [] });
    expect(settingsManager.getCacheWarmingMode()).toBe("off");

    const { modelRuntime, faux } = await cachedModelRuntime();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
    const during: number[] = [];
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        const before = faux.state.callCount;
        await pause(WINDOW_MS);
        during.push(faux.state.callCount - before);
        options.onData(Buffer.from("ok\n"));
        return { exitCode: 0 };
      },
    };
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: MODEL }) });
    const handle = await createWorkspacePiSession({ rootPath, model: MODEL, bashOperations: operations }, adapter);
    try {
      await handle.prompt("run it");
    } finally { handle.dispose(); }
    expect(during).toEqual([0]);
    expect(faux.state.callCount).toBe(2);
  });
});
