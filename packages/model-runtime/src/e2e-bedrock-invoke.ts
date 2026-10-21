import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type ToolChoice,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput } from "./e2e-route.js";

/**
 * The real provider call of the governed e2e model route: the Bedrock Converse API through
 * `@aws-sdk/client-bedrock-runtime`.
 *
 * Why not pi-ai's `amazon-bedrock` provider (the Step 0 decision, recorded in the Task 4.0 ruling): pi-ai can carry
 * tool calls and tool choice, but its client is built without `maxAttempts`, so the AWS SDK retries a throttled call up
 * to three times, which the "no retries" rule forbids and the route cannot turn off from outside. It also rewrites the
 * prompt on the way out (tool call ids, blank text, cache points, thinking fields) and answers with a pi message that
 * reports the requested model, not a served one. The governed route needs the request it received to be the request
 * Bedrock gets, and exactly one attempt. So the call is made here, with a client built for one attempt.
 *
 * Credentials come from the SDK's default chain (the worker's role). No key is ever read, stored or logged.
 */

/** Converse's JSON document type, taken from the client's own types. */
type DocumentType = Extract<ToolInputSchema, { json: unknown }>["json"];

/** The part of a Bedrock client the route uses; tests supply a fake. */
export interface E2EConverseClient {
  send(command: ConverseCommand, options: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockE2EInvokeOptions {
  /** The client for a region. Defaults to a real client with a single attempt, one per region. */
  clientFor?: (region: string) => Pick<E2EConverseClient, "send"> | { send: (command: never, options: { abortSignal?: AbortSignal }) => Promise<unknown> };
}

/** A Bedrock runtime client that makes one attempt per call: a throttle or a 5xx ends the call, it is never re-sent. */
export function createBedrockRuntimeClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region, maxAttempts: 1 });
}

const EMPTY_TEXT = "(no text)";
const text = (value: string): ContentBlock => ({ text: value.trim() === "" ? EMPTY_TEXT : value });

type PromptMessage = E2EInvokeInput["call"]["prompt"][number];

function toolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  throw new Error("a tool call input must be a JSON object");
}

function toBlocks(message: Exclude<PromptMessage, { role: "system" }>): { role: "user" | "assistant"; blocks: ContentBlock[] } {
  if (message.role === "user") return { role: "user", blocks: message.content.map((part) => text(part.text)) };
  if (message.role === "assistant") {
    const blocks: ContentBlock[] = [];
    for (const part of message.content) {
      if (part.type === "text") { if (part.text.trim() !== "") blocks.push({ text: part.text }); }
      else blocks.push({ toolUse: { toolUseId: part.toolCallId, name: part.toolName, input: toolInput(part.input) as DocumentType } });
    }
    if (blocks.length === 0) blocks.push({ text: EMPTY_TEXT });
    return { role: "assistant", blocks };
  }
  return {
    role: "user",
    blocks: message.content.map((part): ContentBlock => {
      const output = part.output;
      const body = output.type === "content" ? output.value.map((item) => item.text).join("\n") : output.value;
      return { toolResult: { toolUseId: part.toolCallId, content: [{ text: body.trim() === "" ? EMPTY_TEXT : body }], status: output.type === "error-text" ? "error" : "success" } };
    }),
  };
}

/** Converse wants alternating roles and every result for one assistant turn in one user message, so neighbours of one role merge. */
function toMessages(prompt: readonly PromptMessage[]): Message[] {
  const messages: Array<{ role: "user" | "assistant"; content: ContentBlock[] }> = [];
  for (const message of prompt) {
    if (message.role === "system") continue;
    const { role, blocks } = toBlocks(message);
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return messages;
}

function toToolChoice(choice: E2EInvokeInput["call"]["toolChoice"]): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice.type === "auto") return { auto: {} };
  if (choice.type === "required") return { any: {} };
  return { tool: { name: choice.toolName } };
}

export function bedrockConverseRequest(input: E2EInvokeInput): ConverseCommandInput {
  const { call } = input;
  const system = call.prompt.flatMap((message) => (message.role === "system" ? [{ text: message.content }] : []));
  const toolChoice = toToolChoice(call.toolChoice);
  return {
    modelId: input.identifier,
    messages: toMessages(call.prompt),
    ...(system.length === 0 ? {} : { system }),
    inferenceConfig: { maxTokens: input.maxOutputTokens, temperature: input.temperature },
    ...(call.tools === undefined ? {} : {
      toolConfig: {
        tools: call.tools.map((tool) => ({ toolSpec: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: { json: tool.inputSchema as DocumentType } } })),
        ...(toolChoice === undefined ? {} : { toolChoice }),
      },
    }),
  };
}

function finishOf(stopReason: string | undefined): E2EInvokeOutput["finishReason"] {
  const raw = stopReason ?? null;
  switch (stopReason) {
    case "end_turn": return { unified: "stop", raw };
    case "tool_use": return { unified: "tool-calls", raw };
    case "max_tokens": case "model_context_window_exceeded": return { unified: "length", raw };
    case "content_filtered": case "guardrail_intervened": return { unified: "content-filter", raw };
    default: return { unified: "other", raw };
  }
}

export function bedrockConverseOutput(identifier: string, response: ConverseCommandOutput): E2EInvokeOutput {
  const blocks = response.output?.message?.content ?? [];
  const content = blocks.flatMap((block): Array<Record<string, unknown>> => {
    if (block.text !== undefined) return block.text === "" ? [] : [{ type: "text", text: block.text }];
    if (block.toolUse !== undefined) return [{ type: "tool-call", toolCallId: block.toolUse.toolUseId, toolName: block.toolUse.name, input: JSON.stringify(block.toolUse.input ?? {}) }];
    return [{ type: "unsupported-block" }];
  });
  const usage = response.usage;
  return {
    // Converse does not echo the model that served the call, so the identifier the route asked for is what is reported.
    // The pin is held by what is invoked and by the worker role's IAM scope, not by this field.
    servedModelId: identifier,
    content,
    finishReason: finishOf(response.stopReason),
    // No usage is passed on as none, never as zero: the route then fails closed and counts its reserved bound.
    usage: usage?.inputTokens === undefined || usage.outputTokens === undefined ? undefined
      : { inputTokens: usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0), outputTokens: usage.outputTokens },
  };
}

export function createBedrockE2EInvoke(options: BedrockE2EInvokeOptions = {}): E2EInvoke {
  const clients = new Map<string, BedrockRuntimeClient>();
  const clientFor = options.clientFor ?? ((region: string) => {
    let client = clients.get(region);
    if (client === undefined) { client = createBedrockRuntimeClient(region); clients.set(region, client); }
    return client;
  });
  return async (input) => {
    if (input.region === null) throw new Error("a Bedrock route needs a pinned region");
    const client = clientFor(input.region) as E2EConverseClient;
    const response = await client.send(new ConverseCommand(bedrockConverseRequest(input)), { abortSignal: input.signal });
    return bedrockConverseOutput(input.identifier, response);
  };
}
