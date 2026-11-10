// A lesson learned from a task keeps the audience the task had when it was reflected, and nothing in a project-wide lesson names the task except
// `provenance.supportTasks` and the Rovara source events (`rovara:task:<id>...`, or the source id `task:<id>...`). If the task is narrowed afterwards (Plan 5 visibility), the lesson, which was
// written from the task's send-back reasons and notes, would still reach every agent and every screen of the project. So a lesson is also checked against the LIVE audience of every task
// it was learned from, each time it is read.
//
// One rule, one module. The audience of a task is "who can open its session" (`task-audience.ts`); the Team record's own resolver is NOT used here. `keep` has three readers:
//   - an AGENT (`running` is given): the audience of the RUNNING task T. A lesson reaches T only if EVERY person who can see T can see EVERY source task P (audience(T) is a subset of audience(P)). If T's audience
//     cannot be read (a failed or timed-out read, a task that is gone or another company's, past the bound, no audience port, or no task id at all) NO lesson that names a task is kept: there is no weaker rule to
//     fall back to (a fallback would let a lesson from a narrow task reach a company-wide task);
//   - a PERSON (`viewer` has a developer id): the lesson is kept if that person can open every source task's session;
//   - NOBODY in particular (a path whose readers are everyone: the PR "Lessons used" names, publishing a lesson): kept only if every source task, in the lesson's own project, is open to the whole project with no People
//     denial, read live.
// Fail closed: no port, a read that fails or times out, a task that is gone, another company's, past the per-request bound or unreadable, a task id that is malformed: the lesson is withheld. Logs carry counts and
// fixed codes, never ids.
//
// `readVisible` (read-visible.ts) calls it, and every lesson read already goes through `readVisible` (tests/unit/lessons/read-paths.test.ts). A new path that hands a lesson to a person or to an
// agent WITHOUT `readVisible` (the PR "Lessons used" list, publishing a lesson to a repository) must call `liveVisible` with the reader of that path (`undefined` for something everyone in the
// project will read) and use only what it returns.
import { OrgIdSchema } from "@agentx/contracts";
import type { TaskVisibilityPort } from "./access-port.js";
import { audienceWithin, inAudience, lessonAudiencesOf, openToWholeProject, type LessonTaskAudience, type RosterMemo } from "./task-audience.js";
import { projectRepoScopesOf } from "./project-repo-audience.js";
import type { LessonLog } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { lessonPlaces, type IdentitySet, type Lesson } from "./types.js";

/** The most distinct source tasks one call looks up. A lesson learned from a task past it is withheld. */
export const LESSON_LIVE_TASKS_MAX = 300;
/** How long ONE check (`keep`: the batched lookup and the comparison after it, together) may take before every lesson that names a task is withheld. */
export const LESSON_LIVE_TIMEOUT_MS = 8_000;

// The shape of a task id (the same as `live-audience.ts`): anything else cannot be asked about, so a lesson that names one is withheld.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const EVENT_TASK = /^(?:rovara:)?task:([^:]*)/;
const TASK_PLACE = /^rovara:task\/([^/]*)/;

export interface LessonTaskRefs {
  taskIds: string[];
  /** The lesson names a task that cannot be read from it (a malformed id): it is withheld. */
  unreadable: boolean;
}

/** Every task a lesson was learned from: `supportTasks`, the tasks behind lessons loaded into its task (`inheritedTasks`), task citations, the Rovara events it cites (`sourceEvents`, record citations) and any `rovara:task/<id>` place. Pure. */
export function lessonTaskRefs(lesson: Pick<Lesson, "provenance" | "citations">): LessonTaskRefs {
  const ids = new Set<string>();
  let unreadable = false;
  const take = (id: string | undefined): void => {
    if (id !== undefined && TASK_ID.test(id)) ids.add(id);
    else unreadable = true;
  };
  for (const id of lesson.provenance.supportTasks) take(id);
  for (const id of lesson.provenance.inheritedTasks ?? []) take(id);
  for (const citation of lesson.citations) {
    if (citation.kind === "task") take(citation.taskId);
  }
  const events = [...lesson.provenance.sourceEvents, ...lesson.citations.flatMap((citation) => (citation.kind === "record" ? [citation.eventId] : []))];
  for (const event of events) {
    const match = EVENT_TASK.exec(event);
    if (match !== null) take(match[1]);
  }
  for (const place of lessonPlaces(lesson).scopes) {
    const match = TASK_PLACE.exec(place);
    if (match !== null) take(match[1]);
  }
  return { taskIds: [...ids], unreadable };
}

