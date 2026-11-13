// TE-R2 part A (M2, release 0.5.19; DECISIONS 166b, 161, 167): the BRIEF, the one thing the independent reply agent is told about a model call. PURE: no I/O, no clock, no randomness; the prompt hash goes through F0a's `sha256HexOf`.
//
// The brief holds the prompt text of ONE captured call, the expected answer shape the request itself declared, the family, the operation and the model name. It holds NOTHING else: no header, query, URL, key, credential,
// request id, metadata, user field or any other body field. It is built field by field from an allow-list (an unknown field is dropped, never copied), so a field that is not named here cannot reach the agent.
//
// What the shape holds (read from the request's own body, per family):
//   OpenAI chat `response_format.json_schema.schema` and `tools[].function.{name,description,parameters}`; the Responses API `text.format` and `tools[].{name,description,parameters}`; Anthropic `tools[].input_schema`,
//   `output_config.format` and `max_tokens`; Gemini `generationConfig.responseSchema`, `responseMimeType`, `tools[].functionDeclarations`, `toolConfig` (camelCase and snake_case); Cohere `response_format` and `tools[].function`.
//
// Bounds: prompt text at most 64 KiB as UTF-8 (a longer one is `too_long`: the call is not handled and stays unmatched), each schema at most 16 KiB and depth 16, at most 16 tools, a tool description at most 2 KiB (cut), the
// body at most 1 MiB, the brief at most 256 KiB as JSON. Text that looks like a credential is MASKED (`redactText`) before the brief is formed; `promptSha256` is the hash of the prompt AS THE HELPER READ IT (before the mask), because that
// is what a reply's `match.promptSha256` compares (`selectModelReply`); the agent never sees the unmasked text.
//
// What a brief is NOT: proof of anything. `embedding` and `rerank` calls get a brief of their kind, but an answer to them is computed by the family's builder (vectors, scores), not written by a model: the agent has nothing
// to write for them (`replyAgentCanAnswer` says so). `models`, `countTokens` and `count_tokens` get no brief (`unsupported_operation`).
//
// A brief made here (or parsed back with `parseReplyBrief`, which re-checks every bound) is registered in a module-private set: the channel (`model-independent-channel.ts`) accepts only a registered brief, so a hand-made or
// spread copy of one is refused.
import { z } from "zod";
import { MODEL_ECHO_PATTERN, MODEL_REQUEST_BODY_MAX_BYTES } from "./model-family-common.js";
import { readModelRequestFacts } from "./model-request-facts.js";
import { OPERATIONS_BY_FAMILY, SERVED_MODEL_FAMILIES, isServedModelFamily, type ServedModelFamily } from "./model-served-family.js";
import { redactText } from "./redaction.js";
import { sha256HexOf } from "./service-catalog-verify.js";

export const REPLY_BRIEF_PROMPT_MAX_BYTES = 64 * 1024;
export const REPLY_BRIEF_SCHEMA_MAX_BYTES = 16 * 1024;
export const REPLY_BRIEF_SCHEMA_MAX_DEPTH = 16;
export const REPLY_BRIEF_MAX_TOOLS = 16;
export const REPLY_BRIEF_DESCRIPTION_MAX_CHARS = 2 * 1024;
export const REPLY_BRIEF_MAX_BYTES = 256 * 1024;
const SCHEMA_MAX_NODES = 4_000;

/** Why no brief was made, as fixed words (never text from the request). Each means "this call stays not counted". */
export const REPLY_BRIEF_REFUSALS = ["not_json", "unsupported_operation", "no_prompt", "too_long", "bad_schema", "bad_tools"] as const;
export type ReplyBriefRefusal = (typeof REPLY_BRIEF_REFUSALS)[number];

export const REPLY_ANSWER_KINDS = ["text", "json", "tool_call", "embedding", "rerank"] as const;
export type ReplyAnswerKind = (typeof REPLY_ANSWER_KINDS)[number];

export type ReplyJson = null | boolean | number | string | readonly ReplyJson[] | { readonly [key: string]: ReplyJson };
export type ReplyJsonObject = { readonly [key: string]: ReplyJson };

