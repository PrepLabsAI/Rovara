// DEC 228e: the product route accepts and charges Gemini audio and video input, priced per model from the price rows.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { dearestMediaRates, mediaRatesOf, validMediaRates, validModelMediaRates, type MediaPriceSource, type MediaRates } from "../../packages/model-gateway/src/media-price.js";
import { estimateCall, mediaPriced, usageCost } from "../../packages/model-gateway/src/estimate.js";
import { settleAmount, validUsage } from "../../packages/model-gateway/src/reported-cost.js";
import { GeminiUsageCollector, geminiUsage, guardGemini, parseGeminiPath, PRODUCT_AUDIO_REFUSED, PRODUCT_MEDIA_FILE_REFUSED, PRODUCT_TOOL_REFUSED, MEDIA_TOKENS_MAX } from "../../packages/model-gateway/src/product-gemini.js";
import { fetchLiteLLM } from "../../packages/model-gateway/src/price-sources.js";
import { InMemoryPriceSnapshotStore, validSnapshot, type PriceSnapshot } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { PriceRefresher } from "../../packages/model-gateway/src/price-refresh.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { runCorrections } from "../../packages/model-gateway/src/correction.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { DynamoMeter } from "../../packages/model-gateway/src/dynamo-meter.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { now } from "./model-gateway-fixture.js";
import { geminiAnswer, productCall, productGateway, productScope, streamPath } from "./model-gateway-product-fixture.js";

const NOW = 1_800_000_000_000;
const gem = (extra: Record<string, unknown> = {}) => ({ litellm_provider: "gemini", mode: "chat", input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6, ...extra });

