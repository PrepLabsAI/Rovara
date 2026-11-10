// The lessons' two scheduled jobs, run for one company inside the Team record's own schedules (the install's scheduler runs them):
//   - hourly (job id "lessons-resume"): finishes every deletion that was started and not finished in the company's projects (`resumePending`), whatever the learning mode (an erase must finish), and counts the
//     projects with a stuck staged rollback (one fixed line, the Health page's team record line; a count only);
//   - nightly (job id "lessons-reverts"): re-reflects tasks whose change was reverted in the last 72 hours. One message per task to the same queue as a task's end, with the outcome `reverted`; the worker's
//     once-claim on `LEARN#<task>#reverted` makes a revert reflected once however many nights see the row (72 hours covers the daily run, a late one and a late-arriving row). The same nightly run then moves every
//     trial lesson that earned it to stable (`lessonsPromoteJob`: 14 days live, 3 loads, no thumbs-down), because a lesson that is never loaded again would otherwise wait for a load that never comes.
//     Before that it moves lessons past their expiry (and pending ones nobody decided in time) to `expired` (`lessonsExpireJob`), so an expired lesson is never promoted or published.
// Both are bounded (projects, tasks, time) and a failure of one project never stops the others.
import { createHash } from "node:crypto";
import { OrgIdSchema, type DocumentStore, type OrgId } from "@agentx/contracts";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import { settleHelpful, type CounterDeps } from "./counters.js";
import { PENDING_GRACE_MS, projectHash, rotated, documentNightlyState, type NightlyPass, type NightlyPassState, type NightlyStateStore } from "./nightly-state.js";
import type { ReflectQueue } from "./reflect-queue.js";
import type { RevertedTasksReader } from "./task-outcome-rows.js";
import { sweepExpired } from "./expiry.js";
import { retireLesson } from "./curate.js";
import { mergeKeepsRepoOnly } from "./repo-eligibility.js";
import { lessonsRepoFilePublishJob, lessonsRepoFileSweepJob, type RepoFileRuntime } from "./repo-file-job.js";
import { contradictedByMemberCard, isTrialLesson, memberCardsOf, promoteStableTrials, type StableDeps } from "./trial.js";

/** 72 hours. The rows are found by their event time, and a revert can reach the record late (GitHub redelivers for three days); the worker's once-claim on `LEARN#<task>#reverted` makes a repeat free. */
export const REVERT_WINDOW_MS = 72 * 60 * 60 * 1000;
export const MAX_PROJECTS_PER_JOB = 200;
export const MAX_REVERTS_PER_PROJECT = 100;

export interface LessonsJobDeps {
  store: DocumentStore;
  /** The tasks whose change was reverted lately. Absent: no revert is re-reflected. */
  reverts?: RevertedTasksReader | undefined;
  settings: LearningSettingsReader;
  queue?: ReflectQueue | undefined;
  /** What the nightly upkeep needs (the lessons' store, audit and clock): the expiry sweep and the trial-to-stable pass. Absent: neither runs. */
  maintain?: StableDeps | undefined;
  /** What the nightly helpful settle needs (`settleHelpful`; the runtime's counters). The expiry sweep settles the helpful marks that fell due BEFORE it sweeps, so a lesson people use is renewed first. */
  counters?: CounterDeps | undefined;
  /** The lessons a frozen eval snapshot references, which the sweep never expires. Absent: none are pinned. A read that throws skips the project's sweep (fail closed). */
  pinned?: ((orgId: string, project: string) => Promise<ReadonlySet<string>>) | undefined;
  /** Where the passes remember their starting project and each project's grace window. Absent: the document store's own item. */
  state?: NightlyStateStore | undefined;
  /** The weekly file pass. Absent: it does not run. */
  repoFile?: RepoFileRuntime | undefined;
  /** Tries every unfinished deletion of the project (`LessonDeletionPort.resumeAll`): one that fails never stops the ones after it. */
  resume(orgId: string, project: string): Promise<{ finished: number; failed: number }>;
  now(): number;
  newRequestId(): string;
  log(event: string, fields: Record<string, string | number>): void;
}

/** What the hourly run needs to list stuck rollback intents. Both are optional: without them the run only resumes deletions. */
export interface StuckRollbackWatch {
  /** Whether the project has a staged rollback that did not finish (the lesson store's own check for one). Throws when it cannot look. */
  stuckRollbacks?: ((orgId: string, project: string) => Promise<boolean>) | undefined;
  /** Where the company's count goes for the Health page (`recordOpsLevel`). Never throws. */
  reportStuck?: ((orgId: string, count: number) => Promise<void>) | undefined;
}

