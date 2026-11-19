// The one list of AI SDK, model-call and provider-host names Rovara reads code for. Used by the worker (eval-ai-related.ts: which files are AI-related) and by the broker's change tier (L4-EVP: a patch that names one touches likely-AI code).
// Pure: one regex, scanned once per text.
/** One regex, case-insensitive, scanned once per file. A mention in a comment counts too: over-counting is the safe side. */
export const AI_MARKER = new RegExp([
  String.raw`\b(?:openai|anthropic|genai|generativeai|aiplatform|vertexai|litellm|ollama|cohere|mistralai|llama_index|llamaindex|groq|langchain\w*|langgraph\w*)\b`,
  String.raw`@anthropic-ai\/|@google\/genai|@google\/generative-ai|@google-cloud\/vertexai|@google-cloud\/aiplatform|@aws-sdk\/client-bedrock|@ai-sdk\/|@langchain\/|@mistralai\/|@azure\/openai|@huggingface\/inference`,
  String.raw`bedrock[-_](?:agent[-_])?runtime|invoke_?model|converse_?stream|\bconverse\b|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openai\.azure\.com`,
  // Raw HTTP to OpenAI-compatible and other provider APIs, Azure AI Inference.
  String.raw`chat\/completions|\/v1\/messages|\/v1\/completions|\/v1\/responses|:(?:stream)?generateContent|openrouter|deepseek|api\.together|api\.mistral|api\.x\.ai|api\.groq|api\.cohere|azure\.ai\.inference|ai-inference|huggingface_hub|InferenceClient|invoke_endpoint|:11434|\/api\/chat|\/api\/generate`,
  String.raw`(["'\x60])ai(?:\/[^"'\x60\s]{0,256})?\1`,
].join("|"), "iu");

export function hasAiMarker(text: string): boolean { return AI_MARKER.test(text); }
