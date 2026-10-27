import type { E2EModelChannelClient, E2EModelChannelRequest, E2EModelChannelResponse } from "@agentx/contracts";

/**
 * The model of an agent step, as the AI SDK sees it: a v4 language model whose only transport is the worker's model channel (Task 4.3b).
 *
 * e2e's tool loop is given this object and nothing else, so it can never reach a provider or the Vercel AI gateway of its own. `provider` is `agentx-e2e` and `modelId` is the admitted route
 * id, which is what the generated config and its digest name.
 *
 * - One `doGenerate` is one request to the channel. This adapter never retries and never throws a retryable error: the AI SDK retries only a thrown `APICallError` whose
 *   `isRetryable` is true, and a plain `Error` is neither, so a call the worker already counted is never counted twice by a client that tried again (Ruling M4-C).
 * - Every failure (a refused or failed call the worker answered, a socket that could not be reached, a request the client would not send) is an `E2EAgentModelError`: a fixed
 *   sentence and a code from a closed list, never the worker's own words, a prompt or a path.
 * - The worker's receipt id of every answer, an error answer included, is kept for the step's ledger (`takeReceiptIds`).
 * - A file part, a reasoning part or an unknown part in the prompt is refused here (the channel schema refuses them too), so pixels cannot be sent by this path whatever the loop does.
 */

export type E2EAgentModelErrorCode = "channel-error" | "unsupported-prompt" | "no-position" | "invalid-answer" | "credential-in-prompt";
const AGENT_MODEL_ERROR_MESSAGES: Record<E2EAgentModelErrorCode, string> = {
  "channel-error": "the model call did not complete",
  "unsupported-prompt": "the prompt holds a part the model channel does not carry",
  "no-position": "no agent step is running to attribute the model call to",
  "invalid-answer": "the model channel answered with something that cannot be used",
  "credential-in-prompt": "the prompt holds a credential or a session value, so it was not sent",
};

/** A plain, non-retryable error. `isRetryable` is false so the AI SDK never sends the request again. */
export class E2EAgentModelError extends Error {
  readonly isRetryable = false as const;
  constructor(readonly code: E2EAgentModelErrorCode, readonly channelCode: string | null = null) {
    super(channelCode === null ? AGENT_MODEL_ERROR_MESSAGES[code] : `${AGENT_MODEL_ERROR_MESSAGES[code]} (${channelCode})`);
    this.name = "E2EAgentModelError";
  }
}

/** The subset of the AI SDK's v4 call options the act loop sends; anything else on the object is ignored, never forwarded. */
type V4Part = { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown };
type V4Message = { role: string; content: unknown };
type V4CallOptions = {
  prompt: readonly V4Message[];
  tools?: ReadonlyArray<{ type: string; name: string; description?: string; inputSchema: unknown }>;
  toolChoice?: { type: string; toolName?: string };
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
};

const refuse = (): never => { throw new E2EAgentModelError("unsupported-prompt"); };

function channelPrompt(prompt: readonly V4Message[]): E2EModelChannelRequest["call"]["prompt"] {
  return prompt.map((message) => {
    if (message.role === "system") {
      if (typeof message.content !== "string") return refuse();
      return { role: "system" as const, content: message.content };
    }
    if (!Array.isArray(message.content)) return refuse();
    const parts = message.content as V4Part[];
    if (message.role === "user") {
      return { role: "user" as const, content: parts.map((part) => (part.type === "text" && typeof part.text === "string" ? { type: "text" as const, text: part.text } : refuse())) };
    }
    if (message.role === "assistant") {
      return { role: "assistant" as const, content: parts.map((part) => {
        if (part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text };
        if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string") {
          return { type: "tool-call" as const, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } as never;
        }
        return refuse();
      }) };
    }
    if (message.role === "tool") {
      return { role: "tool" as const, content: parts.map((part) => (part.type === "tool-result" && typeof part.toolCallId === "string" && typeof part.toolName === "string"
        ? { type: "tool-result" as const, toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } as never : refuse())) };
    }
    return refuse();
  });
}

