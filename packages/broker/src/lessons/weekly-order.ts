// Lessons phase 1 (research Q4): the weekly list, ordered in BANDS a person can read top to bottom, so every position can be explained in one line. Pure: lessons and counts in, rows out. Nothing is read, written or called here.
//
//   need a look   (not counted in the 5, at most `WEEKLY_NEED_LOOK_MAX`, shown first): lessons in use that are under question or that a person was asked to keep, lessons sent back or proposed for retirement, and a suggestion that
//                 conflicts with a lesson in use. A wrong hint may be reaching agents now.
//   band 1        a person's direct correction (an explicit "remember", an edit to Rovara's PR, a review comment that led to a change, a send-back with a reason)
//   band 2        backed by a measured result (a revert, a follow-up fix, a failing check that was fixed)
//   band 3        a weak source, seen twice
// A source whose suggestions were kept less than `NOISY_KEPT_RATE` of the time (with at least `NOISY_MIN_DECIDED` decided) ranks one band lower. Inside a band the FIRST difference decides: a single person's preference last, independent people,
// independent tasks, "would have applied to N tasks last month", severity, about to lapse, newest sighting, oldest suggestion, id. At most `WEEKLY_MAX_PER_AREA` per code area and `WEEKLY_MAX_PER_SOURCE` per source; at most
// `WEEKLY_PICKS` in all. Each row says why it is there. This replaces the measured-first order of `value.ts` for the weekly list (a person's direct correction first: it is the strongest signal and the person is waiting for it).
import { scopeMatch } from "./load.js";
import { ABOUT_TO_LAPSE_HOURS, NOISY_KEPT_RATE, NOISY_MIN_DECIDED, SOURCE_WINDOW_DAYS, WEEKLY_MAX_PER_AREA, WEEKLY_MAX_PER_SOURCE, WEEKLY_NEED_LOOK_MAX, WEEKLY_PICKS } from "./scoring-settings.js";
import { attributableSources } from "./sources.js";
import { normSource, type Lesson } from "./types.js";
import { independentSources, severityOfType } from "./value.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type WeeklyBand = "direct_correction" | "measured" | "weak_twice";
export type NeedLookCause = "conflict" | "retire_proposed" | "revert_overlap" | "area_gone" | "area_rewritten" | "asked_to_keep" | "sent_back";
export interface WeeklyRow {
  id: string; title: string; type: Lesson["type"];
  /** Present on a suggestion; absent on a need-a-look card. */
  band?: WeeklyBand;
  /** Present on a need-a-look card. */
  cause?: NeedLookCause;
  /** The band a noisy source was moved down to (1 to 3), for the order; the label above stays the lesson's own. */
  rank?: number;
  area: string;
  /** One plain sentence or two: why the row is here. No score, no number a person would have to interpret. */
  reason: string;
  /** "Since this lesson: the correction came back N times in M matching tasks." Present when the lesson has matching tasks. */
  repeat?: { matched: number; back: number };
}
export interface WeeklyList { needLook: WeeklyRow[]; picks: WeeklyRow[] }

export interface TaskScope { repos: readonly string[]; files: readonly string[]; languages: readonly string[] }
export interface QuestionInfo { revertTasks: number; areaGone: boolean; areaRewritten: boolean }
export interface WeeklyExtras {
  /** Lessons in use under question, with why (`signals.ts`). */
  underQuestion?: ReadonlyMap<string, QuestionInfo>;
  /** Lessons a person was asked to keep after a second quiet window. */
  askedToKeep?: ReadonlyMap<string, number>;
  repeats?: ReadonlyMap<string, { matched: number; back: number }>;
  /** The tasks of the last `WOULD_HAVE_APPLIED_DAYS` days, as their repos, files and languages. Absent: "would have applied" is not known (it is left out of the reason, and is no tie-break). */
  recentTasks?: readonly TaskScope[];
  /** Names for the reason line (developer id to a first name or full name the viewer may see). Absent: "A teammate". */
  people?: ReadonlyMap<string, string>;
}

