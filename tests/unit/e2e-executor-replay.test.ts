import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError } from "e2e/agent";
import { canonicalJson, type E2EReplayTrace } from "@agentx/contracts";
import { createE2EReplayState, createE2EReplayStepDriver, createE2EReplayStore, createRovaraE2EReplayExecutor } from "../../packages/verifier/src/executor/agent-replay.js";
import { e2eApplicationAgentConfig } from "../../packages/verifier/src/application-runtime-bootstrap.js";
import { createRovaraE2EAgentExecutor } from "../../packages/verifier/src/executor/agent-executor.js";
import { createE2EAgentCaptureStore } from "../../packages/verifier/src/executor/agent-capture-store.js";

// M1.4 Task 4.6b, tests 10, 13, 14 and the parts of 12: the replay serves only bound recordings, holds no model, and the bootstrap loads a replay config only from those.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const KEY = sha("cache key of the step");
const cleanTrace = (extra: Record<string, unknown> = {}) => ({
  actions: [{ name: "tap", summary: "The tap action.", target: { role: "button", name: "Download orders", testId: "download-orders" } }],
  summary: "The recorded AI navigation concluded.", executor: { name: "rovara-e2e-agent", version: "1" }, startPath: "/", endPath: "/", ...extra });
function recording(trace: Record<string, unknown> = cleanTrace(), options: { keyHash?: string; bind?: Record<string, unknown>; fileKey?: string } = {}): E2EReplayTrace {
  const keyHash = options.keyHash ?? KEY;
  const file = JSON.stringify({ schemaVersion: "rovara-agent-trace-file/v1", keyHash: options.fileKey ?? keyHash, trace });
  return { caseId: "case-a", stepIndex: 1, keyHash, traceBase64: Buffer.from(file).toString("base64"),
    binding: { schemaVersion: "rovara-agent-trace/v1", runId: randomUUID(), caseId: "case-a", stepIndex: 1, traceSha256: sha(canonicalJson(trace)), ledgerSha256: sha("ledger"), actionCount: 1, ...options.bind } as E2EReplayTrace["binding"] };
}

describe("the replay store serves only bound recordings (tests 13 and 14)", () => {
  it("serves the recording whose trace digest is its binding's and whose key is the one it is read under, as the entry the runner reads", async () => {
    const trace = cleanTrace();
    const store = createE2EReplayStore([recording(trace)]);
    const hit = await store.read(KEY);
    expect(hit).toMatchObject({ status: "hit", entry: { schemaVersion: "trace-1", payload: trace } });
    expect(await store.read(sha("another key"))).toEqual({ status: "miss" });
  });
  it("is a miss for a recording whose bytes are not the bound ones (an edited trace, a binding for other bytes) and for one stored under another key", async () => {
    const edited = recording(cleanTrace({ endPath: "/other" }), { bind: { traceSha256: sha(canonicalJson(cleanTrace())) } });
    expect(await createE2EReplayStore([edited]).read(KEY)).toEqual({ status: "miss" });
    const rebound = recording(cleanTrace(), { bind: { traceSha256: sha("not this trace") } });
    expect(await createE2EReplayStore([rebound]).read(KEY)).toEqual({ status: "miss" });
    const wrongFileKey = recording(cleanTrace(), { fileKey: sha("the key the file was written under") });
    expect(await createE2EReplayStore([wrongFileKey]).read(KEY)).toEqual({ status: "miss" });
    // Control: the unedited recording of the same shape is served, so each miss above is the check that refused it.
    expect((await createE2EReplayStore([recording()]).read(KEY)).status).toBe("hit");
  });
  it("is a miss for a file that is not canonical base64 or not a recording of the contract, and serves neither of two recordings under one key", async () => {
    const good = recording();
    expect(await createE2EReplayStore([{ ...good, traceBase64: `${good.traceBase64.slice(0, -2)}A=` }]).read(KEY)).toEqual({ status: "miss" });
    const notContract = recording({ ...cleanTrace(), summary: "free model prose about the page" });
    expect(await createE2EReplayStore([notContract]).read(KEY)).toEqual({ status: "miss" });
    const twin = { ...recording(), stepIndex: 2, binding: { ...recording().binding, stepIndex: 2 } };
    expect(await createE2EReplayStore([recording(), twin]).read(KEY)).toEqual({ status: "miss" });
  });
  it("is a miss for a recording that holds a keyed digest of a value the model chose, and says so: the step ends typed-value-not-replayable (test 13)", async () => {
    const hidden = cleanTrace({ actions: [{ name: "type", summary: "The type action.", target: { role: "textbox", name: "Search" }, value: `hmac-sha256:${sha("secret value")}` }] });
    const state = createE2EReplayState();
    expect(await createE2EReplayStore([recording(hidden)], state).read(KEY)).toEqual({ status: "miss" });
    expect(state.typedValueMiss).toBe(true);
    // An anchor that shows a hidden input value counts too.
    const anchor = cleanTrace({ endAnchors: [{ role: "textbox", name: "Search", value: `hmac-sha256:${sha("secret value")}` }] });
    const anchorState = createE2EReplayState();
    expect(await createE2EReplayStore([recording(anchor)], anchorState).read(KEY)).toEqual({ status: "miss" });
    expect(anchorState.typedValueMiss).toBe(true);
    // Positive control: a recording with a goal-literal value (plain text) is served and flags nothing.
    const literal = cleanTrace({ actions: [{ name: "type", summary: "The type action.", target: { role: "textbox", name: "Search" }, value: "orders" }] });
    const plainState = createE2EReplayState();
    expect((await createE2EReplayStore([recording(literal)], plainState).read(KEY)).status).toBe("hit");
    expect(plainState.typedValueMiss).toBe(false);
  });
  it("never writes and never deletes: it is read-only, and an eviction asked of it does nothing", async () => {
    const store = createE2EReplayStore([recording()]);
    expect(store.writable).toBe(false);
    expect(await store.write(KEY, cleanTrace() as never)).toBeUndefined();
    expect("delete" in store).toBe(false);
    expect((await store.read(KEY)).status).toBe("hit");
  });
  it("hands out a copy: a caller that edits the entry it was given changes nothing the next read returns", async () => {
    const store = createE2EReplayStore([recording()]);
    const first = await store.read(KEY);
    if (first.status !== "hit") throw new Error("expected a hit");
    (first.entry.payload as { actions: unknown[] }).actions.length = 0;
    const second = await store.read(KEY);
    expect(second.status === "hit" && (second.entry.payload as { actions: unknown[] }).actions).toHaveLength(1);
  });
});

