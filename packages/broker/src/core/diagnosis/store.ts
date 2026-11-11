// Fix with agent: what a diagnosis keeps, and the rates and the "one open diagnosis per error" rule around it, on the DocumentStore port. The key layout is the hosted product's, so a Cloud install can read what this one wrote.
//
//   DIAGNOSIS#<id> / REQUEST   ids, the tier, the error reference (codes and ids), the state, and WHILE IT WAITS the context text the turn is given. The text is removed when the request settles and the item then lives 30
//                              days; an unanswered request expires on its own within a day.
//   DIAGNOSIS#<id> / RECORD    the result: the proposals (already read again by `sanitizeDiagnosis`), the model and the cost. No error text, no requester. 30 days.
//   DIAGNOSIS#<id> / PERSON    who asked. Kept apart, with an index (`DIAGNOSISBY#<developerId>`, whose rows also carry `createdAt` here), so erasing the person removes the link and keeps the diagnosis.
//   DIAGNOSISOPEN              "one open diagnosis per ErrorRef": the same error answers the existing diagnosis for an hour, and spends nothing.
//   DIAGNOSISRATE              the counters: light 10 an hour per person and 50 a day per project. The owner pays for a diagnosis on their own key; Rovara keeps no money counter for it.
// The hosted product's one-key-per-diagnosis claim (`keyClaimedAt`, `keyModel`, `keySource`, `retryClaimedAt`) is not written here: the turn runs in this process, once, on a key the proxy mints for that one call.
import { createHash } from "node:crypto";
import {
  DIAGNOSIS_DEDUPE_SECONDS, DIAGNOSIS_RATE, DIAGNOSIS_REFUSALS, DIAGNOSIS_RETENTION_DAYS, DiagnosisFailureReasonSchema, DiagnosisRecordSchema, ErrorRefSchema, INDEX_EXPIRY_ATTRIBUTE,
  agentXError, diagnosisByPersonKey, diagnosisByPersonPk, queryAll, diagnosisKey, diagnosisOpenKey, diagnosisRateKey, errorRefKey, when,
  type DiagnosisFailureReason, type DiagnosisRecord, type DiagnosisTier, type DocumentStore, type ErrorRef, type OrgId, type StoredDocument, type TransactItem,
} from "@agentx/contracts";

export interface DiagnosisStoreDependencies { store: DocumentStore; now: () => number; log?: ((entry: Record<string, unknown>) => void) | undefined }

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A waiting request is kept a day: long enough to be read, short enough that the context text it holds does not linger. */
export const REQUEST_WAITING_SECONDS = 86_400;
/** A request still waiting after this long reads as failed (the turn never ended). */
export const REQUEST_STALE_MS = 15 * 60_000;
/** How many times the counters are read again after losing a race to another request. */
export const RATE_RACE_ATTEMPTS = 4;

/** The diagnosis id of a request: the same person, request and tier always give the same id, so a repeat is the same diagnosis and spends nothing. */
export function diagnosisIdFor(orgId: string, developerId: string, requestId: string, tier: DiagnosisTier): string {
  const digest = createHash("sha256").update(`diagnosis\0${orgId}\0${developerId}\0${requestId}\0${tier}`, "utf8").digest();
  let value = BigInt(`0x${digest.subarray(0, 13).toString("hex")}`);
  let out = "";
  for (let index = 0; index < 20; index += 1) { out = "0123456789abcdefghijklmnopqrstuvwxyz"[Number(value % 36n)]! + out; value /= 36n; }
  return `dgn_${out}`;
}

// ---- the items

export interface DiagnosisRequest {
  diagnosisId: string;
  tier: DiagnosisTier;
  errorRef: ErrorRef;
  project: string;
  state: "queued" | "ready" | "failed";
  createdAt: string;
  /** Light: the context text the turn is given, while it waits. */
  context?: string | undefined;
  /** Failed: why the turn ended without an answer, as a fixed word. Absent: no reason known. */
  failureReason?: DiagnosisFailureReason | undefined;
}

export async function readDiagnosisRequest(deps: Pick<DiagnosisStoreDependencies, "store">, orgId: OrgId, diagnosisId: string): Promise<DiagnosisRequest | undefined> {
  const item = await deps.store.get(diagnosisKey(orgId, diagnosisId, "REQUEST"));
  if (item === undefined || item["orgId"] !== orgId || item["entityType"] !== "DIAGNOSIS_REQUEST") return undefined;
  const errorRef = ErrorRefSchema.safeParse(item["errorRef"]);
  const tier = item["tier"], state = item["state"];
  if (!errorRef.success || (tier !== "light" && tier !== "deep") || (state !== "queued" && state !== "ready" && state !== "failed") || typeof item["project"] !== "string" || typeof item["createdAt"] !== "string") return undefined;
  return {
    diagnosisId, tier, errorRef: errorRef.data, project: item["project"], state, createdAt: item["createdAt"],
    ...(typeof item["context"] === "string" ? { context: item["context"] } : {}),
    ...(DiagnosisFailureReasonSchema.safeParse(item["failureReason"]).success ? { failureReason: item["failureReason"] as DiagnosisFailureReason } : {}),
  };
}

