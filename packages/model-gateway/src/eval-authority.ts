// DEC 253k: the eval spend authority Code's broker asks (Rovara Code PR #805, packages/broker/src/core-host/eval-authority-http.ts, the
// `eval-reservation` plug-in point). The source of truth for "may this approved eval spend" is THIS gateway: its stored approval (the
// product key table, written by Cloud's settings route; eval-approvals.ts) plus the project's own connected product key. Never
// Rovara-paid: the answer's provider is always "customer", and only when the project's own key is connected.
//
//   POST /v1/product/eval/authority
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud EVAL_AUTHORITY_AUDIENCE, cid = the company asked about,
//                                             signed by the install's TASK key (verified as the offered-models token is)
//     body exactly {"company": <org id>, "project": <project>, "approver": {"personId": <id>, "provider": <identity adapter>}}
//   200 exactly {"company", "project", "principal": {companyId, personId, displayName, roles, provider}, "provider": "customer", "connected": true}
//
// 200 ONLY when: the token's cid is the body's company; the project's stored approval counts now (fresh: 15 minutes from the role
// check Cloud made with Code, and not withdrawn) and names exactly this approver (the asked Principal's developer id, as Cloud's
// settings route stores it: storedApproverOf); the approver's role still allows it (owner, admin
// or maintainer, re-read); and the project's own product key is connected (re-read). The same checks the stage hold makes
// (ProductEvalStages.authority, product-eval.ts). `roles` is that one role; `displayName` is "" (the gateway holds no person's
// name; Code re-reads the person's role itself before it grants anything).
//
// Every other answer is fixed: 404 "not found" for every "no" (no approval, stale, withdrawn, another approver, no role, not
// connected, another company's token), so nothing says whether another company or project exists; 503 when a store can't be read;
// 401 an unsigned call; 400 a body that is not exactly the contract; 413 over EVAL_AUTHORITY_BODY_MAX; 405 not a POST; 429 busy.
// Nothing from the request, the token or a store is echoed or logged.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COMPANY, PROJECT, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import type { EvalApproval, EvalRole } from "./product-eval.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const EVAL_AUTHORITY_PATH = "/v1/product/eval/authority";
export const EVAL_AUTHORITY_AUDIENCE = "rovara-model-gateway-eval-authority";
/** The request body is under 1 KiB; anything over this is refused unread past it. */
export const EVAL_AUTHORITY_BODY_MAX = 4_096;
/** Code's ApproverSchema: personId 1..256 characters, provider 1..200. */
const PERSON_MAX = 256;
const PROVIDER_MAX = 200;
/** Per serving task, before any key fetch or store read (the path is on the public load balancer). */
export const EVAL_AUTHORITY_OPEN = 8;
export const EVAL_AUTHORITY_PER_MINUTE = 600;

export interface EvalAuthorityClaims { iss: string; aud: typeof EVAL_AUTHORITY_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseEvalAuthorityClaims(value: unknown): EvalAuthorityClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== EVAL_AUTHORITY_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as EvalAuthorityClaims;
}
/** createSignedTokenVerifier(..., EVAL_AUTHORITY_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const EVAL_AUTHORITY_TOKEN_KIND: SignedTokenKind<EvalAuthorityClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseEvalAuthorityClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

/**
 * Code names the approver by its sign-in Principal (identity adapter `provider`, raw `personId`); Cloud's settings route stores the
 * approver as Code's developer id of that Principal (`developerIdOf`, Code packages/broker/src/core/sessions/create.ts:
 * sha256("developer\0" + provider + "\0" + personId), hex) under EVAL_APPROVER_PROVIDER (cloud-server product-ai-routes.ts
 * PRODUCT_AI_APPROVER_PROVIDER). The asked approver is mapped to that stored form before it is compared.
 */
export const EVAL_APPROVER_PROVIDER = "rovara-code";
export function storedApproverOf(asked: { personId: string; provider: string }): EvalApproval["approver"] {
  return { personId: createHash("sha256").update(`developer\u0000${asked.provider}\u0000${asked.personId}`).digest("hex"), provider: EVAL_APPROVER_PROVIDER };
}

