// The REPO-ONLY reflection.
//
// Every task starts from an input the repository cannot see (a Slack message, a tracker issue, text typed in Rovara), so marks ~0% of the ordinary reflection's lessons as fit for a repository's file. This is the second
// reflection that fixes that: when a Rovara task's pull request merges, ONE more reflection runs over what the repository itself says about that change request, and nothing else. Its prompt holds:
//   - the repository's review comments and review threads on that pull request (the captured rows the first reflection already read: a member's own words, `ownText`, written in the repository),
//   - the human fix-up edits on that pull request (`human_edit`, handed over in memory by the code-host tap; never stored),
//   - the merge fact (the outcome word and the merge revision),
//   Nothing Rovara wrote is in it: not the description (Rovara writes it from the plan, the names of the requester and approver and the task link) and not the title (it comes from the Slack request).
// It holds no Slack, no tracker, no session message, no task description, no plan, no finding, no loaded lesson, no other repository. Its subject sets `repoInputs` ({place, repository, linkPrefix}) for exactly that repository, so
// 's `repoVisibilityOf` marks every draft `repoOnly` BY CONSTRUCTION; the drafts then go through the normal curate, trial and eligibility rules (stable or person-approved before a weekly pull request).
//
// Provider neutrality: this file knows no code host. A `RepoChangeRequest` is the code-host-neutral description of one change request (place, repository, link and link prefix, revision, title, description,
// comments, edits) that the code host's ADAPTER produces (`local/app/lessons-sources.ts` from the code host's view); nothing here builds a URL or parses one.
//
// Money and gates (the first reflection's rules, not new ones):
//   - Off and Collect make no call and read nothing (`modeAllows`); the model itself is behind the lessons switch (`gatedByLessonsSwitch`), so a caller that skipped the mode check still cannot spend.
//   - The customer's own model path, through `reflectSubject`: quote, spend look, hold, key; a refusal records its pause, a failed call counts once per task (`TaskFailureTally`).
//   - Public's per-task cap is ONE total with the task's other learning calls: the call is given only what the task has left (`capsOverride`), and its hold is added to the same tally (`taskBudget`).
//   - One call per merged change request and kind: a once-key per kind, task, repository place and change request head is checked before and taken when the call is made. The worker's lease (`callStartedAt`) is the other lock:
//     a delivery after the call started is never run again. The once-key is taken atomically right before the provider is called (so two runs at once make one call, and a quote that fails takes nothing).
//   - The repository is proved BEFORE anything is paid: 's `repoVisibilityOf` is run over the prompt's spans first; a change request that could not be repo-only makes no call. The proof is the project's registered
//     repository address, matched to the code host's own identity by the adapter, never the project's name.
//   - Two reflections, no hand-over: the task end ALWAYS runs the comments reflection (kind "comments", once-key `repo-reflect:comments:<task>:<place>:<head>`); the human-edit job, when it really has human edits, runs a separate edits
//     reflection (kind "edits": the edits, with the same comments for context; once-key `repo-reflect:edits:...`). Curate's twin and merge rules dedupe any overlap. One extra call only on a pull request with real human edits.
//   - Public's cap is one total per task across both, in any order: each call reserves its hold on the task's shared ladder right before the provider is called (`reserveTaskHeld`).
//   - Only a change request with at least one repository-visible correction is reflected (a member's review comment that reads as a correction, or a human edit); otherwise no call.
import { currentLearningAttempt } from "./learning-deadline.js";
import { looksLikeCorrection } from "./correction-filter.js";
import { processDraftRetrying } from "./draft-retry.js";
import { gatedByLessonsSwitch } from "./model-gate.js";
import { LearningRefusal, failuresCountedOncePerTask, withFailuresCountedOnce, type LessonsPauseStore, type TaskFailureTally } from "./pause.js";
import { learningCaps, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ProcessDeps } from "./process.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { PipelineModel } from "./ports.js";
import { buildReflectorInput, type EvidenceSpan, type ReflectSubject } from "./reflect-input.js";
import { repoVisibilityOf } from "./repo-eligibility.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Audience } from "./types.js";

/**
 * One merged change request of a repository, described without naming a code host. The code host's adapter produces it from the host's own facts; the repository's words in it were already proved by the capture lane
 * (a member's own text, standing and erasure read now, the place and audience of the row they came from).
 */
