// L4-EVC (DEC 254zzz20 D5): the OPT-IN eval health run. After the spend approval the setup card offers "Check my evals now (about $Y)". Nothing here runs a model: a person says yes, and the broker keeps
// ONE request row (`EVAL_HEALTH_REQUEST` in the project's company-scoped setup partition) that the host's health runner reads. No yes, no row, no run: the setup never starts a health run by itself, and a
// request is void as soon as the approval it was made under is replaced (an eval set that needed a new approval asks again).
//
// Who may say yes: the same people who may approve the eval's spend (a company owner or admin, or the project's maintainer, read LIVE from the members seam in their own company), and only while the
// spend item is approved by someone who still holds that right. The cost the person was shown (`seenCostMicros`) must be the broker's own figure for the item; any difference is refused and nothing is
// kept. A repeat of the same yes (the same request id) is the same answer. Fixed words only; no input is echoed.
import { z } from "zod";
import { agentXError, change, when, type DocumentStore, type OrgId, type Principal, type StoredDocument } from "@agentx/contracts";
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

const RecordSchema = z.object({
  entityType: z.literal(EVAL_HEALTH_REQUEST_ENTITY), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  requestId: z.string().uuid(),
  /** The approved spend item the request was made under (its digest); a request under another item is void. */
  spendDigest: hash,
  estimateMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestedBy: z.object({ personId: z.string().min(1).max(256), provider: z.string().min(1).max(200), role: z.enum(["owner", "admin", "maintainer"]), at: z.iso.datetime() }).strict(),
  state: z.enum(["requested", "finished"]),
}).strict();
export type EvalHealthRequestRecord = z.infer<typeof RecordSchema>;

export interface EvalHealthRequestDeps { store: DocumentStore; companyId: OrgId; now: () => number; members?: SessionMembers | undefined; monthlyCapMicros?: number | undefined }

function parse(deps: Pick<EvalHealthRequestDeps, "companyId">, project: string, raw: StoredDocument | undefined): EvalHealthRequestRecord | undefined {
  if (raw === undefined) return undefined;
  const { pk, sk, ...value } = raw;
  void pk; void sk;
  const parsed = RecordSchema.safeParse(value);
  return parsed.success && parsed.data.company === deps.companyId && parsed.data.project === project ? parsed.data : undefined;
}

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
  if (before !== undefined && before.spendDigest === found.spend.digest && before.state === "requested") {
    return before.requestId === body.requestId ? { requested: true, duplicate: true, cost: dollarsOf(estimate) } : refuse("CHANGE_STALE", "An eval check is already waiting to run.");
  }
  const row: EvalHealthRequestRecord = RecordSchema.parse({ entityType: EVAL_HEALTH_REQUEST_ENTITY, schemaVersion: 1, company: deps.companyId, project, requestId: body.requestId, spendDigest: found.spend.digest, estimateMicros: estimate,
    requestedBy: { personId: principal.personId, provider: principal.provider, role, at: new Date(deps.now()).toISOString() }, state: "requested" });
  const condition = raw === undefined ? when.absent() : when.and(...Object.entries(raw).map(([name, value]) => when.eq([name], value)));
  const written = await deps.store.put({ item: { ...key, ...row } as unknown as StoredDocument, condition });
  if (!written.applied) return refuse("CHANGE_STALE", "The eval check changed. Read it again.");
  return { requested: true, duplicate: false, cost: dollarsOf(estimate) };
}

/**
 * What the health runner reads: the person's request, only while it is this company's, unedited in shape, still waiting AND made under the spend item that is approved now. Anything else is no request,
 * so a run never starts without a current yes. (The runner still goes through the approval and the monthly meter; this is not authority to spend.)
 */
export async function readEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros">, project: string): Promise<EvalHealthRequestRecord | undefined> {
  try {
    const row = parse(deps, project, await deps.store.get(evalHealthRequestKey(deps.companyId, project)));
    if (row === undefined || row.state !== "requested") return undefined;
    const table = { store: deps.store, companyId: deps.companyId, ...(deps.members === undefined ? {} : { members: deps.members }), ...(deps.monthlyCapMicros === undefined ? {} : { monthlyCapMicros: deps.monthlyCapMicros }) };
    const [found, item] = await Promise.all([readApprovedEvalPlan(table, project), readEvalSpendItem(table, project)]);
    // The approval must still stand: its approver still holds the right to approve (the item's own live reading).
    return found !== undefined && item?.state === "approved" && found.spend.digest === row.spendDigest && found.spend.plan.estimate.costMicros === row.estimateMicros ? row : undefined;
  } catch { return undefined; }
}

/** The runner marks a request finished (once, guarded by its id); a late or repeated mark changes nothing. */
export async function finishEvalHealthRequest(deps: Pick<EvalHealthRequestDeps, "store" | "companyId">, project: string, requestId: string): Promise<boolean> {
  const key = evalHealthRequestKey(deps.companyId, project);
  const row = parse(deps, project, await deps.store.get(key));
  if (row === undefined || row.requestId !== requestId || row.state !== "requested") return false;
  const result = await deps.store.update({ key, ops: [change.set("state", "finished")], condition: when.and(when.eq("requestId", requestId), when.eq("state", "requested")) }).catch(() => undefined);
  return result?.applied === true;
}

/** What the setup card shows: no request (or one that went void), one waiting to run, or one that has run. */
export async function evalHealthState(deps: Pick<EvalHealthRequestDeps, "store" | "companyId" | "members" | "monthlyCapMicros">, project: string): Promise<"none" | "requested" | "finished"> {
  if (await readEvalHealthRequest(deps, project) !== undefined) return "requested";
  const row = parse(deps, project, await deps.store.get(evalHealthRequestKey(deps.companyId, project)).catch(() => undefined));
  return row?.state === "finished" ? "finished" : "none";
}