describe("media prices from the LiteLLM rows", () => {
  it("a listed audio rate (dearest of standard/batch/flex, never priority), cache and output audio rates", () => {
    const r = mediaRatesOf(gem({ input_cost_per_audio_token: 1e-6, input_cost_per_audio_token_flex: 5e-7, input_cost_per_audio_token_priority: 9e-6, cache_read_input_audio_token_cost: 1e-7, output_cost_per_audio_token: 2e-5, supports_audio_input: true }), "gemini", "gemini/gemini-2.5-flash", NOW);
    expect(r).toEqual({ provider: "gemini", model: "gemini/gemini-2.5-flash", audioInput: 1_000_000, audioCacheRead: 100_000, audioOutput: 20_000_000 });
  });
  it("a supported modality with no rate of its own is billed at the text input rate; an explicit false or no flag leaves it unpriced", () => {
    expect(mediaRatesOf(gem({ supported_modalities: ["text", "image", "audio", "video"] }), "gemini", "m", NOW)).toEqual({ provider: "gemini", model: "m", audioInput: "input", videoInput: "input" });
    expect(mediaRatesOf(gem({ supports_audio_input: true, supports_video_input: true }), "gemini", "m", NOW)).toEqual({ provider: "gemini", model: "m", audioInput: "input", videoInput: "input" });
    expect(mediaRatesOf(gem({ supported_modalities: ["text", "audio", "video"], supports_audio_input: false, input_cost_per_audio_token: 1e-6 }), "gemini", "m", NOW)).toEqual({ provider: "gemini", model: "m", videoInput: "input" });
    expect(mediaRatesOf(gem(), "gemini", "m", NOW)).toBeUndefined();
  });
  it("never $0 and never a guess: zero, negative, text, out-of-range or per-second prices leave the modality unpriced", () => {
    for (const bad of [{ input_cost_per_audio_token: 0 }, { input_cost_per_audio_token: -1 }, { input_cost_per_audio_token: "1e-6" }, { input_cost_per_audio_token: 1e-6, input_cost_per_audio_token_batches: 0 }, { input_cost_per_audio_token: 5 }, { input_cost_per_audio_per_second: 0.0001 }, { input_cost_per_audio_per_second_above_128k_tokens: 0 }]) {
      expect(mediaRatesOf(gem({ supports_audio_input: true, ...bad }), "gemini", "m", NOW)?.audioInput).toBeUndefined();
    }
    expect(mediaRatesOf(gem({ supports_video_input: true, input_cost_per_video_per_second: 0 }), "gemini", "m", NOW)).toBeUndefined();
    // A long-context media tier isn't read: the modality is unpriced rather than charged at the base rate (REVIEW-1 L1).
    expect(mediaRatesOf(gem({ input_cost_per_audio_token: 1e-6, input_cost_per_audio_token_above_200k_tokens: 2e-6 }), "gemini", "m", NOW)).toBeUndefined();
  });
  it("only Gemini chat rows that are not deprecated and have a base input rate", () => {
    const audio = { input_cost_per_audio_token: 1e-6 };
    expect(mediaRatesOf(gem(audio), "openai", "m", NOW)).toBeUndefined();
    expect(mediaRatesOf(gem({ ...audio, mode: "embedding" }), "gemini", "m", NOW)).toBeUndefined();
    expect(mediaRatesOf(gem({ ...audio, deprecation_date: "2020-01-01" }), "gemini", "m", NOW)).toBeUndefined();
    expect(mediaRatesOf(gem({ ...audio, deprecation_date: "soon" }), "gemini", "m", NOW)).toBeUndefined();
    expect(mediaRatesOf(gem({ ...audio, input_cost_per_token: 0 }), "gemini", "m", NOW)).toBeUndefined();
    expect(mediaRatesOf(gem({ ...audio, deprecation_date: "2099-01-01" }), "gemini", "m", NOW)?.audioInput).toBe(1_000_000);
  });
  it("validators refuse unknown fields, wrong providers, zero rates and empty rows", () => {
    expect(validMediaRates({ audioInput: "input" })).toBe(true);
    for (const bad of [{}, { audioInput: 0 }, { audioInput: "text" }, { videoInput: 1.5 }, { audioCacheRead: "input" }, { audioInput: 1, extra: 1 }]) expect(validMediaRates(bad)).toBe(false);
    expect(validModelMediaRates({ provider: "gemini", model: "m", audioInput: 1 })).toBe(true);
    expect(validModelMediaRates({ provider: "openai", model: "m", audioInput: 1 })).toBe(false);
    expect(validModelMediaRates({ provider: "gemini", model: "", audioInput: 1 })).toBe(false);
  });
  it("several rows for one identity: each field at its dearest; a number beats 'input'", () => {
    expect(dearestMediaRates([{ audioInput: "input" }, { audioInput: 2, videoInput: "input" }, { audioInput: 3, audioCacheRead: 1 }])).toEqual({ audioInput: 3, videoInput: "input", audioCacheRead: 1 });
    expect(dearestMediaRates([])).toBeUndefined();
  });
  it("the fetch keeps the media rows, the refresh saves them, the snapshot validates them and the source finds them by identity", async () => {
    const litellm = Buffer.from(JSON.stringify({
      "gemini/gemini-2.5-flash": gem({ input_cost_per_audio_token: 1e-6, supports_audio_input: true }), "gemini-2.5-flash": gem({ input_cost_per_audio_token: 1.2e-6 }),
      "gemini/gemini-2.5-pro": gem({ supported_modalities: ["audio", "video"] }), "gemini/gemini-plain": gem(), "gpt-4o-audio": { ...gem({ input_cost_per_audio_token: 1e-6 }), litellm_provider: "openai" },
    }));
    const store = new InMemoryPriceSnapshotStore(); const prices = new SnapshotPriceSource(store);
    const fetched = await fetchLiteLLM({ get: async () => ({ status: 200, body: litellm }) }, { minModels: 1, now: NOW });
    expect(fetched.ok && fetched.media?.map((m) => m.model)).toEqual(["gemini/gemini-2.5-flash", "gemini-2.5-flash", "gemini/gemini-2.5-pro"]);
    await new PriceRefresher({ store, prices, litellm: async () => fetched, aws: async () => ({ ok: false, reason: "not in this test" }) }).run(NOW);
    const saved = (await store.load())!;
    expect(saved.sources.litellm?.media).toHaveLength(3);
    expect(prices.mediaFor("gemini", "gemini-2.5-flash")).toEqual({ audioInput: 1_200_000 });
    expect(prices.mediaFor("gemini", "gemini-2.5-pro")).toEqual({ audioInput: "input", videoInput: "input" });
    expect(prices.mediaFor("gemini", "gemini-plain")).toBeUndefined();
    expect(prices.mediaFor("openai", "gpt-4o-audio")).toBeUndefined();
    const bad = (media: unknown): PriceSnapshot => ({ ...saved, sources: { ...saved.sources, litellm: { ...saved.sources.litellm!, media } } }) as PriceSnapshot;
    expect(validSnapshot(bad([{ provider: "gemini", model: "x", audioInput: 0 }]))).toBe(false);
    expect(validSnapshot(bad([{ provider: "gemini", model: "x", audioInput: 1 }, { provider: "gemini", model: "x", audioInput: 2 }]))).toBe(false);
    expect(validSnapshot(bad("x"))).toBe(false);
    expect(validSnapshot({ ...saved, sources: { ...saved.sources, aws: { fetchedAt: NOW, count: 0, entries: [], media: [] } } })).toBe(false);
    expect(validSnapshot(bad([{ provider: "gemini", model: "x", audioInput: 1 }]))).toBe(true);
  });
});

