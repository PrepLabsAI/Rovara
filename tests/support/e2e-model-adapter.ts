import { request } from "node:http";
import { E2EModelChannelResponseSchema, type E2EModelChannelRequest } from "../../packages/contracts/src/e2e-model-channel.js";

/**
 * A test-only AI SDK v4 `LanguageModel` that talks to the worker proxy over its socket and to nothing else. It is the
 * shape of adapter Task 4.3 builds for the executor: the e2e agent loop gets this object as its model, so the loop can
 * never be handed a provider (or the Vercel AI Gateway) of its own. Any channel failure throws a plain Error, which
 * `ai` does not retry (it retries only an `APICallError` with `isRetryable`).
 */
export interface ChannelModelOptions {
  socketPath: string;
  runId: string;
  caseId: string;
  stepIndex: number;
  /** Seen after each answer, with the channel request that was sent. */
  onCall?: (sent: E2EModelChannelRequest) => void;
}

type V4Options = {
  prompt: Array<{ role: string; content: unknown }>;
  tools?: Array<{ type: string; name: string; description?: string; inputSchema: unknown }>;
  toolChoice?: { type: string; toolName?: string };
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
};

function toChannelPrompt(prompt: V4Options["prompt"]): unknown[] {
  return prompt.map((message) => {
    if (message.role === "system") return { role: "system", content: message.content };
    const parts = message.content as Array<Record<string, unknown>>;
    if (message.role === "user") return { role: "user", content: parts.map((part) => ({ type: "text", text: String(part["text"]) })) };
    if (message.role === "assistant") {
      return { role: "assistant", content: parts.map((part) => (part["type"] === "tool-call"
        ? { type: "tool-call", toolCallId: part["toolCallId"], toolName: part["toolName"], input: part["input"] }
        : { type: "text", text: String(part["text"]) })) };
    }
    return { role: "tool", content: parts.map((part) => ({ type: "tool-result", toolCallId: part["toolCallId"], toolName: part["toolName"], output: part["output"] })) };
  });
}

function exchange(socketPath: string, body: unknown, signal: AbortSignal | undefined, path = "/v1/generate"): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, ...(signal ? { signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error instanceof Error ? error : new Error("unreadable channel answer")); } });
    });
    req.on("error", reject);
    req.on("socket", (socket) => { socket.on("error", () => undefined); });
    req.end(payload);
  });
}

export function createChannelLanguageModel(options: ChannelModelOptions) {
  let callIndex = 0;
  let syncSeq = 0;
  return {
    specificationVersion: "v4" as const,
    provider: "agentx-e2e",
    modelId: "rovara-e2e-default",
    supportedUrls: {},
    async doGenerate(call: V4Options) {
      const sent = {
        schemaVersion: "rovara-e2e-model-channel/v1", runId: options.runId, caseId: options.caseId, stepIndex: options.stepIndex, callIndex: callIndex++,
        call: {
          prompt: toChannelPrompt(call.prompt),
          ...(call.tools === undefined ? {} : { tools: call.tools.map((tool) => ({ type: "function", name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema })) }),
          ...(call.toolChoice === undefined ? {} : { toolChoice: call.toolChoice }),
        },
      } as E2EModelChannelRequest;
      options.onCall?.(sent);
      // Every call is made under a session sync of its own (MIDSTEPCOOKIE), as the executor's client does; this stand-in knows no session values.
      syncSeq += 1;
      await exchange(options.socketPath, { schemaVersion: "rovara-e2e-model-channel/v1", runId: options.runId, syncSeq, values: [] }, call.abortSignal, "/v1/sync");
      (sent as { syncSeq?: number }).syncSeq = syncSeq;
      const parsed = E2EModelChannelResponseSchema.parse(await exchange(options.socketPath, sent, call.abortSignal));
      if (parsed.result.status === "error") throw new Error(`model channel refused the call: ${parsed.result.code}`);
      const { content, finishReason, usage } = parsed.result;
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
    doStream(): never { throw new Error("streaming is not part of the channel"); },
  };
}
