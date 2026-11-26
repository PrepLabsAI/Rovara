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
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/keep             {}                                   the answer to the weekly list's "Keep it?" card: the people who decide renew a lesson nobody had needed for a long time (`lessons/keep.ts`); audited before the write
//   GET  /v1/dev/projects/{project}/lessons/retire-requests                                                  the open requests (people who decide)
//   GET  /v1/dev/projects/{project}/tasks/{taskId}/lessons                                                   the lessons a task was given ("Lessons used")
//   POST /v1/dev/projects/{project}/tasks/{taskId}/lessons/{lessonId}/not-helpful   {}                       a person on the project marks a lesson the task was given as not helpful (thumbs-down)
//   GET  /v1/dev/projects/{project}/lessons/mode                                                             the project's learning mode
//   GET  /v1/dev/projects/{project}/lessons/measure                                                          phase 0 numbers (fit of what loaded and what was left out, clean-merge rate; counts only): a project admin or a company owner or admin
//   GET  /v1/dev/projects/{project}/lessons/tuning                                                           SUGGESTED starting values for the phase 1 and 2 settings, from the measured rows (`lessons/tuning.ts`; read only, nothing is applied); same readers as measure
//   PUT  /v1/dev/projects/{project}/lessons/mode                        { mode: off | suggest | auto }       a project admin (maintainer) or a company owner or admin only
//   POST /v1/dev/projects/{project}/lessons/mode/trial-offer            { decision: accept | not_now }       the earned-trust offer (`lessons/earned-trust.ts`): who may change the mode answers it
//   GET  /v1/dev/projects/{project}/lessons/areas[?repo=&folder= | ?whole=1]                                 lead 4 L4-LP3W: the approved lessons by code area (a tree), and the lessons anchored at one node (`lessons/area-index.ts`)
//   GET  /v1/dev/projects/{project}/lessons/learning-sources                                                 lead 4 L4-LP3W: "Where Rovara learns from": a row per kind of source with seen / suggested / kept (30 days), one example, paused or not
//   PUT  /v1/dev/projects/{project}/lessons/learning-sources/{key}      { paused: boolean }                  pause or resume one row (who may set the mode may; audited before the change; a paused source is not read at all: nothing is collected, stored or paid for, and resuming starts again from then)
//   GET  /v1/dev/projects/{project}/skills[?name=<skill>]                                                    the project's Rovara skills (L4-AK3): the newest version of each, who approved it (a count and whether you did), the long-skill note;
//                                                                                                            canDecide (L4-JA); with ?name= that one skill with the text of its newest version and, when it reads back, its form
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/skill            { name? }                            "Make this a skill?": a person who decides drafts a skill from a PROVEN procedure lesson (made by code, no model)
//   PUT  /v1/dev/projects/{project}/skills/{name}                       { expectedVersion, description, when, steps, doneWhen?, why? }   an edit is a NEW version with no approvals (the live version stays live)
//   POST /v1/dev/projects/{project}/skills/{name}/approve               { version }                          one of the TWO different people a version needs before it is used
//   POST /v1/dev/projects/{project}/skills/{name}/retire                {}                                   a person who decides takes a skill out of use at once
//   GET  /v1/dev/projects/{project}/lessons/weekly-summary                                                   whether the weekly lessons summary goes to the chats (`lessons/digest-notice.ts`; the project's own choice, else on for a pilot company and off for any other; `source` says which)
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
import { SKILL_STEPS_MAX, approveSkill, draftSkillFromLesson, editSkill, listSkills, mayDecideSkills, readSkill, retireSkill, type SkillDeps } from "../lessons/skills.js";
import { skillDepsOf } from "../lessons/skill-graduation.js";
import { keepByPerson } from "../lessons/keep.js";
import { recordFeedback } from "../lessons/counters.js";
import { writeLearningMode, writeLearningModeFromSuggest } from "../lessons/document-settings.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { attributionNameOf } from "../lessons/people.js";
import { DEFAULT_LEARNING_MODE, requireAudit, resolveLearning, type LearningMode } from "../lessons/policy.js";
import { readLessonMeasure } from "../lessons/measure.js";
import { readTuningReport } from "../lessons/tuning.js";
import { readVisible } from "../lessons/read-visible.js";
import { idIn } from "../lessons/types.js";
import { countLessonUses } from "../lessons/use-count.js";
import { snoozeTrialOffer, tallyTrialOffer, trialOfferEarned, trialOfferSnoozed, trialWouldStart, type TrialOfferTally } from "../lessons/earned-trust.js";
import { resolveDigestSettingStrict, writeDigestSetting } from "../lessons/digest-notice.js";
import { LESSON_PAGE_LISTS, LESSON_PAGE_MAX, buildLessonsByArea, buildLessonsPage, buildLoadedLessons, type LessonPageCursor, type LessonPageList } from "../lessons/view.js";
import { folderOfRequest, type AreaSelection } from "../lessons/area-index.js";
import { buildLearningSources, setLearningSourcePause } from "../lessons/learning-sources.js";
import { buildLessonsDigest } from "../lessons/view.js";
import type { CoreLessons } from "./lessons.js";
import { LESSONS_GRADUATION_API, answerGraduation } from "./lessons-graduation.js";
import type { SkillGraduation } from "../lessons/graduate.js";
import { digestPilotOf, switchCovers, type CoreSwitch } from "./flags.js";
import { rethrowMembershipReadFailure } from "../core/membership-read.js";

/** The paths this API serves (one regex, so the route-table tests read every path from it). */
const LESSONS_API = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons(?:\/(mode|mode\/trial-offer|weekly|weekly-summary|retire-requests|decisions|measure|tuning|replay|areas|learning-sources)|\/([^/]+)\/(approve|reject|retire|retire-request|skill|keep))?|tasks\/([^/]+)\/lessons(?:\/([^/]+)\/(not-helpful))?|lessons\/learning-sources\/([a-z0-9_]{1,40})|skills(?:\/([a-z0-9][a-z0-9-]{0,63})(?:\/(approve|retire))?)?)$/u;

