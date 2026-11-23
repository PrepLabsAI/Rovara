import { SLACK_MODEL_WORDS, type OrgId } from "@agentx/contracts";
import { hostedAnswersModel } from "../../packages/broker/src/core-host/gateway-answers.js";
import { hostedLessonsLearning } from "../../packages/broker/src/core-host/hosted-learning.js";
import { askSlackModelAccessForIdentity } from "../../packages/broker/src/aws/slack-model-access.js";
import { resolveTurnModels, turnRefusalWords } from "../../packages/slack-service/src/slack-company-models.js";
import { signingWorld } from "../support/model-gateway.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { describe, expect, it, vi } from "vitest";
import { operationModelProxy } from "../../packages/worker/src/design-review-sessions.js";
import { invocationModelPrice } from "../../packages/worker/src/setup-agent-price.js";
import { assertGatewayRunPrices } from "../../packages/cli/src/deploy/gateway-price-preflight.js";
const route = { alias: "company-alias", catalog: "zai.glm-5", api: "anthropic-messages" } as const;
const price = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", model: route.alias, provider: "bedrock", sourceId: "operator-ai", connectionRevision: "r1", catalogModel: "zai.glm-5", snapshotHash: "a".repeat(64), snapshotVersion: 7, inputUsdPerMillion: 10,
  outputUsdPerMillion: 40, cacheWriteUsdPerMillion: 30, cacheReadUsdPerMillion: 2, expiresAt: Date.now() + 300_000 };
const answer = (runPrice: unknown) => ({ baseUrl: "https://gateway.example", apiKey: "fixture-key", expiresAt: Date.now() + 900_000, runPrice });
function proxy(runPrice: unknown, fetcher?: typeof fetch) {
  return operationModelProxy({ payload: { modelRoute: route, workflowMode: "WIKI_BUILD" }, controlPlaneUrl: "https://broker.example", capability: "fixture", proxyUrl: undefined,
    fetch: fetcher ?? (async () => Response.json(answer(runPrice))) })!;
}
describe("hosted run price authority", () => {
  it("gets the gateway's per-class rates (not one flattened input rate) through the exact access source used by the adapter, above catalog rates", async () => {
    const read = vi.fn(async () => Response.json(answer(price)));
    const selected = proxy(price, read);
    expect(await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, selected)).toEqual({ inputPerMTok: 10, outputPerMTok: 40, cacheReadPerMTok: 2, cacheWritePerMTok: 30 });
    const request = { ...selected };
    expect(await (request.apiKey as () => Promise<string>).call(request)).toBe("fixture-key");
    expect(request.baseUrl).toBe("https://gateway.example");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, { ...price, model: "wrong" }, { ...price, inputUsdPerMillion: 0 }, { ...price, outputUsdPerMillion: Infinity },
    { ...price, cacheWriteUsdPerMillion: -1 }, { ...price, cacheReadUsdPerMillion: NaN }, { ...price, snapshotVersion: 0 }, { ...price, expiresAt: 1 }])("refuses absent or invalid authority before a model session", async (bad) => {
    await expect(invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, proxy(bad))).rejects.toThrow("model's price");
  });
  it("retains laptop catalog lookup", async () => {
    expect(await invocationModelPrice({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" })).toEqual({ inputPerMTok: 11, outputPerMTok: 55 });
  });
});
describe("gateway-first installation", () => {
  it.each([{}, { runPrice: { version: 1, snapshotVersion: 7 } }, { runPrice: { version: 1, snapshotVersion: 0 } }, { runPrice: { version: 2, snapshotVersion: 7 } }])("blocks old, empty or incompatible gateway readiness", async (body) => {
    await expect(assertGatewayRunPrices("https://gateway.example", async () => Response.json(body))).rejects.toThrow("gateway must serve run prices");
  });
  it("accepts a gateway serving a versioned price snapshot", async () => {
    const read = vi.fn(async () => Response.json({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 7 } }));
    await assertGatewayRunPrices("https://gateway.example", read);
    expect(read.mock.calls).toHaveLength(1);
  });
});

