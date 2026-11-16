// TE-E0 option A: how long each marked check took on past runs, per company, project and repository, so the wait for it is learned ("usually 40 min"), not a fixed 15 minutes. One small item per
// repository (`<company>#CI_CHECK_TIMES` / `<project>#<repositoryId>`), a bounded list of durations per marked check. Informational: a read that fails is an empty history (the wait is then the cap),
// a write that loses its race is dropped (the next finished run adds its own), and nothing here ever decides a verdict.
import { CI_EVIDENCE_LIMITS, companyScoped, when, type DocumentStore, type MarkedCheck, type OrgId } from "@agentx/contracts";
import { withDuration } from "./marked-checks.js";

export const CHECK_TIMES_ENTITY = "CI_CHECK_TIMES";

const part = (value: string): string => value.replace(/[#\p{Cc}\p{Cf}]/gu, "_").slice(0, 200);

/** The item's key: company-scoped, one per project and repository. */
export const checkTimesKey = (orgId: OrgId, project: string, repositoryId: string): { pk: string; sk: string } =>
  ({ pk: companyScoped(orgId, CHECK_TIMES_ENTITY), sk: `${part(project)}#${part(repositoryId)}` });

/** A marked check's key inside the item. */
const checkKey = (check: Pick<MarkedCheck, "name" | "source">): string => `${check.name}\u0000${check.source ?? ""}`;

export interface CheckTimes {
  version: number;
  durations: Record<string, number[]>;
}

/** The stored history for this company only (another company's item is never read as this one's). Anything that does not parse is an empty history. */
export async function readCheckTimes(store: Pick<DocumentStore, "get">, orgId: OrgId, project: string, repositoryId: string): Promise<CheckTimes> {
  try {
    const item = await store.get(checkTimesKey(orgId, project, repositoryId));
    if (item === undefined || item["orgId"] !== orgId || item["entityType"] !== CHECK_TIMES_ENTITY) return { version: 0, durations: {} };
    const version = typeof item["version"] === "number" && Number.isSafeInteger(item["version"]) && item["version"] >= 0 ? item["version"] : 0;
    const raw = item["durations"];
    const durations: Record<string, number[]> = {};
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, list] of Object.entries(raw as Record<string, unknown>).slice(0, CI_EVIDENCE_LIMITS.markedChecksMax * 2)) {
        if (Array.isArray(list)) durations[key] = withDuration(list.filter((value): value is number => typeof value === "number"), Number.NaN);
      }
    }
    return { version, durations };
  } catch {
    return { version: 0, durations: {} };
  }
}

/** A marked check's past durations. */
export const durationsOf = (times: CheckTimes, check: Pick<MarkedCheck, "name" | "source">): number[] => times.durations[checkKey(check)] ?? [];

/**
 * Adds finished runs' durations and writes the item once, conditional on the version read. Only the marked checks of `keep` are kept (an unmarked check's history is dropped). Best effort: a lost race or a
 * failed write is logged with a fixed event name and dropped.
 */
export async function recordCheckTimes(
  store: Pick<DocumentStore, "put">,
  input: { orgId: OrgId; project: string; repositoryId: string; times: CheckTimes; finished: ReadonlyArray<{ check: Pick<MarkedCheck, "name" | "source">; durationMs: number }>; keep: readonly MarkedCheck[] },
  log?: (event: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  if (input.finished.length === 0) return;
  const durations: Record<string, number[]> = {};
  for (const check of input.keep) {
    const key = checkKey(check);
    let list = input.times.durations[key] ?? [];
    for (const done of input.finished) if (checkKey(done.check) === key) list = withDuration(list, done.durationMs);
    if (list.length > 0) durations[key] = list;
  }
  const next = input.times.version + 1;
  try {
    await store.put({
      item: { ...checkTimesKey(input.orgId, input.project, input.repositoryId), entityType: CHECK_TIMES_ENTITY, orgId: input.orgId, version: next, durations },
      condition: input.times.version === 0 ? when.absent() : when.eq("version", input.times.version),
    });
  } catch {
    log?.("ci_evidence.check_times_not_written", {});
  }
}
