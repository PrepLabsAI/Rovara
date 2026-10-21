import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { createToolLoopExecutor } from "e2e/agent";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2EModelChannelRequest } from "../../packages/contracts/src/e2e-model-channel.js";
import { createE2ECredentialGuard } from "../../packages/worker/src/e2e-model-credential-guard.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { startE2EModelProxy, type E2EModelProxy } from "../../packages/worker/src/e2e-model-proxy.js";
import { CASE_ID, MODEL_ID, PROVIDER_KEY, RUN_ID, SECRET_ARN, bedrockRoute, keyedRoute } from "../support/e2e-model-fixtures.js";
import { anthropicSse, bedrockLoopback, bedrockStreamBody, fakeFetch, jsonError, openaiResponsesSse, openrouterSse } from "../support/e2e-provider-fakes.js";
import { createChannelLanguageModel } from "../support/e2e-model-adapter.js";

const root = new URL("../../", import.meta.url);
interface Manifest { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8")) as Manifest;
const readLock = () => (JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as { packages: Record<string, { version?: string }> }).packages;

/** Every non-test TypeScript source under a package tree (not node_modules or dist). */
function sourceFiles(dir: string): string[] {
  const base = new URL(`${dir}/`, root).pathname.replace(/\/$/, "");
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
    }
  };
  walk(base);
  return out;
}

