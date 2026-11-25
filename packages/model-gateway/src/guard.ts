import { inlineImageBound, MAX_INLINE_IMAGES, type InlineImageBound } from "./inline-image.js";
import { record, whole } from "./model-gateway-token.js";
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_BODY_ITEMS = 1_000_000;
export const ALLOWED_BETAS = new Set(["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"]);
/** Request selectors and exposure live together: the guard reads this policy directly.
 * Media here means separate token-billing routes, not inline Anthropic content. */
const FEATURE_POLICY = {
  custom_tools: { exposed: true, toolTypes: ["custom"], requestFields: [] },
  web_search: { exposed: false, toolTypes: ["web_search"], requestFields: [] },
  priority_service: { exposed: false, toolTypes: [], requestFields: ["service_tier"] },
  audio_tokens: { exposed: false, toolTypes: [], requestFields: [] },
  image_tokens: { exposed: false, toolTypes: [], requestFields: [] },
} satisfies Record<string, { exposed: boolean; toolTypes: string[]; requestFields: string[] }>;
export const GATEWAY_FEATURE_NAMES = Object.keys(FEATURE_POLICY);
export const GATEWAY_EXPOSED_FEATURES: ReadonlySet<string> = new Set(Object.entries(FEATURE_POLICY).filter(([, policy]) => policy.exposed).map(([feature]) => feature));
const exposedPolicies = Object.entries(FEATURE_POLICY).filter(([feature]) => GATEWAY_EXPOSED_FEATURES.has(feature)).map(([, policy]) => policy);
const TOOL_TYPES: ReadonlySet<string> = new Set(exposedPolicies.flatMap((policy) => policy.toolTypes));
const FIELDS = new Set(["model", "messages", "max_tokens", "stream", "system", "temperature", "thinking", "output_config", "tool_choice", "tools", "metadata", ...exposedPolicies.flatMap((policy) => policy.requestFields)]);
const CHOICES = new Set(["auto", "any", "none", "required", "tool", "function"]);
export interface GuardFailure { ok: false; status: number; code: string; message: string }
export interface ModelLimitsSource { maxOutputTokens(provider: string, model: string): unknown }
export interface GuardedRequest { ok: true; hasTools: boolean; inputBounded: boolean; usesPromptCache: boolean; images?: InlineImageBound; model: string; maxTokens: number; streaming: boolean; bytes: Buffer; headers: Readonly<Record<string, string>> }
const bad = (): GuardFailure => ({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" });
export const tooLarge = (): GuardFailure => ({ ok: false, status: 413, code: "request_too_large", message: "the request is too large" });
const tool = (v: unknown): boolean => { const t = record(v); return t !== undefined && (t.type === undefined || t.type === null || (typeof t.type === "string" && TOOL_TYPES.has(t.type))); };
const tools = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.every(tool));
/** Anthropic-only port of Code local/model-proxy/providers.ts. Fixed refusal words replace echoed field names. */
export function guardRequest(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, models: readonly string[], modelLimits: ModelLimitsSource): GuardedRequest | GuardFailure {
  if (bytes.length > MAX_BODY_BYTES) return tooLarge();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers["content-type"] ?? "")) return bad();
  if (Object.keys(headers).some((h) => h.startsWith("x-litellm-") || ["openai-organization", "openai-project", "x-api-key-override"].includes(h))) return bad();
  if (Object.keys(headers).length > 64 || Object.entries(headers).reduce((total, [name, value]) => total + name.length + (value?.length ?? 0), 0) > 16384) return bad();
  const beta = headers["anthropic-beta"];
  if (beta !== undefined && (beta.length > 1024 || beta.split(",").some((s) => !ALLOWED_BETAS.has(s.trim())))) return bad();
  let b: Record<string, unknown> | undefined;
  try { b = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); } catch { return bad(); }
  if (b === undefined || Object.keys(b).some((k) => !FIELDS.has(k))) return bad();
  if (typeof b.model !== "string" || !models.includes(b.model) || !Array.isArray(b.messages)) return bad();
  if (b.max_tokens !== undefined && (!whole(b.max_tokens) || b.max_tokens < 1)) return bad();
  if (b.stream !== undefined && typeof b.stream !== "boolean") return bad();
  if (b.temperature !== undefined && (typeof b.temperature !== "number" || !Number.isFinite(b.temperature) || b.temperature < 0 || b.temperature > 1)) return bad();
  const metadata = record(b.metadata);
  if (b.metadata !== undefined && (metadata === undefined || Object.keys(metadata).some((k) => k !== "user_id") || (metadata.user_id !== undefined && typeof metadata.user_id !== "string"))) return bad();
  if (!tools(b.tools)) return bad();
  const choice = b.tool_choice;
  if (choice !== undefined && choice !== null && !(typeof choice === "string" ? CHOICES.has(choice) : typeof record(choice)?.type === "string" && CHOICES.has(record(choice)!.type as string))) return bad();
  // Single iterative traversal, one total item limit (including nested argument data). Never skip an unparsed suffix.
  type WalkKind = "message" | "block" | "payload";
  const stack: Array<{ value: unknown; kind: WalkKind }> = [{ value: b.messages, kind: "message" }, { value: b.system, kind: "block" }];
  let count = 0;
  let inputBounded = true;
  const images = { tokens: 0, dataBytes: 0 };
  let imageCount = 0;
  // Inline cache breakpoints change the rate, not the byte-derived token ceiling.
  let usesPromptCache = Array.isArray(b.tools) && b.tools.some((value: unknown) => record(value)?.cache_control !== undefined);
  while (stack.length > 0) {
    if (++count > MAX_BODY_ITEMS) return bad();
    const { value: v, kind } = stack.pop()!;
    if (Array.isArray(v)) { for (const x of v) stack.push({ value: x, kind }); }
    else {
      const r = record(v); if (r === undefined) continue;
      // Classify only content blocks. Inline reasoning and function payloads are
      // bounded by serialized bytes; inline images use their header-derived bound.
      // Remote data and unknown blocks remain unbounded.
      if (kind === "block") {
        if (r.type === "image") {
          imageCount++;
          const bound = inlineImageBound(r);
          if (bound === undefined || imageCount > MAX_INLINE_IMAGES) inputBounded = false;
          else { images.tokens += bound.tokens; images.dataBytes += bound.dataBytes; }
        } else if (typeof r.type !== "string" || !["text", "tool_use", "tool_result", "thinking", "redacted_thinking"].includes(r.type) || Object.hasOwn(r, "source")) inputBounded = false;
        if (["fileData", "cachedContent"].some((k) => Object.hasOwn(r, k))) inputBounded = false;
      }
      if (kind !== "payload") {
        if (Object.hasOwn(r, "cache_control")) usesPromptCache = true;
        if (Object.hasOwn(r, "tools") && !tools(r.tools)) return bad();
        if (r.type === "tool_addition" && (record(r.tool)?.type !== "tool_definition" || !tool(record(r.tool)?.definition))) return bad();
        if (r.type === "tool_definition" && !tool(r.definition)) return bad();
      }
      for (const [k, x] of Object.entries(r)) {
        if (k === "cache_control") continue; // Cache policy is not an input content block.
        // Tool arguments and result JSON/text remain opaque, but count toward the
        // traversal limit. Only a result's content-block array can introduce media.
        const childKind = k === "content" && (kind === "message" || (kind === "block" && r.type === "tool_result" && Array.isArray(x))) ? "block" : "payload";
        stack.push({ value: x, kind: childKind });
      }
    }
  }
  let rowMax: unknown;
  try { rowMax = modelLimits.maxOutputTokens("anthropic", b.model); } catch { return bad(); }
  if (!whole(rowMax) || rowMax < 1) return bad();
  if (typeof b.max_tokens === "number" && b.max_tokens > rowMax) return bad();
  const maxTokens = b.max_tokens ?? rowMax;
  const streaming = b.stream === true;
  const forwarded = Buffer.from(JSON.stringify({ ...b, max_tokens: maxTokens }));
  const outbound: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (beta !== undefined) outbound["anthropic-beta"] = beta;
  return { ok: true, hasTools: Array.isArray(b.tools), inputBounded, usesPromptCache, ...(imageCount === 0 ? {} : { images }), model: b.model, maxTokens, streaming, bytes: forwarded, headers: outbound };
}
