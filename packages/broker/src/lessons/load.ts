// The loader. At a stage's dispatch it picks the lessons that apply and returns the `learnedContext` payload for the worker
// and the manifest that records what was chosen. It never blocks a task: any failure loads nothing. The task flow's dispatch asks for it through `TaskFlowDeps.learned`.
import {
  LEARNED_CONTEXT_FEATURE, LEARNED_CONTEXT_MAX_BYTES, LEARNED_CONTEXT_MAX_LESSONS, cleanLessonText, type CodeCitation, type LearnedContext, type LearnedLesson, type LessonStage,
} from "@agentx/contracts";
import { globToRegExp } from "./guards.js";
import { safeScopeLabel } from "./render.js";
import { approversRequired, modeAllows, resolveLearning, resolveLoadBudget, type ApprovalPolicy, type LearningSettingsReader, type LoadBudget, type ResolvedLearning } from "./policy.js";
import { hasStaleCitation, isTrialLesson } from "./trial.js";
import type { LessonDeps, LessonEmbedder, LessonVectors } from "./ports.js";
import { EMBED_TIMEOUT_MS, EMBED_WARM_MS, docOfText, rankLessons } from "./similarity.js";
import type { LessonStore, LoadManifest, LoadManifestEntry, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "./access-port.js";
import { createLessonLiveReader, lessonTaskRefs, type LessonLiveReader } from "./live-visibility.js";
import { readVisible, readVisibleRanked } from "./read-visible.js";
import { memberView, type MemberOf, type MemberResolver } from "./members.js";
import { normId, type IdentitySet, type Lesson } from "./types.js";

export const LOAD_MAX_LESSONS = LEARNED_CONTEXT_MAX_LESSONS;
export const LOAD_MAX_BYTES = LEARNED_CONTEXT_MAX_BYTES;
const DAY = 86_400_000;
/** The reviewer's list of what earlier stages loaded is kept short (about 1 KB of titles), so it cannot crowd the lessons budget. */
const PRIOR_LOADED_MAX = 12;
/** The ranked candidates are checked against the access records and the source tasks' live visibility this many at a time, until enough survive. */
const CHECK_PAGE = 3 * LOAD_MAX_LESSONS;
/** The whole visibility work of one load must end inside the dispatcher's 2.5 s deadline (`lessons-dispatch.ts`): what is not checked by then is not offered, and each batched task read is cut at the same time. */
export const LOAD_VISIBILITY_BUDGET_MS = 1_800;

/** Who reads what a stage produces. Only "shared": the reader is the running task's audience, read live, never one named person (a "private" reader would let a lesson only some people may read reach an agent several people can see). */
export type TaskAudience = { kind: "shared" };
export interface LoadRequest {
  workspaceId: string; project: string; taskId: string; stage: LessonStage | "CHECKS"; round: number;
  /** The task's intent and, from PLAN on, the plan summary: both are text the project already holds. */
  intent: string; planSummary?: string;
  repos: readonly string[]; files: readonly string[]; languages: readonly string[];
  taskAudience: TaskAudience;
  /** Asked just before the load record is written: false when the dispatch stopped waiting (its deadline passed), so a load nobody received is never recorded as used. */
  wanted?: () => boolean;
  /** Only an eval-batch dispatch may ask for `off`; the broker route refuses it from production (task). */
  memory?: { mode: "off" | "live" } | { mode: "snapshot"; snapshotId: string; /** EXACTLY these lessons (the snapshot's, at its versions): the live set is never read. The caller (a replay copy's dispatch) resolved them. */ lessons: readonly Lesson[] };
}
export type LoadSkip = "mode" | "stage" | "memory_off" | "index_unreachable" | "no_lessons" | "access_unavailable" | "members_unavailable" | "abandoned";
export interface LoadResult { context?: LearnedContext; manifest: LoadManifest; skipped?: LoadSkip }

export interface LoadDeps extends LessonDeps {
  store: LessonStore; settings: LearningSettingsReader;
  /** The small open embedder, where the install has one. Absent: lessons are ranked against the task by code-aware keywords and cited paths alone. */
  embedder?: LessonEmbedder | undefined;
  /** Where the lessons' vectors are kept (read only here: the loader embeds the task, never a lesson). */
  vectors: LessonVectors;
  /**
   * The record core's access check. Each lesson's source places are checked against the access records at load time (not only against the snapshot the lesson froze), so a person
   * removed from a channel stops getting its lessons. REQUIRED: a caller that cannot supply it gets no lessons (fail closed, with a log line), never the frozen snapshot alone.
   */
  access: AccessCheckPort;
  /**
   * Follows a merged developer to the member they became. The people a tier needs are counted as members, so two approvals given by two accounts that were merged into one person count once. Absent:
   * ids are counted as they are. A lookup that fails loads nothing (fail closed).
   */
  resolveMember?: MemberResolver;
  log?: (event: string, fields: Record<string, unknown>) => void;
}


interface ScopeMatch { matches: boolean; byPath: boolean }
export function scopeMatch(lesson: Lesson, request: Pick<LoadRequest, "repos" | "files" | "languages">): ScopeMatch {
  const { repos, paths, languages } = lesson.scope;
  if (repos !== undefined && repos.length > 0 && !repos.some((r) => request.repos.includes(r))) return { matches: false, byPath: false };
  if (languages !== undefined && languages.length > 0 && request.languages.length > 0 && !languages.some((l) => request.languages.includes(l))) return { matches: false, byPath: false };
  if (paths !== undefined && paths.length > 0 && request.files.length > 0) {
    const expressions = paths.map(globToRegExp);
    const hit = request.files.some((file) => expressions.some((re) => re.test(file)));
    return { matches: hit, byPath: hit };
  }
  return { matches: true, byPath: false };
}

/** The lower bound of the Wilson interval for helpful of loaded (95%). Zero when a lesson has never been loaded. */
export function wilsonLower(helpful: number, loaded: number): number {
  if (loaded <= 0) return 0;
  const n = loaded;
  const p = Math.min(1, Math.max(0, helpful / n));
  const z = 1.96;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n));
}