export interface ReplyTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parametersSchema?: ReplyJsonObject | undefined;
}
export interface ReplyAnswerShape {
  readonly kind: ReplyAnswerKind;
  readonly stream: boolean;
  /** `json` kind: the declared schema (absent for a bare JSON mode). */
  readonly jsonSchema?: ReplyJsonObject | undefined;
  /** `tool_call` kind: the declared function tools. */
  readonly tools?: readonly ReplyTool[] | undefined;
  /** `tool_call` kind: the request forces a tool call (`required`, `any`, a named tool). */
  readonly toolsRequired?: boolean | undefined;
  readonly forcedToolName?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
}
export interface ReplyBrief {
  readonly family: ServedModelFamily;
  readonly operation: string;
  /** The model name when the helper knows it (Gemini names it in the path, the others in the body). Absent: the reply's match has no `model`. */
  readonly model?: string | undefined;
  /** The prompt text, credential-shaped text masked. */
  readonly promptText: string;
  /** SHA-256 of the prompt text as the helper read it (before the mask): what `match.promptSha256` compares. */
  readonly promptSha256: string;
  readonly promptMasked: boolean;
  readonly shape: ReplyAnswerShape;
}
export type ReplyBriefResult = { readonly ok: true; readonly brief: ReplyBrief } | { readonly ok: false; readonly reason: ReplyBriefRefusal };

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
const own = (object: object, key: string): unknown => (Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : undefined);
const firstOwn = (object: object, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const value = own(object, key);
    if (value !== undefined) return value;
  }
  return undefined;
};
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

// ---- bounded JSON

/** Whether a value is plain JSON inside the schema bounds: depth, node count, no `__proto__` key, finite numbers, at most 16 KiB. */
function boundedJson(value: unknown): value is ReplyJson {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > SCHEMA_MAX_NODES || depth > REPLY_BRIEF_SCHEMA_MAX_DEPTH) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
    if (typeof candidate === "object") {
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.keys(candidate).every((key) => key !== "__proto__" && visit((candidate as Record<string, unknown>)[key], depth + 1));
    }
    return false;
  };
  return visit(value, 0) && utf8Bytes(JSON.stringify(value)) <= REPLY_BRIEF_SCHEMA_MAX_BYTES;
}

/** A copy of untrusted JSON on null-prototype objects (nothing is assigned onto `{}`), every string masked; undefined when the value is out of bounds. */
function copySchema(value: unknown, mask: { changed: boolean }): ReplyJsonObject | undefined {
  if (!isRecord(value) || !boundedJson(value)) return undefined;
  const copy = (candidate: ReplyJson): ReplyJson => {
    if (typeof candidate === "string") {
      const masked = redactText(candidate);
      if (masked !== candidate) mask.changed = true;
      return masked;
    }
    if (Array.isArray(candidate)) return (candidate as readonly ReplyJson[]).map(copy);
    if (typeof candidate === "object" && candidate !== null) {
      const out = Object.create(null) as Record<string, ReplyJson>;
      for (const key of Object.keys(candidate)) out[key] = copy((candidate as Record<string, ReplyJson>)[key] as ReplyJson);
      return out;
    }
    return candidate;
  };
  return copy(value) as ReplyJsonObject;
}

// ---- reading the declared shape

interface ReadTools {
  readonly tools: ReplyTool[];
  readonly ok: boolean;
}

function readTool(raw: Record<string, unknown>, mask: { changed: boolean }): { ok: true; tool: ReplyTool } | { ok: false } | undefined {
  const name = own(raw, "name");
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !TOOL_NAME.test(name)) return { ok: false };
  const description = own(raw, "description");
  const schemaRaw = firstOwn(raw, ["parameters", "input_schema", "inputSchema", "parametersJsonSchema", "parameters_json_schema"]);
  let parametersSchema: ReplyJsonObject | undefined;
  if (schemaRaw !== undefined) {
    parametersSchema = copySchema(schemaRaw, mask);
    if (parametersSchema === undefined) return { ok: false };
  }
  let text: string | undefined;
  if (typeof description === "string") {
    const cut = description.slice(0, REPLY_BRIEF_DESCRIPTION_MAX_CHARS);
    text = redactText(cut);
    if (text !== cut) mask.changed = true;
  }
  return { ok: true, tool: { name, ...(text === undefined ? {} : { description: text }), ...(parametersSchema === undefined ? {} : { parametersSchema }) } };
}

