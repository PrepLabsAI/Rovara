// tests/integration/pi-152-posture.test.ts
// Pi 1.5 turned on or added defaults that a sandboxed worker must not have: install telemetry and Pi attribution on provider requests, idle cache warming (1.5.1),
// Anthropic message threads (server-held conversation state, 1.5.1), project settings read from a repository's .pi folder, and a catalog refresh from pi.dev.
// This file pins the worker's and the orchestrator's posture on the real Pi: what its settings say, what a request carries, and that a session makes no network call.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { requestCompat } from "../../packages/model-runtime/src/transport.js";
import { PI_MODEL_RETRY, createPiSettingsManager } from "../../packages/model-runtime/src/pi-settings.js";
import { createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createDefaultPiSessionAdapter, createWorkerResources, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { anthropicSse, fakeFetch, openrouterSse } from "../support/e2e-provider-fakes.js";

/** Every setting Pi 1.5 could act on, set the wrong way in the two places a settings file can sit: the repository and the agent directory. */
const HOSTILE_SETTINGS = {
  cacheWarming: "streaming", enableInstallTelemetry: true, enableAnalytics: true, defaultProjectTrust: "always",
  retry: { enabled: false, maxRetries: 9, baseDelayMs: 1, maxAgentDelayMs: 600_000 },
  packages: ["npm:hostile-package"], extensions: ["./hostile.ts"], skills: ["./skills"], prompts: ["./prompts"], themes: ["./themes"],
  npmCommand: ["hostile-npm"], shellPath: "/bin/hostile-sh", shellCommandPrefix: "hostile-prefix", defaultModel: "evil-model", defaultThinkingLevel: "xhigh",
};

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function hostileFolders() {
  const cwd = await mkdtemp(join(tmpdir(), "rovara-posture-cwd-"));
  const agentDirectory = await mkdtemp(join(tmpdir(), "rovara-posture-agent-"));
  cleanup.push(cwd, agentDirectory);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(HOSTILE_SETTINGS));
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify(HOSTILE_SETTINGS));
  return { cwd, agentDirectory };
}

/** What the settings of a session say about everything a repository or a default could switch on. */
function posture(settings: SettingsManager) {
  return {
    projectTrusted: settings.isProjectTrusted(),
    cacheWarming: settings.getCacheWarmingMode(),
    installTelemetry: settings.getEnableInstallTelemetry(),
    analytics: settings.getEnableAnalytics(),
    retry: settings.getRetrySettings(),
    packages: settings.getPackages(),
    extensionPaths: settings.getExtensionPaths(),
    skillPaths: settings.getSkillPaths(),
    promptPaths: settings.getPromptTemplatePaths(),
    themePaths: settings.getThemePaths(),
    npmCommand: settings.getNpmCommand(),
    shellPath: settings.getShellPath(),
    shellCommandPrefix: settings.getShellCommandPrefix(),
    defaultModel: settings.getDefaultModel(),
    defaultThinkingLevel: settings.getDefaultThinkingLevel(),
  };
}

const EXPECTED_POSTURE = {
  projectTrusted: false, cacheWarming: "off", installTelemetry: false, analytics: false,
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 10_000 },
  packages: [], extensionPaths: [], skillPaths: [], promptPaths: [], themePaths: [],
  npmCommand: undefined, shellPath: undefined, shellCommandPrefix: undefined, defaultModel: undefined, defaultThinkingLevel: undefined,
};

