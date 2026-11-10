// The small parts of lessons on a laptop: the in-process embedder, the learning point's default adapter, the settings items, the model path and what a finished task's record tells.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, learningModeKey, teamRecordPk } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createHashingEmbedder, createLocalLearningAdapter, HASHING_EMBEDDER_DIMENSION } from "../../packages/broker/src/lessons/local-embedder.js";
import { DocumentPresetStore, DocumentSoleOwnerSwitch, DocumentTier0Settings, documentLearningSettings, writeLearningMode, writeLoadBudget } from "../../packages/broker/src/lessons/document-settings.js";
import { resolveLearning, setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { cosine } from "../../packages/broker/src/lessons/similarity.js";
import { createLocalPipelineModel } from "../../packages/broker/src/local/app/lessons-model.js";
import { LearningRefusal } from "../../packages/broker/src/lessons/pause.js";
import { createMemoryModelKeyStore } from "../../packages/broker/src/ports/model-key-stores.js";
import { builtinModelProviderBook } from "../../packages/broker/src/local/model-proxy/index.js";
import { createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";

const WS = IMPLICIT_COMPANY_ID;

describe("the in-process embedder", () => {
  it("is deterministic, has the declared size and length 1, and puts texts with shared words nearer than texts with none", async () => {
    const embedder = createHashingEmbedder();
    const [a, b, c] = await embedder.embedMany(["Wrap network calls in withRetry", "network calls need withRetry around them", "the database schema uses snake case"]);
    expect(a).toHaveLength(HASHING_EMBEDDER_DIMENSION);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
    expect(await embedder.embed("Wrap network calls in withRetry")).toEqual(a);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!) + 0.2);
    expect(embedder.spec).toBe("local-hash-v1-384");
  });

  it("keeps an empty text as a zero vector instead of dividing by nothing", async () => {
    expect((await createHashingEmbedder().embed("  ")).every((value) => value === 0)).toBe(true);
  });

  it("is given by the local learning adapter only when asked for", () => {
    expect("embedder" in createLocalLearningAdapter()).toBe(false);
    expect(createLocalLearningAdapter({ embedder: true }).embedder?.(WS)?.dimension).toBe(HASHING_EMBEDDER_DIMENSION);
  });
});

describe("the learning settings in the document store", () => {
  it("reads a project that never chose as Suggest, and its own choice, the company's lock and the tier-0 setting after", async () => {
    setLearnedLessonsGate(() => true);
    try {
      const store = new MemoryDocumentStore();
      const reader = documentLearningSettings(store);
      expect(await reader.read(WS, "payments")).toMatchObject({ mode: "Suggest" });
      await writeLearningMode(store, { workspaceId: WS, project: "payments" }, "On", 1);
      expect(await reader.read(WS, "payments")).toMatchObject({ mode: "On" });
      expect((await store.get(learningModeKey(WS, "payments")))?.["mode"]).toBe("on");
      await store.put({ item: { pk: teamRecordPk(WS), sk: "MODE_LOCK", mode: "collect" } });
      expect((await resolveLearning(reader, WS, "payments")).mode).toBe("Collect");
      expect(await new DocumentTier0Settings(store).write({ kind: "project", workspaceId: WS, project: "payments" }, "two", { by: "owner", at: 1 }, "one")).toBe(true);
      expect(await reader.read(WS, "payments")).toMatchObject({ tier0Approval: "two" });
    } finally { setLearnedLessonsGate(undefined); }
  });

  it("fails closed on a stored mode it does not know", async () => {
    setLearnedLessonsGate(() => true);
    try {
      const store = new MemoryDocumentStore();
      await store.put({ item: { pk: teamRecordPk(WS, "payments"), sk: "MODE", mode: "everything" } });
      expect((await resolveLearning(documentLearningSettings(store), WS, "payments")).mode).toBe("Off");
    } finally { setLearnedLessonsGate(undefined); }
  });

  it("refuses a tier-0 write that read an older value, keeps a preset's change request once, and moves it by its state", async () => {
    const store = new MemoryDocumentStore();
    const scope = { kind: "project" as const, workspaceId: WS, project: "payments" };
    const tier0 = new DocumentTier0Settings(store);
    expect(await tier0.write(scope, "two", { by: "a", at: 1 }, "auto")).toBe(false);
    const presets = new DocumentPresetStore(store);
    const change = { id: "c1", scope, from: "regulated" as const, to: "standard" as const, proposedBy: "a", at: 1, expiresAt: 10, state: "pending" as const };
    expect(await presets.create(change)).toBe(true);
    expect(await presets.create(change)).toBe(false);
    expect((await presets.open(scope, 5))?.id).toBe("c1");
    expect(await presets.transition(scope, "c1", "pending", "applied")).toBe(true);
    expect(await presets.transition(scope, "c1", "pending", "cancelled")).toBe(false);
    expect(await presets.open(scope, 5)).toBeUndefined();
  });

  it("has the sole-owner switch on until it is written off, and refuses a load budget outside the caps", async () => {
    const store = new MemoryDocumentStore();
    const sole = new DocumentSoleOwnerSwitch(store);
    expect(await sole.read(WS)).toBe(true);
    expect(await sole.write(WS, false, { by: "a", at: 1 }, true)).toBe(true);
    expect(await sole.read(WS)).toBe(false);
    expect(await writeLoadBudget(store, { workspaceId: WS, project: "payments" }, { lessons: 99 }, 1)).toBe(false);
    expect(await writeLoadBudget(store, { workspaceId: WS, project: "payments" }, { lessons: 3, bytes: 1024 }, 1)).toBe(true);
    expect(await documentLearningSettings(store).read(WS, "payments")).toMatchObject({ loadBudget: { lessons: 3, bytes: 1024 } });
  });
});