function readTools(body: Record<string, unknown>, mask: { changed: boolean }): ReadTools {
  const list = own(body, "tools");
  const tools: ReplyTool[] = [];
  if (!Array.isArray(list)) return { tools, ok: true };
  const add = (raw: unknown): boolean => {
    if (!isRecord(raw)) return true;
    const found = readTool(raw, mask);
    if (found === undefined) return true;
    if (!found.ok) return false;
    tools.push(found.tool);
    return tools.length <= REPLY_BRIEF_MAX_TOOLS;
  };
  for (const entry of list.slice(0, REPLY_BRIEF_MAX_TOOLS + 1)) {
    if (!isRecord(entry)) continue;
    const declarations = firstOwn(entry, ["functionDeclarations", "function_declarations"]);
    if (Array.isArray(declarations)) {
      for (const declaration of declarations.slice(0, REPLY_BRIEF_MAX_TOOLS + 1)) if (!add(declaration)) return { tools, ok: false };
      continue;
    }
    const fn = own(entry, "function");
    if (isRecord(fn)) {
      if (!add(fn)) return { tools, ok: false };
      continue;
    }
    // Anthropic (`name` + `input_schema`, no `type` or `custom`) and the Responses API (`type: function`). A built-in tool (`web_search_...`) is not a function the agent can emulate.
    const type = own(entry, "type");
    if (type === undefined || type === "function" || type === "custom") if (!add(entry)) return { tools, ok: false };
  }
  return { tools, ok: tools.length <= REPLY_BRIEF_MAX_TOOLS };
}

interface ToolChoice {
  readonly none: boolean;
  readonly required: boolean;
  readonly forcedName?: string | undefined;
}
function readToolChoice(body: Record<string, unknown>): ToolChoice {
  const config = firstOwn(body, ["toolConfig", "tool_config"]);
  const calling = isRecord(config) ? firstOwn(config, ["functionCallingConfig", "function_calling_config"]) : undefined;
  const choice = firstOwn(body, ["tool_choice", "toolChoice"]) ?? (isRecord(calling) ? own(calling, "mode") : undefined);
  if (typeof choice === "string") {
    const word = choice.toLowerCase();
    return { none: word === "none", required: word === "required" || word === "any" };
  }
  if (isRecord(choice)) {
    const type = own(choice, "type");
    if (type === "auto" || type === "none") return { none: type === "none", required: false };
    const fn = own(choice, "function");
    const named = own(choice, "name") ?? (isRecord(fn) ? own(fn, "name") : undefined);
    return { none: false, required: true, forcedName: typeof named === "string" && TOOL_NAME.test(named) ? named : undefined };
  }
  return { none: false, required: false };
}

/** The declared JSON mode: a schema, a bare JSON mode, or none. */
function readJsonMode(body: Record<string, unknown>, mask: { changed: boolean }): { readonly mode: boolean; readonly schema?: ReplyJsonObject | undefined } | "bad_schema" {
  const generation = firstOwn(body, ["generationConfig", "generation_config"]);
  const candidates: { schema: unknown }[] = [];
  const responseFormat = firstOwn(body, ["response_format", "responseFormat"]);
  if (isRecord(responseFormat)) {
    const type = own(responseFormat, "type");
    const jsonSchema = firstOwn(responseFormat, ["json_schema", "jsonSchema", "schema"]);
    if (type === "json_object" || type === "json_schema" || type === "json") {
      const schema = isRecord(jsonSchema) && isRecord(own(jsonSchema, "schema")) ? own(jsonSchema, "schema") : jsonSchema;
      candidates.push({ schema });
    }
  }
  for (const holder of [own(body, "text"), own(body, "output_config"), own(body, "outputConfig"), body]) {
    if (!isRecord(holder)) continue;
    const format = firstOwn(holder, ["format", "output_format", "outputFormat"]);
    if (isRecord(format)) {
      const type = own(format, "type");
      if (type === "json_object" || type === "json_schema" || type === "json") {
        const inner = own(format, "json_schema");
        const schema = firstOwn(format, ["schema"]) ?? (isRecord(inner) ? (isRecord(own(inner, "schema")) ? own(inner, "schema") : inner) : undefined);
        candidates.push({ schema });
      }
    }
  }
  if (isRecord(generation)) {
    const schema = firstOwn(generation, ["responseSchema", "response_schema", "responseJsonSchema", "response_json_schema"]);
    const mime = firstOwn(generation, ["responseMimeType", "response_mime_type"]);
    if (schema !== undefined || mime === "application/json") candidates.push({ schema });
  }
  const found = candidates[0];
  if (found === undefined) return { mode: false };
  if (found.schema === undefined) return { mode: true };
  const schema = copySchema(found.schema, mask);
  return schema === undefined ? "bad_schema" : { mode: true, schema };
}

