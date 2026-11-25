// GATEWAY-RUN-CHARGES-ROUTE: the gateway's signed, READ-ONLY answer of what one run actually cost. Code's hosted broker reads it for a run whose usage never reached it (a lost run, a Stop the worker did not
// answer; Code's `gateway-run-charges-http.ts`), so it counts what was spent instead of the hold's whole amount.
//
//   GET /v1/service/companies/<companyId>/runs/<operationId>/charges?task=<taskId>
//     authorization: Bearer <service token>   typ rovara-service+jwt, aud RUN_CHARGES_AUDIENCE, cid = the company asked about,
//                                             signed by the install's TASK key (verified exactly as the offered-models and upkeep-cap tokens are: pinned issuer and
//                                             key ids, RS256, the claims exactly iss/aud/jti/iat/nbf/exp/cid, at most SERVICE_TOKEN_SECONDS of life)
//   200 exactly {"version":1,"operationId","seen":true,"complete":boolean,"indexedSince":"<ISO UTC>","reason"?:"started_before_index","receipts":[ChargeReceiptV1, ...]}      amounts in USD micros (one millionth of a dollar), as every receipt's own `amountMicros`
//       `seen: true` is the gateway's word that it HAS recorded calls for this run (it is on every 200 and only there: "never seen" is the 404). So a reader that takes "complete, no receipts" as a
//       final $0 can require `seen: true`; this route never answers a 200 with no receipts at all (see below), so that case cannot arise from it.
//   404 {"error":{"type":"not_found","message":"not found"}}    no record, another company's run, another task's run, an operation id that is not one: ONE answer, so none of them can be told apart
//   503                                                         the gateway cannot read the whole run right now (a call with no receipt, too many calls, a store that does not answer)
//
// What a run is: the task token's `op` (the operation id; Code's `OperationRecord.id`). Every call the gateway admits for it takes a hold; the meter writes the run's index item in the same transaction as the hold
// (meter.ts `ReserveInput.run`, dynamo-meter.ts `RUN#`), so a call that holds money is never missing from the run. What `complete` means: NO call of the run holds an open reservation (every call is settled, or is the
// gateway's own estimate, which is then the receipt's `status`). A run with a call still open (a stream still running, a settle not landed) answers `complete: false`: the receipts are what the gateway holds so far, with an
// open call's receipt as its hold wrote it (`awaiting_usage`, amount = its reservation), so a reader cannot take the number as final. A receipt that is not `final` is an estimate; Code reads that off each receipt's status.
// `indexedSince`: when the gateway began recording calls under their run (one marker per environment). Calls held before it are not in any run's record, so a run whose first recorded call is at or before
// `indexedSince` + RUN_INDEX_GRACE_MS (75 minutes: one call's longest life and the sweep's quarter hour) is answered `complete: false` with `reason: "started_before_index"`: never a final sum. A run that
// began before `indexedSince` but made its first recorded call later is only the reader's to catch: it must treat an operation that started before `indexedSince` as unknown.
// There is NEVER a 200 with no receipts: a run with no record is a 404 (a reader that took an empty list as "$0" would book nothing for a run that cost money).
//
// Company isolation: the company is the token's `cid`; a path naming another company is refused as an unsigned call (nothing about either company's runs is looked at), and the run is looked up only under the token's
// company AND the task named in the query: another company's run, or the same run under another task, is not found. Nothing from the request, a token or a store is echoed or logged.
// No customer data beyond amounts: a receipt is answered with the people and names it holds (who asked, who pays, the provider's request id, the connection's name, the project) replaced by the contract's own
// "restricted" values, so the answer holds money, model, usage counts and times only. The stored receipts are untouched.
import type { IncomingMessage, ServerResponse } from "node:http";
import { chargeValue, parseChargeReceiptV1, type ChargeReceiptV1 } from "./charge-receipt.js";
import type { RunChargesRead, RunScope } from "./meter.js";
import { COMPANY, TASK, record, whole } from "./model-gateway-token.js";
import { SERVICE_TOKEN_CLAIMS, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_TYPE } from "./offered-models.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";

export const RUN_CHARGES_AUDIENCE = "rovara-model-gateway-run-charges";
export const RUN_CHARGES_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/charges$/iu;
/** Per serving task, before any key fetch or store read (the path is on the public load balancer). */
export const RUN_CHARGES_OPEN = 8;
export const RUN_CHARGES_PER_MINUTE = 600;

