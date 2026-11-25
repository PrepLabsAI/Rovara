import { beforeAll, expect, it, vi } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { call, caps, claims, MemorySink, mint, now, setup } from "./model-gateway-fixture.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { createAnswersRoutes, ANSWERS_PATH, ANSWERS_STEP } from "../../packages/model-gateway/src/answers-route.js";
import { toChatCompletions } from "../../packages/model-gateway/src/agent-openai.js";
import { inlineImageBound } from "../../packages/model-gateway/src/inline-image.js";
import { guardBedrockProduct, parseBedrockProductPath } from "../../packages/model-gateway/src/product-bedrock.js";
import { parseBedrockConnect } from "../../packages/model-gateway/src/bedrock-byo.js";
import type { TaskClaims } from "../../packages/model-gateway/src/model-gateway-token.js";
import { guardRequest } from "../../packages/model-gateway/src/guard.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { answerRateQuote, RATE_QUOTE_AUDIENCE } from "../../packages/model-gateway/src/rate-quote.js";
import type { RunPrice } from "../../packages/model-gateway/src/model-gateway-token.js";

beforeAll(denyNetwork);
const model = "claude-sonnet-5-5";
const id = "us.anthropic.claude-sonnet-5-5";
type Format = "png" | "jpeg" | "gif" | "webp";
/** LZW (min code size 2) of `count` pixels, all palette index 0; standard GIF variable-width codes. */
function lzw(count: number): Buffer {
  const clear = 4, eoi = 5; const bytes: number[] = []; let acc = 0, bits = 0, size = 3, next = 6;
  const emit = (code: number): void => { acc |= code << bits; bits += size; while (bits >= 8) { bytes.push(acc & 255); acc >>>= 8; bits -= 8; } };
  const dict = new Map<number, number>();
  emit(clear);
  if (count > 0) {
    let prefix = 0;
    for (let i = 1; i < count; i++) {
      const hit = dict.get(prefix);
      if (hit !== undefined) { prefix = hit; continue; }
      emit(prefix);
      if (next === 4096) { emit(clear); dict.clear(); next = 6; size = 3; } else { if (next >= 1 << size) size++; dict.set(prefix, next++); }
      prefix = 0;
    }
    emit(prefix);
  }
  emit(eoi);
  if (bits > 0) bytes.push(acc & 255);
  return Buffer.from(bytes);
}
const subBlocks = (data: Buffer): Buffer => {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += 255) { const part = data.subarray(at, at + 255); parts.push(Buffer.from([part.length]), part); }
  return Buffer.concat([...parts, Buffer.from([0])]);
};
interface GifFrame { left?: number; top?: number; width: number; height: number; localTable?: boolean }
interface GifOptions { version?: "GIF87a" | "GIF89a"; trailer?: boolean; animated?: boolean }
/** A real GIF: header, screen, global table, optional loop/comment/graphic-control extensions, LZW-coded frames, trailer. */
function gif(screen: [number, number], frames: GifFrame[], options: GifOptions = {}): Buffer {
  const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const parts: Buffer[] = [Buffer.from(options.version ?? "GIF89a", "latin1"), u16(screen[0]), u16(screen[1]), Buffer.from([0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])];
  if (options.animated) parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0]));
  // A comment whose bytes look like an image descriptor and a trailer: they must be skipped by length.
  parts.push(Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from([0x2c, 0x3b, 0x21, 0x2c])));
  for (const f of frames) {
    if (options.animated) parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
    parts.push(Buffer.from([0x2c]), u16(f.left ?? 0), u16(f.top ?? 0), u16(f.width), u16(f.height), Buffer.from([f.localTable === true ? 0x80 : 0]));
    if (f.localTable === true) parts.push(Buffer.from([0, 0, 0, 255, 255, 255]));
    parts.push(Buffer.from([2]), subBlocks(lzw(f.width * f.height)));
  }
  if (options.trailer !== false) parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