function readMaxOutputTokens(body: Record<string, unknown>): number | undefined {
  const generation = firstOwn(body, ["generationConfig", "generation_config"]);
  return (
    positiveInt(firstOwn(body, ["max_completion_tokens", "max_output_tokens", "max_tokens", "maxOutputTokens"])) ??
    (isRecord(generation) ? positiveInt(firstOwn(generation, ["maxOutputTokens", "max_output_tokens"])) : undefined)
  );
}

const EMBEDDING_OPERATIONS: ReadonlySet<string> = new Set(["embeddings", "embed", "embedContent", "batchEmbedContents"]);
const NO_BRIEF_OPERATIONS: ReadonlySet<string> = new Set(["models", "countTokens", "count_tokens"]);

/** Whether the agent has something to write for this brief: a text, JSON or tool-call answer. An embedding or rerank answer is computed by the family's builder. */
export function replyAgentCanAnswer(brief: ReplyBrief): boolean {
  return brief.shape.kind === "text" || brief.shape.kind === "json" || brief.shape.kind === "tool_call";
}

const BRIEFS = new WeakSet<object>();
const register = (brief: ReplyBrief): ReplyBrief => {
  const frozen = Object.freeze(brief);
  BRIEFS.add(frozen);
  return frozen;
};
/** Whether a value is a brief made by `extractReplyBrief` or `parseReplyBrief` (a spread copy or a hand-made look-alike is not). */
export function isReplyBrief(value: unknown): value is ReplyBrief {
  return typeof value === "object" && value !== null && BRIEFS.has(value);
}

/**
 * The brief for one captured call. `bodyText` is the request body as the helper read it; `options.model` is the model the helper resolved from the route (Gemini names it in the path). Reads the body with
 * F2-A's `readModelRequestFacts` and adds the declared shape. Never throws; a call it cannot brief is `{ok:false, reason}` and stays not counted.
 */
export function extractReplyBrief(family: ServedModelFamily, operation: string, bodyText: string, options: { readonly model?: string | undefined } = {}): ReplyBriefResult {
  if (!isServedModelFamily(family) || !OPERATIONS_BY_FAMILY[family].includes(operation) || NO_BRIEF_OPERATIONS.has(operation)) return { ok: false, reason: "unsupported_operation" };
  if (bodyText.length > MODEL_REQUEST_BODY_MAX_BYTES) return { ok: false, reason: "too_long" };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isRecord(body)) return { ok: false, reason: "not_json" };
  const facts = readModelRequestFacts(bodyText);
  const prompt = facts.promptText;
  if (prompt === undefined || prompt.length === 0) return { ok: false, reason: "no_prompt" };
  if (utf8Bytes(prompt) > REPLY_BRIEF_PROMPT_MAX_BYTES) return { ok: false, reason: "too_long" };
  const mask = { changed: false };
  const promptText = redactText(prompt);
  if (promptText !== prompt) mask.changed = true;

  const model = options.model ?? facts.model;
  const stream = facts.stream || operation === "streamGenerateContent";
  const maxOutputTokens = readMaxOutputTokens(body);
  let shape: ReplyAnswerShape;
  if (EMBEDDING_OPERATIONS.has(operation)) shape = { kind: "embedding", stream: false };
  else if (operation === "rerank") shape = { kind: "rerank", stream: false };
  else {
    const json = readJsonMode(body, mask);
    if (json === "bad_schema") return { ok: false, reason: "bad_schema" };
    const read = readTools(body, mask);
    if (!read.ok) return { ok: false, reason: "bad_tools" };
    const choice = readToolChoice(body);
    const tools = choice.none ? [] : read.tools;
    const forced = choice.forcedName !== undefined && tools.some((tool) => tool.name === choice.forcedName) ? choice.forcedName : undefined;
    const base = { stream, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
    if (json.mode && !(tools.length > 0 && choice.required)) shape = { kind: "json", ...base, ...(json.schema === undefined ? {} : { jsonSchema: json.schema }) };
    else if (tools.length > 0) shape = { kind: "tool_call", ...base, tools, toolsRequired: choice.required, ...(forced === undefined ? {} : { forcedToolName: forced }) };
    else shape = { kind: "text", ...base };
  }
  const brief: ReplyBrief = {
    family,
    operation,
    ...(model === undefined || !MODEL_ECHO_PATTERN.test(model) ? {} : { model }),
    promptText,
    promptSha256: sha256HexOf(new TextEncoder().encode(prompt)),
    promptMasked: mask.changed,
    shape,
  };
  if (utf8Bytes(JSON.stringify(brief)) > REPLY_BRIEF_MAX_BYTES) return { ok: false, reason: "too_long" };
  return { ok: true, brief: register(brief) };
}

