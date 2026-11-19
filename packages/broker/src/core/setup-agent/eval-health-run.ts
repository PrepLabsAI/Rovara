// L4-EVH (DEC 254zzz20 D5): the broker's side of the opt-in eval HEALTH RUN. A person said yes (`eval-health-request.ts`); this is what happens next, and nothing here happens without that yes:
//
//   start     re-reads the request and everything it rested on, NOW: its age (at most a day), the live role of the person who asked (they may no longer approve eval spend), the approval it was made under (still the
//             approved item, by someone who still may approve it), the project's main heads (read by the broker), and a baseline that is not already saved or being measured. Anything that fails is a closed "Not run:" reason,
//             written to the request, with nothing spent. Otherwise the request is CLAIMED (`requested` -> `running`, once, with the broker's own claim id, the main heads and the cache key parts it will keep the result
//             under) and handed to a worker. The request's own estimate is never the authority to spend: the worker gets the grant of the approved item (`createEvalSpendCapabilities` with that item's digest, through the
//             install's bound reservation adapter) and holds the whole estimate at the gateway and the monthly meter.
//   plan      what the worker asks for with its claim: the same plan and grant a CHECKS run is given, for THIS request's approved item only, while the claim is live and everything above still holds.
//   record    the worker's one result. The broker checks it against ITS OWN plan (the questions, three answers each), keeps it as the project's baseline under the key parts it wrote at the claim (never the worker's), and
//             marks the request finished with pass or fail per case, or `not_run` with a closed reason. A result for another request or claim, a second result, or a late one changes nothing.
//
// Every move that changes the request is audited first (`deps.audit`), and each is one conditional write on the exact prior row, so a repeated call or a race does the work once. Words are fixed; no input, cause or provider
// text is echoed. Nothing in this file calls a model or reaches AWS.
import { randomUUID } from "node:crypto";
import {
  EvalBaseRecordSchema, EvalHealthResultBodySchema, createDocumentBaseScoreCache, evalBaseCacheKey, isStandInSetVersion, standInSettingsFingerprint, change, when,
  type AdapterRegistry, type DocumentStore, type EvalBaseCacheKeyParts, type EvalBaseRecord, type EvalBlockedReach, type EvalHealthNotRunReason, type OrgId, type JsonValue,
} from "@agentx/contracts";
import { baselineParts, type EvalPlanRead } from "../proof/eval-plan-delivery.js";
import type { SessionMembers } from "../sessions/access.js";
import { developerIdOf } from "../sessions/create.js";
import {
  claimEvalHealthRequest, evalHealthRequestKey, evalHealthApprovalStands, evalHealthRequestExpired, evalHealthRunExpired, failEvalHealthRequest, finishEvalHealthRequest, readEvalHealthRow,
  type EvalHealthRequestRecord, type EvalHealthResultSummary,
} from "./eval-health-request.js";
import { baseOf, createEvalPlanSources, type EvalPlanSourceDeps } from "./eval-plan-source.js";
import { readApprovedEvalPlan, roleFor } from "./eval-spend.js";
import { settleEvalWrapperTest } from "./eval-wrapper.js";

export interface EvalHealthRunDeps {
  store: DocumentStore;
  standIns?: EvalPlanSourceDeps["standIns"];
  companyId: OrgId;
  now: () => number;
  members?: SessionMembers | undefined;
  /** The install's bound adapters: the grant a worker holds with comes ONLY from the adapter bound at `eval-reservation` (none: no run spends). */
  registry: Pick<AdapterRegistry, "names" | "get">;
  /** The company's monthly eval cap (the bound adapter's source). */
  monthlyCap?: ((scope: { company: string; project: string }) => Promise<number | undefined>) | undefined;
  /** The head commit of the default branch of each of the project's repositories, read by the broker now. Undefined (or nothing): main cannot be read. */
  mainHeads(project: string): Promise<ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> | undefined>;
  /** Hands the claimed run to a worker (the operation that carries `evalHealth: { requestId, claimId }`). False or a throw: it could not be started, and nothing was spent. */
  launch(job: { project: string; requestId: string; claimId: string; bases: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> }): Promise<boolean>;
  /** The audit record of a move, written BEFORE the move. A throw stops the move. */
  audit(event: { action: "eval.health_claimed" | "eval.health_finished" | "eval.health_not_run" | "eval.health_reused"; project: string; requestId: string; reason?: EvalHealthNotRunReason }): Promise<void>;
}