// A real 16x16 baseline JPEG (JFIF, Exif, DHT, DQT, SOF0 then SOS), encoded by macOS ImageIO.
const REAL_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMADw8PDw8PGg8PGiQaGhokMSQkJCQxPjExMTExPks+Pj4+Pj5LS0tLS0tLS1paWlpaWmlpaWlpdnZ2dnZ2dnZ2dv/bAEMBEhMTHhweNBwcNHtURVR7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e//dAAQAAf/aAAwDAQACEQMRAD8A52G09q1IbT2rUhtPatSG09qqrigwGN2P/9k=", "base64");
// SOF0 + SOS for a header-only JPEG of the table below; the SOS segment ends at this offset.
const JPEG_HEADER_SOS_END = 41;
function header(format: Format, width: number, height: number): Buffer {
  if (format === "png") {
    const b = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b);
    b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b;
  }
  if (format === "gif") {
    // A real one-frame GIF: only the logical screen has the requested size (the frame is 1x1), so the
    // table below stays small. Zero sizes get a zero-size frame too (a frame also sizes the image).
    const zero = width === 0 || height === 0;
    return gif([width, height], [{ width: zero ? width : 1, height: zero ? height : 1 }]);
  }
  if (format === "jpeg") {
    const b = Buffer.from("ffd8ffe000040000ffc00011080001000103011100021100031100ffda000c03010002110311003f0000ffd9", "hex");
    b.writeUInt16BE(height, 13); b.writeUInt16BE(width, 15); return b;
  }
  const b = Buffer.alloc(30); b.write("RIFF"); b.writeUInt32LE(22, 4); b.write("WEBPVP8X", 8); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3); return b;
}
const image = (data = header("png", 200, 200), format = "png") => ({ type: "image", source: { type: "base64", media_type: `image/${format}`, data: data.toString("base64") } });
const body = (blocks: unknown[], name = model) => ({ model: name, max_tokens: 64, stream: true, messages: [{ role: "user", content: blocks }] });
const guard = (blocks: unknown[]) => guardRequest(Buffer.from(JSON.stringify(body(blocks))), { "content-type": "application/json" }, [model], { maxOutputTokens: () => 64 });

