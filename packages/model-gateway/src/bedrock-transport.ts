import type { ClientRequest } from "node:http";
import https from "node:https";
import { signRequest, type CredentialSource } from "./aws.js";
import { randomUUID } from "node:crypto";
import { BEDROCK_CONVERSE_ID, ConverseStreamToSse, fromConverse, LEADING_THINKING_TEXT_MODEL, REASONING_CARRYOVER_MODEL } from "./bedrock-converse.js";
import { BedrockStreamToSse, EventStreamDecoder, EventStreamError, exceptionStatus, type EventStreamMessage } from "./bedrock-event-stream.js";
import { AnswerBrokeError, NotSentError, type ProviderResponse, type ProviderTransport } from "./provider.js";

/**
 * Rovara's AI (DEC 240): Bedrock's InvokeModel / InvokeModelWithResponseStream in Rovara's OWN AWS account, signed with the
 * gateway task role's credentials (SigV4, service "bedrock"). There is no customer role and no external id: the IAM grant on the
 * task role (infra/lib/model-gateway.ts) names the allow-listed models only. The host is fixed from the configured region; the
 * path is one the route built from an allow-listed model id (bedrockInvokePath) and is checked again here. A streamed answer
 * (AWS event-stream framing) is turned back into the Anthropic SSE the agent route speaks (bedrock-event-stream.ts).
 *
 * Why InvokeModel and not bedrock-runtime's native /anthropic/v1/messages: AWS documents the IAM actions and the response
 * framing of InvokeModel(WithResponseStream), not of the native path (checked 2026-11-15); one real staging call settled the
 * framing used here (tests/fixtures/model-gateway-bedrock).
 */
/** A Bedrock Claude model or system inference profile id: `anthropic.<model>`, `<geo>.anthropic.<model>` or `global.anthropic.<model>` (only a BYO connection that allows global routing names one), optional `:<n>`. */
export const BEDROCK_CLAUDE_ID = /^(?:[a-z]{2,4}\.|global\.)?anthropic\.claude-[a-z0-9-]{1,80}(?::\d{1,3})?$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const PATH = /^\/model\/([A-Za-z0-9.-]+(?:%3A\d{1,3})?)\/(invoke|invoke-with-response-stream|converse|converse-stream)$/u;
/** The most a whole (non-streaming) Converse answer may be before it is translated (provider.ts MAX_RESPONSE_BYTES). */
const CONVERSE_ANSWER_MAX_BYTES = 10 * 1024 * 1024;

/** The request path for an allow-listed model id (encoded as AWS's SDKs send it). Throws for anything else. */
export function bedrockInvokePath(modelId: string, streaming: boolean): string {
  if (!BEDROCK_CLAUDE_ID.test(modelId)) throw new Error("invalid bedrock model");
  return `/model/${encodeURIComponent(modelId)}/${streaming ? "invoke-with-response-stream" : "invoke"}`;
}

/** The Converse path for an allow-listed non-Claude model id (DEC 243c). Throws for anything else. */
export function bedrockConversePath(modelId: string, streaming: boolean): string {
  if (!BEDROCK_CONVERSE_ID.test(modelId)) throw new Error("invalid bedrock model");
  return `/model/${encodeURIComponent(modelId)}/${streaming ? "converse-stream" : "converse"}`;
}

export interface BedrockTransportOptions { region: string; credentials: CredentialSource; request?: typeof https.request; now?: () => number }

