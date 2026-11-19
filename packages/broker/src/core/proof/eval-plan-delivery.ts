// EVAL-WIRE-SOURCES (DEC 253c): the `eval-plan` callback. The final-check eval of a CHECKS run needs three things only the broker holds: the project's confirmed eval plan, the persisted spend
// approval (F3e, re-read for current authority) and the company's base-score cache entry for that plan. This handler answers them to that run, once per ask, and to nothing else.
//
// Who may ask (checked by the callback layer before this runs): a signed capability that names THIS action (`eval-plan`), for this workspace, operation and fence, unexpired, on a live operation
// of this install's company. What this handler checks on top: the operation is a task's CHECKS operation whose own stored invocation carries an `evalRequest` (the broker decided the eval, never the
// worker), and its task is found through the workspace's own pointer and belongs to this company. The project is that task's project. Nothing is read from the request.
//
// What it answers: only the sources of (this company, this project). A plan that names another company or project is not sent ("not_available"); a grant that does is sent as null; the cache is
// the company's own (`cache(companyId)`) and read at the plan's own key. Any fault, a missing source, or an answer over `EVAL_PLAN_DELIVERY_MAX_BYTES` is "not_available": the worker then reads
// "not connected" and spends nothing. A refusal is one fixed sentence that names no company, project or source.
import {
  EVAL_PLAN_DELIVERY_MAX_BYTES, EvalEnvironmentSchema, EvalStandInDescriptorSchema, PrepareEvalHealthSchema, EvalPlanDeliveryGrantSchema, EvalPlanDeliverySchema, EvalRequestSchema, WorkflowReviewBaseSchema, agentXError, evalBaseCacheKey, savedEnvRepositoryIsFor, standInSettingsFingerprint,
  type BaseScoreCache, type EvalBaseCacheKeyParts, type EvalPlanDelivery, type EvalSpendApproval,
} from "@agentx/contracts";
import { isLiveOperation } from "../e2e/uploads-chunks.js";

export const EVAL_PLAN_DELIVERY_FORBIDDEN = "the eval plan is delivered only to the active CHECKS operation the broker asked for an eval";
const NOT_AVAILABLE: EvalPlanDelivery = Object.freeze({ status: "not_available" });

/** The project's scope, always the run's own: the company that runs the operation and the project of the operation's own task. */
export interface EvalPlanScope { readonly companyId: string; readonly project: string }

/** The run's own pinned base: each repository's base commit, from the operation's own stored dispatch payload (`workflowBase`, the broker's pin), never the request. Undefined when it has none. */
export interface EvalPlanRun {
  readonly bases: ReadonlyArray<{ readonly repositoryId: string; readonly baseCommitSha: string }> | undefined;
  /** L4-EVH: the digest of the one approved spend item the run was made under (a health run's request). Set: only that item answers, so a re-approval in between gives no plan and no grant. */
  readonly spendDigest?: string | undefined;
}

/** One consistent read of the plan and its approval: both of the SAME approved spend item (EVAL-PLAN-SNAPSHOT). */
export interface EvalPlanRead {
  /** The confirmed final-check plan of this company's project (Rovara's own selection, inventory and pins). */
  readonly plan: unknown;
  /** Broker-only hint from a finished health claim for this exact plan; never supplied by the worker. */
  readonly baselineStandInSetVersion?: string;
  /** The persisted spend approval of the very item `plan` was read with (F3e `createEvalSpendCapabilities(...).approval`, bound to that item's digest), or undefined when it is not wired here. */
  readonly approval: EvalSpendApproval | undefined;
  /**
   * L4-EVS: the environment the sealed eval runs in (the project's saved image with a short-lived pull login, or its approved install steps), or undefined (the bare worker image). Read with the plan so it is
   * the project's own; this handler re-checks the scope (a saved image's repository must be this company's and this project's) and the shape, and drops anything else.
   */
  readonly environment?: unknown;
  /** L4-EINT: what the project's evals reach (checked against the strict descriptor schema here; anything else is dropped). Absent when the operator's switch is off. */
  readonly standIns?: unknown;
}

/** The broker's trusted sources. Each one is asked only for the run's own scope, and each answer is checked against it again here. */
export interface EvalPlanSources {
  /** The plan and its approval in ONE read, or undefined when there is no plan. `run` names the run's pinned base (DEC 253j(1)). */
  read(scope: EvalPlanScope, run: EvalPlanRun): Promise<EvalPlanRead | undefined>;
  /** The company's own base-score cache (`createDocumentBaseScoreCache` for this company), or undefined when it is not wired here. */
  cache(companyId: string): BaseScoreCache | undefined;
}