export interface RepoChangeRequest {
  /** The record's name of the repository (`<source>:repo/<id>`), as the comment rows (or the edits) name it. Absent until a comment row or an edit names it. */
  place?: string | undefined;
  /** The project's name for the repository (the name in the project definition and in the prompt header). */
  repository: string;
  /** The project's REGISTERED repository address, which the adapter matched to the code host's own identity of the change request's repository: the proof judges the link prefix against, without case. */
  repositoryUrl: string;
  /** The change request's permalink. */
  link: string;
  /** The start of every change request link of that repository: the header's links must all begin with it ('s `repoInputs.linkPrefix`). */
  linkPrefix: string;
  /** The change request's head revision at the merge: the once-key's "head", so a new head is a new reflection. */
  revision: string;
  /** The merge revision on the default branch, when the host said it. */
  mergeRevision?: string | undefined;
  merged: boolean;
  /** Who may read the change request: the repository's readers. Absent until a comment row or an edit says it. */
  audience?: Audience | undefined;
  /** The repository's review comments and review threads on it (`pr_comment` spans, member text, scope = `place`). */
  comments: readonly EvidenceSpan[];
  /** The human fix-up edits on it (`human_edit` spans, scope = `place`). Handed over in memory by the human-edit job; never stored. */
  edits: readonly EvidenceSpan[];
}

/** A change request with its place and readers named: what a subject can be built from. */
export type PlacedChangeRequest = RepoChangeRequest & { place: string; audience: Audience };
const isPlaced = (change: RepoChangeRequest): change is PlacedChangeRequest => change.place !== undefined && change.audience !== undefined;

/** The change request completed with the place and readers an edit names (the human-edit job's), and the edits. A change request that already has a different place is another repository's: undefined. Pure. */
export function withEdits(change: RepoChangeRequest, edit: { place: string; audience: Audience; spans: readonly EvidenceSpan[] }): PlacedChangeRequest | undefined {
  if (change.place !== undefined && change.place !== edit.place) return undefined;
  return { ...change, place: edit.place, audience: change.audience ?? edit.audience, edits: [...change.edits, ...edit.spans] };
}

/** At most this many change requests of one task are reflected on. */
export const MAX_REPO_CHANGES = 5;
/** Less room than this in the task's budget is none. */
const MIN_ROOM_USD = 0.001;

/** Whether a span is a person's own correction in the repository: a member with a known id, words that are theirs (not chosen by code). */
const isMemberWords = (span: EvidenceSpan): boolean => span.trust === "member" && span.fixedText !== true && (span.authorId !== undefined || (span.authorIds?.length ?? 0) > 0);

/** The two reflections of a change request: of its review comments (the task end's), and of its human edits with the comments for context (the human-edit job's). */
export type RepoReflectKind = "comments" | "edits";

/** Whether the change request has a repository-visible correction of that kind: a merged change request with a member's review comment that reads as a correction (comments), or a human edit by a member (edits). Pure. */
export function hasRepoCorrection(change: RepoChangeRequest, kind: RepoReflectKind = "comments"): boolean {
  if (!change.merged) return false;
  return kind === "comments"
    ? change.comments.some((span) => span.kind === "pr_comment" && isMemberWords(span) && looksLikeCorrection(span.text))
    : change.edits.some((span) => span.kind === "human_edit" && isMemberWords(span));
}

/** The once-key of one reflection: its kind, the task, the repository and the change request's head. */
export const repoReflectKey = (taskId: string, change: Pick<RepoChangeRequest, "place" | "revision">, kind: RepoReflectKind = "comments"): string => `repo-reflect:${kind}:${taskId}:${change.place}:${change.revision}`;

/**
 * The subject of the repo-only reflection. It takes from the finished task only who started and steered it (their trust gates the reflection as for the first one, so a task an outsider started or steered teaches nothing
 * here either) and the outcome; nothing of its text. Every span is the repository's. The comments reflection holds the comments; the edits reflection holds the edits and the comments for context, and its lesson must stand on an edit. Pure.
 */
export function repoOnlySubjectOf(main: ReflectSubject, change: PlacedChangeRequest, kind: RepoReflectKind = "comments"): ReflectSubject {
  return {
    kind: "task", id: main.id, workspaceId: main.workspaceId, project: main.project, repositories: [change.repository], outcome: "merged",
    ...(change.mergeRevision === undefined ? {} : { mergedCommit: change.mergeRevision }),
    ...(main.initiatorId === undefined ? {} : { initiatorId: main.initiatorId }),
    ...(main.initiatorTrust === undefined ? {} : { initiatorTrust: main.initiatorTrust }),
    ...(main.steeringTrust === undefined ? {} : { steeringTrust: main.steeringTrust }),
    ...(main.intentTrust === undefined ? {} : { intentTrust: main.intentTrust }),
    links: [change.link], audience: change.audience, scopes: [change.place],
    repoInputs: { place: change.place, repository: change.repository, linkPrefix: change.linkPrefix, repositoryUrl: change.repositoryUrl },
    promptStyle: "repo_only", requireEvidenceKind: kind === "comments" ? ["pr_comment"] : ["human_edit"],
    ...(main.evalRun === true ? { evalRun: true } : {}),
    spans: kind === "comments" ? [...change.comments] : [...change.comments, ...change.edits],
  };
}

