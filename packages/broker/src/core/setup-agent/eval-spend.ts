import { randomInt } from "node:crypto";
// Independent setup approval. The setup-command candidate/check/owner gate is never reused for spend.
import {
  EVAL_DEFAULT_CALL_BUDGET, EVAL_DEFAULT_COST_BUDGET_MICROS, EvalSpendApprovalRecordSchema, EvalSpendPlanSchema,
  agentXError, canonicalJson, change, evalSpendDigest, evalSpendInputsDigest, when,
  type DocumentStore, type EvalSpendApprovalRecord, type EvalSpendPlan, type EvalSpendGrant, type EvalSpendApproval, type MonthlyMeter, type EvalReservationAdapter, type OrgId, type Principal, type StoredDocument,
} from "@agentx/contracts";
import { SubjectRefusal, type DecisionSubject } from "../decisions/approval-gate.js";
import { localOwnerMembers, type SessionMembers, type SessionPerson } from "../sessions/access.js";
import { developerIdOf } from "../sessions/create.js";
import { setupPartition } from "./keys.js";

export const EVAL_SPEND_KIND = "setup-eval-spend";
/** Cap and membership come from the trusted host, never the proposal or a stored approver role. */
type Table = { store: DocumentStore; companyId: OrgId; members?: SessionMembers; monthlyCapMicros?: number; log?: (event: "eval_spend_approval_invalid") => void };

async function roleFor(deps: Table, project: string, person: SessionPerson): Promise<"owner" | "admin" | "maintainer" | undefined> {
  try {
    const members = deps.members ?? localOwnerMembers();
    const companyRole = await members.companyRole(person);
    if (companyRole === "owner" || companyRole === "admin") return companyRole;
    if (companyRole !== "member") return undefined;
    return await members.projectGrant(person, project) === "maintainer" ? "maintainer" : undefined;
  } catch { return undefined; }
}
const sessionPerson = (principal: Principal): SessionPerson => ({ companyId: principal.companyId, developerId: developerIdOf(principal), principal });
export const evalSpendKey = (company: string, project: string) => ({ pk: setupPartition(company, project), sk: "EVAL_SPEND" });

function parseRecord(deps: Table, project: string, raw: StoredDocument | undefined): EvalSpendApprovalRecord | undefined {
  if (raw === undefined) return undefined;
  const { pk, sk, ...value } = raw;
  void pk; void sk;
  const parsed = EvalSpendApprovalRecordSchema.safeParse(value);
  if (parsed.success) {
    const row = parsed.data;
    if (row.company === deps.companyId && row.project === project && row.digest === evalSpendDigest(row.company, row.project, row.plan) && row.inputsDigest === evalSpendInputsDigest(row.plan.inputs)) return row;
  }
  (deps.log ?? console.warn)("eval_spend_approval_invalid");
  return undefined;
}
async function readRecord(deps: Table, project: string): Promise<EvalSpendApprovalRecord | undefined> {
  return parseRecord(deps, project, await deps.store.get(evalSpendKey(deps.companyId, project)));
}

const fitsMonthlyCap = (deps: Table, plan: EvalSpendPlan): boolean =>
  Number.isSafeInteger(deps.monthlyCapMicros) && deps.monthlyCapMicros! >= plan.budget.maximum.costMicros;

async function approvedRole(deps: Table, row: EvalSpendApprovalRecord) {
  if (row.approvedBy === undefined) return undefined;
  return roleFor(deps, row.project, { companyId: row.company, developerId: developerIdOf(row.approvedBy) });
}

/** Called only with the trusted discovery/estimate, never request JSON or a model's approval claim.
 * A refresh may reuse approval through the producers; proposing a changed item always asks again. */
