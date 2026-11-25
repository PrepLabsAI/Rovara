// DEC 253q (c): the monthly cap Code's `eval-reservation` adapter reads (its optional `monthlyCapMicros()`). The source of truth is
// Cloud's company budget, read the way every agent call reads it (company-caps.ts CompanyBudgetCaps.capsFor): the lower of the
// company's monthly cap and the project monthly cap. A project with no cap of its own (NO_CAP) is held to the company's cap. No
// source means refused: a company with no settings row, no company monthly cap (null), or a row that is not its own has no cap here.
//
//   POST /v1/product/eval/cap
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud EVAL_CAP_AUDIENCE, cid = the company asked about,
//                                             signed by the install's TASK key (verified exactly as the eval-authority token is)
//     body exactly {"company": <org id>, "project": <project>}
//   200 exactly {"company", "project", "monthlyCapMicros": <whole number, 0..Number.MAX_SAFE_INTEGER>[, "connected": <boolean>]}
//
// L4-T3 (additive, no new route): `connected` is whether the project's own product key is connected, re-read with the SAME check the eval
// authority and the stage hold make (ProductEvalStages.connected). It is sent only where the gateway holds eval stages (so an install that
// cannot say sends the three members it always did), and only after the cap itself was found: a company with no budget source is the same
// fixed 404 as before. A connection that cannot be read is left out (unknown), never guessed and never a 503 for the cap. Code reads it to say
// "Connect it in Company settings" instead of "not approved" (the authority route's 404 does not say why).
//
// Every other answer is fixed (eval-authority.ts's answers): 404 "not found" for every "no" (another company's token or body, a
// project the gateway could never have stored, no budget source, a value that is not whole), so nothing says whether another company
// exists; 503 when the budget can't be read; 401 an unsigned call; 400 a body that is not exactly the contract; 413 over
// EVAL_CAP_BODY_MAX; 405 not a POST; 429 busy. Nothing from the request, the token or the store is echoed or logged.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapsSource } from "./caps.js";
import { EVAL_AUTHORITY_ANSWERS } from "./eval-authority.js";
import { COMPANY, PROJECT, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const EVAL_CAP_PATH = "/v1/product/eval/cap";
export const EVAL_CAP_AUDIENCE = "rovara-model-gateway-eval-cap";
/** The request body is under 300 bytes; anything over this is refused unread past it. */
export const EVAL_CAP_BODY_MAX = 4_096;
/** Per serving task, before any key fetch or store read (the path is on the public load balancer). */
/** The most the connection read may take before the cap is answered without it. */
export const EVAL_CAP_CONNECTION_MS = 1_000;
export const EVAL_CAP_OPEN = 8;
export const EVAL_CAP_PER_MINUTE = 600;

export interface EvalCapClaims { iss: string; aud: typeof EVAL_CAP_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseEvalCapClaims(value: unknown): EvalCapClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== EVAL_CAP_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as EvalCapClaims;
}
/** createSignedTokenVerifier(..., EVAL_CAP_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const EVAL_CAP_TOKEN_KIND: SignedTokenKind<EvalCapClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseEvalCapClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

/** What the cap answer needs to say whether the project's own AI key is connected (ProductEvalStages.connected). */
export interface EvalConnectionSource {
  connected(scope: { iss: string; cid: string; pid: string }, signal: AbortSignal): Promise<boolean | undefined>;
}
export interface EvalCapHandlerOptions {
  /** createSignedTokenVerifier(..., EVAL_CAP_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<EvalCapClaims | undefined>;
  /** The company budget (process.ts: CompanyBudgetCaps over Cloud's Companies table). */
  caps: CapsSource;
  /** L4-T3: the project's key connection. Absent: the answer has no `connected` member, exactly as before. */
  connection?: EvalConnectionSource;
  now?: () => number;
}
export interface EvalCapAnswer { company: string; project: string; monthlyCapMicros: number; connected?: boolean }

const ANSWERS = EVAL_AUTHORITY_ANSWERS;
export const EVAL_CAP_ANSWERS = ANSWERS;

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
export async function answerEvalCap(options: EvalCapHandlerOptions, request: Request, signal: AbortSignal = new AbortController().signal): Promise<{ status: number; body: unknown }> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^[0-9]+$/u.test(declared) && Number(declared) > EVAL_CAP_BODY_MAX) return ANSWERS.tooLarge;
  const claims = await options.verify(auth.slice(7));
  if (claims === undefined) return ANSWERS.refused;
  const bytes = await readBody(request.body, EVAL_CAP_BODY_MAX);
  if (bytes === undefined) return ANSWERS.tooLarge;
  const type = request.headers["content-type"];
  if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return ANSWERS.invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  // Exactly the contract's members, each checked at runtime.
  const input = record(parsed);
  if (input === undefined || !exactKeys(input, ["company", "project"]) || typeof input.company !== "string" || typeof input.project !== "string") return ANSWERS.invalid;
  // The token's company is THE company: a body naming another one is "not found" (nothing about either is said).
  if (input.company !== claims.cid || !PROJECT.test(input.project)) return ANSWERS.notFound;
  const cid = claims.cid; const pid = input.project;
  let caps: Awaited<ReturnType<CapsSource["capsFor"]>>;
  // The company budget reads only the company (its project cap is the company's per-project setting); no task or person is asked about.
  try { caps = await options.caps.capsFor({ iss: claims.iss, cid, pid, tid: "" }, signal); } catch { return ANSWERS.unavailable; }
  // CompanyBudgetCaps answers an empty object when there is no source (no settings row, a null company cap, another company's row).
  const c = record(caps);
  if (c === undefined || !whole(c.companyMonth) || !whole(c.projectMonth)) return ANSWERS.notFound;
  const answer: EvalCapAnswer = { company: cid, project: pid, monthlyCapMicros: Math.min(c.companyMonth, c.projectMonth) };
  if (options.connection !== undefined) {
    let connected: boolean | undefined;
    // Bounded on its own: a slow key read leaves `connected` out (unknown) instead of costing the cap its answer (Code waits 3 seconds for the whole reply).
    const own = new AbortController(); const stop = (): void => own.abort(); signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, EVAL_CAP_CONNECTION_MS);
    try { connected = await options.connection.connected({ iss: claims.iss, cid, pid }, own.signal); } catch { connected = undefined; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
    if (typeof connected === "boolean") answer.connected = connected;
  }
  return { status: 200, body: answer };
}

/** The HTTP handler the serving process mounts at EVAL_CAP_PATH (process.ts), over the company budget source. */
export function createEvalCapHandler(options: EvalCapHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, EVAL_CAP_OPEN, EVAL_CAP_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      const answer = release === undefined ? ANSWERS.busy : await answerEvalCap(options, { method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (release === undefined || answer.status !== 200) req.resume();
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
