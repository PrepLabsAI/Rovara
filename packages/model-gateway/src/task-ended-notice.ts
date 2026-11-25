// The task-ended notice: Code tells the gateway that a task ended (closed, or completed by a merge), and the gateway records it so the
// task's next call is refused (`task_ended`, 403) and a call still streaming is stopped (server.ts rechecks the record before each chunk and
// every second while idle). Before this route nothing wrote the record (`ENDED#<task>` in the markers table), so every task counted as not ended.
//
//   POST /v1/service/task-ended
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud TASK_ENDED_AUDIENCE, cid = the company that owns the task,
//                                             signed by the install's TASK key (verified exactly as the eval cap's token is: pinned issuer and
//                                             key ids, RS256, the claims exactly iss/aud/jti/iat/nbf/exp/cid, at most SERVICE_TOKEN_SECONDS of life)
//     body exactly {"company": <org id>, "task": <task id>}
//   200 exactly {"company", "task", "ended": true}   the first notice and every repeat answer the same words
//
// Which company: the token's `cid`, signed by the install's broker. A body naming another company is refused (403, fixed words), logged
// (`task_ended_notice` outcome `refused`, reason `company_mismatch`, no ids) and nothing is written. The record is keyed by the install, the company
// and the task (`CO#[iss,cid]` / `ENDED#<task>`), so a notice for company A can only ever end a task of company A: another company's task of the same
// name is a different key, and the gateway's own reader looks up the token's company only. The gateway holds no table of which tasks exist, so an
// unknown task is recorded too: a task closed before its first call must stop that call, and a record for a task that never calls is harmless.
//
// Idempotent and one-way: the write is conditional on no row existing (DynamoEndedTasks.record), so a repeat notice, or one redelivered after a lost answer,
// changes nothing (not even the expiry) and a later notice never un-ends a task. The row expires after ENDED_TASK_RETENTION_SECONDS.
//
// Calls already admitted when the notice lands are stopped by the server's existing recheck: they are not left to finish, and they settle under the
// cut-call rule (DEC 254zzz521, GATEWAY-CUT-ACTUAL): on the company's own key the call settles at the provider's complete usage when already read,
// else at an estimate of use (cutCallMicros); a call that may still be reasoning without streaming keeps the hold. Never twice and never left open.
//
// Every other answer is fixed: 401 an unsigned call, 400 a body that is not exactly the contract or a task id that is not a task id, 413 over TASK_ENDED_BODY_MAX,
// 405 not a POST, 429 busy, 503 when the record cannot be written (Code sends the notice again). Nothing from the request, the token or the store is echoed.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EndedTaskRecorder } from "./ended.js";
import { EVAL_AUTHORITY_ANSWERS } from "./eval-authority.js";
import { COMPANY, TASK, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const TASK_ENDED_PATH = "/v1/service/task-ended";
export const TASK_ENDED_AUDIENCE = "rovara-model-gateway-task-ended";
/** The request body is under 300 bytes; anything over this is refused unread past it. */
export const TASK_ENDED_BODY_MAX = 4_096;
/** Per serving task, before any key fetch or store write (the path is on the public load balancer). */
export const TASK_ENDED_OPEN = 8;
export const TASK_ENDED_PER_MINUTE = 600;

export interface TaskEndedClaims { iss: string; aud: typeof TASK_ENDED_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseTaskEndedClaims(value: unknown): TaskEndedClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== TASK_ENDED_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as TaskEndedClaims;
}
/** createSignedTokenVerifier(..., TASK_ENDED_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const TASK_ENDED_TOKEN_KIND: SignedTokenKind<TaskEndedClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseTaskEndedClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

/** The one log line of this route (fixed words only, never an id): the alarms and operators count `outcome`. */
export interface TaskEndedLog { event: "task_ended_notice"; outcome: "recorded" | "repeat" | "refused" | "unavailable"; reason?: "company_mismatch" }
export interface TaskEndedHandlerOptions {
  /** createSignedTokenVerifier(..., TASK_ENDED_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<TaskEndedClaims | undefined>;
  /** The ended-task record the server's own reader (`EndedTasks`) reads (process.ts passes the same object). */
  ended: EndedTaskRecorder;
  log?: (line: TaskEndedLog) => void;
  now?: () => number;
}
export interface TaskEndedAnswer { company: string; task: string; ended: true }

const ANSWERS = {
  ...EVAL_AUTHORITY_ANSWERS,
  forbidden: { status: 403, body: { error: { type: "forbidden", message: "the notice is not for this company" } } },
} as const;
export const TASK_ENDED_ANSWERS = ANSWERS;

type Request = { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> };
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k));

/** Reads at most `max` bytes; undefined when the body is longer (the rest is left unread). */
async function readBody(body: AsyncIterable<Uint8Array>, max: number): Promise<Buffer | undefined> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) return undefined;
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerTaskEnded(options: TaskEndedHandlerOptions, request: Request, signal: AbortSignal = new AbortController().signal): Promise<{ status: number; body: unknown }> {
  const say = (line: TaskEndedLog): void => { try { options.log?.(line); } catch { /* Logging never stops an answer. */ } };
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^[0-9]+$/u.test(declared) && Number(declared) > TASK_ENDED_BODY_MAX) return ANSWERS.tooLarge;
  const claims = await options.verify(auth.slice(7));
  if (claims === undefined) return ANSWERS.refused;
  const bytes = await readBody(request.body, TASK_ENDED_BODY_MAX);
  if (bytes === undefined) return ANSWERS.tooLarge;
  const type = request.headers["content-type"];
  if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return ANSWERS.invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  // Exactly the contract's members, each checked at runtime.
  const input = record(parsed);
  if (input === undefined || !exactKeys(input, ["company", "task"]) || typeof input.company !== "string" || typeof input.task !== "string" || !TASK.test(input.task)) return ANSWERS.invalid;
  // The token's company is THE company: a notice naming another one writes nothing.
  if (input.company !== claims.cid) { say({ event: "task_ended_notice", outcome: "refused", reason: "company_mismatch" }); return ANSWERS.forbidden; }
  let wrote: boolean;
  try { wrote = await options.ended.record(claims.iss, claims.cid, input.task, signal); } catch { say({ event: "task_ended_notice", outcome: "unavailable" }); return ANSWERS.unavailable; }
  say({ event: "task_ended_notice", outcome: wrote ? "recorded" : "repeat" });
  const answer: TaskEndedAnswer = { company: claims.cid, task: input.task, ended: true };
  return { status: 200, body: answer };
}

/** The HTTP handler the serving process mounts at TASK_ENDED_PATH (process.ts), over the same ended-task record the server reads. */
export function createTaskEndedHandler(options: TaskEndedHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, TASK_ENDED_OPEN, TASK_ENDED_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      const answer = release === undefined ? ANSWERS.busy : await answerTaskEnded(options, { method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (release === undefined || answer.status !== 200) req.resume();
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