describe("signed gateway price read", () => {
  it("signs the authenticated company and rejects mismatched company/model/expiry before forwarding", async () => {
    const { runPriceReader } = await import("../../packages/broker/src/core-host/run-price-http.js");
    const { signingWorld } = await import("../support/model-gateway.js");
    const signed = signingWorld();
    for (const change of [{}, { companyId: "org_bbbbbbbbbbbbbbbbbbbb" }, { model: "foreign" }, { expiresAt: 1 }, { cacheReadUsdPerMillion: -1 }]) {
      const asked: string[] = [];
      const read = runPriceReader({ gatewayUrl: "https://gateway.example", issuer: "https://install.example/v1/auth", signer: signed.signer,
        fetch: async (url, init) => {
          asked.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
          const token = new Headers(init?.headers).get("authorization")!.slice(7);
          const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { cid: string; aud: string };
          expect(claims).toMatchObject({ cid: price.companyId, aud: "rovara-model-gateway-rate-quote" });
          return Response.json({ runPrice: { ...price, ...change } });
        } });
      const answer = await read(price.companyId, route.alias);
      expect(answer).toEqual(Object.keys(change).length === 0 ? price : undefined);
      expect(asked).toEqual([`https://gateway.example/v1/service/companies/${price.companyId}/rate-quote?model=${route.alias}&runPrice=1`]);
    }
  });
});


it.each(["SETUP_AGENT", "WIKI_BUILD"])("preserves local routed %s catalog pricing and HTTP access only with trusted local context", async workflowMode => {
  const fetcher = async () => Response.json({ baseUrl: "http://broker-relay:3000", apiKey: "local-fixture", expiresAt: Date.now() + 900_000 });
  const input = { payload: { workflowMode, modelRoute: route }, proxyUrl: "http://boot-relay:3000", controlPlaneUrl: "http://broker-relay:3000", capability: "fixture", fetch: fetcher };
  const local = operationModelProxy({ ...input, environment: { AGENTX_ENVIRONMENT_KIND: "local" } })!;
  expect(await invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, local)).toMatchObject({ inputPerMTok: 1, outputPerMTok: 3.2 });
  expect(await (local.apiKey as () => Promise<string>).call(local)).toBe("local-fixture");
  expect(local.baseUrl).toBe("http://broker-relay:3000");
  const hosted = operationModelProxy({ ...input, environment: { AGENTX_ENVIRONMENT_KIND: "named", AGENTX_RUNTIME: "ec2" } })!;
  await expect(invocationModelPrice({ provider: "rovara-route", modelId: route.alias }, route, hosted)).rejects.toThrow("proxy address");
});