/** What the repo-only reflection needs of the task's learning dependencies (a structural subset of `TaskLearningDeps`). */
export interface RepoReflectDeps {
  reflect: ReflectDeps;
  process: ProcessDeps;
  settings: LearningSettingsReader;
  log?: ((event: string, fields: Record<string, string | number>) => void) | undefined;
}

/**
 * A pause store that does not record "cost_too_high" (the task simply has no room left, which is not a reason to pause the project: the outcome judge's rule) or "no_provider" (this path's own refusals, a switch turned off
 * mid-run or a lost once-key, are not a missing provider; the task's first reflection records a real one).
 */
function withoutOwnRefusals(pause: LessonsPauseStore | undefined): LessonsPauseStore | undefined {
  return pause === undefined ? undefined : { ...pause, record: async (workspaceId, project, code) => { if (code !== "cost_too_high" && code !== "no_provider") await pause.record(workspaceId, project, code); } };
}

/**
 * Public's per-task cap is one total for the task, across the task-end run and the human-edit job, in any order. What the task has held is a ladder of once-keys, one per whole cent (rounded up):
 * `task-held:<task>:<n>`. No store method is added. A read counts the steps from 1 until one is missing. A call RESERVES its hold by taking the next free steps one at a time (`markOnce` is atomic, so two runs at once never
 * take the same step), and fails when the cap's steps are used up. Runs whose holds are not reserved call by call (the first reflection, the judges) top the ladder up to their tally when they end (`noteTaskHeld`). The total only
 * grows, and holds only task ids (nothing about a person). Enterprise has no cap and neither reads nor writes it.
 */
const HELD_STEP_USD = 0.01;
const HELD_MAX_STEPS = 100;
const heldName = (taskId: string, step: number): string => `task-held:${taskId}:${String(step)}`;
const stepsOf = (usd: number): number => Math.max(0, Math.ceil(usd / HELD_STEP_USD - 1e-9));
const maxStepsOf = (capUsd: number | undefined): number => (capUsd === undefined ? HELD_MAX_STEPS : Math.max(1, stepsOf(capUsd)));
export async function readTaskHeld(store: Pick<LessonStore, "seenOnce">, key: ScopeKey, taskId: string, capUsd?: number): Promise<number> {
  let steps = 0;
  const max = maxStepsOf(capUsd);
  while (steps < max && await store.seenOnce(key, heldName(taskId, steps + 1))) steps += 1;
  return Math.round(steps * HELD_STEP_USD * 100) / 100;
}
/** Tops the ladder up to at least `usd`. */
export async function noteTaskHeld(store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, usd: number, capUsd?: number): Promise<void> {
  const wanted = Math.min(maxStepsOf(capUsd), stepsOf(usd));
  for (let step = stepsOf(await readTaskHeld(store, key, taskId, capUsd)) + 1; step <= wanted; step += 1) await store.markOnce(key, heldName(taskId, step));
}
/** Reserves `usd` of the task's cap: takes that many free steps. False when the cap's steps run out first (the steps taken stay taken: a refusal is conservative). */
export async function reserveTaskHeld(store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, usd: number, capUsd: number): Promise<boolean> {
  const need = stepsOf(usd);
  const max = maxStepsOf(capUsd);
  let taken = 0;
  for (let step = stepsOf(await readTaskHeld(store, key, taskId, capUsd)) + 1; step <= max && taken < need; step += 1) if (await store.markOnce(key, heldName(taskId, step))) taken += 1;
  return taken >= need;
}

/** Puts the task's shared cap ledger on its tally (idempotent): every paid call of the task that has the tally reserves its hold on the ladder before it is made. */
export function attachCapLadder(tally: TaskFailureTally, store: Pick<LessonStore, "seenOnce" | "markOnce">, key: ScopeKey, taskId: string, capUsd: number): void {
  tally.reserve ??= (usd) => reserveTaskHeld(store, key, taskId, usd, capUsd);
}

/** Which reflection to run: the comments one (the task end's, the default) or the edits one (the human-edit job's). */
export interface RepoReflectOptions { kind?: RepoReflectKind }

export interface RepoReflectResult { calls: number; drafts: number }

