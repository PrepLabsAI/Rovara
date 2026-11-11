// What a project's page says about its automatic runs: the runs Rovara started by itself ("Started by Rovara (nightly)") and its own "Automatic runs" line (this month's runs against the cap, and that the cap
// has paused them). Fixed words, counts and days: nothing from a repository, and no task id (a person cannot open a task they do not own).
import { AutomaticJobSchema, queryAll, projectPk, startedByAutomaticWords, type AutomaticJob, type OrgId } from "@agentx/contracts";
import type { Table } from "../automation/kit.js";
import { AUTOMATIC_RUNS_STARTED_PREFIX, readAutomaticRunsUse, type AutomaticRunsUse } from "./cap.js";

export const RECENT_AUTOMATIC_RUNS_SHOWN = 10;

export type AutomaticRunState = "running" | "complete" | "failed" | "cancelled";
export interface AutomaticRunView { job: AutomaticJob; words: string; startedAt: string; state: AutomaticRunState }
export interface AutomaticRunsView {
  /** The project's own "Automatic runs" line: this month's runs against its cap. */
  line: AutomaticRunsUse & { label: "Automatic runs"; words: string };
  /** Why automatic runs are paused, when the cap has paused them. */
  pausedWords?: string;
  recent: AutomaticRunView[];
}

export const AUTOMATIC_RUNS_PAUSED_WORDS = (cap: number): string => `Automatic runs are paused for this month: this project reached its cap of ${String(cap)}. The owner can raise the cap.`;

/** How a run stands now, from the host's own task (`undefined`: the task cannot be read, so the run is left out rather than shown as something it is not). */
export type AutomaticRunStateReader = (taskId: string) => Promise<AutomaticRunState | undefined>;

/** The runs the project's system owner started lately, newest first, with where each one stands now. */
export async function recentAutomaticRuns(deps: Table, orgId: OrgId, project: string, stateOf: AutomaticRunStateReader): Promise<AutomaticRunView[]> {
  const found: Array<{ job: AutomaticJob; at: string; taskId: string | undefined }> = [];
  for (const item of await queryAll(deps.store, { pk: projectPk(orgId, project), sk: { op: "beginsWith", prefix: AUTOMATIC_RUNS_STARTED_PREFIX } })) {
    const job = AutomaticJobSchema.safeParse(item["job"]);
    const at = item["at"];
    if (job.success && typeof at === "string" && Number.isFinite(Date.parse(at))) found.push({ job: job.data, at, taskId: typeof item["taskId"] === "string" ? item["taskId"] : undefined });
  }
  found.sort((a, b) => b.at.localeCompare(a.at));
  const runs: AutomaticRunView[] = [];
  for (const entry of found.slice(0, RECENT_AUTOMATIC_RUNS_SHOWN)) {
    const state = entry.taskId === undefined ? "running" : await stateOf(entry.taskId).catch(() => undefined);
    if (state === undefined) continue;
    runs.push({ job: entry.job, words: startedByAutomaticWords(entry.job), startedAt: entry.at, state });
  }
  return runs;
}

export async function automaticRunsView(deps: Table, orgId: OrgId, project: string, stateOf: AutomaticRunStateReader): Promise<AutomaticRunsView> {
  const [use, recent] = await Promise.all([readAutomaticRunsUse(deps, orgId, project), recentAutomaticRuns(deps, orgId, project, stateOf).catch(() => [])]);
  return {
    line: { ...use, label: "Automatic runs", words: `Automatic runs: ${String(use.used)} of ${String(use.cap)} this month` },
    ...(use.paused ? { pausedWords: AUTOMATIC_RUNS_PAUSED_WORDS(use.cap) } : {}),
    recent,
  };
}
