// Lessons phase 4 on the Code lessons API (the weekly cards and what a person does with them), for ONE project of the caller's OWN company. The paths are served by `createLessonsApi` (`lessons-api.ts`), which does the
// switch, the membership, the roster and the script-token checks BEFORE it hands a request here; everything below runs as the signed-in person.
//
//   GET  /v1/dev/projects/{project}/lessons/graduation                           this week's cards: the one "Make this permanent?" card, the Tidy card, and the draft check tasks waiting for a person
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/graduate                  { target: rule|check|skill, paths?, name? }   make a proven lesson permanent (a tier-2 lesson waits for a second person)
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/graduate-later            {}                                            "Not now": not offered for 60 days, and this week's card is used
//   POST /v1/dev/projects/{project}/lessons/{lessonId}/both-places               { version, cardPaths, otherPaths }            the third answer to a conflict: both are right, in different places
//   POST /v1/dev/projects/{project}/lessons/tidy/retire-chosen                          { ids }                                       retire the chosen lessons of the Tidy card
//   POST /v1/dev/projects/{project}/lessons/tidy/later                           {}                                            "Not now" on the Tidy card
//   POST /v1/dev/projects/{project}/lessons/check-drafts/{draftId}/started       { taskId }                                    a person says which task they started from a draft (their own, in this project)
//   POST /v1/dev/projects/{project}/lessons/check-drafts/{draftId}/dismiss       {}                                            a person who decides drops a draft
//   POST /v1/dev/projects/{project}/lessons/rules/{ruleId}/retire                {}                                            a person who decides takes a team rule out of use at once (audited first)
// Nothing here starts a task. A draft is text; the person starts the work in the usual place and tells Rovara which task it was.
import { agentXError, type AgentXError, type OrgId } from "@agentx/contracts";
import { z } from "zod";
import { approveAfterSettle, settleBothPlaces } from "../lessons/settle-both.js";
import { GRADUATION_TARGETS, graduateLesson, graduationLater, weeklyCard, type GraduateDeps } from "../lessons/graduate.js";
import { GraduationUnreadable, getCheckDraft, isDraftId, listCheckDrafts, moveCheckDraft } from "../lessons/graduation-store.js";
import { retireTidy, tidyCard, tidyLater } from "../lessons/tidy.js";
import { createTeamRulePublisher, liveRules, readTeamRules, retireTeamRule, TEAM_RULE_GLOB_MAX, TEAM_RULE_PATHS_MAX } from "../lessons/team-rules.js";
import { requireAudit } from "../lessons/policy.js";
import { skillDepsOf, skillGraduationOf } from "../lessons/skill-graduation.js";
import { freshSignalsReader } from "../lessons/signals.js";
import { idIn } from "../lessons/types.js";
import type { CoreLessons } from "./lessons.js";
import type { LessonsApiRequest } from "./lessons-api.js";
import type { SkillGraduation } from "../lessons/graduate.js";

/** The paths this part of the API serves. `lessons-api.ts` tests it BEFORE its own paths (`tidy` and `check-drafts` would otherwise read as a lesson id). */
export const LESSONS_GRADUATION_API = /^\/v1\/dev\/projects\/([^/]+)\/lessons\/(?:(graduation)|tidy\/(retire-chosen|later)|check-drafts\/(chk_[0-9a-f]{16})\/(started|dismiss)|rules\/(rule_[0-9a-f]{16})\/(retire)|([A-Za-z0-9_-]{4,64})\/(graduate|graduate-later|both-places))$/u;

const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
const NOT_RECORDED = "That could not be recorded, so nothing was changed. Try again.";
/** The same slug every skill name is (L4-AK3's `ROVARA_SKILL_NAME`). */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const Glob = z.string().min(1).max(TEAM_RULE_GLOB_MAX);
const Globs = z.array(Glob).min(1).max(TEAM_RULE_PATHS_MAX);
const GraduateBody = z.object({ target: z.enum(GRADUATION_TARGETS), paths: Globs.optional(), name: z.string().regex(SKILL_NAME).optional() }).strict();
const BothBody = z.object({ version: z.number().int().min(1).max(1_000_000), cardPaths: Globs, otherPaths: Globs }).strict();
const TidyBody = z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u)).min(1).max(10) }).strict();
const StartedBody = z.object({ taskId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u) }).strict();
const EmptyBody = z.object({}).strict();