/**
 * Hourly. Finishes every unfinished deletion of each project, and counts the projects whose staged rollback is stuck: one fixed log line with the number, the number in the answer, and the number
 * handed to `reportStuck` (the Health page line). No project, lesson or id leaves the job. A zero is reported only when every project was looked at and none of the looks failed (a zero that could hide a stuck
 * one would clear the Health line wrongly); a positive count is a lower bound and is always reported. Returns counts only.
 */
export async function lessonsResumeJob(deps: Pick<LessonsJobDeps, "resume" | "now" | "log"> & StuckRollbackWatch, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const started = deps.now();
  let finished = 0, failed = 0, skipped = 0, stuck = 0, stuckFailures = 0;
  const covered = projects.slice(0, MAX_PROJECTS_PER_JOB);
  for (const project of covered) {
    if (deps.now() - started > budgetMs) { skipped += 1; continue; }
    try {
      const result = await deps.resume(orgId, project);
      finished += result.finished;
      // An intent that could not be finished is counted and named in one fixed line (no ids); the project's other intents were still tried.
      if (result.failed > 0) { failed += result.failed; deps.log("lessons_job.resume_failed", { intents: result.failed }); }
    } catch { failed += 1; deps.log("lessons_job.resume_failed", {}); }
    if (deps.stuckRollbacks === undefined) continue;
    try { if (await deps.stuckRollbacks(orgId, project)) stuck += 1; } catch { stuckFailures += 1; }
  }
  const out: Record<string, number> = { lessonDeletionsResumed: finished, lessonResumeFailures: failed, lessonResumeSkipped: skipped };
  if (deps.stuckRollbacks === undefined) return out;
  if (stuck > 0) deps.log("lessons_job.rollbacks_stuck", { projects: stuck });
  if (stuckFailures > 0) deps.log("lessons_job.rollback_check_failed", { projects: stuckFailures });
  const complete = skipped === 0 && stuckFailures === 0 && projects.length <= MAX_PROJECTS_PER_JOB;
  if (deps.reportStuck !== undefined && (stuck > 0 || complete)) await deps.reportStuck(orgId, stuck).catch(() => undefined);
  return { ...out, lessonRollbacksStuck: stuck, lessonStuckCheckFailures: stuckFailures };
}

/** Nightly. Returns counts only. */
export async function lessonsRevertJob(deps: LessonsJobDeps, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.queue === undefined || deps.reverts === undefined) return { revertsEnqueued: 0 };
  const workspaceId: OrgId = org.data;
  const started = deps.now();
  let enqueued = 0, failed = 0, truncated = 0, capped = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (deps.now() - started > budgetMs) break;
    try {
      // The worker checks the mode too; asking here keeps a project with learning off from sending anything.
      if (!modeAllows((await resolveLearning(deps.settings, orgId, project)).mode, "reflect")) continue;
      const found = await deps.reverts.since(workspaceId, project, deps.now() - REVERT_WINDOW_MS);
      // A project cut off by the page limit says so in one fixed line, the project only as a hash.
      if (found.truncated) { truncated += 1; deps.log("lessons_job.revert_window_truncated", { project: createHash("sha256").update(`${orgId}\u0000${project}`).digest("hex").slice(0, 12) }); }
      // Review: the per-project cap used to cut without a word. Now one fixed line (the project as a hash) and a count.
      if (found.taskIds.length > MAX_REVERTS_PER_PROJECT) { capped += 1; deps.log("lessons_job.reverts_capped", { project: createHash("sha256").update(`${orgId}\u0000${project}`).digest("hex").slice(0, 12) }); }
      for (const taskId of found.taskIds.slice(0, MAX_REVERTS_PER_PROJECT)) {
        try { await deps.queue.send({ orgId: workspaceId, taskId, outcome: "reverted", requestId: deps.newRequestId() }); enqueued += 1; } catch { failed += 1; deps.log("lessons_job.enqueue_failed", {}); }
      }
    } catch {
      failed += 1;
      deps.log("lessons_job.revert_failed", {});
    }
  }
  return { revertsEnqueued: enqueued, revertFailures: failed, revertWindowsTruncated: truncated, revertsCapped: capped };
}