describe("the replay executor holds no model and stops the step it is handed", () => {
  it("has no model, no judge and no cache preference, and answers a blocked verdict at once, saying the step needed a model", async () => {
    const state = createE2EReplayState();
    const executor = createRovaraE2EReplayExecutor(state);
    expect(executor.name).toBe("rovara-e2e-replay");
    expect(executor.version).toBe("1");
    expect(executor.model).toBeUndefined();
    expect(executor.judge).toBeUndefined();
    expect(executor.cache).toBeUndefined();
    const verdict = await executor.runStep({} as never);
    expect(verdict).toMatchObject({ status: "blocked", errorCode: "ENVIRONMENT_UNAVAILABLE" });
    expect(state.needsModel).toBe(true);
  });
  it("is made of modules that never reach a model: its imports (and theirs, runtime ones) name no AI SDK, no channel client and no model adapter", () => {
    const root = resolve(import.meta.dirname, "../../packages/verifier/src");
    const seen = new Set<string>();
    const external: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gmu)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
        else external.push(specifier);
      }
    };
    visit(join(root, "executor/agent-replay.ts"));
    expect(external.filter((item) => item === "ai" || item.startsWith("@ai-sdk/"))).toEqual([]);
    expect([...seen].map((file) => file.slice(root.length + 1)).filter((file) => /model-channel|agent-model-adapter|agent-executor|agent-step-driver|ai-default-provider/u.test(file))).toEqual([]);
    // The control: the walk reached the modules the replay really uses.
    expect([...seen].map((file) => file.slice(root.length + 1))).toContain("application-templates.ts");
  });
});

