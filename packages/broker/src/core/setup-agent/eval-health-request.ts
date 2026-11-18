// L4-EVC (DEC 254zzz20 D5): the OPT-IN eval health run. After the spend approval the setup card offers "Check my evals now (about $Y)". Nothing here runs a model: a person says yes, and the broker keeps
// ONE request row (`EVAL_HEALTH_REQUEST` in the project's company-scoped setup partition) that the host's health runner reads. No yes, no row, no run: the setup never starts a health run by itself, and a
// request is void as soon as the approval it was made under is replaced (an eval set that needed a new approval asks again).
//
// Who may say yes: the same people who may approve the eval's spend (a company owner or admin, or the project's maintainer, read LIVE from the members seam in their own company), and only while the
// spend item is approved by someone who still holds that right. The cost the person was shown (`seenCostMicros`) must be the broker's own figure for the item; any difference is refused and nothing is
// kept. A repeat of the same yes (the same request id) is the same answer. Fixed words only; no input is echoed.
//
// L4-EVH: the row also carries the run's own life. `requested` (a yes waits) -> `running` (the broker claimed it: `claim`, its own random id, the repositories' main heads it read, and the cache key it will keep the result
// under) -> `finished` (a result: pass or fail per case) or `not_run` (a closed reason). Only the broker moves it, each move one conditional write on the exact prior row.
import { z } from "zod";
import {
  EVAL_HEALTH_MAX_AGE_MS, EVAL_HEALTH_RUN_MAX_MS, EvalHealthNotRunReasonSchema, agentXError, change, evalBaseCacheKey, when,
  type DocumentStore, type JsonValue, type EvalHealthNotRunReason, type OrgId, type Principal, type StoredDocument,
} from "@agentx/contracts";
import type { SessionMembers } from "../sessions/access.js";
import { developerIdOf } from "../sessions/create.js";
import { dollarsOf } from "./eval-cost.js";
import { readApprovedEvalPlan, readEvalSpendItem, roleFor } from "./eval-spend.js";
import { setupPartition } from "./keys.js";