export interface EvalPlanDeliveryOperation {
  readonly kind?: unknown;
  readonly workflowMode?: unknown;
  readonly status: string;
  readonly companyId?: unknown;
  readonly dispatch?: { readonly payload?: unknown } | undefined;
}

export interface EvalPlanDeliveryDeps {
  readonly sources: EvalPlanSources;
  /** The company the operation runs for (the callback layer's own; never the request's). */
  readonly companyId: string;
  /** The project of the task this operation belongs to, read from the company's own store; undefined when it cannot be read or is another company's. */
  projectOf(operation: EvalPlanDeliveryOperation): Promise<string | undefined>;
  /**
   * L4-EVH: the plan of an opt-in health run's own preparation (a prepare operation whose stored dispatch carries `evalHealth`). Asked with the run's own request and claim (never the request's body); the reader
   * re-checks the claim and everything the yes rested on (deliverEvalHealthPlan). Absent: a health run is not served here.
   */
  readonly health?: { read(lease: { requestId: string; claimId: string }, scope: EvalPlanScope): Promise<EvalPlanRead | undefined> } | undefined;
  /** One fixed event name per fail-closed answer (no value of the request, the plan or the sources). */
  readonly log?: (event: "eval_plan_scope_mismatch" | "eval_plan_unavailable" | "eval_plan_oversize" | "eval_environment_invalid" | "eval_environment_scope_mismatch" | "eval_stand_ins_invalid") => void;
}

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The base-score cache parts the round looks up for a public eval: the plan's key, its base eval set, no hidden set, and its measured settings. Undefined when the plan does not name them. */
export function baselineParts(plan: Record<string, unknown>): EvalBaseCacheKeyParts | undefined {
  const key = record(plan["key"]); const inputs = record(plan["inputs"]);
  const evalSetHash = typeof plan["baseEvalSetHash"] === "string" ? plan["baseEvalSetHash"] : plan["evalSetHash"];
  if (key === undefined || inputs === undefined || typeof evalSetHash !== "string" || typeof inputs["settingsFingerprint"] !== "string") return undefined;
  const parts = { ...key, evalSetHash, hiddenSetHash: "none", settingsFingerprint: inputs["settingsFingerprint"] } as unknown as EvalBaseCacheKeyParts;
  try { evalBaseCacheKey(parts); return parts; } catch { return undefined; }
}

async function baselineOf(cache: BaseScoreCache | undefined, plan: Record<string, unknown>, version?: string): Promise<Extract<EvalPlanDelivery, { status: "ready" }>["baseline"]> {
  const plain = cache === undefined ? undefined : baselineParts(plan);
  const parts = plain === undefined || version === undefined ? plain : { ...plain, standInSetVersion: version, settingsFingerprint: standInSettingsFingerprint(plain.settingsFingerprint, version) };
  if (cache === undefined || parts === undefined || plain === undefined) return null;
  const found = await cache.read(parts).catch(() => undefined);
  const measurement = cache.readMeasurement === undefined ? "unavailable" as const : await cache.readMeasurement(plain).catch(() => "unavailable" as const);
  return { key: evalBaseCacheKey(parts), record: found ?? null, measurement };
}

