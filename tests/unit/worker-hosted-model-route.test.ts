import { runPriceFor } from "../support/hosted-run-price.js";
// Hosted setup/wiki require the selected proxy adapter as well as the trusted route.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT, SETUP_RUN_REFUSED_MESSAGES, agentXError, type InvocationModelRoute } from "../../packages/contracts/src/index.js";
import { createModelPrices } from "../../packages/broker/src/core/cost/price-table.js";
import { createHostedMetering } from "../../packages/broker/src/core-host/hosted-modules.js";
import { readGatewayModelAccess } from "../../packages/broker/src/core-host/gateway-model-access.js";
import { listPricesPerMillion } from "../../packages/model-runtime/src/catalog.js";
import { routeUsageIdentity } from "../../packages/model-runtime/src/index.js";
import { modelSpendIsMetered, setupModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { runSetupAgentInvocation } from "../../packages/worker/src/setup-agent-invocation.js";
import { runWikiBuildInvocation } from "../../packages/worker/src/wiki-build-invocation.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "hosted-route-")); roots.push(dir); return dir; };

const ROUTE = { alias: "claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" } as const;
/** A route whose catalog name no installed catalog knows: the ledger has no price for it. */
const UNKNOWN_ROUTE = { alias: "unlisted", api: "anthropic-messages", catalog: "unlisted" } as const;
const PRICED = { provider: "rovara-route", modelId: "claude-sonnet-4-6" };
const IMAGE = { AGENTX_SANDBOX_IMAGE: "i@sha256:" + "b".repeat(64) };
const PROXY = { AGENTX_MODEL_PROXY_URL: "https://proxy.test" };
const OP = "11111111-1111-4111-8111-111111111111";
const REFUSED_PROXY = agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_REFUSED_MESSAGES.noModelProxy).message;
const WIKI_REFUSED_PROXY = "this install has no model proxy";

describe("modelSpendIsMetered", () => {
  it("preserves the laptop gate and refuses a route without actual-session evidence", () => {
    expect(modelSpendIsMetered({ ...PROXY }, {})).toBe(true);
    expect(modelSpendIsMetered({}, { modelRoute: ROUTE })).toBe(false);
    expect(modelSpendIsMetered({}, {})).toBe(false);
    expect(modelSpendIsMetered({ AGENTX_MODEL_PROXY_URL: "" }, {})).toBe(false);
  });
});

/** A real one-commit repository, so the run's own repository checks pass and the money checks are what decide. */
async function repository() {
  const root = await temp();
  const directory = join(root, "repo/web");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), "{}\n");
  const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=a@b.c", "-c", "user.name=x", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "one");
  return { root, commit: (await git("rev-parse", "HEAD")).stdout.trim() };
}