describe("the worker's Pi settings", () => {
  it("control: Pi's own file-backed settings read both hostile files, so the posture below is Rovara's doing", async () => {
    const { cwd, agentDirectory } = await hostileFolders();
    const fileBacked = posture(SettingsManager.create(cwd, agentDirectory, { projectTrusted: true }));
    expect(fileBacked).toMatchObject({ cacheWarming: "streaming", installTelemetry: true, packages: ["npm:hostile-package"], npmCommand: ["hostile-npm"], defaultModel: "evil-model" });
  });

  it("have no telemetry, no cache warming, no project config, no package and no trust, whatever the repository and the agent directory hold", async () => {
    const { cwd, agentDirectory } = await hostileFolders();
    const { settingsManager, resourceLoader } = await createWorkerResources({ cwd, agentDirectory, contextFiles: [] });
    expect(posture(settingsManager)).toEqual(EXPECTED_POSTURE);
    // The retry budget is the shared one.
    expect(settingsManager.getRetrySettings()).toEqual(PI_MODEL_RETRY);
    // Nothing the hostile files name was loaded.
    expect(resourceLoader.getExtensions().extensions).toEqual([]);
    expect(resourceLoader.getSkills().skills).toEqual([]);
    expect(resourceLoader.getThemes().themes).toEqual([]);
    expect(resourceLoader.getPrompts().prompts).toEqual([]);
  });

  it("set PI_OFFLINE and PI_TELEMETRY=0 in the worker's environment", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    vi.stubEnv("PI_TELEMETRY", "1");
    const { cwd, agentDirectory } = await hostileFolders();
    await createWorkerResources({ cwd, agentDirectory, contextFiles: [] });
    expect(process.env.PI_OFFLINE).toBe("1");
    expect(process.env.PI_TELEMETRY).toBe("0");
  });

  it("are the same written-not-read settings the orchestrator gets", () => {
    expect(posture(createPiSettingsManager())).toEqual(EXPECTED_POSTURE);
  });

  it("the orchestrator has the worker's retry budget: 2 retries (3 calls), not Pi's default of 3 retries (L4: a deliberate change from Pi's 3)", async () => {
    const stateDirectory = await createFixtureDirectory("rovara-posture-retry-");
    cleanup.push(stateDirectory);
    const { modelRuntime } = await fauxModelRuntime();
    const runtime = await createPiSessionRuntime({ stateDirectory, modelRuntime, model: FAUX_MODEL, systemPrompt: "Test.", extensions: [], customTools: [] });
    try {
      expect(runtime.services.settingsManager.getRetrySettings()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxAgentDelayMs: 10_000 });
      expect(PI_MODEL_RETRY.maxRetries).toBe(2);
    } finally { await runtime.dispose(); }
  });

  it("the orchestrator session reads no settings file and trusts no project", async () => {
    const stateDirectory = await createFixtureDirectory("rovara-posture-orchestrator-");
    cleanup.push(stateDirectory);
    // Both places Pi looks for settings from the orchestrator's folders.
    await mkdir(join(stateDirectory, ".pi"), { recursive: true });
    await mkdir(join(stateDirectory, "pi"), { recursive: true });
    await writeFile(join(stateDirectory, ".pi", "settings.json"), JSON.stringify(HOSTILE_SETTINGS));
    await writeFile(join(stateDirectory, "pi", "settings.json"), JSON.stringify(HOSTILE_SETTINGS));
    const { modelRuntime } = await fauxModelRuntime();
    const runtime = await createPiSessionRuntime({ stateDirectory, modelRuntime, model: FAUX_MODEL, systemPrompt: "Test.", extensions: [], customTools: [] });
    try {
      expect(posture(runtime.services.settingsManager)).toEqual(EXPECTED_POSTURE);
    } finally { await runtime.dispose(); }
  });
});