/**
 * Only approved lessons are used (the pilot rule): an active lesson loads only while the approvals it carries still meet what the project's policy asks of its tier NOW, counting people only.
 * Tier 2 always needs two people (or the audited sole-owner exception); tier 1 needs what `approval.tier1` says; tier 0 needs what `approval.tier0` says, which is one person unless a project
 * has turned automatic go-live on (and `resolveLearning` reads "auto" as "one" while that is off). A lesson sent back to a person (`reviewRequired`) needs at least one person whatever its tier.
 * This is a second line behind the status: an old row, a hand edit or a bug that left a lesson `active` without its approvals does not reach an agent.
 */
export function approvedForUse(lesson: Lesson, policy: ApprovalPolicy, member: MemberOf = normId, trialAllowed = false): boolean {
  // A lesson live on trial or stable needs no person, but only while every setting in force allows that (`ResolvedLearning.trialAllowed`: Standard, mode On, no company approval floor, no
  // required group, no two-person requirement) and the lesson is not tier 2. A stricter setting stops them at once (default: stopped).
  if (isTrialLesson(lesson)) return trialAllowed && lesson.tier < 2;
  const people = new Set(lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => member(a.by))).size;
  if (lesson.tier === 2) return isTierTwoApproved(lesson, member);
  const needed = Math.max(approversRequired(lesson.tier, policy), lesson.reviewRequired === true ? 1 : 0);
  return people >= needed;
}

/** A code citation the broker's own check found stale keeps its lesson out; the worker checks again at the base commit. */
export { hasStaleCitation };

/**
 * A tier-2 lesson loads after two different people approved it. The audited sole-owner exception stands in for the second person EXCEPT for a lesson that asks for a capability change (more tools,
 * domains, budget or approvals): that text reaches the agent only after two people, always.
 */
const isTierTwoApproved = (lesson: Lesson, member: MemberOf = normId): boolean => lesson.tier === 2 && (new Set(lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => member(a.by))).size >= 2
  || (!lesson.tierReasons.includes("capability_request") && lesson.approvals.some((a) => a.mode === "sole_owner_exception")));

/** Which lesson types a stage may load. Reviewer stages get only tier-2-approved review checks. */
export function stageAllows(lesson: Lesson, stage: LessonStage, member: MemberOf = normId): boolean {
  if (!lesson.stages.includes(stage)) return false;
  switch (stage) {
    case "UNDERSTAND": case "PLAN": return lesson.type !== "review_check";
    case "IMPLEMENT": return lesson.type === "convention" || lesson.type === "pitfall" || (lesson.type === "fact" && lesson.citations.some((c) => c.kind === "code"));
    case "PLAN_CRITIQUE": case "REVIEW": return lesson.type === "review_check" && isTierTwoApproved(lesson, member);
  }
}

