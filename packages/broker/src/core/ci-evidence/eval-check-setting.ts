// L4-EVCI2: where the customer's confirmed eval check is KEPT, and the `ciEvidence` port that gives it back to merge tracking (`CiEvidenceSettings.evalCheck`).
//
// ONE row per company AND project (`ORG#<company>#CIEVAL#<project>` / `CHECK`, companyScoped, built only from a checked company id and project name). The row holds the check's name (and the reporting app) and when it
// changed; no person's id or words (who confirmed it is in the audit record), so the company purge removes it by key and the person erase has no step here. It is durable (no expiry): a setting, not a cache.
//
//   - The row is read only at the caller's own company key, and its body must name that company and project (a copied row reads as nothing). A row that does not read is "nothing named", never a guess; a store that cannot
//     answer THROWS (the port then tells merge tracking "not known", so the pass is tried again and no head is judged without the setting).
//   - Only `evalCheck` comes from here: nothing is marked, the wait cap and report settings are the defaults, so a project with no confirmed check gives `undefined` and every pass is exactly what it was.
//   - "None" is a row too (no `check`): it says the maintainer looked and chose none, and when. It reads exactly like no row.
import { OrgIdSchema, EvalCheckSchema, CI_EVIDENCE_LIMITS, companyScoped, type CiEvidenceSettings, type DocumentKey, type DocumentStore, type EvalCheck, type OrgId } from "@agentx/contracts";

export const EVAL_CHECK_ENTITY = "CI_EVAL_CHECK";
/** The project names the broker keeps (the same pattern the hosted routes check before anything is read). */
export const EVAL_CHECK_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export interface EvalCheckScope { orgId: OrgId; project: string }

export function evalCheckPartition(scope: EvalCheckScope): string {
  const orgId = OrgIdSchema.parse(scope.orgId);
  if (!EVAL_CHECK_PROJECT.test(scope.project)) throw new Error("not a project name");
  return companyScoped(orgId, `CIEVAL#${scope.project}`);
}
export const evalCheckKey = (scope: EvalCheckScope): DocumentKey => ({ pk: evalCheckPartition(scope), sk: "CHECK" });

export interface EvalCheckSetting {
  /** The confirmed check. Absent: a maintainer chose none (or nothing was ever confirmed). */
  check?: EvalCheck | undefined;
  changedAt: string;
  /** The request id of the change (a repeat of the same request with the same choice is one act). */
  requestId?: string | undefined;
}

type Log = ((event: string, fields: Record<string, unknown>) => void) | undefined;
export interface EvalCheckStoreDeps { store: Pick<DocumentStore, "get" | "put">; companyId: OrgId; log?: Log }

/**
 * The project's setting as the store says now: undefined when there is no row, or one that is not exactly this company's and project's. THROWS when the store cannot answer (a read that failed is not "none").
 */
export async function readEvalCheckSetting(deps: Pick<EvalCheckStoreDeps, "store" | "companyId" | "log">, project: string): Promise<EvalCheckSetting | undefined> {
  if (!EVAL_CHECK_PROJECT.test(project)) return undefined;
  const row = await deps.store.get(evalCheckKey({ orgId: deps.companyId, project }));
  if (row === undefined) return undefined;
  const parsed = row["check"] === undefined ? undefined : EvalCheckSchema.safeParse(row["check"]);
  if (row["entityType"] !== EVAL_CHECK_ENTITY || row["orgId"] !== deps.companyId || row["project"] !== project || typeof row["changedAt"] !== "string" || parsed?.success === false) {
    deps.log?.("ci_eval_check.row_invalid", {});
    return undefined;
  }
  const value = parsed?.data;
  return { ...(value === undefined ? {} : { check: value }), changedAt: row["changedAt"], ...(typeof row["requestId"] === "string" ? { requestId: row["requestId"] } : {}) };
}

/** Writes the project's setting (a check, or `undefined` for none). The caller has already checked who may and written the audit record. */
export async function writeEvalCheckSetting(deps: Pick<EvalCheckStoreDeps, "store" | "companyId">, input: { project: string; check: EvalCheck | undefined; requestId: string; now: number }): Promise<EvalCheckSetting> {
  const changedAt = new Date(input.now).toISOString();
  const check = input.check === undefined ? undefined : EvalCheckSchema.parse(input.check);
  await deps.store.put({ item: { ...evalCheckKey({ orgId: deps.companyId, project: input.project }), entityType: EVAL_CHECK_ENTITY, orgId: deps.companyId, project: input.project, ...(check === undefined ? {} : { check: { name: check.name, ...(check.source === undefined ? {} : { source: check.source }) } }), changedAt, requestId: input.requestId } });
  return { ...(check === undefined ? {} : { check }), changedAt };
}

/** The settings the port answers for a confirmed check: nothing marked, the defaults everywhere else. */
export function settingsWithEvalCheck(check: EvalCheck): CiEvidenceSettings {
  return { version: 1, markedChecks: [], waitCapMinutes: CI_EVIDENCE_LIMITS.waitCapMinutesDefault, perTestReports: true, shareLogs: false, evalCheck: check };
}

/**
 * The `ciEvidence` port of merge tracking, for a host that keeps the confirmed check here. Answers `undefined` (nothing named) for another company's task, a task with no project, a project with no confirmed check and
 * a row that does not read; THROWS when the store cannot answer (merge tracking reads that as "not known" and tries the pass again).
 */
export function evalCheckEvidencePort(deps: EvalCheckStoreDeps): (task: { orgId?: unknown; project?: unknown }) => Promise<CiEvidenceSettings | undefined> {
  return async (task) => {
    if (task?.orgId !== deps.companyId || typeof task.project !== "string") return undefined;
    const setting = await readEvalCheckSetting(deps, task.project);
    return setting?.check === undefined ? undefined : settingsWithEvalCheck(setting.check);
  };
}
