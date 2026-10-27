import { request } from "node:http";
import {
  E2E_MODEL_CHANNEL_GENERATE_PATH,
  E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES,
  E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES,
  E2E_MODEL_CHANNEL_SCHEMA_VERSION,
  E2E_MODEL_CHANNEL_STEP_PATH,
  E2E_MODEL_CHANNEL_SYNC_PATH,
  E2E_MODEL_SESSION_SYNC_MAX_VALUES,
  E2EModelChannelRequestSchema,
  E2EModelChannelResponseSchema,
  type E2EModelChannelClient,
  type E2EModelChannelRequest,
  type E2EModelChannelResponse,
  type E2EModelChannelStepMarker,
  type E2EModelSessionSync,
} from "@agentx/contracts";
import { createSessionSyncState, syncSessionBeforeCall, type E2EModelSessionSource } from "./model-channel-sync.js";

/**
 * The executor's client for the worker's model socket (M1.4 Task 4.3a). It speaks the two requests of `rovara-e2e-model-channel/v1` and nothing else: a step marker
 * (`POST /v1/step`, `begin` or `end`) and a model call (`POST /v1/generate`). Nothing loads it yet; the agent step driver of Task 4.3b does.
 *
 * - One HTTP request per call. There is no retry here, so a call the worker counted is never counted twice by a client that tried again; deciding whether to ask again is the
 *   agent's, and the worker's budget is what bounds it.
 * - Every failure is a `E2EModelChannelError`: a plain error whose `isRetryable` is false, with a code from a fixed list and a fixed sentence. Nothing the worker answered, and
 *   nothing from the socket's own errors, is put in a message, so a caller that logs it cannot leak a prompt, a path or a credential.
 * - A request that is not a valid channel request (a file part, an unknown tool, an oversized prompt) is refused here, before it is sent.
 */

export const E2E_MODEL_CHANNEL_ERROR_CODES_CLIENT = ["unavailable", "timeout", "aborted", "refused", "invalid-response", "invalid-request", "session-sync"] as const;
export type E2EModelChannelClientErrorCode = (typeof E2E_MODEL_CHANNEL_ERROR_CODES_CLIENT)[number];

const MESSAGES: Record<E2EModelChannelClientErrorCode, string> = {
  unavailable: "the model channel could not be reached",
  timeout: "the model channel did not answer in time",
  aborted: "the model channel request was cancelled",
  refused: "the model channel refused the request",
  "invalid-response": "the model channel answered with something that is not a valid answer",
  "invalid-request": "the request is not a valid model channel request",
  "session-sync": "the session values could not be synced to the model channel, so the call was not sent",
};

/** A plain, non-retryable error. `isRetryable` is false so the AI SDK's own retry never re-sends a call the worker already counted. */
export class E2EModelChannelError extends Error {
  readonly isRetryable = false as const;
  constructor(readonly code: E2EModelChannelClientErrorCode) {
    super(MESSAGES[code]);
    this.name = "E2EModelChannelError";
  }
}

/** Longest the client waits for one answer. The worker's own call timeout is 30 s and a step 90 s; this is only the bound for a socket that never answers. */
export const E2E_MODEL_CHANNEL_CLIENT_TIMEOUT_MS = 120_000;
const RESPONSE_READ_LIMIT_BYTES = E2E_MODEL_CHANNEL_MAX_RESPONSE_BYTES + 4_096;

export interface E2EModelChannelClientOptions {
  /** The mounted socket (`/run/rovara/model.sock`). */
  socketPath: string;
  runId: string;
  /** Per request. Default `E2E_MODEL_CHANNEL_CLIENT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * The browser's session values (MIDSTEPCOOKIE). Required: every `generate` first reads them, tells the worker the ones it does not have, and names that sync on the call. There is no
   * way to make a call without it, so a caller cannot bypass the sync.
   */
  sessionSync: E2EModelSessionSource;
}

type Reply = { status: number; body: unknown };