/**
 * Runs the repo-only reflection for each merged change request of a finished task that has a repository-visible correction. Sequential, one model call per change request, never throws into the caller's work: a fault is one
 * fixed log line. `tally` is the task's: the hold goes on it, so Public's per-task cap is one total with the first reflection and the outcome judge.
 */
export async function reflectRepoOnly(deps: RepoReflectDeps, main: ReflectSubject, changes: readonly RepoChangeRequest[], tally: TaskFailureTally, options: RepoReflectOptions = {}): Promise<RepoReflectResult> {
  const result: RepoReflectResult = { calls: 0, drafts: 0 };
  if (main.outcome !== "merged" || main.evalRun === true) return result;
  const kind = options.kind ?? "comments";
  const wanted = changes.filter((change) => hasRepoCorrection(change, kind)).slice(0, MAX_REPO_CHANGES);
  if (wanted.length === 0) return result;
  const store = deps.process.store;
  const cap = learningCaps(deps.reflect.edition, deps.reflect.capsOverride).perTaskUsd;
  try {
    // The switch first: Off, Collect and a lessons switch that is off or unreadable read nothing and call nothing.
    if (!modeAllows((await resolveLearning(deps.settings, main.workspaceId, main.project)).mode, "reflect")) return result;
    const key = { workspaceId: main.workspaceId, project: main.project };
    const pause = withoutOwnRefusals(failuresCountedOncePerTask(deps.reflect.pause, tally));
    // The task's cap is one total across its runs; start from what they held, and reserve every call on the shared ladder before it is made.
    if (cap !== undefined) attachCapLadder(tally, store, key, main.id, cap);
    if (cap !== undefined) tally.heldUsd = Math.max(tally.heldUsd, await readTaskHeld(store, key, main.id, cap));
    for (const change of wanted) {
      const attempt = currentLearningAttempt();
      if (attempt?.signal?.aborted === true) break;
      if (!isPlaced(change)) continue;
      const once = repoReflectKey(main.id, change, kind);
      if (await store.seenOnce(key, once)) continue;
      // The repository is proved BEFORE anything is paid: a change request whose prompt could not be repo-only makes no call.
      const subject = repoOnlySubjectOf(main, change, kind);
      const built = buildReflectorInput(subject);
      if (!built.eligible) continue;
      const visibility = repoVisibilityOf(subject, built.spans.values());
      if (visibility.repoOnly === undefined) { deps.log?.("learning.repo_reflect_not_repo_only", { codes: visibility.blocked.join(",") }); continue; }
      // Public's per-task cap is one total: this call is given what the task has left.
      const room = cap === undefined ? undefined : Math.round((cap - tally.heldUsd) * 1e6) / 1e6;
      if (room !== undefined && room < MIN_ROOM_USD) { deps.log?.("learning.repo_reflect_no_room", {}); break; }
      // Right before the provider is called the hold is reserved on the task's ladder (by `reflectSubject`, through the tally) and then the once-key is taken (atomically: of two runs at once only one gets it). A quote that fails, a refusal or a lost key spends nothing (a lost key leaves its reserved cents on the ladder: conservative).
      let called = false;
      const claiming: PipelineModel = { ...deps.reflect.model, complete: async (request) => {
        if (!(await store.markOnce(key, once))) throw new LearningRefusal("no_provider", "this change request was already reflected on");
        called = true;
        return deps.reflect.model.complete(request);
      } };
      // The lessons switch is checked first (a refusal there takes no key), then the key and the hold, then the provider.
      const model = gatedByLessonsSwitch(claiming);
      const heldBefore = tally.heldUsd;
      const reflected = await reflectSubject({
        ...deps.reflect, model, ...(pause === undefined ? {} : { pause }), taskBudget: tally,
        ...(room === undefined ? {} : { capsOverride: { ...deps.reflect.capsOverride, perTaskUsd: room } }),
      }, subject);
      if (called) result.calls += 1; else tally.heldUsd = heldBefore;
      if (reflected.status !== "ok") continue;
      const processDeps = { ...withFailuresCountedOnce(deps.process, tally), taskBudget: tally };
      for (const draft of reflected.drafts) {
        if (currentLearningAttempt()?.signal?.aborted === true) { deps.log?.("learning.drafts_cut_at_deadline", {}); break; }
        try {
          await processDraftRetrying(processDeps, key, draft, { ...(deps.log === undefined ? {} : { log: deps.log }) });
          result.drafts += 1;
        } catch { deps.log?.("learning.repo_reflect_draft_failed", {}); }
      }
    }
    if (cap !== undefined) await noteTaskHeld(store, key, main.id, tally.heldUsd, cap);
  } catch {
    deps.log?.("learning.repo_reflect_failed", {});
  }
  return result;
}
