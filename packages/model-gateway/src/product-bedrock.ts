// Bring your own Bedrock, slice 2 (DEC 238, Q8): the PRODUCT route. The customer's tests (in the task sandbox) call Amazon Bedrock
// through the gateway on the company's OWN role: `/v1/product/bedrock/model/{id}/{converse,converse-stream,invoke,invoke-with-response-stream}`.
// The AWS SDK in the sandbox is pointed at the worker's local port (AWS_ENDPOINT_URL_BEDROCK_RUNTIME) with dummy credentials; the worker
// removes them and adds the task token (product-bridge.ts PRODUCT_BEDROCK_BRIDGE, contract v2); the gateway signs for the company's own
// session (bedrock-byo-sessions.ts). What this module holds: the path, the body guards, the answers' usage readers (Bedrock bills the
// customer; the gateway only counts, at list price, under the one combined company cap) and the passthrough transport.
//
// Scope (DEC 238 Q8): Converse and ConverseStream for every model; InvokeModel(WithResponseStream) only for Claude's Anthropic body and
// the Titan text embedding models. Refused with fixed words: provisioned throughput, guardrails, priority or latency-optimised tiers,
// application inference profiles, prompt-management ARNs, every other InvokeModel body, and a model the company did not pick.
import { randomUUID } from "node:crypto";
import type { ClientRequest } from "node:http";
import https from "node:https";
import { signRequest } from "./aws.js";
import { BEDROCK_EMBEDDING_ID, type BedrockConnection } from "./bedrock-byo.js";
import { BEDROCK_CONVERSE_ID } from "./bedrock-converse.js";
import { BedrockStreamToSse, EventStreamDecoder, EventStreamError, type EventStreamMessage } from "./bedrock-event-stream.js";
import { BEDROCK_CLAUDE_ID, type BedrockTransportOptions } from "./bedrock-transport.js";
import { ALLOWED_BETAS, guardRequest, MAX_BODY_BYTES, MAX_BODY_ITEMS, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import { record, whole, type TaskClaims } from "./model-gateway-token.js";
import { CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS } from "./bedrock-converse.js";
import { NotSentError, type ProviderResponse, type ProviderTransport } from "./provider.js";
import type { RouteCall, UsageReader } from "./server.js";
import { UsageCollector, type TokenUsage } from "./usage.js";

export const PRODUCT_BEDROCK_PREFIX = "/v1/product/bedrock/model/";
export const BEDROCK_PRODUCT_OPS = ["converse", "converse-stream", "invoke", "invoke-with-response-stream"] as const;
export type BedrockProductOp = typeof BEDROCK_PRODUCT_OPS[number];
export type BedrockFamily = "claude" | "embedding" | "converse";
/** The answer's content type for a streaming call: AWS's binary event stream (the SDK decodes it as it comes). */
export const EVENT_STREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";

// ---- Fixed words (the bridge contract lists the types) -------------------------------------------------------------------------
export const PRODUCT_BEDROCK_FEATURE = "this Bedrock feature is not offered on the product route: guardrails, priority or latency tiers, provisioned throughput and application inference profiles are refused";
export const PRODUCT_BEDROCK_MODEL = "this model is not one your company picked for its Bedrock connection";
export const PRODUCT_BEDROCK_OPERATION = "this model is not offered this way on the product route: Converse for every picked model, InvokeModel only for Claude's Anthropic body and Titan text embeddings";
export const PRODUCT_BEDROCK_NOT_CONNECTED = "no Bedrock role is connected for this project";
export const PRODUCT_BEDROCK_REFUSED = "not run: AWS refused the connected role (check the Bedrock connection in Settings)";
export const PRODUCT_BEDROCK_MODEL_NOT_ENABLED = "this model is not enabled yet in your AWS account: an AWS admin opens it once in the Bedrock console, then try again";
export const PRODUCT_BEDROCK_THROTTLED = "Bedrock is limiting this account; try again later";
export const PRODUCT_BEDROCK_QUOTA = "the Bedrock quota for this account is used up";
const notAllowed = (message: string): GuardFailure => ({ ok: false, status: 400, code: "not_allowed", message });
const bad = (): GuardFailure => ({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" });

// ---- The path ----------------------------------------------------------------------------------------------------------------------
export interface BedrockProductPath { modelId: string; op: BedrockProductOp; streaming: boolean; converse: boolean; /** An ARN (provisioned throughput, an application inference profile, a prompt): refused with the feature words. */ arn: boolean }
/** The model id as it appears in a Bedrock request path (":" as the SDK sends it, %3A). */
const PATH_ID = /^[A-Za-z0-9.:%-]{1,2048}$/u;
/**
 * `/v1/product/bedrock/model/{id}/{op}` with no query. The id is decoded once (only %3A is a valid escape); an ARN is a recognised
 * request that is refused later with the feature words, anything else malformed is not a route at all (404).
 */
export function parseBedrockProductPath(path: string, query: string): BedrockProductPath | undefined {
  if (query !== "" || !path.startsWith(PRODUCT_BEDROCK_PREFIX)) return undefined;
  const rest = path.slice(PRODUCT_BEDROCK_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash < 1) return undefined;
  const raw = rest.slice(0, slash); const op = rest.slice(slash + 1);
  if (!BEDROCK_PRODUCT_OPS.some((o) => o === op)) return undefined;
  // An ARN (the SDK encodes its ":" and "/"): recognised only to be refused, kept as sent and never used.
  if (/^arn(?::|%3A)/iu.test(raw)) return /^[A-Za-z0-9.:%/_-]{1,2048}$/u.test(raw) ? { modelId: raw, op: op as BedrockProductOp, streaming: op === "converse-stream" || op === "invoke-with-response-stream", converse: op === "converse" || op === "converse-stream", arn: true } : undefined;
  if (!PATH_ID.test(raw) || /%(?!3A)/iu.test(raw)) return undefined;
  const modelId = raw.replaceAll(/%3A/giu, ":");
  const arn = false;
  if (!/^[a-z0-9][a-z0-9.:-]{1,200}$/u.test(modelId)) return undefined;
  return { modelId, op: op as BedrockProductOp, streaming: op === "converse-stream" || op === "invoke-with-response-stream", converse: op === "converse" || op === "converse-stream", arn };
}
/** The request path sent to Bedrock for a checked id and operation (encoded as AWS's SDKs send it). */
export function bedrockProductPath(modelId: string, op: BedrockProductOp): string {
  if (!BEDROCK_PRODUCT_OPS.some((o) => o === op) || bedrockFamily(modelId) === undefined) throw new Error("invalid bedrock model");
  return `/model/${encodeURIComponent(modelId)}/${op}`;
}
/** The model's family, or undefined for an id the product route never serves. */
export function bedrockFamily(id: string): BedrockFamily | undefined {
  if (BEDROCK_EMBEDDING_ID.test(id)) return "embedding";
  if (BEDROCK_CLAUDE_ID.test(id)) return "claude";
  return BEDROCK_CONVERSE_ID.test(id) ? "converse" : undefined;
}
/** Every operation a family is offered with: Converse for all, InvokeModel for Claude (Anthropic body) and the embedding models only. */
export function familyAllows(family: BedrockFamily, op: BedrockProductOp): boolean {
  if (family === "embedding") return op === "invoke";
  if (family === "claude") return true;
  return op === "converse" || op === "converse-stream";
}
/** The ids the company picked for its product calls: the agents' Claude picks and the product models. */
export function productAllowList(connection: Pick<BedrockConnection, "models" | "productModels">): ReadonlySet<string> {
  return new Set([...Object.values(connection.models), ...(connection.productModels ?? [])]);
}

// ---- The guards ------------------------------------------------------------------------------------------------------------------
const CREDENTIAL_HEADER = /^(?:authorization|x-amz-security-token|x-amz-bedrock-|x-amzn-bedrock-)/u;
/** Request headers that carry a credential, or select a feature the route refuses (guardrails, performance or service tier, trace). */
function headersRefused(headers: Readonly<Record<string, string | undefined>>): boolean {
  // The SDK's own content negotiation headers on a streaming InvokeModel are harmless (the transport sends its own); every other
  // x-amzn-bedrock-* header (guardrail, trace, performance config, service tier) is a refused feature.
  return Object.keys(headers).some((name) => { const lower = name.toLowerCase(); return CREDENTIAL_HEADER.test(lower) && lower !== "x-amzn-bedrock-accept" && lower !== "x-amzn-bedrock-content-type"; });
}
function headerShapeOk(headers: Readonly<Record<string, string | undefined>>): boolean {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers["content-type"] ?? "")) return false;
  return Object.keys(headers).length <= 64 && Object.entries(headers).reduce((total, [name, value]) => total + name.length + (value?.length ?? 0), 0) <= 16384;
}
/** The row's own output ceiling for the model, else the Converse default (a model with no row is held to 4,096 tokens, never more). */
function outputCeiling(modelLimits: ModelLimitsSource, id: string): number {
  let row: unknown;
  try { row = modelLimits.maxOutputTokens("bedrock", id); } catch { return CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS; }
  return whole(row) && row >= 1 ? row : CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS;
}
const REQUEST_METADATA_VALUE = /^[A-Za-z0-9\s:_@$#=/+,.-]{1,256}$/u;
const text = (v: unknown): v is string => typeof v === "string";
const unitInterval = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const onlyKeys = (r: Record<string, unknown>, keys: readonly string[]) => Object.keys(r).every((k) => keys.includes(k));
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]) => onlyKeys(r, keys) && keys.every((k) => Object.hasOwn(r, k));
/** What a request must already be before any model is named: the route's checks on bytes, headers and the model. */
export interface BedrockGuardInput {
  bytes: Buffer; headers: Readonly<Record<string, string | undefined>>; path: BedrockProductPath; connection: BedrockConnection; claims: TaskClaims; modelLimits: ModelLimitsSource;
}
type Verdict = { bounded: boolean } | undefined;
const MEDIA_FORMATS: Readonly<Record<string, readonly string[]>> = { image: ["png", "jpeg", "gif", "webp"], video: ["mkv", "mov", "mp4", "webm", "flv", "mpeg", "mpg", "wmv", "three_gp"], document: ["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"] };
/** One inline media block: the bytes in the request (never an S3 location: not byte-bounded, and the role holds no S3 rights). */
function mediaBlock(kind: "image" | "video" | "document", value: unknown): boolean {
  const m = record(value);
  if (m === undefined || !onlyKeys(m, kind === "document" ? ["format", "name", "source"] : ["format", "source"]) || !text(m.format) || !MEDIA_FORMATS[kind]!.includes(m.format)) return false;
  if (kind === "document" && m.name !== undefined && (!text(m.name) || m.name.length > 200)) return false;
  const source = record(m.source);
  return source !== undefined && exactKeys(source, ["bytes"]) && text(source.bytes);
}
/** A JSON value of any shape (tool input and schemas): bounded by the request's own item count. */
const jsonValue = (v: unknown): boolean => v === null || ["string", "number", "boolean", "object"].includes(typeof v);
const SUPPORTED_TOOL_RESULT: ReadonlyArray<readonly [string, (v: unknown) => Verdict]> = [
  ["text", (v) => text(v) ? { bounded: true } : undefined],
  ["json", (v) => jsonValue(v) && v !== undefined ? { bounded: true } : undefined],
  ["image", (v) => mediaBlock("image", v) ? { bounded: false } : undefined],
  ["document", (v) => mediaBlock("document", v) ? { bounded: false } : undefined],
  ["video", (v) => mediaBlock("video", v) ? { bounded: false } : undefined],
];
const CACHE_POINT = (v: unknown): boolean => { const c = record(v); return c !== undefined && onlyKeys(c, ["type", "ttl"]) && c.type === "default" && (c.ttl === undefined || c.ttl === "5m" || c.ttl === "1h"); };
/** One content block of a message: exactly one known kind. `bounded` false when its input tokens can't be read off its bytes. */
function contentBlock(block: unknown): Verdict {
  const b = record(block);
  if (b === undefined) return undefined;
  const keys = Object.keys(b);
  if (keys.length !== 1) return undefined;
  const kind = keys[0]!; const value = b[kind];
  switch (kind) {
    case "text": return text(value) ? { bounded: true } : undefined;
    case "image": case "video": case "document": return mediaBlock(kind, value) ? { bounded: false } : undefined;
    case "cachePoint": return CACHE_POINT(value) ? { bounded: false } : undefined;
    case "toolUse": {
      const t = record(value);
      return t !== undefined && onlyKeys(t, ["toolUseId", "name", "input"]) && text(t.toolUseId) && text(t.name) && jsonValue(t.input) && t.input !== undefined ? { bounded: true } : undefined;
    }
    case "toolResult": {
      const t = record(value);
      if (t === undefined || !onlyKeys(t, ["toolUseId", "content", "status"]) || !text(t.toolUseId) || !Array.isArray(t.content) || (t.status !== undefined && t.status !== "success" && t.status !== "error")) return undefined;
      let bounded = true;
      for (const item of t.content) {
        const r = record(item); const k = r === undefined ? [] : Object.keys(r);
        const rule = k.length === 1 ? SUPPORTED_TOOL_RESULT.find(([name]) => name === k[0]) : undefined;
        const verdict = rule === undefined ? undefined : rule[1](r![k[0]!]);
        if (verdict === undefined) return undefined;
        bounded &&= verdict.bounded;
      }
      return { bounded };
    }
    case "reasoningContent": {
      const r = record(value);
      if (r === undefined) return undefined;
      const k = Object.keys(r);
      if (k.length !== 1) return undefined;
      if (k[0] === "redactedContent") return text(r.redactedContent) ? { bounded: true } : undefined;
      const t = record(r.reasoningText);
      return k[0] === "reasoningText" && t !== undefined && onlyKeys(t, ["text", "signature"]) && text(t.text) && (t.signature === undefined || text(t.signature)) ? { bounded: true } : undefined;
    }
    // guardContent (guardrails), citations, search results and anything new: not offered.
    default: return undefined;
  }
}
function messagesOk(messages: unknown): { ok: boolean; bounded: boolean } {
  if (!Array.isArray(messages) || messages.length < 1) return { ok: false, bounded: true };
  let bounded = true;
  for (const m of messages) {
    const message = record(m);
    if (message === undefined || !exactKeys(message, ["role", "content"]) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content) || message.content.length < 1) return { ok: false, bounded };
    for (const block of message.content) {
      const verdict = contentBlock(block);
      if (verdict === undefined) return { ok: false, bounded };
      bounded &&= verdict.bounded;
    }
  }
  return { ok: true, bounded };
}
function systemOk(system: unknown): { ok: boolean; bounded: boolean } {
  if (system === undefined) return { ok: true, bounded: true };
  if (!Array.isArray(system)) return { ok: false, bounded: true };
  let bounded = true;
  for (const s of system) {
    const r = record(s); const k = r === undefined ? [] : Object.keys(r);
    if (r === undefined || k.length !== 1) return { ok: false, bounded };
    if (k[0] === "text" && text(r.text)) continue;
    if (k[0] === "cachePoint" && CACHE_POINT(r.cachePoint)) { bounded = false; continue; }
    return { ok: false, bounded };
  }
  return { ok: true, bounded };
}
/** `toolConfig`: client tools (`toolSpec`) and cache points only; a system tool (grounding, code interpreter) is billed apart: refused. */
function toolConfigOk(config: unknown): { ok: boolean; bounded: boolean; hasTools: boolean } {
  if (config === undefined) return { ok: true, bounded: true, hasTools: false };
  const c = record(config);
  if (c === undefined || !onlyKeys(c, ["tools", "toolChoice"]) || !Array.isArray(c.tools) || c.tools.length < 1) return { ok: false, bounded: true, hasTools: false };
  let bounded = true;
  for (const tool of c.tools) {
    const t = record(tool); const k = t === undefined ? [] : Object.keys(t);
    if (t === undefined || k.length !== 1) return { ok: false, bounded, hasTools: true };
    if (k[0] === "cachePoint" && CACHE_POINT(t.cachePoint)) { bounded = false; continue; }
    const spec = record(t.toolSpec); const schema = record(spec?.inputSchema);
    if (k[0] !== "toolSpec" || spec === undefined || !onlyKeys(spec, ["name", "description", "inputSchema", "strict"]) || !text(spec.name) || (spec.description !== undefined && !text(spec.description))
      || schema === undefined || !exactKeys(schema, ["json"]) || record(schema.json) === undefined || (spec.strict !== undefined && typeof spec.strict !== "boolean")) return { ok: false, bounded, hasTools: true };
  }
  if (c.toolChoice !== undefined) {
    const choice = record(c.toolChoice); const k = choice === undefined ? [] : Object.keys(choice);
    const named = k[0] === "tool" ? record(choice?.tool) : undefined;
    if (choice === undefined || k.length !== 1 || !(k[0] === "auto" || k[0] === "any" || k[0] === "tool") || (k[0] !== "tool" && record(choice[k[0]]) === undefined) || (k[0] === "tool" && (named === undefined || !exactKeys(named, ["name"]) || !text(named.name)))) return { ok: false, bounded, hasTools: true };
  }
  return { ok: true, bounded, hasTools: true };
}
/** `additionalModelRequestFields`: only fields that shape a model's answer and change no price tier (an allowed Anthropic beta, top_k, a thinking budget). */
function additionalOk(value: unknown): boolean {
  if (value === undefined) return true;
  const a = record(value);
  if (a === undefined || !onlyKeys(a, ["top_k", "thinking", "anthropic_beta"])) return false;
  if (a.top_k !== undefined && !whole(a.top_k)) return false;
  if (a.anthropic_beta !== undefined && !(Array.isArray(a.anthropic_beta) && a.anthropic_beta.length <= 8 && a.anthropic_beta.every((b: unknown) => text(b) && ALLOWED_BETAS.has(b)))) return false;
  if (a.thinking !== undefined) {
    const t = record(a.thinking);
    if (t === undefined || !onlyKeys(t, ["type", "budget_tokens"]) || (t.type !== "enabled" && t.type !== "disabled") || (t.budget_tokens !== undefined && !whole(t.budget_tokens))) return false;
  }
  return true;
}
/** Every value in the request, counted once (one iterative walk: a total limit on items, never a pattern x item loop). */
function countItems(root: unknown): boolean {
  const stack: unknown[] = [root]; let count = 0;
  while (stack.length > 0) {
    if (++count > MAX_BODY_ITEMS) return false;
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) stack.push(x); }
    else if (v !== null && typeof v === "object") { for (const x of Object.values(v)) stack.push(x); }
  }
  return true;
}
const parseBody = (bytes: Buffer): Record<string, unknown> | undefined => {
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); } catch { return undefined; }
};
/** Fields whose presence is the refused features themselves (guardrails, performance or service tiers): the feature words, not "invalid". */
const FEATURE_FIELDS = ["guardrailConfig", "performanceConfig", "serviceTier", "service_tier"];
const done = (call: Omit<RouteCall, "ok" | "headers" | "streaming" | "path"> & { path: BedrockProductPath }): RouteCall => {
  const { path, ...rest } = call;
  return { ok: true, ...rest, streaming: path.streaming, headers: { "content-type": "application/json" }, path: bedrockProductPath(path.modelId, path.op), ...(path.streaming ? { streamContentType: EVENT_STREAM_CONTENT_TYPE } : {}) };
};