const scopeLabel = (lesson: Lesson): string => safeScopeLabel(lesson.scope);

export function toLearned(lesson: Lesson): LearnedLesson {
  return {
    id: lesson.id, version: lesson.version, type: lesson.type, title: lesson.title, description: lesson.description, body: lesson.body, scopeLabel: scopeLabel(lesson),
    citations: lesson.citations.filter((c): c is CodeCitation => c.kind === "code"),
  };
}
const sizeOf = (lesson: LearnedLesson): number => Buffer.byteLength(JSON.stringify(lesson), "utf8");

/**
 * two lessons kept apart as twins say the same advice, so a task is given only one of them. A pair is a twin pair ONLY when one lesson lists the other in `repoTwins`
 * (never by `possibleDuplicateOf` alone: a person's "keep both" on an ordinary duplicate loads both). Of a pair the repo-only one is preferred when exactly one is, otherwise the one ranked higher (the list is in rank order).
 * Returns, for each non-preferred twin, the lesson that is preferred over it (both present in `ranked`). Pure.
 */
export function twinPreference(ranked: readonly Lesson[]): Map<string, string> {
  const position = new Map(ranked.map((lesson, index) => [lesson.id, index] as const));
  const byId = new Map(ranked.map((lesson) => [lesson.id, lesson] as const));
  const preferred = new Map<string, string>();
  for (const lesson of ranked) {
    for (const twinId of lesson.repoTwins ?? []) {
      const twin = byId.get(twinId);
      if (twin === undefined || twin.id === lesson.id) continue;
      const lessonOnly = lesson.provenance.repoOnly !== undefined;
      const twinOnly = twin.provenance.repoOnly !== undefined;
      const lessonWins = lessonOnly !== twinOnly ? lessonOnly : position.get(lesson.id)! < position.get(twin.id)!;
      const [winner, loser] = lessonWins ? [lesson, twin] : [twin, lesson];
      if (!preferred.has(loser.id)) preferred.set(loser.id, winner.id);
    }
  }
  return preferred;
}

/** The lessons with each twin pair reduced to its preferred lesson; `fits` says whether a lesson can still be chosen (the byte budget): if the preferred twin does not fit the other is tried, so a pair never loses both. */
export function chooseWithTwins(ranked: readonly Lesson[], fits: (lesson: Lesson) => boolean): Lesson[] {
  const preferred = twinPreference(ranked);
  const byId = new Map(ranked.map((lesson) => [lesson.id, lesson] as const));
  const losersOf = new Map<string, Lesson[]>();
  for (const [loserId, winnerId] of preferred) (losersOf.get(winnerId) ?? losersOf.set(winnerId, []).get(winnerId)!).push(byId.get(loserId)!);
  const decided = new Set<string>();
  const out: Lesson[] = [];
  const take = (lesson: Lesson): boolean => { if (!fits(lesson)) return false; out.push(lesson); return true; };
  for (const lesson of ranked) {
    if (decided.has(lesson.id)) continue;
    decided.add(lesson.id);
    const winnerId = preferred.get(lesson.id);
    const winner = winnerId === undefined ? undefined : byId.get(winnerId);
    if (winner !== undefined && !decided.has(winner.id)) {
      // A non-preferred twin ranks first: its preferred twin gets the place, and this one only if that one does not fit.
      decided.add(winner.id);
      if (!take(winner)) take(lesson);
      continue;
    }
    if (winner !== undefined) continue;
    const losers = losersOf.get(lesson.id) ?? [];
    for (const loser of losers) decided.add(loser.id);
    if (!take(lesson)) { for (const loser of losers) if (take(loser)) break; }
  }
  return out;
}