/** What the route needs from the eval stages (ProductEvalStages.authority). */
export interface EvalAuthoritySource {
  authority(scope: { iss: string; cid: string; pid: string }, approver: EvalApproval["approver"], signal: AbortSignal): Promise<{ role: EvalRole } | undefined>;
}
export interface EvalAuthorityHandlerOptions {
  /** createSignedTokenVerifier(..., EVAL_AUTHORITY_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<EvalAuthorityClaims | undefined>;
  stages: EvalAuthoritySource;
  now?: () => number;
}
export interface EvalAuthorityAnswer {
  company: string; project: string;
  principal: { companyId: string; personId: string; displayName: string; roles: EvalRole[]; provider: string };
  provider: "customer"; connected: true;
}

const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notFound: { status: 404, body: { error: { type: "not_found", message: "not found" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  tooLarge: { status: 413, body: { error: { type: "invalid_request", message: "the request is too large" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  invalid: { status: 400, body: { error: { type: "invalid_request", message: "the service call is not valid" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;
export const EVAL_AUTHORITY_ANSWERS = ANSWERS;

type Request = { method: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: AsyncIterable<Uint8Array> };
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max;

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
export async function answerEvalAuthority(options: EvalAuthorityHandlerOptions, request: Request, signal: AbortSignal = new AbortController().signal): Promise<{ status: number; body: unknown }> {
  if (request.method !== "POST") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^[0-9]+$/u.test(declared) && Number(declared) > EVAL_AUTHORITY_BODY_MAX) return ANSWERS.tooLarge;
  const claims = await options.verify(auth.slice(7));
  if (claims === undefined) return ANSWERS.refused;
  const bytes = await readBody(request.body, EVAL_AUTHORITY_BODY_MAX);
  if (bytes === undefined) return ANSWERS.tooLarge;
  const type = request.headers["content-type"];
  if (typeof type !== "string" || type.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return ANSWERS.invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { return ANSWERS.invalid; }
  // Exactly the contract's members, each checked at runtime.
  const input = record(parsed); const approver = record(input?.approver);
  if (input === undefined || !exactKeys(input, ["company", "project", "approver"]) || approver === undefined || !exactKeys(approver, ["personId", "provider"])) return ANSWERS.invalid;
  if (typeof input.company !== "string" || typeof input.project !== "string" || !text(approver.personId, PERSON_MAX) || !text(approver.provider, PROVIDER_MAX)) return ANSWERS.invalid;
  // The token's company (checked against COMPANY with the token) is THE company: a body naming another one is answered as "not
  // found" (nothing about either is said). A project the gateway could never have stored is not found either.
  if (input.company !== claims.cid || !PROJECT.test(input.project)) return ANSWERS.notFound;
  const cid = claims.cid; const pid = input.project;
  const asked = { personId: approver.personId, provider: approver.provider };
  let found: { role: EvalRole } | undefined;
  try { found = await options.stages.authority({ iss: claims.iss, cid, pid }, storedApproverOf(asked), signal); } catch { return ANSWERS.unavailable; }
  if (found === undefined) return ANSWERS.notFound;
  const answer: EvalAuthorityAnswer = {
    company: cid, project: pid,
    principal: { companyId: cid, personId: asked.personId, displayName: "", roles: [found.role], provider: asked.provider },
    provider: "customer", connected: true,
  };
  return { status: 200, body: answer };
}

/** The HTTP handler the serving process mounts at EVAL_AUTHORITY_PATH (process.ts), only when the product route holds eval stages. */
export function createEvalAuthorityHandler(options: EvalAuthorityHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, EVAL_AUTHORITY_OPEN, EVAL_AUTHORITY_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      const answer = release === undefined ? ANSWERS.busy : await answerEvalAuthority(options, { method: req.method ?? "", headers: req.headers, body: req }, controller.signal);
      if (release === undefined || answer.status !== 200) req.resume();
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
