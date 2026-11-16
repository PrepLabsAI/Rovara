// The Home number (lessons holistic review, fix 4): "Corrections you had to repeat: X of Y this month", for one project or for the whole company. It is the engine's "same mistake twice" measure
// (`lessons/metric.ts`) over the correction log (`lessons/correction-log.ts`) with the signature matcher: no model, no spend, counts only (no correction or lesson text, no task ids).
//
//   GET /v1/dev/projects/{project}/lessons/repeats?month=YYYY-MM   anyone on the project's roster
//   GET /v1/dev/lessons/repeats?month=YYYY-MM                      an owner or admin of the company (the sum over the company's projects)
//
// `month` is a UTC calendar month, the current one by default; a month after the current one is refused. The current month is measured up to now.
// Rules (the lessons API's, `lessons-api.ts`): the switch first (off reads nothing, not even membership); the company comes ONLY from live membership (`companyOf`); every read goes through that company's
// lessons and log; another company's project, or one the person is not on, is "No such project."; refusals are fixed words, nothing a caller sent is echoed. Nothing here writes, so nothing is audited.
// Bounded: one project's measure is held to the measure's own limits (2,000 corrections, 500 lessons, a matcher-call cap); the company's sum reads at most `COMPANY_PROJECTS_MAX` projects and stops
// starting new ones after `deadlineMs`, and says `truncated` when either cut it short.
import { AgentXError, AgentXNameSchema, OrgIdSchema, OrgRoleSchema, agentXError, type OrgId, type OrgRole } from "@agentx/contracts";
import { z } from "zod";
import { correctionLogSource, readSignatureKey, signatureMatcher } from "../lessons/correction-log.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { METRIC_MIN_CORRECTIONS, sameMistakeTwice, type SameMistakeTwice } from "../lessons/metric.js";
import type { CoreLessons } from "./lessons.js";
import { switchCovers, type CoreSwitch } from "./flags.js";
import { LESSONS_OFF, NO_SUCH_PROJECT } from "./lessons-api.js";

const PROJECT_PATH = /^\/v1\/dev\/projects\/([^/]+)\/lessons\/repeats$/u;
const COMPANY_PATH = "/v1/dev/lessons/repeats";
/** Whether a path is one of this API's (the dev router asks before it hands a request here). */
export const isLessonsRepeatsPath = (path: string): boolean => path === COMPANY_PATH || PROJECT_PATH.test(path);

export const COMPANY_NUMBER_NEEDS_ADMIN = "Only an owner or admin of the company can see the company's number.";
export const COMPANY_PROJECTS_MAX = 50;
export const REPEATS_DEADLINE_MS = 20_000;
const SIGN_IN_AGAIN = "Sign in again.";
const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
const MonthQuery = z.object({ month: z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/u).optional() }).strict();

export interface LessonsRepeatsCaller { personId: string }
/** What this API needs of one company's lessons. */
export type LessonsRepeatsCompany = Pick<CoreLessons, "companyId" | "runtime" | "projectExists">;
export interface LessonsRepeatsOptions {
  lessonsSwitch: CoreSwitch;
  /** The caller's company and live role, from membership. Undefined, malformed or a throw: sign in again. */
  companyOf(caller: LessonsRepeatsCaller): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The lessons of a company the switch covers. Undefined: lessons are off for it. */
  lessonsOf(companyId: OrgId): Promise<LessonsRepeatsCompany | undefined>;
  people: Pick<HostedLessonPeople, "onProjectRoster">;
  /** Every project of the company (`companyProjects`). */
  projectsOf(companyId: OrgId): Promise<string[]>;
  now: () => number;
  /** Tests: the company sum's deadline (default `REPEATS_DEADLINE_MS`). */
  deadlineMs?: number;
}
export interface LessonsRepeatsRequest { method: string; path: string; query?: URLSearchParams | undefined }
export interface LessonsRepeatsApi { answer(request: LessonsRepeatsRequest, caller: LessonsRepeatsCaller): Promise<unknown> }

/** The answer's counts: "X of Y" is `repeated` of `corrections`; `enoughData` is false below the measure's minimum (the screen then says "Not enough corrections yet"). */
export interface RepeatCounts {
  month: string; repeated: number; corrections: number; enoughData: boolean;
  split: { lessonLoaded: number; lessonNotLoaded: number; noLesson: number };
  unjudged: number; truncated: boolean;
}

const notFound = (message: string): AgentXError => agentXError("NOT_FOUND", message);