/** Whether a path is one of this API's (the dev router asks before it hands a request here). */
export const isLessonsApiPath = (path: string): boolean => LESSONS_API.test(path) || LESSONS_GRADUATION_API.test(path);

export const LESSONS_OFF = "Lessons are off.";
export const NO_SUCH_PROJECT = "No such project.";
export const NO_SUCH_TASK = "No such task.";
export const NO_SUCH_LESSON = "That lesson is no longer there.";
export const MODE_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can change its learning mode.";
export const SOURCE_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can pause or resume a source.";
export const SUMMARY_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can change the weekly summary.";
export const TUNING_NEEDS_ADMIN = "Only an admin of this project, or an owner or admin of the company, can see the suggested lessons settings.";
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
export type LessonsApiCompany = Pick<CoreLessons, "companyId" | "runtime" | "readTask" | "projectExists" | "replay">;

export interface LessonsApiOptions {
  /** The install's lessons switch (`readCoreLessonsSwitch`). */
  lessonsSwitch: CoreSwitch;
  /** The pilot list for the weekly summary's default (see `CoreLessonsOptions.digestPilot`); absent: the companies `lessonsSwitch` names. Pass the same list the lessons were built with. */
  digestPilot?: ((companyId: OrgId) => boolean) | undefined;
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

const SKILLS_PATH = /^\/v1\/dev\/projects\/[^/]+\/skills(?:\/|$)/u;
const ALLOWED_METHODS: Record<string, string> = { list: "GET", task: "GET", weekly: "GET", "retire-requests": "GET", measure: "GET", tuning: "GET", replay: "GET", decisions: "POST", "mode/trial-offer": "POST", approve: "POST", reject: "POST", retire: "POST", "retire-request": "POST", keep: "POST", "not-helpful": "POST", areas: "GET", "learning-sources": "GET", "learning-source": "PUT", skill: "POST", skills: "GET", "skill-edit": "PUT", "skill-approve": "POST", "skill-retire": "POST" };

interface ParsedLessonsRoute {
  graduation: RegExpExecArray | null;
  route: string;
  method: string;
  rawProject: string;
  rawLesson: string | undefined;
  action: string | undefined;
  rawTask: string | undefined;
  rawTaskLesson: string | undefined;
  rawSource: string | undefined;
  rawSkill: string | undefined;
}

interface LessonsContext {
  options: LessonsApiOptions;
  log: (event: string, fields?: Record<string, unknown>) => void;
  caller: LessonsApiCaller;
  companyId: OrgId;
  role: OrgRole;
  personId: string;
  project: string;
  onRoster: boolean;
  lessons: LessonsApiCompany;
  runtime: LessonsApiCompany["runtime"];
  deps: LessonsApiCompany["runtime"]["routes"];
  who: { orgId: OrgId; developerId: string };
  where: { workspaceId: OrgId; project: string };
  mayChange: () => Promise<boolean>;
}

type DecisionItem = z.infer<typeof DecisionSchema>;
type DecisionOutcome = { lessonId: string; ok: true; status: string } | { lessonId: string; ok: false; code: string; message: string };
type ProjectLearningMode = { settings: Awaited<ReturnType<LessonsApiCompany["runtime"]["settings"]["read"]>>; resolved: Awaited<ReturnType<typeof resolveLearning>>; own: LessonApiMode };

function resolveRouteName(
  graduation: RegExpExecArray | null,
  skillsPath: boolean,
  fixed: string | undefined,
  action: string | undefined,
  rawTask: string | undefined,
  rawTaskLesson: string | undefined,
  rawSource: string | undefined,
  rawSkill: string | undefined,
  skillAction: string | undefined,
): string {
  if (graduation !== null) return "graduation";
  if (skillsPath) {
    if (rawSkill === undefined) return "skills";
    return skillAction === undefined ? "skill-edit" : `skill-${skillAction}`;
  }
  if (rawSource !== undefined) return "learning-source";
  if (rawTaskLesson !== undefined) return "not-helpful";
  if (rawTask !== undefined) return "task";
  return fixed ?? action ?? "list";
}

function isMethodAllowed(route: string, method: string): boolean {
  if (route === "mode" || route === "weekly-summary") return method === "GET" || method === "PUT";
  return ALLOWED_METHODS[route] === method;
}

function parseLessonsRoute(request: LessonsApiRequest): ParsedLessonsRoute {
  // Lessons phase 4 (`lessons-graduation.ts`): its paths are tried first (`tidy` and `check-drafts` would otherwise read as a lesson id); it shares everything below up to the roster check.
  const graduation = LESSONS_GRADUATION_API.exec(request.path);
  const match = graduation ?? LESSONS_API.exec(request.path);
  if (match === null) throw notFound(ROUTE_NOT_FOUND);
  const [, rawProject, fixed, rawLesson, action, rawTask, rawTaskLesson, , rawSource, rawSkill, skillAction] = graduation === null ? match : [match[0], match[1]] as unknown as typeof match;
  const method = request.method;
  // The skills paths (`skills`, `skills/{name}`, `skills/{name}/approve|retire`) and the lesson's `skill` action are the skill routes.
  const skillsPath = SKILLS_PATH.test(request.path);
  const route = resolveRouteName(graduation, skillsPath, fixed, action, rawTask, rawTaskLesson, rawSource, rawSkill, skillAction);
  if (graduation === null && !isMethodAllowed(route, method)) throw notFound(ROUTE_NOT_FOUND);
  return { graduation, route, method, rawProject: rawProject!, rawLesson, action, rawTask, rawTaskLesson, rawSource, rawSkill };
}

function hasDuplicateQueryKeys(query: URLSearchParams | undefined): boolean {
  if (query === undefined) return false;
  const keys = [...query.keys()];
  return keys.length !== new Set(keys).size;
}

function decodeLessonId(raw: string | undefined): string {
  let lessonId: string;
  try { lessonId = decodeURIComponent(raw!); } catch { throw notFound(NO_SUCH_LESSON); }
  if (!LESSON_ID.test(lessonId)) throw notFound(NO_SUCH_LESSON);
  return lessonId;
}

function decodeTaskId(raw: string | undefined): string {
  let taskId: string;
  try { taskId = decodeURIComponent(raw!); } catch { throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK); }
  if (!TASK_ID.test(taskId)) throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK);
  return taskId;
}