/** A reader of many calls in one request: the audiences it has looked up are remembered, so the same task is never read twice and the bound counts only the lessons checked. */
export interface LessonLiveReader {
  /** The lessons of `lessons` whose source tasks are all still visible to the reader now (see the top of this file), in their order. Never throws. */
  keep(viewer: Pick<IdentitySet, "developerId"> | undefined, lessons: readonly Lesson[]): Promise<Lesson[]>;
  /**
   * A reader for NOBODY in particular that shares what this one has looked up: the audiences and roster answers already read are not read again. For a path that checks the same source tasks twice, once
   * for the running task and once for the repository's readers (the pull request description), so each source task is read once per request.
   */
  withoutRunningTask(): LessonLiveReader;
  /**
   * the places (`<source>:repo/<id>`) of the repositories the lesson's project has NOW, read live from the project definition, once per request (a failed read is not remembered). `undefined` when
   * they cannot be read (no port, an unreadable definition, past the deadline): nothing is then treated as a project repository, so a lesson restricted to repository readers stays restricted.
   */
  projectRepos(): Promise<ReadonlySet<string> | undefined>;
  /**
   * Review: the ids of the lessons this reader (and the readers it shares reads with) withheld because a task they were learned from is a LEGACY task with no session item, so its audience is unknown. Such a lesson is
   * correctly kept out (fail closed); the count lets a person who decides see how many are waiting for that reason.
   */
  legacyWithheld(): readonly string[];
}

export interface LessonLiveReaderInput {
  /** The access port's task-visibility port; the lesson audiences ride on it (`withLessonAudiences`). Without them every lesson that names a task is withheld. */
  port: TaskVisibilityPort | undefined; key: ScopeKey; where: string;
  /**
   * Present: the lessons are for an AGENT, and the reader is the audience of this running task. `taskId` is undefined for a stage that was queued without one: then nothing that names a task is kept.
   * Absent: the viewer rule (a person, or nobody in particular).
   */
  running?: { taskId: string | undefined } | undefined;
  log?: LessonLog | undefined; /** Tests and the loader's own deadline (a function gives the time left for each lookup). */ timeoutMs?: number | (() => number) | undefined; maxTasks?: number | undefined;
}

/**
 * One reader per request. Lessons that name no task pass untouched (and no read is made when none names one). Anything that cannot be read withholds the lessons it affects. `where` names the
 * caller in the log line.
 */
export function createLessonLiveReader(input: LessonLiveReaderInput): LessonLiveReader {
  return buildReader(input, { audiences: new Map<string, LessonTaskAudience | undefined>(), memo: new Map<string, Promise<boolean>>(), repos: {}, legacyTasks: new Set<string>(), legacyLessons: new Set<string>() });
}

/** What readers of one request share: the audiences looked up (one read per task) and the roster answers (one read per person). */
interface SharedReads { audiences: Map<string, LessonTaskAudience | undefined>; memo: RosterMemo; repos: { read?: Promise<ReadonlySet<string> | undefined> }; /** Tasks found to have no session item. */ legacyTasks: Set<string>; /** Lessons withheld because they name one. */ legacyLessons: Set<string> }

