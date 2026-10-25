import { describe, expect, it, vi } from "vitest";
import { MissingProviderSecret } from "../../packages/model-runtime/src/config.js";
import {
  ProviderCheckHttpError, bedrockModelName, bedrockThrottleSentence, checkModel, classSentence, failureFromError,
  type ModelCheckQuota,
} from "../../packages/model-runtime/src/model-check.js";
import type { QuotaClient, QuotaRow } from "../../packages/model-runtime/src/model-discovery.js";

// M1.4 Task 4.10D, tests 40 and 42: the shared single-call model check, the class it gives a failure, and a zero quota read as a limit. Nothing here touches AWS or a provider.

const SONNET = "us.anthropic.claude-sonnet-4-6";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const throttled = () => Object.assign(new Error("Too many requests, please wait before trying again."), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } });
const rows = (value: number): QuotaRow[] => [{ code: "L-SONNET46GEO", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6", value }];
const quotaClient = (value: number): QuotaClient => ({ list: async () => ({ quotas: rows(value) }) });
const deniedQuotas: QuotaClient = { list: async () => { throw Object.assign(new Error("not allowed"), { name: "AccessDeniedException" }); } };
const base = { provider: "amazon-bedrock" as const, modelId: SONNET, region: "us-east-1" };

describe("the single-call model check (test 42, INST-8)", () => {
  it("retries a throttle once after 2 s and then reads a zero quota as a limit, never as 'wait a minute'", async () => {
    const run = vi.fn().mockRejectedValue(throttled());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await checkModel(base, { run, sleep, quotas: quotaClient(0), now: () => NOW });
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
    expect(result).toMatchObject({ ok: false, class: "limit-or-rate-limited", signal: "ThrottlingException", quota: { scope: "geographic", code: "L-SONNET46GEO", tokensPerMinute: 0 } });
    const sentence = bedrockThrottleSentence({ modelId: SONNET, quota: (result as { quota: ModelCheckQuota }).quota, rerun: "run agentx init again", changeModel: "--worker-model" });
    expect(sentence).toBe("Amazon Bedrock's limit for us.anthropic.claude-sonnet-4-6 in this account is 0 tokens per minute (quota L-SONNET46GEO). Request an increase in Service Quotas, or choose another model with --worker-model");
    expect(sentence).not.toMatch(/wait a minute/);
  });

  it("names the quota and its value when it is above zero, and says 'if this repeats'", async () => {
    const result = await checkModel(base, { run: async () => { throw throttled(); }, sleep: async () => undefined, quotas: quotaClient(5_000_000), now: () => NOW });
    const quota = (result as { quota: ModelCheckQuota }).quota;
    expect(quota).toEqual({ scope: "geographic", code: "L-SONNET46GEO", tokensPerMinute: 5_000_000 });
    expect(bedrockThrottleSentence({ modelId: SONNET, quota, rerun: "run agentx init again", changeModel: "--worker-model" }))
      .toBe("Amazon Bedrock throttled the check of us.anthropic.claude-sonnet-4-6; if this repeats, check Service Quotas → Amazon Bedrock (quota L-SONNET46GEO: 5000000 tokens per minute)");
  });

  it("keeps today's text and adds 'could not read the quota' when the lookup is denied", async () => {
    const result = await checkModel(base, { run: async () => { throw throttled(); }, sleep: async () => undefined, quotas: deniedQuotas, now: () => NOW });
    const quota = (result as { quota: ModelCheckQuota }).quota;
    expect(quota.tokensPerMinute).toBeNull();
    const sentence = bedrockThrottleSentence({ modelId: SONNET, quota, rerun: "run agentx init again", changeModel: "--worker-model" });
    expect(sentence).toContain("Bedrock throttled the check of us.anthropic.claude-sonnet-4-6; wait a minute and run agentx init again");
    expect(sentence).toContain("Rovara could not read the quota");
  });

  it("does not look at quota when the second try succeeds, and when no quota client was given the quota stays unattempted", async () => {
    const run = vi.fn().mockRejectedValueOnce(throttled()).mockResolvedValueOnce(undefined);
    const listed = vi.fn();
    expect(await checkModel(base, { run, sleep: async () => undefined, quotas: { list: listed }, now: () => NOW })).toEqual({ ok: true });
    expect(listed).not.toHaveBeenCalled();
    const without = await checkModel(base, { run: async () => { throw throttled(); }, sleep: async () => undefined, now: () => NOW });
    expect(without).toMatchObject({ ok: false, class: "limit-or-rate-limited" });
    expect((without as { quota?: unknown }).quota).toBeUndefined();
    expect(bedrockThrottleSentence({ modelId: SONNET, quota: undefined, rerun: "run agentx init again", changeModel: "--worker-model" })).toBe(`Bedrock throttled the check of ${SONNET}; wait a minute and run agentx init again`);
  });

  it("reads the quota that applies to the route's scope: a global profile reads the global quota, and a bare id reads none", async () => {
    const both: QuotaRow[] = [
      { code: "L-GEO", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6", value: 7 },
      { code: "L-GLO", name: "Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6", value: 0 },
    ];
    const global = await checkModel({ ...base, modelId: "global.anthropic.claude-sonnet-4-6" }, { run: async () => { throw throttled(); }, sleep: async () => undefined, quotas: { list: async () => ({ quotas: both }) }, now: () => NOW });
    expect((global as { quota: ModelCheckQuota }).quota).toEqual({ scope: "global", code: "L-GLO", tokensPerMinute: 0 });
    const bare = await checkModel({ ...base, modelId: "anthropic.claude-sonnet-4-6" }, { run: async () => { throw throttled(); }, sleep: async () => undefined, quotas: { list: async () => ({ quotas: both }) }, now: () => NOW });
    expect((bare as { quota: ModelCheckQuota }).quota.tokensPerMinute).toBeNull();
  });

  it("derives the quota name from a model id without its geography, date or version", () => {
    expect(bedrockModelName("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic.claude-haiku-4-5");
    expect(bedrockModelName("global.anthropic.claude-sonnet-4-6")).toBe("anthropic.claude-sonnet-4-6");
  });
});

describe("the class a failed check carries (test 40)", () => {
  it("gives each provider's failures the matching class from the status or name, never from message text", () => {
    const named = (name: string, status?: number) => Object.assign(new Error("Anything the provider said about sk-ant-secret"), { name, ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }) });
    expect(failureFromError("amazon-bedrock", named("ThrottlingException", 429))).toEqual({ class: "limit-or-rate-limited", signal: "ThrottlingException" });
    expect(failureFromError("amazon-bedrock", named("AccessDeniedException", 403))).toEqual({ class: "key-rejected", signal: "AccessDeniedException" });
    expect(failureFromError("amazon-bedrock", named("ResourceNotFoundException", 404))).toEqual({ class: "model-not-found", signal: "ResourceNotFoundException" });
    expect(failureFromError("anthropic", new ProviderCheckHttpError(401, "the API key was refused"))).toEqual({ class: "key-rejected", signal: null });
    expect(failureFromError("openai", new ProviderCheckHttpError(404, "the model is not available"))).toEqual({ class: "model-not-found", signal: null });
    expect(failureFromError("openrouter", new ProviderCheckHttpError(402, "out of credits"))).toEqual({ class: "limit-or-rate-limited", signal: null });
    expect(failureFromError("openai", new ProviderCheckHttpError(503, "down"))).toEqual({ class: "provider-outage", signal: null });
  });

  it("reads a network code (also under a cause) as unreachable, a deadline as an outage, a missing secret as key-rejected, and a model outside the catalog as model-not-found", () => {
    expect(failureFromError("openai", Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toEqual({ class: "unreachable", signal: "ENOTFOUND" });
    expect(failureFromError("amazon-bedrock", Object.assign(new Error("did not answer"), { name: "TimeoutError" }))).toEqual({ class: "provider-outage", signal: "timeout" });
    expect(failureFromError("openai", new MissingProviderSecret("openai"))).toEqual({ class: "secret-unreadable", signal: "secret-unreadable" });
    expect(failureFromError("anthropic", Object.assign(new Error("Anthropic model is not in the installed Pi catalog; choose a supported model"), { code: "CONFIG_INVALID" }))).toEqual({ class: "not-in-catalog", signal: "not-in-catalog" });
    expect(failureFromError("openai", new Error("something else"))).toEqual({ class: "unknown", signal: null });
  });

  it("returns the class, the signal and (for the caller's own wording) the error, and keeps provider text out of the sentence", async () => {
    const secretText = "Bearer sk-live-should-never-be-kept";
    const result = await checkModel({ provider: "anthropic", modelId: "claude-sonnet-4-6", region: "us-east-1" }, { run: async () => { throw Object.assign(new Error(secretText), { status: 401 }); }, now: () => NOW });
    expect(result).toMatchObject({ ok: false, class: "key-rejected", signal: null });
    const sentence = classSentence({ provider: "anthropic", modelId: "claude-sonnet-4-6", class: "key-rejected" });
    expect(sentence).toBe("Anthropic refused the key for claude-sonnet-4-6; check the key, and that it may use this model.");
    expect(JSON.stringify(sentence)).not.toContain("sk-live");
  });

  it("has one fixed sentence per class, each naming the provider and the model", () => {
    for (const cls of ["limit-or-rate-limited", "key-rejected", "model-not-found", "unreachable", "request-rejected", "provider-outage", "unknown", "secret-unreadable", "not-in-catalog"] as const) {
      const sentence = classSentence({ provider: "openai", modelId: "gpt-5.4", class: cls });
      expect(sentence).toContain("OpenAI");
      expect(sentence).toContain("gpt-5.4");
      expect(sentence).not.toMatch(/wait a minute/);
    }
  });
});
