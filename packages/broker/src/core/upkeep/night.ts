// Nightly upkeep, one night of one project (lead 4 N1; design setup-upkeep-plan.md 2.2, wiki plan row N1). The scheduler's fire for a project with upkeep ON reaches `runUpkeepNight`. The order is fixed:
//   1. the switch: read NOW from the project's own row. OFF: nothing else is read and nothing is done.
//   2. when something merged since the last recorded night (the default-branch commits changed; unreadable counts as changed): the SETUP CHECK, then the MOCK / SPEC CHECKS. Neither uses AI; a failure of one is logged in
//      fixed words and never stops the next step. (The setup check's result is the setup page's own card; this job only starts the check.)
//   3. the WIKI REFRESH of the pages that are flagged, changed or unwritten: AI, under the project's upkeep cap, through the one unattended door (refresh.ts). It starts only when a dollar cap is really enforced on this
//      install; before it starts, the project's upkeep limit is read when the host can (a limit that says "paused" starts nothing and tells the admins once); when the gateway pauses a started run, the same notice is written.
//   4. the night is recorded (fixed words) and the commits are remembered.
// SILENT when fine: no message is written for a night that passed, and none for a night that had nothing to do. The only voice is the admins' notice of a pause (`queueUpkeepPaused`), once per month and reason.
import { createHash } from "node:crypto";
import { type DocumentStore, type OrgId, type UpkeepNightOutcome, type UpkeepPauseReason } from "@agentx/contracts";
import type { UpkeepRefreshAnswer } from "./refresh.js";
import { upkeepExpiryOf, upkeepLastKey, upkeepNightKey } from "./keys.js";
import { readUpkeepSetting } from "./settings.js";

export type UpkeepLimitRead = { state: "ok" } | { state: "paused"; reason: UpkeepPauseReason };
export type UpkeepStepResult = "done" | "failed" | "unavailable" | "skipped";

export interface UpkeepNightDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** Whether a dollar cap is really enforced on this install (the registered Admission declares it). False: nothing that spends AI is started. */
  enforces: { dollars: boolean };
  /** The default branch's head of each repository, as the code host says now (a repository that cannot be read is left out). Throws when the host cannot answer. */
  heads(project: string): Promise<ReadonlyArray<{ repo: string; commit: string }>>;
  /** Step 2a, no AI: starts the project's setup check on a fresh machine. Absent: this install cannot (reported `unavailable`). */
  setupCheck?(project: string): Promise<void>;
  /** Step 2b, no AI: the mock and spec checks (design 2.4). Absent: not built here yet (reported `unavailable`). */
  mockChecks?(project: string): Promise<void>;
  /** The project's upkeep limit as Cloud says now (GET /org/spend-limits), when the host can read it. Throws or absent: the gateway's own refusal at the first call is the wall. */
  limit?(project: string): Promise<UpkeepLimitRead>;
  /** Step 3, AI: tonight's refresh (refresh.ts `startUpkeepWikiRefresh`). */
  refresh(project: string, day: string, options: { includeUnwritten: boolean }): Promise<UpkeepRefreshAnswer>;
  /** Writes the admins' notice of a pause (`queueUpkeepPaused`, once per company, project, month and reason). Never throws. */
  paused(input: { orgId: OrgId; project: string; reason: UpkeepPauseReason }): Promise<void>;
  /** Fixed codes only: never a repository's text, a prompt, a path or a key. */
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface UpkeepNightResult { outcome: UpkeepNightOutcome; setupCheck: UpkeepStepResult; mockChecks: UpkeepStepResult; wiki: string; /** L4-SR1: why the night paused before it started (the gateway's cap read), when it did. */ pauseReason?: UpkeepPauseReason }

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const headsHash = (heads: ReadonlyArray<{ repo: string; commit: string }>): string =>
  createHash("sha256").update(JSON.stringify([...heads].map((head) => [head.repo, head.commit]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)))).digest("hex");