/**
 * The product route's guard for one request. Order: the model and the operation, then credentials and feature headers, then the
 * body; nothing of the body is read for a model the company did not pick. Always a fixed refusal, never the request's words.
 */
export function guardBedrockProduct(input: BedrockGuardInput): RouteCall | GuardFailure {
  const { bytes, headers, path, connection, claims, modelLimits } = input;
  if (path.arn) return notAllowed(PRODUCT_BEDROCK_FEATURE);
  if (!productAllowList(connection).has(path.modelId)) return notAllowed(PRODUCT_BEDROCK_MODEL);
  const family = bedrockFamily(path.modelId);
  if (family === undefined || !familyAllows(family, path.op)) return notAllowed(PRODUCT_BEDROCK_OPERATION);
  if (headersRefused(headers)) return notAllowed(PRODUCT_BEDROCK_FEATURE);
  if (bytes.length > MAX_BODY_BYTES || !headerShapeOk(headers)) return bad();
  const body = parseBody(bytes);
  if (body === undefined) return bad();
  if (FEATURE_FIELDS.some((f) => Object.hasOwn(body, f))) return notAllowed(PRODUCT_BEDROCK_FEATURE);
  if (!countItems(body)) return bad();
  if (path.converse) return guardConverse(body, path, claims, modelLimits);
  return family === "embedding" ? guardEmbedding(body, path) : guardAnthropicInvoke(body, path, modelLimits);
}