export interface E2EAgentModelAdapterOptions {
  client: E2EModelChannelClient;
  /** The admitted route id; it is the model's `modelId`. */
  routeId: string;
  /** The step the call belongs to. It returns null when no agent step is running, and the call is then refused before anything is sent. */
  position: () => { caseId: string; stepIndex: number } | null;
  /**
   * Whether the bytes of a request carry a credential this process knows (the run's accounts, and every session value it has learned, a cookie the application set during the
   * step included). The worker scans each request against the values it was told, and the channel client tells it the browser's current values before every call
   * (MIDSTEPCOOKIE), so this scan is a second check: a request it flags is refused here and never sent.
   */
  scan?: (bytes: Uint8Array) => boolean;
}

export interface E2EAgentModelAdapter {
  readonly provider: "agentx-e2e";
  readonly modelId: string;
  readonly specificationVersion: "v4";
  readonly supportedUrls: Record<string, never>;
  doGenerate(options: V4CallOptions): Promise<unknown>;
  doStream(): never;
  /** The receipt ids of the calls answered for this step since the last call to `takeReceiptIds` for it, in order. */
  takeReceiptIds(position: { caseId: string; stepIndex: number }): string[];
  /** How many requests were sent to the channel for this step (answered or not). */
  callsFor(position: { caseId: string; stepIndex: number }): number;
}

export function createE2EAgentModelAdapter(options: E2EAgentModelAdapterOptions): E2EAgentModelAdapter {
  const key = (position: { caseId: string; stepIndex: number }) => `${String(position.stepIndex)}:${position.caseId}`;
  const counters = new Map<string, number>();
  const receipts = new Map<string, string[]>();
  return Object.freeze({
    provider: "agentx-e2e" as const,
    modelId: options.routeId,
    specificationVersion: "v4" as const,
    supportedUrls: {},
    async doGenerate(call: V4CallOptions): Promise<unknown> {
      const position = options.position();
      if (position === null) throw new E2EAgentModelError("no-position");
      const prompt = channelPrompt(call.prompt);
      const tools = call.tools === undefined ? undefined : call.tools.map((tool) => ({ type: "function" as const, name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema })) as unknown as NonNullable<E2EModelChannelRequest["call"]["tools"]>;
      const request = { prompt, ...(tools === undefined ? {} : { tools }), ...(call.toolChoice === undefined ? {} : { toolChoice: call.toolChoice as E2EModelChannelRequest["call"]["toolChoice"] }),
        ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }) } as E2EModelChannelRequest["call"];
      if (options.scan?.(Buffer.from(JSON.stringify(request), "utf8")) === true) throw new E2EAgentModelError("credential-in-prompt");
      const slot = key(position);
      const callIndex = counters.get(slot) ?? 0;
      counters.set(slot, callIndex + 1);
      let answer: E2EModelChannelResponse;
      try {
        answer = await options.client.generate({ caseId: position.caseId, stepIndex: position.stepIndex, callIndex, call: request }, call.abortSignal);
      } catch (error) {
        // The client's errors carry only a code of their own; whatever else was thrown is not repeated.
        if ((error as { code?: unknown } | null)?.code === "credential-in-prompt") throw new E2EAgentModelError("credential-in-prompt");
        throw new E2EAgentModelError("channel-error", typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null);
      }
      const held = receipts.get(slot) ?? [];
      held.push(answer.receiptId);
      receipts.set(slot, held);
      if (answer.result.status === "error") throw new E2EAgentModelError("channel-error", answer.result.code);
      const { content, finishReason, usage } = answer.result;
      return {
        content,
        finishReason: { unified: finishReason.unified, raw: finishReason.raw ?? undefined },
        usage: {
          inputTokens: { total: usage.inputTokens, noCache: usage.inputTokens, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: 0 },
        },
        warnings: [] as unknown[],
      };
    },
    doStream(): never { throw new E2EAgentModelError("unsupported-prompt"); },
    takeReceiptIds(position: { caseId: string; stepIndex: number }): string[] {
      const slot = key(position);
      const held = receipts.get(slot) ?? [];
      receipts.delete(slot);
      return held;
    },
    callsFor(position: { caseId: string; stepIndex: number }): number { return counters.get(key(position)) ?? 0; },
  });
}