export async function proposeEvalSpendApproval(deps: Table, project: string, input: Omit<EvalSpendPlan, "budget"> & { budget?: EvalSpendPlan["budget"] }): Promise<EvalSpendApprovalRecord> {
  const plan = EvalSpendPlanSchema.parse({ ...input, budget: input.budget ?? { usual: input.estimate, maximum: { calls: EVAL_DEFAULT_CALL_BUDGET, costMicros: EVAL_DEFAULT_COST_BUDGET_MICROS } } });
  if (!fitsMonthlyCap(deps, plan)) throw agentXError("CONFIG_INVALID", "The eval budget does not fit the monthly cap.");
  const key = evalSpendKey(deps.companyId, project);
  const raw = await deps.store.get(key);
  const before = parseRecord(deps, project, raw);
  const digest = evalSpendDigest(deps.companyId, project, plan);
  if (before?.digest === digest && (before.state === "waiting" || (before.state === "approved" && await approvedRole(deps, before) !== undefined))) return before;
  // Corrupt records need a new revision even when their previous revision is unreadable,
  // so an old DecisionGate replay cannot masquerade as the new decision.
  const previousRevision = before?.revision ?? (raw === undefined ? 0 : randomInt(1, 2 ** 48));
  const row = EvalSpendApprovalRecordSchema.parse({ entityType: "EVAL_SPEND_APPROVAL", schemaVersion: 1, company: deps.companyId, project, revision: previousRevision + 1, digest, inputsDigest: evalSpendInputsDigest(plan.inputs), plan, state: "waiting" });
  const { approvedBy, ...waiting } = row;
  void approvedBy;
  const result = await deps.store.put({ item: { ...key, ...waiting }, condition: raw === undefined ? when.absent() : when.and(
    ...Object.entries(raw).map(([name, value]) => when.eq([name], value)),
    ...["revision", "digest", "state", "approvedBy"].filter(name => !Object.hasOwn(raw, name)).map(name => when.notExists([name])),
  ) });
  if (!result.applied) throw agentXError("CHANGE_STALE", "The eval approval changed. Read it again.");
  return row;
}

export async function readEvalSpendItem(deps: Table, project: string) {
  try {
    const row = await readRecord(deps, project);
    if (row === undefined) return undefined;
    const money = (n: number): string => `$${(n / 1_000_000).toFixed(2)}`;
    const { estimate, budget } = row.plan;
    const state = row.state === "approved" && await approvedRole(deps, row) === undefined ? "approval needs renewing" as const : row.state;
    return { state, label: `Run the eval health check: about ${estimate.calls} calls, about ${money(estimate.costMicros)}`,
      budget: `Usually about ${budget.usual.calls} calls (about ${money(budget.usual.costMicros)}), at most ${budget.maximum.calls} calls (about ${money(budget.maximum.costMicros)})${fitsMonthlyCap(deps, row.plan) ? ", within the monthly cap" : ""}.`,
      ...(row.state === "waiting" ? { approval: { requestId: `eval-${row.digest.slice(0, 40)}-${row.revision}`, revision: row.revision, artifactDigest: row.digest, kind: EVAL_SPEND_KIND as typeof EVAL_SPEND_KIND, risk: "high" as const } } : {}),
    };
  } catch { return undefined; }
}

export function createEvalSpendSubject(deps: Table): DecisionSubject {
  return {
    kind: EVAL_SPEND_KIND,
    async load(company, project) {
      if (company !== deps.companyId) return undefined;
      const row = await readRecord(deps, project);
      if (row === undefined) return undefined;
      return { key: evalSpendKey(company, project), guard: when.and(when.eq("revision", row.revision), when.eq("digest", row.digest), when.eq("state", "waiting")), waiting: row.state === "waiting",
        request: { kind: EVAL_SPEND_KIND, subject: { type: "eval_spend", id: project }, projectName: project, revision: row.revision, artifactDigest: row.digest, risk: "high" }, state: row };
    },
    async apply(loaded, attempt, approvers, at) {
      const row = EvalSpendApprovalRecordSchema.parse(loaded.state);
      // Company owners/admins are global; a maintainer must hold this project's own grant.
      const roles = await Promise.all(approvers.map(p => roleFor(deps, row.project, sessionPerson(p))));
      if (approvers.length === 0 || approvers.some(p => p.companyId !== row.company) || roles.some(role => role === undefined)) throw new SubjectRefusal("not_the_approver", "Only a company owner, admin or project maintainer approves eval spend.");
      if (attempt.outcome === "reject") return { ops: [change.set("state", "rejected")] };
      if (attempt.outcome !== "approve") throw new SubjectRefusal("invalid_outcome", "Eval spend is approved or rejected.");
      const approvedBy = { personId: approvers[0]!.personId, provider: approvers[0]!.provider, role: roles[0]!, at };
      EvalSpendApprovalRecordSchema.parse({ ...row, state: "approved", approvedBy });
      return { ops: [change.set("state", "approved"), change.set("approvedBy", approvedBy)], result: { project: row.project } };
    },
  };
}

