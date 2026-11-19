// For lessons, a task's audience is who can open it, and a lesson reaches an agent only if everyone who can see the running task can see every task the lesson was learned from. The audience is held as the few things
// that DIFFER between tasks (denials, named people, wider shares) plus a one-person roster check: the project's roster is never listed, because within one project it cancels out. Anything that cannot be read is
// "unknown" and the lesson is withheld.
//
// Code runs as one person (`localLessonAudiencePort`): every task is the owner's and open to the whole project. A hosted install fills `LessonAudiencePort` from its sessions, shares and people lists, and the
// comparisons below are the same.
import type { OrgId } from "@agentx/contracts";

/**
 * A task of this company that has no session item at all: it was started before sessions existed (a legacy task). It has no session access to follow, so its audience is unknown and the lessons learned from it are
 * withheld (fail closed). Kept apart from every other unreadable answer so the owner can be told how many lessons wait for this reason .
 */
export class LegacyTaskNoSessionError extends Error {
  constructor() { super("lessons: the task has no session item"); this.name = "LegacyTaskNoSessionError"; }
}

export interface LessonTaskAudience {
  project: string;
  /** People the task's People list denies: they can't open the task, whatever else says. */
  denied: ReadonlySet<string>;
  /** People who reach the task by name: its owner, member shares, People entries that are not "denied". Minus denied. */
  extras: ReadonlySet<string>;
  /** Shared with the whole company. */
  orgWide: boolean;
  /** Projects other than its own that the task is shared with. */
  otherProjects: ReadonlySet<string>;
  /**
   * Whether `person` is on the task's project roster now: an org owner or admin, or a member holding a grant. ONE person is read (their org member row, then their grant), never the whole roster: within one
   * project the roster is the same for every task, so a comparison of two tasks of a project only ever needs the few people who DIFFER. The answer is remembered for the rest of the request, and `signal` stops the reads.
   * Throws when it cannot be read.
   */
  onRoster(person: string, signal?: AbortSignal): Promise<boolean>;
}

/** Whether `person` can open a task with this audience. May throw (an unreadable roster entry). */
export async function inAudience(audience: LessonTaskAudience, person: string, signal?: AbortSignal): Promise<boolean> {
  if (audience.denied.has(person)) return false;
  return audience.orgWide || audience.extras.has(person) || await audience.onRoster(person, signal);
}

/** The task is visible to the whole project, with no People denial. (The project is the caller's to compare: `audience.project`.) */
export function openToWholeProject(audience: LessonTaskAudience): boolean {
  return audience.denied.size === 0;
}

/**
 * Whether EVERY person who can see `inner` can also see `outer` (audience(inner) is a subset of audience(outer)). Never wider than the truth: different projects, a denial of `outer` that `inner` does not repeat
 * (a person the lesson's task hides could still open the running one), a wider share, or a person who reaches `inner` by name but not `outer` all say no.
 *
 * Within one project the roster cancels out, so only the people that DIFFER are compared (audience(T) = roster minus T.denied, plus T's named people, plus its wider shares):
 *   1. everyone `outer` denies, `inner` also denies (so a roster member `inner` lets in is not denied by `outer`; this also covers people who open project tasks without a roster row: the project's Slack channel,
 *      an Auditor with a grant, a merged id);
 *   2. `inner`'s shares go no wider than `outer`'s (the company; other projects, unless `outer` is company-wide);
 *   3. everyone `inner` names (not denied by it) can open `outer`: named on it, `outer` is company-wide, or on the project's roster (one read per person, not the roster).
 * Throws when a person cannot be read.
 */
export async function audienceWithin(inner: LessonTaskAudience, outer: LessonTaskAudience, signal?: AbortSignal): Promise<boolean> {
  if (inner.project !== outer.project) return false;
  for (const person of outer.denied) if (!inner.denied.has(person)) return false;
  if (inner.orgWide && !outer.orgWide) return false;
  if (!outer.orgWide) for (const project of inner.otherProjects) if (!outer.otherProjects.has(project)) return false;
  for (const person of inner.extras) if (!await inAudience(outer, person, signal)) return false;
  return true;
}

/** The people whose roster rows were read during one request: one answer per (project, person). */
export type RosterMemo = Map<string, Promise<boolean>>;

/** The live audiences of tasks. A task missing from the answer, or mapped to `undefined`, is unknown. May throw: that reads as unknown for every task asked about. */
export interface LessonAudiencePort {
  /** `signal` aborts when the caller stops waiting: the port should start no new reads then. `memo` keeps the roster answers (one per person) for the rest of the request. */
  read(orgId: OrgId, taskIds: readonly string[], options?: { signal?: AbortSignal; memo?: RosterMemo; /** Filled with the ids of tasks that have no session item (legacy tasks); they are also absent from the answer. */ legacy?: Set<string> }): Promise<ReadonlyMap<string, LessonTaskAudience | undefined>>;
}

/**
 * The audience port of one person on one machine: every task of the install is the owner's and is open to the whole project (the project's one member), with no denials and no shares. A task
 * that no longer exists, or that belongs to another project than the one it is asked in, is unknown (withheld). `projectOf` reads a task's project from its record.
 */
export function localLessonAudiencePort(input: { ownerId: string; projectOf(orgId: OrgId, taskId: string): Promise<string | undefined> }): LessonAudiencePort {
  return {
    async read(orgId, taskIds, options) {
      const out = new Map<string, LessonTaskAudience | undefined>();
      for (const id of new Set(taskIds)) {
        if (options?.signal?.aborted === true) break;
        try {
          const project = await input.projectOf(orgId, id);
          out.set(id, project === undefined ? undefined : { project, denied: new Set(), extras: new Set([input.ownerId]), orgWide: false, otherProjects: new Set(), onRoster: async (person) => person === input.ownerId });
        } catch { out.set(id, undefined); }
      }
      return out;
    },
  };
}

/**
 * The lesson-audience port rides on the task-visibility port the access check carries, so the shared access port (`access-port.ts`) and the Team record's port types stay exactly as they were.
 * A port without it (a test stub, an older wiring) gives no audiences, and every lesson that names a task is then withheld.
 */
export interface WithLessonAudiences { lessonAudiences: LessonAudiencePort }

export function withLessonAudiences<T extends object>(port: T, audiences: LessonAudiencePort): T & WithLessonAudiences {
  return Object.assign(Object.create(Object.getPrototypeOf(port) as object | null), port, { lessonAudiences: audiences }) as T & WithLessonAudiences;
}

export function lessonAudiencesOf(port: object | undefined): LessonAudiencePort | undefined {
  const found = (port as Partial<WithLessonAudiences> | undefined)?.lessonAudiences;
  return found !== undefined && typeof found.read === "function" ? found : undefined;
}