async function freeStep(deps: UpkeepNightDeps, project: string, step: "setup_check" | "mock_checks"): Promise<UpkeepStepResult> {
  if (step === "setup_check" ? deps.setupCheck === undefined : deps.mockChecks === undefined) return "unavailable";
  try {
    await (step === "setup_check" ? deps.setupCheck!(project) : deps.mockChecks!(project));
    return "done";
  } catch (error) {
    deps.log?.({ event: "upkeep.step_failed", step, error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

export async function runUpkeepNight(deps: UpkeepNightDeps, input: { project: string }): Promise<UpkeepNightResult> {
  const { project } = input;
  const result: UpkeepNightResult = { outcome: "off", setupCheck: "skipped", mockChecks: "skipped", wiki: "skipped" };
  // 1. The switch, now. Off reads and does nothing more.
  if (!(await readUpkeepSetting(deps, project)).enabled) return result;
  const scope = { orgId: deps.companyId, project };
  const day = dayOf(deps.now());
  const last = await deps.store.get(upkeepLastKey(scope)).catch(() => undefined);
  let heads: ReadonlyArray<{ repo: string; commit: string }> | undefined;
  try { heads = await deps.heads(project); } catch { heads = undefined; }
  const hash = heads === undefined || heads.length === 0 ? undefined : headsHash(heads);
  const merged = hash === undefined || last?.["orgId"] !== deps.companyId || last["project"] !== project || last["headsHash"] !== hash;
  // 2. Free steps, only when something merged.
  if (merged) {
    result.setupCheck = await freeStep(deps, project, "setup_check");
    result.mockChecks = await freeStep(deps, project, "mock_checks");
  }
  // 3. The wiki refresh: AI, only with an enforced cap.
  let outcome: UpkeepNightOutcome;
  let refreshed: string | undefined;
  if (!deps.enforces.dollars) {
    result.wiki = "no_cost_cap";
    outcome = "no_cost_cap";
  } else {
    // A refresh already started at exactly these commits is not paid for again: nothing merged since, so the same pages would be written (or dropped) the same way. A person's "Refresh now" or the next merge goes on from here.
    const refreshedHash = last?.["orgId"] === deps.companyId && last["project"] === project && typeof last["refreshedHash"] === "string" ? last["refreshedHash"] : undefined;
    if (hash === undefined) {
      // The commits could not be read (the code host is down): nothing is spent on a night that cannot tell what it would refresh, and the same words are logged.
      result.wiki = "heads_unreadable";
      outcome = "failed";
      deps.log?.({ event: "upkeep.heads_unreadable" });
    } else if (refreshedHash === hash) {
      result.wiki = "already_refreshed";
      outcome = "nothing_changed";
      refreshed = hash;
    } else {
      outcome = await wikiStep(deps, project, day, result, merged);
      if (result.wiki === "started") refreshed = hash;
    }
  }
  // 4. Recorded in fixed words; the commits are remembered so tomorrow can tell whether anything merged.
  const at = new Date(deps.now()).toISOString();
  try {
    await deps.store.put({ item: { ...upkeepNightKey(scope, day), entityType: "UPKEEP_NIGHT", orgId: deps.companyId, project, day, outcome, wiki: result.wiki, ...(result.pauseReason === undefined ? {} : { pauseReason: result.pauseReason }), at, ...upkeepExpiryOf(deps.now()) } });
    if (hash !== undefined) await deps.store.put({ item: { ...upkeepLastKey(scope), entityType: "UPKEEP_LAST", orgId: deps.companyId, project, day, headsHash: hash, outcome, at, ...(refreshed === undefined ? {} : { refreshedHash: refreshed }), ...upkeepExpiryOf(deps.now()) } });
  } catch (error) {
    deps.log?.({ event: "upkeep.night_not_recorded", error: error instanceof Error ? error.name : "unknown" });
  }
  result.outcome = outcome;
  return result;
}

async function wikiStep(deps: UpkeepNightDeps, project: string, day: string, result: UpkeepNightResult, merged: boolean): Promise<UpkeepNightOutcome> {
  if (deps.limit !== undefined) {
    let read: UpkeepLimitRead | undefined;
    try { read = await deps.limit(project); } catch { read = undefined; }
    if (read?.state === "paused") {
      await deps.paused({ orgId: deps.companyId, project, reason: read.reason });
      result.wiki = "paused";
      result.pauseReason = read.reason;
      return "paused";
    }
  }
  let answer: UpkeepRefreshAnswer;
  try {
    answer = await deps.refresh(project, day, { includeUnwritten: true });
  } catch (error) {
    deps.log?.({ event: "upkeep.refresh_failed", error: error instanceof Error ? error.name : "unknown" });
    result.wiki = "failed";
    return "failed";
  }
  result.wiki = answer.outcome;
  switch (answer.outcome) {
    case "started": return "ran";
    case "no_cost_cap": return "no_cost_cap";
    case "needs_ai_key": return "needs_ai_key";
    case "busy": return "busy";
    case "unavailable": return "failed";
    default: return merged && (result.setupCheck === "done" || result.mockChecks === "done") ? "ran" : "nothing_changed";
  }
}