export type EvalHealthStart =
  | { outcome: "started"; requestId: string; claimId: string }
  | { outcome: "reused"; requestId: string }
  | { outcome: "not_run"; requestId: string; reason: EvalHealthNotRunReason }
  | { outcome: "nothing" };

const noName = (project: string): boolean => typeof project !== "string" || project === "";
const table = (deps: EvalHealthRunDeps, monthlyCapMicros?: number) => ({ store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(monthlyCapMicros === undefined ? {} : { monthlyCapMicros }) });
const cacheOf = (deps: EvalHealthRunDeps) => createDocumentBaseScoreCache(deps.store, { companyId: deps.companyId, now: deps.now });

async function capOf(deps: EvalHealthRunDeps, project: string): Promise<number | undefined> {
  try { const cap = deps.monthlyCap === undefined ? undefined : await deps.monthlyCap({ company: deps.companyId, project }); return typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0 ? cap : undefined; } catch { return undefined; }
}

/** Whether the person who asked may STILL approve eval spend (a company owner or admin, or the project's maintainer), read live. The role the request kept is never used. */
async function requesterMayStill(deps: EvalHealthRunDeps, project: string, row: EvalHealthRequestRecord): Promise<boolean> {
  const principal = { companyId: deps.companyId, personId: row.requestedBy.personId, provider: row.requestedBy.provider, displayName: "", roles: [] };
  return await roleFor({ ...(deps.members === undefined ? {} : { members: deps.members }) }, project, { companyId: deps.companyId, developerId: developerIdOf(principal), principal }) !== undefined;
}

/** Everything a yes rests on, now. The closed reason it fails with, or undefined: it holds. */
async function whyNot(deps: EvalHealthRunDeps, project: string, row: EvalHealthRequestRecord, cap: number | undefined): Promise<EvalHealthNotRunReason | undefined> {
  if (evalHealthRequestExpired(row, deps.now())) return "expired";
  if (!await requesterMayStill(deps, project, row)) return "requester_not_allowed";
  if (!await evalHealthApprovalStands({ ...table(deps, cap) }, project, row)) return "approval_changed";
  return undefined;
}

/** The plan and grant for this request's own approved item and the broker's own main heads; the install's reservation adapter is the only authority behind the grant. */
async function planFor(deps: EvalHealthRunDeps, project: string, row: EvalHealthRequestRecord, bases: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }>, cap: number | undefined): Promise<EvalPlanRead | undefined> {
  const sources = createEvalPlanSources({ ...table(deps, cap), registry: deps.registry, ...(deps.standIns === undefined ? {} : { standIns: deps.standIns }) });
  return await sources.read({ companyId: deps.companyId, project }, { bases, spendDigest: row.spendDigest });
}

/** The reasons that say the run could not READ the eval's results (the wrapper file's whole job). Every other "not run" reason is about the run itself (it never happened, was stopped or ran out), so the file's test stays approved. */
const UNREADABLE_REASONS: ReadonlySet<EvalHealthNotRunReason> = new Set<EvalHealthNotRunReason>(["invalid_results", "incomplete_questions"]);

/**
 * The run's answer for a wrapped eval's file (DEC 254zzz43): `readable` when the results were read in full (a measured result, or a baseline the project already held), `unreadable` when they could not be read.
 * Only for the approved plan THIS request was made under, in this request's own company and project; a replaced approval records nothing. Best effort: it never changes the run's own outcome.
 */
async function settleWrapperTest(deps: EvalHealthRunDeps, project: string, row: Pick<EvalHealthRequestRecord, "spendDigest">, result: "readable" | "unreadable"): Promise<void> {
  try {
    const found = await readApprovedEvalPlan(table(deps), project);
    if (found === undefined || found.spend.digest !== row.spendDigest) return;
    await settleEvalWrapperTest({ store: deps.store, companyId: deps.companyId, now: deps.now }, project, found.plan, result);
  } catch { /* the file keeps its state: the card still reads "test approved" */ }
}

/** Writes one move: its audit record first, then the conditional write. A failed audit stops the move. */
async function settleNotRun(deps: EvalHealthRunDeps, project: string, row: EvalHealthRequestRecord, reason: EvalHealthNotRunReason, claimId?: string, blocked?: EvalBlockedReach): Promise<EvalHealthStart> {
  try { await deps.audit({ action: "eval.health_not_run", project, requestId: row.requestId, reason }); } catch { return { outcome: "nothing" }; }
  const done = await failEvalHealthRequest({ store: deps.store, companyId: deps.companyId, now: deps.now }, project, row.requestId, reason, claimId === undefined && blocked === undefined ? undefined : { ...(claimId === undefined ? {} : { claimId }), ...(blocked === undefined ? {} : { blocked }) });
  return done ? { outcome: "not_run", requestId: row.requestId, reason } : { outcome: "nothing" };
}