for (const format of ["png", "jpeg", "gif", "webp"] as const) it.each([
  [1, 1, 1], [28, 28, 1], [29, 28, 2], [200, 200, 64], [1000, 1000, 1296], [8000, 8000, 4784], [9000, 1, 286], [1, 9000, 286],
])(`${format}: bounds %sx%s at %s patches plus margin`, (w, h, patches) => {
  const block = image(header(format, w, h), format);
  expect(guard([block])).toMatchObject({ ok: true, inputBounded: true, images: { tokens: patches + 256, dataBytes: block.source.data.length } });
});
it("clamps huge PNG dimensions without allocating pixels", () => {
  expect(guard([image(header("png", 0xffffffff, 0xffffffff))])).toMatchObject({ ok: true, inputBounded: true, images: { tokens: 4784 + 256 } });
});
for (const format of ["png", "jpeg", "gif", "webp"] as const) it(`${format}: every truncated dimension header remains unbounded`, () => {
  const b = header(format, 200, 200);
  for (let i = 0; i < (format === "jpeg" ? JPEG_HEADER_SOS_END : b.length); i++) expect(guard([image(b.subarray(0, i), format)]), `prefix ${i}`).toMatchObject({ ok: true, inputBounded: false });
});
it.each(["png", "jpeg", "gif"] as const)("%s: zero dimensions refuse", format => {
  expect(guard([image(header(format, 0, 200), format)])).toMatchObject({ inputBounded: false });
  expect(guard([image(header(format, 200, 0), format)])).toMatchObject({ inputBounded: false });
});
it.each([
  { type: "image" }, image(Buffer.from("not an image")), image(undefined, "svg+xml"), image(header("png", 200, 200), "jpeg"),
  { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
  { type: "image", source: { type: "file", file_id: "file_1" } },
  { ...image(), fileData: {} }, { ...image(), cachedContent: "external" },
  { ...image(), source: { ...image().source, data: "AA==!" } },
  { ...image(), source: { ...image().source, data: "" } },
  { ...image(), source: { ...image().source, data: 12 } },
  { ...image(), source: { ...image().source, data: "AB==" } },
])("refuses malformed or remote image %#", block => expect(guard([block])).toMatchObject({ ok: true, inputBounded: false }));
it("counts images across direct and nested tool-result content, with a 100-image ceiling", () => {
  const blocks = [image(), { type: "tool_result", tool_use_id: "read_1", content: Array.from({ length: 99 }, () => image()) }];
  expect(guard(blocks)).toMatchObject({ inputBounded: true, images: { tokens: 100 * (64 + 256) } });
  expect(guard([...blocks, image()])).toMatchObject({ inputBounded: false });
});
it("keeps opaque tool arguments/results outside image classification", () => {
  const opaque = { type: "image", source: { type: "url" } };
  expect(guard([{ type: "tool_use", id: "t", name: "read", input: opaque }, { type: "tool_result", tool_use_id: "t", content: opaque }])).toMatchObject({ inputBounded: true });
});
it.each(["document", "server_tool_use", "fileData", "cachedContent"])("keeps %s refused next to a valid image", type => {
  const block = type === "fileData" || type === "cachedContent" ? { type: "text", text: "x", [type]: {} } : { type };
  expect(guard([image(), block])).toMatchObject({ inputBounded: false });
});

async function world(name = model, cache = false, tier = false) {
  const catalog = name === model ? id : name;
  const prices = new SnapshotPriceSource({ load: async () => ({ version: 9, sources: { litellm: { fetchedAt: now - 100, count: 1, entries: [{ provider: "bedrock", model: catalog, kind: "chat", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, cacheReadMicrosPerMTok: 250_000, cacheWrite5mMicrosPerMTok: 4_000_000, cacheWrite1hMicrosPerMTok: 6_000_000,
    ...(tier ? { longContext: [{ aboveTokens: 32_000, inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 3_000_000, cacheReadMicrosPerMTok: 500_000, cacheWrite5mMicrosPerMTok: 8_000_000, cacheWrite1hMicrosPerMTok: 12_000_000 }] } : {}) }] } } }), save: async () => false }, { now: () => now, overrides: [] });
  await prices.reload();
  const rovara = { sourceId: "operator-account@region", models: new Map([[name, catalog]]), exempt: new Set<string>() };
  const sources = { sourceFor: async () => "rovara" as const }; const keys = { connected: async () => false, keyFor: async () => undefined };
  const quoted = await answerRateQuote({ prices, now: () => now, region: "us-west-2", switchedOn: new Set(), offeredProviders: new Set(["bedrock"]), sources, keys, rovara, verify: async () => ({ ...claims, aud: RATE_QUOTE_AUDIENCE }) }, { method: "GET", url: `/v1/service/companies/${claims.cid}/rate-quote?model=${name}&runPrice=1`, headers: { authorization: "Bearer fixture" } });
  const grant = (quoted.body as { runPrice: RunPrice }).runPrice; expect(grant).toBeDefined();
  const f = setup({ prices, agentKeys: keys, chargeReceipts: { source: (_c, _m, resolved) => resolved } });
  const sent: Buffer[] = [];
  f.deps.agentAi = { sources, rovara: { ...rovara, transport: async request => { sent.push(Buffer.from(request.body)); return f.deps.transport(request); } } };
  const blocks: unknown[] = [image()];
  if (cache) blocks.push({ type: "text", text: "cached", cache_control: { type: "ephemeral" } });
  return { ...f, sent, grant, body: body(blocks, name), token: mint({ mdl: [name], runPrice: grant }) };
}
it.each([false, true])("priced Claude accepts Pi nested inline images and settles actual usage (cached=%s)", async cache => {
  const f = await world(model, cache); const reserve = vi.spyOn(f.meter, "reserve"); const settle = vi.spyOn(f.meter, "settleV2");
  const block = image(); f.body.messages[0]!.content.push({ type: "tool_result", tool_use_id: "read_1", content: [block] });
  expect((await call(f.deps, f.body, f.token)).status).toBe(200); expect(f.sent).toHaveLength(1);
  expect(JSON.parse(f.sent[0]!.toString())).toMatchObject({ messages: f.body.messages });
  const tokens = f.sent[0]!.length - 2 * block.source.data.length + 2 * (64 + 256);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(tokens * (cache ? 6 : 1) + 64 * 2);
  expect(settle.mock.calls[0]![0].receipt).toMatchObject({ status: "final", amountMicros: { value: 37 } });
});
it.each([false, true])("image tokens reach the long-context hold band (cached=%s)", async cache => {
  const f = await world(model, cache, true); const reserve = vi.spyOn(f.meter, "reserve");
  const block = image(header("png", 8000, 8000)); f.body.messages[0]!.content = Array.from({ length: 7 }, () => block);
  if (cache) f.body.messages[0]!.content.push({ type: "text", text: "cached", cache_control: { type: "ephemeral" } });
  expect((await call(f.deps, f.body, f.token)).status).toBe(200);
  const tokens = f.sent[0]!.length - 7 * block.source.data.length + 7 * (4784 + 256);
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(tokens * (cache ? 12 : 2) + 64 * 3);
});
it("non-Claude Converse still refuses valid inline images before reserve/send", async () => {
  const f = await world("zai.glm-5"); const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, f.body, f.token)).status).toBe(400);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("priced Claude refuses malformed images before reserve/send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve"); f.body.messages[0]!.content = [image(Buffer.from("bad"))];
  expect((await call(f.deps, f.body, f.token)).status).toBe(409);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it("enforces the 5 MiB base64 ceiling before decoding", () => {
  const source = image().source;
  const exact = Buffer.alloc(5 * 1024 * 1024 / 4 * 3); header("png", 200, 200).copy(exact);
  expect(inlineImageBound({ type: "image", source: { ...source, data: exact.toString("base64") } })).toEqual({ tokens: 320, dataBytes: 5 * 1024 * 1024 });
  const oversized = exact.toString("base64") + "AAAA";
  expect(inlineImageBound({ type: "image", source: { ...source, data: oversized } })).toBeUndefined();
});
it("refuses corrupt PNG/GIF signatures and mismatched PNG IHDR size", () => {
  for (const format of ["png", "gif"] as const) {
    const b = header(format, 200, 200); b[0] = 0;
    expect(guard([image(b, format)])).toMatchObject({ inputBounded: false });
  }
  const b = header("png", 200, 200); b.writeUInt32BE(12, 8);
  expect(guard([image(b)])).toMatchObject({ inputBounded: false });
});
it("supports GIF87a, JPEG fill markers and progressive SOF", () => {
  const gif = header("gif", 200, 200); gif.write("GIF87a");
  const jpeg = header("jpeg", 200, 200); jpeg[9] = 0xc2;
  for (const block of [image(gif, "gif"), image(jpeg, "jpeg"), image(Buffer.concat([jpeg.subarray(0, 8), Buffer.from([255]), jpeg.subarray(8)]), "jpeg"), image(Buffer.concat([jpeg.subarray(0, 8), Buffer.from([255, 255, 255]), jpeg.subarray(8)]), "jpeg")]) {
    expect(guard([block])).toMatchObject({ inputBounded: true, images: { tokens: 320 } });
  }
});
it("rejects malformed JPEG segments and caps JPEG header scanning at 64 KiB", () => {
  const original = header("jpeg", 200, 200);
  const corrupt: Buffer[] = [];
  for (const [offset, value] of [[0, 0], [2, 0], [5, 1], [5, 255], [9, 0xc4], [11, 7], [11, 16], [17, 4]] as const) {
    const b = Buffer.from(original); b[offset] = value; corrupt.push(b);
  }
  const large = Buffer.alloc(65535); large[0] = 255; large[1] = 0xe1; large.writeUInt16BE(65533, 2);
  corrupt.push(Buffer.concat([Buffer.from([255, 216]), large, original.subarray(8)]));
  for (const b of corrupt) expect(guard([image(b, "jpeg")])).toMatchObject({ inputBounded: false });
});
function webpChunk(kind: string, bytes: Buffer): Buffer {
  const b = Buffer.alloc(20 + bytes.length + bytes.length % 2); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WEBP", 8); b.write(kind, 12); b.writeUInt32LE(bytes.length, 16); bytes.copy(b, 20); return b;
}
it("supports VP8 and VP8L dimensions, including their size-bit masks", () => {
  const lossy = Buffer.alloc(10); Buffer.from("9d012a", "hex").copy(lossy, 3); lossy.writeUInt16LE(200 | 0xc000, 6); lossy.writeUInt16LE(200 | 0x8000, 8);
  const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE((199 | (199 << 14) | (1 << 28)) >>> 0, 1);
  for (const b of [webpChunk("VP8 ", lossy), webpChunk("VP8L", lossless)]) expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: true, images: { tokens: 320 } });
});
it("rejects malformed WebP containers, chunks, signatures and zero VP8 dimensions", () => {
  const original = header("webp", 200, 200); const corrupt: Buffer[] = [];
  for (const [offset, value] of [[0, 0], [8, 0], [4, 21], [16, 11], [16, 9], [12, 0]] as const) {
    const b = Buffer.from(original); b[offset] = value; corrupt.push(b);
  }
  corrupt.push(webpChunk("VP8L", Buffer.alloc(4)), webpChunk("VP8L", Buffer.alloc(5)), webpChunk("VP8 ", Buffer.alloc(9)), webpChunk("VP8 ", Buffer.alloc(10)));
  const zero = Buffer.alloc(10); Buffer.from("9d012a", "hex").copy(zero, 3); corrupt.push(webpChunk("VP8 ", zero));
  for (const b of corrupt) expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: false });
});
it("counts valid system images and deeply nested tool-result arrays", () => {
  const request = { ...body([{ type: "tool_result", tool_use_id: "t", content: [[[image()]]] }]), system: [image()] };
  expect(guardRequest(Buffer.from(JSON.stringify(request)), { "content-type": "application/json" }, [model], { maxOutputTokens: () => 64 })).toMatchObject({ inputBounded: true, images: { tokens: 640 } });
});
it("accepts a real inline PNG with the documented Messages source shape on the direct route", async () => {
  const block = image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=", "base64"));
  const f = setup(); const reserve = vi.spyOn(f.meter, "reserve");
  const result = await call(f.deps, body([block], claims.mdl[0]));
  expect(result.status).toBe(200); expect(f.calls).toHaveLength(1);
  const encoded = JSON.stringify(body([block], claims.mdl[0]));
  expect(reserve.mock.calls[0]![0].estimateMicros).toBe(Buffer.byteLength(encoded) - block.source.data.length + 257 + 128);
});