describe("the learning model path", () => {
  const anthropic = (text: string, seen: Array<Record<string, unknown>> = []): typeof fetch => (async (_url, init) => {
    seen.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const key = createMemoryModelKeyStore({ anthropic: ["sk", "ant", "x", "y", "z"].join("-") });
  const request = { purpose: "reflect" as const, system: "system words", user: "user words", maxOutputTokens: 100, workspaceId: WS };

  it("sends the system and user text without tools, to the provider the install chose, and prices the usage it reports", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const metered: string[] = [];
    const metering = createPriceTableMetering({ currency: "USD", models: { "anthropic/claude-test": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } } }, (entry) => { metered.push(entry.entryId); });
    const model = createLocalPipelineModel({ choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: key, companyId: WS, providers: builtinModelProviderBook(), fetch: anthropic("{\"candidates\":[]}", seen), metering });
    const result = await model.complete(request);
    expect(result.text).toBe("{\"candidates\":[]}");
    expect(result.model).toBe("anthropic/claude-test");
    expect(result.costUsd).toBeCloseTo(0.00002, 8);
    expect(metered).toHaveLength(1);
    expect(seen[0]).toMatchObject({ system: "system words", messages: [{ role: "user", content: "user words" }] });
    expect(seen[0]).not.toHaveProperty("tools");
  });

  it("refuses with the no-provider reason, and calls nothing, when no model is set up", async () => {
    let called = 0;
    const model = createLocalPipelineModel({ choice: async () => undefined, keys: key, companyId: WS, providers: builtinModelProviderBook(), fetch: (async () => { called += 1; return new Response("{}"); }) });
    await expect(model.complete(request)).rejects.toBeInstanceOf(LearningRefusal);
    expect(called).toBe(0);
  });

  it("refuses, with nothing sent, when the provider has no key", async () => {
    let called = 0;
    const model = createLocalPipelineModel({ choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: createMemoryModelKeyStore({}), companyId: WS, providers: builtinModelProviderBook(), fetch: (async () => { called += 1; return new Response("{}"); }) });
    await expect(model.complete(request)).rejects.toBeInstanceOf(LearningRefusal);
    expect(called).toBe(0);
  });

  it("throws, and marks the attempt's fault final, when the provider answers with an error", async () => {
    const { withLearningAttempt } = await import("../../packages/broker/src/lessons/learning-deadline.js");
    const model = createLocalPipelineModel({ choice: async () => ({ provider: "anthropic", model: "claude-test" }), keys: key, companyId: WS, providers: builtinModelProviderBook(), fetch: (async () => new Response("{}", { status: 500 })) });
    const attempt = { deadlineAt: Date.now() + 60_000 } as { deadlineAt: number; fault?: "retryable" | "final" };
    await expect(withLearningAttempt(attempt, () => model.complete(request))).rejects.toThrow();
    expect(attempt.fault).toBe("final");
  });
});

