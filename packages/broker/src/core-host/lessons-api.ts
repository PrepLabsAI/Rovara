// Lane LM8 part 1 (DEC 225/226): the Code lessons API that Cloud's lessons screens call, for ONE project of the caller's OWN company. The dev route table (`aws/dev-route-scopes.ts`) has a row for each
// route below (full access only, like the other company-admin routes); `aws/developer-routes.ts` authenticates the caller and hands the request here through its optional `lessons` dependency
// (absent: every route answers "Lessons are off."). The deployed wiring (Step 6) builds this with `createLessonsApi` for the install.
//
//   GET  /v1/dev/projects/{project}/lessons?list=proposed|approved|retired&since=<ms>&limit=1..50&cursor=<next>   one page of one list (since: created at or after); each lesson's `usedInTasks` = distinct tasks given it
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/approve          { version, edit? }                   Keep: a person approves the version they read, or an edit of it (title, description, body)
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/reject           { version, reason }                  Drop: reason is one of REJECT_REASONS (fixed words, never a person's text)
//   POST /v1/dev/projects/{project}/lessons/decisions                   { decisions: [...] }                 Keep or Drop for up to 20 proposed lessons at once (the inbox's batch row); one answer each
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/retire           { reason }                           reason: one of RETIRE_REASONS; clears the lesson's retire request
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/retire-request   {}                                   anyone on the project asks the people who decide to retire it
//   GET  /v1/dev/projects/{project}/lessons/retire-requests                                                  the open requests (people who decide)
//   GET  /v1/dev/projects/{project}/tasks/{taskId}/lessons                                                   the lessons a task was given ("Lessons used")
//   POST /v1/dev/projects/{project}/tasks/{taskId}/lessons/{lessonId}/not-helpful   {}                       a person on the project marks a lesson the task was given as not helpful (thumbs-down)
//   GET  /v1/dev/projects/{project}/lessons/mode                                                             the project's learning mode
//   GET  /v1/dev/projects/{project}/lessons/measure                                                          phase 0 numbers (fit of what loaded and what was left out, clean-merge rate; counts only): a project admin or a company owner or admin
//   PUT  /v1/dev/projects/{project}/lessons/mode                        { mode: off | suggest | auto }       a project admin (maintainer) or a company owner or admin only
//   POST /v1/dev/projects/{project}/lessons/mode/trial-offer            { decision: accept | not_now }       the earned-trust offer (`lessons/earned-trust.ts`): who may change the mode answers it
//   GET  /v1/dev/projects/{project}/lessons/areas[?repo=&folder= | ?whole=1]                                 lead 4 L4-LP3W: the approved lessons by code area (a tree), and the lessons anchored at one node (`lessons/area-index.ts`)
//   GET  /v1/dev/projects/{project}/lessons/learning-sources                                                 lead 4 L4-LP3W: "Where Rovara learns from": a row per kind of source with seen / suggested / kept (30 days), one example, paused or not
//   PUT  /v1/dev/projects/{project}/lessons/learning-sources/{key}      { paused: boolean }                  pause or resume one row (who may set the mode may; audited before the change; a paused source is not read at all: nothing is collected, stored or paid for, and resuming starts again from then)
//   GET  /v1/dev/projects/{project}/skills                                                                   the project's Rovara skills (L4-AK3): the newest version of each, who approved it (a count and whether you did), the long-skill note
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/skill            { name? }                            "Make this a skill?": a person who decides drafts a skill from a PROVEN procedure lesson (made by code, no model)
//   PUT  /v1/dev/projects/{project}/skills/{name}                       { expectedVersion, description, when, steps, doneWhen?, why? }   an edit is a NEW version with no approvals (the live version stays live)
//   POST /v1/dev/projects/{project}/skills/{name}/approve               { version }                          one of the TWO different people a version needs before it is used
//   POST /v1/dev/projects/{project}/skills/{name}/retire                {}                                   a person who decides takes a skill out of use at once
//   GET  /v1/dev/projects/{project}/lessons/weekly-summary                                                   whether the weekly lessons summary goes to the chats (`lessons/digest-notice.ts`; off by default)
//   PUT  /v1/dev/projects/{project}/lessons/weekly-summary              { on: boolean }                      who may set the mode sets it; audited before the write
//
// Rules:
//   - The switch (`ROVARA_CORE_LESSONS`) is read first: a company it does not cover gets the fixed "Lessons are off." and nothing is read or written. With the switch `off` not even membership is read.
//   - The company comes ONLY from live membership (`companyOf`), never from a path, a query, a body or a token claim; a reader that throws or answers something malformed is "sign in again".
//   - Every read and write goes through the lessons of that company (`lessonsOf(companyId)`), whose keys are all under the company's partition. A project the company does not have, or one the person is not
//     on the roster of, is "No such project." (the same words, so another company's project names cannot be probed).
//   - Who decides (approve, reject, retire, the proposed and retired lists, retire requests) is the lessons library's own rule (the project's approvers, read live); the mode is set only by a project
//     admin or a company owner or admin, read live. A script token gets nothing from this API: it neither reads nor decides nor sets.
//   - Every write is audited: by the library for approve, reject and retire (its own order: approve records before it commits; reject and retire record after, best effort, as on the laptop), and here BEFORE
//     the write for the mode and a retire request (no record, no change).
//   - A person's erased words never come back: reasons are fixed words, people are named live (an erased person is "a former member"), and an erased person's retire request is never listed.
//   - Refusals are fixed words; nothing a caller sent is echoed.
import { AgentXError, AgentXNameSchema, LEARNING_SOURCE_KEYS, LearningSourcePauseBodySchema, OrgIdSchema, OrgRoleSchema, ROVARA_SKILL_DESCRIPTION_MAX, ROVARA_SKILL_NAME, agentXError, companyScoped, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";
import { z } from "zod";
import { approveLesson, rejectLesson, retireByPerson, type ApprovalFailure } from "../lessons/approve.js";
import { SKILL_STEPS_MAX, approveSkill, draftSkillFromLesson, editSkill, listSkills, retireSkill, type SkillDeps } from "../lessons/skills.js";
import { skillDepsOf } from "../lessons/skill-graduation.js";
import { recordFeedback } from "../lessons/counters.js";
import { writeLearningMode, writeLearningModeFromSuggest } from "../lessons/document-settings.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { attributionNameOf } from "../lessons/people.js";
import { DEFAULT_LEARNING_MODE, requireAudit, resolveLearning, type LearningMode } from "../lessons/policy.js";
import { readLessonMeasure } from "../lessons/measure.js";
import { readVisible } from "../lessons/read-visible.js";
import { idIn } from "../lessons/types.js";
import { countLessonUses } from "../lessons/use-count.js";
import { snoozeTrialOffer, tallyTrialOffer, trialOfferEarned, trialOfferSnoozed, trialWouldStart, type TrialOfferTally } from "../lessons/earned-trust.js";
import { readDigestSettingStrict, writeDigestSetting } from "../lessons/digest-notice.js";
import { LESSON_PAGE_LISTS, LESSON_PAGE_MAX, buildLessonsByArea, buildLessonsPage, buildLoadedLessons, type LessonPageCursor, type LessonPageList } from "../lessons/view.js";
import { folderOfRequest, type AreaSelection } from "../lessons/area-index.js";
import { buildLearningSources, setLearningSourcePause } from "../lessons/learning-sources.js";
import type { CoreLessons } from "./lessons.js";
import { LESSONS_GRADUATION_API, answerGraduation } from "./lessons-graduation.js";
import type { SkillGraduation } from "../lessons/graduate.js";
import { switchCovers, type CoreSwitch } from "./flags.js";

/** The paths this API serves (one regex, so the route-table tests read every path from it). */
const LESSONS_API = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons(?:\/(mode|mode\/trial-offer|weekly-summary|retire-requests|decisions|measure|areas|learning-sources)|\/([^/]+)\/(approve|reject|retire|retire-request|skill))?|tasks\/([^/]+)\/lessons(?:\/([^/]+)\/(not-helpful))?|lessons\/learning-sources\/([a-z0-9_]{1,40})|skills(?:\/([a-z0-9][a-z0-9-]{0,63})(?:\/(approve|retire))?)?)$/u;

/** Whether a path is one of this API's (the dev router asks before it hands a request here). */
export const isLessonsApiPath = (path: string): boolean => LESSONS_API.test(path) || LESSONS_GRADUATION_API.test(path);

export const LESSONS_OFF = "Lessons are off.";
export const NO_SUCH_PROJECT = "No such project.";
export const NO_SUCH_TASK = "No such task.";
export const NO_SUCH_LESSON = "That lesson is no longer there.";
export const MODE_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can change its learning mode.";
export const SOURCE_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can pause or resume a source.";
export const SUMMARY_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can change the weekly summary.";
export const MEASURE_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can see how lessons are loaded.";
export const NOT_FOR_SCRIPT_TOKENS = "A script token cannot do that.";
const SIGN_IN_AGAIN = "Sign in again.";
const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
const NOT_RECORDED = "That could not be recorded, so nothing was changed. Try again.";
const ROUTE_NOT_FOUND = "route not found";

export const LESSON_API_MODES = ["off", "suggest", "auto"] as const;
export type LessonApiMode = (typeof LESSON_API_MODES)[number];
/** Why a person rejected a proposed lesson: fixed words only, so no person's text is kept with a lesson. */
export const REJECT_REASONS = ["wrong", "too_narrow", "duplicate", "not_useful", "other"] as const;
/** Why a person retired a lesson: fixed words only. */
export const RETIRE_REASONS = ["outdated", "wrong", "harmful", "not_useful", "other"] as const;

const TO_STORED: Record<LessonApiMode, LearningMode> = { off: "Off", suggest: "Suggest", auto: "On" };
/** `Collect` (the laptop's "capture only") proposes and uses nothing, so this API shows it as off. */
const FROM_STORED: Record<LearningMode, LessonApiMode> = { Off: "off", Collect: "off", Suggest: "suggest", On: "auto" };

const LESSON_ID = /^[A-Za-z0-9_-]{4,64}$/u;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PAGE_DEFAULT = 50;
const RETIRE_REQUESTS_MAX = 50;
const RETIRE_REQUEST_KEEP_SECONDS = 30 * 86_400;

const EditSchema = z.object({ title: z.string().trim().min(1).max(80), description: z.string().max(160), body: z.string().trim().min(1).max(600) }).strict();
const ApproveBody = z.object({ version: z.number().int().min(1).max(1_000_000), edit: EditSchema.optional() }).strict();
export const DECISIONS_MAX = 20;
const DecisionSchema = z.discriminatedUnion("decision", [
  z.object({ lessonId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1).max(1_000_000), decision: z.literal("keep"), edit: EditSchema.optional() }).strict(),
  z.object({ lessonId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u), version: z.number().int().min(1).max(1_000_000), decision: z.literal("drop"), reason: z.enum(REJECT_REASONS) }).strict(),
]);
const DecisionsBody = z.object({ decisions: z.array(DecisionSchema).min(1).max(DECISIONS_MAX).refine((list) => new Set(list.map((d) => d.lessonId)).size === list.length) }).strict();
const RejectBody = z.object({ version: z.number().int().min(1).max(1_000_000), reason: z.enum(REJECT_REASONS) }).strict();
const RetireBody = z.object({ reason: z.enum(RETIRE_REASONS) }).strict();
const EmptyBody = z.object({}).strict();
const SkillDraftBody = z.object({ name: z.string().regex(ROVARA_SKILL_NAME).optional() }).strict();
const SkillEditBody = z.object({
  expectedVersion: z.number().int().min(1).max(1_000_000), description: z.string().trim().min(1).max(ROVARA_SKILL_DESCRIPTION_MAX), when: z.string().trim().min(1).max(2_000),
  steps: z.array(z.string().trim().min(1).max(4_000)).min(1).max(SKILL_STEPS_MAX), doneWhen: z.string().max(2_000).optional(), why: z.string().max(2_000).optional(),
}).strict();
const SkillApproveBody = z.object({ version: z.number().int().min(1).max(1_000_000) }).strict();
const ModeBody = z.object({ mode: z.enum(LESSON_API_MODES) }).strict();
const TrialOfferBody = z.object({ decision: z.enum(["accept", "not_now"]) }).strict();
const WeeklySummaryBody = z.object({ on: z.boolean() }).strict();
const PageQuery = z.object({
  list: z.enum(LESSON_PAGE_LISTS).default("approved"),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number).refine((n) => n <= LESSON_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(400).optional(),
  since: z.string().regex(/^[0-9]{1,16}$/u).transform(Number).optional(),
}).strict();
/** `repo` is a repository name, or `*` for the lessons that name paths but no repository; `whole=1` asks for the lessons with no area. Nothing else is accepted. */
const AreasQuery = z.object({ repo: z.string().regex(/^(?:\*|[A-Za-z0-9_.@-]{1,100})$/u).optional(), folder: z.string().max(400).optional(), whole: z.literal("1").optional() }).strict();
const SOURCE_KEY = z.enum(LEARNING_SOURCE_KEYS);
const CursorSchema = z.tuple([z.enum(LESSON_PAGE_LISTS), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(LESSON_ID)]);