/** Who reads what is selected. A running task (a Rovara agent): its audience, read live. Nobody in particular (a local coding tool, decision 46b): the whole project, so only what every member may read (decision 32). */
export type SelectReader = { running: { taskId: string } } | { running?: undefined };
export interface SelectInput {
  key: ScopeKey; stage: LessonStage; resolved: ResolvedLearning;
  /** The project's active, unexpired lessons without a stale citation (the caller read them from the store). */
  active: readonly Lesson[];
  intent: string; planSummary?: string; repos: readonly string[]; files: readonly string[]; languages: readonly string[];
  reader: SelectReader; where: string; budget: LoadBudget;
  /** Lessons are checked this many at a time against the access records (default `CHECK_PAGE`). */
  pageSize?: number;
  /** A further cheap, caller-owned filter of the lessons that fit the stage and scope, before any are ranked or read (the local-tools filters). It may read; a lesson it drops is never read further. */
  prefilter?: (eligible: readonly Lesson[]) => Promise<readonly Lesson[]>;
}
export type SelectOutcome =
  | { ok: false; skipped: "members_unavailable" | "access_unavailable" }
  | { ok: true; chosen: LearnedLesson[]; picked: Lesson[]; entries: LoadManifestEntry[]; bytes: number; complete: boolean; viewer: IdentitySet | undefined; live: LessonLiveReader; log: (event: string, fields: Record<string, unknown>) => void };

/**
 * The one ranking and budget of lessons, shared by the dispatch loader (`loadLessonsForStage`, reader = the running task) and the local-tools read (reader = the whole project): the approval rule now, the stage and scope, the fused
 * similarity (keywords and paths, plus the cosine only where `deps.embedder` is set), then the best candidates are read a page at a time through the access records and the source tasks' live visibility (`readVisibleRanked`) until
 * the budget is filled. It writes nothing and never reads a lesson past `readVisible`. Fail closed: a roster of members or an access port that is missing is a skip, never a weaker rule.
 */