/** A case's name as it is kept for the card: one line of printable text (markup and control characters out), at most 160 characters. It is only ever shown as text. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const caseName = (id: string): string => id.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>[\]`@]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160) || "case";

/** What a person is told of a baseline record: how many of the three answers passed for each case, and how many cases gave different answers. Never an answer's text. */
export function evalHealthSummaryOf(record: EvalBaseRecord, flags: { saved: boolean; reused: boolean }, atMs: number): EvalHealthResultSummary | undefined {
  const rows = record.questions;
  if (rows === undefined || rows.length < 1) return undefined;
  const cases = rows.map(row => ({ id: caseName(row.id), passes: row.samples.filter(sample => sample.pass).length }));
  const differing = rows.filter(row => new Set(row.samples.map(sample => JSON.stringify([sample.pass, sample.answer]))).size > 1).length;
  const total = rows.reduce((n, row) => n + row.samples.length, 0);
  return { at: new Date(atMs).toISOString(), questionCount: rows.length, passedAnswers: cases.reduce((n, c) => n + c.passes, 0), totalAnswers: total, differing, cases, saved: flags.saved, reused: flags.reused };
}

/**
 * Starts the run for the project's waiting yes, if there is one and it still holds. Safe to call at any time and any number of times (after the yes, from a timer): it acts once per request.
 */
export async function startEvalHealthRun(deps: EvalHealthRunDeps, project: string): Promise<EvalHealthStart> {
  try {
    if (noName(project)) return { outcome: "nothing" };
    const row = await readEvalHealthRow({ store: deps.store, companyId: deps.companyId }, project);
    if (row === undefined || row.state !== "requested") return { outcome: "nothing" };
    const cap = await capOf(deps, project);
    const reason = await whyNot(deps, project, row, cap);
    if (reason !== undefined) return await settleNotRun(deps, project, row, reason);
    // The broker reads main itself; a worker's word about the base is never used.
    const bases = await deps.mainHeads(project).catch(() => undefined);
    const heads: ReadonlyArray<{ repositoryId: string; baseCommitSha: string }> | undefined = bases !== undefined && bases.length >= 1 && bases.length <= 16
      && bases.every(b => typeof b?.baseCommitSha === "string" && /^[a-f0-9]{40}$/u.test(b.baseCommitSha) && typeof b.repositoryId === "string" && b.repositoryId !== "") ? bases : undefined;
    const found = await readApprovedEvalPlan(table(deps, cap), project);
    if (found === undefined || found.spend.digest !== row.spendDigest) return await settleNotRun(deps, project, row, "approval_changed");
    // The plan names which repository holds the eval; main's head for THAT repository is the base (a head of another repository is not).
    const read = heads === undefined ? undefined : await planFor(deps, project, row, heads, cap).catch(() => undefined);
    const plan = read?.plan as Record<string, unknown> | undefined;
    const parts = plan === undefined ? undefined : baselineParts(plan);
    if (heads === undefined || read === undefined || parts === undefined || baseOf({ bases: heads }, found.plan.repository) !== parts.baseCommit) return await settleNotRun(deps, project, row, "main_unreadable");
    const cache = cacheOf(deps);
    // The project already has this exact baseline (same code, evals, model and judge): nothing to run and nothing to spend. The person is shown it.
    const saved = await cache.read(parts);
    const reusedSummary = saved === undefined ? undefined : evalHealthSummaryOf(saved, { saved: true, reused: true }, deps.now());
    if (reusedSummary !== undefined) {
      try { await deps.audit({ action: "eval.health_reused", project, requestId: row.requestId }); } catch { return { outcome: "nothing" }; }
      // From `requested` straight to finished: the plain mark with the result (no claim, no worker).
      if (!await finishEvalHealthRequest({ store: deps.store, companyId: deps.companyId }, project, row.requestId, { result: reusedSummary })) return { outcome: "nothing" };
      await settleWrapperTest(deps, project, row, "readable");
      return { outcome: "reused", requestId: row.requestId };
    }
    // A baseline that is being measured right now (a task's, or another check) is not measured twice.
    const mark = cache.startMeasurement === undefined ? undefined : await cache.startMeasurement(parts);
    if (mark === undefined || mark.status === "unavailable") return await settleNotRun(deps, project, row, "unavailable");
    if (mark.status !== "started") return await settleNotRun(deps, project, row, "already_measuring");
    const claimId = randomUUID();
    const claim = { claimId, at: new Date(deps.now()).toISOString(), bases: heads.map(b => ({ repositoryId: b.repositoryId, baseCommitSha: b.baseCommitSha })), parts: { ...parts } as EvalBaseCacheKeyParts & { hiddenSetHash: "none"; codeHash: string; judgePin: string }, mark: { claimId: mark.mark.claimId, startedAt: mark.mark.startedAt, expiresAt: mark.mark.expiresAt, state: "measuring" as const } };
    try { await deps.audit({ action: "eval.health_claimed", project, requestId: row.requestId }); } catch { await finish(deps, cache, parts, claim.mark); return { outcome: "nothing" }; }
    if (!await claimEvalHealthRequest({ store: deps.store, companyId: deps.companyId }, project, row.requestId, claim)) { await finish(deps, cache, parts, claim.mark); return { outcome: "nothing" }; }
    let started = false;
    try { started = await deps.launch({ project, requestId: row.requestId, claimId, bases: claim.bases }); } catch { started = false; }
    if (!started) {
      await finish(deps, cache, parts, claim.mark);
      const settled = await settleNotRun(deps, project, row, "could_not_start", claimId);
      return settled.outcome === "not_run" ? settled : { outcome: "nothing" };
    }
    return { outcome: "started", requestId: row.requestId, claimId };
  } catch { return { outcome: "nothing" }; }
}