function retireAskKey(companyId: OrgId, project: string, lessonId: string): { pk: string; sk: string } {
  return { pk: companyScoped(companyId, `LESSON_RETIRE_ASK#${project}`), sk: lessonId };
}

async function resolveCompanyLessons(
  options: LessonsApiOptions,
  membershipOf: (caller: LessonsApiCaller) => Promise<{ companyId: OrgId; role: OrgRole }>,
  caller: LessonsApiCaller,
): Promise<{ companyId: OrgId; role: OrgRole; lessons: LessonsApiCompany }> {
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
  return { companyId, role, lessons };
}

async function resolveProjectAccess(
  options: LessonsApiOptions,
  lessons: LessonsApiCompany,
  companyId: OrgId,
  personId: string,
  rawProject: string,
): Promise<{ project: string; onRoster: boolean }> {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw notFound(NO_SUCH_PROJECT); }
  if (!AgentXNameSchema.safeParse(project).success) throw notFound(NO_SUCH_PROJECT);
  let onRoster: boolean;
  let exists: boolean;
  try {
    [exists, onRoster] = await Promise.all([lessons.projectExists(project), options.people.onProjectRoster(companyId, project, personId)]);
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
  if (!exists) throw notFound(NO_SUCH_PROJECT);
  return { project, onRoster };
}

async function resolveRequestContext(
  options: LessonsApiOptions,
  membershipOf: (caller: LessonsApiCaller) => Promise<{ companyId: OrgId; role: OrgRole }>,
  log: (event: string, fields?: Record<string, unknown>) => void,
  caller: LessonsApiCaller,
  rawProject: string,
): Promise<LessonsContext> {
  const { companyId, role, lessons } = await resolveCompanyLessons(options, membershipOf, caller);
  const personId = caller.personId;
  const { project, onRoster } = await resolveProjectAccess(options, lessons, companyId, personId, rawProject);
  const runtime = lessons.runtime;
  /** Who may inspect replay or change the project's lessons settings: company owner/admin or project maintainer. */
  const mayChange = async (): Promise<boolean> => {
    if (role === "owner" || role === "admin") return true;
    try { return (await options.projectRole(companyId, project, personId)) === "maintainer"; } catch (error) { rethrowMembershipReadFailure(error); return false; }
  };
  return {
    options, log, caller, companyId, role, personId, project, onRoster, lessons, runtime,
    deps: runtime.routes,
    who: { orgId: companyId, developerId: personId },
    where: { workspaceId: companyId, project },
    mayChange,
  };
}

async function handleWeekly(ctx: LessonsContext): Promise<unknown> {
  if (!ctx.onRoster) throw notFound(NO_SUCH_PROJECT);
  try {
    const digest = await buildLessonsDigest(ctx.deps, ctx.who, ctx.project);
    return { project: ctx.project, weekly: { needLook: digest.weekly?.needLook ?? [], picks: digest.weekly?.picks ?? [] } };
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
  }
}