it("refuses URL or malformed images even without a signed run price", async () => {
  for (const block of [image(Buffer.from("bad")), { type: "image", source: { type: "url", url: "https://example.test/p.png" } }]) {
    const f = setup(); const reserve = vi.spyOn(f.meter, "reserve");
    const refused = await call(f.deps, body([block], claims.mdl[0]));
    expect(refused.status).toBe(409); expect(refused.text()).toContain("This image can't be priced (only inline png, jpeg, gif or webp up to the size limit can be sent). Send it inline or leave it out.");
    expect(reserve).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  }
});

it("Bedrock's documented Claude InvokeModel body retains image bounds through its adapter", () => {
  const connection = parseBedrockConnect(JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa", region: "us-west-2", models: { [model]: id }, allowGlobal: false }));
  const path = parseBedrockProductPath(`/v1/product/bedrock/model/${encodeURIComponent(id)}/invoke`, "");
  expect(connection).toBeDefined(); expect(path).toBeDefined();
  const block = image(header("png", 8000, 8000));
  const checked = guardBedrockProduct({ bytes: Buffer.from(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 64, messages: [{ role: "user", content: [block] }] })), headers: { "content-type": "application/json" }, path: path!, connection: connection!, claims: claims as TaskClaims, modelLimits: { maxOutputTokens: () => 64 } });
  expect(checked).toMatchObject({ ok: true, inputBounded: true, images: { tokens: 5040, dataBytes: block.source.data.length } });
});