async function finish(_deps: EvalHealthRunDeps, cache: ReturnType<typeof cacheOf>, parts: EvalBaseCacheKeyParts, mark: Parameters<NonNullable<ReturnType<typeof cacheOf>["finishMeasurement"]>>[1] | undefined): Promise<void> {
  if (mark === undefined || cache.finishMeasurement === undefined) return;
  await cache.finishMeasurement(parts, mark).catch(() => undefined);
}

/** The claim a worker asks under: the request's own id and claim, a live run, and everything the yes rested on still holding. */
async function liveClaim(deps: EvalHealthRunDeps, project: string, lease: { requestId: unknown; claimId: unknown }): Promise<{ row: EvalHealthRequestRecord & { claim: NonNullable<EvalHealthRequestRecord["claim"]> }; cap: number | undefined } | undefined> {
  if (noName(project) || typeof lease.requestId !== "string" || typeof lease.claimId !== "string") return undefined;
  const row = await readEvalHealthRow({ store: deps.store, companyId: deps.companyId }, project);
  if (row === undefined || row.state !== "running" || row.claim === undefined || row.requestId !== lease.requestId || row.claim.claimId !== lease.claimId || evalHealthRunExpired(row, deps.now())) return undefined;
  return { row: row as EvalHealthRequestRecord & { claim: NonNullable<EvalHealthRequestRecord["claim"]> }, cap: await capOf(deps, project) };
}

/**
 * The plan and grant a claimed run reads, or undefined (the worker then reads "not connected" and spends nothing). Re-checks, at the time of the ask, the person's role, the approval and the age; the plan and the
 * grant are those of the request's own approved item (a re-approval in between is no grant), and the main heads are the ones the broker claimed.
 */
export async function deliverEvalHealthPlan(deps: EvalHealthRunDeps, project: string, lease: { requestId: unknown; claimId: unknown }): Promise<EvalPlanRead | undefined> {
  try {
    const live = await liveClaim(deps, project, lease);
    if (live === undefined || await whyNot(deps, project, live.row, live.cap) !== undefined) return undefined;
    return await planFor(deps, project, live.row, live.row.claim.bases, live.cap);
  } catch { return undefined; }
}

export type EvalHealthRecorded = { outcome: "finished" | "not_run" | "duplicate" | "refused" };

/**
 * The worker's one result. Taken once, for the live claim only. A measured result is checked against the broker's own plan before it is kept; anything that does not hold is `not_run` with a closed reason (and no
 * baseline is saved). Only the validated stand-in digest can extend the broker-owned claim identity.
 */