export const MAX_PROMOTIONS_PER_PROJECT = 200;
/** The helpful marks settled per project and night: this many at a time, and at most this many rounds. */
export const SETTLE_BATCH = 200;
export const SETTLE_ROUNDS = 10;

/** One pass's place in the company's project list: where it starts tonight and what it remembers. A state that cannot be read leaves the pass running from the top and writing nothing. */
async function openPass(deps: Pick<LessonsJobDeps, "store" | "state" | "log">, orgId: string, pass: NightlyPass, projects: readonly string[]): Promise<{ ordered: string[]; start: number; total: number; state: NightlyPassState; writable: boolean; store: NightlyStateStore }> {
  const store = deps.state ?? documentNightlyState(deps.store);
  const capped = [...new Set(projects)].sort().slice(0, MAX_PROJECTS_PER_JOB);
  let state: NightlyPassState = { next: 0, projects: {} };
  let writable = true;
  try { state = await store.read(orgId, pass); } catch { writable = false; deps.log("lessons_job.state_unreadable", {}); }
  const start = capped.length === 0 ? 0 : state.next % capped.length;
  return { ordered: rotated(capped, start), start, total: capped.length, state, writable, store };
}
async function closePass(deps: Pick<LessonsJobDeps, "log">, orgId: string, pass: NightlyPass, open: Awaited<ReturnType<typeof openPass>>, visited: number, projects: readonly string[]): Promise<void> {
  if (!open.writable || open.total === 0) return;
  try {
    const live = new Set(projects.map((project) => projectHash(orgId, project)));
    await open.store.write(orgId, pass, { next: (open.start + visited) % open.total, projects: Object.fromEntries(Object.entries(open.state.projects).filter(([hash]) => live.has(hash))) });
  } catch { deps.log("lessons_job.state_unsaved", {}); }
}

/**
 * Nightly. Moves each project's trial lessons that earned stable to stable (`promoteStableTrials`, which writes the audit entry first and commits through the store's erasure fence). Only where trial lessons
 * can exist: the project's resolved learning must allow them (Standard preset, mode On, no company approval floor). A project that is Off, Collect, Suggest or Regulated is left alone. Bounded in projects, lessons and
 * time; one project failing never stops the others. The pass starts at a saved position and walks the projects round, so the projects at the end of the list are not the ones the budget always cuts off. Returns counts only.
 */
export async function lessonsPromoteJob(deps: Pick<LessonsJobDeps, "store" | "settings" | "maintain" | "state" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.maintain === undefined) return { trialsPromoted: 0 };
  const started = deps.now();
  const outOfTime = (): boolean => deps.now() - started > budgetMs;
  const open = await openPass(deps, orgId, "promote", projects);
  let promoted = 0, failed = 0, visited = 0;
  for (const project of open.ordered) {
    if (outOfTime()) break;
    let cut = false;
    const stop = (): boolean => { const out = outOfTime(); if (out) cut = true; return out; };
    try {
      if ((await resolveLearning(deps.settings, org.data, project)).trialAllowed) {
        // A lesson a pending member card contradicts is never made stable (the repair retires it; past its night's cap it waits for the next night, still on trial).
        const contradicted = await contradictedByMemberCard(deps.maintain.store, { workspaceId: org.data, project });
        promoted += (await promoteStableTrials(deps.maintain, { workspaceId: org.data, project }, MAX_PROMOTIONS_PER_PROJECT, stop, contradicted)).length;
      }
    } catch {
      failed += 1;
      deps.log("lessons_job.promote_failed", {});
    }
    // A project the budget cut off in the middle is the next night's first; one that was finished counts, even when the budget is gone now.
    if (cut) break;
    visited += 1;
  }
  await closePass(deps, orgId, "promote", open, visited, projects);
  return { trialsPromoted: promoted, promoteFailures: failed };
}

/** The most trial lessons one project's repair actually retires in a night (a retire that did not happen does not use this); the rest go on the next nights. */
export const MAX_TRIAL_REPAIRS_PER_PROJECT = 20;
/** The most cards one project's repair looks at in a night, whatever came of them: the hard bound of the pass (the pending cards are read in a rotating order that resumes where the last night stopped, so no card is behind the limit every night). */
export const MAX_TRIAL_REPAIR_CHECKS = 200;