function guardConverse(body: Record<string, unknown>, path: BedrockProductPath, claims: TaskClaims, modelLimits: ModelLimitsSource): RouteCall | GuardFailure {
  // requestMetadata is the gateway's alone: a caller's value is overwritten (never trusted, so the customer's logs join to Rovara's task).
  if (!onlyKeys(body, ["messages", "system", "inferenceConfig", "toolConfig", "additionalModelRequestFields", "requestMetadata"])) return bad();
  const messages = messagesOk(body.messages); const system = systemOk(body.system); const tools = toolConfigOk(body.toolConfig);
  if (!messages.ok || !system.ok || !tools.ok || !additionalOk(body.additionalModelRequestFields)) return bad();
  if (body.requestMetadata !== undefined && record(body.requestMetadata) === undefined) return bad();
  const config = body.inferenceConfig === undefined ? {} : record(body.inferenceConfig);
  if (config === undefined || !onlyKeys(config, ["maxTokens", "temperature", "topP", "stopSequences"])) return bad();
  if (config.maxTokens !== undefined && (!whole(config.maxTokens) || config.maxTokens < 1)) return bad();
  if ((config.temperature !== undefined && !unitInterval(config.temperature)) || (config.topP !== undefined && !unitInterval(config.topP))) return bad();
  if (config.stopSequences !== undefined && !(Array.isArray(config.stopSequences) && config.stopSequences.length <= 8 && config.stopSequences.every((s: unknown) => text(s) && s.length >= 1 && s.length <= 256))) return bad();
  const ceiling = outputCeiling(modelLimits, path.modelId);
  if (typeof config.maxTokens === "number" && config.maxTokens > ceiling) return bad();
  const maxTokens = typeof config.maxTokens === "number" ? config.maxTokens : ceiling;
  const metadata = { rovara_project: claims.pid, rovara_task: claims.tid };
  if (!Object.values(metadata).every((v) => REQUEST_METADATA_VALUE.test(v))) return bad();
  const forwarded = { ...body, inferenceConfig: { ...config, maxTokens }, requestMetadata: metadata };
  return done({ hasTools: tools.hasTools, inputBounded: messages.bounded && system.bounded && tools.bounded, model: path.modelId, maxTokens, bytes: Buffer.from(JSON.stringify(forwarded)), path });
}