// P1-1/P2-1: real hosted quote readers, token mints and callers. The external
// gateway is a double here; its saved-source policy and billing have separate tests.
describe("hosted purpose callers preserve the selected source", () => {
  const company = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const model = "claude-sonnet-5";
  const gateway = "https://gateway.example";
  const issuer = "https://install-a.example/v1/auth";
  const env = { ROVARA_CORE_MODEL_GATEWAY_URL: gateway, ROVARA_CORE_AGENT_MODEL: model, ROVARA_CORE_ANSWERS_MODEL: model, ROVARA_CORE_LEARNING_MODEL: model };
  const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
  const sources = [
    ["anthropic_key", "anthropic", true],
    ["bedrock_byo", "bedrock", false],
    ["openai_key", "openai", false],
    ["custom_endpoint", "anthropic", false],
    ["openrouter_key", "openrouter", false],
  ] as const;
  const purposes = [
    ["answers", "/v1/answers/messages", "rovara-answers-call", 1],
    ["learning", "/v1/learning/messages", "rovara-lessons-learning-call", 1],
    ["slack", "/v1/answers/v1/messages", "rovara-answers-call", 2],
  ] as const;
  const stream = () => new Response([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

  for (const [purpose, path, step, quoteReads] of purposes) {
    it.each(sources)(`${purpose} with %s keeps the source snapshot and propagates refusal without fallback`, async (source, provider, supported) => {
      const now = Date.now();
      const grant = { ...runPriceFor(model, now), companyId: company, provider, sourceId: `company-${source}`, connectionRevision: "own-key-revision-2", catalogModel: model };
      const signed = signingWorld();
      const tokens = () => ({ signer: signed.signer, issuer });
      const reads: string[] = [];
      const posts: Array<{ url: string; claims: Record<string, unknown> }> = [];
      const fetchImpl: typeof fetch = async (url, init) => {
        const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (init?.method === "GET") {
          reads.push(address);
          expect(decode(new Headers(init.headers).get("authorization")!.slice(7))).toMatchObject({ cid: company, aud: "rovara-model-gateway-rate-quote" });
          return Response.json({ runPrice: grant });
        }
        expect(init?.method).toBe("POST");
        posts.push({ url: address, claims: decode(new Headers(init?.headers).get("x-api-key")!) });
        if (!supported) return Response.json({ error: { type: purpose === "learning" ? "lessons_paused" : "answers_paused", message: "Selected source cannot serve this purpose yet." } }, {
          status: 403, headers: { [purpose === "learning" ? "x-rovara-lessons-pause" : "x-rovara-answers-pause"]: "no_provider" },
        });
        return purpose === "slack" ? stream() : Response.json({ model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 2 } });
      };
      if (purpose === "answers") {
        const port = hostedAnswersModel(env, tokens, fetchImpl)!(company)!;
        const session = await port.open({ companyId: company, project: "alpha", personId: "ada", answerId: `a${"1".repeat(31)}`, ceilingCents: 15 });
        const complete = session.complete({ system: "rules", transcript: "question", maxOutputTokens: 1_500, remainingCents: 15, signal: new AbortController().signal });
        if (supported) expect((await complete).text).toBe("ok");
        else await expect(complete).rejects.toMatchObject({ reason: "not_set_up" });
        await session.finish({ tokens: 0 });
      } else if (purpose === "learning") {
        const port = hostedLessonsLearning(env, tokens, { fetch: fetchImpl, now: () => now })(company)!;
        const complete = port.model.complete({ purpose: "reflect", system: "rules", user: "question", maxOutputTokens: 1_500, workspaceId: company, project: "alpha", budgetUsd: 0.15 });
        if (supported) expect((await complete).text).toBe("ok");
        else await expect(complete).rejects.toMatchObject({ code: "no_provider" });
      } else {
        const identity = { slack: { thread: { teamId: "T0AAAAAAAAA", channelId: "C0123456789", threadTs: "1695500000.000001" }, binding: { teamId: "T0AAAAAAAAA", channelId: "C0123456789", projectName: "alpha", updatedAt: "2026-11-21T00:00:00.000Z" } } };
        const models = await resolveTurnModels({ controlPlaneUrl: "https://control.example", signedFetch: async () => Response.json(await askSlackModelAccessForIdentity({ companyMode: true, companyOf: async () => company, env, taskTokens: tokens, fetch: fetchImpl, now: () => now }, identity)), fetch: fetchImpl });
        if (models.kind !== "gateway") throw new Error("gateway expected");
        const selected = models.models.runtime.getModel(models.models.model.provider, models.models.model.modelId)!;
        const result = await models.models.runtime.completeSimple(selected, { messages: [{ role: "user", content: "question", timestamp: 1 }] });
        expect(result.stopReason).toBe(supported ? "stop" : "error");
        expect(turnRefusalWords(models)).toBe(supported ? undefined : SLACK_MODEL_WORDS.noProvider);
      }
      expect(reads).toEqual(Array<string>(quoteReads).fill(`${gateway}/v1/service/companies/${company}/rate-quote?model=${model}&runPrice=1`));
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe(`${gateway}${path}`);
      expect(posts[0]!.claims).toMatchObject({ cid: company, stp: step, mdl: [model], runPrice: grant });
    });
  }
});