// ---- parsing a brief back (the capture file is read by the worker, outside the helper's process)

const JsonObjectSchema = z.custom<ReplyJsonObject>((value) => isRecord(value) && boundedJson(value), "a bounded JSON object");
const ToolSchema = z
  .object({ name: z.string().regex(TOOL_NAME), description: z.string().max(REPLY_BRIEF_DESCRIPTION_MAX_CHARS).optional(), parametersSchema: JsonObjectSchema.optional() })
  .strict();
const ShapeSchema = z
  .object({
    kind: z.enum(REPLY_ANSWER_KINDS),
    stream: z.boolean(),
    jsonSchema: JsonObjectSchema.optional(),
    tools: z.array(ToolSchema).max(REPLY_BRIEF_MAX_TOOLS).optional(),
    toolsRequired: z.boolean().optional(),
    forcedToolName: z.string().regex(TOOL_NAME).optional(),
    maxOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();
const BriefSchema = z
  .object({
    family: z.enum(SERVED_MODEL_FAMILIES),
    operation: z.string().min(1).max(64),
    model: z.string().regex(MODEL_ECHO_PATTERN).optional(),
    promptText: z.string().min(1).refine((text) => utf8Bytes(text) <= REPLY_BRIEF_PROMPT_MAX_BYTES, "the prompt is at most 64 KiB"),
    promptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    promptMasked: z.boolean(),
    shape: ShapeSchema,
  })
  .strict()
  .superRefine((brief, context) => {
    if (!OPERATIONS_BY_FAMILY[brief.family].includes(brief.operation) || NO_BRIEF_OPERATIONS.has(brief.operation)) context.addIssue({ code: "custom", path: ["operation"], message: "an operation of the family that has a brief" });
    const { kind, tools, jsonSchema, toolsRequired, forcedToolName } = brief.shape;
    if ((kind === "tool_call") !== (tools !== undefined && tools.length > 0)) context.addIssue({ code: "custom", path: ["shape", "tools"], message: "tools belong to a tool_call shape, and a tool_call shape has some" });
    if (jsonSchema !== undefined && kind !== "json") context.addIssue({ code: "custom", path: ["shape", "jsonSchema"], message: "a schema belongs to a json shape" });
    if ((toolsRequired !== undefined || forcedToolName !== undefined) && kind !== "tool_call") context.addIssue({ code: "custom", path: ["shape"], message: "tool flags belong to a tool_call shape" });
    if (forcedToolName !== undefined && !(tools ?? []).some((tool) => tool.name === forcedToolName)) context.addIssue({ code: "custom", path: ["shape", "forcedToolName"], message: "a forced tool is a declared one" });
    if (new Set((tools ?? []).map((tool) => tool.name)).size !== (tools ?? []).length) context.addIssue({ code: "custom", path: ["shape", "tools"], message: "a tool is declared once" });
  });

/** The strict parse of a brief that was written down (the capture file's entries): every bound re-checked, unknown keys refused, the result registered. A value that fails is `{ok:false}`. */
export function parseReplyBrief(value: unknown): { readonly ok: true; readonly brief: ReplyBrief } | { readonly ok: false } {
  const parsed = BriefSchema.safeParse(value);
  if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > REPLY_BRIEF_MAX_BYTES) return { ok: false };
  return { ok: true, brief: register(parsed.data) };
}
