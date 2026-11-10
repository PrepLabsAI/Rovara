// Helpful and harmful counters, stale handling and auto-retire. Counters come from outcomes (merge, send-backs, reviews,
// reverts) and from two buttons on the task page ("Helpful", "Wrong here"). Every mark is idempotent per task and lesson. The judge model is tool-less and
// answers a fixed code; it can only add a harmful mark or withhold a helpful one, never approve or lower a tier.
import { createHash } from "node:crypto";
import { resolveLearning, emitAudit, modeAllows, type LearningSettingsReader } from "./policy.js";
import type { AlertSink, CorrectionJudge, CorrectionKind, CorrectionRating, LessonDeps, LessonVectors } from "./ports.js";
import { pendingExpiry, renewLesson } from "./expiry.js";
import { retireLesson } from "./curate.js";
import { isTrialLesson, promoteIfStable } from "./trial.js";
import { nextVersion, type LessonStore, type LoadManifest, type ScopeKey } from "./store.js";
import { cleanForLearning, globToRegExp } from "./guards.js";
import type { AccessCheckPort } from "./access-port.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { IdentitySet, Lesson } from "./types.js";
import type { LoadReport } from "@agentx/contracts";

const DAY = 86_400_000;
export const REVERT_WINDOW_MS = 14 * DAY;
export const STALE_WINDOW_MS = 14 * DAY;
export const STALE_LIMIT = 3;
const MAX_JUDGE_CALLS_PER_TASK = 20;
const RATINGS: readonly CorrectionRating[] = ["caused", "contradicts", "unrelated", "same_ignored"];
const MAX_CORRECTIONS_PER_LESSON = 5;

/** Only a lesson the worker reported as having reached the prompt counts for anything: loaded, helpful, harmful. A dropped or unreported lesson never ran. */
const REACHED_PROMPT: ReadonlySet<string> = new Set(["valid", "moved", "none"]);
const reached = (manifests: readonly LoadManifest[]): Set<string> => new Set(manifests.flatMap((m) => m.lessons.filter((e) => REACHED_PROMPT.has(e.citation)).map((e) => e.id)));

export interface CounterDeps extends LessonDeps {
  store: LessonStore; judge: CorrectionJudge; settings: LearningSettingsReader; alerts?: AlertSink; /** Where lesson vectors are kept: a lesson the counters retire loses its vector. */ vectors?: LessonVectors;
  /** Asked before each judge call: false means this task's time for judging is used up (the correction is then unjudged and the outcome is reported `deferred`). Absent: always. */
  mayCall?: () => boolean;
}

export interface TaskCorrection {
  kind: CorrectionKind; /** Files the correction touches, for scope matching. Empty: it names none, so it could be about any lesson. */ paths: readonly string[]; text: string; at: number;
  /** The canonical developer id of the person whose correction this is. A harmful mark is made once per person and lesson, under their random reference (erasure takes it back). Absent: it can blame nobody. */
  authorId?: string;
  /** The words are code's (a send-back with no reason, an erased sender's, a revert): counted, never rated, and it leaves the lesson unjudged. */
  fixed?: boolean;
}
export interface TaskOutcome {
  workspaceId: string; project: string; taskId: string; outcome: "merged" | "closed" | "abandoned" | "reverted"; sendBacks: number; mergedAt?: number;
  corrections: readonly TaskCorrection[];
  /** An eval run writes no counters. */
  evalRun?: boolean;
}

/**
 * A correction is in a lesson's scope when the lesson has no path scope (a repository-wide lesson), or the correction names no file (a send-back and a revert name none today, so what it touched is unknown and
 * it could be about any lesson), or one of the correction's files matches.
 */
const inScope = (lesson: Lesson, correction: TaskCorrection): boolean => {
  const paths = lesson.scope.paths ?? [];
  if (paths.length === 0 || correction.paths.length === 0) return true;
  const expressions = paths.map(globToRegExp);
  return correction.paths.some((p) => expressions.some((re) => re.test(p)));
};

/** The auto-retire rule: harmful at least 2 and more than helpful. */
const meetsRetireRule = (lesson: Lesson): boolean => lesson.counters.harmful >= 2 && lesson.counters.harmful > lesson.counters.helpful;

