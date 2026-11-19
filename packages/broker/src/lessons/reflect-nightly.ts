// The nightly reflector. It re-reflects tasks whose outcome changed (a revert within 14 days, late review comments) and
// the day's decisions and ticket clusters, within a per-run budget of subjects, time and dollars. A project in mode Off or Collect is skipped by
// `reflectSubject` itself, so a company lock is honoured here without a second check.
import { learningCaps } from "./policy.js";
import { reflectSubject, type LessonDraft, type NightlyBudget, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";

export interface NightlyWorkSource {
  projects(workspaceId: string): Promise<string[]>;
  /** The subjects due for reflection in a project since `sinceMs`, oldest first, at most `limit`. */
  subjects(workspaceId: string, project: string, sinceMs: number, limit: number): Promise<ReflectSubject[]>;
}
/** Receives the drafts of one subject (the curator pipeline). A failure here never stops the run. */
export type DraftSink = (subject: ReflectSubject, drafts: LessonDraft[]) => Promise<void>;

export interface NightlyOptions { workspaceId: string; sinceMs: number; maxSubjects?: number; maxMs?: number }
export interface NightlyReport {
  subjects: number; reflected: number; drafts: number; skipped: number; stoppedBy: "done" | "subjects" | "time" | "night_cap";
  spentUsd: number;
}

export async function reflectNightly(deps: ReflectDeps, work: NightlyWorkSource, sink: DraftSink, options: NightlyOptions): Promise<NightlyReport> {
  const maxSubjects = options.maxSubjects ?? 200;
  const maxMs = options.maxMs ?? 10 * 60_000;
  const started = deps.now();
  const caps = learningCaps(deps.edition, deps.capsOverride);
  const budget: NightlyBudget = { spentUsd: 0, ...(caps.perNightUsd === undefined ? {} : { capUsd: caps.perNightUsd }) };
  const report: NightlyReport = { subjects: 0, reflected: 0, drafts: 0, skipped: 0, stoppedBy: "done", spentUsd: 0 };
  const projects = await work.projects(options.workspaceId);
  for (const project of projects) {
    const batch = await work.subjects(options.workspaceId, project, options.sinceMs, Math.max(0, maxSubjects - report.subjects));
    for (const subject of batch) {
      if (report.subjects >= maxSubjects) { report.stoppedBy = "subjects"; report.spentUsd = budget.spentUsd; return report; }
      if (deps.now() - started > maxMs) { report.stoppedBy = "time"; report.spentUsd = budget.spentUsd; return report; }
      // The workspace and project come from the work source's own listing, never from the subject's own claim.
      if (subject.workspaceId !== options.workspaceId || subject.project !== project) { report.skipped += 1; continue; }
      report.subjects += 1;
      const result = await reflectSubject(deps, subject, budget);
      if (result.reason === "night_cap") { report.stoppedBy = "night_cap"; report.spentUsd = budget.spentUsd; return report; }
      if (result.status !== "ok") { report.skipped += 1; continue; }
      report.reflected += 1;
      report.drafts += result.drafts.length;
      if (result.drafts.length > 0) { try { await sink(subject, result.drafts); } catch { /* a failed curate is retried by the next run */ } }
    }
  }
  report.spentUsd = budget.spentUsd;
  return report;
}
