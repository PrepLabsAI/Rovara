// TE-C1 (DECISIONS 160(6): the baseline cache is the ENGINE's record): the baseline per base commit. "Before" is known per test, per commit, from a run Rovara trusts.
//
// One row per trusted run at a commit, on the project's partition: `TESTENV#BASELINE#SHA#<envRevision, 8 digits>#<headSha>` (90 days, like the nightly's history). The environment revision is in the key because an approved
// revision is immutable and pins the check set, so a row of another revision never answers for this one; the partition is the company's and the project's, so a company never reads another's.
//
// TRUSTED WRITERS ONLY: `recordBaselineRow` takes a `TrustedBaselineRun`, which only `mintTrustedBaselineRun` makes, and only `recordNightlyResult` (after its slot lock and environment checks) calls that. A task, a CHECKS
// callback, the evidence keeper and the worker's files have no way to make one (a source test names the one production caller), and the runtime check refuses a look-alike object. `writer` names who: only `nightly` today.
//
// LOOKUP (`baselineFor`): the exact (revision, branch, commit) row first; else the nearest row among the ancestors the WORKER verified (a list of `{ sha, commitsBack }`, at most 50 commits back), labelled partial. Else
// nothing: today's behaviour (the nightly baseline). Never "the latest row". A row is used only when it parses, says the same revision, branch and commit as its key, has a whole failing set, is not from the future and
// has not expired; a store that cannot be read is a miss, never "no failures". Age is reported, not limited: a row of last month is still the run at that commit, and the line says how old it is.
import { BASELINE_ANCESTOR_MAX, BASELINE_CANDIDATES_MAX, BaselineRowSchema, baselineSetIsWhole, projectPk, queryAll, type BaselineRow, type OrgId } from "@agentx/contracts";
import { documentOf, expired, expiryOf, type TestEnvDeps } from "./deps.js";