it("rejects a remote source even when it also carries valid inline data", () => {
  expect(guard([{ ...image(), source: { ...image().source, type: "url", url: "https://example.test/i.png" } }])).toMatchObject({ inputBounded: false });
});
it("checks WebP chunk extents independently of the readable dimension prefix", () => {
  const bytes = Buffer.alloc(5); bytes[0] = 0x2f; bytes.writeUInt32LE(199 | (199 << 14), 1);
  for (const declared of [7, 100]) {
    const b = webpChunk("VP8L", bytes); b.writeUInt32LE(declared, 16);
    expect(guard([image(b, "webp")])).toMatchObject({ inputBounded: false });
  }
});
it("rejects high-bit aliases for GIF signatures and WebP chunk names", () => {
  const gif = header("gif", 200, 200); gif[0] = 0xc7;
  const webp = header("webp", 200, 200); webp[12] = 0xd6;
  expect(guard([image(gif, "gif")])).toMatchObject({ inputBounded: false });
  expect(guard([image(webp, "webp")])).toMatchObject({ inputBounded: false });
});

it("rejects a VP8 frame tag with positive readable dimensions but a wrong signature", () => {
  const bytes = Buffer.alloc(10); bytes.writeUInt16LE(200, 6); bytes.writeUInt16LE(200, 8);
  expect(guard([image(webpChunk("VP8 ", bytes), "webp")])).toMatchObject({ inputBounded: false });
});
it("includes image tokens in the atomic budget hold before any provider send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.deps.caps = new FixedCapsSource({ ...caps, task: 500 });
  expect((await call(f.deps, f.body, f.token)).status).toBe(422);
  expect(reserve).toHaveBeenCalledOnce(); expect(reserve.mock.calls[0]![0].estimateMicros).toBeGreaterThan(500);
  expect(f.sent).toHaveLength(0);
});
it("checks cache-write evidence in bands reached only by image tokens", async () => {
  const f = await world(model, true, true); const reserve = vi.spyOn(f.meter, "reserve");
  const prices = f.deps.prices!; const effective = prices.effectiveFor!.bind(prices);
  f.deps.prices = { priceFor: prices.priceFor.bind(prices), quoteBasis: prices.quoteBasis!.bind(prices), effectiveFor: async (...args) => {
    const p = await effective(...args);
    return { ...p, derived: [{ aboveTokens: 32000, keys: ["cacheWrite1hMicrosPerMTok"] }] };
  } };
  const block = image(header("png", 8000, 8000));
  f.body.messages[0]!.content.push(...Array.from({ length: 7 }, () => block));
  const result = await call(f.deps, f.body, f.token);
  expect(result.status).toBe(409); expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it("rejects otherwise valid image data with a noncanonical base64 suffix", () => {
  for (const suffix of ["!", "\n"]) expect(guard([{ ...image(), source: { ...image().source, data: image().source.data + suffix } }])).toMatchObject({ inputBounded: false });
});
it("includes the tool allowance when checking image-reached cache bands", async () => {
  const f = await world(model, true, true); const reserve = vi.spyOn(f.meter, "reserve");
  const prices = f.deps.prices!; const effective = prices.effectiveFor!.bind(prices);
  f.deps.prices = { priceFor: prices.priceFor.bind(prices), quoteBasis: prices.quoteBasis!.bind(prices), effectiveFor: async (...args) => ({ ...await effective(...args), derived: [{ aboveTokens: 32000, keys: ["cacheWrite1hMicrosPerMTok"] }] }) };
  const block = image(header("png", 8000, 8000));
  f.body.messages[0]!.content.push(...Array.from({ length: 5 }, () => block));
  const padding = { type: "text", text: "" }; f.body.messages[0]!.content.push(padding);
  const request = { ...f.body, tools: [{ name: "read", input_schema: { type: "object" } }] };
  const forwardedBytes = Buffer.byteLength(JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 64, messages: request.messages, tools: request.tools }));
  const imageInput = forwardedBytes - 6 * block.source.data.length + 5 * 5040 + 320;
  padding.text = "x".repeat(32001 - 4096 - imageInput);
  const result = await call(f.deps, request, f.token);
  expect(result.status).toBe(409); expect(result.text()).toMatch(/cache.write price/iu);
  expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});