async function handleTaskRoute(ctx: LessonsContext, request: LessonsApiRequest, parsed: ParsedLessonsRoute): Promise<unknown> {
  const taskId = decodeTaskId(parsed.rawTask);
  const task = await ctx.lessons.readTask(taskId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
  // A task of another company or project, or one the person may not read (not on the roster and not its own person), is the same "no such task".
  // A person off the roster learns nothing about the project from a task id (the same "No such project." as a project that does not exist), not even from a task they started: a person removed from the project keeps no hold on it.
  if (!ctx.onRoster) throw notFound(NO_SUCH_PROJECT);
  if (task === undefined || task.companyId !== ctx.companyId || task.project !== ctx.project) throw agentXError("TASK_NOT_FOUND", NO_SUCH_TASK);
  if (parsed.route === "task") {
    const wikiUse = ctx.onRoster ? await ctx.options.wikiTaskUse?.(ctx.companyId, ctx.project, taskId) : undefined;
    return { project: ctx.project, taskId, ...(await buildLoadedLessons(ctx.deps, ctx.who, ctx.project, taskId)), ...(wikiUse === undefined ? {} : { wikiUse }) };
  }
  // Not helpful: the one-tap thumbs-down of a person on the project, for a lesson this task was given (the library checks it was, and that they can read it). One mark per person per lesson;
  // a lesson live on trial is retired by it, any other lesson gets a "wrong here" mark that asks a person to decide.
  bodyOf(EmptyBody, request.body, "not helpful takes no fields");
  const lessonId = decodeLessonId(parsed.rawTaskLesson);
  if (!ctx.onRoster) throw notFound(NO_SUCH_LESSON);
  const viewer = await ctx.deps.directory.identity(ctx.companyId, ctx.personId);
  const marked = await recordFeedback({ ...ctx.runtime.counters, access: ctx.runtime.access }, { ...ctx.where, taskId, lessonId, userId: ctx.personId, viewer, kind: "thumbs_down", projectMember: true });
  if (!marked.ok) {
    if (marked.code === "repeat") throw agentXError("IDEMPOTENCY_CONFLICT", "You already marked this lesson.");
    throw notFound(NO_SUCH_LESSON);
  }
  return { project: ctx.project, taskId, lessonId, marked: "not_helpful" };
}

async function handleReplay(ctx: LessonsContext, request: LessonsApiRequest): Promise<unknown> {
  if (ctx.caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
  // The measure read's rule (DEC 254zzz34): on the project's roster like every lesson read, then a maintainer, company admin or owner.
  if (!ctx.onRoster) throw notFound(NO_SUCH_PROJECT);
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", MEASURE_NEEDS_ADMIN);
  const params = Object.fromEntries(request.query?.entries() ?? []);
  if (Object.keys(params).some((name) => name !== "tasks") || (request.query?.getAll("tasks").length ?? 0) > 1) throw agentXError("CONFIG_INVALID", "replay takes tasks (1 to 50), once");
  const rawTasks = request.query?.get("tasks") ?? undefined;
  if (rawTasks !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(rawTasks)) throw agentXError("CONFIG_INVALID", "replay takes tasks (1 to 50), once");
  try { return { project: ctx.project, ...(await ctx.lessons.replay(ctx.project, rawTasks === undefined ? 30 : Number(rawTasks))) }; }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
}

async function handleSkillsList(ctx: LessonsContext, request: LessonsApiRequest, skillDeps: SkillDeps): Promise<unknown> {
  const byYou = (approvers: readonly string[]) => approvers.some((id) => id.normalize("NFC").trim().toLowerCase() === ctx.personId.normalize("NFC").trim().toLowerCase());
  // L4-JA: whether this person may decide skills (what every skill write asks the approver directory), so the screen shows the buttons only to them. Code still refuses anyone else.
  const canDecide = await mayDecideSkills(skillDeps, ctx.where, ctx.personId);
  // `?name=<skill>` (L4-JA): that one skill with the text of its newest version (the text a person approves) and, when it reads back exactly, the form to start an edit from. No other query is taken.
  const queryNames = request.query?.getAll("name") ?? [];
  if ([...(request.query?.keys() ?? [])].some((key) => key !== "name") || queryNames.length > 1 || (queryNames[0] !== undefined && !ROVARA_SKILL_NAME.test(queryNames[0]))) throw agentXError("CONFIG_INVALID", "skills takes name (one skill's name), once");
  if (queryNames[0] !== undefined) {
    let detail: Awaited<ReturnType<typeof readSkill>>;
    try { detail = await readSkill(ctx.runtime, ctx.where, queryNames[0]); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (detail === undefined) throw notFound("That skill is no longer there.");
    const { approvers, ...rest } = detail;
    return { project: ctx.project, canDecide, skills: [{ ...rest, approvedByYou: byYou(approvers) }] };
  }
  let skills: Awaited<ReturnType<typeof listSkills>>;
  try { skills = await listSkills(ctx.runtime, ctx.where); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
  return { project: ctx.project, canDecide, skills: skills.map(({ approvers, ...rest }) => ({ ...rest, approvedByYou: byYou(approvers) })) };
}

async function handleSkillDraft(ctx: LessonsContext, request: LessonsApiRequest, rawLesson: string | undefined, skillDeps: SkillDeps): Promise<unknown> {
  const body = bodyOf(SkillDraftBody, request.body, "a skill draft takes an optional name (lowercase letters, digits and hyphens)");
  const lessonId = decodeLessonId(rawLesson);
  const made = await draftSkillFromLesson(skillDeps, ctx.where, { lessonId, by: ctx.personId, name: body.name });
  if (!made.ok) throw skillRefusalOf(made.code);
  ctx.log("skill_drafted", { companyId: ctx.companyId });
  return { project: ctx.project, name: made.name, version: made.version, ...(made.note === undefined ? {} : { note: made.note }) };
}

async function handleSkillEdit(ctx: LessonsContext, request: LessonsApiRequest, skillName: string, skillDeps: SkillDeps): Promise<unknown> {
  const body = bodyOf(SkillEditBody, request.body, "a skill edit takes expectedVersion, description, when, steps (1 to 12), and optionally doneWhen and why");
  const done = await editSkill(skillDeps, ctx.where, { name: skillName, by: ctx.personId, expectedVersion: body.expectedVersion, form: { description: body.description, when: body.when, steps: body.steps, doneWhen: body.doneWhen, why: body.why } });
  if (!done.ok) throw skillRefusalOf(done.code);
  return { project: ctx.project, name: skillName, version: done.version, ...(done.note === undefined ? {} : { note: done.note }) };
}

async function handleSkillApprove(ctx: LessonsContext, request: LessonsApiRequest, skillName: string, skillDeps: SkillDeps): Promise<unknown> {
  const body = bodyOf(SkillApproveBody, request.body, "an approval takes the version you read");
  const done = await approveSkill(skillDeps, ctx.where, { name: skillName, version: body.version, by: ctx.personId });
  if (!done.ok) throw skillRefusalOf(done.code);
  return { project: ctx.project, name: skillName, version: body.version, approvals: done.approvals, live: done.live };
}

async function handleSkillRoute(ctx: LessonsContext, request: LessonsApiRequest, parsed: ParsedLessonsRoute): Promise<unknown> {
  // Rovara skills (L4-AK3). Reads need the roster; every write is a person who decides (the library asks the approver directory now), never a script token (refused above), and is audited by the library before it is made.
  const skillDeps: SkillDeps = skillDepsOf(ctx.runtime, { companyId: ctx.companyId, now: ctx.options.now, log: ctx.log });
  if (parsed.route === "skills") return await handleSkillsList(ctx, request, skillDeps);
  if (parsed.route === "skill") return await handleSkillDraft(ctx, request, parsed.rawLesson, skillDeps);
  const skillName = parsed.rawSkill;
  if (skillName === undefined) throw notFound(ROUTE_NOT_FOUND);
  if (parsed.route === "skill-edit") return await handleSkillEdit(ctx, request, skillName, skillDeps);
  if (parsed.route === "skill-approve") return await handleSkillApprove(ctx, request, skillName, skillDeps);
  bodyOf(EmptyBody, request.body, "retiring a skill takes no fields");
  const retired = await retireSkill(skillDeps, ctx.where, { name: skillName, by: ctx.personId });
  if (!retired.ok) throw skillRefusalOf(retired.code);
  return { project: ctx.project, name: skillName, retired: true };
}

async function handleList(ctx: LessonsContext, request: LessonsApiRequest): Promise<unknown> {
  const query = PageQuery.safeParse(Object.fromEntries(request.query?.entries() ?? []));
  if (!query.success || hasDuplicateQueryKeys(request.query)) throw agentXError("CONFIG_INVALID", "list takes list (proposed, approved or retired), since, limit (1 to 50) and cursor, once each");
  const after = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor, query.data.list);
  const page = await buildLessonsPage(ctx.deps, ctx.who, ctx.project, { list: query.data.list, limit: query.data.limit ?? PAGE_DEFAULT, ...(after === undefined ? {} : { after }), ...(query.data.since === undefined ? {} : { since: query.data.since }) });
  // "Used in N tasks": the distinct tasks each shown lesson was given to (its use rows, this company and project only). A lesson that could not be counted has no `usedInTasks`, and the page says so (`usedInIncomplete`).
  // A proposed lesson has never been given to a task, so the proposed list is not counted (no `usedInTasks`, and the page is not incomplete for it).
  const used = query.data.list === "proposed" ? { counts: new Map<string, { tasks: number; more?: true }>(), incomplete: false } : await countLessonUses(ctx.runtime.documents, { companyId: ctx.companyId, project: ctx.project, lessonIds: page.lessons.map((one) => one.id), now: ctx.options.now() });
  const lessonsShown = page.lessons.map((one) => { const count = used.counts.get(one.id); return count === undefined ? one : { ...one, usedInTasks: count.tasks, ...(count.more === true ? { usedInTasksMore: true as const } : {}) }; });
  return { ...page, lessons: lessonsShown, ...(used.incomplete ? { usedInIncomplete: true } : {}), ...(page.next === undefined ? {} : { next: encodeLessonCursor(page.next) }) };
}

async function handleMeasure(ctx: LessonsContext): Promise<unknown> {
  // Phase 0 (measure only, `lessons/measure.ts`): numbers about loads and merges, ids never shown. For the people who run the project's learning, never a script token.
  if (ctx.caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", MEASURE_NEEDS_ADMIN);
  try { return await readLessonMeasure(ctx.runtime.documents, { companyId: ctx.companyId, project: ctx.project, now: ctx.options.now() }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
}

function parseAreaSelection(data: z.infer<typeof AreasQuery>): AreaSelection | undefined {
  if (data.whole === "1") {
    if (data.repo !== undefined || data.folder !== undefined) throw agentXError("CONFIG_INVALID", "whole=1 takes nothing else");
    return { whole: true };
  }
  if (data.repo !== undefined) {
    const folder = folderOfRequest(data.folder ?? "");
    if (folder === undefined) throw agentXError("CONFIG_INVALID", "folder is not a plain folder path");
    return { repo: data.repo === "*" ? null : data.repo, folder };
  }
  if (data.folder !== undefined) throw agentXError("CONFIG_INVALID", "folder needs repo");
  return undefined;
}

async function handleAreas(ctx: LessonsContext, request: LessonsApiRequest): Promise<unknown> {
  // Lead 4 L4-LP3W: the approved lessons by code area (anyone on the project reads, like the approved list).
  const query = AreasQuery.safeParse(Object.fromEntries(request.query?.entries() ?? []));
  if (!query.success || hasDuplicateQueryKeys(request.query)) throw agentXError("CONFIG_INVALID", "areas takes repo (a name, or *), folder and whole=1, once each");
  const selection = parseAreaSelection(query.data);
  return await buildLessonsByArea(ctx.deps, ctx.who, ctx.project, selection === undefined ? {} : { selection });
}

async function handleLearningSource(ctx: LessonsContext, request: LessonsApiRequest, rawSource: string | undefined): Promise<unknown> {
  const sourceKey = SOURCE_KEY.safeParse(rawSource);
  if (!sourceKey.success) throw notFound(ROUTE_NOT_FOUND);
  const body = bodyOf(LearningSourcePauseBodySchema, request.body, "pause takes paused: true or false");
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", SOURCE_NEEDS_ADMIN);
  let outcome: Awaited<ReturnType<typeof setLearningSourcePause>>;
  try { outcome = await setLearningSourcePause({ store: ctx.runtime.store, audit: ctx.runtime.audit, now: ctx.options.now, log: (event, fields) => ctx.log(event, fields) }, ctx.where, ctx.personId, sourceKey.data, body.paused); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
  if (!outcome.ok) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
  ctx.log("learning_source_set", { companyId: ctx.companyId, paused: outcome.paused });
  return { project: ctx.project, key: sourceKey.data, paused: outcome.paused };
}

async function handleTuning(ctx: LessonsContext): Promise<unknown> {
  // The tuning report (`lessons/tuning.ts`): suggested values for the settings phases 1 and 2 introduce, from the project's own measured rows; "not enough data yet (N of M loads)" until there are enough.
  // Read only: an operator or admin applies a value; nothing here changes by itself. For the people who run the project's learning, never a script token.
  if (ctx.caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", TUNING_NEEDS_ADMIN);
  try { return await readTuningReport(ctx.runtime.documents, { companyId: ctx.companyId, project: ctx.project, now: ctx.options.now() }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
}

async function handleWeeklySummary(ctx: LessonsContext, request: LessonsApiRequest, method: string): Promise<unknown> {
  if (method === "GET") {
    let setting: Awaited<ReturnType<typeof resolveDigestSettingStrict>>;
    try { setting = await resolveDigestSettingStrict(ctx.runtime.documents, ctx.companyId, ctx.project, digestPilotOf(ctx.options)); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    return { project: ctx.project, on: setting.on, source: setting.source, canChange: await ctx.mayChange() };
  }
  const body = bodyOf(WeeklySummaryBody, request.body, "the weekly summary takes on: true or false");
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", SUMMARY_NEEDS_ADMIN);
  // The record first: no record, no change.
  if (!(await requireAudit(ctx.runtime.audit, { action: "lesson.digest_switched", workspaceId: ctx.companyId, project: ctx.project, actor: ctx.personId, facts: { enabled: body.on } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
  try { await writeDigestSetting(ctx.runtime.documents, ctx.companyId, ctx.project, body.on, ctx.options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
  ctx.log("weekly_summary_set", { companyId: ctx.companyId, on: body.on });
  return { project: ctx.project, on: body.on, source: "chosen", canChange: true };
}

async function readProjectLearningMode(ctx: LessonsContext): Promise<ProjectLearningMode> {
  const settings = await ctx.runtime.settings.read(ctx.companyId, ctx.project).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
  const resolved = await resolveLearning(ctx.runtime.settings, ctx.companyId, ctx.project);
  // No settings, or no mode stored, is the default (Suggest, DEC 226).
  const stored = (settings as { mode?: unknown } | undefined)?.mode ?? DEFAULT_LEARNING_MODE;
  const own: LessonApiMode = typeof stored === "string" && stored in FROM_STORED ? FROM_STORED[stored as LearningMode] : "off";
  return { settings, resolved, own };
}

/**
 * The earned-trust offer (DEC 231): only while the project's own mode and the mode in force are both Suggest (no company lock), accepting would really start trials and nothing more (Standard preset,
 * no approval floor, required group or two-person rule, tier 0 not set to go live by itself: `trialWouldStart`), the offer is earned and nobody said "not now" lately. Undefined: no offer. Who may not
 * change the mode is never offered it.
 */
async function readTrialOfferDue(ctx: LessonsContext, mode: ProjectLearningMode): Promise<TrialOfferTally | undefined> {
  if (mode.own !== "suggest" || FROM_STORED[mode.resolved.chosenMode] !== "suggest" || mode.resolved.preset !== "standard") return undefined;
  if (!trialWouldStart(mode.settings ?? {}, mode.resolved)) return undefined;
  if (await trialOfferSnoozed(ctx.runtime.documents, ctx.companyId, ctx.project, ctx.options.now())) return undefined;
  const tally = await tallyTrialOffer(ctx.runtime.store, ctx.where, ctx.options.now());
  return tally !== undefined && trialOfferEarned(tally) ? tally : undefined;
}

async function handleTrialOffer(ctx: LessonsContext, request: LessonsApiRequest, mode: ProjectLearningMode): Promise<unknown> {
  const body = bodyOf(TrialOfferBody, request.body, "the decision is accept or not_now");
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", MODE_NEEDS_ADMIN);
  // Answered against the offer as it stands now: one that is no longer due (the mode changed, a lock came, a drop, someone answered) is not answered under the person.
  const tally = await readTrialOfferDue(ctx, mode);
  if (tally === undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "There is no offer to answer now.");
  if (body.decision === "not_now") {
    // The record first: no record, no change.
    if (!(await requireAudit(ctx.runtime.audit, { action: "lesson.trial_offer_answered", workspaceId: ctx.companyId, project: ctx.project, actor: ctx.personId, facts: { answer: "not_now", approvals: tally.approvals, drops: tally.drops } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
    try { await snoozeTrialOffer(ctx.runtime.documents, ctx.companyId, ctx.project, ctx.options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "That could not be saved. Try again."); }
    ctx.log("trial_offer_not_now", { companyId: ctx.companyId });
    return { project: ctx.project, decision: "not_now", mode: mode.own };
  }
  // Accepting is a change of mode: ONE record (the mode change, marked as the offer's), before the write. The write holds only while the mode is still Suggest, so a mode someone changed since the
  // offer was read is never written over (the person is told there is no offer now; the record then stands for an answer that changed nothing, the safe way round).
  if (!(await requireAudit(ctx.runtime.audit, { action: "lesson.mode_changed", workspaceId: ctx.companyId, project: ctx.project, actor: ctx.personId, facts: { from: mode.own, to: "auto", via: "trial_offer", approvals: tally.approvals, drops: tally.drops } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
  let written: boolean;
  try { written = await writeLearningModeFromSuggest(ctx.runtime.documents, ctx.where, TO_STORED.auto, ctx.options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The mode could not be saved. Try again."); }
  if (!written) throw agentXError("IDEMPOTENCY_CONFLICT", "There is no offer to answer now.");
  // Best effort: a project that goes back to Suggest later is not offered trial again at once.
  await snoozeTrialOffer(ctx.runtime.documents, ctx.companyId, ctx.project, ctx.options.now()).catch(() => undefined);
  ctx.log("trial_offer_accepted", { companyId: ctx.companyId });
  const after = await resolveLearning(ctx.runtime.settings, ctx.companyId, ctx.project);
  return { project: ctx.project, decision: "accept", mode: "auto", effective: FROM_STORED[after.chosenMode] };
}

async function handleModeRoute(ctx: LessonsContext, request: LessonsApiRequest, parsed: ParsedLessonsRoute): Promise<unknown> {
  const mode = await readProjectLearningMode(ctx);
  if (parsed.route === "mode/trial-offer") return await handleTrialOffer(ctx, request, mode);
  if (parsed.method === "GET") {
    const effective = FROM_STORED[mode.resolved.chosenMode];
    const canChange = await ctx.mayChange();
    // The offer is extra: a tally that cannot be read is no offer, never a failed read of the mode.
    const offer = canChange ? await readTrialOfferDue(ctx, mode).catch(() => undefined) : undefined;
    return { project: ctx.project, mode: mode.own, effective, lockedByCompany: effective !== mode.own, canChange, ...(offer === undefined ? {} : { trialOffer: { approvals: offer.approvals, drops: offer.drops, since: offer.since } }) };
  }
  const body = bodyOf(ModeBody, request.body, "the mode is off, suggest or auto");
  if (!(await ctx.mayChange())) throw agentXError("FORBIDDEN", MODE_NEEDS_ADMIN);
  // The record first: no record, no change.
  if (!(await requireAudit(ctx.runtime.audit, { action: "lesson.mode_changed", workspaceId: ctx.companyId, project: ctx.project, actor: ctx.personId, facts: { from: mode.own, to: body.mode } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
  try { await writeLearningMode(ctx.runtime.documents, ctx.where, TO_STORED[body.mode], ctx.options.now()); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "The mode could not be saved. Try again."); }
  ctx.log("mode_set", { companyId: ctx.companyId, mode: body.mode });
  const after = await resolveLearning(ctx.runtime.settings, ctx.companyId, ctx.project);
  return { project: ctx.project, mode: body.mode, effective: FROM_STORED[after.chosenMode], lockedByCompany: FROM_STORED[after.chosenMode] !== body.mode, canChange: true };
}

async function resolveRetireRequestRow(
  ctx: LessonsContext,
  viewer: Awaited<ReturnType<LessonsApiCompany["runtime"]["routes"]["directory"]["identity"]>>,
  row: Record<string, unknown>,
): Promise<{ lessonId: string; title: string; status: string; by: string; at: number } | undefined> {
  const asker = row["personId"];
  if (typeof asker !== "string" || typeof row["sk"] !== "string") return undefined;
  // An erased person's request is never shown (erase removes it too); a person whose standing cannot be read is left out.
  const erased = await ctx.options.people.isErased(ctx.companyId, asker).catch(() => true);
  if (erased) return undefined;
  const name = await ctx.options.people.displayName(ctx.companyId, asker).catch(() => undefined);
  const lesson = await ctx.runtime.store.get(ctx.where, row["sk"]);
  if (lesson === undefined || lesson.status === "retired" || lesson.status === "rejected" || lesson.status === "expired") return undefined;
  if ((await readVisible({ access: ctx.runtime.access, key: ctx.where, viewer, lessons: [lesson], where: "view" })).length !== 1) return undefined;
  return { lessonId: lesson.id, title: lesson.title, status: lesson.status, by: name === undefined ? "a former member" : attributionNameOf(name), at: typeof row["at"] === "number" ? row["at"] : 0 };
}

async function handleRetireRequests(ctx: LessonsContext): Promise<unknown> {
  const eligibility = await ctx.deps.directory.eligibility(ctx.companyId, ctx.project).catch(() => undefined);
  if (eligibility === undefined || !eligibility.complete || !idIn(eligibility.eligibleIds, ctx.personId)) throw agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can see retire requests.");
  const page = await ctx.runtime.documents.query({ pk: companyScoped(ctx.companyId, `LESSON_RETIRE_ASK#${ctx.project}`), limit: RETIRE_REQUESTS_MAX + 1 }).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
  const viewer = await ctx.deps.directory.identity(ctx.companyId, ctx.personId);
  const requests: Array<{ lessonId: string; title: string; status: string; by: string; at: number }> = [];
  for (const row of page.items.slice(0, RETIRE_REQUESTS_MAX)) {
    const entry = await resolveRetireRequestRow(ctx, viewer, row);
    if (entry !== undefined) requests.push(entry);
  }
  requests.sort((a, b) => b.at - a.at || a.lessonId.localeCompare(b.lessonId));
  return { project: ctx.project, requests, more: page.items.length > RETIRE_REQUESTS_MAX };
}

function refusalOutcome(lessonId: string, code: ApprovalFailure): DecisionOutcome {
  const refused = refusalOf(code);
  return { lessonId, ok: false, code: refused.code, message: refused.message.slice(refused.code.length + 2) };
}

async function applyOneDecision(ctx: LessonsContext, decision: DecisionItem): Promise<DecisionOutcome> {
  const one = { ...ctx.where, lessonId: decision.lessonId, approverId: ctx.personId, expectedVersion: decision.version };
  // A fault on one lesson answers for that lesson only: the decisions already made are still reported.
  try {
    if (decision.decision === "keep") {
      const result = await approveLesson(ctx.deps, { ...one, ...(decision.edit === undefined ? {} : { edit: decision.edit }) });
      return result.ok ? { lessonId: decision.lessonId, ok: true, status: result.status } : refusalOutcome(decision.lessonId, result.code);
    }
    const result = await rejectLesson(ctx.deps, { ...one, reason: decision.reason });
    return result.ok ? { lessonId: decision.lessonId, ok: true, status: "rejected" } : refusalOutcome(decision.lessonId, result.code);
  } catch (error) {
    ctx.log("decision_failed", { error: error instanceof Error ? error.name : "unknown" });
    return { lessonId: decision.lessonId, ok: false, code: "RUNTIME_UNAVAILABLE", message: UNAVAILABLE };
  }
}

async function handleDecisions(ctx: LessonsContext, request: LessonsApiRequest): Promise<unknown> {
  const body = bodyOf(DecisionsBody, request.body, `decisions takes 1 to ${String(DECISIONS_MAX)} distinct lessons, each { lessonId, version, decision: keep, edit? } or { lessonId, version, decision: drop, reason }`);
  // One at a time, in the order given; each answers for itself (a refusal of one never undoes or blocks another). Each is the same library call as the single routes, audited the same way.
  const results: DecisionOutcome[] = [];
  for (const decision of body.decisions) results.push(await applyOneDecision(ctx, decision));
  return { project: ctx.project, results };
}

async function handleRetireRequest(ctx: LessonsContext, request: LessonsApiRequest, lessonId: string): Promise<unknown> {
  // A retire request: anyone on the project who can see the lesson asks; the people who decide answer it.
  bodyOf(EmptyBody, request.body, "a retire request takes no fields");
  const lesson = await ctx.runtime.store.get(ctx.where, lessonId);
  const viewer = await ctx.deps.directory.identity(ctx.companyId, ctx.personId);
  if (lesson === undefined || (lesson.status !== "active" && lesson.status !== "stale" && lesson.status !== "pending")
    || (await readVisible({ access: ctx.runtime.access, key: ctx.where, viewer, lessons: [lesson], where: "view" })).length !== 1) throw notFound(NO_SUCH_LESSON);
  if (!(await requireAudit(ctx.runtime.audit, { action: "lesson.retire_requested", workspaceId: ctx.companyId, project: ctx.project, lessonId, actor: ctx.personId, facts: { via: "api" } }))) throw agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
  const documents = ctx.runtime.documents;
  const at = ctx.options.now();
  await documents.put({ item: {
    ...retireAskKey(ctx.companyId, ctx.project, lessonId), entityType: "LESSON_RETIRE_ASK", personId: ctx.personId, via: "api", at,
    ...(documents.ttlAttribute === undefined ? {} : { [documents.ttlAttribute]: Math.floor(at / 1000) + RETIRE_REQUEST_KEEP_SECONDS }),
  // The first open request stands (a later asker does not replace it, so erasing the later asker never drops an earlier person's request).
  }, condition: { op: "notExists", path: ["pk"] } }).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", "The request could not be saved. Try again."); });
  return { project: ctx.project, lessonId, requested: true };
}

async function handleSingleLessonAction(ctx: LessonsContext, request: LessonsApiRequest, parsed: ParsedLessonsRoute): Promise<unknown> {
  // The writes on one lesson.
  const lessonId = decodeLessonId(parsed.rawLesson);
  switch (parsed.action) {
    case "approve": {
      const body = bodyOf(ApproveBody, request.body, "approve takes the version you read");
      const result = await approveLesson(ctx.deps, { ...ctx.where, lessonId, approverId: ctx.personId, expectedVersion: body.version, ...(body.edit === undefined ? {} : { edit: body.edit }) });
      if (!result.ok) throw refusalOf(result.code);
      return { project: ctx.project, lessonId, status: result.status, version: result.lesson.version, needs: result.needs };
    }
    case "reject": {
      const body = bodyOf(RejectBody, request.body, `reject takes the version you read and a reason: ${REJECT_REASONS.join(", ")}`);
      const result = await rejectLesson(ctx.deps, { ...ctx.where, lessonId, approverId: ctx.personId, reason: body.reason, expectedVersion: body.version });
      if (!result.ok) throw refusalOf(result.code);
      return { project: ctx.project, lessonId, status: "rejected" };
    }
    case "retire": {
      const body = bodyOf(RetireBody, request.body, `retire takes a reason: ${RETIRE_REASONS.join(", ")}`);
      const result = await retireByPerson(ctx.deps, { ...ctx.where, lessonId, actorId: ctx.personId, reason: body.reason });
      if (!result.ok) throw refusalOf(result.code);
      // The request (if any) is answered: best effort, it no longer shows once the lesson is retired either way.
      await ctx.runtime.documents.delete({ key: retireAskKey(ctx.companyId, ctx.project, lessonId) }).catch(() => undefined);
      return { project: ctx.project, lessonId, status: "retired" };
    }
    case "keep": {
      // The answer to "Keep it?": the people who decide (read live) renew a lesson a question stands on. Audited before the write by the library; a refusal is its fixed words.
      bodyOf(EmptyBody, request.body, "keep takes no fields");
      const result = await keepByPerson({ ...ctx.deps, evidence: ctx.runtime.evidence }, { ...ctx.where, lessonId, actorId: ctx.personId });
      if (!result.ok) throw refusalOf(result.code);
      return { project: ctx.project, lessonId, kept: true };
    }
    default:
      return await handleRetireRequest(ctx, request, lessonId);
  }
}

async function dispatchRosterRoute(ctx: LessonsContext, request: LessonsApiRequest, parsed: ParsedLessonsRoute): Promise<unknown> {
  switch (parsed.route) {
    case "skills":
    case "skill":
    case "skill-edit":
    case "skill-approve":
    case "skill-retire":
      return await handleSkillRoute(ctx, request, parsed);
    case "list":
      return await handleList(ctx, request);
    case "measure":
      return await handleMeasure(ctx);
    case "areas":
      return await handleAreas(ctx, request);
    case "learning-sources":
      // Lead 4 L4-LP3W: "Where Rovara learns from" and its Pause.
      return await buildLearningSources(ctx.deps, ctx.who, ctx.project, { canPause: await ctx.mayChange() });
    case "learning-source":
      return await handleLearningSource(ctx, request, parsed.rawSource);
    case "tuning":
      return await handleTuning(ctx);
    case "weekly-summary":
      return await handleWeeklySummary(ctx, request, parsed.method);
    case "mode":
    case "mode/trial-offer":
      return await handleModeRoute(ctx, request, parsed);
    case "retire-requests":
      return await handleRetireRequests(ctx);
    case "decisions":
      return await handleDecisions(ctx, request);
    default:
      return await handleSingleLessonAction(ctx, request, parsed);
  }
}

export function createLessonsApi(options: LessonsApiOptions): LessonsApi {
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "lessons-api", event, ...fields });

  /** The caller's company and role from membership, checked. */
  async function membershipOf(caller: LessonsApiCaller): Promise<{ companyId: OrgId; role: OrgRole }> {
    let found: unknown;
    try { found = await options.companyOf(caller); } catch (error) { rethrowMembershipReadFailure(error); found = undefined; }
    const record = found as { companyId?: unknown; role?: unknown } | undefined | null;
    const companyId = OrgIdSchema.safeParse(record?.companyId);
    const role = OrgRoleSchema.safeParse(record?.role);
    if (!companyId.success || !role.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    return { companyId: companyId.data, role: role.data };
  }

  async function answer(request: LessonsApiRequest, caller: LessonsApiCaller): Promise<unknown> {
    const parsed = parseLessonsRoute(request);
    const ctx = await resolveRequestContext(options, membershipOf, log, caller, parsed.rawProject);
    if (parsed.route === "weekly") return await handleWeekly(ctx);
    if (parsed.route === "task" || parsed.route === "not-helpful") return await handleTaskRoute(ctx, request, parsed);
    if (parsed.route === "replay") return await handleReplay(ctx, request);
    if (!ctx.onRoster) throw notFound(NO_SUCH_PROJECT);
    if (parsed.graduation !== null) return await answerGraduation(request, parsed.graduation, { companyId: ctx.companyId, project: ctx.project, personId: ctx.personId, lessons: ctx.lessons, skills: ctx.options.skillsOf?.(ctx.companyId), now: ctx.options.now, log: ctx.log }, ctx.caller);
    return await dispatchRosterRoute(ctx, request, parsed);
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