const path = parseGeminiPath("/v1/product/gemini/v1beta/models/gemini-2.5-flash:generateContent", "")!;
const limits = { maxOutputTokens: () => 1000 };
const headers = { "content-type": "application/json" };
const noMedia = <T extends { media?: unknown }>(p: T): Omit<T, "media"> => { const rest: Partial<T> = { ...p }; delete rest.media; return rest as Omit<T, "media">; };
const RATES: MediaRates = { audioInput: 3_000_000, videoInput: "input", audioCacheRead: 500_000 };
const source = (rates: MediaRates | undefined = RATES): MediaPriceSource => ({ mediaFor: (provider, model) => provider === "gemini" && model === "gemini-2.5-flash" ? rates : undefined });
const guard = (parts: unknown[], media: MediaPriceSource | undefined = source(), extra: Record<string, unknown> = {}) => guardGemini(Buffer.from(JSON.stringify({ contents: [{ role: "user", parts }], ...extra })), headers, path, limits, media);
const audioPart = (data = "A".repeat(4000), mimeType = "audio/mp3") => ({ inlineData: { mimeType, data } });
const videoPart = (data = "A".repeat(8000), videoMetadata?: unknown) => ({ inlineData: { mimeType: "video/mp4", data }, ...(videoMetadata === undefined ? {} : { videoMetadata }) });

