// TE-F2 part A: what the helper reads from a model request's body to pick a reply and to shape an answer: the model, whether it streams, the first declared tool, the prompt text a reply's `promptContains` and
// `promptSha256` look at, and the counts the embedding and rerank answers need. Bounded (the body is at most 1 MiB, the walk visits at most 100,000 values to depth 16, the prompt text stops at 2 MiB). PURE.
//
// The PROMPT TEXT is every string found under a key named `content`, `text`, `input`, `prompt`, `query`, `system`, `system_instruction`, `systemInstruction`, `instructions`, `documents`, `texts`, `inputs` or `message`
// (arrays inherit the key of the list they sit in), joined with a newline, in document order. Roles, tool names, tool descriptions, tool-call arguments and every other field are not part of it. A reply's
// `promptSha256` is the SHA-256 of that text as UTF-8.
import { echoableModelName } from "./model-family-openai.js";

export const PROMPT_TEXT_MAX_CHARS = 2 * 1024 * 1024;
const WALK_MAX_VALUES = 100_000;
const WALK_MAX_DEPTH = 16;
const PROMPT_KEYS: ReadonlySet<string> = new Set(["content", "text", "input", "prompt", "query", "system", "system_instruction", "systemInstruction", "instructions", "documents", "texts", "inputs", "message"]);

export interface ModelRequestFacts {
  /** The `model` field of the body as a name safe to echo, or undefined when the body has none. */
  readonly model: string | undefined;
  readonly stream: boolean;
  /** The first declared tool's name, when the body declares one. */
  readonly toolName: string | undefined;
  /** The prompt text defined above; undefined when the body is not a JSON object. */
  readonly promptText: string | undefined;
  /** How many inputs an embedding call has (OpenAI `input`, Cohere `texts`); 1 when there is one string or none could be counted. */
  readonly inputCount: number;
  /** OpenAI `dimensions` or Cohere `output_dimension`, a positive integer, else undefined. */
  readonly dimensions: number | undefined;
  readonly base64: boolean;
  readonly embeddingTypes: readonly string[];
  readonly documentCount: number;
  readonly topN: number | undefined;
}

const NO_FACTS: ModelRequestFacts = { model: undefined, stream: false, toolName: undefined, promptText: undefined, inputCount: 1, dimensions: undefined, base64: false, embeddingTypes: [], documentCount: 0, topN: undefined };

const own = (object: object, key: string): unknown => (Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined);
const positiveInt = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

function collectPrompt(root: object): string {
  const pieces: string[] = [];
  let chars = 0;
  let visited = 0;
  const walk = (value: unknown, collect: boolean, depth: number): void => {
    visited += 1;
    if (visited > WALK_MAX_VALUES || depth > WALK_MAX_DEPTH || chars > PROMPT_TEXT_MAX_CHARS) return;
    if (typeof value === "string") {
      if (collect) {
        pieces.push(value);
        chars += value.length + 1;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, collect, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], PROMPT_KEYS.has(key), depth + 1);
    }
  };
  for (const key of Object.keys(root)) walk((root as Record<string, unknown>)[key], PROMPT_KEYS.has(key), 1);
  const text = pieces.join("\n");
  return text.length > PROMPT_TEXT_MAX_CHARS ? text.slice(0, PROMPT_TEXT_MAX_CHARS) : text;
}

function firstToolName(parsed: object): string | undefined {
  const tools = own(parsed, "tools");
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const first: unknown = tools[0];
  if (typeof first !== "object" || first === null) return undefined;
  const candidates: unknown[] = [own(first, "name")];
  const fn = own(first, "function");
  if (typeof fn === "object" && fn !== null) candidates.push(own(fn, "name"));
  const declarations = own(first, "functionDeclarations") ?? own(first, "function_declarations");
  if (Array.isArray(declarations) && typeof declarations[0] === "object" && declarations[0] !== null) candidates.push(own(declarations[0] as object, "name"));
  const found = candidates.find((candidate): candidate is string => typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(candidate));
  return found;
}

/** Gemini `batchEmbedContents` carries `outputDimensionality` inside each request. */
function firstRequestDimensions(parsed: object): number | undefined {
  const requests = own(parsed, "requests");
  const first: unknown = Array.isArray(requests) ? requests[0] : undefined;
  return typeof first === "object" && first !== null ? positiveInt(own(first, "outputDimensionality")) : undefined;
}

function countInputs(parsed: object): number {
  const texts = own(parsed, "texts");
  if (Array.isArray(texts)) return Math.max(1, texts.length);
  const requests = own(parsed, "requests"); // Gemini batchEmbedContents
  if (Array.isArray(requests)) return Math.max(1, requests.length);
  const instances = own(parsed, "instances"); // Vertex :predict
  if (Array.isArray(instances)) return Math.max(1, instances.length);
  const input = own(parsed, "input");
  if (Array.isArray(input)) {
    // A list of token ids is ONE input; a list of strings or of token lists is one input each.
    return input.length > 0 && input.every((item) => typeof item === "number") ? 1 : Math.max(1, input.length);
  }
  return 1;
}

/** The facts of a request body (text). A body that is not a JSON object gives the empty facts. Never throws. */
export function readModelRequestFacts(bodyText: string): ModelRequestFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return NO_FACTS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return NO_FACTS;
  const documents = own(parsed, "documents");
  const types = own(parsed, "embedding_types");
  return {
    model: typeof own(parsed, "model") === "string" ? echoableModelName(own(parsed, "model")) : undefined,
    stream: own(parsed, "stream") === true,
    toolName: firstToolName(parsed),
    promptText: collectPrompt(parsed),
    inputCount: countInputs(parsed),
    dimensions: positiveInt(own(parsed, "dimensions")) ?? positiveInt(own(parsed, "output_dimension")) ?? positiveInt(own(parsed, "outputDimensionality")) ?? firstRequestDimensions(parsed),
    base64: own(parsed, "encoding_format") === "base64",
    embeddingTypes: Array.isArray(types) ? types.filter((type): type is string => typeof type === "string").slice(0, 8) : [],
    documentCount: Array.isArray(documents) ? documents.length : 0,
    topN: positiveInt(own(parsed, "top_n")),
  };
}