/** Module specifiers a file names with from, import, import() or require(), in single, double or back quotes. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"`])([^'"`\n]+)\1/g)].map((match) => match[2]!);
}

const isAiSpecifier = (specifier: string) => /^(?:ai|@ai-sdk)(?:\/|$)/.test(specifier);

describe("Step 0: the pinned dependencies", () => {
  it("pins ai at 7.0.127 in the verifier package, and ai's @ai-sdk/provider is the copy e2e 0.20.0 pins", () => {
    expect(readJson("packages/verifier/package.json").dependencies?.ai).toBe("7.0.127");
    const ai = readJson("node_modules/ai/package.json");
    expect(ai.version).toBe("7.0.127");
    const e2e = readJson("node_modules/e2e/package.json");
    const e2eProvider = e2e.dependencies?.["@ai-sdk/provider"] ?? e2e.peerDependencies?.["@ai-sdk/provider"];
    expect(e2eProvider, "e2e pins @ai-sdk/provider").toBe("4.0.21");
    expect(ai.dependencies?.["@ai-sdk/provider"]).toBe("4.0.21");
    expect(readJson("node_modules/@ai-sdk/provider/package.json").version).toBe("4.0.21");
  });

  it("lists ai in no package but the one that hosts e2e, and nothing but the test and verifier sides import it (Ruling M4-O)", async () => {
    const { readdirSync } = await import("node:fs");
    const withAi: string[] = [];
    for (const name of readdirSync(new URL("packages", root))) {
      const manifest = readJson(`packages/${name}/package.json`);
      const lists = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((key) => manifest[key as "dependencies"]?.ai !== undefined);
      if (lists) withAi.push(name);
      if (manifest.dependencies?.e2e !== undefined) expect(name).toBe("verifier");
    }
    expect(withAi).toEqual(["verifier"]);
    expect(readJson("package.json").dependencies?.ai).toBeUndefined();
    expect(readJson("package.json").devDependencies?.ai).toBeUndefined();
    const offenders = sourceFiles("packages").filter((file) => !file.includes("/packages/verifier/")).flatMap((file) => specifiersOf(file).filter(isAiSpecifier).map((specifier) => `${file}: ${specifier}`));
    expect(offenders, "no source outside the verifier imports ai or an @ai-sdk package, in any quote style, require or dynamic import").toEqual([]);
  });

  it("keeps ai out of the worker's module graph: no import of the verifier executor, and nothing reachable from the verifier's root loads ai", () => {
    const workerLike = ["packages/worker", "packages/model-runtime", "packages/broker", "packages/cli"].flatMap((dir) => sourceFiles(`${dir}/src`));
    const executorImports = workerLike.flatMap((file) => specifiersOf(file).filter((specifier) => /^@agentx\/verifier\/executor(?:\/|$)|verifier\/src\/executor|verifier\/dist\/executor/.test(specifier)).map((specifier) => `${file}: ${specifier}`));
    expect(executorImports).toEqual([]);
    const verifierSrc = new URL("packages/verifier/src/", root).pathname;
    const seen = new Set<string>();
    const reached: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of specifiersOf(file)) {
        if (isAiSpecifier(specifier)) reached.push(`${file}: ${specifier}`);
        if (!specifier.startsWith(".")) continue;
        const target = join(file, "..", specifier.replace(/\.js$/, ".ts"));
        if (target.startsWith(verifierSrc) && statSync(target, { throwIfNoEntry: false })?.isFile()) visit(target);
      }
    };
    visit(join(verifierSrc, "index.ts"));
    expect(seen.size).toBeGreaterThan(5);
    expect(reached).toEqual([]);
  });

  it("has one @ai-sdk/provider in the lockfile, and no @ai-sdk package but the three ai needs itself", () => {
    const lock = readLock();
    const provider = Object.keys(lock).filter((key) => key.endsWith("node_modules/@ai-sdk/provider"));
    expect(provider).toEqual(["node_modules/@ai-sdk/provider"]);
    expect(lock["node_modules/@ai-sdk/provider"]!.version).toBe("4.0.21");
    const aiSdk = Object.keys(lock).filter((key) => /(?:^|\/)node_modules\/@ai-sdk\/[^/]+$/.test(key)).map((key) => key.replace(/^.*node_modules\//, "")).sort();
    expect(aiSdk).toEqual(["@ai-sdk/gateway", "@ai-sdk/provider", "@ai-sdk/provider-utils"]);
    expect(lock["node_modules/ai"]!.version).toBe("7.0.127");
  });
});

describe("Step 0: e2e never reaches the Vercel AI Gateway on its own", () => {
  const agentConfig = () => import(new URL("node_modules/e2e/dist/config/agent.js", root).href) as Promise<{
    resolveAgentConfig: (value: unknown, label?: string) => Record<string, unknown>;
    missingModelError: (name: string) => Error & { code: string };
  }>;

  it("has no source that imports or calls gateway from ai, and no implicit default model", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".js")) files.push(path); } };
    walk(new URL("node_modules/e2e/dist", root).pathname);
    // `e2e init` (cli/) scaffolds a gateway config for a human author; it is not on the agent path, and nothing in a run loads it.
    const runtime = files.filter((file) => !file.includes("/dist/cli/"));
    expect(files.length).toBeGreaterThan(50);
    const offenders = runtime.filter((file) => /import\s*\{[^}]*\bgateway\b[^}]*\}\s*from\s*['"]ai['"]|\bgateway\s*\(\s*['"`]|AI_SDK_DEFAULT_PROVIDER|AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN/.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/`[^`]*gateway\([^`]*`/g, "")));
    // The only mentions in the runtime are the example text of two error messages in config/agent.js, which the scan strips.
    expect(offenders.map((file) => file.replace(/^.*node_modules\/e2e\/dist\//, "")).sort()).toEqual([]);
  });

  it("refuses a model given as a string (which the AI SDK would send to the gateway) and a bare gateway-looking object", async () => {
    const { resolveAgentConfig } = await agentConfig();
    expect(() => resolveAgentConfig({ model: "openai/gpt-6-luna-fast" }, "agents.default")).toThrow(/must be an AI SDK model instance, not the string/);
    expect(() => resolveAgentConfig({ model: { provider: "gateway" } }, "agents.default")).toThrow(/AI SDK model instance/);
  });

  it("resolves an agents entry with no model to no model at all, and the agent fixture then refuses with MODEL_UNAVAILABLE", async () => {
    const { resolveAgentConfig, missingModelError } = await agentConfig();
    const resolved = resolveAgentConfig({}, "agents.default");
    expect(resolved["model"]).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toMatch(/gateway/i);
    expect(missingModelError("default").code).toBe("MODEL_UNAVAILABLE");
    // And the loop itself: with no model anywhere, the executor stops before any request.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const executor = createToolLoopExecutor({ name: "no-model", buildPrompt: () => "goal", tools: () => ({}) });
    await expect(executor.runStep({ model: undefined, budgets: { maxModelCalls: 4, remainingMs: () => 60_000, recordModelCall: () => undefined }, signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("resolves a configured adapter to its own provider name, never gateway", async () => {
    const { resolveAgentConfig } = await agentConfig();
    const model = createChannelLanguageModel({ socketPath: "/nonexistent.sock", runId: RUN_ID, caseId: CASE_ID, stepIndex: 0 });
    const resolved = resolveAgentConfig({ model }, "agents.default") as { model: { provider: string; id: string; model: unknown } };
    expect(resolved.model).toMatchObject({ provider: "agentx-e2e", id: "rovara-e2e-default" });
    expect(resolved.model.model).toBe(model);
  });
});

type Answer = { tool: { id: string; name: string; input: Record<string, unknown> } };
const TAP: Answer = { tool: { id: "tooluse_a", name: "tap", input: { target: "n1" } } };
const CONCLUDE: Answer = { tool: { id: "tooluse_b", name: "complete_step", input: { status: "passed", summary: "Tapped the export button." } } };

const stepContext = (recorded: unknown[] = []) => ({
  model: undefined, providerOptions: undefined, agentContext: undefined, signal: new AbortController().signal,
  budgets: { maxModelCalls: 12, remainingMs: () => 60_000, recordModelCall: (call: unknown) => { recorded.push(call); } },
  step: { instruction: "export the orders" }, attachTurns: () => undefined, attachTranscript: () => undefined,
});

describe("Step 0: e2e 0.20.0's tool loop round-trips through the governed route and pi-ai, for each provider", () => {
  let dir: string;
  let proxy: E2EModelProxy | undefined;
  let loopback: Awaited<ReturnType<typeof bedrockLoopback>> | undefined;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rs-")); });
  afterEach(async () => {
    await proxy?.close().catch(() => undefined);
    await loopback?.close();
    proxy = undefined;
    loopback = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function startProxy(invoke: Awaited<ReturnType<typeof createE2EProviderInvoke>>, definition = bedrockRoute()) {
    const route = createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
    proxy = await startE2EModelProxy({
      socketPath: join(dir, "m.sock"), runId: RUN_ID, route, credentialSet: { passwords: [], emails: [], cookieValues: [] },
      evidence: { writeReceipt: () => undefined, writeTranscript: () => undefined }, deadlineAt: Date.now() + 120_000, environment: {},
    });
    proxy.beginStep({ caseId: CASE_ID, stepIndex: 0 });
    return route;
  }

  function loop(sent: E2EModelChannelRequest[], tapped: string[]) {
    const model = createChannelLanguageModel({ socketPath: join(dir, "m.sock"), runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, onCall: (request) => sent.push(request) });
    return createToolLoopExecutor({
      name: "rovara-seam", model: model as never, system: "You drive a web app.",
      buildPrompt: () => 'Goal: export the orders\n#n1 button "Export orders"',
      tools: () => ({
        tap: tool({ description: "Tap one node", inputSchema: z.object({ target: z.string() }), execute: async ({ target }) => { tapped.push(target); return "Tapped " + target + "."; } }),
      }),
    });
  }

  it("Bedrock: the real loop's tool calls reach a loopback endpoint as Converse requests, one per turn, and the receipts name the pinned model", async () => {
    loopback = await bedrockLoopback((_request, count) => ({ status: 200, body: bedrockStreamBody(count === 1 ? TAP : CONCLUDE) }));
    const invoke = await createE2EProviderInvoke(bedrockRoute(), { environment: {}, testing: { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } } });
    await startProxy(invoke);
    const sent: E2EModelChannelRequest[] = [];
    const tapped: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const recorded: unknown[] = [];
    const verdict = await loop(sent, tapped).runStep(stepContext(recorded) as never);

    expect(verdict).toMatchObject({ status: "passed", summary: "Tapped the export button." });
    expect(tapped).toEqual(["n1"]);
    expect(loopback.requests).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(recorded).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const [first, second] = loopback.requests.map((request) => request.body as { toolConfig: { toolChoice: unknown; tools: Array<{ toolSpec: { name: string } }> }; inferenceConfig: unknown; additionalModelRequestFields: unknown; messages: Array<{ role: string; content: Array<{ toolUse?: unknown; toolResult?: unknown }> }> });
    expect(first!.toolConfig.toolChoice).toEqual({ any: {} });
    expect(first!.toolConfig.tools.map((item) => item.toolSpec.name).sort()).toEqual(["complete_step", "tap"]);
    expect(first!.inferenceConfig).toEqual({ maxTokens: 1024 });
    expect(first!.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(second!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second!.messages[1]!.content[0]!.toolUse).toMatchObject({ toolUseId: "tooluse_a", name: "tap", input: { target: "n1" } });
    expect(second!.messages[2]!.content[0]!.toolResult).toMatchObject({ toolUseId: "tooluse_a", content: [{ text: "Tapped n1." }], status: "success" });
    const summary = await proxy!.close();
    expect(summary.receipts.map((item) => [item.callIndex, item.outcome, item.modelId, item.servedModelId])).toEqual([[0, "ok", MODEL_ID, null], [1, "ok", MODEL_ID, null]]);
  });

  const keyed = [
    { provider: "anthropic" as const, answer: (model: string, turn: Answer) => anthropicSse({ model, ...turn }), idOf: (id: string) => id },
    { provider: "openai" as const, answer: (model: string, turn: Answer) => openaiResponsesSse({ model, ...turn }), idOf: (id: string) => id },
    { provider: "openrouter" as const, answer: (model: string, turn: Answer) => openrouterSse({ model, ...turn, upstream: "Anthropic" }), idOf: (id: string) => id },
  ];
  for (const spec of keyed) {
    it(spec.provider + ": the real loop's tool calls reach the provider as its own requests, one per turn, with no call to the global fetch", async () => {
      const definition = keyedRoute(spec.provider);
      let turn = 0;
      const fake = fakeFetch(() => spec.answer(definition.modelId, turn++ === 0 ? TAP : CONCLUDE));
      const invoke = await createE2EProviderInvoke(definition, { environment: {}, readSecret: async (arn) => (arn === SECRET_ARN ? PROVIDER_KEY : undefined), fetch: fake.fetch });
      await startProxy(invoke, definition);
      const tapped: string[] = [];
      const globalFetch = vi.spyOn(globalThis, "fetch");
      const verdict = await loop([], tapped).runStep(stepContext() as never);
      expect(verdict).toMatchObject({ status: "passed" });
      expect(tapped).toEqual(["n1"]);
      expect(fake.requests).toHaveLength(2);
      expect(globalFetch).not.toHaveBeenCalled();
      globalFetch.mockRestore();
      const summary = await proxy!.close();
      expect(summary.receipts.map((item) => [item.outcome, item.provider, item.modelId, item.servedModelId])).toEqual([
        ["ok", spec.provider, definition.modelId, definition.modelId], ["ok", spec.provider, definition.modelId, definition.modelId],
      ]);
      // The provider key is in the auth header and nowhere else: not in a payload, a receipt or the summary.
      expect(fake.requests.every((request) => !request.bodyText.includes(PROVIDER_KEY))).toBe(true);
      expect(JSON.stringify(summary)).not.toContain(PROVIDER_KEY);
    });
  }

  it("does not resend when the provider throttles: the loop ends the step after one request, on Bedrock and on a keyed provider", async () => {
    loopback = await bedrockLoopback(() => ({ status: 429, body: JSON.stringify({ message: "Rate exceeded" }), errorType: "ThrottlingException" }));
    const invoke = await createE2EProviderInvoke(bedrockRoute(), { environment: {}, testing: { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } } });
    await startProxy(invoke);
    const model = createChannelLanguageModel({ socketPath: join(dir, "m.sock"), runId: RUN_ID, caseId: CASE_ID, stepIndex: 0 });
    const executor = createToolLoopExecutor({ name: "rovara-seam", model: model as never, buildPrompt: () => "Goal: x", tools: () => ({}) });
    await expect(executor.runStep(stepContext() as never)).rejects.toMatchObject({ code: "MODEL_PROVIDER_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loopback.requests).toHaveLength(1);
    expect((await proxy!.close()).receipts.map((item) => item.outcome)).toEqual(["provider-error"]);

    const definition = keyedRoute("anthropic");
    const fake = fakeFetch(() => jsonError(429));
    const keyedInvoke = await createE2EProviderInvoke(definition, { environment: {}, readSecret: async () => PROVIDER_KEY, fetch: fake.fetch });
    await startProxy(keyedInvoke, definition);
    await expect(createToolLoopExecutor({ name: "rovara-seam", model: createChannelLanguageModel({ socketPath: join(dir, "m.sock"), runId: RUN_ID, caseId: CASE_ID, stepIndex: 0 }) as never, buildPrompt: () => "Goal: x", tools: () => ({}) }).runStep(stepContext() as never)).rejects.toMatchObject({ code: "MODEL_PROVIDER_FAILED" });
    expect(fake.requests).toHaveLength(1);
  });

  it("scans a provider key the invoke holds: a page that shows it is refused before any request", async () => {
    const definition = keyedRoute("anthropic");
    const fake = fakeFetch(() => anthropicSse({ model: definition.modelId, ...TAP }));
    const invoke = await createE2EProviderInvoke(definition, { environment: {}, readSecret: async () => PROVIDER_KEY, fetch: fake.fetch });
    await startProxy(invoke, definition);
    const guard = createE2ECredentialGuard({ passwords: [...invoke.secrets], emails: [], cookieValues: [] });
    expect(guard.containsSecret({ messages: ["the page shows " + PROVIDER_KEY] })).toBe(true);
    const model = createChannelLanguageModel({ socketPath: join(dir, "m.sock"), runId: RUN_ID, caseId: CASE_ID, stepIndex: 0 });
    const executor = createToolLoopExecutor({ name: "rovara-seam", model: model as never, buildPrompt: () => "Goal: the page shows " + PROVIDER_KEY, tools: () => ({}) });
    await expect(executor.runStep(stepContext() as never)).rejects.toMatchObject({ code: "MODEL_PROVIDER_FAILED" });
    expect(fake.requests).toHaveLength(0);
    expect((await proxy!.close()).receipts.map((item) => item.outcome)).toEqual(["refused-credential-match"]);
  });
});