export interface LessonsApiRequest {
  method: string;
  path: string;
  /** The query string's parameters. */
  query?: URLSearchParams | undefined;
  body?: string | undefined;
}

export interface LessonsApiCaller {
  /** The person the sign-in vouched for. */
  personId: string;
  /** Set when the caller holds a script token: it gets nothing from this API (a refusal, for reads as well as writes). */
  scriptToken?: { tokenId: string } | undefined;
}

/** What this API needs of one company's lessons (`createCoreLessons`). */
export type LessonsApiCompany = Pick<CoreLessons, "companyId" | "runtime" | "readTask" | "projectExists">;

export interface LessonsApiOptions {
  /** The install's lessons switch (`readCoreLessonsSwitch`). */
  lessonsSwitch: CoreSwitch;
  /** The caller's company and their live role in it, from membership. Undefined, malformed or a throw: sign in again. */
  companyOf(caller: LessonsApiCaller): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The lessons of a company the switch covers (built once per company by the deployment). Undefined: lessons are off for it. */
  lessonsOf(companyId: OrgId): Promise<LessonsApiCompany | undefined>;
  /** The same people port the company's lessons were built with (roster and names, for this company only). */
  people: Pick<HostedLessonPeople, "onProjectRoster" | "displayName" | "isErased">;
  /** The skills library of one company (L4-AK3), for graduating a proven procedure into a skill. Absent: the skill target answers "not available yet". */
  skillsOf?: (companyId: OrgId) => SkillGraduation | undefined;
  /** The person's role on the project now (a project admin is a `maintainer`); undefined: none. */
  projectRole(companyId: OrgId, project: string, personId: string): Promise<ProjectRole | undefined>;
  /** The task's own project's wiki use report; the caller never chooses the company or project. */
  wikiTaskUse?(companyId: OrgId, project: string, taskId: string): Promise<{ given: string[]; read: string[] } | undefined>;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface LessonsApi {
  /** The answer's body for a request to one of this API's paths; refusals are thrown as `AgentXError` (fixed words). */
  answer(request: LessonsApiRequest, caller: LessonsApiCaller): Promise<unknown>;
}

const notFound = (message: string): AgentXError => agentXError("NOT_FOUND", message);

function bodyOf<T>(schema: z.ZodType<T>, body: string | undefined, words: string): T {
  let raw: unknown;
  try { raw = body === undefined || body === "" ? {} : JSON.parse(body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", words);
  return parsed.data;
}

export function encodeLessonCursor(cursor: LessonPageCursor): string {
  return Buffer.from(JSON.stringify([cursor.list, cursor.updatedAt, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(text: string, list: LessonPageList): LessonPageCursor {
  const refused = (): AgentXError => agentXError("CONFIG_INVALID", "the cursor is not one this list gave");
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw refused();
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { throw refused(); }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data[0] !== list) throw refused();
  return { list: parsed.data[0], updatedAt: parsed.data[1], id: parsed.data[2] };
}

/** The words a library refusal is answered with: fixed, and never the cause. */
function refusalOf(code: ApprovalFailure): AgentXError {
  switch (code) {
    case "not_found": return notFound(NO_SUCH_LESSON);
    case "not_pending": return agentXError("IDEMPOTENCY_CONFLICT", "That lesson is not waiting for a decision.");
    case "conflict": return agentXError("IDEMPOTENCY_CONFLICT", "This lesson changed since you read it. Read it again and decide again.");
    case "mode_off": return agentXError("FORBIDDEN", "Learning is off for this project.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not tell who may decide this. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
    case "already_approved": return agentXError("IDEMPOTENCY_CONFLICT", "You already approved this lesson.");
    case "author_cannot_approve_alone": return agentXError("FORBIDDEN", "A lesson needs someone other than the person who wrote it.");
    case "second_person_required": return agentXError("FORBIDDEN", "This lesson needs a second person to approve it.");
    case "sole_owner_cool_off": return agentXError("FORBIDDEN", "This lesson can be approved by you alone after a short wait.");
    case "capability_request": return agentXError("FORBIDDEN", "This lesson asks for more than advice, so it needs a second look.");
    case "tier_never": return agentXError("FORBIDDEN", "That lesson cannot be approved.");
    case "not_permitted": return agentXError("FORBIDDEN", "You cannot see where this lesson came from, so you cannot decide it.");
    case "not_eligible": return agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons.");
    default: return agentXError("FORBIDDEN", "That was not accepted.");
  }
}

/** The words a skill refusal is answered with: fixed, and never the cause or anything the caller sent. */
export function skillRefusalOf(code: string): AgentXError {
  switch (code) {
    case "not_found": return notFound("That skill or lesson is no longer there.");
    case "not_proven": return agentXError("FORBIDDEN", "That lesson has not proved itself yet, so it cannot become a skill.");
    case "not_eligible": return agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can decide skills.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not tell who may decide this. Try again.");
    case "other_target": return agentXError("IDEMPOTENCY_CONFLICT", "That lesson is already becoming something else (a rule or a check).");
    case "already_a_skill": return agentXError("IDEMPOTENCY_CONFLICT", "A skill was already made from this lesson.");
    case "not_project_wide": return agentXError("FORBIDDEN", "That lesson came from a place only some people can read, so it cannot become the project's skill.");
    case "bad_name": return agentXError("CONFIG_INVALID", "That skill name cannot be used. Use lowercase letters, digits and hyphens, and a name no other skill has.");
    case "too_large": return agentXError("CONFIG_INVALID", "That skill is too long. A skill is at most 32 KB.");
    case "too_many_steps": return agentXError("CONFIG_INVALID", "A skill has at most 12 steps.");
    case "empty": return agentXError("CONFIG_INVALID", "A skill needs at least one step.");
    case "execution_line": return agentXError("CONFIG_INVALID", "A skill is text only: it cannot hold a command line to run or a list of tools.");
    case "conflict": case "not_newest": return agentXError("IDEMPOTENCY_CONFLICT", "This skill changed since you read it. Read it again and decide again.");
    case "already_live": return agentXError("IDEMPOTENCY_CONFLICT", "That version is already in use.");
    case "already_approved": return agentXError("IDEMPOTENCY_CONFLICT", "You already approved this version.");
    case "retired": return agentXError("IDEMPOTENCY_CONFLICT", "That skill was retired.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
    default: return agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
  }
}

export function createLessonsApi(options: LessonsApiOptions): LessonsApi {
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "lessons-api", event, ...fields });

  /** The caller's company and role from membership, checked. */
  async function membershipOf(caller: LessonsApiCaller): Promise<{ companyId: OrgId; role: OrgRole }> {
    let found: unknown;
    try { found = await options.companyOf(caller); } catch { found = undefined; }
    const record = found as { companyId?: unknown; role?: unknown } | undefined | null;
    const companyId = OrgIdSchema.safeParse(record?.companyId);
    const role = OrgRoleSchema.safeParse(record?.role);
    if (!companyId.success || !role.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    return { companyId: companyId.data, role: role.data };
  }

  async function answer(request: LessonsApiRequest, caller: LessonsApiCaller): Promise<unknown> {
    // Lessons phase 4 (`lessons-graduation.ts`): its paths are tried first (`tidy` and `check-drafts` would otherwise read as a lesson id); it shares everything below up to the roster check.
    const graduation = LESSONS_GRADUATION_API.exec(request.path);
    const match = graduation ?? LESSONS_API.exec(request.path);
    if (match === null) throw notFound(ROUTE_NOT_FOUND);
    const [, rawProject, fixed, rawLesson, action, rawTask, rawTaskLesson, , rawSource, rawSkill, skillAction] = graduation === null ? match : [match[0], match[1]] as unknown as typeof match;
    const method = request.method;
    // The skills paths (`skills`, `skills/{name}`, `skills/{name}/approve|retire`) and the lesson's `skill` action are the skill routes.
    const skillsPath = /^\/v1\/dev\/projects\/[^/]+\/skills(?:\/|$)/u.test(request.path);
    const route = graduation !== null ? "graduation" : skillsPath ? (rawSkill === undefined ? "skills" : skillAction === undefined ? "skill-edit" : `skill-${skillAction}`) : rawSource !== undefined ? "learning-source" : rawTaskLesson !== undefined ? "not-helpful" : rawTask !== undefined ? "task" : fixed !== undefined ? fixed : action !== undefined ? action : "list";
    const allowed: Record<string, string> = { list: "GET", task: "GET", "retire-requests": "GET", measure: "GET", decisions: "POST", "mode/trial-offer": "POST", approve: "POST", reject: "POST", retire: "POST", "retire-request": "POST", "not-helpful": "POST", areas: "GET", "learning-sources": "GET", "learning-source": "PUT", skill: "POST", skills: "GET", "skill-edit": "PUT", "skill-approve": "POST", "skill-retire": "POST" };
    if (graduation === null && (route === "mode" || route === "weekly-summary" ? method !== "GET" && method !== "PUT" : allowed[route] !== method)) throw notFound(ROUTE_NOT_FOUND);

    // The switch first: off reads nothing at all, not even who is asking.
    if (options.lessonsSwitch.mode === "off") throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    const { companyId, role } = await membershipOf(caller);
    if (!switchCovers(options.lessonsSwitch, companyId)) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    let lessons: LessonsApiCompany | undefined;
    try { lessons = await options.lessonsOf(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (lessons === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    // The lessons handed back must be the member company's own: anything else is a wiring fault, refused before any read.
    if (lessons.companyId !== companyId) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    // A script token neither reads nor changes lessons here: the lists are for team members, on their own screens, a page at a time.
    if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);

    let project: string;
    try { project = decodeURIComponent(rawProject!); } catch { throw notFound(NO_SUCH_PROJECT); }
    if (!AgentXNameSchema.safeParse(project).success) throw notFound(NO_SUCH_PROJECT);
    const personId = caller.personId;
    let onRoster: boolean;
    let exists: boolean;
    try {
      [exists, onRoster] = await Promise.all([lessons.projectExists(project), options.people.onProjectRoster(companyId, project, personId)]);
    } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (!exists) throw notFound(NO_SUCH_PROJECT);

    const runtime = lessons.runtime;
    const deps = runtime.routes;
    const who = { orgId: companyId, developerId: personId };
    const where = { workspaceId: companyId, project };

    if (route === "task" || route === "not-helpful") {
      let taskId: string;
      try { taskId = decodeURIComponent(rawTask!); } catch { throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK); }
      if (!TASK_ID.test(taskId)) throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK);
      const task = await lessons.readTask(taskId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
      // A task of another company or project, or one the person may not read (not on the roster and not its own person), is the same "no such task".
      // A person off the roster learns nothing about the project from a task id (the same "No such project." as a project that does not exist), unless the task is their own.
      if (!onRoster && (task === undefined || task.developerId !== personId)) throw notFound(NO_SUCH_PROJECT);
      if (task === undefined || task.companyId !== companyId || task.project !== project) throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK);
      if (route === "task") {
        const wikiUse = onRoster ? await options.wikiTaskUse?.(companyId, project, taskId) : undefined;
        return { project, taskId, ...(await buildLoadedLessons(deps, who, project, taskId)), ...(wikiUse === undefined ? {} : { wikiUse }) };
      }
      // Not helpful: the one-tap thumbs-down of a person on the project, for a lesson this task was given (the library checks it was, and that they can read it). One mark per person per lesson;
      // a lesson live on trial is retired by it, any other lesson gets a "wrong here" mark that asks a person to decide.
      bodyOf(EmptyBody, request.body, "not helpful takes no fields");
      let lessonId: string;
      try { lessonId = decodeURIComponent(rawTaskLesson!); } catch { throw notFound(NO_SUCH_LESSON); }
      if (!LESSON_ID.test(lessonId) || !onRoster) throw notFound(NO_SUCH_LESSON);
      const viewer = await deps.directory.identity(companyId, personId);
      const marked = await recordFeedback({ ...runtime.counters, access: runtime.access }, { ...where, taskId, lessonId, userId: personId, viewer, kind: "thumbs_down", projectMember: true });
      if (!marked.ok) {
        if (marked.code === "repeat") throw agentXError("IDEMPOTENCY_CONFLICT", "You already marked this lesson.");
        throw notFound(NO_SUCH_LESSON);
      }
      return { project, taskId, lessonId, marked: "not_helpful" };
    }
    if (!onRoster) throw notFound(NO_SUCH_PROJECT);

    if (graduation !== null) return await answerGraduation(request, graduation, { companyId, project, personId, lessons, skills: options.skillsOf?.(companyId), now: options.now, log }, caller);

    // Rovara skills (L4-AK3). Reads need the roster; every write is a person who decides (the library asks the approver directory now), never a script token (refused above), and is audited by the library before it is made.
    if (route === "skills" || route === "skill" || route.startsWith("skill-")) {
      const skillDeps: SkillDeps = skillDepsOf(runtime, { companyId, now: options.now, log });
      let skillName: string | undefined;
      if (rawSkill !== undefined) skillName = rawSkill;
      if (route === "skills") {
        let skills: Awaited<ReturnType<typeof listSkills>>;
        try { skills = await listSkills(runtime, where); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
        return { project, skills: skills.map(({ approvers, ...rest }) => ({ ...rest, approvedByYou: approvers.some((id) => id.normalize("NFC").trim().toLowerCase() === personId.normalize("NFC").trim().toLowerCase()) })) };
      }
      if (route === "skill") {
        const body = bodyOf(SkillDraftBody, request.body, "a skill draft takes an optional name (lowercase letters, digits and hyphens)");
        let lessonId: string;
        try { lessonId = decodeURIComponent(rawLesson!); } catch { throw notFound(NO_SUCH_LESSON); }
        if (!LESSON_ID.test(lessonId)) throw notFound(NO_SUCH_LESSON);
        const made = await draftSkillFromLesson(skillDeps, where, { lessonId, by: personId, name: body.name });
        if (!made.ok) throw skillRefusalOf(made.code);
        log("skill_drafted", { companyId });
        return { project, name: made.name, version: made.version, ...(made.note === undefined ? {} : { note: made.note }) };
      }
      if (skillName === undefined) throw notFound(ROUTE_NOT_FOUND);
      if (route === "skill-edit") {
        const body = bodyOf(SkillEditBody, request.body, "a skill edit takes expectedVersion, description, when, steps (1 to 12), and optionally doneWhen and why");
        const done = await editSkill(skillDeps, where, { name: skillName, by: personId, expectedVersion: body.expectedVersion, form: { description: body.description, when: body.when, steps: body.steps, doneWhen: body.doneWhen, why: body.why } });
        if (!done.ok) throw skillRefusalOf(done.code);
        return { project, name: skillName, version: done.version, ...(done.note === undefined ? {} : { note: done.note }) };
      }
      if (route === "skill-approve") {
        const body = bodyOf(SkillApproveBody, request.body, "an approval takes the version you read");
        const done = await approveSkill(skillDeps, where, { name: skillName, version: body.version, by: personId });
        if (!done.ok) throw skillRefusalOf(done.code);
        return { project, name: skillName, version: body.version, approvals: done.approvals, live: done.live };
      }
      bodyOf(EmptyBody, request.body, "retiring a skill takes no fields");
      const retired = await retireSkill(skillDeps, where, { name: skillName, by: personId });
      if (!retired.ok) throw skillRefusalOf(retired.code);
      return { project, name: skillName, retired: true };
    }

    if (route === "list") {
      const query = PageQuery.safeParse(Object.fromEntries(request.query?.entries() ?? []));
      if (!query.success || [...(request.query?.keys() ?? [])].length !== new Set(request.query?.keys() ?? []).size) throw agentXError("CONFIG_INVALID", "list takes list (proposed, approved or retired), since, limit (1 to 50) and cursor, once each");
      const after = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor, query.data.list);
      const page = await buildLessonsPage(deps, who, project, { list: query.data.list, limit: query.data.limit ?? PAGE_DEFAULT, ...(after === undefined ? {} : { after }), ...(query.data.since === undefined ? {} : { since: query.data.since }) });
      // "Used in N tasks": the distinct tasks each shown lesson was given to (its use rows, this company and project only). A lesson that could not be counted has no `usedInTasks`, and the page says so (`usedInIncomplete`).
      // A proposed lesson has never been given to a task, so the proposed list is not counted (no `usedInTasks`, and the page is not incomplete for it).
      const used = query.data.list === "proposed" ? { counts: new Map<string, { tasks: number; more?: true }>(), incomplete: false } : await countLessonUses(runtime.documents, { companyId, project, lessonIds: page.lessons.map((one) => one.id), now: options.now() });
      const lessonsShown = page.lessons.map((one) => { const count = used.counts.get(one.id); return count === undefined ? one : { ...one, usedInTasks: count.tasks, ...(count.more === true ? { usedInTasksMore: true as const } : {}) }; });
      return { ...page, lessons: lessonsShown, ...(used.incomplete ? { usedInIncomplete: true } : {}), ...(page.next === undefined ? {} : { next: encodeLessonCursor(page.next) }) };
    }

    /** Who may change the project's lessons settings (the mode, the weekly summary): a company owner or admin, or a project admin (maintainer), read live. */
    const mayChange = async (): Promise<boolean> => {
      if (role === "owner" || role === "admin") return true;
      try { return (await options.projectRole(companyId, project, personId)) === "maintainer"; } catch { return false; }
    };

    if (route === "measure") {
      // Phase 0 (measure only, `lessons/measure.ts`): numbers about loads and merges, ids never shown. For the people who run the project's learning, never a script token.
      if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
      if (!(await mayChange())) throw agentXError("FORBIDDEN", MEASURE_NEEDS_ADMIN);
      try { return await readLessonMeasure(runtime.documents, { companyId, project, now: options.now() }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    }

    // Lead 4 L4-LP3W: the approved lessons by code area (anyone on the project reads, like the approved list).
    if (route === "areas") {
      const query = AreasQuery.safeParse(Object.fromEntries(request.query?.entries() ?? []));
      if (!query.success || [...(request.query?.keys() ?? [])].length !== new Set(request.query?.keys() ?? []).size) throw agentXError("CONFIG_INVALID", "areas takes repo (a name, or *), folder and whole=1, once each");
      let selection: AreaSelection | undefined;
      if (query.data.whole === "1") {
        if (query.data.repo !== undefined || query.data.folder !== undefined) throw agentXError("CONFIG_INVALID", "whole=1 takes nothing else");
        selection = { whole: true };
      } else if (query.data.repo !== undefined) {
        const folder = folderOfRequest(query.data.folder ?? "");
        if (folder === undefined) throw agentXError("CONFIG_INVALID", "folder is not a plain folder path");
        selection = { repo: query.data.repo === "*" ? null : query.data.repo, folder };
      } else if (query.data.folder !== undefined) throw agentXError("CONFIG_INVALID", "folder needs repo");
      return await buildLessonsByArea(deps, who, project, selection === undefined ? {} : { selection });
    }

    // Lead 4 L4-LP3W: "Where Rovara learns from" and its Pause.
    if (route === "learning-sources") return await buildLearningSources(deps, who, project, { canPause: await mayChange() });
    if (route === "learning-source") {
      const sourceKey = SOURCE_KEY.safeParse(rawSource);
      if (!sourceKey.success) throw notFound(ROUTE_NOT_FOUND);
      const body = bodyOf(LearningSourcePauseBodySchema, request.body, "pause takes paused: true or false");
      if (!(await mayChange())) throw agentXError("FORBIDDEN", SOURCE_NEEDS_ADMIN);
      let outcome: Awaited<ReturnType<typeof setLearningSourcePause>>;
      try { outcome = await setLearningSourcePause({ store: runtime.store, audit: runtime.audit, now: options.now }, where, personId, sourceKey.data, body.paused); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
      if (!outcome.ok) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
      log("learning_source_set", { companyId, paused: outcome.paused });
      return { project, key: sourceKey.data, paused: outcome.paused };
    }

    if (route === "weekly-summary") {
      if (method === "GET") {
        let on: boolean;
        try { on = await readDigestSettingStrict(runtime.documents, companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
        return { project, on, canChange: await mayChange() };
      }
      const body = bodyOf(WeeklySummaryBody, request.body, "the weekly summary takes on: true or false");
      if (!(await mayChange())) throw agentXError("FORBIDDEN", SUMMARY_NEEDS_ADMIN);
      // The record first: no record, no change.
      if (!(await requireAudit(runtime.audit, { action: "lesson.digest_switched", workspaceId: companyId, project, actor: personId, facts: { enabled: body.on } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
      try { await writeDigestSetting(runtime.documents, companyId, project, body.on, options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
      log("weekly_summary_set", { companyId, on: body.on });
      return { project, on: body.on, canChange: true };
    }

    if (route === "mode" || route === "mode/trial-offer") {
      const settings = await runtime.settings.read(companyId, project).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
      const resolved = await resolveLearning(runtime.settings, companyId, project);
      // No settings, or no mode stored, is the default (Suggest, DEC 226).
      const stored = (settings as { mode?: unknown } | undefined)?.mode ?? DEFAULT_LEARNING_MODE;
      const own: LessonApiMode = typeof stored === "string" && stored in FROM_STORED ? FROM_STORED[stored as LearningMode] : "off";
      /**
       * The earned-trust offer (DEC 231): only while the project's own mode and the mode in force are both Suggest (no company lock), accepting would really start trials and nothing more (Standard preset,
       * no approval floor, required group or two-person rule, tier 0 not set to go live by itself: `trialWouldStart`), the offer is earned and nobody said "not now" lately. Undefined: no offer. Who may not
       * change the mode is never offered it.
       */
      const offerDue = async (): Promise<TrialOfferTally | undefined> => {
        if (own !== "suggest" || FROM_STORED[resolved.chosenMode] !== "suggest" || resolved.preset !== "standard") return undefined;
        if (!trialWouldStart(settings ?? {}, resolved)) return undefined;
        if (await trialOfferSnoozed(runtime.documents, companyId, project, options.now())) return undefined;
        const tally = await tallyTrialOffer(runtime.store, where, options.now());
        return tally !== undefined && trialOfferEarned(tally) ? tally : undefined;
      };
      if (route === "mode/trial-offer") {
        const body = bodyOf(TrialOfferBody, request.body, "the decision is accept or not_now");
        if (!(await mayChange())) throw agentXError("FORBIDDEN", MODE_NEEDS_ADMIN);
        // Answered against the offer as it stands now: one that is no longer due (the mode changed, a lock came, a drop, someone answered) is not answered under the person.
        const tally = await offerDue();
        if (tally === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "There is no offer to answer now.");
        if (body.decision === "not_now") {
          // The record first: no record, no change.
          if (!(await requireAudit(runtime.audit, { action: "lesson.trial_offer_answered", workspaceId: companyId, project, actor: personId, facts: { answer: "not_now", approvals: tally.approvals, drops: tally.drops } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
          try { await snoozeTrialOffer(runtime.documents, companyId, project, options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
          log("trial_offer_not_now", { companyId });
          return { project, decision: "not_now", mode: own };
        }
        // Accepting is a change of mode: ONE record (the mode change, marked as the offer's), before the write. The write holds only while the mode is still Suggest, so a mode someone changed since the
        // offer was read is never written over (the person is told there is no offer now; the record then stands for an answer that changed nothing, the safe way round).
        if (!(await requireAudit(runtime.audit, { action: "lesson.mode_changed", workspaceId: companyId, project, actor: personId, facts: { from: own, to: "auto", via: "trial_offer", approvals: tally.approvals, drops: tally.drops } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
        let written: boolean;
        try { written = await writeLearningModeFromSuggest(runtime.documents, where, TO_STORED.auto, options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The mode could not be saved. Try again."); }
        if (!written) throw agentXError("IDEMPOTENCY_CONFLICT", "There is no offer to answer now.");
        // Best effort: a project that goes back to Suggest later is not offered trial again at once.
        await snoozeTrialOffer(runtime.documents, companyId, project, options.now()).catch(() => undefined);
        log("trial_offer_accepted", { companyId });
        const after = await resolveLearning(runtime.settings, companyId, project);
        return { project, decision: "accept", mode: "auto", effective: FROM_STORED[after.chosenMode] };
      }
      if (method === "GET") {
        const effective = FROM_STORED[resolved.chosenMode];
        const canChange = await mayChange();
        // The offer is extra: a tally that cannot be read is no offer, never a failed read of the mode.
        const offer = canChange ? await offerDue().catch(() => undefined) : undefined;
        return { project, mode: own, effective, lockedByCompany: effective !== own, canChange, ...(offer === undefined ? {} : { trialOffer: { approvals: offer.approvals, drops: offer.drops, since: offer.since } }) };
      }
      const body = bodyOf(ModeBody, request.body, "the mode is off, suggest or auto");
      if (!(await mayChange())) throw agentXError("FORBIDDEN", MODE_NEEDS_ADMIN);
      // The record first: no record, no change.
      if (!(await requireAudit(runtime.audit, { action: "lesson.mode_changed", workspaceId: companyId, project, actor: personId, facts: { from: own, to: body.mode } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
      try { await writeLearningMode(runtime.documents, where, TO_STORED[body.mode], options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The mode could not be saved. Try again."); }
      log("mode_set", { companyId, mode: body.mode });
      const after = await resolveLearning(runtime.settings, companyId, project);
      return { project, mode: body.mode, effective: FROM_STORED[after.chosenMode], lockedByCompany: FROM_STORED[after.chosenMode] !== body.mode, canChange: true };
    }

    const retireAskKey = (lessonId: string) => ({ pk: companyScoped(companyId, `LESSON_RETIRE_ASK#${project}`), sk: lessonId });

    if (route === "retire-requests") {
      const eligibility = await deps.directory.eligibility(companyId, project).catch(() => undefined);
      if (eligibility === undefined || !eligibility.complete || !idIn(eligibility.eligibleIds, personId)) throw agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can see retire requests.");
      const page = await runtime.documents.query({ pk: companyScoped(companyId, `LESSON_RETIRE_ASK#${project}`), limit: RETIRE_REQUESTS_MAX + 1 }).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
      const viewer = await deps.directory.identity(companyId, personId);
      const requests: Array<{ lessonId: string; title: string; status: string; by: string; at: number }> = [];
      for (const row of page.items.slice(0, RETIRE_REQUESTS_MAX)) {
        const asker = row["personId"];
        if (typeof asker !== "string" || typeof row["sk"] !== "string") continue;
        // An erased person's request is never shown (erase removes it too); a person whose standing cannot be read is left out.
        const erased = await options.people.isErased(companyId, asker).catch(() => true);
        if (erased) continue;
        const name = await options.people.displayName(companyId, asker).catch(() => undefined);
        const lesson = await runtime.store.get(where, row["sk"]);
        if (lesson === undefined || lesson.status === "retired" || lesson.status === "rejected" || lesson.status === "expired") continue;
        if ((await readVisible({ access: runtime.access, key: where, viewer, lessons: [lesson], where: "view" })).length !== 1) continue;
        requests.push({ lessonId: lesson.id, title: lesson.title, status: lesson.status, by: name === undefined ? "a former member" : attributionNameOf(name), at: typeof row["at"] === "number" ? row["at"] : 0 });
      }
      requests.sort((a, b) => b.at - a.at || a.lessonId.localeCompare(b.lessonId));
      return { project, requests, more: page.items.length > RETIRE_REQUESTS_MAX };
    }

    if (route === "decisions") {
      const body = bodyOf(DecisionsBody, request.body, `decisions takes 1 to ${String(DECISIONS_MAX)} distinct lessons, each { lessonId, version, decision: keep, edit? } or { lessonId, version, decision: drop, reason }`);
      // One at a time, in the order given; each answers for itself (a refusal of one never undoes or blocks another). Each is the same library call as the single routes, audited the same way.
      const results: Array<{ lessonId: string; ok: true; status: string } | { lessonId: string; ok: false; code: string; message: string }> = [];
      for (const decision of body.decisions) {
        const one = { ...where, lessonId: decision.lessonId, approverId: personId, expectedVersion: decision.version };
        // A fault on one lesson answers for that lesson only: the decisions already made are still reported.
        try {
        if (decision.decision === "keep") {
          const result = await approveLesson(deps, { ...one, ...(decision.edit === undefined ? {} : { edit: decision.edit }) });
          if (result.ok) { results.push({ lessonId: decision.lessonId, ok: true, status: result.status }); continue; }
          const refused = refusalOf(result.code);
          results.push({ lessonId: decision.lessonId, ok: false, code: refused.code, message: refused.message.slice(refused.code.length + 2) });
        } else {
          const result = await rejectLesson(deps, { ...one, reason: decision.reason });
          if (result.ok) { results.push({ lessonId: decision.lessonId, ok: true, status: "rejected" }); continue; }
          const refused = refusalOf(result.code);
          results.push({ lessonId: decision.lessonId, ok: false, code: refused.code, message: refused.message.slice(refused.code.length + 2) });
        }
        } catch (error) {
          log("decision_failed", { error: error instanceof Error ? error.name : "unknown" });
          results.push({ lessonId: decision.lessonId, ok: false, code: "RUNTIME_UNAVAILABLE", message: UNAVAILABLE });
        }
      }
      return { project, results };
    }

    // The writes on one lesson.
    let lessonId: string;
    try { lessonId = decodeURIComponent(rawLesson!); } catch { throw notFound(NO_SUCH_LESSON); }
    if (!LESSON_ID.test(lessonId)) throw notFound(NO_SUCH_LESSON);

    if (action === "approve") {
      const body = bodyOf(ApproveBody, request.body, "approve takes the version you read");
      const result = await approveLesson(deps, { ...where, lessonId, approverId: personId, expectedVersion: body.version, ...(body.edit === undefined ? {} : { edit: body.edit }) });
      if (!result.ok) throw refusalOf(result.code);
      return { project, lessonId, status: result.status, version: result.lesson.version, needs: result.needs };
    }
    if (action === "reject") {
      const body = bodyOf(RejectBody, request.body, `reject takes the version you read and a reason: ${REJECT_REASONS.join(", ")}`);
      const result = await rejectLesson(deps, { ...where, lessonId, approverId: personId, reason: body.reason, expectedVersion: body.version });
      if (!result.ok) throw refusalOf(result.code);
      return { project, lessonId, status: "rejected" };
    }
    if (action === "retire") {
      const body = bodyOf(RetireBody, request.body, `retire takes a reason: ${RETIRE_REASONS.join(", ")}`);
      const result = await retireByPerson(deps, { ...where, lessonId, actorId: personId, reason: body.reason });
      if (!result.ok) throw refusalOf(result.code);
      // The request (if any) is answered: best effort, it no longer shows once the lesson is retired either way.
      await runtime.documents.delete({ key: retireAskKey(lessonId) }).catch(() => undefined);
      return { project, lessonId, status: "retired" };
    }
    // A retire request: anyone on the project who can see the lesson asks; the people who decide answer it.
    bodyOf(EmptyBody, request.body, "a retire request takes no fields");
    const lesson = await runtime.store.get(where, lessonId);
    const viewer = await deps.directory.identity(companyId, personId);
    if (lesson === undefined || (lesson.status !== "active" && lesson.status !== "stale" && lesson.status !== "pending")
      || (await readVisible({ access: runtime.access, key: where, viewer, lessons: [lesson], where: "view" })).length !== 1) throw notFound(NO_SUCH_LESSON);
    if (!(await requireAudit(runtime.audit, { action: "lesson.retire_requested", workspaceId: companyId, project, lessonId, actor: personId, facts: { via: "api" } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
    const documents = runtime.documents;
    const at = options.now();
    await documents.put({ item: {
      ...retireAskKey(lessonId), entityType: "LESSON_RETIRE_ASK", personId, via: "api", at,
      ...(documents.ttlAttribute === undefined ? {} : { [documents.ttlAttribute]: Math.floor(at / 1000) + RETIRE_REQUEST_KEEP_SECONDS }),
    // The first open request stands (a later asker does not replace it, so erasing the later asker never drops an earlier person's request).
    }, condition: { op: "notExists", path: ["pk"] } }).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", "The request could not be saved. Try again."); });
    return { project, lessonId, requested: true };
  }

  return {
    async answer(request, caller) {
      try { return await answer(request, caller); }
      catch (error) {
        if (error instanceof AgentXError) throw error;
        log("failed", { error: error instanceof Error ? error.name : "unknown" });
        throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      }
    },
  };
}