/**
 * Nightly: a member's correction that contradicts a lesson live on trial makes a card for people and retires that lesson (`curate.ts`, `toPerson`). The retire comes after the card is committed, and a
 * store fault in it is not allowed to undo the card, so it can be left undone. This repairs it by the same rule: each pending card that names a lesson, from a member's correction, whose named lesson is still
 * live on trial is retired (audited as the contradicted trial retire). It runs before the promotion, and the promotion skips any lesson such a card names, so a contradicted lesson is never made stable first.
 * Where learning is not Off. Bounded: at most `MAX_TRIAL_REPAIRS_PER_PROJECT` retires that really happened per project and night, and at most `MAX_TRIAL_REPAIR_CHECKS` cards looked at; the cards are walked from a
 * saved place (the number of cards looked at moves it on each night, per project), so a retire the store refuses for ever (its erasure fence) cannot keep the same cards first every night and starve the rest. A refusal or a failure is counted and the pass goes on.
 * Returns counts only.
 */
export async function lessonsTrialRepairJob(deps: Pick<LessonsJobDeps, "store" | "settings" | "maintain" | "state" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.maintain === undefined) return { trialsRetiredByCard: 0 };
  const started = deps.now();
  const outOfTime = (): boolean => deps.now() - started > budgetMs;
  // Where each project's walk resumes is saved (a count per project hash): a state that cannot be read leaves the walk at the top and writes nothing.
  const store = deps.state ?? documentNightlyState(deps.store);
  let saved: NightlyPassState = { next: 0, projects: {} };
  let writable = true;
  try { saved = await store.read(orgId, "repair"); } catch { writable = false; deps.log("lessons_job.state_unreadable", {}); }
  let retired = 0, failed = 0, refused = 0, moved = false;
  for (const project of [...new Set(projects)].sort().slice(0, MAX_PROJECTS_PER_JOB)) {
    if (outOfTime()) break;
    try {
      if ((await resolveLearning(deps.settings, org.data, project)).mode === "Off") continue;
      const key = { workspaceId: org.data, project };
      const hash = projectHash(orgId, project);
      const cards = await memberCardsOf(deps.maintain.store, key);
      const first = cards.length === 0 ? 0 : (saved.projects[hash]?.cardsNext ?? 0) % cards.length;
      let done = 0, examined = 0;
      for (const card of [...cards.slice(first), ...cards.slice(0, first)].slice(0, MAX_TRIAL_REPAIR_CHECKS)) {
        if (done >= MAX_TRIAL_REPAIRS_PER_PROJECT || outOfTime()) break;
        examined += 1;
        const other = await deps.maintain.store.get(key, card.contradictsWith!);
        if (other === undefined || !isTrialLesson(other) || other.status !== "active") continue;
        // A card across the repo-only line is for a person; the nightly repair never retires a trial lesson on it (as curate does not).
        if (!mergeKeepsRepoOnly(other, card)) continue;
        try {
          if (await retireLesson(deps.maintain, key, other.id, "contradicted", undefined, "lesson.trial_retired")) { retired += 1; done += 1; } else refused += 1;
        } catch { failed += 1; deps.log("lessons_job.trial_repair_failed", {}); }
      }
      // Tomorrow starts after the last card looked at, so every card is reached within ceil(cards / looked at per night) nights.
      if (cards.length > 0) { saved.projects[hash] = { seenAt: deps.now(), cardsNext: (first + examined) % cards.length }; moved = true; }
    } catch {
      failed += 1;
      deps.log("lessons_job.trial_repair_failed", {});
    }
  }
  if (writable && moved) {
    const live = new Set([...new Set(projects)].map((project) => projectHash(orgId, project)));
    try { await store.write(orgId, "repair", { next: 0, projects: Object.fromEntries(Object.entries(saved.projects).filter(([hash]) => live.has(hash))) }); } catch { deps.log("lessons_job.state_unsaved", {}); }
  }
  return { trialsRetiredByCard: retired, trialRepairFailures: failed, trialRepairRefused: refused };
}

/**
 * Nightly. Per project where learning is not Off: first settles the helpful marks that fell due (`settleHelpful`: each applies the mark and renews the lesson), THEN marks lessons past their expiry (active) and
 * pending lessons nobody decided in time as `expired` (`sweepExpired`: audited, committed through the store's erasure fence, the rule checked again on the fresh copy). So a lesson people use is renewed before the
 * sweep looks at it. Loading already ignores an expired lesson; this makes the Lessons tab, the counts and repository publishing agree. Lessons an eval snapshot pins are never expired. A project whose learning was Off
 * the last time the sweep reached it (it is marked `off`), or that was never seen, holds its pending lessons for a grace window, so switching learning back on does not expire the backlog at once. A lesson fades after N days without helping (`expiry.ts`). Bounded in projects, lessons and time (the sweep stops between
 * lessons), starting at a saved position; a failing project never stops the others.
 */
