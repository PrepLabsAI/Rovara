// L4-E12 (E2, DEC 254zzz55 N6): the FREE dry run's dependency list, kept per company and project and shown through the TH1 words.
//
// REPORT (the worker's word, through the setup run's EXISTING callback, body kind `eval_dry_run`; `callback.ts`). The callback already names the run: a running setup run of THIS company, its project and task from the authenticated
// operation, never from the body. The list is schema-checked (`EvalDependencyListSchema`: bounded, strict, fixed shapes; `modelCalls` must be exactly 0). It is kept as ONE row per project (`EVAL_DEPENDENCY_LIST` in the project's
// company-scoped setup partition): the newest setup run's list replaces the older one (a re-run of setup re-measures), and the row names the run that made it. Nothing in it is a log line, a value or a path.
//
// READ (`readEvalDependencyList`): only at the caller's own company's key; a row whose company, project or shape differs reads as absent (a copied row never shows), and an unreadable row reads as absent.
//
// SHOWN (`evalReachesView`): the fixed sentence of `evalDependencyListWords` (the same clause TH1 says for a failed eval, so a person reads one wording), the TH1 items (`evalDependencyListToBlockedReach`) and, whenever this install's test
// services are off, the fixed "Test services are off on this install" reason: read from the install NOW (not from the run), so turning them on changes the page without another run.
import { z } from "zod";
import {
  EvalDependencyListSchema, agentXError, evalDependencyListToBlockedReach, evalDependencyListWords,
  type DocumentStore, type EvalBlockedReach, type EvalDependencyList, type OrgId, type StoredDocument,
} from "@agentx/contracts";
import { setupPartition, type RunScope } from "./keys.js";

export const EVAL_DEPENDENCY_LIST_ENTITY = "EVAL_DEPENDENCY_LIST";
/** The project's one list row, in the company-scoped setup partition. */
export const evalDependencyListKey = (company: string, project: string) => ({ pk: setupPartition(company, project), sk: EVAL_DEPENDENCY_LIST_ENTITY });

const RecordSchema = z.object({
  entityType: z.literal(EVAL_DEPENDENCY_LIST_ENTITY), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), taskId: z.string().min(1).max(160),
  list: z.unknown(),
  recordedAt: z.iso.datetime(),
}).strict();

export type EvalDependencyListLogEvent = "eval_dry_run_recorded" | "eval_dry_run_refused";
type Log = ((entry: { event: EvalDependencyListLogEvent; reason?: string }) => void) | undefined;

export interface EvalDependencyListDeps { store: DocumentStore; now: () => number; log?: Log }

/**
 * The callback's `eval_dry_run`: keeps the run's list, replacing the project's earlier one. Refused (fixed words, nothing written) for a list that is not the contract's shape, including any claim of a model call. `run` is the
 * callback's own (`setupRunOfOperation`: a running setup run of this company).
 */
export async function recordEvalDependencyList(deps: EvalDependencyListDeps, run: RunScope, rawList: unknown): Promise<{ recorded: true }> {
  const parsed = EvalDependencyListSchema.safeParse(rawList);
  if (!parsed.success) {
    deps.log?.({ event: "eval_dry_run_refused", reason: "unreadable" });
    throw agentXError("CONFIG_INVALID", "the eval dry run's list is not readable");
  }
  const row = { entityType: EVAL_DEPENDENCY_LIST_ENTITY, schemaVersion: 1 as const, company: run.orgId, project: run.project, taskId: run.taskId, list: parsed.data, recordedAt: new Date(deps.now()).toISOString() };
  await deps.store.put({ item: { ...evalDependencyListKey(run.orgId, run.project), ...row } as unknown as StoredDocument });
  deps.log?.({ event: "eval_dry_run_recorded" });
  return { recorded: true };
}

/** The project's list, only when the row is this company's and project's and its list is still the contract's shape. */
export async function readEvalDependencyList(deps: { store: DocumentStore; companyId: OrgId }, project: string): Promise<{ taskId: string; list: EvalDependencyList } | undefined> {
  try {
    const raw = await deps.store.get(evalDependencyListKey(deps.companyId, project));
    if (raw === undefined) return undefined;
    const { pk, sk, ...value } = raw;
    void pk; void sk;
    const row = RecordSchema.safeParse(value);
    const list = row.success ? EvalDependencyListSchema.safeParse(row.data.list) : undefined;
    if (!row.success || list?.success !== true || row.data.company !== deps.companyId || row.data.project !== project) return undefined;
    return { taskId: row.data.taskId, list: list.data };
  } catch { return undefined; }
}

/** What a page shows of the dry run: the fixed sentence and its TH1 items. */
export interface EvalReachesView {
  /** "A free dry run of your eval on main found it reaches a database (port 5432) and an outside service (api.example.com) ... Test services are off on this install, ...". */
  words: string;
  /** The TH1 items (databases by port, outside hosts by name; at most 3), when the list names any. */
  blocked?: EvalBlockedReach;
  /** True when this install's test services are off right now. */
  servicesOff?: true;
}

/**
 * The view of the project's list, or undefined when there is none or it found nothing worth saying. `servicesOff` is read from the install now: the sentence then carries the fixed "Test services are off on this install" reason,
 * whatever the worker saw when it ran. A list that found nothing says nothing (no "found nothing": a dry run that could not stand in for the real world proves nothing), except that a run that stopped early says so.
 */
export async function evalReachesView(deps: { store: DocumentStore; companyId: OrgId }, project: string, options: { servicesOff: boolean }): Promise<EvalReachesView | undefined> {
  const found = await readEvalDependencyList(deps, project);
  if (found === undefined) return undefined;
  // Judged on the install as it is now, not on the run's own flag.
  const { servicesOff: _ranWithout, ...rest } = found.list;
  void _ranWithout;
  const cleaned: EvalDependencyList = options.servicesOff ? { ...rest, servicesOff: true } : rest;
  const words = evalDependencyListWords(cleaned);
  if (words === undefined) return undefined;
  const blocked = evalDependencyListToBlockedReach(cleaned);
  return { words, ...(blocked === undefined ? {} : { blocked }), ...(options.servicesOff ? { servicesOff: true as const } : {}) };
}