it.each(["openai", "openrouter", "endpoint"] as const)("%s still refuses valid inline images while accepting plain text", provider => {
  expect(toChatCompletions(body([{ type: "text", text: "hello" }]), "gpt-5", 64, provider)).toBeDefined();
  expect(toChatCompletions(body([image()]), "gpt-5", 64, provider)).toBeUndefined();
});
it("keeps the image bound in an unsigned call's provisional input floor", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  expect((await call(f.deps, f.body, mint({ mdl: [model] }))).status).toBe(200);
  expect(reserve.mock.calls[0]![0].provisional).toMatchObject({ requestBytes: f.sent[0]!.length - image().source.data.length + 320, toolInputAllowanceTokens: 0, maxOutputTokens: 64 });
});

it("keeps the shared stale-authorization sentence for a non-image unbounded block, not the image sentence", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.body.messages[0]!.content = [{ type: "document", source: { type: "url", url: "https://example.test/p.pdf" } }];
  const result = await call(f.deps, f.body, f.token);
  expect(result.status).toBe(409); expect(result.text()).toContain("AI source or price changed; pause this run for fresh authorization.");
  expect(result.text()).not.toContain("can't be priced"); expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("hosted answers with images require a signed price before any hold or send", async () => {
  const f = await world(); const reserve = vi.spyOn(f.meter, "reserve");
  f.deps.answers = createAnswersRoutes({ keys: f.deps.agentKeys!, meter: f.meter, companyCaps: f.deps.caps, limits: { limitFor: async () => undefined }, modelLimits: f.deps.modelLimits, transport: f.deps.transport,
    rovaraDefault: { ai: f.deps.agentAi!.rovara!, sources: f.deps.agentAi!.sources } });
  const sink = new MemorySink();
  await handleGateway(f.deps, { method: "POST", url: ANSWERS_PATH, headers: { "content-type": "application/json", "x-api-key": mint({ mdl: [model], stp: ANSWERS_STEP }) }, body: (async function* () { yield Buffer.from(JSON.stringify(f.body)); })() }, sink);
  expect(sink.status).toBe(409); expect(reserve).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
});
it("fails closed when a truncated JPEG fill-marker run cannot supply a dimension segment", () => {
  expect(guard([image(Buffer.from("ffd8ffffffff", "hex"), "jpeg")])).toMatchObject({ inputBounded: false });
});

// IMAGE-GIF-FRAME-BOUND (N1): decoders size a GIF from its frames, not only from the logical screen.
const tokensOf = (w: number, h: number): number => Math.ceil(w / 28) * Math.ceil(h / 28) + 256;
const gifTokens = (b: Buffer) => inlineImageBound(image(b, "gif"))?.tokens;
it("real GIF bytes: the encoder output is a well-formed GIF (header, screen, frames, trailer)", () => {
  const b = gif([40, 30], [{ width: 40, height: 30 }, { width: 5, height: 5 }], { animated: true });
  expect(b.toString("latin1", 0, 6)).toBe("GIF89a");
  expect([b.readUInt16LE(6), b.readUInt16LE(8)]).toEqual([40, 30]);
  expect(b.at(-1)).toBe(0x3b);
  expect(b.subarray(0, 13 + 6 + 19).includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
});
it("gif: a frame larger than the logical screen bounds the hold by the frame (the checker's 1000x800 frame behind a 10x10 screen)", () => {
  const b = gif([10, 10], [{ width: 1000, height: 800 }]);
  expect(b.length).toBeGreaterThan(500); // real LZW data, not a bare header
  expect(gifTokens(b)).toBe(tokensOf(1000, 800));
  expect(gifTokens(b)).toBeGreaterThanOrEqual(1044);
  expect(guard([image(b, "gif")])).toMatchObject({ inputBounded: true, images: { tokens: tokensOf(1000, 800), dataBytes: image(b, "gif").source.data.length } });
});
it("gif: a frame's left+width and top+height count, not just its size", () => {
  expect(gifTokens(gif([10, 10], [{ left: 90, top: 190, width: 10, height: 10 }]))).toBe(tokensOf(100, 200));
});
it("gif: an animated GIF is bounded by its largest frame, wherever it sits", () => {
  const small = { width: 40, height: 30 };
  const large = { left: 100, top: 50, width: 300, height: 200, localTable: true };
  const opts = { animated: true };
  expect(gifTokens(gif([40, 30], [small, { width: 20, height: 20 }, large], opts))).toBe(tokensOf(400, 250)); // later frame is the largest
  expect(gifTokens(gif([40, 30], [large, small, { width: 20, height: 20 }], opts))).toBe(tokensOf(400, 250)); // first frame is the largest
  expect(gifTokens(gif([40, 30], [small, large, small], opts))).toBe(tokensOf(400, 250)); // middle frame
  // width and height are maximised independently across frames
  expect(gifTokens(gif([10, 10], [{ width: 300, height: 10 }, { width: 10, height: 200 }], opts))).toBe(tokensOf(300, 200));
});
it("gif: frames inside the screen leave the screen bound unchanged (several frames, GIF87a and GIF89a)", () => {
  const frames = [1, 2, 3, 4].map(i => ({ left: i, top: i, width: 100, height: 100 }));
  expect(gifTokens(gif([200, 200], frames, { animated: true }))).toBe(tokensOf(200, 200));
  expect(gifTokens(gif([200, 200], frames.slice(0, 1), { version: "GIF87a" }))).toBe(tokensOf(200, 200));
});
it("gif: a zero-size screen is still bounded by a real frame, and an all-zero GIF is refused", () => {
  expect(gifTokens(gif([0, 0], [{ width: 50, height: 60 }]))).toBe(tokensOf(50, 60));
  expect(gif([0, 0], [{ width: 0, height: 0 }]).length).toBeGreaterThan(13);
  expect(guard([image(gif([0, 0], [{ width: 0, height: 0 }]), "gif")])).toMatchObject({ inputBounded: false });
});
it("gif: refuses (unbounded) a GIF with no image descriptor, however large its screen header says", () => {
  expect(guard([image(gif([200, 200], []), "gif")])).toMatchObject({ ok: true, inputBounded: false }); // trailer but no frame
  expect(guard([image(gif([200, 200], [], { trailer: false }), "gif")])).toMatchObject({ inputBounded: false }); // neither
  const bare = Buffer.alloc(13); bare.write("GIF89a"); bare.writeUInt16LE(200, 6); bare.writeUInt16LE(200, 8);
  expect(guard([image(bare, "gif")])).toMatchObject({ inputBounded: false }); // the old 13-byte header-only GIF
});
it("gif: refuses a GIF that never reaches its trailer or has a malformed block", () => {
  const whole = gif([10, 10], [{ width: 300, height: 300 }, { width: 8, height: 8 }], { animated: true });
  expect(gifTokens(whole)).toBe(tokensOf(300, 300));
  expect(gifTokens(whole.subarray(0, whole.length - 1))).toBeUndefined(); // trailer missing
  for (const cut of [20, 40, 100, whole.length - 40]) expect(gifTokens(whole.subarray(0, cut)), `cut ${cut}`).toBeUndefined();
  const unknown = Buffer.from(whole); unknown[whole.length - 1] = 0x99; // unknown block type where the trailer was
  expect(gifTokens(unknown)).toBeUndefined();
  const stray = Buffer.concat([whole.subarray(0, whole.length - 1), Buffer.from([0x99, 0x3b])]); // unknown block, then a trailer
  expect(gifTokens(stray)).toBeUndefined();
  const trailing = Buffer.concat([whole.subarray(0, whole.length - 1), Buffer.from([0x2c, 1, 2])]); // descriptor cut short
  expect(gifTokens(trailing)).toBeUndefined();
});
const MAX_GIF_FRAMES_FOR_TEST = 2048;
it("gif: scans up to the frame cap (largest frame last) and refuses past it as unbounded", () => {
  const tiny = { width: 1, height: 1 };
  const atCap = gif([10, 10], [...Array.from({ length: MAX_GIF_FRAMES_FOR_TEST - 1 }, () => tiny), { width: 700, height: 500 }], { animated: true });
  expect(gifTokens(atCap)).toBe(tokensOf(700, 500));
  const pastCap = gif([10, 10], [...Array.from({ length: MAX_GIF_FRAMES_FOR_TEST }, () => tiny), { width: 700, height: 500 }], { animated: true });
  expect(pastCap.length).toBeLessThan(5 * 1024 * 1024 / 4 * 3); // a valid, in-size GIF that the cap alone refuses
  expect(gifTokens(pastCap)).toBeUndefined();
  expect(guard([image(pastCap, "gif")])).toMatchObject({ ok: true, inputBounded: false });
});

// IMAGE-GIF-FRAME-BOUND (N2): a decoder may keep the LAST start-of-frame marker; bound by every one.
const SOF_AT = 156, SOS_AT = 751;
const sof = (w: number, h: number): Buffer => { const b = Buffer.from(REAL_JPEG.subarray(SOF_AT, SOF_AT + 19)); b.writeUInt16BE(h, 5); b.writeUInt16BE(w, 7); return b; };
const withSof = (before: Buffer[], after: Buffer[]): Buffer => Buffer.concat([REAL_JPEG.subarray(0, SOF_AT), ...before, REAL_JPEG.subarray(SOF_AT, SOS_AT), ...after, REAL_JPEG.subarray(SOS_AT)]);
const jpegTokens = (b: Buffer) => inlineImageBound(image(b, "jpeg"))?.tokens;
it("jpeg: a real encoder-produced JPEG is bounded by its SOF as before", () => {
  expect([REAL_JPEG.subarray(SOF_AT, SOF_AT + 2).toString("hex"), REAL_JPEG.subarray(SOS_AT, SOS_AT + 2).toString("hex")]).toEqual(["ffc0", "ffda"]);
  expect(jpegTokens(REAL_JPEG)).toBe(tokensOf(16, 16));
  expect(guard([image(REAL_JPEG, "jpeg")])).toMatchObject({ inputBounded: true, images: { tokens: 257 } });
});
it("jpeg: a later or earlier larger SOF bounds the hold (first-SOF-only and last-SOF-only would under-count)", () => {
  expect(jpegTokens(withSof([], [sof(1000, 800)]))).toBe(tokensOf(1000, 800)); // decoder keeps the last
  expect(jpegTokens(withSof([sof(1000, 800)], []))).toBe(tokensOf(1000, 800)); // decoder keeps the first
  expect(jpegTokens(withSof([sof(1000, 10)], [sof(10, 800)]))).toBe(tokensOf(1000, 800)); // each side maximised
  expect(jpegTokens(withSof([sof(8, 8)], [sof(9, 9), sof(300, 200)]))).toBe(tokensOf(300, 200)); // several
});
it("jpeg: refuses a JPEG with no SOS, a malformed extra SOF, or a stray standalone marker in the header", () => {
  expect(jpegTokens(REAL_JPEG.subarray(0, SOS_AT))).toBeUndefined(); // SOF but the scan never reaches SOS
  expect(jpegTokens(REAL_JPEG.subarray(0, SOS_AT + 5))).toBeUndefined(); // SOS segment cut short
  const badSof = sof(1000, 800).subarray(0, 18); // extra SOF whose segment is shorter than its length claims
  expect(jpegTokens(withSof([], [badSof]))).toBeUndefined();
  for (const marker of [0xd8, 0xd9, 0xd0, 0x01]) expect(jpegTokens(withSof([], [Buffer.from([0xff, marker, 0, 2])])), `marker ${marker}`).toBeUndefined();
});