/** The month's window: [first instant, the next month's first instant), cut at now for the current month. */
function windowOf(month: string | undefined, now: number): { month: string; sinceMs: number; untilMs: number } {
  const today = new Date(now);
  const current = `${String(today.getUTCFullYear()).padStart(4, "0")}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const chosen = month ?? current;
  if (chosen > current) throw agentXError("CONFIG_INVALID", "month is a month that has started, as YYYY-MM");
  const [year, monthNumber] = chosen.split("-").map(Number) as [number, number];
  const sinceMs = Date.UTC(year, monthNumber - 1, 1);
  const end = Date.UTC(year, monthNumber, 1);
  return { month: chosen, sinceMs, untilMs: Math.max(sinceMs + 1, Math.min(end, now)) };
}

async function measure(lessons: LessonsRepeatsCompany, companyId: OrgId, project: string, window: { sinceMs: number; untilMs: number }): Promise<SameMistakeTwice> {
  const documents = lessons.runtime.documents;
  const key = await readSignatureKey(documents, companyId, project);
  return await sameMistakeTwice({ corrections: correctionLogSource(documents, companyId), matcher: signatureMatcher(key), store: lessons.runtime.store }, { workspaceId: companyId, project }, window);
}

const countsOf = (month: string, m: Pick<SameMistakeTwice, "repeats" | "corrections" | "split" | "unjudged" | "truncated">): RepeatCounts => ({
  month, repeated: m.repeats, corrections: m.corrections, enoughData: m.corrections >= METRIC_MIN_CORRECTIONS,
  split: { lessonLoaded: m.split.lessonLoaded, lessonNotLoaded: m.split.lessonNotLoaded, noLesson: m.split.noLesson }, unjudged: m.unjudged, truncated: m.truncated,
});

export function createLessonsRepeatsApi(options: LessonsRepeatsOptions): LessonsRepeatsApi {
  async function answer(request: LessonsRepeatsRequest, caller: LessonsRepeatsCaller): Promise<unknown> {
    const projectMatch = PROJECT_PATH.exec(request.path);
    if ((projectMatch === null && request.path !== COMPANY_PATH) || request.method !== "GET") throw notFound("route not found");
    // The switch first: off reads nothing at all, not even who is asking.
    if (options.lessonsSwitch.mode === "off") throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    let found: unknown;
    try { found = await options.companyOf(caller); } catch { found = undefined; }
    const record = found as { companyId?: unknown; role?: unknown } | undefined | null;
    const company = OrgIdSchema.safeParse(record?.companyId);
    const role = OrgRoleSchema.safeParse(record?.role);
    if (!company.success || !role.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    const companyId = company.data;
    if (!switchCovers(options.lessonsSwitch, companyId)) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    let lessons: LessonsRepeatsCompany | undefined;
    try { lessons = await options.lessonsOf(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (lessons === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    // The lessons handed back must be the member company's own.
    if (lessons.companyId !== companyId) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);

    const keys = [...(request.query?.keys() ?? [])];
    const query = MonthQuery.safeParse(Object.fromEntries(request.query?.entries() ?? []));
    if (!query.success || keys.length !== new Set(keys).size) throw agentXError("CONFIG_INVALID", "repeats takes month (YYYY-MM), once");
    const window = windowOf(query.data.month, options.now());

    if (projectMatch !== null) {
      let project: string;
      try { project = decodeURIComponent(projectMatch[1]!); } catch { throw notFound(NO_SUCH_PROJECT); }
      if (!AgentXNameSchema.safeParse(project).success) throw notFound(NO_SUCH_PROJECT);
      let exists: boolean;
      let onRoster: boolean;
      try { [exists, onRoster] = await Promise.all([lessons.projectExists(project), options.people.onProjectRoster(companyId, project, caller.personId)]); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
      if (!exists || !onRoster) throw notFound(NO_SUCH_PROJECT);
      return { project, ...countsOf(window.month, await measure(lessons, companyId, project, window)) };
    }

    // The company's number: owners and admins, read live.
    if (role.data !== "owner" && role.data !== "admin") throw agentXError("FORBIDDEN", COMPANY_NUMBER_NEEDS_ADMIN);
    let projects: string[];
    try { projects = (await options.projectsOf(companyId)).slice().sort(); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    const total = { repeats: 0, corrections: 0, split: { lessonLoaded: 0, lessonNotLoaded: 0, noLesson: 0 }, unjudged: 0, truncated: projects.length > COMPANY_PROJECTS_MAX };
    const deadlineAt = Date.now() + (options.deadlineMs ?? REPEATS_DEADLINE_MS);
    let counted = 0;
    for (const project of projects.slice(0, COMPANY_PROJECTS_MAX)) {
      if (Date.now() >= deadlineAt) { total.truncated = true; break; }
      const one = await measure(lessons, companyId, project, window);
      total.repeats += one.repeats; total.corrections += one.corrections; total.unjudged += one.unjudged;
      total.split.lessonLoaded += one.split.lessonLoaded; total.split.lessonNotLoaded += one.split.lessonNotLoaded; total.split.noLesson += one.split.noLesson;
      if (one.truncated) total.truncated = true;
      counted += 1;
    }
    return { scope: "company", projects: counted, ...countsOf(window.month, total) };
  }

  return {
    async answer(request, caller) {
      try { return await answer(request, caller); }
      catch (error) {
        if (error instanceof AgentXError) throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      }
    },
  };
}