export interface RunChargesClaims { iss: string; aud: typeof RUN_CHARGES_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The service token's claims, exactly (the offered-models token's members, with this route's audience). */
export function parseRunChargesClaims(value: unknown): RunChargesClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== RUN_CHARGES_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as RunChargesClaims;
}
/** createSignedTokenVerifier(..., RUN_CHARGES_TOKEN_KIND): pinned issuer and task key ids, RS256, at most 60 seconds of life. */
export const RUN_CHARGES_TOKEN_KIND: SignedTokenKind<RunChargesClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseRunChargesClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

export interface RunChargesHandlerOptions {
  /** createSignedTokenVerifier(..., RUN_CHARGES_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<RunChargesClaims | undefined>;
  /** The agent meter (the one the agent route reserves on): only `runCharges` is used. */
  meter: { runCharges(scope: RunScope, operationId: string): Promise<RunChargesRead> };
  now?: () => number;
}
export interface RunChargesAnswer { version: 1; operationId: string; seen: true; complete: boolean; indexedSince: string; reason?: "started_before_index"; receipts: ChargeReceiptV1[] }

const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notFound: { status: 404, body: { error: { type: "not_found", message: "not found" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;
export const RUN_CHARGES_ANSWERS = ANSWERS;

/** The text every person-level or customer-named field is replaced by (the receipt contract's own word for "withheld": `unavailable`/`restricted`). */
const WITHHELD = "restricted";
/** A receipt as the route answers it: amounts, model, usage counts and times kept; who asked, who pays, the provider's request id, the connection's name and the project withheld. */
export function projectRunReceipt(r: ChargeReceiptV1): ChargeReceiptV1 {
  return {
    ...structuredClone(r), project: WITHHELD,
    providerRequestId: { state: "unavailable", reason: "restricted" }, requesterId: { state: "unavailable", reason: "restricted" },
    source: { ...r.source, name: WITHHELD },
    payer: r.payer.kind === "mixed" ? { kind: "mixed", name: WITHHELD } : { kind: r.payer.kind, id: WITHHELD, name: WITHHELD },
  };
}

/** The query is exactly one `task`, a task id in the gateway's own format; the run's id is the path's (a UUID by the path's own pattern). */
function taskOf(query: string): string | undefined {
  const params = new URLSearchParams(query);
  const all = [...params.keys()];
  const task = params.get("task");
  return all.length === 1 && all[0] === "task" && params.getAll("task").length === 1 && task !== null && TASK.test(task) ? task : undefined;
}

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerRunCharges(options: RunChargesHandlerOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  const cut = request.url.indexOf("?");
  const target = RUN_CHARGES_PATH.exec(cut < 0 ? request.url : request.url.slice(0, cut));
  if (target === null) return ANSWERS.notFound;
  if (request.method !== "GET") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const claims = await options.verify(auth.slice(7));
  // The token's company is THE company; a path naming another company is an unsigned call (nothing about either company is said or read).
  if (claims === undefined || claims.cid !== target[1]) return ANSWERS.refused;
  const task = taskOf(cut < 0 ? "" : request.url.slice(cut + 1));
  if (task === undefined) return ANSWERS.notFound;
  const operationId = target[2]!;
  if (signal?.aborted === true) return ANSWERS.unavailable;
  try {
    const read = await options.meter.runCharges({ iss: claims.iss, cid: claims.cid, tid: task }, operationId);
    if (!read.found) return ANSWERS.notFound;
    // Every receipt must read, as Code's reader reads it, with an amount: a run is answered whole or not at all.
    if (read.receipts.length === 0) return ANSWERS.unavailable;
    const receipts = read.receipts.map(projectRunReceipt);
    for (const receipt of receipts) if (parseChargeReceiptV1(receipt) === undefined || chargeValue(receipt.amountMicros) === undefined) return ANSWERS.unavailable;
    receipts.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0));
    // A run whose record may start before the index did is never complete (a reader would take the sum as final): `reason` says why.
    const answer: RunChargesAnswer = { version: 1, operationId, seen: true, complete: read.complete && !read.startedBeforeIndex, indexedSince: new Date(read.indexedSince).toISOString(), ...(read.startedBeforeIndex ? { reason: "started_before_index" as const } : {}), receipts };
    return { status: 200, body: answer };
  } catch { return ANSWERS.unavailable; }
}

/** The HTTP handler the serving process mounts for RUN_CHARGES_PATH (process.ts). */
export function createRunChargesHandler(options: RunChargesHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, RUN_CHARGES_OPEN, RUN_CHARGES_PER_MINUTE);
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    res.once("close", abort);
    const release = limit.take();
    try {
      // A GET carries no body worth reading; it is dropped unread.
      req.resume();
      const answer = release === undefined ? ANSWERS.busy : await answerRunCharges(options, { method: req.method ?? "", url: req.url ?? "", headers: req.headers }, controller.signal);
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); res.off("close", abort); }
  };
}