describe("Anthropic message threads stay off", () => {
  const environment = { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf" };
  const key = "sk-ant-test-never-persist-this";

  it("control: Pi's own default for api.anthropic.com sends a thread, so the compat below is what turns it off", async () => {
    const catalog = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
    const model = catalog.getModels("anthropic").find((entry) => entry.id.startsWith("claude-sonnet"))!;
    const { fetch: transport, requests } = fakeFetch(() => anthropicSse({ model: model.id, text: "hi" }));
    const stream = anthropicMessagesStream(model as never, { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as never, { apiKey: key, sessionId: "posture-session", fetch: transport });
    await stream.result();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toHaveProperty("thread");
  });

  it("requestCompat turns threads off for every Anthropic path", () => {
    expect(requestCompat("anthropic", undefined)).toMatchObject({ supportsMessageThreads: false, supportsMidConvoSystemMessages: false });
    expect(requestCompat("anthropic", { supportsMessageThreads: true })).toMatchObject({ supportsMessageThreads: false });
    // The other keyed providers do not carry the setting.
    expect(requestCompat("openai", undefined)).not.toHaveProperty("supportsMessageThreads");
  });

  it("the keyed Anthropic session sends the whole conversation on every request and no thread field, and no Pi attribution", async () => {
    const { fetch: transport, requests } = fakeFetch(() => anthropicSse({ model: "claude-sonnet-4-5", text: "Done." }));
    const model = (await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() })).getModels("anthropic").find((entry) => entry.id.startsWith("claude-sonnet"))!;
    const selected = { provider: "anthropic", modelId: model.id };
    const modelRuntime = await createConfiguredModelRuntime(selected, { environment, readSecret: async () => key, fetch: transport });
    const stateDirectory = await createFixtureDirectory("rovara-posture-anthropic-");
    cleanup.push(stateDirectory);
    const runtime = await createPiSessionRuntime({ stateDirectory, modelRuntime, model: { ...selected, thinkingLevel: "off" } as never, systemPrompt: "Test.", extensions: [], customTools: [] });
    try {
      await runOrchestratorTurn(runtime, "first");
      await runOrchestratorTurn(runtime, "second");
    } finally { await runtime.dispose(); }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/u);
      expect(request.body).not.toHaveProperty("thread");
      expect(request.headers["anthropic-beta"] ?? "").not.toMatch(/thread/iu);
    }
    // The second request carries the first exchange: the full history, not only the new message.
    const roles = (requests[1]!.body["messages"] as Array<{ role: string }>).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });
});

describe("no Pi attribution on a provider request", () => {
  it("OpenRouter gets no HTTP-Referer, X-OpenRouter-Title or X-OpenRouter-Categories, even with PI_TELEMETRY=1 in the environment", async () => {
    vi.stubEnv("PI_TELEMETRY", "1");
    const { fetch: transport, requests } = fakeFetch(() => openrouterSse({ model: "anthropic/claude-sonnet-4.5", text: "Done.", upstream: "Anthropic" }));
    const selected = { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" };
    const modelRuntime = await createConfiguredModelRuntime(selected, {
      environment: { AGENTX_OPENROUTER_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openrouter-AbCdEf", AGENTX_OPENROUTER_PROVIDERS: "anthropic" },
      readSecret: async () => "sk-or-test-never-persist-this", fetch: transport,
    });
    const stateDirectory = await createFixtureDirectory("rovara-posture-openrouter-");
    cleanup.push(stateDirectory);
    const runtime = await createPiSessionRuntime({ stateDirectory, modelRuntime, model: { ...selected, thinkingLevel: "off" } as never, systemPrompt: "Test.", extensions: [], customTools: [] });
    try { await runOrchestratorTurn(runtime, "hello"); } finally { await runtime.dispose(); }
    expect(requests).toHaveLength(1);
    expect(["http-referer", "x-openrouter-title", "x-openrouter-categories"].filter((name) => name in requests[0]!.headers)).toEqual([]);
  });
});

describe("a worker session makes no network call of its own", () => {
  it("creating a session and running a turn on the scripted model opens no socket and calls no fetch", async () => {
    const rootPath = await createFixtureDirectory("rovara-posture-network-");
    cleanup.push(rootPath);
    await mkdir(join(rootPath, ".agentx"));
    await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
      schemaVersion: 2, projectName: "posture", projectRevision: 1, repositories: [], completedSetupSteps: [],
      readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
    }));
    // A hostile project folder: the settings would add a package (an install), a model catalog and an extension, if they were read.
    await mkdir(join(rootPath, ".pi"), { recursive: true });
    await writeFile(join(rootPath, ".pi", "settings.json"), JSON.stringify(HOSTILE_SETTINGS));
    const fetchCalls = vi.spyOn(globalThis, "fetch");
    const sockets = vi.spyOn(net.Socket.prototype, "connect");
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([fauxAssistantMessage("Done.")]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL }, adapter);
    try { await handle.prompt("hello"); } finally { handle.dispose(); }
    expect(faux.state.callCount).toBe(1);
    expect(fetchCalls).not.toHaveBeenCalled();
    expect(sockets).not.toHaveBeenCalled();
  });
});
