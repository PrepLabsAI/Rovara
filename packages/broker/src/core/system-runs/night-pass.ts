// The hourly pass of the upkeep night (lead 4 L4-P1; design system-started-runs.md 3.2). The hosted job table fires it once an hour (`upkeep-night`, core-host/jobs.ts); it runs for ONE company and only DECIDES AND STARTS, it
// never waits for a run:
//   1. the company's SystemRuns flag is off: return (nothing is read);
//   2. for each project of the company (the order rotates by the hour, so the same projects are not always last): is it this project's hour? Each project has a fixed hour inside the night window (07:00-11:00 UTC) from a hash
//      of company and project (`upkeepNightDue`); outside the window, or before its own hour, nothing is read for it. A project whose upkeep is OFF is skipped.
//   3. CLAIM the night: one row per project per UTC day, written only when absent. A second fire (a retry, a double delivery, the next hour) finds it and does nothing. A night whose start failed (a fault, not a refusal)
//      gives its claim back, so the next hour tries again inside the window;
//   4. at most `MAX_STARTS_PER_PASS` projects are started per pass; the rest wait for the next hour (a company with many projects never starts many machines at once);
//   5. the night itself is the injected `night` (core/upkeep/night.ts `runUpkeepNight`): it reads the switch again, and starts the nightly check through the system starter only when something merged.
// A missed hour (a deploy, an outage): the next pass starts any project whose hour has passed today and has no claim. A missed day is skipped, not doubled.
import { INDEX_EXPIRY_ATTRIBUTE, UPKEEP_NIGHT_WINDOW, upkeepNightDue, type DocumentStore, type OrgId } from "@agentx/contracts";
import { upkeepPartition } from "../upkeep/keys.js";
import { readUpkeepSetting } from "../upkeep/settings.js";
import type { UpkeepNightResult } from "../upkeep/night.js";

/** The most projects one pass starts. */
export const MAX_STARTS_PER_PASS = 5;
const CLAIM_KEEP_SECONDS = 3 * 86_400;

export interface UpkeepPassDeps {
  store: DocumentStore;
  companyId: OrgId;
  now: () => number;
  /** The company's SystemRuns flag, read now. */
  enabled(): boolean;
  /** Every project of the company (its catalog). Throws when it cannot be read. */
  projects(): Promise<readonly string[]>;
  /** One project's night (`runUpkeepNight`). */
  night(project: string): Promise<UpkeepNightResult>;
  /** Fixed codes only. */
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface UpkeepPassReport {
  skipped?: "system_runs_off" | "outside_window";
  due: number;
  started: number;
  claimedAlready: number;
  failed: number;
  deferred: number;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const upkeepClaimKey = (orgId: OrgId, project: string, day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("not a day");
  return { pk: upkeepPartition({ orgId, project }), sk: `PASS#${day}` };
};

export async function runUpkeepNightPass(deps: UpkeepPassDeps, options: { budgetMs: number }): Promise<UpkeepPassReport> {
  const report: UpkeepPassReport = { due: 0, started: 0, claimedAlready: 0, failed: 0, deferred: 0 };
  if (!deps.enabled()) return { ...report, skipped: "system_runs_off" };
  const startedAt = deps.now();
  const hour = new Date(startedAt).getUTCHours();
  if (hour < UPKEEP_NIGHT_WINDOW.startHourUtc || hour >= UPKEEP_NIGHT_WINDOW.endHourUtc) return { ...report, skipped: "outside_window" };
  const day = dayOf(startedAt);
  const names = [...await deps.projects()].sort();
  // The order rotates with the day and the hour, so a company over the per-pass limit does not always leave the same projects for later.
  const rotation = names.length === 0 ? 0 : (Math.floor(startedAt / 3_600_000) % names.length);
  for (const project of [...names.slice(rotation), ...names.slice(0, rotation)]) {
    if (deps.now() - startedAt > options.budgetMs) { report.deferred += 1; continue; }
    // Not this project's hour yet (or its hour is past the window's end): nothing is read for it.
    if (!upkeepNightDue(deps.companyId, project, startedAt)) continue;
    if (!(await readUpkeepSetting(deps, project)).enabled) continue;
    report.due += 1;
    if (report.started >= MAX_STARTS_PER_PASS) { report.deferred += 1; continue; }
    const key = upkeepClaimKey(deps.companyId, project, day);
    const claimed = await deps.store.put({
      item: { ...key, entityType: "UPKEEP_PASS_CLAIM", orgId: deps.companyId, project, day, at: new Date(deps.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + CLAIM_KEEP_SECONDS },
      condition: { op: "notExists", path: ["pk"] },
    });
    if (!claimed.applied) { report.claimedAlready += 1; continue; }
    try {
      await deps.night(project);
      report.started += 1;
    } catch (error) {
      // A fault (not a refusal): the claim goes back so the next hour tries this project again inside the window.
      report.failed += 1;
      deps.log?.({ event: "upkeep_pass.night_failed", error: error instanceof Error ? error.name : "unknown" });
      await deps.store.delete({ key }).catch(() => undefined);
    }
  }
  return report;
}