/**
 * Erasure of a commenter took one of their harmful marks back (`deletion.ts`). Only two things are undone, each only while the lesson is exactly what the marks made it:
 *  - the retirement the marks caused: the lesson is retired, it is still the head, and it is the very version that auto-retired it (`retiredByHarm`). If the remaining marks no longer meet the retire rule the lesson goes
 *    to PENDING for a person ("brought back after an erasure: check it", `reviewRequired`), never straight back to live: a person's approval re-checks everything the normal way. Any later change (a person retired it,
 *    something replaced it, it expired, was edited or rejected) is a newer version and nothing is done;
 *  - a retire proposal, when no harmful mark at all is left behind it.
 * Idempotent: it reads the lesson's state, so a second call (a retried erasure) does nothing more.
 */
export async function reverseHarm(deps: LessonDeps & { store: LessonStore }, key: ScopeKey, lessonId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lesson = await deps.store.get(key, lessonId);
    if (lesson === undefined) return;
    if (lesson.status === "retired") {
      if (lesson.retiredByHarm === undefined || lesson.retiredByHarm !== lesson.version || meetsRetireRule(lesson)) return;
      const setVersion = await deps.store.setVersion(key);
      const back: Lesson = { ...lesson, status: "pending", reviewRequired: true, approvals: [], pendingExpiresAt: pendingExpiry(deps.now()), version: nextVersion(lesson, await deps.store.versions(key, lessonId)), updatedAt: deps.now() };
      delete (back as { retiredByHarm?: number }).retiredByHarm;
      delete (back as { trial?: Lesson["trial"] }).trial;
      if ((await deps.store.commit(key, setVersion, [back], deps.now())).ok) await emitAudit(deps.audit, { action: "lesson.harm_reversed", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { tier: lesson.tier, type: lesson.type } });
      else continue;
      return;
    }
    if (lesson.status === "active" && lesson.retireProposedAt !== undefined && lesson.counters.harmful === 0) {
      await deps.store.mutate(key, lessonId, () => ({ retireProposedAt: undefined as unknown as number }));
      await emitAudit(deps.audit, { action: "lesson.proposal_withdrawn", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { tier: lesson.tier } });
    }
    return;
  }
}

/** Adds one harmful mark and runs the auto-retire rule: harmful at least 2 and more than helpful. Tier 0 retires at once; others go to a person. */
async function addHarmful(deps: CounterDeps, key: ScopeKey, lessonId: string, forceProposal: boolean): Promise<void> {
  const updated = await deps.store.mutate(key, lessonId, (l) => ({ counters: { ...l.counters, harmful: l.counters.harmful + 1 } }));
  if (updated === undefined) return;
  const failing = meetsRetireRule(updated);
  // A lesson live with no person behind it (tier 0, or on trial / stable) retires itself when its marks turn against it; the others go to a person.
  if (failing && (updated.tier === 0 || isTrialLesson(updated)) && updated.status === "active") {
    // The new version says the marks did it (`retiredByHarm`), so erasing a commenter whose mark it rested on can undo exactly this retirement (`reverseHarm`); a button's mark does not.
    await retireLesson(deps, key, lessonId, "harmful_counters", undefined, "lesson.auto_retired", { byHarm: !forceProposal });
    return;
  }
  if ((failing || forceProposal) && updated.status === "active" && updated.retireProposedAt === undefined) {
    await deps.store.mutate(key, lessonId, () => ({ retireProposedAt: deps.now() }));
    await emitAudit(deps.audit, { action: "lesson.retire_proposed", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { harmful: updated.counters.harmful, helpful: updated.counters.helpful } });
    try { await deps.alerts?.alert(key.workspaceId, key.project, "retire_proposed"); } catch { /* the proposal is stored */ }
  }
}

async function addHelpful(deps: CounterDeps, key: ScopeKey, lessonId: string, expiryDays: number | undefined): Promise<void> {
  const now = deps.now();
  const updated = await deps.store.mutate(key, lessonId, (l) => ({ counters: { ...l.counters, helpful: l.counters.helpful + 1 }, lastHelpfulAt: now }));
  if (updated !== undefined) await renewLesson(deps.store, key, lessonId, now, expiryDays, "helpful");
}

/**
 * Called when a task reaches a terminal state, and again if its outcome changes (a revert). For each lesson that was loaded for the task, corrections in
 * the lesson's scope are rated by the judge; a lesson that caused or contradicted a correction gets a harmful mark. A merged task with at most one
 * send-back and no such correction queues a helpful mark for when the 14-day revert window has passed.
 */