function buildReader(input: LessonLiveReaderInput, shared: SharedReads): LessonLiveReader {
  const org = OrgIdSchema.safeParse(input.key.workspaceId);
  const audiencePort = lessonAudiencesOf(input.port);
  const maxTasks = input.maxTasks ?? LESSON_LIVE_TASKS_MAX;
  const withheld = (count: number, reason: string): void => { input.log?.(`learning.${input.where}_live_withheld`, { lessons: count, reason }); };
  const unreadable = (reason: string, tasks?: number): void => { input.log?.(`learning.${input.where}_audience_unreadable`, tasks === undefined ? { reason } : { reason, tasks }); };

  // Audiences: read once per task per request, with the same bound, per-read time and abort for every read of the request.
  const { audiences, memo } = shared;
  const verdicts = new Map<string, Promise<boolean>>();
  const timeLeft = (): number => (typeof input.timeoutMs === "function" ? input.timeoutMs() : input.timeoutMs ?? LESSON_LIVE_TIMEOUT_MS);
  /** `run` with a deadline `limit()` ms away: when it passes, `run`'s signal aborts (no new read starts, a read in flight is cut) and the wait ends. */
  const bounded = async <T,>(limit: () => number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = run(abort.signal);
      work.catch(() => undefined);
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("timed out")); }, limit()); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const loadAudiences = async (ids: Iterable<string>, limit: () => number): Promise<void> => {
    if (!org.success || audiencePort === undefined) return;
    const fresh: string[] = [];
    for (const id of ids) {
      if (audiences.has(id) || fresh.includes(id)) continue;
      if (audiences.size + fresh.length >= maxTasks) { unreadable("bound"); continue; }
      fresh.push(id);
    }
    if (fresh.length === 0) return;
    for (const id of fresh) audiences.set(id, undefined);
    try {
      const found = await bounded(limit, (signal) => audiencePort.read(org.data, fresh, { signal, memo, legacy: shared.legacyTasks }));
      for (const id of fresh) audiences.set(id, found.get(id));
    } catch (error) {
      unreadable(error instanceof Error && error.message === "timed out" ? "timeout" : "error", fresh.length);
    }
  };

  return {
    withoutRunningTask: () => buildReader({ ...input, running: undefined }, shared),
    legacyWithheld: () => [...shared.legacyLessons],
    projectRepos() {
      const repoPort = projectRepoScopesOf(input.port);
      if (!org.success || repoPort === undefined) {
        unreadable("no_project_repos");
        return Promise.resolve(undefined);
      }
      if (shared.repos.read === undefined) {
        const read = bounded(timeLeft, () => repoPort.read(org.data, input.key.project)).catch((error: unknown) => {
          unreadable(error instanceof Error && error.message === "timed out" ? "timeout" : "project_repos_error");
          if (shared.repos.read === read) delete shared.repos.read;
          return undefined;
        });
        shared.repos.read = read;
      }
      return shared.repos.read;
    },
    async keep(viewer, lessons) {
      const refs = lessons.map((lesson) => lessonTaskRefs(lesson));
      const names = (index: number): boolean => refs[index]!.taskIds.length > 0 || refs[index]!.unreadable;
      const named = lessons.filter((_, index) => names(index));
      if (named.length === 0) return [...lessons];
      const unnamed = (): Lesson[] => lessons.filter((_, index) => !names(index));
      if (!org.success || audiencePort === undefined) {
        withheld(named.length, org.success ? "no_port" : "bad_org");
        return unnamed();
      }
      // ONE deadline for this whole check: the audience read and the comparison after it share it (and the caller's own deadline, when it gives one as a function).
      const deadline = Date.now() + timeLeft();
      const remaining = (): number => Math.max(1, Math.min(deadline - Date.now(), timeLeft()));
      const running = input.running;
      const runningId = running?.taskId;
      if (running !== undefined && (runningId === undefined || !TASK_ID.test(runningId))) {
        // A stage with no (usable) task id has no audience to compare: there is no weaker reader to fall back to.
        withheld(named.length, "running_unknown");
        return unnamed();
      }
      const person = running !== undefined ? undefined : viewer?.developerId;
      const who = person === undefined || person === "" ? undefined : person;
      await loadAudiences([...(runningId === undefined ? [] : [runningId]), ...refs.flatMap((ref) => ref.taskIds)], remaining);
      const runningAudience = runningId === undefined ? undefined : audiences.get(runningId);
      if (running !== undefined && runningAudience === undefined) {
        // The running task's audience can't be read: nothing that names a task is kept.
        withheld(named.length, "running_unreadable");
        return unnamed();
      }
      /** Whether this reader may see the source task `id` (cached per request). May throw (an unreadable roster entry). */
      const allowed = (id: string, signal: AbortSignal): Promise<boolean> => {
        // The answer depends on WHO is reading (the running task, a person, or nobody in particular): the key says which, so a reader asked for two viewers never hands one the other's answer.
        const cacheKey = `${running !== undefined ? `running:${runningId ?? ""}` : who !== undefined ? `person:${who}` : "nobody"}\u0000${id}`;
        let known = verdicts.get(cacheKey);
        if (known === undefined) {
          const source = audiences.get(id);
          known = source === undefined ? Promise.resolve(false)
            : runningAudience !== undefined ? audienceWithin(runningAudience, source, signal)
            : who !== undefined ? inAudience(source, who, signal)
            : Promise.resolve(source.project === input.key.project && openToWholeProject(source));
          verdicts.set(cacheKey, known);
          known.catch(() => { if (verdicts.get(cacheKey) === known) verdicts.delete(cacheKey); });
        }
        return known;
      };
      let ok: boolean[];
      try {
        ok = await bounded(remaining, async (signal) => {
          const out: boolean[] = [];
          for (let index = 0; index < lessons.length; index += 1) {
            if (!names(index)) { out.push(true); continue; }
            const ref = refs[index]!;
            let pass = !ref.unreadable;
            for (const id of ref.taskIds) { if (!pass) break; pass = await allowed(id, signal); }
            out.push(pass);
          }
          return out;
        });
      } catch (error) {
        // A roster entry that cannot be read (or a deadline that passed) answers "no" for everything that names a task.
        unreadable(error instanceof Error && error.message === "timed out" ? "timeout" : "error");
        withheld(named.length, "audience_unreadable");
        return unnamed();
      }
      const count = lessons.filter((_, index) => names(index) && !ok[index]).length;
      if (count > 0) withheld(count, "task_not_visible");
      // Review: of those, the lessons learned from a legacy task with no session item (counted apart, once per lesson per request).
      const legacy = lessons.filter((lesson, index) => names(index) && !ok[index] && refs[index]!.taskIds.some((id) => shared.legacyTasks.has(id)) && !shared.legacyLessons.has(lesson.id));
      for (const lesson of legacy) shared.legacyLessons.add(lesson.id);
      if (legacy.length > 0) input.log?.(`learning.${input.where}_legacy_task_withheld`, { lessons: legacy.length });
      return lessons.filter((_, index) => ok[index]);
    },
  };
}

/**
 * The lessons of `lessons` whose source tasks are all still visible to `viewer` now, in their order (one call of a fresh reader). Never throws: anything that cannot be read withholds the lessons it
 * affects. `where` names the caller in the log line.
 */
export async function liveVisible(input: LessonLiveReaderInput & { viewer: Pick<IdentitySet, "developerId"> | undefined; lessons: readonly Lesson[] }): Promise<Lesson[]> {
  return createLessonLiveReader(input).keep(input.viewer, input.lessons);
}