export async function selectLessons(deps: LoadDeps, input: SelectInput): Promise<SelectOutcome> {
  const { key, stage, resolved, intent, budget } = input;
  const now = deps.now();
  let active: Lesson[] = [...input.active];
  // The people a tier needs are counted as MEMBERS (a merged developer is the member they became); a merge record that cannot be read loads nothing.
  const member = await memberView(deps.resolveMember, key.workspaceId, active.flatMap((l) => l.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => a.by)));
  if (member === undefined) {
    deps.metrics?.count("learning_load_skipped", { reason: "members_unavailable" });
    return { ok: false, skipped: "members_unavailable" };
  }
  // A snapshot's lessons are held to the SAME approval rule as live ones (no bypass): the arm's export already kept only what is delivered without a person, and the project's own rules decide it again here.
  active = active.filter((l) => approvedForUse(l, resolved.approval, member, resolved.trialAllowed));

  // The access records, asked now for the places each candidate lesson was learned from (one batch for the whole load). A record that cannot be read loads nothing.
  if ((deps.access as AccessCheckPort | undefined) === undefined) {
    deps.log?.("learning.load_no_access_port", { stage });
    deps.metrics?.count("learning_load_skipped", { reason: "access_unavailable" });
    return { ok: false, skipped: "access_unavailable" };
  }
  // Every candidate goes through the one read path: the frozen snapshot AND the access records AND the source tasks' live visibility. The candidates are scored and scope-matched FIRST (cheap, no reads), then the
  // best ones are checked a page at a time until enough survive, with one reader for the whole load so no task is read twice.
  // No single person is the reader: restricted lessons and restricted places are checked as for nobody in particular, and the source tasks against the running task's audience (or, with no running task, the whole project).
  const viewer: IdentitySet | undefined = undefined;
  // Which of the lessons that fit the stage and scope fit THIS task best: the fused score (code-aware keywords, the files the task touches and, where there is an embedder, the cosine) against the task's intent, plan summary
  // and touched files. It is a ranking only (it reads no access record and returns scores, never text): the visibility pages below still decide what may load, and an embedder that is down is keywords and paths.
  const scope = { repos: input.repos, files: input.files, languages: input.languages };
  let eligible = active.filter((lesson) => stageAllows(lesson, stage, member) && scopeMatch(lesson, scope).matches);
  if (input.prefilter !== undefined) eligible = [...await input.prefilter(eligible)];
  let similarity = new Map<string, number>();
  try {
    const task = docOfText(cleanLessonText(`${intent}\n${input.planSummary ?? ""}`, 2000), input.files);
    similarity = new Map((await rankLessons({ embedder: deps.embedder, vectors: deps.vectors, log: deps.log, metrics: deps.metrics }, key, eligible, task, { queryKind: "query", timeoutMs: EMBED_TIMEOUT_MS.load, warmMs: EMBED_WARM_MS.load })).ranked.map((r) => [r.id, Math.max(0, Math.min(1, r.fused))]));
  } catch { deps.metrics?.count("learning_load_similarity_failed"); }

  const scored: Array<{ lesson: Lesson; score: number; why: LoadManifestEntry["why"] }> = [];
  for (const lesson of eligible) {
    const match = scopeMatch(lesson, scope);
    const sim = similarity.get(lesson.id) ?? 0;
    const recency = Math.exp(-Math.max(0, now - (lesson.lastValidatedAt ?? lesson.updatedAt)) / (90 * DAY));
    const score = 0.6 * sim + 0.3 * wilsonLower(lesson.counters.helpful, lesson.counters.loaded) + 0.1 * recency;
    scored.push({ lesson, score, why: match.byPath ? "path" : sim >= 0.6 ? "similar" : "scope" });
  }
  scored.sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const rank = new Map(scored.map((entry) => [entry.lesson.id, entry] as const));

  const log = (event: string, fields: Record<string, unknown>): void => {
    deps.log?.(event, fields);
    if (fields.reason === "bound") deps.metrics?.count("learning_live_bound_hit", { where: input.where });
  };
  const deadlineAt = Date.now() + LOAD_VISIBILITY_BUDGET_MS;
  // Each batched task read gets only the time that is left, so the whole load stays inside the dispatcher's deadline whatever the State table does.
  const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: input.where, log, ...(input.reader.running === undefined ? {} : { running: input.reader.running }), timeoutMs: () => Math.max(1, deadlineAt - Date.now()) });
  const chosen: LearnedLesson[] = [];
  const picked: Lesson[] = [];
  const entries: LoadManifestEntry[] = [];
  let bytes = 0;
  const choose = (candidates: readonly Lesson[]): void => {
    chosen.length = 0; picked.length = 0; entries.length = 0; bytes = 0;
    // Twins are reduced to one, preferring the repo-only one, and the other twin is tried when the preferred one does not fit the bytes left.
    chooseWithTwins(candidates, (lesson) => {
      if (chosen.length >= budget.lessons) return false;
      const entry = rank.get(lesson.id)!;
      const learned = toLearned(lesson);
      const size = sizeOf(learned);
      if (bytes + size > budget.bytes) return false;
      chosen.push(learned);
      picked.push(lesson);
      entries.push({ id: lesson.id, version: lesson.version, score: Math.round(entry.score * 1000) / 1000, why: entry.why, citation: "unchecked", taskIds: lessonTaskRefs(lesson).taskIds });
      bytes += size;
      return true;
    });
  };
  let complete: boolean;
  try {
    const checked = await readVisibleRanked({
      access: deps.access, key, viewer, where: input.where, log, live, ranked: scored.map((entry) => entry.lesson), pageSize: input.pageSize ?? CHECK_PAGE,
      enough: (kept) => { choose(kept); return chosen.length >= budget.lessons; }, deadlineAt,
    });
    choose(checked.kept);
    complete = checked.complete;
    if (!checked.complete) { deps.log?.(input.where === "load" ? "learning.load_visibility_budget" : `learning.${input.where}_visibility_budget`, { checked: checked.checked, ranked: scored.length }); deps.metrics?.count("learning_load_budget_hit"); }
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "access_unavailable" });
    return { ok: false, skipped: "access_unavailable" };
  }
  return { ok: true, chosen, picked, entries, bytes, complete, viewer, live, log };
}