describe("audio and video admission and the hold estimate", () => {
  it("inline audio: 32 tokens a second at a 750 B/s floor; its encoded bytes leave the byte count; overrun-capable", () => {
    const r = guard([{ text: "transcribe" }, audioPart()]); if (!r.ok) throw new Error(r.message);
    // 4000 base64 chars = 3000 bytes = 4 s = 128 tokens.
    expect(r.media).toEqual({ tokens: 128, dataBytes: 4000, audio: true, video: false });
    expect(r.inputBounded).toBe(false); expect(r.mediaRates).toEqual(RATES);
    const snake = guardGemini(Buffer.from(JSON.stringify({ contents: [{ parts: [{ functionResponse: { name: "f", response: {}, parts: [{ inline_data: { mime_type: "audio/wav", data: "A".repeat(4000) } }] } }] }] })), headers, path, limits, source());
    expect(snake.ok && snake.media).toEqual({ tokens: 128, dataBytes: 4000, audio: true, video: false });
  });
  it("inline video: (fps x 300 + 32) tokens a second; a declared clip bounds the length, else a 2000 B/s floor", () => {
    const plain = guard([videoPart()]); expect(plain.ok && plain.media).toEqual({ tokens: 3 * 332, dataBytes: 8000, audio: false, video: true });
    const fps = guard([videoPart(undefined, { fps: 2 })]); expect(fps.ok && fps.media?.tokens).toBe(3 * 632);
    const clip = guard([videoPart(undefined, { startOffset: "15s", endOffset: "19.5s" })]); expect(clip.ok && clip.media?.tokens).toBe(5 * 332);
    const both = guard([audioPart(), videoPart()]); expect(both.ok && both.media).toEqual({ tokens: 128 + 996, dataBytes: 12000, audio: true, video: true });
    const huge = guard([videoPart(undefined, { endOffset: "9999999s", fps: 24 })]); expect(huge.ok && huge.media?.tokens).toBe(MEDIA_TOKENS_MAX);
  });
  it("refuses bad videoMetadata, missing or non-string data, and both spellings of videoMetadata", () => {
    for (const meta of [{ fps: 0 }, { fps: 25 }, { fps: "2" }, { startOffset: "5s", endOffset: "5s" }, { endOffset: "5" }, { startOffset: "-1s" }, { other: 1 }, "x"]) expect(guard([videoPart(undefined, meta)]).ok).toBe(false);
    expect(guard([{ inlineData: { mimeType: "audio/mp3" } }]).ok).toBe(false);
    expect(guard([{ inlineData: { mimeType: "audio/mp3", data: 5 } }]).ok).toBe(false);
  });
  it("refuses audio on a model with no audio price, and video without both prices (the audio track), with fixed words", () => {
    for (const [parts, media] of [[[audioPart()], { mediaFor: () => undefined }], [[audioPart()], source({ videoInput: "input" })], [[videoPart()], source({ audioInput: "input" })], [[videoPart()], source({ videoInput: "input" })], [[audioPart()], { mediaFor: () => { throw new Error("x"); } }], [[audioPart()], { mediaFor: () => ({ audioInput: 0 }) }]] as const) {
      const r = guard([...parts], media); expect(!r.ok && r.message).toBe(PRODUCT_AUDIO_REFUSED);
    }
    // Images keep their text-rate treatment with no media price at all.
    const image = guard([{ inlineData: { mimeType: "image/png", data: "AAAA" } }], undefined); expect(image.ok && image.media).toBeUndefined();
  });
  it("refuses audio and video by file reference (no size or length to hold), keeps image files", () => {
    for (const part of [{ fileData: { mimeType: "audio/mpeg", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/a" } }, { fileData: { mimeType: "video/mp4", fileUri: "x" } }]) {
      const r = guard([part]); expect(!r.ok && r.message).toBe(PRODUCT_MEDIA_FILE_REFUSED);
    }
    const nested = guard([{ functionResponse: { name: "f", response: {}, parts: [{ file_data: { mime_type: "video/mp4", file_uri: "x" } }] } }]); expect(!nested.ok && nested.message).toBe(PRODUCT_MEDIA_FILE_REFUSED);
    expect(guard([{ fileData: { mimeType: "image/png", fileUri: "x" } }]).ok).toBe(true);
  });
  it("still refuses Google server tools next to priced audio", () => {
    for (const tool of [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: {} }]) { const r = guard([audioPart()], source(), { tools: [tool] }); expect(!r.ok && r.message).toBe(PRODUCT_TOOL_REFUSED); }
  });
  it("estimateCall: media tokens at the dearest usable rate; identical to today without media (golden)", () => {
    const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 1_000_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 1_000_000, media: RATES };
    expect(estimateCall(100, 10, price, 0, false, { tokens: 128, audio: true, video: false })).toBe(Math.ceil((228 * 3_000_000 + 10 * 2_000_000) / 1e6));
    expect(estimateCall(100, 10, price, 0, false)).toBe(Math.ceil((100 * 1_000_000 + 10 * 2_000_000) / 1e6));
    expect(estimateCall(100, 10, noMedia(price), 0, false)).toBe(estimateCall(100, 10, { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 1_000_000, cacheWrite5mMicrosPerMTok: 1_000_000, cacheWrite1hMicrosPerMTok: 1_000_000 }, 0, false));
    // A long-context tier raises a listed media rate it would otherwise undercut; the tier is chosen with media tokens counted.
    const long = { ...price, longContext: [{ aboveTokens: 200_000, inputMicrosPerMTok: 5_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 5_000_000, cacheWrite5mMicrosPerMTok: 5_000_000, cacheWrite1hMicrosPerMTok: 5_000_000 }] };
    expect(estimateCall(100, 0, long, 0, false, { tokens: 200_000, audio: true, video: false })).toBe(Math.ceil(200_100 * 5));
    expect(() => estimateCall(100, 10, { ...price, media: { videoInput: "input" } }, 0, false, { tokens: 1, audio: false, video: true })).toThrow();
  });
});

describe("usage by modality and the settle", () => {
  const meta = (extra: Record<string, unknown> = {}) => ({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "TEXT", tokenCount: 72 }, { modality: "AUDIO", tokenCount: 128 }], ...extra });
  it("reads AUDIO and VIDEO prompt and cache details as parts of input and cacheRead; text usage is unchanged (golden)", () => {
    expect(geminiUsage(meta())).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 128 });
    expect(geminiUsage({ promptTokenCount: 6, cachedContentTokenCount: 2, candidatesTokenCount: 3, promptTokensDetails: [{ modality: "TEXT", tokenCount: 6 }] })).toEqual({ input: 4, output: 3, cacheRead: 2, cacheWrite: 0 });
    expect(geminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 90, candidatesTokenCount: 1, promptTokensDetails: [{ modality: "VIDEO", tokenCount: 50 }, { modality: "AUDIO", tokenCount: 40 }, { modality: "TEXT", tokenCount: 10 }], cacheTokensDetails: [{ modality: "AUDIO", tokenCount: 30 }, { modality: "VIDEO", tokenCount: 60 }] }))
      .toEqual({ input: 10, output: 1, cacheRead: 90, cacheWrite: 0, audioInput: 10, audioCacheRead: 30, videoCacheRead: 60 });
  });
  it("malformed details make the usage unusable; on a media call missing details bill the prompt as its dearest media kind (REVIEW-1 M2)", () => {
    for (const details of ["x", [{ modality: 1, tokenCount: 1 }], [{ modality: "AUDIO", tokenCount: -1 }], [{ modality: "AUDIO", tokenCount: 201 }], [{ modality: "TEXT", tokenCount: 201 }], [{ modality: "AUDIO", tokenCount: 150 }, { modality: "AUDIO", tokenCount: 60 }], Array.from({ length: 17 }, () => ({ modality: "TEXT", tokenCount: 1 }))]) {
      expect(geminiUsage(meta({ promptTokensDetails: details }))).toBeUndefined();
    }
    const noDetails = { promptTokenCount: 200, candidatesTokenCount: 10 };
    expect(geminiUsage(noDetails)).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0 });
    expect(geminiUsage(noDetails, "audio")).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 200 });
    expect(geminiUsage(noDetails, "video")).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, videoInput: 200 });
    expect(geminiUsage(meta({ cachedContentTokenCount: 5 }), "audio")).toEqual({ input: 195, output: 10, cacheRead: 5, cacheWrite: 0, audioInput: 128, audioCacheRead: 5 });
    const media = new GeminiUsageCollector({ missingDetails: "audio" }); media.whole({ candidates: [{ finishReason: "STOP" }], usageMetadata: noDetails }); expect(media.finish()).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 200 });
    const text = new GeminiUsageCollector(); text.whole({ candidates: [{ finishReason: "STOP" }], usageMetadata: noDetails }); expect(text.finish()).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0 });
  });
  it("usage validation: media counts are whole parts of their totals", () => {
    const base = { input: 10, output: 0, cacheRead: 5, cacheWrite: 0 };
    expect(validUsage({ ...base, audioInput: 6, videoInput: 4, audioCacheRead: 5 })).toBe(true);
    for (const bad of [{ audioInput: 11 }, { audioInput: 6, videoInput: 5 }, { audioCacheRead: 3, videoCacheRead: 3 }, { videoInput: 1.5 }, { audioInput: "1" }]) expect(validUsage({ ...base, ...bad })).toBe(false);
  });
  it("usageCost charges each modality at its rate, cached audio at its cache rate; unpriced media never settles at $0", () => {
    const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 100_000, media: RATES };
    // 72 text x 1 + 128 audio x 3 + 10 out x 2 = 476.
    expect(usageCost({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 128 }, price)).toBe(476);
    // Video at "input": 3x the text rate; cached video at 3x the cache rate; cached audio at its listed 0.5.
    expect(usageCost({ input: 100, output: 0, cacheRead: 20, cacheWrite: 0, videoInput: 100, audioCacheRead: 10, videoCacheRead: 10 }, price)).toBe(Math.ceil((100 * 3_000_000 + 10 * 500_000 + 10 * 300_000) / 1e6));
    // Cached audio with no cache rate of its own: the listed audio input rate.
    expect(usageCost({ input: 0, output: 0, cacheRead: 10, cacheWrite: 0, audioCacheRead: 10 }, { ...price, media: { audioInput: 3_000_000 } })).toBe(30);
    // Above a long-context threshold a listed audio rate is never charged below that tier's input rate.
    const long = { ...price, longContext: [{ aboveTokens: 200_000, inputMicrosPerMTok: 5_000_000 }] };
    expect(usageCost({ input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, audioInput: 300_000 }, long)).toBe(1_500_000);
    // "input" audio uses 3x the cache-read rate when cached.
    expect(usageCost({ input: 0, output: 0, cacheRead: 10, cacheWrite: 0, audioCacheRead: 10 }, { ...price, media: { audioInput: "input" } })).toBe(3);
    const unpriced = { input: 200, output: 10, cacheRead: 0, cacheWrite: 0, videoInput: 100 };
    expect(mediaPriced(unpriced, price)).toBe(true);
    expect(mediaPriced(unpriced, { ...price, media: { audioInput: 1 } })).toBe(false);
    expect(usageCost(unpriced, noMedia(price))).toBe(Number.MAX_SAFE_INTEGER);
    // Reported but unpriced media (REVIEW-1 M1): 4x the text input rate, never below the hold, estimated with the usage.
    expect(settleAmount({ usage: unpriced, price: { ...noMedia(price), estimated: false }, reservationMicros: 999 })).toEqual({ actualMicros: 999, estimated: true, usage: unpriced });
    expect(settleAmount({ usage: unpriced, price: { ...noMedia(price), estimated: false }, reservationMicros: 1 })).toEqual({ actualMicros: 100 * 4 + 100 + 20, estimated: true, usage: unpriced });
    expect(settleAmount({ usage: { input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 128 }, price: { ...price, estimated: false }, reservationMicros: 999 })).toEqual({ actualMicros: 476, estimated: false });
  });
});

