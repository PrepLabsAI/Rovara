// "the same mistake twice" (design 4.12). Per project and over a window: of the corrections people gave, how many had to be given
// again on a LATER task. It is the measure of whether learning works, so it is built to be hard to flatter:
//   - A correction is a send-back reason, a change-requesting review comment, a member's human edit, or a revert, given by a member of the company. An outsider's words and an eval run's
//     corrections are not counted.
//   - A correction is a REPEAT when it says the same thing as a correction from an earlier task in the last 90 days, or the same thing as a lesson that was live when it was given.
//   - Every repeat falls in exactly one of three groups: the lesson existed and WAS loaded (the lesson failed), the lesson existed but was NOT loaded (the loader missed), or there was
//     NO lesson (learning missed).
//   - rate = repeats / judged corrections. A correction the matcher could not rate is reported as unjudged and left out of both sides, so a matcher outage never lowers the rate.
//
// READ-ONLY. It takes the lesson store through a type that only lists, reads versions and reads load manifests; it takes corrections through a source that only lists. It writes
// nothing, charges nothing, and returns counts only: no correction text and no lesson text leaves this module (so it can be shown to anyone who may see the project).
// The matcher is a port: production hands it the curator's matcher; `metric-source.ts` has one that needs no text and no model.
import { globToRegExp } from "./guards.js";
import type { CorrectionKind, Embedder } from "./ports.js";
import type { LessonStore, LoadManifest, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

const DAY = 86_400_000;
/** A correction repeats an earlier one from at most this long before it. */
export const REPEAT_LOOKBACK_DAYS = 90;
/** Below this many judged corrections the screen says "Not enough corrections yet" and shows no rate (as the measure does). */
export const METRIC_MIN_CORRECTIONS = 10;
/** The widest window one call measures. */
export const METRIC_MAX_WINDOW_DAYS = 400;
export const METRIC_MAX_CORRECTIONS = 2_000;
/** The most earlier corrections one correction is compared with (the most recent ones). */
export const METRIC_MAX_EARLIER = 200;
/** The most lessons one project contributes. */
export const METRIC_MAX_LESSONS = 500;
/** Matcher calls in one measurement; past it the rest of the corrections are unjudged and the answer says it was cut short. */
export const METRIC_MAX_MATCHER_CALLS = 20_000;
/**
 * Embedding calls in one measurement: a HARD cap. Once the curator's embedding matcher is behind the port, 20,000 matcher calls could mean 20,000 embedding calls; each distinct text is embedded once
 * (`EmbeddingBudget`), so a call is at most one per distinct correction or lesson text, and this caps even that. Past it the rest are unjudged and the answer says it was cut short.
 */
export const METRIC_MAX_EMBEDDING_CALLS = 3_000;

export interface CorrectionRecord {
  /** The correction's own id (its record row). */
  id: string;
  taskId: string;
  /** When it was given, in epoch milliseconds. */
  at: number;
  kind: CorrectionKind;
  /** Whether a member of the company gave it. Anyone else's is kept in the record but never counted. */
  member: boolean;
  /** An eval run's corrections are never counted (design 4.13). */
  evalRun?: boolean;
  /** The files it touches, to keep a path-scoped lesson from matching corrections elsewhere. */
  paths?: readonly string[];
  /** The earlier correction this one was already found to repeat when it was captured (the grouping step). It is believed only if that correction is on an earlier task. */
  repeatOf?: string;
  /** What the matcher compares: the words, or a signature of them (the words may be gone). The module reads neither. */
  text?: string;
  signature?: readonly string[];
}

/** Lists a project's corrections. Only reads. */
export interface CorrectionSource {
  /** Corrections with `since <= at < until`, oldest first, at most `limit`; `truncated` when more existed. */
  list(key: ScopeKey, range: { since: number; until: number }, limit: number): Promise<{ corrections: CorrectionRecord[]; truncated: boolean }>;
}

export type LessonFacts = Pick<Lesson, "id" | "type" | "title" | "description" | "body" | "scope">;

/** Says whether two pieces of advice are the same. The curator's matcher in production; a fake in tests. It may throw; the correction is then unjudged. */
export interface CorrectionMatcher {
  /** `later` says again what `earlier` said. */
  sameAsCorrection(earlier: CorrectionRecord, later: CorrectionRecord): Promise<boolean>;
  sameAsLesson(correction: CorrectionRecord, lesson: LessonFacts): Promise<boolean>;
}

/** The only parts of the lesson store this module can call. */
export type MetricStore = Pick<LessonStore, "listAllHeads" | "versions" | "manifests">;

/** Thrown by `EmbeddingBudget.embed` when the next call would pass the cap. */
export class EmbeddingBudgetExhausted extends Error { constructor() { super("the embedding budget is used up"); } }

/**
 * The embedding calls of one measurement. A matcher that embeds text takes its vectors through `embed`: the same text is embedded once, a call that fails still counts, and the call that would pass
 * `max` is refused before it is made. `used` is what the answer reports.
 */
export class EmbeddingBudget {
  used = 0;
  exhausted = false;
  private readonly cache = new Map<string, number[]>();
  constructor(readonly max: number) {}
  async embed(embedder: Embedder, text: string): Promise<number[]> {
    const known = this.cache.get(text);
    if (known !== undefined) return known;
    if (this.used >= this.max) { this.exhausted = true; throw new EmbeddingBudgetExhausted(); }
    this.used += 1;
    const vector = await embedder.embed(text);
    this.cache.set(text, vector);
    return vector;
  }
}

/** The matcher, or a function that makes it from this measurement's embedding budget (so a matcher that embeds is held to the cap). */
export type MatcherSource = CorrectionMatcher | ((budget: EmbeddingBudget) => CorrectionMatcher);
export interface MetricDeps { corrections: CorrectionSource; matcher: MatcherSource; store: MetricStore }
export interface MetricWindow { sinceMs: number; untilMs: number }
export interface MetricLimits { maxCorrections?: number; maxEarlier?: number; maxLessons?: number; maxMatcherCalls?: number; maxEmbeddingCalls?: number; lookbackDays?: number }

export interface SameMistakeTwice {
  window: MetricWindow;
  /** Judged member corrections in the window: the denominator. */
  corrections: number;
  repeats: number;
  /** repeats / corrections, or null when there are fewer than METRIC_MIN_CORRECTIONS. */
  rate: number | null;
  enoughData: boolean;
  /** Every repeat is in exactly one: lessonLoaded + lessonNotLoaded + noLesson === repeats. */
  split: { lessonLoaded: number; lessonNotLoaded: number; noLesson: number };
  /** Corrections the matcher could not rate (it failed, or the budget ran out); they are in neither count. */
  unjudged: number;
  /** Some input was cut to its limit: the answer is for what was read. */
  truncated: boolean;
  /** Embedding calls this measurement made (0 for a matcher that does not embed), and the cap it was held to. */
  embeddingCalls: number;
  embeddingBudget: number;
}

/** A manifest entry counts as loaded only when the worker reported the lesson reached the prompt (the same rule the counters use). */
const REACHED: ReadonlySet<string> = new Set(["valid", "moved", "none"]);

/** The lesson as it was at time `t`: the last version written by then, and whether that version was live (active and not expired). */
function liveAt(versions: readonly Lesson[], t: number): Lesson | undefined {
  let at: Lesson | undefined;
  for (const version of versions) if (version.updatedAt <= t && (at === undefined || version.version >= at.version)) at = version;
  return at !== undefined && at.status === "active" && at.expiresAt > t ? at : undefined;
}

/** A lesson with a path scope matches a correction only when one of the correction's files is in it; a correction that names no files is not filtered. */
function inScope(lesson: Lesson, correction: CorrectionRecord): boolean {
  const paths = lesson.scope.paths ?? [];
  if (paths.length === 0 || (correction.paths ?? []).length === 0) return true;
  const expressions = paths.map(globToRegExp);
  return (correction.paths ?? []).some((path) => expressions.some((expression) => expression.test(path)));
}

class Budget {
  used = 0;
  exhausted = false;
  constructor(private readonly max: number) {}
  /** Takes one matcher call, or says there is none left. */
  take(): boolean {
    if (this.used >= this.max) { this.exhausted = true; return false; }
    this.used += 1;
    return true;
  }
}
class Unjudged extends Error {}

export async function sameMistakeTwice(deps: MetricDeps, key: ScopeKey, window: MetricWindow, limits: MetricLimits = {}): Promise<SameMistakeTwice> {
  if (!Number.isFinite(window.sinceMs) || !Number.isFinite(window.untilMs) || window.untilMs <= window.sinceMs || window.untilMs - window.sinceMs > METRIC_MAX_WINDOW_DAYS * DAY) {
    throw new RangeError("The window must be a forward span of at most 400 days.");
  }
  const lookback = (limits.lookbackDays ?? REPEAT_LOOKBACK_DAYS) * DAY;
  const maxCorrections = limits.maxCorrections ?? METRIC_MAX_CORRECTIONS;
  const maxEarlier = limits.maxEarlier ?? METRIC_MAX_EARLIER;
  const maxLessons = limits.maxLessons ?? METRIC_MAX_LESSONS;
  const budget = new Budget(limits.maxMatcherCalls ?? METRIC_MAX_MATCHER_CALLS);
  const embeddings = new EmbeddingBudget(limits.maxEmbeddingCalls ?? METRIC_MAX_EMBEDDING_CALLS);
  const matcher: CorrectionMatcher = typeof deps.matcher === "function" ? deps.matcher(embeddings) : deps.matcher;

  const read = await deps.corrections.list(key, { since: window.sinceMs - lookback, until: window.untilMs }, maxCorrections + METRIC_MAX_EARLIER * 10);
  let truncated = read.truncated;
  // Only members' corrections, never an eval run's, and nothing the source returned from outside the range it was asked for (a source is not trusted to filter).
  const all = read.corrections
    .filter((c) => c.member && c.evalRun !== true && c.at >= window.sinceMs - lookback && c.at < window.untilMs)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const byId = new Map(all.map((c) => [c.id, c] as const));
  const inWindow = all.filter((c) => c.at >= window.sinceMs);
  const counted = inWindow.slice(0, maxCorrections);
  if (inWindow.length > counted.length) truncated = true;

  // Lessons: every head the project holds, with its versions read when first needed.
  const heads = (await deps.store.listAllHeads(key)).filter((h) => h.workspaceId === key.workspaceId && h.project === key.project);
  const lessons = heads.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, maxLessons);
  if (heads.length > lessons.length) truncated = true;
  const versionCache = new Map<string, Lesson[]>();
  const versionsOf = async (lesson: Lesson): Promise<Lesson[]> => {
    let found = versionCache.get(lesson.id);
    if (found === undefined) { found = await deps.store.versions(key, lesson.id); versionCache.set(lesson.id, found); }
    return found;
  };
  const manifestCache = new Map<string, LoadManifest[]>();
  const loadedOn = async (taskId: string): Promise<Set<string>> => {
    let manifests = manifestCache.get(taskId);
    if (manifests === undefined) { manifests = await deps.store.manifests(key, taskId); manifestCache.set(taskId, manifests); }
    return new Set(manifests.flatMap((m) => m.lessons.filter((e) => REACHED.has(e.citation)).map((e) => e.id)));
  };

  const ask = async (call: () => Promise<boolean>): Promise<boolean> => {
    if (!budget.take()) throw new Unjudged();
    try { return await call(); } catch { throw new Unjudged(); }
  };

  const result: SameMistakeTwice = {
    window, corrections: 0, repeats: 0, rate: null, enoughData: false, split: { lessonLoaded: 0, lessonNotLoaded: 0, noLesson: 0 }, unjudged: 0, truncated: false, embeddingCalls: 0, embeddingBudget: embeddings.max,
  };

  for (const correction of counted) {
    try {
      // 1. The same thing said on an earlier task, in the last 90 days.
      const earlier = all.filter((e) => e.at < correction.at && e.at >= correction.at - lookback && e.taskId !== correction.taskId).slice(-maxEarlier);
      const believed = correction.repeatOf === undefined ? undefined : byId.get(correction.repeatOf);
      let repeatsCorrection = believed !== undefined && believed.taskId !== correction.taskId && believed.at < correction.at;
      for (const candidate of repeatsCorrection ? [] : earlier.slice().reverse()) {
        if (await ask(() => matcher.sameAsCorrection(candidate, correction))) { repeatsCorrection = true; break; }
      }

      // 2. The same thing as a lesson that was live when it was given. Lessons that were loaded for this task are asked first: one match among them settles it.
      const live: Lesson[] = [];
      for (const lesson of lessons) {
        if (lesson.createdAt > correction.at) continue;
        const version = liveAt(await versionsOf(lesson), correction.at);
        if (version !== undefined && inScope(version, correction)) live.push(version);
      }
      const loaded = live.length === 0 ? new Set<string>() : await loadedOn(correction.taskId);
      const ordered = [...live.filter((l) => loaded.has(l.id)), ...live.filter((l) => !loaded.has(l.id))];
      let matched: Lesson | undefined;
      for (const lesson of ordered) {
        if (await ask(() => matcher.sameAsLesson(correction, lesson))) { matched = lesson; break; }
      }

      result.corrections += 1;
      if (!repeatsCorrection && matched === undefined) continue;
      result.repeats += 1;
      if (matched === undefined) result.split.noLesson += 1;
      else if (loaded.has(matched.id)) result.split.lessonLoaded += 1;
      else result.split.lessonNotLoaded += 1;
    } catch (error) {
      if (!(error instanceof Unjudged)) throw error;
      result.unjudged += 1;
    }
  }

  result.truncated = truncated || budget.exhausted || embeddings.exhausted;
  result.embeddingCalls = embeddings.used;
  result.enoughData = result.corrections >= METRIC_MIN_CORRECTIONS;
  result.rate = result.enoughData ? result.repeats / result.corrections : null;
  return result;
}
