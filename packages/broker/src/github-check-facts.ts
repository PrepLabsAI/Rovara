// TE-E0 option A: the GitHub answers the customer's pipeline evidence reads, parsed field by field (pure, like github-pull-status.ts). Three reads, all with permissions the App already asks
// (`checks`, `statuses`, `actions` at read), none new:
//  - one check run's times and, for a GitHub Actions job, its run attempt ("passed on run 2" is never guessed: no attempt read, no number said);
//  - the latest run of a named check on a commit or branch (the base commit's run for the change proof, the main branch's run for "your environment"), from check runs, then commit statuses;
//  - the check names seen on recent pull requests, for the setup screen.
// An answer that does not fit is refused (undefined, or a throw the caller treats as "not known"), never read as fine.
import { GITHUB_ACTIONS_APP_ID } from "@agentx/contracts";
import { cleanName, type PullRequestCheck, type PullRequestCheckConclusion } from "./github-pull-status.js";

const SHA = /^[a-f0-9]{40}$/u;
/** ISO times as GitHub writes them; anything else is not a time. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
/** The most run attempts a GitHub Actions run can have is far below this; a larger number is a bad read. */
export const RUN_ATTEMPT_MAX = 1_000;
/** The most check names a setup listing returns. */
export const SEEN_CHECKS_MAX = 100;

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const time = (value: unknown): string | undefined => (typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined);
const positiveId = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** One check run's facts: its times, and for an Actions job its run attempt and workflow run. Each field is present only when GitHub gave it in a form that can be believed. */
export interface CheckRunFacts {
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  workflowRunId?: string;
}

/** `GET check-runs/{id}` (times) and, for an Actions job, `GET actions/jobs/{id}` (attempt, run). A job answer for another run id than the one asked is ignored whole. */
export function parseCheckRunFacts(checkRun: unknown, job: unknown, checkRunId: string): CheckRunFacts | undefined {
  const run = record(checkRun);
  if (run === undefined || String(run["id"]) !== checkRunId) return undefined;
  const facts: CheckRunFacts = {};
  const started = time(run["started_at"]);
  const completed = time(run["completed_at"]);
  if (started !== undefined) facts.startedAt = started;
  if (completed !== undefined && (started === undefined || Date.parse(completed) >= Date.parse(started))) facts.completedAt = completed;
  const actions = record(job);
  if (actions !== undefined && String(actions["id"]) === checkRunId) {
    const attempt = actions["run_attempt"];
    if (typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= RUN_ATTEMPT_MAX) facts.attempt = attempt;
    const runId = positiveId(actions["run_id"]);
    if (runId !== undefined) facts.workflowRunId = String(runId);
  }
  return facts;
}

const REST_CONCLUSIONS: Readonly<Record<string, PullRequestCheckConclusion>> = {
  success: "success", failure: "failure", neutral: "neutral", cancelled: "cancelled", skipped: "skipped", timed_out: "timed_out", action_required: "action_required", stale: "stale", startup_failure: "startup_failure",
};

/** A link GitHub gave: https only, no credentials, at most 2,048 characters; else empty. */
function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** The latest run of a named check on one commit, with the commit GitHub says it ran on. */
export interface LatestCheckRun {
  headSha: string;
  check: PullRequestCheck;
  startedAt?: string;
}

/**
 * The latest run of `name` among `GET commits/{ref}/check-runs?check_name=` (REST). `appId` narrows it to one app when the mark names one. A run on another commit than `expectedSha` (when the ref was
 * a sha) is not this commit's and is refused. Undefined when none matches; a run that does not parse throws (not known).
 */
export function latestCheckRunOf(list: unknown, input: { name: string; appId?: number | undefined; expectedSha?: string | undefined }): LatestCheckRun | undefined {
  const runs = record(list)?.["check_runs"];
  if (!Array.isArray(runs)) throw new Error("check runs list unreadable");
  // A list past one page is not the whole answer: the named check could be on the next page, so nothing is read from it.
  const total = record(list)?.["total_count"];
  if (runs.length > 100 || (typeof total === "number" && total > runs.length)) throw new Error("check runs list cut");
  const found: LatestCheckRun[] = [];
  for (const value of runs.slice(0, 100)) {
    const run = record(value);
    if (run === undefined) throw new Error("check run unreadable");
    if (typeof run["name"] !== "string" || cleanName(run["name"]) !== input.name) continue;
    const appId = positiveId(record(run["app"])?.["id"]);
    if (input.appId !== undefined && appId !== input.appId) continue;
    const headSha = run["head_sha"];
    if (typeof headSha !== "string" || !SHA.test(headSha)) throw new Error("check run head unreadable");
    if (input.expectedSha !== undefined && headSha !== input.expectedSha) continue;
    const completed = run["status"] === "completed";
    const conclusion = typeof run["conclusion"] === "string" ? REST_CONCLUSIONS[run["conclusion"]] : undefined;
    if (completed && conclusion === undefined) throw new Error("check run conclusion unknown");
    const id = positiveId(run["id"]);
    const started = time(run["started_at"]);
    found.push({
      headSha,
      check: { name: input.name, status: completed ? "completed" : "pending", ...(completed && conclusion !== undefined ? { conclusion } : {}), required: false, url: safeUrl(run["html_url"] ?? run["details_url"]), ...(id === undefined ? {} : { jobId: String(id) }), ...(appId === undefined ? {} : { appId }) },
      ...(started === undefined ? {} : { startedAt: started }),
    });
  }
  // The newest start speaks for the commit; a run with no start time is older than any that has one. Between runs that cannot be told apart, a failed one wins.
  const failedRank = (run: LatestCheckRun): number => (run.check.conclusion !== undefined && run.check.conclusion !== "success" && run.check.conclusion !== "neutral" && run.check.conclusion !== "skipped" ? 1 : 0);
  return found.sort((left, right) => (Date.parse(right.startedAt ?? "1970-01-01T00:00:00Z") - Date.parse(left.startedAt ?? "1970-01-01T00:00:00Z")) || failedRank(right) - failedRank(left))[0];
}

