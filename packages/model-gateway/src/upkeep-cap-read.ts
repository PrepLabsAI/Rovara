// L4-CAPR (lead 4): the gateway tells Code whether a project's nightly-upkeep cap is enforced, so Code's nightly wiki refresh (Code #978, contracts/upkeep.ts
// `UpkeepCapReadSchema`) may start AI by itself. Code starts nothing on a guess: it starts only while THIS answer says the gateway holds the cap.
//
//   GET /v1/service/companies/<companyId>/upkeep/<project>
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud UPKEEP_CAP_AUDIENCE, cid = the company asked about,
//                                             signed by the install's TASK key (verified exactly as the offered-models token is: pinned issuer and
//                                             key ids, RS256, the claims exactly iss/aud/jti/iat/nbf/exp/cid, at most SERVICE_TOKEN_SECONDS of life)
//   200 exactly {"version":1,"company","project","month":"YYYY-MM","enforced":true,"limitMicros","spentMicros"}
//
// What "enforced" means here (never a default, never a guess): it is the limit the agent route's upkeep call holds the project to RIGHT NOW (upkeep-cap.ts
// `withUpkeepCap`), read through the same `UpkeepLimits` the route uses, and the spend is the meter's own `upkeep` row for the same company, project and
// month. The limit is the project's `upkeep_month` row, else UPKEEP_DEFAULT_MONTH_MICROS (the route enforces that default for a project with no row, so the
// answer states it); a $0 row is an enforced limit of 0 ("no upkeep spend"). A limit that does not read (null, or a throw), a meter row that does not read or
// is not this company's, or a month that changed while reading is NOT an answer: 503, never `enforced: true`. `enforced` is only ever `true` in a 200: a
// gateway that cannot say so answers an error, and Code reads every error as "not known" and starts nothing.
//
// Company isolation: the company is the token's `cid`; a path naming another company is refused as an unsigned call (a caller that builds company A's
// address with company B's token learns nothing), the project is the path's own checked name, and every read below is for that one company and project.
// Every failure is a fixed answer: nothing from the request, a token or a store is echoed or logged.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Meter, MeterScope } from "./meter.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";
import { UPKEEP_DEFAULT_MONTH_MICROS, type UpkeepLimits } from "./upkeep-cap.js";

export const UPKEEP_CAP_READ_AUDIENCE = "rovara-model-gateway-upkeep-cap";
export const UPKEEP_CAP_READ_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/upkeep\/([a-z][a-z0-9-]{0,62})$/u;
/** Per serving task, before any key fetch or store read (the path is on the public load balancer). */
export const UPKEEP_CAP_READ_OPEN = 8;
export const UPKEEP_CAP_READ_PER_MINUTE = 600;
/** The meter's row scope needs a task id in the token's own format; the upkeep row never reads it (it is per company, project and month). */
const READ_TASK = "upkeep-cap-read";

export interface UpkeepCapReadClaims { iss: string; aud: typeof UPKEEP_CAP_READ_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseUpkeepCapReadClaims(value: unknown): UpkeepCapReadClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== UPKEEP_CAP_READ_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as UpkeepCapReadClaims;
}
/** createSignedTokenVerifier(..., UPKEEP_CAP_READ_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const UPKEEP_CAP_READ_TOKEN_KIND: SignedTokenKind<UpkeepCapReadClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseUpkeepCapReadClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

export interface UpkeepCapReadHandlerOptions {
  /** createSignedTokenVerifier(..., UPKEEP_CAP_READ_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<UpkeepCapReadClaims | undefined>;
  /** The SAME limits the agent route enforces (process.ts: `upkeepLimits`), so the answer is what the route's very next upkeep call is held to. */
  limits: UpkeepLimits;
  /** The agent meter (the one the agent route reserves on): only `read` is used. */
  meter: Pick<Meter, "read">;
  now?: () => number;
}
export interface UpkeepCapReadAnswer { version: 1; company: string; project: string; month: string; enforced: true; limitMicros: number; spentMicros: number }

const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notFound: { status: 404, body: { error: { type: "not_found", message: "not found" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;
export const UPKEEP_CAP_READ_ANSWERS = ANSWERS;

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerUpkeepCapRead(options: UpkeepCapReadHandlerOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  const target = UPKEEP_CAP_READ_PATH.exec(request.url);
  if (target === null) return ANSWERS.notFound;
  if (request.method !== "GET") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const claims = await options.verify(auth.slice(7));
  // The token's company is THE company; a path naming another company is an unsigned call (nothing about either company is said).
  if (claims === undefined || claims.cid !== target[1]) return ANSWERS.refused;
  const cid = claims.cid; const pid = target[2]!;
  const now = options.now ?? Date.now;
  try {
    const month = monthOf(now());
    // The limit the agent route's upkeep call is held to: the project's own row, else the default; a row that does not read is not a limit (503).
    const own = await options.limits.limitFor(cid, pid, signal);
    if (own === null) return ANSWERS.unavailable;
    const limitMicros = own ?? UPKEEP_DEFAULT_MONTH_MICROS;
    if (!whole(limitMicros)) return ANSWERS.unavailable;
    const scope: MeterScope = { iss: claims.iss, cid, pid, tid: READ_TASK };
    const row = (await options.meter.read(scope, { upkeep: true })).find((r) => r.item === "upkeep");
    // The row is this company's own and its amount is a whole number; anything else is unreadable, never a zero.
    if (row === undefined || row.company !== cid || !whole(row.spentMicros)) return ANSWERS.unavailable;
    // The meter keys its rows by the month of ITS clock: an answer across a month change is not trusted.
    if (monthOf(now()) !== month) return ANSWERS.unavailable;
    const answer: UpkeepCapReadAnswer = { version: 1, company: cid, project: pid, month, enforced: true, limitMicros, spentMicros: row.spentMicros };
    return { status: 200, body: answer };
  } catch { return ANSWERS.unavailable; }
}

/** The HTTP handler the serving process mounts for UPKEEP_CAP_READ_PATH (process.ts). */
export function createUpkeepCapReadHandler(options: UpkeepCapReadHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, UPKEEP_CAP_READ_OPEN, UPKEEP_CAP_READ_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      // A GET carries no body worth reading; it is dropped unread.
      req.resume();
      const answer = release === undefined ? ANSWERS.busy : await answerUpkeepCapRead(options, { method: req.method ?? "", url: req.url ?? "", headers: req.headers }, controller.signal);
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
