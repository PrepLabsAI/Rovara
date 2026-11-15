/** Narrow static rules, not a resolver: TS/JS/Python and line/token based JSON/YAML/TOML/env/INI.
 * AI signals: SDK import/require (openai, anthropic, @anthropic-ai/sdk, @google/genai, @google/generative-ai,
 * google.genai, google.generativeai, ai, @ai-sdk/*, langchain*, cohere, litellm, ollama), a model prefix below,
 * or a prompts/models/llm/ai/agents folder. Model/template/content/input/settings need that signal; input also needs an SDK call.
 * Named prompts match whole underscore/camelCase parts; DIR/PATH/STATUS/TIMEOUT/ROOT/FILE/URL suffixes are excluded.
 * SDK system/messages text blocks are recognized without a separate file-level signal.
 * Unsupported languages, variable resolution, YAML aliases/merges and computed keys are deliberately not guessed.
 */
import type { ModelFamily } from "./model-catalog.js";
import type { ModelSettingKey } from "./prompt-change.js";
export const SETTING_ALIASES = new Map<string, ModelSettingKey>([
  ["temperature", "temperature"], ["top_p", "top_p"], ["topP", "top_p"], ["top_k", "top_k"], ["topK", "top_k"],
  ["max_tokens", "max_tokens"], ["maxTokens", "max_tokens"], ["max_output_tokens", "max_tokens"], ["maxOutputTokens", "max_tokens"], ["max_completion_tokens", "max_tokens"], ["maxCompletionTokens", "max_tokens"],
  ["stop", "stop_sequences"], ["stop_sequences", "stop_sequences"], ["stopSequences", "stop_sequences"], ["seed", "seed"],
  ["frequency_penalty", "frequency_penalty"], ["frequencyPenalty", "frequency_penalty"], ["presence_penalty", "presence_penalty"], ["presencePenalty", "presence_penalty"],
  ["response_format", "response_format"], ["responseFormat", "response_format"], ["reasoning_effort", "reasoning_effort"], ["reasoningEffort", "reasoning_effort"],
  ["thinking_budget", "thinking_budget"], ["thinkingBudget", "thinking_budget"], ["tool_choice", "tool_choice"], ["toolChoice", "tool_choice"],
]);
export const SYSTEM_KEYS = new Set(["system", "system_prompt", "systemPrompt", "system_instruction", "system_instructions", "systemInstruction", "systemInstructions", "instructions"]);
export const PROMPT_KEYS = new Set(["prompt", "template"]);
export const MODEL_KEYS = new Set(["model", "model_name", "modelName", "model_id", "modelId", "deployment", "deployment_name", "deploymentName"]);
export const CONFIG_MODEL_KEYS = new Set([...MODEL_KEYS].map((key) => key.toLowerCase()));
export function promptConstantName(name: string): boolean {
  const parts = name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2").toLowerCase();
  return /(?:^|_)(?:system|prompt|instructions?|template)(?:_|$)/u.test(parts) && !/(?:^|_)(?:dir|path|status|timeout|root|file|url)$/u.test(parts);
}
export const TOOL_KEYS = new Set(["tools", "functions", "function_declarations", "functionDeclarations", "input_schema", "tool_schema", "toolSchema"]);
export const PROMPT_CALLS = new Set(["generate_content", "generateContent", "generateText", "streamText", "generate_text", "invoke", "PromptTemplate", "from_template", "from_messages"]);
export const MODEL_CALLS = new Set(["openai", "google", "anthropic", "init_chat_model"]);
export const SDK_CALLS = new Set([...PROMPT_CALLS, ...MODEL_CALLS, "create", "chat", "generate", "ChatOpenAI", "getGenerativeModel"]);
/** UNVERIFIED: every prefix here is a static hint from the brief, not proven by a vendor SDK run. */
export const MODEL_PREFIXES: ReadonlyArray<readonly [ModelFamily, readonly string[]]> = [
  ["openai_compatible", ["gpt-", "o1", "o3", "o4", "text-embedding-"]], ["anthropic_messages", ["claude-"]],
  ["gemini", ["gemini-", "models/gemini-"]], ["cohere", ["command-", "embed-"]],
];
export function modelFamily(value: string): ModelFamily | null {
  for (const [family, prefixes] of MODEL_PREFIXES) if (prefixes.some((prefix) => value.startsWith(prefix))) return family;
  return null;
}
export function promptFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = lower.slice(dot + 1);
  if (new Set(["prompt", "prompty", "dotprompt", "jinja", "jinja2", "j2", "hbs", "handlebars", "mustache"]).has(extension)) return true;
  if (lower.endsWith(".prompt.md")) return true;
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (extension === "txt" && (name.includes("prompt") || name.includes("system"))) return true;
  return /(?:^|\/)(?:prompts|prompt|system-prompts)\//u.test(lower) && new Set(["md", "txt", "yaml", "yml", "json", "toml"]).has(extension);
}
export function sourceMode(path: string): "code" | "config" | "other" {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/\.(?:[cm]?[jt]sx?|py|pyi)$/iu.test(path)) return "code";
  if (/\.(?:json|ya?ml|toml|ini)$/iu.test(path) || name === "env" || name.startsWith("env.") || name === ".env" || name.includes(".env.") || name.endsWith(".env")) return "config";
  return "other";
}
export function aiPath(path: string): boolean { return /(?:^|\/)(?:prompts|models|llm|ai|agents)\//iu.test(path); }
export function knownSdk(value: string): boolean {
  return /^(?:openai|anthropic|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai|google\.genai|google\.generativeai|ai|cohere|litellm|ollama)(?:[/.]|$)/u.test(value) || value.startsWith("@ai-sdk/") || value.startsWith("langchain") || value.startsWith("@langchain/");
}
