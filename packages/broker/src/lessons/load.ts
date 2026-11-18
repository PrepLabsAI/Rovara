// The loader. At a stage's dispatch it picks the lessons that apply and returns the `learnedContext` payload for the worker
// and the manifest that records what was chosen. It never blocks a task: any failure loads nothing. The task flow's dispatch asks for it through `TaskFlowDeps.learned`.
import {
  KNOWLEDGE_PULL_MAX_UNITS, KNOWLEDGE_STAGE_PARTS, LEARNED_CONTEXT_FEATURE, LEARNED_CONTEXT_MAX_BYTES, LEARNED_CONTEXT_MAX_LESSONS, cleanLessonText, type CodeCitation, type LearnedContext, type LearnedLesson, type LessonStage,
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
import { MEASURE_LEFT_OUT, type FitSample, type MeasureSink } from "./measure.js";
import { fitOrder, passesFitFloor } from "./fit.js";
import { RECENCY_DAYS, resolveRanking, type RankingSettings } from "./scoring-settings.js";
import type { SignalsReader } from "./signals.js";
import { NO_EVIDENCE, betaStrength, legacyEvidence } from "./strength.js";
import { pullable } from "./knowledge-brief.js";
import { normId, type IdentitySet, type Lesson } from "./types.js";

export const LOAD_MAX_LESSONS = LEARNED_CONTEXT_MAX_LESSONS;
export const LOAD_MAX_BYTES = LEARNED_CONTEXT_MAX_BYTES;
/** The byte budget given to the look-up's selection: the unit limit decides, and `pullUnitsOf` enforces the contract's own byte limit on the units themselves. */
const PULL_SELECT_BYTES = 256 * 1024;
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
export interface LoadResult {
  context?: LearnedContext; manifest: LoadManifest; skipped?: LoadSkip;
  /** The lessons chosen for the push, in order (the same as `context.lessons`, with their scope). */
  picked?: Lesson[];
}

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
  /**
   * Phase 0 (measure only): where a load's fit numbers are written (`measure.ts`). Absent: nothing is recorded. It changes nothing about what loads: the record is written after the manifest, never throws and is
   * not waited on past its own short limit.
   */
  measure?: MeasureSink | undefined;
  /**
   * Phases 1 and 2: the project's clean-merge rate (the prior's centre), each lesson's windowed evidence and the lessons under question (`signals.ts`). Absent, or no answer in its short wait: the neutral prior, the lessons' own
   * counters as evidence and nothing under question (a project with no rows). It is read once per project and reused, so a load pays for it at most once in a few minutes.
   */
  signals?: SignalsReader | undefined;
  /** The settings of the fit floor, the weights, the prior and the newcomer place (`scoring-settings.ts`). Absent: the research's starting values. A test or the replay harness may change them. */
  ranking?: Partial<Omit<RankingSettings, "weights">> & { weights?: Partial<RankingSettings["weights"]> } | undefined;
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

/**
 * The lower bound of the Wilson interval for helpful of loaded (95%). Zero when a lesson has never been loaded. NOT used by the loader any more (phase 1 replaced it with the Beta strength of `strength.ts`: this bound is 0 for a
 * lesson never loaded, so a new lesson ranked as if it had failed); kept as the "before" of the replay comparison and its own tests.
 */
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

/** Who reads what is selected. A running task (a Rovara agent): its audience, read live. Nobody in particular (a local coding tool, decision 46b): the whole project, so only what every member may read (decision 32). */
export type SelectReader = { running: { taskId: string } } | { running?: undefined };
export interface SelectInput {
  key: ScopeKey; stage: LessonStage; resolved: ResolvedLearning;
  /** The project's active, unexpired lessons without a stale citation (the caller read them from the store). */
  active: readonly Lesson[];
  intent: string; planSummary?: string; repos: readonly string[]; files: readonly string[]; languages: readonly string[];
  reader: SelectReader; where: string; budget: LoadBudget;
  /** A further cheap, caller-owned filter of the lessons that fit the stage and scope, before any are ranked or read (the local-tools filters). It may read; a lesson it drops is never read further. */
  prefilter?: (eligible: readonly Lesson[]) => Promise<readonly Lesson[]>;
  /**
   * The PUSH channel (a step's dispatch, `loadLessonsForStage`): lessons must pass the fit floor on an absolute measure, and one place is kept for a well-fitting newcomer (phase 1). Absent: the local-tools read, where the tool
   * asks for the lessons of a change it describes (a pull): every lesson of the stage and scope is ranked and none is dropped for fit.
   */
  push?: true;
}
export type SelectOutcome =
  | { ok: false; skipped: "members_unavailable" | "access_unavailable" }
  | { ok: true; chosen: LearnedLesson[]; picked: Lesson[]; entries: LoadManifestEntry[]; bytes: number; complete: boolean; viewer: IdentitySet | undefined; live: LessonLiveReader; log: (event: string, fields: Record<string, unknown>) => void;
      /** Phase 0 (measure only): the fit and rank score of every lesson that was ranked, in rank order, read by nothing that decides a load. */
      ranking: ReadonlyArray<{ id: string; fit: number; score: number; words: number; cos: number | undefined }>;
      /** Phase 1: how many lessons that fit the stage and scope were left out because they did not pass the fit floor, and which loaded lessons were given the newcomer place. */
      belowFloor: number; newcomers: readonly string[] };

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
  // Phase 0 (measure only): the two absolute companions of the fused fit (which is a rank-based score: 1 is first in every list the query has), kept for the record and read by nothing that decides a load.
  const absolute = new Map<string, { words: number; cos: number | undefined }>();
  try {
    const task = docOfText(cleanLessonText(`${intent}\n${input.planSummary ?? ""}`, 2000), input.files);
    const ranked = (await rankLessons({ embedder: deps.embedder, vectors: deps.vectors, log: deps.log, metrics: deps.metrics }, key, eligible, task, { queryKind: "query", timeoutMs: EMBED_TIMEOUT_MS.load, warmMs: EMBED_WARM_MS.load })).ranked;
    similarity = new Map(ranked.map((r) => [r.id, Math.max(0, Math.min(1, r.fused))]));
    for (const r of ranked) absolute.set(r.id, { words: r.containment, cos: r.cosine });
  } catch { deps.metrics?.count("learning_load_similarity_failed"); }

  // Phases 1 and 2 (`scoring-settings.ts`): the strength of each lesson is a Beta score over its windowed evidence with a prior at the project's own clean-merge rate; a lesson must pass the fit floor on an ABSOLUTE
  // measure (a scope path matched, or the shared-word share, or the embedder's cosine) to be loaded at all; a lesson under question ranks lower. The project's signals are read once (cached, bounded, never a failure).
  const settings = resolveRanking(deps.ranking);
  const signals = deps.signals === undefined ? undefined : await deps.signals.read(key).catch(() => undefined);
  const recencyMs = RECENCY_DAYS * DAY;
  type Scored = { lesson: Lesson; score: number; fit: number; why: LoadManifestEntry["why"]; passes: boolean; order: number };
  const everyone: Scored[] = [];
  for (const lesson of eligible) {
    const match = scopeMatch(lesson, scope);
    const sim = similarity.get(lesson.id) ?? 0;
    const recency = Math.exp(-Math.max(0, now - (lesson.lastValidatedAt ?? lesson.updatedAt)) / recencyMs);
    // A lesson with evidence rows is weighed by its rows alone; one with none by its own counters inside the window (what it had before the rows began). No signals at all: the counters.
    const rows = signals?.evidence.get(lesson.id);
    // (When the signals read was cut short, a lesson with no row may only have been cut off: no lesson is then weighed by its old counters, so no lesson is judged by a different rule from another.)
    const evidence = rows ?? (lesson.counters.helpful + lesson.counters.harmful === 0 || signals?.truncated === true ? NO_EVIDENCE : legacyEvidence(lesson, now, settings.evidenceWindowDays * DAY));
    const strength = betaStrength(evidence, signals?.cleanMergeRate, settings);
    const questioned = signals?.underQuestion.has(lesson.id) === true;
    const w = settings.weights;
    const score = Math.max(0, w.fit * sim + w.strength * strength + w.recency * recency - (questioned ? settings.underQuestionPenalty : 0));
    const fit = { words: absolute.get(lesson.id)?.words ?? 0, cos: absolute.get(lesson.id)?.cos, byPath: match.byPath };
    everyone.push({ lesson, score, fit: sim, why: match.byPath ? "path" : sim >= 0.6 ? "similar" : "scope", passes: input.push !== true || passesFitFloor(fit, settings), order: fitOrder(fit, settings) });
  }
  everyone.sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const scored = everyone.filter((entry) => entry.passes);
  const belowFloor = everyone.length - scored.length;
  if (belowFloor > 0) deps.metrics?.count("learning_load_below_floor", { where: input.where });
  const rank = new Map(scored.map((entry) => [entry.lesson.id, entry] as const));
  // The newcomer place: the best-fitting lessons with fewer than `newcomerMaxUses` uses are checked first (so the access pages reach them), and `choose` keeps one place for one of them.
  const isNewcomer = (lesson: Lesson): boolean => lesson.counters.loaded < settings.newcomerMaxUses;
  const newcomerOrder = scored.filter((entry) => isNewcomer(entry.lesson)).sort((a, b) => b.order - a.order || b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const hoisted = new Set(newcomerOrder.slice(0, Math.max(3, settings.newcomerSlots + 2)).map((entry) => entry.lesson.id));
  const checkOrder = [...scored.filter((entry) => hoisted.has(entry.lesson.id)), ...scored.filter((entry) => !hoisted.has(entry.lesson.id))];

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
  let newcomers: string[] = [];
  /** Fills the chosen lessons from `order` up to `limit` places and the byte budget. */
  const fill = (order: readonly Lesson[], limit: number): void => {
    chosen.length = 0; picked.length = 0; entries.length = 0; bytes = 0;
    // In rank order, each lesson that fits the places and bytes left (batch 17: the twins of #998's base are gone, #979).
    for (const lesson of order) {
      if (chosen.length >= limit) continue;
      const entry = rank.get(lesson.id)!;
      const learned = toLearned(lesson);
      const size = sizeOf(learned);
      if (bytes + size > budget.bytes) continue;
      chosen.push(learned);
      picked.push(lesson);
      entries.push({ id: lesson.id, version: lesson.version, score: Math.round(entry.score * 1000) / 1000, why: entry.why, citation: "unchecked", taskIds: lessonTaskRefs(lesson).taskIds });
      bytes += size;
    }
  };
  const choose = (candidates: readonly Lesson[]): void => {
    // Rank order (what the access pages do not promise once newcomers are checked first).
    const byRank = [...candidates].filter((lesson) => rank.has(lesson.id)).sort((a, b) => rank.get(b.id)!.score - rank.get(a.id)!.score || a.id.localeCompare(b.id));
    fill(byRank, budget.lessons);
    newcomers = [];
    if (input.push !== true || settings.newcomerSlots <= 0 || budget.lessons < settings.newcomerMinBudget) return;
    const have = picked.filter(isNewcomer).length;
    if (have >= settings.newcomerSlots) return;
    // Not enough newcomers in the natural picks: the best-fitting ones (no randomness: fit, then score, then id) go first and take the places, the rest fill the others.
    const wanted = byRank.filter((lesson) => isNewcomer(lesson) && !picked.some((p) => p.id === lesson.id))
      .sort((a, b) => rank.get(b.id)!.order - rank.get(a.id)!.order || rank.get(b.id)!.score - rank.get(a.id)!.score || a.id.localeCompare(b.id)).slice(0, settings.newcomerSlots - have);
    if (wanted.length === 0) return;
    const front = new Set(wanted.map((lesson) => lesson.id));
    fill([...wanted, ...byRank.filter((lesson) => !front.has(lesson.id))], budget.lessons);
    const placed = wanted.filter((lesson) => picked.some((p) => p.id === lesson.id)).map((lesson) => lesson.id);
    if (placed.length === 0) { fill(byRank, budget.lessons); return; }
    newcomers = placed;
    // Back into rank order, so the prompt lists the lessons the way it did before (the newcomer is not read first for having been placed first).
    const order = new Map(byRank.map((lesson, index) => [lesson.id, index] as const));
    const rows = picked.map((lesson, index) => ({ lesson, learned: chosen[index]!, entry: entries[index]! })).sort((a, b) => order.get(a.lesson.id)! - order.get(b.lesson.id)!);
    picked.length = 0; chosen.length = 0; entries.length = 0;
    for (const row of rows) { picked.push(row.lesson); chosen.push(row.learned); entries.push(row.entry); }
  };
  let complete: boolean;
  try {
    const checked = await readVisibleRanked({
      access: deps.access, key, viewer, where: input.where, log, live, ranked: checkOrder.map((entry) => entry.lesson), pageSize: CHECK_PAGE,
      enough: (kept) => { choose(kept); return chosen.length >= budget.lessons; }, deadlineAt,
    });
    choose(checked.kept);
    complete = checked.complete;
    if (!checked.complete) { deps.log?.(input.where === "load" ? "learning.load_visibility_budget" : `learning.${input.where}_visibility_budget`, { checked: checked.checked, ranked: scored.length }); deps.metrics?.count("learning_load_budget_hit"); }
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "access_unavailable" });
    return { ok: false, skipped: "access_unavailable" };
  }
  if (newcomers.length > 0) deps.metrics?.count("learning_load_newcomer_placed", { where: input.where });
  return { ok: true, chosen, picked, entries, bytes, complete, viewer, live, log, belowFloor, newcomers, ranking: everyone.map((entry) => ({ id: entry.lesson.id, fit: entry.fit, score: entry.score, words: absolute.get(entry.lesson.id)?.words ?? 0, cos: absolute.get(entry.lesson.id)?.cos })) };
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
    // ONE fit floor (`scoring-settings.ts`, on the ABSOLUTE fit: a scope path matched, the shared-word share or the cosine) and the newcomer place, for the live push only: a replay copy's frozen snapshot is delivered exactly as chosen, so neither applies to it.
    ...(snapshot === undefined ? { push: true as const } : {}),
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
  // Phase 0 (measure only): the fit numbers of this load. Live loads only (an eval's snapshot or memory-off load is not the project's own), after the manifest, and nothing below reads what it did.
  if (snapshot === undefined && deps.measure !== undefined && active.length > 0) {
    try {
      const sample = (id: string): FitSample => { const ranked = selected.ranking.find((entry) => entry.id === id)!; return { id, fit: ranked.fit, score: ranked.score, words: ranked.words, cos: ranked.cos ?? null }; };
      const picked = new Set(entries.map((entry) => entry.id));
      // Not waited for: the measurement never holds a step's dispatch (a slow store could push a near-deadline load past the dispatcher's 2.5 s). The sink never throws and bounds its own write.
      void deps.measure.load({
        workspaceId: key.workspaceId, project: key.project, taskId: request.taskId, stage, round: request.round, at: now, budgetLessons: resolveLoadBudget(resolved.loadBudget, { lessons: LOAD_MAX_LESSONS, bytes: LOAD_MAX_BYTES }).lessons,
        activeCount: active.length, eligibleCount: selected.ranking.length,
        loaded: entries.map((entry) => sample(entry.id)), leftOut: selected.ranking.filter((entry) => !picked.has(entry.id)).slice(0, MEASURE_LEFT_OUT).map((entry) => sample(entry.id)),
      }).catch(() => { try { deps.metrics?.count("learning_measure_failed"); } catch { /* information only */ } });
    } catch { deps.metrics?.count("learning_measure_failed"); }
  }
  // `loaded` is counted when the worker reports the lesson reached the prompt (applyLoadReport), not here: a lesson the worker dropped was never loaded.
  if (chosen.length === 0 && priorLoaded === undefined) return { manifest, skipped: "no_lessons" };
  return { manifest, picked: selected.picked, context: { v: 1, setVersion, stage, lessons: chosen, ...(priorLoaded === undefined ? {} : { priorLoaded }) } };
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