export async function loadLessonsForStage(deps: LoadDeps, request: LoadRequest): Promise<LoadResult> {
  const key: ScopeKey = { workspaceId: request.workspaceId, project: request.project };
  const now = deps.now();
  const empty = async (skipped: LoadSkip, setVersion?: number): Promise<LoadResult> => ({
    skipped, manifest: { taskId: request.taskId, workspaceId: key.workspaceId, project: key.project, stage: request.stage === "CHECKS" ? "PLAN" : request.stage, round: request.round, setVersion: setVersion ?? 0, memory: skipped === "memory_off" ? "off" : "live", at: now, lessons: [], bytes: 0 },
  });
  if (request.memory?.mode === "off") return empty("memory_off");
  if (request.stage === "CHECKS") return empty("stage");
  const stage = request.stage;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  // A replay copy given a frozen snapshot is explicitly delivered those lessons whatever the install's lessons switch says (the harness names this in its plan), but the project's OWN mode still
  // decides (a project with lessons Off gets none). The live set is never read for it.
  const snapshot = request.memory?.mode === "snapshot" ? request.memory : undefined;
  if (!modeAllows(snapshot === undefined ? resolved.mode : resolved.chosenMode, "load")) return empty("mode");

  let setVersion = 0;
  let active: Lesson[];
  try {
    if (snapshot !== undefined) {
      active = snapshot.lessons.filter((l) => l.workspaceId === key.workspaceId && l.project === key.project && l.status === "active" && !hasStaleCitation(l));
    } else {
      setVersion = await deps.store.setVersion(key);
      active = (await deps.store.list(key, { statuses: ["active"] })).filter((l) => l.expiresAt > now && !hasStaleCitation(l));
    }
  } catch {
    // Fail closed: with the store unreachable the task runs as it would without memory.
    deps.metrics?.count("learning_load_skipped", { reason: "index_unreachable" });
    return empty("index_unreachable", setVersion);
  }

  // The ranking, the approval rule and the visibility pages are `selectLessons`, which the local-tools read shares (decision 46b); here the reader is the running task's audience.
  const selected = await selectLessons(deps, {
    key, stage, resolved, active, intent: request.intent, ...(request.planSummary === undefined ? {} : { planSummary: request.planSummary }),
    repos: request.repos, files: request.files, languages: request.languages, reader: { running: { taskId: request.taskId } }, where: "load",
    budget: resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES }),
  });
  if (!selected.ok) return empty(selected.skipped, setVersion);
  const { chosen, entries, bytes, live, viewer, log } = selected;

  let priorLoaded: LearnedContext["priorLoaded"];
  if (stage === "PLAN_CRITIQUE" || stage === "REVIEW") {
    // Reviewers see what the planner and coder were told, so they can check whether a lesson drove a bad change.
    const seen = new Map<string, { id: string; type: Lesson["type"]; title: string }>();
    for (const manifest of await deps.store.manifests(key, request.taskId)) {
      if (manifest.stage === "PLAN_CRITIQUE" || manifest.stage === "REVIEW") continue;
      for (const entry of manifest.lessons) {
        if (seen.has(entry.id) || seen.size >= PRIOR_LOADED_MAX) continue;
        const lesson = await deps.store.get(key, entry.id);
        if (lesson !== undefined) seen.set(entry.id, { id: lesson.id, type: lesson.type, title: lesson.title });
      }
    }
    // The titles go through the same read path: a lesson whose source place turned private since is not listed for a task that may no longer read it.
    const shown = new Set((await readVisible({ access: deps.access, key, viewer, live, lessons: (await Promise.all([...seen.keys()].map((id) => deps.store.get(key, id)))).flatMap((l) => (l === undefined ? [] : [l])), where: "load", log })).map((l) => l.id));
    priorLoaded = [...seen.values()].filter((entry) => shown.has(entry.id));
  }

  const manifest: LoadManifest = { taskId: request.taskId, workspaceId: key.workspaceId, project: key.project, stage, round: request.round, setVersion, memory: snapshot === undefined ? "live" : "snapshot", ...(snapshot === undefined ? {} : { snapshotId: snapshot.snapshotId }), at: now, lessons: entries, bytes };
  if (request.wanted !== undefined && !request.wanted()) return { manifest, skipped: "abandoned" };
  await deps.store.putManifest(manifest);
  // `loaded` is counted when the worker reports the lesson reached the prompt (applyLoadReport), not here: a lesson the worker dropped was never loaded.
  if (chosen.length === 0 && priorLoaded === undefined) return { manifest, skipped: "no_lessons" };
  return { manifest, context: { v: 1, setVersion, stage, lessons: chosen, ...(priorLoaded === undefined ? {} : { priorLoaded }) } };
}

/**
 * The single call the dispatch makes. It returns an object to spread into the worker invocation:
 * `{ learnedContext }` when something loads, `{}` otherwise. Called with a worker that does not list the feature, it returns `{}` and records nothing (no manifest, no counters). The dispatch
 * itself asks as for a worker that lists it, and delivery removes the field for an older worker: so a manifest can name lessons that an older worker
 * never received (the task page shows them as "not checked yet"). Any failure inside is swallowed: learning never blocks a stage.
 */
export async function learnedContextForDispatch(deps: LoadDeps, request: LoadRequest, workerFeatures: readonly string[]): Promise<{ learnedContext?: LearnedContext }> {
  if (!workerFeatures.includes(LEARNED_CONTEXT_FEATURE)) return {};
  try {
    const result = await loadLessonsForStage(deps, request);
    return result.context === undefined ? {} : { learnedContext: result.context };
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "error" });
    return {};
  }
}