/** The sources of this run's own company and project, or `not_available`. Throws only the fixed refusal, for a caller that is not this run. */
export async function handleEvalPlanDelivery(deps: EvalPlanDeliveryDeps, operation: EvalPlanDeliveryOperation): Promise<EvalPlanDelivery> {
  const payload = record(operation.dispatch?.payload);
  // L4-EVH: a health run's own preparation (read only, pinned, carrying `evalHealth`) is the other operation that asks; its lease is the stored dispatch's, never the request's.
  const healthLease = operation.kind === "prepare" && deps.health !== undefined && isLiveOperation(operation.status) && operation.companyId === deps.companyId && payload !== undefined ? PrepareEvalHealthSchema.safeParse(payload["evalHealth"]) : undefined;
  const healthJob = healthLease?.success === true ? healthLease.data : undefined;
  if (healthJob === undefined && (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || !isLiveOperation(operation.status) || operation.companyId !== deps.companyId
    || payload === undefined || !EvalRequestSchema.safeParse(payload["evalRequest"]).success)) throw agentXError("CALLBACK_FORBIDDEN", EVAL_PLAN_DELIVERY_FORBIDDEN);
  const project = await deps.projectOf(operation);
  if (typeof project !== "string" || project === "") throw agentXError("CALLBACK_FORBIDDEN", EVAL_PLAN_DELIVERY_FORBIDDEN);
  const scope: EvalPlanScope = Object.freeze({ companyId: deps.companyId, project });
  const log = (event: Parameters<NonNullable<EvalPlanDeliveryDeps["log"]>>[0]): void => { try { deps.log?.(event); } catch { /* logging never changes the answer */ } };
  try {
    const base = WorkflowReviewBaseSchema.safeParse(payload?.["workflowBase"]);
    // One read: the plan and the approval of the same approved item (never two reads a re-approval could fall between).
    const found = healthJob !== undefined ? await deps.health!.read({ requestId: healthJob.requestId, claimId: healthJob.claimId }, scope) : await deps.sources.read(scope, Object.freeze({ bases: base.success ? base.data : undefined }));
    const plan = record(found?.plan);
    if (found === undefined || plan === undefined) { log("eval_plan_unavailable"); return NOT_AVAILABLE; }
    const key = record(plan["key"]);
    // The plan must be this company's and this project's, in its own fields and in its cache key.
    if (plan["company"] !== scope.companyId || plan["project"] !== scope.project || key?.["company"] !== scope.companyId || key["project"] !== scope.project) { log("eval_plan_scope_mismatch"); return NOT_AVAILABLE; }
    let approval: Extract<EvalPlanDelivery, { status: "ready" }>["approval"] = null;
    const reader = found.approval;
    if (reader !== undefined) {
      const grant = EvalPlanDeliveryGrantSchema.safeParse(await reader.read().catch(() => undefined));
      if (grant.success && grant.data.company === scope.companyId && grant.data.project === scope.project) approval = grant.data;
      else if (grant.success) log("eval_plan_scope_mismatch");
    }
    // L4-EVS: the environment is delivered only when it is whole and its saved image is this project's own; otherwise the eval runs on the bare image, as before (it is never a reason to withhold the plan).
    let environment: Extract<EvalPlanDelivery, { status: "ready" }>["environment"];
    if (found.environment !== undefined) {
      const parsed = EvalEnvironmentSchema.safeParse(found.environment);
      if (!parsed.success) log("eval_environment_invalid");
      else if (parsed.data.kind === "saved" && !savedEnvRepositoryIsFor(parsed.data.repository, { orgId: scope.companyId, projectId: scope.project })) log("eval_environment_scope_mismatch");
      else environment = parsed.data;
    }
    // L4-EINT: the stand-in descriptor (only when the source gave one: the operator's switch). A malformed one is dropped, never a reason to withhold the plan.
    let standIns: Extract<EvalPlanDelivery, { status: "ready" }>["standIns"];
    if (found.standIns !== undefined) {
      const parsed = EvalStandInDescriptorSchema.safeParse(found.standIns);
      if (parsed.success) standIns = parsed.data; else log("eval_stand_ins_invalid");
    }
    const baseline = await baselineOf(deps.sources.cache(scope.companyId), plan, found.baselineStandInSetVersion);
    const answerWith = (env: typeof environment, stand: typeof standIns = standIns) => EvalPlanDeliverySchema.safeParse({ status: "ready", plan, approval, baseline, ...(env === undefined ? {} : { environment: env }), ...(stand === undefined ? {} : { standIns: stand }) });
    let answer = answerWith(environment);
    if (!answer.success) { log("eval_plan_unavailable"); return NOT_AVAILABLE; }
    // L4-EINT: a stand-in descriptor that makes the answer too big is dropped too (the eval runs without stand-ins), never a reason to withhold the plan.
    if (standIns !== undefined && Buffer.byteLength(JSON.stringify(answer.data), "utf8") > EVAL_PLAN_DELIVERY_MAX_BYTES) { log("eval_stand_ins_invalid"); answer = answerWith(environment, undefined); if (!answer.success) { log("eval_plan_unavailable"); return NOT_AVAILABLE; } }
    // An environment that makes the answer too big is dropped (the eval runs on the bare image), never a reason to withhold the plan.
    if (environment !== undefined && Buffer.byteLength(JSON.stringify(answer.data), "utf8") > EVAL_PLAN_DELIVERY_MAX_BYTES) { log("eval_environment_invalid"); answer = answerWith(undefined); if (!answer.success) { log("eval_plan_unavailable"); return NOT_AVAILABLE; } }
    if (Buffer.byteLength(JSON.stringify(answer.data), "utf8") > EVAL_PLAN_DELIVERY_MAX_BYTES) { log("eval_plan_oversize"); return NOT_AVAILABLE; }
    return answer.data;
  } catch {
    log("eval_plan_unavailable");
    return NOT_AVAILABLE;
  }
}