/**
 * The same call for the knowledge briefing: the loaded context AND the lessons chosen (with their scope, for the worker's area check). Any failure loads nothing. Kept apart from `learnedContextForDispatch` so every other caller
 * keeps its exact answer.
 */
export async function lessonsAndPickedForDispatch(deps: LoadDeps, request: LoadRequest, workerFeatures: readonly string[]): Promise<{ learnedContext?: LearnedContext; picked?: Lesson[] }> {
  if (!workerFeatures.includes(LEARNED_CONTEXT_FEATURE)) return {};
  try {
    const result = await loadLessonsForStage(deps, request);
    return { ...(result.context === undefined ? {} : { learnedContext: result.context }), ...(result.picked === undefined ? {} : { picked: result.picked }) };
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "error" });
    return {};
  }
}

/**
 * Lead 4 L4-AK2: the look-up's lessons for a step (the pull set): approved, visible to the running task's audience, scoped, stable or person-approved, ranked, up to `KNOWLEDGE_PULL_MAX_UNITS`, through the SAME read path as the push
 * (`selectLessons`). Reads and writes nothing else; undefined when learning does not load, the stage may not look up, or anything cannot be read. `leftOut` counts eligible lessons the look-up could not hold.
 */
export async function loadPullForStage(deps: LoadDeps, request: Pick<LoadRequest, "workspaceId" | "project" | "taskId" | "intent" | "planSummary" | "repos" | "files" | "languages"> & { stage: LessonStage }): Promise<{ picked: Lesson[]; leftOut: number } | undefined> {
  if (!KNOWLEDGE_STAGE_PARTS[request.stage].pull) return undefined;
  try {
    const key: ScopeKey = { workspaceId: request.workspaceId, project: request.project };
    const now = deps.now();
    const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
    if (!modeAllows(resolved.mode, "load")) return undefined;
    const active = (await deps.store.list(key, { statuses: ["active"] })).filter((l) => l.expiresAt > now && !hasStaleCitation(l));
    const wider = await selectLessons(deps, {
      key, stage: request.stage, resolved, active, intent: request.intent, ...(request.planSummary === undefined ? {} : { planSummary: request.planSummary }),
      // No files: the look-up holds every scoped lesson of the task's repositories, not only those whose globs match the files the plan names (the agent may look elsewhere); the ranking still reads the task text.
      repos: request.repos, files: [], languages: request.languages, reader: { running: { taskId: request.taskId } }, where: "load",
      budget: { lessons: KNOWLEDGE_PULL_MAX_UNITS, bytes: PULL_SELECT_BYTES }, prefilter: async (eligible) => eligible.filter(pullable),
    });
    if (!wider.ok) return undefined;
    // The last line before anything is handed on: what was picked goes through the one read path again, for the same reader (so no task is read twice). It can only remove a lesson.
    const allowed = new Set((await readVisible({ access: deps.access, key, viewer: wider.viewer, live: wider.live, lessons: wider.picked, where: "load", log: wider.log })).map((lesson) => lesson.id));
    const picked = wider.picked.filter((lesson) => allowed.has(lesson.id));
    const candidates = active.filter((lesson) => stageAllows(lesson, request.stage) && pullable(lesson) && scopeMatch(lesson, { repos: request.repos, files: [], languages: request.languages }).matches).length;
    return { picked, leftOut: Math.max(0, candidates - picked.length) };
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "error" });
    return undefined;
  }
}