/** The result, or undefined: not there, another org's, or not readable as a record (a record that does not parse is no record). */
export async function readDiagnosisRecord(deps: Pick<DiagnosisStoreDependencies, "store">, orgId: OrgId, diagnosisId: string): Promise<DiagnosisRecord | undefined> {
  const item = await deps.store.get(diagnosisKey(orgId, diagnosisId, "RECORD"));
  if (item === undefined || item["orgId"] !== orgId) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, orgId: _org, [INDEX_EXPIRY_ATTRIBUTE]: _expires, ...record } = item;
  void _pk; void _sk; void _type; void _org; void _expires;
  const parsed = DiagnosisRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}

/** Who asked, from the person-link row; undefined once they were erased. */
export async function readDiagnosisRequester(deps: Pick<DiagnosisStoreDependencies, "store">, orgId: OrgId, diagnosisId: string): Promise<string | undefined> {
  const item = await deps.store.get(diagnosisKey(orgId, diagnosisId, "PERSON"));
  return item !== undefined && item["orgId"] === orgId && typeof item["requestedBy"] === "string" ? item["requestedBy"] : undefined;
}

// ---- the rates

interface RateStep { room: boolean; item: TransactItem }

/**
 * The window a counter is in. This process's own clock decides (`deps.now`, never a request's time). A stored window NEWER than this one, by at most one window, was written by a clock that runs ahead; it is the window
 * still (the count is kept), never a reason to start again from zero. A stored window older than this one is a finished window (a new count), and one more than a window ahead is not trusted (a new count under this window).
 */
function windowOf(nowMs: number, windowMs: number, seenWindow: unknown): { window: number; inWindow: boolean } {
  const window = Math.floor(nowMs / windowMs) * windowMs;
  if (typeof seenWindow !== "number") return { window, inWindow: false };
  if (seenWindow === window) return { window, inWindow: true };
  return seenWindow > window && seenWindow - window <= windowMs ? { window: seenWindow, inWindow: true } : { window, inWindow: false };
}

/** One fixed-window counter as a step of the request's own transaction: the new count is set from the count that was read, conditional on it, so two requests cannot both take the last place. */
async function rateStep(deps: DiagnosisStoreDependencies, key: { pk: string; sk: string }, orgId: OrgId, limit: number, windowMs: number): Promise<RateStep> {
  const stored = await deps.store.get(key);
  const seenWindow = stored?.["windowStart"], seenCount = stored?.["count"];
  if (stored !== undefined && (typeof seenWindow !== "number" || typeof seenCount !== "number")) throw agentXError("RUNTIME_UNAVAILABLE", "diagnosis counters can't be read");
  const { window, inWindow } = windowOf(deps.now(), windowMs, seenWindow);
  const count = inWindow && typeof seenCount === "number" ? seenCount : 0;
  return {
    room: count < limit,
    item: {
      kind: "put",
      item: { ...key, entityType: "DIAGNOSIS_RATE", orgId, windowStart: window, count: count + 1, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((window + 2 * windowMs) / 1000) },
      condition: stored === undefined ? when.absent() : when.and(when.eq("windowStart", seenWindow as number), when.eq("count", seenCount as number)),
    },
  };
}

// ---- admitting

export interface DiagnosisAdmission {
  orgId: OrgId;
  developerId: string;
  requestId: string;
  tier: DiagnosisTier;
  errorRef: ErrorRef;
  project: string;
  /** Light: the context text the turn will be given. */
  context?: string | undefined;
  /** Steps that commit with the admission (the audit record of the start). */
  extraItems?: readonly TransactItem[] | undefined;
}

/**
 * Spends the rates, takes the "one open diagnosis" place for the error and records the request, its person link and the erasure index, in one transaction. Answers the diagnosis id and whether this call made it
 * (`created`): a repeat of the same request, or the same error while its diagnosis is open (an hour), answers the existing one and spends nothing. `TOO_MANY_REQUESTS` when a counter is full.
 */