export async function recordEvalHealthResult(deps: EvalHealthRunDeps, project: string, rawBody: unknown): Promise<EvalHealthRecorded> {
  try {
    const parsed = EvalHealthResultBodySchema.safeParse(rawBody);
    if (!parsed.success) return { outcome: "refused" };
    const body = parsed.data;
    const row = await readEvalHealthRow({ store: deps.store, companyId: deps.companyId }, project);
    if (row === undefined || row.requestId !== body.requestId || row.claim?.claimId !== body.claimId) return { outcome: "refused" };
    // The same result again (a retried post) is the same answer; a different one after the first is not taken.
    if (row.state === "finished" || row.state === "not_run") return { outcome: "duplicate" };
    if (row.state !== "running" || evalHealthRunExpired(row, deps.now())) return { outcome: "refused" };
    const claim = row.claim;
    const parts = claim.parts as unknown as EvalBaseCacheKeyParts;
    const cache = cacheOf(deps);
    const end = async (reason: EvalHealthNotRunReason, blocked?: EvalBlockedReach): Promise<EvalHealthRecorded> => {
      const settled = await settleNotRun(deps, project, row, reason, claim.claimId, blocked);
      await finish(deps, cache, parts, claim.mark);
      if (settled.outcome !== "not_run") return { outcome: "refused" };
      if (UNREADABLE_REASONS.has(reason)) await settleWrapperTest(deps, project, row, "unreadable");
      return { outcome: "not_run" };
    };
    if (body.result.status === "not_run") return await end(body.result.reason, body.result.blocked);
    const cap = await capOf(deps, project);
    // The result is for the approved plan the claim was made under; a plan replaced since is not the one this measured.
    const found = await readApprovedEvalPlan(table(deps, cap), project);
    if (found === undefined || found.spend.digest !== row.spendDigest) return await end("approval_changed");
    const record = EvalBaseRecordSchema.safeParse(body.result.record);
    const ids = found.plan.questions.map(q => q.id);
    const rows = record.success ? record.data.questions : undefined;
    if (!record.success || rows === undefined || rows.length !== ids.length || record.data.caseCount !== ids.length || new Set(rows.map(q => q.id)).size !== rows.length || !rows.every(q => ids.includes(q.id) && q.samples.length === 3)) return await end("invalid_results");
    // DEC 254zzz101(4): the worker knows the checkout's stand-in digest, never any other key part.
    const version = body.result.standInSetVersion;
    if (version !== undefined && !isStandInSetVersion(version)) return { outcome: "refused" };
    if ((claim.standInSetVersion !== undefined && claim.standInSetVersion !== version)
      || (record.data.standInSetVersion !== undefined && record.data.standInSetVersion !== version)) return { outcome: "refused" };
    const measuredParts = version === undefined ? parts : { ...parts, standInSetVersion: version, settingsFingerprint: standInSettingsFingerprint(parts.settingsFingerprint, version) };
    const measuredRecord = version === undefined ? record.data : { ...record.data, standInSetVersion: version };
    // The move is audited first; a failed audit keeps nothing (no baseline either) and leaves the run waiting for the result again.
    try { await deps.audit({ action: "eval.health_finished", project, requestId: row.requestId }); } catch { return { outcome: "refused" }; }
    if (version !== undefined) {
      // Bind before writing any baseline. A changed/ended claim or a competing version refuses the result.
      const bound = await deps.store.update({ key: evalHealthRequestKey(deps.companyId, project),
        ops: [change.set(["claim", "standInSetVersion"], version)],
        condition: when.and(when.eq("requestId", body.requestId), when.eq("state", "running"), when.eq("company", deps.companyId), when.eq("project", project), when.eq("claim", JSON.parse(JSON.stringify(claim)) as JsonValue)),
      }).catch(() => undefined);
      if (bound?.applied !== true) return { outcome: "refused" };
    }
    const written = await (async () => { try { return await cache.write(measuredParts, measuredRecord, { writer: "rovara_base_round", baseCommit: parts.baseCommit }); } catch { return "refused" as const; } })();
    const summary = evalHealthSummaryOf(measuredRecord, { saved: written === "stored", reused: false }, deps.now());
    if (summary === undefined) return await end("invalid_results");
    const done = await finishEvalHealthRequest({ store: deps.store, companyId: deps.companyId }, project, row.requestId, { claimId: claim.claimId, result: summary });
    await finish(deps, cache, parts, claim.mark);
    if (!done) return { outcome: "refused" };
    await settleWrapperTest(deps, project, row, "readable");
    return { outcome: "finished" };
  } catch { return { outcome: "refused" }; }
}

/** The cache key this run keeps its result under (for a caller that needs to look): derived from the claim only. */
export const evalHealthKeyOf = (row: EvalHealthRequestRecord): string | undefined => {
  try {
    const claim = row.claim;
    if (claim === undefined) return undefined;
    return evalBaseCacheKey(claim.standInSetVersion === undefined ? claim.parts : {
      ...claim.parts, standInSetVersion: claim.standInSetVersion, settingsFingerprint: standInSettingsFingerprint(claim.parts.settingsFingerprint, claim.standInSetVersion),
    });
  } catch { return undefined; }
};