const audioBody = { contents: [{ role: "user", parts: [{ text: "transcribe" }, audioPart()] }], generationConfig: { maxOutputTokens: 100 } };
describe("the product route end to end", () => {
  it("holds the media estimate, sends one call, and settles audio at its rate to the project", async () => {
    let held = 0;
    const g = await productGateway({ media: source(), transport: async () => { held = (await g.productMeter.read(productScope))[0]!.reservedMicros; return { status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "TEXT", tokenCount: 72 }, { modality: "AUDIO", tokenCount: 128 }] }) }; } });
    const sink = await productCall(g.deps, streamPath, audioBody);
    expect(sink.status).toBe(200);
    // Body bytes minus the 4000 encoded audio bytes, plus 128 audio tokens, all at the 3 $/M audio rate; 100 output at 2 $/M.
    const bodyBytes = g.productCalls[0]!.body.byteLength;
    expect(held).toBe(Math.ceil(((bodyBytes - 4000 + 128) * 3_000_000 + 100 * 2_000_000) / 1e6));
    expect((await g.productMeter.read(productScope)).every((r) => r.spentMicros === 476 && r.reservedMicros === 0)).toBe(true);
    expect(g.logs).toContainEqual({ event: "settled", costMicros: 476, estimated: false, appliedMaxOutputTokens: 100, route: "product" });
  });
  it("a media call whose answer has no modality details bills every prompt token at the audio rate and still answers (REVIEW-1 M2)", async () => {
    const g = await productGateway({ media: source({ audioInput: 5_000_000, videoInput: "input" }), transport: async () => ({ status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10 }) }) });
    expect((await productCall(g.deps, streamPath, audioBody)).status).toBe(200);
    expect((await g.productMeter.read(productScope)).every((r) => r.spentMicros === 200 * 5 + 20 && r.reservedMicros === 0)).toBe(true);
  });
  it("audio reported from a cached context with no media price is charged cautiously, flagged estimated, and blocks the task by one call (REVIEW-1 M1)", async () => {
    const g = await productGateway({ transport: async () => ({ status: 200, body: geminiAnswer({ promptTokenCount: 1_000_010, cachedContentTokenCount: 1_000_000, candidatesTokenCount: 10, cacheTokensDetails: [{ modality: "AUDIO", tokenCount: 1_000_000 }] }) }) });
    expect((await productCall(g.deps, streamPath, { contents: [{ parts: [{ text: "x" }] }], cachedContent: "cachedContents/a", generationConfig: { maxOutputTokens: 100 } })).status).toBe(200);
    // 10 text x 1 + 1M cached audio x 4 (4x the text input rate) + 10 out x 2.
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(4_000_030);
    expect(g.logs).toContainEqual({ event: "product_over_reservation" });
    expect((await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items[0]!.usage.audioCacheRead).toBe(1_000_000);
  });
  it("without media prices the route refuses audio before holding or sending (today's behaviour)", async () => {
    const g = await productGateway();
    const sink = await productCall(g.deps, streamPath, audioBody);
    expect(sink.status).toBe(400); expect(g.productCalls).toHaveLength(0);
    expect((await g.productMeter.read(productScope))[0]!.committed).toBe(0);
  });
  it("an estimated price writes the correction row with the media counts, and the correction re-prices them at the media rate", async () => {
    const g = await productGateway({ media: source(), overrides: { prices: { priceFor: () => undefined } }, transport: async () => ({ status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 128 }] }) }) });
    expect((await productCall(g.deps, streamPath, audioBody)).status).toBe(200);
    const [row] = (await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items;
    expect(row!.usage).toEqual({ input: 200, output: 10, cacheRead: 0, cacheWrite: 0, audioInput: 128 });
    const exact = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, priceVersion: 2, origin: { source: "litellm" as const, fetchedAt: now } };
    const caps = new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 });
    // No media rates at correction time: left for an operator, never re-priced as text.
    const skipped = await runCorrections({ meter: g.productMeter, prices: { priceFor: () => exact }, caps, now, runId: "r1" });
    expect(skipped.corrected).toBe(0);
    const done = await runCorrections({ meter: g.productMeter, prices: { priceFor: () => exact, mediaFor: () => RATES }, caps, now, runId: "r2" });
    expect(done.corrected).toBe(1);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(72 + 384 + 20);
  });
  it("the DynamoDB meter keeps the media counts on the correction row", async () => {
    const tables = { meter: "gw-meter", ledger: "gw-ledger", markers: "gw-markers" };
    const wire = new WireDynamo([...Object.values(tables), "gw-prices"]);
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "t" }), transport: wire.transport });
    const meter = new DynamoMeter({ db, tables, now: () => now });
    const r = await meter.reserve({ scope: productScope, caps: { task: 1000, projectMonth: 1000, companyMonth: 1000 }, estimateMicros: 500, overrun: { deadlineSeconds: now / 1000 + 60, tokenExpiresSeconds: now / 1000 + 900 } });
    if (!r.ok) throw new Error("reserve");
    const usage = { input: 200, output: 10, cacheRead: 20, cacheWrite: 0, audioInput: 128, videoInput: 2, audioCacheRead: 10, videoCacheRead: 5 };
    await meter.settle(r.reservation, 476, { provider: "gemini", model: "gemini-2.5-flash", kind: "chat", usage, settledAt: now });
    expect((await meter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items[0]!.usage).toEqual(usage);
  });
});