export async function admitDiagnosis(deps: DiagnosisStoreDependencies, input: DiagnosisAdmission): Promise<{ diagnosisId: string; created: boolean }> {
  const { orgId } = input;
  const diagnosisId = diagnosisIdFor(orgId, input.developerId, input.requestId, input.tier);
  if (await deps.store.get(diagnosisKey(orgId, diagnosisId, "REQUEST")) !== undefined) return { diagnosisId, created: false };
  const errorKey = errorRefKey(input.errorRef);
  const openKey = diagnosisOpenKey(orgId, input.tier, errorKey);
  const openNow = async (): Promise<string | undefined> => {
    const open = await deps.store.get(openKey);
    return open !== undefined && typeof open["diagnosisId"] === "string" && typeof open["expiresAt"] === "number" && open["expiresAt"] > deps.now() ? open["diagnosisId"] : undefined;
  };
  for (let attempt = 1; ; attempt += 1) {
    const existing = await openNow();
    if (existing !== undefined) return { diagnosisId: existing, created: false };
    const nowMs = deps.now();
    const steps = [
      await rateStep(deps, diagnosisRateKey(orgId, "light_person", input.developerId), orgId, DIAGNOSIS_RATE.lightPerPersonPerHour, HOUR_MS),
      await rateStep(deps, diagnosisRateKey(orgId, "light_project", input.project), orgId, DIAGNOSIS_RATE.lightPerProjectPerDay, DAY_MS),
    ];
    if (steps.some((step) => !step.room)) throw agentXError("TOO_MANY_REQUESTS", DIAGNOSIS_REFUSALS.rateLimited);
    const waitingUntil = Math.floor(nowMs / 1000) + REQUEST_WAITING_SECONDS;
    const keep = Math.floor(nowMs / 1000) + DIAGNOSIS_RETENTION_DAYS * 86_400;
    const result = await deps.store.transact([
      ...steps.map((step) => step.item),
      { kind: "put", item: { ...openKey, entityType: "DIAGNOSIS_OPEN", orgId, diagnosisId, tier: input.tier, expiresAt: nowMs + DIAGNOSIS_DEDUPE_SECONDS * 1000, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + DIAGNOSIS_DEDUPE_SECONDS * 2 },
        condition: when.or(when.absent(), when.lte("expiresAt", nowMs)) },
      { kind: "put", item: { ...diagnosisKey(orgId, diagnosisId, "REQUEST"), entityType: "DIAGNOSIS_REQUEST", orgId, diagnosisId, tier: input.tier, errorRef: input.errorRef as unknown as StoredDocument[string], project: input.project, state: "queued", createdAt: new Date(nowMs).toISOString(),
        ...(input.context === undefined ? {} : { context: input.context }), [INDEX_EXPIRY_ATTRIBUTE]: waitingUntil }, condition: when.absent() },
      { kind: "put", item: { ...diagnosisKey(orgId, diagnosisId, "PERSON"), entityType: "DIAGNOSIS_PERSON", orgId, diagnosisId, requestedBy: input.developerId, [INDEX_EXPIRY_ATTRIBUTE]: keep } },
      { kind: "put", item: { ...diagnosisByPersonKey(orgId, input.developerId, diagnosisId), entityType: "DIAGNOSIS_BY", orgId, diagnosisId, createdAt: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: keep } },
      ...(input.extraItems ?? []),
    ]);
    if (result.applied) return { diagnosisId, created: true };
    // Another call won the place at the same moment: if it was this very request or the same error, that is the answer.
    if (await deps.store.get(diagnosisKey(orgId, diagnosisId, "REQUEST")) !== undefined) return { diagnosisId, created: false };
    const raced = await openNow();
    if (raced !== undefined) return { diagnosisId: raced, created: false };
    // Only the counters moved (another request): read them again, a bounded number of times, without blaming the asker.
    if (attempt >= RATE_RACE_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", "Couldn't diagnose this now.");
  }
}

// ---- settling

/** The items that end a waiting request: its state (conditional on `queued`, so only the first ending counts), the context text removed, and, for a result, the record. */
export function diagnosisSettleItems(
  orgId: OrgId, diagnosisId: string, nowMs: number, outcome: { state: "failed"; reason?: DiagnosisFailureReason | undefined } | { state: "ready"; record: DiagnosisRecord },
): TransactItem[] {
  const keep = Math.floor(nowMs / 1000) + DIAGNOSIS_RETENTION_DAYS * 86_400;
  return [
    {
      kind: "update", key: diagnosisKey(orgId, diagnosisId, "REQUEST"),
      ops: [
        { op: "set", path: ["state"], value: outcome.state }, { op: "set", path: ["settledAt"], value: new Date(nowMs).toISOString() }, { op: "set", path: [INDEX_EXPIRY_ATTRIBUTE], value: keep },
        ...(outcome.state === "failed" && outcome.reason !== undefined ? [{ op: "set" as const, path: ["failureReason"] as const, value: outcome.reason }] : []),
        { op: "remove", path: ["context"] },
      ],
      condition: when.and(when.eq("state", "queued"), when.eq("orgId", orgId)),
    },
    ...(outcome.state === "ready"
      ? [{ kind: "put" as const, item: { ...diagnosisKey(orgId, diagnosisId, "RECORD"), entityType: "DIAGNOSIS_RECORD", orgId, ...(JSON.parse(JSON.stringify(outcome.record)) as Record<string, never>), [INDEX_EXPIRY_ATTRIBUTE]: keep } }]
      : []),
  ];
}

/** Ends a waiting request. Answers whether this call ended it (a repeat answers false and writes nothing). A failure also frees the error's open place, so it can be asked about again. `extraItems` commit with it (the audit record). */
export async function settleDiagnosis(
  deps: DiagnosisStoreDependencies, orgId: OrgId, request: Pick<DiagnosisRequest, "diagnosisId" | "tier" | "errorRef">,
  outcome: { state: "failed"; reason?: DiagnosisFailureReason | undefined } | { state: "ready"; record: DiagnosisRecord }, extraItems: readonly TransactItem[] = [],
): Promise<boolean> {
  const result = await deps.store.transact([...diagnosisSettleItems(orgId, request.diagnosisId, deps.now(), outcome), ...extraItems]);
  if (!result.applied) return false;
  if (outcome.state === "failed") await freeOpenPlace(deps, orgId, request);
  return true;
}

/** Lets go of the error's open place, only if it is still this diagnosis's. A failure is ignored (the place ends by itself within the hour). */
export async function freeOpenPlace(deps: Pick<DiagnosisStoreDependencies, "store">, orgId: OrgId, request: Pick<DiagnosisRequest, "diagnosisId" | "tier" | "errorRef">): Promise<void> {
  await deps.store.update({
    key: diagnosisOpenKey(orgId, request.tier, errorRefKey(request.errorRef)), ops: [{ op: "set", path: ["expiresAt"], value: 0 }], condition: when.eq("diagnosisId", request.diagnosisId),
  }).catch(() => undefined);
}

/** The diagnosis that is open for this error and tier now, if any (its id). */
export async function openDiagnosisFor(deps: Pick<DiagnosisStoreDependencies, "store" | "now">, orgId: OrgId, tier: DiagnosisTier, errorRef: ErrorRef): Promise<string | undefined> {
  const open = await deps.store.get(diagnosisOpenKey(orgId, tier, errorRefKey(errorRef)));
  return open !== undefined && typeof open["diagnosisId"] === "string" && typeof open["expiresAt"] === "number" && open["expiresAt"] > deps.now() ? open["diagnosisId"] : undefined;
}

/**
 * The newest light diagnosis of this error that this person asked for within the dedupe window, whatever became of it: the open one if there is one, else (a diagnosis that failed lets go of its place) the person's
 * own, read from their index. A page uses it to show a failed diagnosis's words and to offer "Try again". Older than the window, a diagnosis is not this occurrence's, and the error is asked about afresh.
 */
export async function latestDiagnosisFor(deps: Pick<DiagnosisStoreDependencies, "store" | "now">, orgId: OrgId, developerId: string, errorRef: ErrorRef): Promise<DiagnosisRequest | undefined> {
  const open = await openDiagnosisFor(deps, orgId, "light", errorRef);
  if (open !== undefined) {
    const request = await readDiagnosisRequest(deps, orgId, open);
    if (request !== undefined) return request;
  }
  const key = errorRefKey(errorRef);
  const since = deps.now() - DIAGNOSIS_DEDUPE_SECONDS * 1000;
  const listed = await queryAll(deps.store, { pk: diagnosisByPersonPk(orgId, developerId) });
  let newest: DiagnosisRequest | undefined;
  for (const row of listed) {
    if (typeof row["diagnosisId"] !== "string" || row["orgId"] !== orgId) continue;
    // The index row says when the diagnosis was made (a row from the hosted product does not, and is read).
    if (typeof row["createdAt"] === "string" && Date.parse(row["createdAt"]) < since) continue;
    const request = await readDiagnosisRequest(deps, orgId, row["diagnosisId"]);
    if (request === undefined || request.tier !== "light" || errorRefKey(request.errorRef) !== key || Date.parse(request.createdAt) < since) continue;
    if (newest === undefined || request.createdAt > newest.createdAt) newest = request;
  }
  return newest;
}