export const EVAL_HEALTH_REQUEST_ENTITY = "EVAL_HEALTH_REQUEST";
export const evalHealthRequestKey = (company: string, project: string) => ({ pk: setupPartition(company, project), sk: "EVAL_HEALTH_REQUEST" });

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const EvalHealthRequestBodySchema = z.object({
  requestId: z.string().uuid(),
  /** The cost the person was shown on the button, in micro-dollars; the broker holds it against its own figure. */
  seenCostMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

const hex40 = z.string().regex(/^[a-f0-9]{40}$/u);
/** The cache key parts the broker kept for this run when it claimed it: its own, from its own plan and the main head it read (never a worker's). */
const KeyPartsSchema = z.object({
  company: z.string().min(1).max(100), project: z.string().min(1).max(200), baseCommit: hex40, codeHash: hash, judgePin: hash, evalSetHash: hash, hiddenSetHash: z.literal("none"),
  commandFingerprint: hash, catalogRowId: z.string().min(1).max(40), model: z.string().min(1).max(200), modelVersion: z.string().min(1).max(200), settingsFingerprint: hash,
}).strict().refine(parts => { try { evalBaseCacheKey(parts); return true; } catch { return false; } }, "a valid cache key");
const ClaimSchema = z.object({
  claimId: z.string().uuid(), at: z.iso.datetime(),
  bases: z.array(z.object({ repositoryId: z.string().min(1).max(200), baseCommitSha: hex40 }).strict()).min(1).max(16),
  parts: KeyPartsSchema,
  /** The baseline's measuring mark (so a task that arrives meanwhile reads "measuring", not a second measurement); finished with the run. */
  mark: z.object({ claimId: z.string().uuid(), startedAt: z.number().int().min(0), expiresAt: z.number().int().min(0), state: z.literal("measuring") }).strict().optional(),
}).strict();
/** What a person is told of a finished run: pass or fail per case (how many of the three answers passed), never an answer's text. */
const ResultSchema = z.object({
  at: z.iso.datetime(), questionCount: z.number().int().min(1).max(1_000), passedAnswers: z.number().int().min(0).max(3_000), totalAnswers: z.number().int().min(1).max(3_000), differing: z.number().int().min(0).max(1_000),
  cases: z.array(z.object({ id: z.string().min(1).max(160), passes: z.number().int().min(0).max(3) }).strict()).min(1).max(1_000),
  /** False: measured, but the baseline could not be kept. */
  saved: z.boolean(),
  /** True: the project already had this exact baseline; nothing was run or spent. */
  reused: z.boolean(),
}).strict();
export type EvalHealthResultSummary = z.infer<typeof ResultSchema>;

const RecordSchema = z.object({
  entityType: z.literal(EVAL_HEALTH_REQUEST_ENTITY), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  requestId: z.string().uuid(),
  /** The approved spend item the request was made under (its digest); a request under another item is void. */
  spendDigest: hash,
  estimateMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestedBy: z.object({ personId: z.string().min(1).max(256), provider: z.string().min(1).max(200), role: z.enum(["owner", "admin", "maintainer"]), at: z.iso.datetime() }).strict(),
  state: z.enum(["requested", "running", "finished", "not_run"]),
  claim: ClaimSchema.optional(),
  notRun: z.object({ reason: EvalHealthNotRunReasonSchema, at: z.iso.datetime() }).strict().optional(),
  result: ResultSchema.optional(),
}).strict();
export type EvalHealthRequestRecord = z.infer<typeof RecordSchema>;

export interface EvalHealthRequestDeps { store: DocumentStore; companyId: OrgId; now: () => number; members?: SessionMembers | undefined; monthlyCapMicros?: number | undefined }

/** The stored row, only when it is this company's and project's and exactly the shape the broker writes. */
export const parseEvalHealthRow = parse;
function parse(deps: Pick<EvalHealthRequestDeps, "companyId">, project: string, raw: StoredDocument | undefined): EvalHealthRequestRecord | undefined {
  if (raw === undefined) return undefined;
  const { pk, sk, ...value } = raw;
  void pk; void sk;
  const parsed = RecordSchema.safeParse(value);
  return parsed.success && parsed.data.company === deps.companyId && parsed.data.project === project ? parsed.data : undefined;
}

/** A yes older than the maximum age: it is not run. */
export const evalHealthRequestExpired = (row: Pick<EvalHealthRequestRecord, "requestedBy">, nowMs: number): boolean => !(nowMs - Date.parse(row.requestedBy.at) <= EVAL_HEALTH_MAX_AGE_MS);
/** A claimed run that has not reported within its window (or whose claim is unreadable): it is over. */
export const evalHealthRunExpired = (row: Pick<EvalHealthRequestRecord, "claim">, nowMs: number): boolean => row.claim === undefined || !(nowMs - Date.parse(row.claim.at) <= EVAL_HEALTH_RUN_MAX_MS);

/** The fixed refusal: the error only (never the input). */
const refuse = (code: Parameters<typeof agentXError>[0], message: string): never => { throw agentXError(code, message); };

/**
 * A person's yes to "Check my evals now". Returns whether this was a repeat. Refuses: another company, a role that may not approve eval spend, no standing approval, a stale cost, a request id
 * already used for something else. Writes only the request row; the health run itself is the host's (it reads `readEvalHealthRequest`).
 */
export async function requestEvalHealthCheck(deps: EvalHealthRequestDeps, project: string, rawBody: unknown, principal: Principal): Promise<{ requested: true; duplicate: boolean; cost: string }> {
  const parsed = EvalHealthRequestBodySchema.safeParse(rawBody);
  if (!parsed.success) return refuse("CONFIG_INVALID", "That check was not understood.");
  const body = parsed.data;
  if (principal?.companyId !== deps.companyId) return refuse("FORBIDDEN", "Only a company owner, admin or project maintainer can start the eval check.");
  const table = { store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(deps.monthlyCapMicros === undefined ? {} : { monthlyCapMicros: deps.monthlyCapMicros }) };
  const role = await roleFor(table, project, { companyId: deps.companyId, developerId: developerIdOf(principal), principal });
  if (role === undefined) return refuse("FORBIDDEN", "Only a company owner, admin or project maintainer can start the eval check.");
  // The approval must stand: approved, bound to its own plan, and by someone who still may approve (read live inside `readEvalSpendItem`).
  const [found, item] = await Promise.all([readApprovedEvalPlan(table, project), readEvalSpendItem(table, project)]);
  if (found === undefined || item?.state !== "approved") return refuse("CHANGE_STALE", "The eval's spend isn't approved, so it can't be checked yet.");
  const estimate = found.spend.plan.estimate.costMicros;
  if (body.seenCostMicros !== estimate) return refuse("CHANGE_STALE", "The check's cost changed since you looked. Read it again.");
  const key = evalHealthRequestKey(deps.companyId, project);
  const raw = await deps.store.get(key);
  const before = parse(deps, project, raw);
  // Idempotent per request id: a repeat of a yes already taken (waiting, finished or void) is the same answer and queues nothing again, so a stale retry of an old click never starts another run.
  if (before !== undefined && before.requestId === body.requestId) return { requested: true, duplicate: true, cost: dollarsOf(estimate) };
  // One check at a time for one approval. A yes older than a day, or a run that never reported back, no longer holds a place (the row says why when it is read).
  const at = deps.now();
  if (before !== undefined && before.spendDigest === found.spend.digest && before.state === "requested" && !evalHealthRequestExpired(before, at)) return refuse("CHANGE_STALE", "An eval check is already waiting to run.");
  // A live claim holds the place whatever approval it was made under: a new yes never overwrites a run that is spending (its mark and its worker would be orphaned).
  if (before !== undefined && before.state === "running" && !evalHealthRunExpired(before, at)) return refuse("CHANGE_STALE", "An eval check is already running.");
  const row: EvalHealthRequestRecord = RecordSchema.parse({ entityType: EVAL_HEALTH_REQUEST_ENTITY, schemaVersion: 1, company: deps.companyId, project, requestId: body.requestId, spendDigest: found.spend.digest, estimateMicros: estimate,
    requestedBy: { personId: principal.personId, provider: principal.provider, role, at: new Date(deps.now()).toISOString() }, state: "requested" });
  const condition = raw === undefined ? when.absent() : when.and(...Object.entries(raw).map(([name, value]) => when.eq([name], value)));
  const written = await deps.store.put({ item: { ...key, ...row } as unknown as StoredDocument, condition });
  if (!written.applied) return refuse("CHANGE_STALE", "The eval check changed. Read it again.");
  return { requested: true, duplicate: false, cost: dollarsOf(estimate) };
}

const tableOf = (deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros">) => ({ store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(deps.monthlyCapMicros === undefined ? {} : { monthlyCapMicros: deps.monthlyCapMicros }) });

/**
 * Whether the approval a request was made under still stands: the spend item is approved by someone who still holds the right to approve (its own live reading), it is the very item the request names (its digest),
 * and its estimate is the one the request carries. A replaced approval (an eval that grew, another model) is no approval for an old yes.
 */
export async function evalHealthApprovalStands(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros">, project: string, row: Pick<EvalHealthRequestRecord, "spendDigest" | "estimateMicros">): Promise<boolean> {
  try {
    const table = tableOf(deps);
    const [found, item] = await Promise.all([readApprovedEvalPlan(table, project), readEvalSpendItem(table, project)]);
    return found !== undefined && item?.state === "approved" && found.spend.digest === row.spendDigest && found.spend.plan.estimate.costMicros === row.estimateMicros;
  } catch { return false; }
}

/**
 * What the health runner reads: the person's request, only while it is this company's, unedited in shape, still waiting AND made under the spend item that is approved now. Anything else is no request,
 * so a run never starts without a current yes. (The runner still goes through the approval and the monthly meter; this is not authority to spend, and the request's estimate is never one.)
 */
export async function readEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros">, project: string): Promise<EvalHealthRequestRecord | undefined> {
  try {
    const row = parse(deps, project, await deps.store.get(evalHealthRequestKey(deps.companyId, project)));
    if (row === undefined || row.state !== "requested") return undefined;
    return await evalHealthApprovalStands(deps, project, row) ? row : undefined;
  } catch { return undefined; }
}

/** The row, only when this company's and project's and in the state the caller expects. */
export async function readEvalHealthRow(deps: Pick<EvalHealthRequestDeps, "store" | "companyId">, project: string): Promise<EvalHealthRequestRecord | undefined> {
  try { return parse(deps, project, await deps.store.get(evalHealthRequestKey(deps.companyId, project))); } catch { return undefined; }
}

const iso = (deps: { now?: (() => number) | undefined }): string => new Date((deps.now ?? Date.now)()).toISOString();

/** The broker claims a waiting request for one run: `requested` -> `running`, once (the write names the request and its state), with the claim it will hold the worker to. A repeat or a race changes nothing. */
export async function claimEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId">, project: string, requestId: string, claim: z.input<typeof ClaimSchema>): Promise<boolean> {
  const parsed = ClaimSchema.safeParse(claim);
  if (!parsed.success) return false;
  const row = await readEvalHealthRow(deps, project);
  if (row === undefined || row.requestId !== requestId || row.state !== "requested") return false;
  const result = await deps.store.update({ key: evalHealthRequestKey(deps.companyId, project), ops: [change.set("state", "running"), change.set("claim", JSON.parse(JSON.stringify(parsed.data)) as JsonValue)], condition: when.and(when.eq("requestId", requestId), when.eq("state", "requested")) }).catch(() => undefined);
  return result?.applied === true;
}

/**
 * The runner marks a request finished (once, guarded by its id); a late or repeated mark changes nothing. With a `claimId` it ends that claim's run (state `running`, the claim's own id) and may carry the
 * result a person is shown; without one it is the earlier plain mark of a waiting request.
 */
export async function finishEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId">, project: string, requestId: string, options?: { claimId?: string; result?: EvalHealthResultSummary }): Promise<boolean> {
  const key = evalHealthRequestKey(deps.companyId, project);
  const row = parse(deps, project, await deps.store.get(key));
  const claimId = options?.claimId;
  if (row === undefined || row.requestId !== requestId || row.state !== (claimId !== undefined ? "running" : "requested")) return false;
  if (claimId !== undefined && row.claim?.claimId !== claimId) return false;
  const result = options?.result === undefined ? undefined : ResultSchema.safeParse(options.result);
  if (result !== undefined && !result.success) return false;
  const ops = [change.set("state", "finished"), ...(result === undefined ? [] : [change.set("result", result.data)])];
  const condition = claimId !== undefined ? when.and(when.eq("requestId", requestId), when.eq("state", "running"), when.eq(["claim", "claimId"], claimId)) : when.and(when.eq("requestId", requestId), when.eq("state", "requested"));
  const written = await deps.store.update({ key, ops, condition }).catch(() => undefined);
  return written?.applied === true;
}