export async function lessonsExpireJob(deps: Pick<LessonsJobDeps, "store" | "settings" | "maintain" | "counters" | "pinned" | "state" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.maintain === undefined) return { lessonsExpired: 0 };
  const started = deps.now();
  const outOfTime = (): boolean => deps.now() - started > budgetMs;
  const open = await openPass(deps, orgId, "expire", projects);
  let expired = 0, failed = 0, settled = 0, visited = 0;
  for (const project of open.ordered) {
    if (outOfTime()) break;
    let cut = false;
    try {
      if ((await resolveLearning(deps.settings, org.data, project)).mode === "Off") {
        // Say so, instead of guessing from a gap later: the first night with learning On after this opens the grace window.
        open.state.projects[projectHash(orgId, project)] = { seenAt: deps.now(), off: true };
        visited += 1;
        continue;
      }
      const key = { workspaceId: org.data, project };
      // The marks first: any failure here (or in the pinned read) leaves the project unswept tonight rather than sweeping lessons that were about to be renewed.
      if (deps.counters !== undefined) {
        for (let round = 0; round < SETTLE_ROUNDS && !outOfTime(); round += 1) {
          const applied = await settleHelpful(deps.counters, key, SETTLE_BATCH);
          settled += applied;
          if (applied < SETTLE_BATCH) break;
        }
      }
      const pinned = deps.pinned === undefined ? undefined : await deps.pinned(org.data, project);
      const hash = projectHash(orgId, project);
      const now = deps.now();
      const seen = open.state.projects[hash];
      const graceUntil = seen === undefined || seen.off === true ? now + PENDING_GRACE_MS : seen.graceUntil;
      const swept = await sweepExpired(deps.maintain, deps.maintain.store, key, { limit: MAX_PROMOTIONS_PER_PROJECT, stop: outOfTime, ...(pinned === undefined ? {} : { pinned }), ...(graceUntil === undefined ? {} : { holdPendingUntil: graceUntil }) });
      expired += swept.expired.length;
      cut = swept.stopped;
      open.state.projects[hash] = { seenAt: now, ...(graceUntil !== undefined && graceUntil > now ? { graceUntil } : {}) };
    } catch {
      failed += 1;
      deps.log("lessons_job.expire_failed", {});
    }
    if (cut) break;
    visited += 1;
  }
  await closePass(deps, orgId, "expire", open, visited, projects);
  return { lessonsExpired: expired, expireFailures: failed, helpfulSettled: settled };
}

/** The nightly run: the revert re-reflection with the first half of the budget, then the expiry sweep, the trial repair and the trial promotion with what is left, so neither can starve the other. */
export async function lessonsNightlyJob(deps: LessonsJobDeps, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const started = deps.now();
  // The erasure sweep comes FIRST and has a share of the night's budget of its own (a fifth), so no other pass can starve it.
  const sweep = deps.repoFile === undefined ? {} : await lessonsRepoFileSweepJob(deps.repoFile, orgId, projects, budgetMs / 5, Math.floor(deps.now() / 86_400_000));
  const reverts = await lessonsRevertJob(deps, orgId, projects, budgetMs / 2);
  const expiries = await lessonsExpireJob(deps, orgId, projects, Math.max(0, (budgetMs - (deps.now() - started)) / 2));
  // The repair of a trial lesson a card contradicts comes before the promotion: a contradicted lesson is not made stable first.
  const repairs = await lessonsTrialRepairJob(deps, orgId, projects, Math.max(0, (budgetMs - (deps.now() - started)) / 4));
  const promotions = await lessonsPromoteJob(deps, orgId, projects, Math.max(0, (budgetMs - (deps.now() - started)) / 2));
  // The weekly lessons file pass comes last, with what is left: it opens a pull request only after the sweep above has retired and expired what should go.
  const repoFile = deps.repoFile === undefined ? {} : await lessonsRepoFilePublishJob(deps.repoFile, orgId, projects, Math.max(0, budgetMs - (deps.now() - started)), Math.floor(deps.now() / 86_400_000));
  return { ...sweep, ...reverts, ...expiries, ...repairs, ...promotions, ...repoFile };
}