/** Claude through InvokeModel: the Anthropic Messages body Bedrock takes (same traversal and limits as the agent route's guard, one extra field set). */
function guardAnthropicInvoke(body: Record<string, unknown>, path: BedrockProductPath, modelLimits: ModelLimitsSource): RouteCall | GuardFailure {
  const extra = ["anthropic_version", "top_p", "top_k", "stop_sequences", "anthropic_beta"];
  if (body.anthropic_version !== "bedrock-2023-05-31" || !Array.isArray(body.messages) || body.messages.length < 1) return bad();
  if (body.top_p !== undefined && !unitInterval(body.top_p)) return bad();
  if (body.top_k !== undefined && !whole(body.top_k)) return bad();
  if (body.stop_sequences !== undefined && !(Array.isArray(body.stop_sequences) && body.stop_sequences.length <= 8 && body.stop_sequences.every((s: unknown) => text(s) && s.length >= 1 && s.length <= 256))) return bad();
  if (body.anthropic_beta !== undefined && !(Array.isArray(body.anthropic_beta) && body.anthropic_beta.length <= 8 && body.anthropic_beta.every((b: unknown) => text(b) && ALLOWED_BETAS.has(b)))) return bad();
  // The Messages body checks (fields, tools, nested items, output ceiling) are the agent route's own: the body is shown to that guard
  // without Bedrock's extra fields. `metadata` is not part of Bedrock's body; service_tier and every other field fail there.
  const core = Object.fromEntries(Object.entries(body).filter(([name]) => !extra.includes(name)));
  const ceiling = outputCeiling(modelLimits, path.modelId);
  const checked = guardRequest(Buffer.from(JSON.stringify({ ...core, model: path.modelId })), { "content-type": "application/json" }, [path.modelId], { maxOutputTokens: () => ceiling });
  if (!checked.ok) return checked;
  if (Object.hasOwn(body, "metadata") || Object.hasOwn(body, "model") || Object.hasOwn(body, "stream")) return bad();
  const forwarded = JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>;
  delete forwarded.model;
  const out = { anthropic_version: "bedrock-2023-05-31", ...forwarded, ...Object.fromEntries(Object.entries(body).filter(([name]) => extra.includes(name) && name !== "anthropic_version")) };
  return done({ hasTools: checked.hasTools, inputBounded: checked.inputBounded, usesPromptCache: checked.usesPromptCache, ...(checked.images === undefined ? {} : { images: checked.images }), model: path.modelId, maxTokens: checked.maxTokens, bytes: Buffer.from(JSON.stringify(out)), path });
}