function bodyOf<T>(schema: z.ZodType<T>, body: string | undefined, words: string): T {
  let raw: unknown;
  try { raw = body === undefined || body === "" ? {} : JSON.parse(body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", words);
  return parsed.data;
}

/** The words a refusal is answered with: fixed, never the cause or anything the caller sent. */
export function graduationRefusalOf(code: string): AgentXError {
  switch (code) {
    case "not_found": return agentXError("NOT_FOUND", "That lesson is no longer there.");
    case "not_eligible": return agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can decide lessons.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not tell who may decide this. Try again.");
    case "mode_off": return agentXError("FORBIDDEN", "Learning is off for this project.");
    case "not_active": return agentXError("IDEMPOTENCY_CONFLICT", "That lesson is not in use now.");
    case "restricted": case "task_not_shared": case "not_trusted": return agentXError("FORBIDDEN", "That lesson came from a place only some people can read, so it cannot become something the whole project reads.");
    case "not_proven": return agentXError("FORBIDDEN", "That lesson has not proved itself yet.");
    case "wrong_target": return agentXError("CONFIG_INVALID", "That kind of lesson cannot become that.");
    case "bad_paths": return agentXError("CONFIG_INVALID", "Those paths cannot be used. Use plain relative paths such as src/billing/**.");
    case "already_approved": return agentXError("IDEMPOTENCY_CONFLICT", "That lesson already became something else, or you already asked.");
    case "second_person_required": return agentXError("FORBIDDEN", "This lesson needs a second person to make it permanent.");
    case "sole_owner_cool_off": return agentXError("FORBIDDEN", "This can be done by you alone after a short wait.");
    case "no_skills": return agentXError("FORBIDDEN", "Skills are not available for this project yet.");
    case "skill_refused": return agentXError("FORBIDDEN", "A skill could not be made from that lesson.");
    case "rule_refused": return agentXError("FORBIDDEN", "That lesson could not be made into a rule. It may ask for more than advice, or the project already holds the most rules it can.");
    case "check_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "The draft task could not be saved. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", NOT_RECORDED);
    case "conflict": case "not_pending": case "not_newest": return agentXError("IDEMPOTENCY_CONFLICT", "This lesson changed since you read it. Read it again and decide again.");
    case "not_a_conflict": return agentXError("IDEMPOTENCY_CONFLICT", "That lesson does not conflict with another one.");
    case "other_not_live": return agentXError("IDEMPOTENCY_CONFLICT", "The other lesson is no longer in use, so there is nothing to settle.");
    case "not_permitted": return agentXError("FORBIDDEN", "You cannot see where one of these lessons came from, so you cannot decide this.");
    case "same_place": return agentXError("CONFIG_INVALID", "Give the two lessons different places.");
    case "wider_than_before": return agentXError("CONFIG_INVALID", "The older lesson can only get narrower: choose paths inside the ones it has.");
    case "paths_outside": return agentXError("CONFIG_INVALID", "A rule can only apply to part of where the lesson applies. Choose paths inside the lesson's own.");
    case "request_differs": return agentXError("IDEMPOTENCY_CONFLICT", "The first person asked for something else (another target or other paths). Ask for the same, or start again.");
    case "no_card": return agentXError("IDEMPOTENCY_CONFLICT", "There is no card to answer now.");
    case "not_on_card": return agentXError("CONFIG_INVALID", "Choose lessons from the card.");
    default: return agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
  }
}

export interface GraduationContext {
  companyId: OrgId; project: string; personId: string;
  lessons: Pick<CoreLessons, "runtime" | "readTask">;
  /** The skills library, when the deployment has it (L4-AK3). */
  skills?: SkillGraduation | undefined;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * A page read ("graduation" GET) uses the shared cached signals; every decision (a POST) reads them fresh. The skills library is the company's own (`skillDepsOf`) unless a test hands another.
 */
function depsOf(ctx: GraduationContext, fresh: boolean): GraduateDeps {
  const runtime = ctx.lessons.runtime;
  return {
    now: ctx.now, audit: runtime.audit, store: runtime.store, directory: runtime.directory, settings: runtime.settings, vectors: runtime.vectors,
    publisher: createTeamRulePublisher({ store: runtime.documents, companyId: ctx.companyId, now: ctx.now }),
    taskVisibility: runtime.access.taskVisibility, documents: runtime.documents, access: runtime.access, signals: fresh ? freshSignalsReader(runtime.documents, ctx.companyId, ctx.now) : runtime.signals, skills: ctx.skills ?? skillGraduationOf(skillDepsOf(runtime, { companyId: ctx.companyId, now: ctx.now, log: (event, fields) => ctx.log(event, fields) })),
    log: (event, fields) => ctx.log(event, fields),
  };
}

/** Answers one graduation route. The caller has already checked the switch, the company, the roster and that a script token is not writing; reads by a script token are refused here too (a decision surface). */
export async function answerGraduation(request: LessonsApiRequest, match: RegExpExecArray, ctx: GraduationContext, caller: { scriptToken?: unknown }): Promise<unknown> {
  if (caller.scriptToken !== undefined) throw agentXError("FORBIDDEN", "A script token cannot do that.");
  const [, , graduation, tidyAction, draftId, draftAction, ruleId, , rawLesson, lessonAction] = match;
  const { project, personId, companyId } = ctx;
  const deps = depsOf(ctx, request.method !== "GET");
  const where = { workspaceId: companyId, project };
  const method = request.method;
  const need = (expected: "GET" | "POST"): void => { if (method !== expected) throw agentXError("NOT_FOUND", "route not found"); };
  try {
    if (graduation !== undefined) {
      need("GET");
      const viewer = await deps.directory.identity(companyId, personId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
      const group = await deps.directory.eligibility(companyId, project, { approverId: personId }).catch(() => undefined);
      const canDecide = group !== undefined && group.complete && idIn(group.eligibleIds, personId);
      const card = await weeklyCard(deps, where, viewer);
      const tidy = await tidyCard(tidyDeps(deps), where, viewer);
      const drafts = (await listCheckDrafts(deps.documents, companyId, project)).filter((draft) => draft.status === "draft").map(({ id, lessonId, title, request: text, paths, createdAt }) => ({ id, lessonId, title, request: text, paths, createdAt }));
      // The team rules in use, for people who decide (a rule is read by every step it applies to, so they can see and retire it).
      const rules = canDecide ? liveRules(await readTeamRules(deps.documents, companyId, project).catch(() => { throw new GraduationUnreadable(); })).map(({ id, text, paths, repos, fromLesson, createdAt }) => ({ id, text, paths, repos, fromLesson, createdAt })) : [];
      return { project, canDecide, ...(card === undefined ? {} : { card }), ...(tidy === undefined ? {} : { tidy }), drafts, rules };
    }
    need("POST");
    if (tidyAction !== undefined) {
      if (tidyAction === "later") {
        bodyOf(EmptyBody, request.body, "this takes no fields");
        const done = await tidyLater(tidyDeps(deps), { ...where, actorId: personId });
        if (!done.ok) throw graduationRefusalOf(done.code);
        return { project, closed: true };
      }
      const body = bodyOf(TidyBody, request.body, "retiring takes 1 to 10 lessons from the card");
      const done = await retireTidy(tidyDeps(deps), { ...where, actorId: personId, ids: body.ids });
      if (!done.ok) throw graduationRefusalOf(done.code);
      ctx.log("tidy_retired", { retired: done.retired.length });
      return { project, retired: done.retired, skipped: done.skipped };
    }
    if (ruleId !== undefined) {
      bodyOf(EmptyBody, request.body, "this takes no fields");
      const group = await deps.directory.eligibility(companyId, project, { approverId: personId }).catch(() => undefined);
      if (group === undefined || !group.complete) throw graduationRefusalOf("eligibility_unavailable");
      if (!idIn(group.eligibleIds, personId)) throw graduationRefusalOf("not_eligible");
      // The record first: no record, no change.
      if (!(await requireAudit(deps.audit, { action: "lesson.retired", workspaceId: companyId, project, actor: personId, facts: { cause: "rule_retired", tier: 0 } }))) throw graduationRefusalOf("audit_unavailable");
      const done = await retireTeamRule(deps.documents, companyId, project, ruleId, ctx.now);
      if (!done.ok) throw done.code === "not_found" ? agentXError("NOT_FOUND", "That rule is no longer in use.") : done.code === "conflict" ? graduationRefusalOf("conflict") : agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      return { project, ruleId, status: "retired" };
    }
    if (draftId !== undefined && isDraftId(draftId)) {
      const draft = await getCheckDraft(deps.documents, companyId, project, draftId);
      if (draft === undefined) throw agentXError("NOT_FOUND", "That draft is no longer there.");
      if (draftAction === "started") {
        const body = bodyOf(StartedBody, request.body, "say which task you started: its id");
        // Their own task, in this company and project: a draft is never marked from a task someone else started.
        const task = await ctx.lessons.readTask(body.taskId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); });
        if (task === undefined || task.companyId !== companyId || task.project !== project || task.developerId !== personId) throw agentXError("TASK_NOT_FOUND", "No such task.");
        const moved = await moveCheckDraft(deps.documents, companyId, project, draftId, { status: "started", taskId: body.taskId });
        if (moved !== "moved") throw agentXError("IDEMPOTENCY_CONFLICT", "That draft was already started or dropped.");
        return { project, draftId, status: "started" };
      }
      bodyOf(EmptyBody, request.body, "this takes no fields");
      const group = await deps.directory.eligibility(companyId, project, { approverId: personId }).catch(() => undefined);
      if (group === undefined || !group.complete) throw graduationRefusalOf("eligibility_unavailable");
      if (!idIn(group.eligibleIds, personId)) throw graduationRefusalOf("not_eligible");
      const moved = await moveCheckDraft(deps.documents, companyId, project, draftId, { status: "dismissed" });
      if (moved !== "moved") throw agentXError("IDEMPOTENCY_CONFLICT", "That draft was already started or dropped.");
      return { project, draftId, status: "dismissed" };
    }
    if (rawLesson === undefined) throw agentXError("NOT_FOUND", "route not found");
    const lessonId = rawLesson;
    if (lessonAction === "graduate-later") {
      bodyOf(EmptyBody, request.body, "this takes no fields");
      const done = await graduationLater(deps, { ...where, lessonId, approverId: personId });
      if (!done.ok) throw graduationRefusalOf(done.code);
      return { project, lessonId, later: true };
    }
    if (lessonAction === "both-places") {
      const body = bodyOf(BothBody, request.body, "this takes the version you read and a path set for each lesson");
      const settled = await settleBothPlaces(deps2(deps), { ...where, lessonId, approverId: personId, expectedVersion: body.version, cardPaths: body.cardPaths, otherPaths: body.otherPaths });
      if (!settled.ok) throw graduationRefusalOf(settled.code);
      // The waiting lesson is then approved as always (its tier, a second person if it needs one).
      const approved = await approveAfterSettle(deps2(deps), { ...where, lessonId, approverId: personId, expectedVersion: settled.cardVersion });
      ctx.log("both_places", { approved: approved.ok });
      return { project, lessonId, otherId: settled.otherId, cardPaths: settled.cardPaths, otherPaths: settled.otherPaths, version: settled.cardVersion, ...(approved.ok ? { status: approved.status, needs: approved.needs } : { status: "pending", needs: "decision" }) };
    }
    const body = bodyOf(GraduateBody, request.body, "this takes a target (rule, check or skill), and for a rule optionally paths");
    if (body.paths !== undefined && body.target !== "rule") throw graduationRefusalOf("bad_paths");
    const made = await graduateLesson(deps, { ...where, lessonId, approverId: personId, target: body.target, paths: body.paths, skillName: body.name });
    if (!made.ok) throw graduationRefusalOf(made.code);
    ctx.log("graduated", { target: made.target, state: made.state });
    if (made.state === "waiting") return { project, lessonId, target: made.target, state: "waiting", needs: made.needs };
    if (made.state === "drafted") return { project, lessonId, target: "skill", state: "drafted", name: made.ref, version: made.version };
    return { project, lessonId, target: made.target, state: "done", ref: made.ref, already: made.already };
  } catch (error) {
    if (error instanceof GraduationUnreadable) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    throw error;
  }
}

/** The deps the Tidy card needs: the approval deps and the document store. */
const tidyDeps = (deps: GraduateDeps) => ({ ...deps2(deps), documents: deps.documents });

/** The approve deps the settle route needs (a subset of the graduation deps). */
const deps2 = (deps: GraduateDeps) => ({ now: deps.now, audit: deps.audit, store: deps.store, directory: deps.directory, settings: deps.settings, access: deps.access, ...(deps.vectors === undefined ? {} : { vectors: deps.vectors }), ...(deps.log === undefined ? {} : { log: deps.log }) });