/** How long a row is kept: the nightly's own history rows keep 90 days. */
export const BASELINE_RETENTION_MS = 90 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** A run that claims to have finished later than this ahead of now is not believed (the nightly's own allowance). */
const FUTURE_SKEW_MS = HOUR_MS;
const HEX40 = /^[a-f0-9]{40}$/u;
const KEY_PREFIX = "TESTENV#BASELINE#SHA#";

const revisionPart = (envRevision: number): string => String(envRevision).padStart(8, "0");
const prefixOf = (envRevision: number): string => `${KEY_PREFIX}${revisionPart(envRevision)}#`;

/** The row's key. */
export const baselineRowKey = (orgId: OrgId, project: string, envRevision: number, headSha: string): { pk: string; sk: string } => ({ pk: projectPk(orgId, project), sk: `${prefixOf(envRevision)}${headSha}` });

declare const trustedBrand: unique symbol;
/** A run the engine trusts: made by `mintTrustedBaselineRun` and nothing else. */
export interface TrustedBaselineRun {
  readonly [trustedBrand]: true;
  readonly orgId: OrgId;
  readonly project: string;
  readonly row: BaselineRow;
}
const minted = new WeakSet<object>();

/**
 * Makes the one thing `recordBaselineRow` accepts. ONLY `recordNightlyResult` calls this, after it has checked the slot lock, the environment's revision and branch and the result's own arithmetic. The row is parsed here, so a
 * run whose summary does not fit the row's rules (a bad sha, a list over its cap) is refused before anything is written.
 */
export function mintTrustedBaselineRun(input: { orgId: OrgId; project: string; row: unknown }): TrustedBaselineRun {
  const run = Object.freeze({ orgId: input.orgId, project: input.project, row: BaselineRowSchema.parse(input.row) }) as unknown as TrustedBaselineRun;
  minted.add(run);
  return run;
}

/** Writes the row for a trusted run (put: the same run recorded again writes the same row). Refuses anything `mintTrustedBaselineRun` did not make. */
export async function recordBaselineRow(deps: Pick<TestEnvDeps, "store" | "now">, run: TrustedBaselineRun): Promise<void> {
  if (typeof run !== "object" || run === null || !minted.has(run)) throw new Error("a baseline row is written only for a trusted run");
  const { orgId, project, row } = run;
  await deps.store.put({ item: documentOf({ ...baselineRowKey(orgId, project, row.envRevision, row.headSha), entityType: "TEST_ENV_BASELINE_SHA", orgId, project, baseline: row, ...expiryOf(deps.now() + BASELINE_RETENTION_MS) }) });
}

/** The failing tests this row excuses: its list when the failing set is whole (the row is only ever found when it is), else none. */
export const knownFailingOf = (row: BaselineRow): string[] => (baselineSetIsWhole(row) ? [...row.failed] : []);

export interface BaselineQuery {
  orgId: OrgId;
  project: string;
  envRevision: number;
  /** The branch the task is based on: a row of another branch is never used. */
  branch: string;
  /** The task's base commit, when known: an exact row is looked for first. */
  baseCommit?: string | undefined;
  /** Ancestors of the base commit that the WORKER verified at the start of its round (nearest first is the usual order; the nearest is picked either way). Empty: no ancestor is looked for. */
  ancestry: ReadonlyArray<{ sha: string; commitsBack: number }>;
}
export interface FoundBaseline {
  row: BaselineRow;
  /** 0 for the base commit itself. */
  commitsBack: number;
  /** True when the row is of an ancestor, not of the base commit itself. */
  partial: boolean;
  /** Whole hours between the run's end and now. */
  ageHours: number;
}

/** The row at `headSha` when it is usable for this company, project, revision and branch; undefined otherwise (including when the store cannot be read). */
async function usableRow(deps: Pick<TestEnvDeps, "store" | "now">, query: Pick<BaselineQuery, "orgId" | "project" | "envRevision" | "branch">, headSha: string, item?: Record<string, unknown>): Promise<BaselineRow | undefined> {
  try {
    const found = item ?? await deps.store.get(baselineRowKey(query.orgId, query.project, query.envRevision, headSha));
    if (found === undefined || found["orgId"] !== query.orgId || found["project"] !== query.project || expired(found, deps.now())) return undefined;
    const parsed = BaselineRowSchema.safeParse(found["baseline"]);
    if (!parsed.success) return undefined;
    const row = parsed.data;
    if (row.envRevision !== query.envRevision || row.branch !== query.branch || row.headSha !== headSha || !baselineSetIsWhole(row)) return undefined;
    const finished = Date.parse(row.finishedAt);
    return Number.isFinite(finished) && finished <= deps.now() + FUTURE_SKEW_MS ? row : undefined;
  } catch {
    return undefined;
  }
}

const found = (deps: Pick<TestEnvDeps, "now">, row: BaselineRow, commitsBack: number): FoundBaseline => ({ row, commitsBack, partial: commitsBack > 0, ageHours: Math.max(0, Math.floor((deps.now() - Date.parse(row.finishedAt)) / HOUR_MS)) });

/** The baseline for a task: the exact commit's row, else the nearest verified ancestor's (at most 50 commits back), else undefined. */
export async function baselineFor(deps: Pick<TestEnvDeps, "store" | "now">, query: BaselineQuery): Promise<FoundBaseline | undefined> {
  if (query.baseCommit !== undefined && HEX40.test(query.baseCommit)) {
    const exact = await usableRow(deps, query, query.baseCommit);
    if (exact !== undefined) return found(deps, exact, 0);
  }
  const ancestors = query.ancestry
    .filter((entry) => HEX40.test(entry.sha) && Number.isInteger(entry.commitsBack) && entry.commitsBack >= 0 && entry.commitsBack <= BASELINE_ANCESTOR_MAX)
    .sort((left, right) => left.commitsBack - right.commitsBack);
  for (const entry of ancestors) {
    const row = await usableRow(deps, query, entry.sha);
    if (row !== undefined) return found(deps, row, entry.commitsBack);
  }
  return undefined;
}

/** The commits a task plan offers the worker: the newest usable rows of this revision and branch (at most five), newest first. An unreadable store offers none. */
export async function baselineCandidatesOf(deps: Pick<TestEnvDeps, "store" | "now">, query: Pick<BaselineQuery, "orgId" | "project" | "envRevision" | "branch">): Promise<string[]> {
  try {
    // Every row of the revision (a night a day for 90 days is a few hundred small rows, and the keys sort by commit, not by time, so the newest cannot be picked from a page).
    const items = await queryAll(deps.store, { pk: projectPk(query.orgId, query.project), sk: { op: "beginsWith", prefix: prefixOf(query.envRevision) } });
    const rows: BaselineRow[] = [];
    for (const item of items) {
      const headSha = item.sk.slice(prefixOf(query.envRevision).length);
      const row = HEX40.test(headSha) ? await usableRow(deps, query, headSha, item) : undefined;
      if (row !== undefined) rows.push(row);
    }
    return rows.sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt)).slice(0, BASELINE_CANDIDATES_MAX).map((row) => row.headSha);
  } catch {
    return [];
  }
}