describe("hosted setup run (no env proxy, a model route)", () => {
  async function attempt(environment: NodeJS.ProcessEnv, payload: Record<string, unknown>, model = PRICED) {
    const { root, commit } = await repository();
    const calls: string[][] = [];
    const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); } };
    const invocation = { operationId: OP, projectRevision: 1, payload: { conversationId: "c", setupAgent: { limits: SETUP_AGENT_LIMITS_DEFAULT, commits: [{ repository: "web", commit }] }, ...payload } } as never;
    const session = payload.modelRoute === undefined ? {} : await resolveTaskSessionModel({ modelRoute: payload.modelRoute as InvocationModelRoute }, undefined, environment, undefined, { baseUrl: "https://broker.test", apiKey: "test-key", runPrice: async () => (payload.modelRoute as InvocationModelRoute).alias === "unlisted" ? undefined : runPriceFor((payload.modelRoute as InvocationModelRoute).alias) });
    let message = "";
    try { await runSetupAgentInvocation(invocation, { ...session, rootPath: root, model, eventSink: async () => undefined, setupAgent: async () => ({}), docker, environment }, { repositories: [{ name: "web", path: "repo/web", resolvedCommit: commit, defaultBranch: "main", resolvedAt: "", completedAt: "" }] }, root); } catch (error) { message = (error as Error).message; }
    return { message, calls };
  }

  it("proceeds past the money check with a model route and no env var: the next refusal is the price, not the proxy", async () => {
    const unpriced = await attempt({ ...IMAGE }, { modelRoute: UNKNOWN_ROUTE }, { provider: "rovara-route", modelId: "unlisted" });
    expect(unpriced.message).toContain("does not know this model's price");
    // With a priced model it goes on to build the run (it reaches Docker); it is never refused for the proxy.
    const priced = await attempt({ ...IMAGE }, { modelRoute: ROUTE });
    expect(priced.message).not.toBe(REFUSED_PROXY);
    expect(priced.message).not.toBe(agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_REFUSED_MESSAGES.noModelPrice).message);
  });

  it("refuses with neither the env var nor a model route, before any container", async () => {
    const result = await attempt({ ...IMAGE }, {});
    expect(result.message).toBe(REFUSED_PROXY);
    expect(result.calls).toEqual([]);
    expect((await attempt({ ...IMAGE, AGENTX_MODEL_PROXY_URL: "" }, {})).message).toBe(REFUSED_PROXY);
  });

  it("laptop path unchanged: the env var alone passes the money check (the price refusal follows for an unlisted model)", async () => {
    const result = await attempt({ ...IMAGE, ...PROXY }, {}, { provider: "x", modelId: "unlisted" });
    expect(result.message).toBe(agentXError("RUNTIME_UNAVAILABLE", SETUP_RUN_REFUSED_MESSAGES.noModelPrice).message);
  });
});

describe("hosted wiki build (no env proxy, a model route)", () => {
  async function attempt(environment: NodeJS.ProcessEnv, payload: Record<string, unknown>, model = PRICED) {
    const root = await temp();
    const callbacks: unknown[] = [];
    const invocation = { operationId: OP, projectRevision: 1, payload: { conversationId: "c", wikiBuild: { limits: { pages: 1, budgetCents: 100, wallClockMin: 1, pageReserveCents: 10 }, pins: [{ repo: "api", commit: "a".repeat(40) }] }, ...payload } } as never;
    const session = payload.modelRoute === undefined ? {} : await resolveTaskSessionModel({ modelRoute: payload.modelRoute as InvocationModelRoute }, undefined, environment, undefined, { baseUrl: "https://broker.test", apiKey: "test-key", runPrice: async () => (payload.modelRoute as InvocationModelRoute).alias === "unlisted" ? undefined : runPriceFor((payload.modelRoute as InvocationModelRoute).alias) });
    let message = "";
    try {
      await runWikiBuildInvocation(invocation, { ...session, rootPath: root, model, eventSink: async () => undefined, taskShell: { kind: "local" }, environment,
        wikiBuild: async (body) => { callbacks.push(body); throw new Error("callback-reached"); } }, { repositories: [{ name: "api", path: "repo/api", resolvedCommit: "a".repeat(40) }] } as never, root);
    } catch (error) { message = (error as Error).message; }
    return { message, callbacks };
  }

  it("with a model route and no env var the run starts: it reaches the broker's callback, never refused for the proxy", async () => {
    const result = await attempt({}, { modelRoute: ROUTE });
    expect(result.message).not.toContain(WIKI_REFUSED_PROXY);
    expect(result.callbacks.length).toBeGreaterThan(0);
  });

  it("refuses with neither, and calls nothing", async () => {
    const result = await attempt({}, {});
    expect(result.message).toContain(WIKI_REFUSED_PROXY);
    expect(result.callbacks).toEqual([]);
  });

  it("laptop path unchanged: the env var alone starts the run", async () => {
    const result = await attempt({ ...PROXY }, {});
    expect(result.message).not.toContain(WIKI_REFUSED_PROXY);
    expect(result.callbacks.length).toBeGreaterThan(0);
  });

  it("an unpriced model still does not start, route or not", async () => {
    const result = await attempt({}, { modelRoute: UNKNOWN_ROUTE }, { provider: "rovara-route", modelId: "unlisted" });
    expect(result.callbacks).toEqual([]);
    expect(result.message).toContain("RUNTIME_UNAVAILABLE");
  });
});