/** A request that did not run: `not_run`, with one closed reason. From a waiting request (no claim named) or from a claimed run (its claim named). Once; a repeat or a different claim changes nothing. */
export async function failEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId"> & { now?: (() => number) | undefined }, project: string, requestId: string, reason: EvalHealthNotRunReason, options?: { claimId?: string }): Promise<boolean> {
  const key = evalHealthRequestKey(deps.companyId, project);
  const row = parse(deps, project, await deps.store.get(key));
  const claimId = options?.claimId;
  if (row === undefined || row.requestId !== requestId || row.state !== (claimId !== undefined ? "running" : "requested") || !EvalHealthNotRunReasonSchema.safeParse(reason).success) return false;
  if (claimId !== undefined && row.claim?.claimId !== claimId) return false;
  const condition = claimId !== undefined ? when.and(when.eq("requestId", requestId), when.eq("state", "running"), when.eq(["claim", "claimId"], claimId)) : when.and(when.eq("requestId", requestId), when.eq("state", "requested"));
  const written = await deps.store.update({ key, ops: [change.set("state", "not_run"), change.set("notRun", { reason, at: iso(deps) })], condition }).catch(() => undefined);
  return written?.applied === true;
}

/** What the setup card shows of the check: nothing asked (or a yes gone void), one waiting to run, one running, one finished (with its result) or one that did not run (with its reason). */
export interface EvalHealthView {
  state: "none" | "requested" | "running" | "finished" | "not_run";
  reason?: EvalHealthNotRunReason;
  result?: EvalHealthResultSummary;
}
export async function readEvalHealthView(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros"> & { now?: (() => number) | undefined }, project: string): Promise<EvalHealthView> {
  const row = await readEvalHealthRow(deps, project);
  if (row === undefined) return { state: "none" };
  // The age of a yes and the window of a run are judged only against a clock the caller gives (the host's); without one the row is read as it is.
  const nowMs = deps.now?.();
  if (row.state === "finished") return { state: "finished", ...(row.result === undefined ? {} : { result: row.result }) };
  if (row.state === "not_run") return { state: "not_run", reason: row.notRun?.reason ?? "unavailable" };
  if (row.state === "running") return nowMs !== undefined && evalHealthRunExpired(row, nowMs) ? { state: "not_run", reason: "no_report" } : { state: "running" };
  // A waiting yes: void once its approval is replaced; "not run" once it is a day old.
  if (!await evalHealthApprovalStands(deps, project, row)) return { state: "none" };
  return nowMs !== undefined && evalHealthRequestExpired(row, nowMs) ? { state: "not_run", reason: "expired" } : { state: "requested" };
}

/** The card's one word for it (`readEvalHealthView(...).state`). */
export async function evalHealthState(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros"> & { now?: (() => number) | undefined }, project: string): Promise<EvalHealthView["state"]> {
  return (await readEvalHealthView(deps, project)).state;
}