export function createBedrockTransport(options: BedrockTransportOptions): ProviderTransport {
  if (!REGION.test(options.region)) throw new Error("invalid aws region");
  const host = `bedrock-runtime.${options.region}.amazonaws.com`;
  const request = options.request ?? https.request;
  const now = options.now ?? Date.now;
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    const path = input.path;
    const match = path === undefined ? null : PATH.exec(path);
    if (path === undefined || match === null) throw new NotSentError();
    const modelId = decodeURIComponent(match[1]!);
    const converse = match[2] === "converse" || match[2] === "converse-stream";
    // Claude through InvokeModel with the Anthropic body; every other model only through Converse.
    if (!(converse ? BEDROCK_CONVERSE_ID : BEDROCK_CLAUDE_ID).test(modelId)) throw new NotSentError();
    // Claude never through Converse, whatever its prefix.
    if (converse && /(?:^|\.)anthropic\./u.test(modelId)) throw new NotSentError();
    const streaming = match[2] === "invoke-with-response-stream" || match[2] === "converse-stream";
    let credentials;
    try { credentials = await options.credentials(); } catch { throw new NotSentError(); }
    if (input.signal.aborted) throw new NotSentError();
    const body = Buffer.from(input.body);
    // Only these headers: the route's own (an Anthropic version header, a caller key) never reach AWS.
    const headers = signRequest({ method: "POST", host, path, region: options.region, service: "bedrock", body, credentials, now: new Date(now()), headers: { "content-type": "application/json", accept: streaming ? "application/vnd.amazon.eventstream" : "application/json" } });
    return new Promise<ProviderResponse>((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try {
        call = request({ hostname: host, port: 443, path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...headers, "content-length": String(body.byteLength) } }, (response) => {
          const status = response.statusCode ?? 0;
          const raw = response as AsyncIterable<Uint8Array>;
          const cancel = () => response.destroy();
          if (status < 200 || status >= 300) { resolve({ status, body: raw, cancel }); return; }
          if (!streaming) { resolve({ status, body: converse ? converseAnswer(raw, modelId) : raw, cancel }); return; }
          // Look at the first message before answering: an exception before any output is answered as its error status, so the route
          // accounts it like the same error before the stream (free). Anything after it streams as Anthropic SSE.
          firstMessage(raw, converse ? converseStream(modelId) : anthropicStream()).then((first) => {
            if (first.message?.headers[":message-type"] === "exception") { cancel(); resolve({ status: exceptionStatus(first.message), body: empty(), cancel }); return; }
            resolve({ status, body: toSse(first.sse, first.message, first.rest, first.iterator), cancel, progress: () => first.sse.progress() });
          // The 2xx head arrived and the answer broke before its first event: Bedrock accepted the request (failed-call.ts: not free).
          }, () => { cancel(); reject(new AnswerBrokeError()); });
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

/** Event-stream messages to Anthropic SSE: the Anthropic body's own stream, or ConverseStream's (translated). */
interface StreamConverter { decode(bytes: Uint8Array): EventStreamMessage[]; convert(messages: readonly EventStreamMessage[]): Buffer; finish(): void; progress(): { events: number; outputBytes: number } }
const anthropicStream = (): StreamConverter => { const sse = new BedrockStreamToSse(); return { decode: (b) => sse.decode(b), convert: (m) => sse.convert(m), finish: () => { sse.finish(); }, progress: () => sse.progress() }; };
const converseStream = (model: string): StreamConverter => {
  const decoder = new EventStreamDecoder(); const sse = new ConverseStreamToSse(model, `msg_bdrk_${randomUUID().replaceAll("-", "")}`, LEADING_THINKING_TEXT_MODEL.test(model), REASONING_CARRYOVER_MODEL.test(model));
  return { decode: (b) => decoder.push(b), convert: (m) => sse.convert(m), finish: () => { decoder.finish(); }, progress: () => sse.progress() };
};
/** A whole Converse answer as the Anthropic message JSON the route settles from. A malformed answer throws (a broken answer). */
async function* converseAnswer(raw: AsyncIterable<Uint8Array>, model: string): AsyncIterable<Uint8Array> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of raw) { size += part.byteLength; if (size > CONVERSE_ANSWER_MAX_BYTES) throw new EventStreamError(); parts.push(Buffer.from(part)); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new EventStreamError(); }
  yield Buffer.from(JSON.stringify(fromConverse(parsed, model, `msg_bdrk_${randomUUID().replaceAll("-", "")}`, LEADING_THINKING_TEXT_MODEL.test(model), REASONING_CARRYOVER_MODEL.test(model))));
}

interface First { sse: StreamConverter; message: EventStreamMessage | undefined; rest: EventStreamMessage[]; iterator: AsyncIterator<Uint8Array> }
/** Reads until the first whole message (or the end). Throws on a malformed stream. */
async function firstMessage(raw: AsyncIterable<Uint8Array>, sse: StreamConverter): Promise<First> {
  const iterator = raw[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { sse, message: undefined, rest: [], iterator };
    const messages = sse.decode(next.value);
    if (messages.length > 0) return { sse, message: messages[0], rest: messages.slice(1), iterator };
  }
}
async function* empty(): AsyncIterable<Uint8Array> { /* An error answer: no bytes. */ }
/** One message at a time, so the events before a broken one still go out (the route then sees how far the stream got). The converter's state is per instance: the same result as one batch. */
function* convertEach(sse: StreamConverter, messages: readonly EventStreamMessage[]): Generator<Buffer> {
  for (const message of messages) { const out = sse.convert([message]); if (out.length > 0) yield out; }
}
async function* toSse(sse: StreamConverter, first: EventStreamMessage | undefined, rest: EventStreamMessage[], iterator?: AsyncIterator<Uint8Array>): AsyncIterable<Uint8Array> {
  yield* convertEach(sse, first === undefined ? rest : [first, ...rest]);
  if (iterator !== undefined) for (;;) { const next = await iterator.next(); if (next.done) break; yield* convertEach(sse, sse.decode(next.value)); }
  sse.finish();
}