export async function recordTaskOutcome(deps: CounterDeps, outcome: TaskOutcome): Promise<{ harmful: string[]; queuedHelpful: string[]; /** Some correction went unjudged because this task's time for judging ran out. */ deferred?: true }> {
  const result: { harmful: string[]; queuedHelpful: string[]; deferred?: true } = { harmful: [], queuedHelpful: [] };
  if (outcome.evalRun === true) return result;
  const key: ScopeKey = { workspaceId: outcome.workspaceId, project: outcome.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  // While the install's lessons switch is off (or unreadable) `resolved.mode` is capped at Collect, which does not allow "load", so this returns before anything is judged or queued: no judge call, no spend, and no
  // helpful mark either (a mark without a judge that could have blamed the lesson would fail open). The judge's own model is gated as well (`judge-model.ts`), the second lock.
  if (!modeAllows(resolved.mode, "load")) {
    // A revert needs no model: while the switch is off it still takes back a helpful mark queued before (and remembers the revert, so a later "merged" delivery queues nothing), so a reverted task keeps no credit. Nothing is judged.
    if (resolved.switchedOff && outcome.outcome === "reverted") {
      for (const lessonId of reached(await deps.store.manifests(key, outcome.taskId))) {
        await deps.store.removePending(key, `helpful:${outcome.taskId}:${lessonId}`);
        await deps.store.markOnce(key, `reverted:${outcome.taskId}:${lessonId}`);
      }
    }
    return result;
  }

  const loaded = new Set<string>();
  for (const id of reached(await deps.store.manifests(key, outcome.taskId))) loaded.add(id);
  // Nothing loaded: nothing to count (and no model to ask). Otherwise the outcome is recorded only where outcomes can be rated now: a usable model on the company's own provider and room in the learning month.
  // Where they cannot, nothing is recorded, no helpful mark either (a mark given without a judge that could have blamed the lesson would fail open). Only a revert goes on, judging nothing: taking a queued
  // mark back is the safe direction and must not wait for a model.
  if (loaded.size === 0) return result;
  const canJudge = deps.judge.usable === undefined || await deps.judge.usable(key);
  // (`deferred`: nothing was counted, so the task is not counted for good and a later delivery, when a model is usable, counts it.)
  if (!canJudge && outcome.outcome !== "reverted") { result.deferred = true; return result; }
  // The lessons, in the order the judge's calls are spent: those a correction names a file of first (a comment on src/a.ts is about the lessons that reach src/a.ts), then the rest in an order that changes from task to
  // task, so the 20-call limit never favours the same lessons every time.
  const lessons: Lesson[] = [];
  for (const lessonId of loaded) { const lesson = await deps.store.get(key, lessonId); if (lesson !== undefined) lessons.push(lesson); }
  const named = (lesson: Lesson): boolean => (lesson.scope.paths ?? []).length > 0 && outcome.corrections.some((c) => c.paths.length > 0 && inScope(lesson, c));
  const shuffle = (lesson: Lesson): string => createHash("sha256").update(`${outcome.taskId}\u0000${lesson.id}`).digest("hex");
  lessons.sort((a, b) => Number(named(b)) - Number(named(a)) || shuffle(a).localeCompare(shuffle(b)));
  let judgeCalls = 0;
  for (const lesson of lessons) {
    const lessonId = lesson.id;
    const blamers = new Set<string>();
    let blamed = false;
    let unjudged = false;
    let ignored = false;
    for (const correction of outcome.corrections.filter((c) => inScope(lesson, c)).slice(0, MAX_CORRECTIONS_PER_LESSON)) {
      // Words chosen by code are counted, never rated.
      if (correction.fixed === true) { unjudged = true; continue; }
      if (!canJudge || judgeCalls >= MAX_JUDGE_CALLS_PER_TASK) { unjudged = true; continue; }
      // A correction is paid for at most once, whatever happens to the worker: its rating is on record once it came back (a delivery after a time cut reuses it), and the judge claims the correction right before the
      // paid call (a delivery after a worker died there finds it claimed and leaves the correction unjudged).
      const id = createHash("sha256").update(`${correction.kind}\u0000${correction.authorId ?? ""}\u0000${correction.text}`).digest("hex").slice(0, 16);
      const rated = (rating: CorrectionRating): string => `rated:${outcome.taskId}:${lessonId}:${id}:${rating}`;
      let rating: CorrectionRating | undefined;
      for (const known of RATINGS) if (rating === undefined && await deps.store.seenOnce(key, rated(known))) rating = known;
      if (rating === undefined) {
        if (deps.mayCall?.() === false) { unjudged = true; result.deferred = true; continue; }
        judgeCalls += 1;
        let refused = false;
        try {
          rating = await deps.judge.rate({ workspaceId: key.workspaceId, project: key.project, claim: async () => { const fresh = await deps.store.markOnce(key, `judged:${outcome.taskId}:${lessonId}:${id}`); refused = !fresh; return fresh; }, lesson, correctionKind: correction.kind, correctionText: cleanForLearning(correction.text, 1500) });
        } catch { rating = undefined; }
        // A claim that was refused (this correction was paid for before) made no call: it does not use one of the task's call slots.
        if (refused) judgeCalls -= 1;
        if (rating !== undefined) await deps.store.markOnce(key, rated(rating));
      }
      if (rating === undefined) { unjudged = true; continue; }
      if (rating === "caused" || rating === "contradicts") { blamed = true; if (correction.authorId !== undefined) blamers.add(correction.authorId); }
      if (rating === "same_ignored") { ignored = true; deps.metrics?.count("learning.loaded_but_ignored"); }
    }
    if (blamed) {
      // The task's record that this lesson was blamed: harm wins, so a later pass that rates the same task differently queues no helpful mark for it.
      await deps.store.markOnce(key, `harmful:${outcome.taskId}:${lessonId}`);
      // A person's thumbs and their corrections count ONCE per lesson, together (the same `feedback:` key serves both): a person who pressed Helpful on a lesson cannot also have a correction counted against it, and
      // one whose correction counted against it finds their later Helpful / Wrong here answered `repeat`. Both fail safe (the lesson is never marked twice by one person), and the Lessons tab says so (`MARKS_ONCE`).
      // A harmful mark is one PERSON's, once per lesson ever, under the same key as that person's Helpful / Wrong here / thumbs-down marks: a person who is rude to a lesson on ten tasks marks it once, and two
      // marks (the most a tier-0 or trial lesson needs to retire itself) are two different people. A correction with no known author blames nobody.
      let marked = false;
      for (const author of [...blamers].sort()) {
        const ref = await deps.store.markRef(key, author);
        if (ref === undefined) continue;
        if (!(await deps.store.markOnce(key, `feedback:${lessonId}:${ref}`))) continue;
        await deps.store.noteHarm(key, ref, lessonId);
        await addHarmful(deps, key, lessonId, false);
        marked = true;
      }
      if (marked) result.harmful.push(lessonId);
      await deps.store.removePending(key, `helpful:${outcome.taskId}:${lessonId}`);
      // A blamed revert is still a revert: record it so a later "merged" end for this task queues nothing.
      if (outcome.outcome === "reverted") await deps.store.markOnce(key, `reverted:${outcome.taskId}:${lessonId}`);
      continue;
    }
    if (outcome.outcome === "reverted") {
      await deps.store.removePending(key, `helpful:${outcome.taskId}:${lessonId}`);
      // Remember the revert: a "merged" end for this task delivered again later must not queue the mark it took back (checked below, next to the settled once-key).
      await deps.store.markOnce(key, `reverted:${outcome.taskId}:${lessonId}`);
      continue;
    }
    if (outcome.outcome === "merged" && outcome.sendBacks <= 1 && !unjudged && !ignored) {
      // A task end delivered again after its mark settled, or after that task's revert took the mark back, queues nothing (the settled and reverted once-keys are the record): a repeat extends nothing and counts nothing.
      // Nor does a lesson this task already blamed.
      if (await deps.store.seenOnce(key, `helpful-final:${outcome.taskId}:${lessonId}`) || await deps.store.seenOnce(key, `reverted:${outcome.taskId}:${lessonId}`) || await deps.store.seenOnce(key, `harmful:${outcome.taskId}:${lessonId}`)) continue;
      const dueAt = (outcome.mergedAt ?? deps.now()) + REVERT_WINDOW_MS;
      // The queued mark is the whole hold: the expiry sweep leaves a lesson with a queued mark alone, so a revert (which takes the mark back) ends the hold and the lesson then fades. No expiry is moved here.
      await deps.store.addPending({ key: `helpful:${outcome.taskId}:${lessonId}`, workspaceId: key.workspaceId, project: key.project, lessonId, taskId: outcome.taskId, dueAt });
      result.queuedHelpful.push(lessonId);
    }
  }
  return result;
}

/** Applies the helpful marks whose revert window has passed without a revert. Idempotent; bounded to `limit` per run. */
export async function settleHelpful(deps: CounterDeps, key: ScopeKey, limit = 200): Promise<number> {
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  let applied = 0;
  for (const entry of await deps.store.duePending(key, deps.now(), limit)) {
    if (await deps.store.markOnce(key, `helpful-final:${entry.taskId}:${entry.lessonId}`)) { await addHelpful(deps, key, entry.lessonId, resolved.expiryDays); applied += 1; }
    await deps.store.removePending(key, entry.key);
  }
  return applied;
}

export type FeedbackFailure = "not_loaded" | "not_found" | "repeat" | "not_permitted";
/** The task page's "Helpful" and "Wrong here". A person can mark a lesson only for a task it was loaded into, once per person. */
export async function recordFeedback(deps: CounterDeps & { access: AccessCheckPort; log?: LessonLog }, input: { workspaceId: string; project: string; taskId: string; lessonId: string; userId: string; /** What the person is in the sources (their linked ids), for the access check. */ viewer: IdentitySet; kind: "helpful" | "wrong_here" | "thumbs_down"; /** A thumbs-down counts only from a member of the project (the route checked their role). */ projectMember?: boolean }): Promise<{ ok: true } | { ok: false; code: FeedbackFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const manifests = await deps.store.manifests(key, input.taskId);
  if (!reached(manifests).has(input.lessonId)) return { ok: false, code: "not_loaded" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  // Only a person who can read the lesson now can mark it (frozen snapshot AND the access records); an unreadable record is a no. So the two "wrong here" marks that auto-retire a lesson
  // always come from people with access.
  const permitted = await readVisible({ access: deps.access, key, viewer: input.viewer, lessons: [lesson], where: "feedback", log: deps.log }).then((list) => list.length === 1, () => false);
  if (!permitted) return { ok: false, code: "not_permitted" };
  if (input.kind === "thumbs_down") return thumbsDown(deps, key, lesson, input);
  // One mark per person per lesson (either kind, any task), made under a random reference that erasure deletes: a person cannot retire a lesson alone by marking it on several tasks, and the
  // stored key names nobody once they are erased.
  const ref = await deps.store.markRef(key, input.userId);
  if (ref === undefined) return { ok: false, code: "not_permitted" };
  if (!(await deps.store.markOnce(key, `feedback:${input.lessonId}:${ref}`))) return { ok: false, code: "repeat" };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (input.kind === "helpful") await addHelpful(deps, key, input.lessonId, resolved.expiryDays);
  else await addHarmful(deps, key, input.lessonId, true);
  await emitAudit(deps.audit, { action: input.kind === "helpful" ? "lesson.helpful" : "lesson.wrong_here", workspaceId: key.workspaceId, project: key.project, lessonId: input.lessonId, actor: input.userId, facts: { task: input.taskId } });
  return { ok: true };
}

/**
 * The one-tap thumbs-down, from the pull request's "Lessons used" link or the task page. A project member's thumbs-down RETIRES a lesson that is live on trial or stable at once,
 * audited (`lesson.trial_retired`, with the person): such a lesson has no person behind it, so one person's "no" is enough. On any other lesson it is a "wrong here" mark that asks a person to decide,
 * counted under the SAME once-key as Helpful and Wrong here (one mark of any kind per person per lesson), so one person cannot retire an approved lesson alone by marking it twice.
 */
async function thumbsDown(deps: CounterDeps, key: ScopeKey, lesson: Lesson, input: { taskId: string; lessonId: string; userId: string; projectMember?: boolean }): Promise<{ ok: true } | { ok: false; code: FeedbackFailure }> {
  if (input.projectMember !== true) return { ok: false, code: "not_permitted" };
  const ref = await deps.store.markRef(key, input.userId);
  if (ref === undefined) return { ok: false, code: "not_permitted" };
  if (isTrialLesson(lesson)) {
    if (!(await deps.store.markOnce(key, `thumbs:${input.lessonId}:${ref}`))) return { ok: false, code: "repeat" };
    if (lesson.status === "active") await retireLesson(deps, key, lesson.id, "thumbs_down", input.userId, "lesson.trial_retired");
    return { ok: true };
  }
  if (!(await deps.store.markOnce(key, `feedback:${input.lessonId}:${ref}`))) return { ok: false, code: "repeat" };
  await addHarmful(deps, key, lesson.id, true);
  await emitAudit(deps.audit, { action: "lesson.wrong_here", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.userId, facts: { task: input.taskId } });
  return { ok: true };
}

/**
 * Applies the worker's load report for one stage: validated lessons are renewed (facts) and stamped, moved citations are corrected as a new lesson
 * version, stale ones count toward the stale limit (3 in 14 days makes the lesson `stale`), and lessons whose check did not finish are left alone.
 * Only lessons named in the stage's manifest are touched, whatever the report says.
 */
export async function applyLoadReport(deps: CounterDeps, input: { workspaceId: string; project: string; taskId: string; stage: LoadManifest["stage"]; round: number; report: LoadReport }): Promise<void> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const manifest = (await deps.store.manifests(key, input.taskId)).find((m) => m.stage === input.stage && m.round === input.round);
  if (manifest === undefined || input.report.stage !== input.stage) return;
  // A replay copy's load (a frozen snapshot) never touches the live lessons: no loaded count, no renewal, no moved citation, no stale mark.
  if (manifest.memory === "snapshot") return;
  if (!(await deps.store.markOnce(key, `report:${input.taskId}:${input.stage}:${input.round}`))) return;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  const now = deps.now();
  const entries = new Map(manifest.lessons.map((e) => [e.id, e] as const));
  for (const reported of input.report.lessons) {
    const entry = entries.get(reported.id);
    if (entry === undefined || entry.version !== reported.version) continue;
    entry.citation = reported.citation;
    if (reported.citation === "valid" || reported.citation === "none" || reported.citation === "moved") {
      if (await deps.store.markOnce(key, `loaded:${input.taskId}:${reported.id}`)) {
        const counted = await deps.store.mutate(key, reported.id, (l) => ({ counters: { ...l.counters, loaded: l.counters.loaded + 1 } }));
        // A trial lesson that has now earned stable (14 days, 3 loads, no thumbs-down) becomes stable.
        if (counted?.trial?.state === "trial") await promoteIfStable(deps, key, reported.id);
      }
      if (reported.citation === "moved" && reported.corrected !== undefined) await patchMovedCitations(deps, key, reported.id, reported.corrected);
      await renewLesson(deps.store, key, reported.id, now, resolved.expiryDays, "validated");
    } else if (reported.citation === "stale_dropped") {
      const updated = await deps.store.mutate(key, reported.id, (l) => ({
        counters: { ...l.counters, citationStale: l.counters.citationStale + 1 }, staleAt: [...l.staleAt.filter((t) => now - t < STALE_WINDOW_MS), now].slice(-20),
      }));
      if (updated !== undefined && updated.status === "active" && updated.staleAt.length >= STALE_LIMIT) await markStale(deps, key, updated);
    }
  }
  await deps.store.updateManifest(manifest);
}

async function patchMovedCitations(deps: CounterDeps, key: ScopeKey, id: string, corrected: ReadonlyArray<{ index: number; startLine: number; endLine: number }>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lesson = await deps.store.get(key, id);
    if (lesson === undefined) return;
    const citations = lesson.citations.map((c, index) => {
      const fix = corrected.find((x) => x.index === index);
      return fix !== undefined && c.kind === "code" ? { ...c, startLine: fix.startLine, endLine: fix.endLine } : c;
    });
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...lesson, citations, version: nextVersion(lesson, await deps.store.versions(key, id)), updatedAt: deps.now() }], deps.now());
    if (result.ok) {
      await emitAudit(deps.audit, { action: "lesson.citation_moved", workspaceId: key.workspaceId, project: key.project, lessonId: id, facts: { citations: corrected.length, tier: lesson.tier } });
      return;
    }
  }
}

async function markStale(deps: CounterDeps, key: ScopeKey, lesson: Lesson): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined || fresh.status !== "active") return;
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, status: "stale", version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), updatedAt: deps.now() }], deps.now());
    if (result.ok) { await emitAudit(deps.audit, { action: "lesson.stale", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { stale: fresh.staleAt.length } }); return; }
  }
}