describe("the hosted route alias is priced (the next blocker would be noModelPrice)", () => {
  it.each(["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5", "claude-sonnet-5-5"])("alias %s on the route provider has a setup price", (alias) => {
    expect(setupModelPrice({ provider: "rovara-route", modelId: alias })).toBeDefined();
  });
});

// Hotfix 0.5.33: a routed run is priced as the broker's ledger prices it (the price must never be below what is charged).
describe("setupModelPrice on a hosted route (the ledger's price, not a name match)", () => {
  // The exact staging shape: CoreAgentModel zai.glm-5, built by the broker's own route reader (gateway-model-access.ts), and the task model the worker builds from it (task-model.ts routedTaskModel).
  const read = readGatewayModelAccess({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.com", ROVARA_CORE_AGENT_MODEL: "zai.glm-5" });
  const STAGING_ROUTE = (read as { route: { alias: string; api: "anthropic-messages"; catalog: string } }).route;
  const STAGING_MODEL = { provider: "rovara-route", modelId: "zai.glm-5" };

  it("the staging route has the expected shape", () => {
    expect(STAGING_ROUTE).toEqual({ alias: "zai.glm-5", api: "anthropic-messages", catalog: "zai.glm-5" });
  });

  it("CASE: without the route the staging model has NO price (the bug: canonical zai-glm-5 matches no catalog entry)", () => {
    expect(setupModelPrice(STAGING_MODEL)).toBeUndefined();
  });

  it("with the route it is priced, and it equals what the hosted meter charges per million tokens for that route", async () => {
    const price = setupModelPrice(STAGING_MODEL, STAGING_ROUTE);
    expect(price).toMatchObject({ inputPerMTok: 1, outputPerMTok: 3.2 });
    // The ledger: the identity the worker reports for the route, through the hosted meter's own price table (cap price and recorded price).
    const prices = createModelPrices({ providers: () => [], catalog: listPricesPerMillion });
    const identity = routeUsageIdentity(STAGING_ROUTE);
    expect(identity).toEqual({ provider: "amazon-bedrock", modelId: "zai.glm-5" });
    for (const found of [prices.find(identity), prices.findCap(identity)]) {
      expect(found?.price.inputMicrosPerMillionTokens).toBe(Math.round(price!.inputPerMTok * 1_000_000));
      expect(found?.price.outputMicrosPerMillionTokens).toBe(Math.round(price!.outputPerMTok * 1_000_000));
    }
    // And the meter itself: one million input and one million output tokens cost exactly the setup price's total.
    const cost = await createHostedMetering().price({ provider: identity.provider, modelId: identity.modelId, tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } });
    expect(cost).not.toBeNull();
    expect(cost!.micros).toBe(Math.round((price!.inputPerMTok + price!.outputPerMTok) * 1_000_000));
  });

  it("is never below the cheaper OpenRouter entry for the same name (that was the under-price risk)", () => {
    expect(setupModelPrice(STAGING_MODEL, STAGING_ROUTE)!.inputPerMTok).toBeGreaterThan(0.6);
    expect(setupModelPrice(STAGING_MODEL, STAGING_ROUTE)!.outputPerMTok).toBeGreaterThan(1.9);
  });

  it("an unknown routed model has no price (refused, never zero or guessed)", () => {
    expect(setupModelPrice({ provider: "rovara-route", modelId: "unlisted" }, UNKNOWN_ROUTE)).toBeUndefined();
  });

  it("non-routed pricing is unchanged", () => {
    expect(setupModelPrice({ provider: "rovara-route", modelId: "claude-sonnet-4-6" })).toBeDefined();
    expect(setupModelPrice({ provider: "openrouter", modelId: "z-ai/glm-5" })).toEqual({ inputPerMTok: 0.6, outputPerMTok: 1.9 });
    // A model that is not on the route provider ignores a route.
    expect(setupModelPrice({ provider: "amazon-bedrock", modelId: "global.zai.glm-5.3" }, STAGING_ROUTE)).toEqual(setupModelPrice({ provider: "amazon-bedrock", modelId: "global.zai.glm-5.3" }));
  });
});