function post(options: E2EModelChannelClientOptions, path: string, payload: Buffer, signal: AbortSignal | undefined): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    if (signal?.aborted === true) { reject(new E2EModelChannelError("aborted")); return; }
    let settled = false;
    const done = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); action(); };
    const req = request({ socketPath: options.socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > RESPONSE_READ_LIMIT_BYTES) { done(() => { req.destroy(); reject(new E2EModelChannelError("invalid-response")); }); return; }
        chunks.push(chunk);
      });
      res.on("end", () => done(() => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); } catch { reject(new E2EModelChannelError("invalid-response")); }
      }));
      res.on("error", () => done(() => reject(new E2EModelChannelError("unavailable"))));
    });
    const onAbort = () => done(() => { req.destroy(); reject(new E2EModelChannelError("aborted")); });
    const timer = setTimeout(() => done(() => { req.destroy(); reject(new E2EModelChannelError("timeout")); }), options.timeoutMs ?? E2E_MODEL_CHANNEL_CLIENT_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", () => done(() => reject(new E2EModelChannelError("unavailable"))));
    req.end(payload);
  });
}

export function createE2EModelChannelClient(options: E2EModelChannelClientOptions): E2EModelChannelClient {
  const syncState = createSessionSyncState();
  const syncBefore = (signal: AbortSignal | undefined): Promise<number> => syncSessionBeforeCall(options.sessionSync, syncState, async (sync: E2EModelSessionSync) => {
    const reply = await post(options, E2E_MODEL_CHANNEL_SYNC_PATH, Buffer.from(JSON.stringify(sync), "utf8"), signal);
    const body = reply.body as { status?: unknown; syncSeq?: unknown } | null;
    return reply.status === 200 && body?.status === "ok" && body.syncSeq === sync.syncSeq;
  }, { runId: options.runId, maxValues: E2E_MODEL_SESSION_SYNC_MAX_VALUES, schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION },
  () => new E2EModelChannelError("session-sync"));
  // One call at a time: a sync belongs to the call that follows it.
  let calls: Promise<unknown> = Promise.resolve();
  const marker = async (body: E2EModelChannelStepMarker, signal: AbortSignal | undefined): Promise<void> => {
    const reply = await post(options, E2E_MODEL_CHANNEL_STEP_PATH, Buffer.from(JSON.stringify(body), "utf8"), signal);
    if (reply.status !== 200 || (reply.body as { status?: unknown } | null)?.status !== "ok") throw new E2EModelChannelError("refused");
  };
  return {
    beginStep: (position, signal) => marker({ schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION, runId: options.runId, marker: "begin", caseId: position.caseId, stepIndex: position.stepIndex,
      ...(position.cookieValues === undefined || position.cookieValues.length === 0 ? {} : { cookieValues: [...position.cookieValues] }) }, signal),
    endStep: (position, signal) => marker({ schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION, runId: options.runId, marker: "end", caseId: position.caseId, stepIndex: position.stepIndex }, signal),
    generate(request: { caseId: string; stepIndex: number; callIndex: number; call: E2EModelChannelRequest["call"] }, signal?: AbortSignal): Promise<E2EModelChannelResponse> {
      const run = calls.then(async (): Promise<E2EModelChannelResponse> => {
        // A request the channel would not carry is refused before anything is synced or sent.
        const shape = E2EModelChannelRequestSchema.safeParse({ schemaVersion: E2E_MODEL_CHANNEL_SCHEMA_VERSION, runId: options.runId, caseId: request.caseId, stepIndex: request.stepIndex,
          callIndex: request.callIndex, syncSeq: 1, call: request.call });
        if (!shape.success) throw new E2EModelChannelError("invalid-request");
        // The sync is taken as late as possible: after the prompt is built, so it is at least as new as anything the prompt can hold.
        const syncSeq = await syncBefore(signal);
        const parsed = E2EModelChannelRequestSchema.safeParse({ ...shape.data, syncSeq });
        if (!parsed.success) throw new E2EModelChannelError("invalid-request");
        const payload = Buffer.from(JSON.stringify(parsed.data), "utf8");
        if (payload.length > E2E_MODEL_CHANNEL_MAX_REQUEST_BYTES) throw new E2EModelChannelError("invalid-request");
        const reply = await post(options, E2E_MODEL_CHANNEL_GENERATE_PATH, payload, signal);
        // The worker answers a refused or failed call with a valid answer of status `error` (and a status code that says why); that answer is the result, not a transport failure.
        const answer = E2EModelChannelResponseSchema.safeParse(reply.body);
        if (!answer.success) throw new E2EModelChannelError(reply.status >= 200 && reply.status < 300 ? "invalid-response" : "refused");
        return answer.data;
      });
      calls = run.catch(() => undefined);
      return run;
    },
  };
}

export type { E2EModelChannelClient };