/** No reservation implementation lives here. F1e binds the trusted adapter; absent/unreadable is zero spend. */
export function createEvalSpendCapabilities(options: Table & { project: string; current(): Promise<EvalSpendPlan | undefined>; adapter?: EvalReservationAdapter }): { approval: EvalSpendApproval; meter: MonthlyMeter } {
  const issued = new WeakMap<EvalSpendGrant, EvalSpendApprovalRecord>();
  const resolve = async () => {
    if (options.adapter === undefined) return undefined;
    const row = await readRecord(options, options.project);
    if (row?.state !== "approved" || row.approvedBy === undefined) return undefined;
    const parsed = EvalSpendPlanSchema.safeParse(await options.current());
    if (!parsed.success) return undefined;
    const current = parsed.data;
    if (current.selection !== row.plan.selection || evalSpendInputsDigest(current.inputs) !== row.inputsDigest || canonicalJson(current.budget) !== canonicalJson(row.plan.budget) || current.estimate.calls > row.plan.estimate.calls || current.estimate.costMicros > row.plan.estimate.costMicros) return undefined;
    const authority = await options.adapter.authority({ company: row.company, project: row.project, approver: row.approvedBy });
    if (authority === undefined || authority.company !== row.company || authority.project !== row.project || authority.principal.companyId !== row.company || authority.principal.personId !== row.approvedBy.personId || authority.principal.provider !== row.approvedBy.provider || authority.provider !== "customer" || authority.connected !== true) return undefined;
    const role = await roleFor(options, row.project, sessionPerson(authority.principal));
    if (role === undefined) return undefined;
    return { row, role };
  };
  const approval: EvalSpendApproval = { async read() {
    try {
      const found = await resolve(); if (found === undefined) return undefined;
      const { row, role } = found;
      const grant: EvalSpendGrant = Object.freeze({ company: row.company, project: row.project, selection: row.plan.selection, inputsDigest: row.inputsDigest, role, provider: "customer", connected: true, maxCalls: row.plan.estimate.calls, maxCostMicros: row.plan.estimate.costMicros });
      issued.set(grant, row); return grant;
    } catch { return undefined; }
  } };
  const meter: MonthlyMeter = { async reserve(request) {
    try {
      const row = issued.get(request.approval);
      if (options.adapter === undefined || row === undefined) return undefined;
      if (![request.calls, request.costMicros].every(n => Number.isSafeInteger(n) && n > 0) || request.calls > row.plan.estimate.calls || request.costMicros > row.plan.estimate.costMicros) return undefined;
      const revalidate = async (): Promise<boolean> => {
        try { const found = await resolve(); return found !== undefined && canonicalJson(found.row) === canonicalJson(row); } catch { return false; }
      };
      if (!await revalidate()) return undefined;
      // Whole-estimate atomic hold and dispatch scope belong to the adapter, never to a repository/caller.
      return await options.adapter.reserve({ approval: row, calls: request.calls, costMicros: request.costMicros, revalidate });
    } catch { return undefined; }
  } };
  return { approval, meter };
}