/** Titan text embeddings: one text in, one vector out (V2 may name dimensions, normalize and the vector types). The answer carries the token count. */
export const EMBEDDING_INPUT_MAX_BYTES = 200_000;
function guardEmbedding(body: Record<string, unknown>, path: BedrockProductPath): RouteCall | GuardFailure {
  if (!onlyKeys(body, ["inputText", "dimensions", "normalize", "embeddingTypes"]) || !text(body.inputText) || body.inputText.length < 1 || Buffer.byteLength(body.inputText, "utf8") > EMBEDDING_INPUT_MAX_BYTES) return bad();
  if (body.dimensions !== undefined && ![256, 512, 1024].includes(body.dimensions as number)) return bad();
  if (body.normalize !== undefined && typeof body.normalize !== "boolean") return bad();
  if (body.embeddingTypes !== undefined && !(Array.isArray(body.embeddingTypes) && body.embeddingTypes.length >= 1 && body.embeddingTypes.length <= 2 && body.embeddingTypes.every((t: unknown) => t === "float" || t === "binary"))) return bad();
  if ((body.dimensions !== undefined || body.normalize !== undefined || body.embeddingTypes !== undefined) && !/v2:0$/u.test(path.modelId)) return bad();
  // No output tokens to hold (the answer is a vector): one token keeps the meter's shape; the hold is the input, one token per byte.
  return done({ hasTools: false, inputBounded: true, model: path.modelId, maxTokens: 1, bytes: Buffer.from(JSON.stringify(body)), path, priceKind: "embedding" });
}