/** The latest commit status of `name` from `GET commits/{ref}/status` (combined: one entry per context). A status has no app, so a mark that names one never matches a status. */
export function latestStatusOf(combined: unknown, input: { name: string; appId?: number | undefined; expectedSha?: string | undefined }): LatestCheckRun | undefined {
  if (input.appId !== undefined) return undefined;
  const body = record(combined);
  const sha = body?.["sha"];
  const statuses = body?.["statuses"];
  if (typeof sha !== "string" || !SHA.test(sha) || !Array.isArray(statuses)) throw new Error("combined status unreadable");
  if (input.expectedSha !== undefined && sha !== input.expectedSha) return undefined;
  for (const value of statuses.slice(0, 100)) {
    const status = record(value);
    if (status === undefined || typeof status["context"] !== "string" || cleanName(status["context"]) !== input.name) continue;
    const state = status["state"];
    if (state !== "error" && state !== "failure" && state !== "pending" && state !== "success") throw new Error("status state unknown");
    const finished = state !== "pending";
    return {
      headSha: sha,
      check: { name: input.name, status: finished ? "completed" : "pending", ...(finished ? { conclusion: state === "success" ? "success" as const : state === "error" ? "error" as const : "failure" as const } : {}), required: false, url: safeUrl(status["target_url"]) },
    };
  }
  return undefined;
}

/** A check name seen on recent pull requests, with the app that reported it (absent for a commit status). */
export interface SeenCheckName { name: string; source?: string }

/**
 * The names in one commit's check runs and combined status, added to `into` (distinct by name and app), at most `SEEN_CHECKS_MAX` in all. Returns false when anything was left out (an entry that does not
 * parse, a list past one page, the cap reached, or a part not given): the listing is then incomplete, and the caller says so.
 */
export function addSeenCheckNames(into: Map<string, SeenCheckName>, checkRuns: unknown, combined: unknown): boolean {
  let whole = true;
  const add = (name: unknown, source: string | undefined): void => {
    if (typeof name !== "string") { whole = false; return; }
    let clean: string;
    try {
      clean = cleanName(name);
    } catch {
      whole = false;
      return;
    }
    if (into.size >= SEEN_CHECKS_MAX && !into.has(`${clean}\u0000${source ?? ""}`)) { whole = false; return; }
    const key = `${clean}\u0000${source ?? ""}`;
    if (!into.has(key)) into.set(key, { name: clean, ...(source === undefined ? {} : { source }) });
  };
  const runsBody = record(checkRuns);
  const runs = runsBody?.["check_runs"];
  if (!Array.isArray(runs)) whole = false;
  else {
    const total = runsBody?.["total_count"];
    if (runs.length > 100 || (typeof total === "number" && total > runs.length)) whole = false;
    for (const value of runs.slice(0, 100)) {
      const run = record(value);
      const appId = positiveId(record(run?.["app"])?.["id"]);
      add(run?.["name"], appId === undefined ? undefined : String(appId));
    }
  }
  const statuses = record(combined)?.["statuses"];
  if (!Array.isArray(statuses)) whole = false;
  else {
    if (statuses.length > 100) whole = false;
    for (const value of statuses.slice(0, 100)) add(record(value)?.["context"], undefined);
  }
  return whole;
}

/** The head commits of `GET pulls?state=all` (recent first), at most `max`, each a full sha. */
export function recentPullRequestHeads(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  const heads: string[] = [];
  for (const value of list.slice(0, max)) {
    const sha = record(record(value)?.["head"])?.["sha"];
    if (typeof sha === "string" && SHA.test(sha) && !heads.includes(sha)) heads.push(sha);
  }
  return heads;
}

/** Whether a check run is a GitHub Actions job (its run attempt can be read). */
export const isActionsApp = (appId: number | undefined): boolean => appId === GITHUB_ACTIONS_APP_ID;