describe("media with no price of its own (row says supported, lists none): 3x the text rate, estimated", () => {
  const TEXT_RATE: MediaRates = { audioInput: "input", videoInput: "input" };
  it("holds and settles at 3x the text input rate, never below it, flagged estimated with a correction row of media counts; a later correction keeps it estimated until the row lists a price", async () => {
    let held = 0;
    const g = await productGateway({ media: source(TEXT_RATE), transport: async () => { held = (await g.productMeter.read(productScope))[0]!.reservedMicros; return { status: 200, body: geminiAnswer({ promptTokenCount: 200, candidatesTokenCount: 10, promptTokensDetails: [{ modality: "TEXT", tokenCount: 72 }, { modality: "AUDIO", tokenCount: 128 }] }) }; } });
    expect((await productCall(g.deps, streamPath, audioBody)).status).toBe(200);
    const bodyBytes = g.productCalls[0]!.body.byteLength;
    // Fixture text input 1 $/M: media held at 3 $/M (dearest usable rate), 100 output at 2 $/M.
    expect(held).toBe(Math.ceil(((bodyBytes - 4000 + 128) * 3_000_000 + 100 * 2_000_000) / 1e6));
    // 72 text x 1 + 128 audio x 3 + 10 out x 2 = 476, estimated.
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(476);
    expect(g.logs).toContainEqual({ event: "settled", costMicros: 476, estimated: true, appliedMaxOutputTokens: 100, route: "product" });
    const [row] = (await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items;
    expect(row!.usage.audioInput).toBe(128);
    const exact = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, priceVersion: 2, origin: { source: "litellm" as const, fetchedAt: now } };
    const caps = new FixedCapsSource({ task: 1_000_000_000, projectMonth: 1_000_000_000, companyMonth: 1_000_000_000 });
    expect((await runCorrections({ meter: g.productMeter, prices: { priceFor: () => exact, mediaFor: () => TEXT_RATE }, caps, now, runId: "c1" })).corrected).toBe(1);
    // Still "input": stays estimated (pending); once the row lists 2 $/M audio, the correction lowers it to the listed price.
    expect((await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items).toHaveLength(1);
    expect((await runCorrections({ meter: g.productMeter, prices: { priceFor: () => ({ ...exact, priceVersion: 3 }), mediaFor: () => ({ audioInput: 2_000_000 }) }, caps, now, runId: "c2" })).corrected).toBe(1);
    expect((await g.productMeter.read(productScope))[0]!.spentMicros).toBe(72 + 256 + 20);
    expect((await g.productMeter.pendingFor({ provider: "gemini", model: "gemini-2.5-flash" }, 5)).items).toHaveLength(0);
  });
  it("a listed media rate is not estimated, and never below the text rate", () => {
    const price = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 100_000, estimated: false };
    expect(settleAmount({ usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, audioInput: 100 }, price: { ...price, media: { audioInput: 500_000 } }, reservationMicros: 1 })).toEqual({ actualMicros: 100, estimated: false });
    expect(settleAmount({ usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, audioInput: 100 }, price: { ...price, media: { audioInput: "input" } }, reservationMicros: 1 })).toEqual({ actualMicros: 300, estimated: true, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, audioInput: 100 } });
  });
});

describe("in-memory meter keeps media counts (contract)", () => {
  it("settle with media usage is recorded as given", async () => {
    const meter = new InMemoryMeter(() => now);
    const r = await meter.reserve({ scope: productScope, caps: { task: 1000, projectMonth: 1000, companyMonth: 1000 }, estimateMicros: 10 }); if (!r.ok) throw new Error("reserve");
    await meter.settle(r.reservation, 5, { provider: "gemini", model: "m", kind: "chat", usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, audioInput: 2 }, settledAt: now });
    expect((await meter.pendingFor({ provider: "gemini", model: "m" }, 5)).items[0]!.usage.audioInput).toBe(2);
  });
});