// ---- Usage -----------------------------------------------------------------------------------------------------------------------
export type BedrockUsageKind = "converse" | "converse-stream" | "anthropic" | "anthropic-stream" | "embedding";
export function bedrockUsageKind(path: BedrockProductPath, family: BedrockFamily): BedrockUsageKind {
  if (family === "embedding") return "embedding";
  if (path.converse) return path.streaming ? "converse-stream" : "converse";
  return path.streaming ? "anthropic-stream" : "anthropic";
}
const count = (v: unknown): v is number => whole(v) && v <= 1_000_000_000;
/** Converse's `usage` as token counts, or undefined when its two required counts are not whole numbers (then the call settles at its full hold). */
function converseUsage(value: unknown): TokenUsage | undefined {
  const u = record(value);
  if (u === undefined || !count(u.inputTokens) || !count(u.outputTokens)) return undefined;
  for (const optional of [u.cacheReadInputTokens, u.cacheWriteInputTokens]) if (optional !== undefined && !count(optional)) return undefined;
  return { input: u.inputTokens, output: u.outputTokens, cacheRead: (u.cacheReadInputTokens as number | undefined) ?? 0, cacheWrite: (u.cacheWriteInputTokens as number | undefined) ?? 0 };
}
const CONVERSE_EVENTS: ReadonlySet<string> = new Set(["messageStart", "contentBlockStart", "contentBlockDelta", "contentBlockStop", "messageStop", "metadata"]);