/** How many of the tasks the lesson's scope would have matched. Unscoped lessons match every task (they are about the whole project). */
export function wouldHaveApplied(lesson: Pick<Lesson, "scope">, tasks: readonly TaskScope[]): number {
  let n = 0;
  for (const task of tasks) if (scopeMatch(lesson as Lesson, task).matches) n += 1;
  return n;
}

/** The lesson's code area as a short label: the first two folders of its first path pattern up to a wildcard, else its first repository, else the whole project. */
export function areaLabelOf(scope: Lesson["scope"]): string {
  const first = (scope.paths ?? [])[0];
  if (first !== undefined) {
    const folders: string[] = [];
    for (const segment of first.replace(/^(?:\.\/|\/)+/u, "").split("/")) {
      if (/[*?{[]/u.test(segment) || segment === "") break;
      folders.push(segment);
      if (folders.length === 2) break;
    }
    // A pattern that starts with a wildcard (`**/*.test.ts`) is about the whole repository, not a folder.
    // (Kept inside the contract's 200 characters.)
    if (folders.length > 0) return `${(scope.repos ?? [])[0] === undefined ? "" : `${scope.repos![0]}:`}${folders.join("/")}`.slice(0, 200);
  }
  return ((scope.repos ?? [])[0] ?? "whole project").slice(0, 200);
}

/** A lesson's own source: the first source its evidence names (a person, CI, a channel), the way spike detection names it. A lesson with none is its own source ("unknown"), so it never fills a source's places for others. */
export const sourceOf = (lesson: Pick<Lesson, "provenance" | "id">): string => normSource(attributableSources(lesson.provenance)[0] ?? lesson.provenance.sources[0] ?? `unknown:${lesson.id}`);

export interface SourceKept { kept: number; decided: number }
/**
 * Per source, over the last `SOURCE_WINDOW_DAYS`: how many of its suggestions a person decided and how many they kept. A kept one has a person's approval in the window; a decided-against one was rejected in the window. A suggestion that
 * lapsed unseen is not a decision. Pure: it counts the lessons it is given.
 */
export function sourceKeptRates(lessons: readonly Lesson[], now: number, windowDays: number = SOURCE_WINDOW_DAYS): Map<string, SourceKept> {
  const since = now - windowDays * DAY;
  const out = new Map<string, SourceKept>();
  for (const lesson of lessons) {
    const approvedAt = lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").reduce<number | undefined>((latest, a) => (latest === undefined || a.at > latest ? a.at : latest), undefined);
    const kept = approvedAt !== undefined && approvedAt >= since;
    const dropped = lesson.status === "rejected" && lesson.updatedAt >= since;
    if (!kept && !dropped) continue;
    const source = sourceOf(lesson);
    const entry = out.get(source) ?? { kept: 0, decided: 0 };
    entry.decided += 1;
    if (kept) entry.kept += 1;
    out.set(source, entry);
  }
  return out;
}
const isNoisy = (stats: SourceKept | undefined): boolean => stats !== undefined && stats.decided >= NOISY_MIN_DECIDED && stats.kept / stats.decided < NOISY_KEPT_RATE;

const BAND_RANK: Record<WeeklyBand, number> = { direct_correction: 1, measured: 2, weak_twice: 3 };
/** The band of a suggestion by where its evidence came from. A person's direct correction beats a measured result; a lesson with neither is a weak source seen twice. */
export function bandOf(lesson: Pick<Lesson, "provenance">): WeeklyBand {
  if (lesson.provenance.memberSignal || lesson.provenance.memberCorrection === true) return "direct_correction";
  if (lesson.provenance.measured) return "measured";
  return "weak_twice";
}

const tasksOf = (lesson: Pick<Lesson, "provenance">): number => new Set(lesson.provenance.supportTasks).size;
const lapsesSoon = (lesson: Pick<Lesson, "pendingExpiresAt">, now: number): boolean => lesson.pendingExpiresAt !== undefined && lesson.pendingExpiresAt - now <= ABOUT_TO_LAPSE_HOURS * HOUR;

function actorWords(lesson: Lesson, people: ReadonlyMap<string, string> | undefined): string {
  const author = lesson.provenance.authors[0];
  const name = author === undefined ? undefined : people?.get(author);
  return name === undefined || name.trim() === "" ? "A teammate" : name.trim();
}

function reasonOf(lesson: Lesson, band: WeeklyBand, noisy: boolean, would: number | undefined, now: number, people: ReadonlyMap<string, string> | undefined): string {
  const kinds = new Set<string>(lesson.provenance.sourceKinds);
  const who = actorWords(lesson, people);
  const parts: string[] = [];
  if (band === "direct_correction") {
    parts.push(kinds.has("remembered") ? `${who} asked Rovara to remember this.`
      : kinds.has("human_edit") ? `${who} edited Rovara's pull request.`
        : kinds.has("send_back") ? `${who} sent Rovara's work back with a reason.`
          : kinds.has("pr_comment") ? `${who}'s review comment led to this.`
            : kinds.has("plan_comment") || kinds.has("design_comment") ? `${who} commented on Rovara's plan.`
              : `${who} corrected Rovara.`);
  } else if (band === "measured") {
    parts.push(kinds.has("ci_failure") ? "A failing check led to this." : "A measured result backs this: a revert, a follow-up fix or a failing check.");
  } else parts.push("A weaker source, seen more than once.");
  const tasks = tasksOf(lesson);
  const people2 = independentSources(lesson.provenance);
  if (tasks >= 2) parts.push(people2 >= 2 ? `Seen in ${tasks} tasks by ${people2} people.` : `Seen in ${tasks} tasks.`);
  if (would !== undefined && would > 0) parts.push(`Would have applied to ${would} ${would === 1 ? "task" : "tasks"} last month.`);
  if (noisy) parts.push("Suggestions from this source are often dropped, so it is listed lower.");
  if (lapsesSoon(lesson, now)) parts.push("It lapses soon.");
  return parts.join(" ");
}

const NEED_PRIORITY: Record<NeedLookCause, number> = { conflict: 0, retire_proposed: 1, revert_overlap: 2, area_gone: 3, area_rewritten: 4, asked_to_keep: 5, sent_back: 6 };
function needLookReason(cause: NeedLookCause, info: QuestionInfo | undefined): string {
  switch (cause) {
    case "conflict": return "It conflicts with a lesson that is in use now. Decide which one stays.";
    case "retire_proposed": return "People marked it wrong here. Retire it?";
    case "revert_overlap": return `${info !== undefined && info.revertTasks > 1 ? `${info.revertTasks} changes in its area were reverted` : "A change in its area was reverted"}. Check it still holds.`;
    case "area_gone": return "The code area it is about is gone. Check it still applies.";
    case "area_rewritten": return "The code area it is about was rewritten. Check this is still true.";
    case "asked_to_keep": return "No task has needed it for a long time. Keep it?";
    case "sent_back": return "It was sent back to a person for a decision.";
  }
}

/**
 * The week's list. `lessons` are the lessons the viewer may read (the digest's visible set): suggestions are the `pending` ones; need-a-look cards come from lessons in use and from a suggestion that conflicts with one in use.
 * Never throws; the same input gives the same list (no clock but `now`, no randomness). A row names no source and no person: the source decides only the order and the spread.
 */
export function orderWeekly(input: { lessons: readonly Lesson[]; now: number; extras?: WeeklyExtras; /** Each source's decided and kept suggestions of the month, counted over every lesson of the project (counts only, nothing of a lesson leaves); absent: counted over `lessons`. */ keptStats?: ReadonlyMap<string, SourceKept>; picks?: number; needLookMax?: number; maxPerArea?: number; maxPerSource?: number }): WeeklyList {
  const { lessons, now } = input;
  const extras = input.extras ?? {};
  const byId = new Map(lessons.map((l) => [l.id, l] as const));
  const kept = input.keptStats ?? sourceKeptRates(lessons, now);
  const row = (lesson: Lesson, over: Partial<WeeklyRow> & { reason: string }): WeeklyRow => ({
    id: lesson.id, title: lesson.title, type: lesson.type, area: areaLabelOf(lesson.scope), ...over,
    ...(extras.repeats?.get(lesson.id) !== undefined && extras.repeats.get(lesson.id)!.matched > 0 ? { repeat: extras.repeats.get(lesson.id)! } : {}),
  });

  // ---- need a look (uncounted)
  const need: Array<{ lesson: Lesson; cause: NeedLookCause; info?: QuestionInfo }> = [];
  for (const lesson of lessons) {
    const partner = lesson.contradictsWith === undefined ? undefined : byId.get(lesson.contradictsWith);
    if (lesson.status === "pending" && partner !== undefined && partner.status === "active") { need.push({ lesson, cause: "conflict" }); continue; }
    if (lesson.status !== "active") continue;
    const info = extras.underQuestion?.get(lesson.id);
    if (lesson.retireProposedAt !== undefined) need.push({ lesson, cause: "retire_proposed" });
    else if (info !== undefined && info.revertTasks > 0) need.push({ lesson, cause: "revert_overlap", info });
    else if (info?.areaGone === true) need.push({ lesson, cause: "area_gone", info });
    else if (info?.areaRewritten === true) need.push({ lesson, cause: "area_rewritten", info });
    else if (extras.askedToKeep?.has(lesson.id) === true) need.push({ lesson, cause: "asked_to_keep" });
    else if (lesson.reviewRequired === true) need.push({ lesson, cause: "sent_back" });
  }
  need.sort((a, b) => NEED_PRIORITY[a.cause] - NEED_PRIORITY[b.cause] || (b.info?.revertTasks ?? 0) - (a.info?.revertTasks ?? 0) || a.lesson.id.localeCompare(b.lesson.id));
  const needLook = need.slice(0, input.needLookMax ?? WEEKLY_NEED_LOOK_MAX).map((n) => row(n.lesson, { cause: n.cause, reason: needLookReason(n.cause, n.info) }));

  // ---- the five suggestions
  type Candidate = { lesson: Lesson; band: WeeklyBand; rank: number; noisy: boolean; would: number | undefined; people: number; tasks: number; lonePreference: boolean };
  const candidates: Candidate[] = lessons.filter((l) => l.status === "pending").map((lesson) => {
    const band = bandOf(lesson);
    const noisy = isNoisy(kept.get(sourceOf(lesson)));
    const people = independentSources(lesson.provenance);
    return {
      lesson, band, noisy, rank: BAND_RANK[band] + (noisy ? 1 : 0), people, tasks: tasksOf(lesson), would: extras.recentTasks === undefined ? undefined : wouldHaveApplied(lesson, extras.recentTasks),
      lonePreference: lesson.type === "preference" && people <= 1,
    };
  });
  candidates.sort((a, b) =>
    a.rank - b.rank
    || Number(a.lonePreference) - Number(b.lonePreference)
    || b.people - a.people
    || b.tasks - a.tasks
    || (b.would ?? 0) - (a.would ?? 0)
    || severityOfType(b.lesson.type) - severityOfType(a.lesson.type)
    || Number(lapsesSoon(b.lesson, now)) - Number(lapsesSoon(a.lesson, now))
    || b.lesson.updatedAt - a.lesson.updatedAt
    || a.lesson.createdAt - b.lesson.createdAt
    || a.lesson.id.localeCompare(b.lesson.id));
  const picks: WeeklyRow[] = [];
  const perArea = new Map<string, number>();
  const perSource = new Map<string, number>();
  for (const c of candidates) {
    if (picks.length >= (input.picks ?? WEEKLY_PICKS)) break;
    const area = areaLabelOf(c.lesson.scope);
    const source = sourceOf(c.lesson);
    if ((perArea.get(area) ?? 0) >= (input.maxPerArea ?? WEEKLY_MAX_PER_AREA) || (perSource.get(source) ?? 0) >= (input.maxPerSource ?? WEEKLY_MAX_PER_SOURCE)) continue;
    perArea.set(area, (perArea.get(area) ?? 0) + 1);
    perSource.set(source, (perSource.get(source) ?? 0) + 1);
    picks.push(row(c.lesson, { band: c.band, rank: c.rank, reason: reasonOf(c.lesson, c.band, c.noisy, c.would, now, extras.people) }));
  }
  return { needLook, picks };
}

