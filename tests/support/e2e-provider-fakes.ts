import { crc32 } from "node:zlib";
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";

/** Fakes for the four providers' wire formats, so the e2e provider invoke is tested without any real provider call. */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a provider payload of unknown shape
  bodyText: string;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/** A `fetch` that records each request and answers from the handler. Nothing leaves the process. */
export function fakeFetch(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(request?.headers ?? init?.headers);
    const bodyText = request ? await request.clone().text() : typeof init?.body === "string" ? init.body : "";
    const recorded: RecordedRequest = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method: request?.method ?? init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()), bodyText, body: bodyText ? JSON.parse(bodyText) as RecordedRequest["body"] : {},
    };
    requests.push(recorded);
    return handler(recorded);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export function sse(events: Array<{ event?: string; data: unknown }>, status = 200): Response {
  const text = events.map((item) => `${item.event === undefined ? "" : `event: ${item.event}\n`}data: ${typeof item.data === "string" ? item.data : JSON.stringify(item.data)}\n\n`).join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

export const jsonError = (status: number, body: unknown = { error: { message: "rate limited with the prompt echoed: hunter2-echo" } }) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface ToolTurn { id: string; name: string; input: Record<string, unknown> }
export interface StreamFacts { model: string; tool?: ToolTurn; text?: string; inputTokens?: number; outputTokens?: number; stop?: "tool" | "end" | "length"; upstream?: string }

export function anthropicSse(facts: StreamFacts): Response {
  const events: Array<{ event: string; data: unknown }> = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: facts.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: facts.inputTokens ?? 900, output_tokens: 1 } } } },
  ];
  let index = 0;
  if (facts.text !== undefined) {
    events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: facts.text } } });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index += 1;
  }
  if (facts.tool !== undefined) {
    events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: facts.tool.id, name: facts.tool.name, input: {} } } });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(facts.tool.input) } } });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  }
  const stopReason = facts.stop === "length" ? "max_tokens" : facts.tool !== undefined && facts.stop !== "end" ? "tool_use" : "end_turn";
  events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: facts.outputTokens ?? 40 } } });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return sse(events);
}

export function openaiResponsesSse(facts: StreamFacts): Response {
  const output = facts.tool === undefined ? [] : [{ type: "function_call", id: "fc_1", call_id: facts.tool.id, name: facts.tool.name, arguments: JSON.stringify(facts.tool.input), status: "completed" }];
  const events: Array<{ data: unknown }> = [
    { data: { type: "response.created", sequence_number: 0, response: { id: "resp_1", object: "response", model: facts.model, status: "in_progress", output: [] } } },
  ];
  if (facts.tool !== undefined) {
    events.push({ data: { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "function_call", id: "fc_1", call_id: facts.tool.id, name: facts.tool.name, arguments: "", status: "in_progress" } } });
    events.push({ data: { type: "response.function_call_arguments.delta", sequence_number: 2, output_index: 0, item_id: "fc_1", delta: JSON.stringify(facts.tool.input) } });
    events.push({ data: { type: "response.function_call_arguments.done", sequence_number: 3, output_index: 0, item_id: "fc_1", arguments: JSON.stringify(facts.tool.input) } });
    events.push({ data: { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: output[0] } });
  }
  events.push({ data: { type: "response.completed", sequence_number: 5, response: { id: "resp_1", object: "response", model: facts.model, status: "completed", output, usage: { input_tokens: facts.inputTokens ?? 900, output_tokens: facts.outputTokens ?? 40, total_tokens: (facts.inputTokens ?? 900) + (facts.outputTokens ?? 40), input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } } });
  return sse(events);
}

export function openrouterSse(facts: StreamFacts): Response {
  const base = { id: "gen-1", object: "chat.completion.chunk", created: 1, model: facts.model, ...(facts.upstream === undefined ? {} : { provider: facts.upstream }) };
  const events: Array<{ data: unknown }> = [];
  if (facts.tool !== undefined) {
    events.push({ data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: facts.tool.id, type: "function", function: { name: facts.tool.name, arguments: "" } }] }, finish_reason: null }] } });
    events.push({ data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(facts.tool.input) } }] }, finish_reason: null }] } });
  } else {
    events.push({ data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: facts.text ?? "" }, finish_reason: null }] } });
  }
  const finish = facts.stop === "length" ? "length" : facts.tool !== undefined && facts.stop !== "end" ? "tool_calls" : "stop";
  events.push({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: facts.inputTokens ?? 900, completion_tokens: facts.outputTokens ?? 40, total_tokens: (facts.inputTokens ?? 900) + (facts.outputTokens ?? 40) } } });
  events.push({ data: "[DONE]" });
  return sse(events);
}