describe("the step port of a replay", () => {
  const act = (outcome: "ok" | "agent" | "other") => async () => {
    if (outcome === "ok") return undefined;
    if (outcome === "agent") throw new AgentError("ENVIRONMENT_UNAVAILABLE", "x");
    throw new Error("the executor itself broke");
  };
  const request = (actImpl: () => Promise<unknown>) => ({ caseId: "case-a", stepIndex: 1, goal: "Export", maxActions: 4, timeoutMs: 1000, signal: new AbortController().signal, act: actImpl as never });
  it("concludes a step the runner replayed whole, with no receipt", async () => {
    const run = createE2EReplayStepDriver(createE2EReplayState());
    expect(await run(request(act("ok")))).toEqual({ verdict: "concluded", stopCode: null, receiptIds: [] });
  });
  it("ends a step the runner could not replay as replay-needs-model, or typed-value-not-replayable when the store refused a hidden value", async () => {
    const state = createE2EReplayState();
    const run = createE2EReplayStepDriver(state);
    expect(await run(request(act("agent")))).toEqual({ verdict: "failed", stopCode: "replay-needs-model", receiptIds: [] });
    expect(await run(request(async () => { state.typedValueMiss = true; throw new AgentError("ENVIRONMENT_UNAVAILABLE", "x"); }))).toEqual({ verdict: "failed", stopCode: "typed-value-not-replayable", receiptIds: [] });
    // The flags belong to one step: the next step starts clean.
    expect(await run(request(act("agent")))).toMatchObject({ stopCode: "replay-needs-model" });
  });
  it("does not turn an executor fault into an answer: anything that is not the runner's own stop is thrown again", async () => {
    const run = createE2EReplayStepDriver(createE2EReplayState());
    await expect(run(request(act("other")))).rejects.toThrow("the executor itself broke");
  });
});

describe("the bootstrap builds a replay config only from the replay parts (test 10)", () => {
  const route = { routeId: "rovara-scripted/v1", routeRevision: "r1" };
  const replayHost = () => { const state = createE2EReplayState(); return { agentExecutor: createRovaraE2EReplayExecutor(state), agentCacheStore: createE2EReplayStore([], state) }; };
  const modelHost = () => ({ modelFactory: () => ({ provider: "agentx-e2e", modelId: route.routeId, specificationVersion: "v4", doGenerate: async () => ({}) }) as never,
    agentExecutor: createRovaraE2EAgentExecutor({ position: () => null, ledger: () => null, origin: () => "http://127.0.0.1" }), agentCacheStore: createE2EAgentCaptureStore() });
  it("builds a read-only cache and an agents entry with no model for a replay declaration and the replay parts", () => {
    const config = e2eApplicationAgentConfig({ modelRoute: null, replay: true }, replayHost());
    expect(config.cache).toMatchObject({ mode: "read-only" });
    expect(Object.keys(config.agents!)).toEqual(["default"]);
    expect(config.agents!["default"]).toEqual({ executor: expect.objectContaining({ name: "rovara-e2e-replay" }) });
    expect("model" in config.agents!["default"]!).toBe(false);
  });
  it("refuses a replay declaration whose host offers a model factory, a model-bearing executor, a writable store, or the governed (model) executor", () => {
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { ...replayHost(), modelFactory: modelHost().modelFactory })).toThrow(/model factory/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { ...replayHost(), agentExecutor: { ...replayHost().agentExecutor, model: modelHost().modelFactory() } })).toThrow(/replay executor/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { ...replayHost(), agentExecutor: { ...replayHost().agentExecutor, judge: modelHost().modelFactory() } })).toThrow(/replay executor/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { ...replayHost(), agentCacheStore: createE2EAgentCaptureStore() })).toThrow(/read-only store/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { agentExecutor: modelHost().agentExecutor, agentCacheStore: replayHost().agentCacheStore })).toThrow(/replay executor/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: true }, { agentCacheStore: replayHost().agentCacheStore })).toThrow(/replay executor/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: route, replay: true }, modelHost())).toThrow(/audit replay is given no model route/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: route, replay: true }, { ...replayHost(), modelFactory: modelHost().modelFactory })).toThrow(/audit replay is given no model route/);
  });
  it("refuses a null-route declaration with a model factory, replay or not, and still builds the cache-off config for a null-route host with none", () => {
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: false }, modelHost())).toThrow(/model factory/);
    expect(() => e2eApplicationAgentConfig({ modelRoute: null, replay: false }, { modelFactory: modelHost().modelFactory })).toThrow(/model factory/);
    expect(e2eApplicationAgentConfig({ modelRoute: null, replay: false }, {})).toEqual({ cache: "off" });
  });
  it("is unchanged for a declaration that names a route: the read-write capture cache and the agent with its model ceiling (the 4.3b config)", () => {
    const config = e2eApplicationAgentConfig({ modelRoute: route, replay: false }, modelHost());
    expect(config.cache).toMatchObject({ mode: "read-write" });
    expect(config.agents!["default"]).toMatchObject({ maxInputTokens: 32000, executor: expect.objectContaining({ name: "rovara-e2e-agent" }) });
    expect(() => e2eApplicationAgentConfig({ modelRoute: route, replay: false }, replayHost())).toThrow(/model/);
  });
});