/**
 * The answer's token counts, read as the bytes pass (the customer's SDK gets the bytes unchanged): Converse JSON or its event stream,
 * Claude's Anthropic message or its event stream, or a Titan embedding. Anything unreadable (a bad frame, a missing final count,
 * an exception event) leaves the usage unknown, and the core then settles the call at its full hold, as for every route.
 */
export class BedrockUsage implements UsageReader {
  readonly #kind: BedrockUsageKind;
  readonly #decoder = new EventStreamDecoder();
  readonly #anthropic = new BedrockStreamToSse();
  readonly #collector = new UsageCollector();
  #usage: TokenUsage | undefined;
  #stopped = false;
  #failed = false;
  constructor(kind: BedrockUsageKind) { this.#kind = kind; }
  push(bytes: Uint8Array): void {
    if (this.#failed) return;
    try {
      if (this.#kind === "anthropic-stream") this.#collector.push(this.#anthropic.push(bytes));
      else if (this.#kind === "converse-stream") this.#converseMessages(this.#decoder.push(bytes));
      else this.#failed = true;
    } catch { this.#failed = true; }
  }
  #converseMessages(messages: readonly EventStreamMessage[]): void {
    for (const message of messages) {
      const type = message.headers[":event-type"];
      if (message.headers[":message-type"] !== "event" || type === undefined || !CONVERSE_EVENTS.has(type) || this.#usage !== undefined) throw new EventStreamError();
      if (type === "messageStop") this.#stopped = true;
      if (type === "metadata") {
        const metadata = record(JSON.parse(message.payload.toString("utf8")) as unknown);
        const usage = converseUsage(metadata?.usage);
        if (!this.#stopped || usage === undefined) throw new EventStreamError();
        this.#usage = usage;
      }
    }
  }
  whole(value: unknown): void {
    const answer = record(value);
    if (this.#kind === "converse") { this.#usage = converseUsage(answer?.usage); if (this.#usage === undefined) this.#failed = true; }
    else if (this.#kind === "anthropic") this.#collector.whole(value);
    else if (this.#kind === "embedding") {
      const n = answer?.inputTextTokenCount;
      if (count(n)) this.#usage = { input: n, output: 0, cacheRead: 0, cacheWrite: 0 }; else this.#failed = true;
    } else this.#failed = true;
  }
  finish(): TokenUsage | undefined {
    if (this.#failed) return undefined;
    try {
      if (this.#kind === "anthropic-stream") { this.#anthropic.finish(); return this.#collector.finish(); }
      if (this.#kind === "converse-stream") { this.#decoder.finish(); return this.#usage === undefined ? undefined : { ...this.#usage }; }
      if (this.#kind === "anthropic") return this.#collector.finish();
      return this.#usage === undefined ? undefined : { ...this.#usage };
    } catch { return undefined; }
  }
}

// ---- Bedrock's errors --------------------------------------------------------------------------------------------------------------
/** The error's kind, from its words and the error type the transport put first (read only to classify, never echoed). */
export type BedrockFailureKind = "not_enabled" | "refused" | "throttled" | "quota" | "invalid" | "unavailable";
export function bedrockFailureKind(status: number, body: Uint8Array | undefined, accessWords: RegExp): BedrockFailureKind {
  const words = body === undefined ? "" : Buffer.from(body).subarray(0, 64 * 1024).toString("utf8");
  if (status === 403 && accessWords.test(words)) return "not_enabled";
  if (status === 401 || status === 403) return "refused";
  if (/^ServiceQuotaExceededException\b/u.test(words)) return "quota";
  if (status === 429 || /^ThrottlingException\b/u.test(words)) return "throttled";
  if (status === 400 || status === 404) return "invalid";
  return "unavailable";
}

// ---- Transport --------------------------------------------------------------------------------------------------------------------
const TRANSPORT_PATH = /^\/model\/([A-Za-z0-9.%-]{1,2048})\/(converse|converse-stream|invoke|invoke-with-response-stream)$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const ERROR_TYPE = /^[A-Za-z]{1,64}$/u;
async function* withErrorType(errorType: string, body: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  yield Buffer.from(`${errorType}\n`);
  yield* body;
}
/**
 * Bedrock's InvokeModel and Converse, answers passed through unchanged: the same request the route checked, signed (SigV4, service
 * "bedrock") with the company's own session. The host is built from the connection's stored Region only; the path is rebuilt here
 * from a model id the route allow-listed and an operation that family is offered with. TLS, port 443, one attempt, no redirects.
 * A failed answer carries Bedrock's error type first, so the route can tell a quota from a validation error.
 */
export function createBedrockProductTransport(options: BedrockTransportOptions): ProviderTransport {
  if (!REGION.test(options.region)) throw new Error("invalid aws region");
  const host = `bedrock-runtime.${options.region}.amazonaws.com`;
  const request = options.request ?? https.request;
  const now = options.now ?? Date.now;
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    const match = input.path === undefined ? null : TRANSPORT_PATH.exec(input.path);
    if (match === null || /%(?!3A)/iu.test(match[1]!)) throw new NotSentError();
    const modelId = match[1]!.replaceAll(/%3A/giu, ":");
    const op = match[2] as BedrockProductOp;
    const family = bedrockFamily(modelId);
    if (family === undefined || !familyAllows(family, op) || input.path !== bedrockProductPath(modelId, op)) throw new NotSentError();
    const streaming = op === "converse-stream" || op === "invoke-with-response-stream";
    let credentials;
    try { credentials = await options.credentials(); } catch { throw new NotSentError(); }
    if (input.signal.aborted) throw new NotSentError();
    const body = Buffer.from(input.body);
    const path = input.path;
    // Only these headers: nothing of the request's own (its dummy credentials are already gone) reaches AWS.
    const headers = signRequest({ method: "POST", host, path, region: options.region, service: "bedrock", body, credentials, now: new Date(now()), headers: { "content-type": "application/json", accept: streaming ? EVENT_STREAM_CONTENT_TYPE : "application/json" } });
    return new Promise<ProviderResponse>((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try {
        call = request({ hostname: host, port: 443, path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...headers, "content-length": String(body.byteLength) } }, (response) => {
          const status = response.statusCode ?? 0;
          const raw = response as AsyncIterable<Uint8Array>;
          const cancel = () => response.destroy();
          if (status >= 200 && status < 300) { resolve({ status, body: raw, cancel }); return; }
          const type = response.headers["x-amzn-errortype"];
          const errorType = typeof type === "string" ? type.split(/[:#]/u)[0]! : "";
          resolve({ status, body: withErrorType(ERROR_TYPE.test(errorType) ? errorType : "Unknown", raw), cancel });
        });
      } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(body); } catch { call.destroy(); fail(); } }
    });
  };
}
/** A call marker for the route's key port: the real credentials are the session, never a string that could leak into a body. */
export const bedrockMarker = (): string => `byo-bedrock-${randomUUID()}`;