// ---------------------------------------------------------------------------------------------------------------------
// A loopback Bedrock endpoint (HTTP/2 without TLS, as the AWS SDK's default handler speaks it)
// ---------------------------------------------------------------------------------------------------------------------

function eventFrame(eventType: string, payload: unknown): Buffer {
  const headers = { ":event-type": eventType, ":content-type": "application/json", ":message-type": "event" };
  const encodedHeaders = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const key = Buffer.from(name);
    const text = Buffer.from(value);
    const out = Buffer.alloc(1 + key.length + 1 + 2 + text.length);
    let offset = 0;
    out.writeUInt8(key.length, offset); offset += 1;
    key.copy(out, offset); offset += key.length;
    out.writeUInt8(7, offset); offset += 1;
    out.writeUInt16BE(text.length, offset); offset += 2;
    text.copy(out, offset);
    return out;
  }));
  const body = Buffer.from(JSON.stringify(payload));
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + encodedHeaders.length + body.length + 4, 0);
  prelude.writeUInt32BE(encodedHeaders.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude) >>> 0);
  const message = Buffer.concat([prelude, preludeCrc, encodedHeaders, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(message) >>> 0);
  return Buffer.concat([message, messageCrc]);
}

/** Only the first frame of a stream: the response is accepted and then goes away. */
export function bedrockStartOnly(): Buffer {
  return eventFrame("messageStart", { role: "assistant" });
}

/** A 200 event stream that delivers its first events and then breaks. */
export function brokenSse(first: Response): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const text = await first.text();
      controller.enqueue(encoder.encode(text.split("\n\n")[0] + "\n\n"));
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function bedrockStreamBody(facts: Omit<StreamFacts, "model">): Buffer {
  const frames: Buffer[] = [eventFrame("messageStart", { role: "assistant" })];
  let index = 0;
  if (facts.text !== undefined) {
    frames.push(eventFrame("contentBlockDelta", { contentBlockIndex: index, delta: { text: facts.text } }));
    frames.push(eventFrame("contentBlockStop", { contentBlockIndex: index }));
    index += 1;
  }
  if (facts.tool !== undefined) {
    frames.push(eventFrame("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: facts.tool.id, name: facts.tool.name } } }));
    frames.push(eventFrame("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(facts.tool.input) } } }));
    frames.push(eventFrame("contentBlockStop", { contentBlockIndex: index }));
  }
  const stopReason = facts.stop === "length" ? "max_tokens" : facts.tool !== undefined && facts.stop !== "end" ? "tool_use" : "end_turn";
  frames.push(eventFrame("messageStop", { stopReason }));
  const inputTokens = facts.inputTokens ?? 900;
  const outputTokens = facts.outputTokens ?? 40;
  frames.push(eventFrame("metadata", { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, metrics: { latencyMs: 12 } }));
  return Buffer.concat(frames);
}

export interface BedrockLoopback {
  endpoint: string;
  requests: Array<{ path: string; body: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a Converse request of unknown shape
  close(): Promise<void>;
}

/** An HTTP/2 cleartext server standing in for bedrock-runtime. `respond` returns a status and body for each request. */
export async function bedrockLoopback(respond: (request: { path: string; body: Record<string, any> }, count: number) => { status: number; body: Buffer | string; type?: string; errorType?: string; drop?: true; cutAfterBody?: true }): Promise<BedrockLoopback> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const requests: BedrockLoopback["requests"] = [];
  const server: Http2Server = createHttp2Server();
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded = { path: String(headers[":path"]), body: text ? JSON.parse(text) as Record<string, any> : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
      requests.push(recorded);
      const answer = respond(recorded, requests.length);
      // A dropped session: the connection goes away with no response at all.
      if (answer.drop === true) { stream.session?.destroy(); return; }
      stream.respond({
        ":status": answer.status, "content-type": answer.type ?? (answer.status === 200 ? "application/vnd.amazon.eventstream" : "application/json"),
        ...(answer.errorType === undefined ? {} : { "x-amzn-errortype": answer.errorType }),
      });
      // A response cut mid-stream: the status and some frames arrive, then the connection goes away.
      if (answer.cutAfterBody === true) { stream.write(answer.body); setTimeout(() => stream.session?.destroy(), 20); return; }
      stream.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise<void>((resolve) => {
      // An HTTP/2 server's close callback waits for every stream; the test is over, so drop the sessions and go on.
      for (const session of sessions) session.destroy();
      server.close();
      setImmediate(resolve);
    }),
  };
}
