// Graduation (lessons phase 4, owner decision 2026-11-17): a lesson that has PROVEN itself is offered, at most once a week per project, as "Make this permanent?". Everything stays inside Rovara. A person chooses where it goes:
//   rule    a team rule in Rovara, scoped to the lesson's code area (`team-rules.ts`): the default for conventions, facts and review checks
//   check   a DRAFT task, "Add a check for ...", that a person starts on their own (`graduation-store.ts`): for pitfalls. Nothing here starts it, and nothing in this module can: there is no task port in its dependencies
//   skill   a Rovara skill (L4-AK3's `draftSkillFromLesson`, through `SkillGraduation`): for procedures. A skill needs two people to approve it, whatever the lesson's tier; the lesson becomes the skill when it goes live
// No repository file, and no download.
//
// The rules, for every target:
//   - a person who may decide lessons for the project, read live; a lesson from a place only some people can read, or from a task that is narrower than the project, is never made permanent (it would be read by everyone);
//   - only a PROVEN lesson (`ProvenReader`, `proven.ts`), counted now;
//   - a tier-2 lesson (tests, checks, reviews, security) needs TWO people, whatever the target (`secondPersonStep`); the first waits, the second finishes. A skill's own two approvals stand in for it;
//   - the ledger is written BEFORE anything is changed (no record, no change);
//   - the lesson is then retired with a `became` link (`became.ts`): it is not handed to a step as a lesson again, and it stays in the archive with that link and its history;
//   - one card a week: the first reader names the week's lesson (`card#<week>`), so a second reader, or the same reader again, sees the same card or none; "Not now" keeps a lesson off for 60 days and uses the week's card.
import { type DocumentStore, type OrgId } from "@agentx/contracts";
import type { AccessCheckPort } from "./access-port.js";
import { createHash } from "node:crypto";
import { cleanForLearning, touchesRiskyPath } from "./guards.js";
import { graduationBlock, secondPersonStep, ruleParagraph, type PromoteDeps, type PromoteFailure } from "./promote.js";
import { recordBecame, type Became } from "./became.js";
import { DAY_MS, CARD_SNOOZE_MS, GraduationUnreadable, claimGraduation, closeCard, draftIdFor, releaseClaim, openCard, putCheckDraft, readCard, snooze, snoozedNow, weekOf, DRAFT_REQUEST_MAX } from "./graduation-store.js";
import { emitAudit, modeAllows, requireAudit, resolveLearning } from "./policy.js";
import { provenLesson, PROVEN, type ProvenReader } from "./proven.js";
import { readVisible } from "./read-visible.js";
import type { ScopeKey } from "./store.js";
import { countLessonUses } from "./use-count.js";
import { lessonValue } from "./value.js";
import { idIn, type IdentitySet, type Lesson } from "./types.js";
import { validGlob, pathsWithin, TEAM_RULE_PATHS_MAX } from "./team-rules.js";

export const GRADUATION_TARGETS = ["rule", "check", "skill"] as const;
export type GraduationTarget = (typeof GRADUATION_TARGETS)[number];

/** Where each kind of lesson may go (research doc Q2): a preference stays a lesson, a procedure may be a skill, a pitfall or a fact may become a check, and everything else but a procedure may be a rule. */
export function allowedTargets(type: Lesson["type"]): GraduationTarget[] {
  switch (type) {
    case "procedure": return ["skill", "rule"];
    case "pitfall": return ["check", "rule"];
    case "fact": case "review_check": return ["rule", "check"];
    case "convention": return ["rule", "check"];
    default: return [];
  }
}
/** The first allowed target: what the card suggests. */
export const recommendedTarget = (type: Lesson["type"]): GraduationTarget | undefined => allowedTargets(type)[0];

/** The skills library of L4-AK3 as graduation needs it: draft a skill from a lesson. Absent in a deployment that has no skills yet: the skill target is then refused. */
export interface SkillGraduation {
  draft(key: ScopeKey, input: { lessonId: string; by: string; name?: string | undefined }): Promise<{ ok: true; name: string; version: number } | { ok: false; code: string }>;
}

export interface GraduateDeps extends PromoteDeps {
  documents: DocumentStore;
  access: AccessCheckPort;
  /** The computed "proven" band. Absent: `provenLesson` (the same rule, until the shared band is merged). */
  proven?: ProvenReader | undefined;
  skills?: SkillGraduation | undefined;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const orgOf = (key: ScopeKey): OrgId => key.workspaceId;

export interface GraduationOffer {
  lessonId: string; version: number; title: string; description: string; type: Lesson["type"]; tier: Lesson["tier"];
  /** What the card suggests, and every place this kind of lesson may go. */
  target: GraduationTarget; targets: GraduationTarget[];
  /** The path globs the lesson applies to (a rule keeps them). */
  paths: string[];
  tasks: number; days: number;
  /** People it needs (2 for a tier-2 lesson, and a skill always), how many already asked, and whether this person did. */
  needs: { required: 1 | 2; have: number; you: boolean;
    /** What the first person chose (target and paths): the second person must choose the same. Present once someone has asked. */
    first?: { target: GraduationTarget; paths: string[] } };
}

const DAYS = (ms: number): number => Math.max(0, Math.floor(ms / DAY_MS));

function offerOf(lesson: Lesson, tasks: number, now: number, personId: string | undefined): GraduationOffer | undefined {
  const asked = lesson.promotionApprovals ?? [];
  const first = asked[0]?.ask?.target;
  const target = first !== undefined && allowedTargets(lesson.type).includes(first) ? first : recommendedTarget(lesson.type);
  if (target === undefined) return undefined;
  return {
    lessonId: lesson.id, version: lesson.version, title: lesson.title, description: lesson.description, type: lesson.type, tier: lesson.tier, target, targets: allowedTargets(lesson.type),
    paths: lesson.scope.paths ?? [], tasks, days: DAYS(now - lesson.createdAt),
    needs: { required: lesson.tier === 2 ? 2 : 1, have: asked.length, you: personId !== undefined && asked.some((a) => idIn([a.by], personId)), ...(asked[0]?.ask === undefined ? {} : { first: { target: asked[0].ask.target, paths: [...asked[0].ask.paths] } }) },
  };
}

/** How many active lessons are looked at when a card is chosen (the best by value first): a bound on the reads, not a judgement. */
export const CANDIDATES_LOOKED_AT = 25;

/**
 * The lessons that could be offered now, best first: live, person-approved, project-wide, proven, not snoozed, and visible to this person. Reads at most `CANDIDATES_LOOKED_AT` lessons' use rows. `viewer` is who is asking
 * (their developer id rides on it). A lesson whose uses could not be counted is not proven.
 */
export async function graduationCandidates(deps: GraduateDeps, key: ScopeKey, viewer: IdentitySet): Promise<GraduationOffer[]> {
  const now = deps.now();
  const snoozed = await snoozedNow(deps.documents, orgOf(key), key.project, now);
  const ranked = (await deps.store.list(key, { statuses: ["active"] }))
    .filter((lesson) => recommendedTarget(lesson.type) !== undefined && lesson.trial === undefined && lesson.approvals.length > 0 && lesson.became === undefined && lesson.promotedRuleId === undefined
      && lesson.provenance.audience.kind === "project" && now - lesson.createdAt >= PROVEN.days * DAY_MS && !snoozed.has(lesson.id))
    .sort((a, b) => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id))
    .slice(0, CANDIDATES_LOOKED_AT);
  if (ranked.length === 0) return [];
  const visible = await readVisible({ access: deps.access, key, viewer, lessons: ranked, where: "graduate", ...(deps.log === undefined ? {} : { log: deps.log }) });
  if (visible.length === 0) return [];
  const used = await countLessonUses(deps.documents, { companyId: orgOf(key), project: key.project, lessonIds: visible.map((lesson) => lesson.id), now });
  const proven = deps.proven ?? provenLesson;
  const offers: GraduationOffer[] = [];
  for (const lesson of visible) {
    const tasks = used.counts.get(lesson.id)?.tasks;
    if (tasks === undefined || !proven({ lesson, tasks, now })) continue;
    if (await graduationBlock(deps, key, lesson) !== undefined) continue;
    const offer = offerOf(lesson, tasks, now, viewer.developerId);
    if (offer !== undefined) offers.push(offer);
  }
  return offers;
}

/** Whether this person may decide lessons for the project now (read live; unreadable is a no). */
async function mayDecide(deps: GraduateDeps, key: ScopeKey, personId: string): Promise<boolean> {
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: personId }).catch(() => undefined);
  return group !== undefined && group.complete && idIn(group.eligibleIds, personId);
}

/**
 * This week's ONE "Make this permanent?" card for a person who decides, or undefined. The first reader of the week names the lesson (the best candidate); from then on everyone sees that card, until it is answered
 * ("done" or "not now"). A card whose lesson is no longer a candidate (retired, no longer proven, now narrower) is not replaced by another that week: one card a week. No candidate names nothing, so a lesson that
 * proves itself on Wednesday is still offered that week. Throws `GraduationUnreadable` when the rows cannot be read.
 */
export async function weeklyCard(deps: GraduateDeps, key: ScopeKey, viewer: IdentitySet): Promise<GraduationOffer | undefined> {
  const personId = viewer.developerId;
  if (personId === undefined || !(await mayDecide(deps, key, personId))) return undefined;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return undefined;
  const now = deps.now();
  const week = weekOf(now);
  let row = await readCard(deps.documents, orgOf(key), key.project, week);
  if (row !== undefined && row.state !== "open") return undefined;
  const offers = await graduationCandidates(deps, key, viewer);
  if (row === undefined) {
    const first = offers[0];
    if (first === undefined) return undefined;
    row = await openCard(deps.documents, orgOf(key), key.project, week, first.lessonId, now);
    if (row.state !== "open") return undefined;
  }
  const named = row.lessonId;
  return offers.find((offer) => offer.lessonId === named);
}

// ---- making it permanent

export type GraduateFailure = PromoteFailure | "paths_outside" | "wrong_target" | "not_proven" | "bad_paths" | "no_skills" | "skill_refused" | "check_unavailable" | "rule_refused" | "unreadable";
export type GraduateResult =
  | { ok: true; target: GraduationTarget; state: "done"; ref: string; already: boolean }
  | { ok: true; target: GraduationTarget; state: "waiting"; needs: "second_person" }
  | { ok: true; target: "skill"; state: "drafted"; ref: string; version: number }
  | { ok: false; code: GraduateFailure };

/** The request a person starts: what to add and why, in the lesson's own words, bounded. */
export function checkRequestText(lesson: Pick<Lesson, "title" | "description" | "body" | "scope">): { title: string; request: string } {
  const title = cleanForLearning(lesson.title, 80).replace(/\s+/gu, " ");
  const body = ruleParagraph(lesson);
  const where = (lesson.scope.paths ?? []).slice(0, 5);
  const request = `Add a check (a test or a lint rule) so this stays true: ${body}${where.length === 0 ? "" : ` It applies to ${where.join(", ")}.`}`;
  return { title: `Add a check for: ${title}`.slice(0, 200), request: request.slice(0, DRAFT_REQUEST_MAX) };
}

/**
 * Makes one lesson permanent. See the header for the rules. `paths` (rule only) narrows or sets where the rule applies; absent, it keeps the lesson's own. A repeat of a finished graduation answers the same result
 * (`already`). Nothing here starts a task.
 */
export async function graduateLesson(deps: GraduateDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string; target: GraduationTarget; paths?: readonly string[] | undefined; skillName?: string | undefined }): Promise<GraduateResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { ok: false, code: "mode_off" };
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.approverId }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (lesson.became !== undefined) return lesson.became.kind === input.target ? { ok: true, target: input.target, state: "done", ref: lesson.became.ref, already: true } : { ok: false, code: "already_approved" };
  if (lesson.status !== "active") return { ok: false, code: "not_active" };
  if (!allowedTargets(lesson.type).includes(input.target)) return { ok: false, code: "wrong_target" };
  // Nothing is recorded for a target this deployment cannot make (a first request of a tier-2 lesson would otherwise be kept for nothing).
  if (input.target === "skill" && deps.skills === undefined) return { ok: false, code: "no_skills" };
  const paths = input.paths === undefined ? undefined : [...new Set(input.paths)];
  if (paths !== undefined && (paths.length > TEAM_RULE_PATHS_MAX || !paths.every(validGlob))) return { ok: false, code: "bad_paths" };
  // A person may narrow where the rule applies, never move it: the paths lie inside the lesson's own (a lesson with none is the whole project, so any paths narrow it).
  if (paths !== undefined && !pathsWithin(paths, lesson.scope.paths)) return { ok: false, code: "paths_outside" };
  // The person must be able to read the lesson now (a lesson from a place they cannot see is not theirs to decide), then the project-wide checks every target shares.
  const identity = await deps.directory.identity(key.workspaceId, input.approverId).catch(() => undefined);
  if (identity === undefined) return { ok: false, code: "eligibility_unavailable" };
  let seen: Lesson[];
  try { seen = await readVisible({ access: deps.access, key, viewer: identity, lessons: [lesson], where: "graduate", ...(deps.log === undefined ? {} : { log: deps.log }) }); } catch { return { ok: false, code: "unreadable" }; }
  if (seen.length !== 1) return { ok: false, code: "not_found" };
  const blocked = await graduationBlock(deps, key, lesson);
  if (blocked !== undefined) return { ok: false, code: blocked };
  // Proven, counted now (never from a number the caller sent).
  const used = await countLessonUses(deps.documents, { companyId: orgOf(key), project: key.project, lessonIds: [lesson.id], now: deps.now() });
  const tasks = used.counts.get(lesson.id)?.tasks;
  if (!(deps.proven ?? provenLesson)({ lesson, tasks, now: deps.now() })) return { ok: false, code: "not_proven" };

  // Where it would apply decides how many people it needs: a place that touches what protects the project (tests, CI, secrets, deploys) is a tier-2 matter whatever the lesson's own tier, and the second person must ask for
  // the same target and the same place as the first.
  const finalPaths = [...(paths ?? lesson.scope.paths ?? [])].sort();
  const binding = createHash("sha256").update(`${input.target}\u0000${finalPaths.join("\u0001")}`).digest("hex").slice(0, 32);
  const second = await secondPersonStep(deps, key, lesson, group, input.approverId, binding, { target: input.target, paths: finalPaths }, touchesRiskyPath(finalPaths));
  if (second !== undefined) return second.ok ? { ok: true, target: input.target, state: "waiting", needs: "second_person" } : { ok: false, code: second.code };
  // One target per lesson: the first claim stands (two people choosing two targets never make both).
  if (await claimGraduation(deps.documents, orgOf(key), key.project, lesson.id, input.target, deps.now()).catch(() => "unreadable" as const) !== "claimed") return { ok: false, code: "already_approved" };
  const failed = async (code: GraduateFailure): Promise<GraduateResult> => {
    await emitAudit(deps.audit, { action: "lesson.promote_failed", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: {} });
    await releaseClaim(deps.documents, orgOf(key), key.project, lesson.id).catch(() => undefined);
    return { ok: false, code };
  };
  // Anything thrown from here on (the skills library, the store) leaves no claim behind to block another target; a retry of the same target is safe.
  try {
    // A skill is made by L4-AK3's library, which needs two people to approve every skill; the lesson becomes it when it goes live. Nothing is retired here. (A tier-2 lesson already needed two people above.)
    if (input.target === "skill") {
      if (!(await requireAudit(deps.audit, { action: "lesson.graduated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier: lesson.tier } }))) return failed("audit_unavailable");
      const made = await deps.skills!.draft(key, { lessonId: lesson.id, by: input.approverId, ...(input.skillName === undefined ? {} : { name: input.skillName }) });
      if (!made.ok) return failed("skill_refused");
      await closeWeekCard(deps, key, lesson.id, "done");
      return { ok: true, target: "skill", state: "drafted", ref: made.name, version: made.version };
    }

    // The ledger first: no record, no change.
    if (!(await requireAudit(deps.audit, { action: "lesson.graduated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier: lesson.tier } }))) return failed("audit_unavailable");

    let ref: string;
    if (input.target === "rule") {
      try {
        ref = (await deps.publisher.publish({ workspaceId: key.workspaceId, project: key.project, paragraph: ruleParagraph(lesson), lessonId: lesson.id, approverId: input.approverId, paths: paths ?? lesson.scope.paths ?? [], repos: lesson.scope.repos ?? [], stages: lesson.stages })).ruleId;
      } catch { return failed("rule_refused"); }
    } else {
      const text = checkRequestText(lesson);
      try {
        ref = (await putCheckDraft(deps.documents, orgOf(key), key.project, { id: draftIdFor(key.workspaceId, key.project, lesson.id), lessonId: lesson.id, title: text.title, request: text.request, paths: lesson.scope.paths ?? [], createdAt: deps.now() })).draft.id;
      } catch (error) { return failed(error instanceof GraduationUnreadable ? "check_unavailable" : "unreadable"); }
    }
    const linked = await recordBecame({ store: deps.store, now: deps.now, vectors: deps.vectors }, key, lesson.id, { kind: input.target, ref });
    if (!linked.ok) return { ok: false, code: linked.code === "not_found" ? "not_found" : "conflict" };
    await closeWeekCard(deps, key, lesson.id, "done");
    return { ok: true, target: input.target, state: "done", ref: linked.became.ref, already: linked.already };
  } catch (error) {
    await releaseClaim(deps.documents, orgOf(key), key.project, lesson.id).catch(() => undefined);
    throw error;
  }
}

/** "Not now": the lesson is not offered for 60 days, and the week's card is used. Only for a person who decides. */
export async function graduationLater(deps: GraduateDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string }): Promise<{ ok: true } | { ok: false; code: "not_eligible" | "eligibility_unavailable" | "not_found" | "unreadable" }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.approverId }).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined || lesson.status !== "active") return { ok: false, code: "not_found" };
  // Only a lesson this person may read, and only while learning is on for the project.
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { ok: false, code: "not_found" };
  try {
    const identity = await deps.directory.identity(key.workspaceId, input.approverId);
    if ((await readVisible({ access: deps.access, key, viewer: identity, lessons: [lesson], where: "graduate", ...(deps.log === undefined ? {} : { log: deps.log }) })).length !== 1) return { ok: false, code: "not_found" };
    await snooze(deps.documents, orgOf(key), key.project, lesson.id, deps.now() + CARD_SNOOZE_MS, deps.now());
    await closeWeekCard(deps, key, lesson.id, "later");
  } catch { return { ok: false, code: "unreadable" }; }
  return { ok: true };
}

/** Closes this week's card when it is the one for this lesson; any other lesson leaves the week's card as it is. A store that cannot be written is not allowed to undo what was done: it is logged. */
async function closeWeekCard(deps: GraduateDeps, key: ScopeKey, lessonId: string, state: "done" | "later"): Promise<void> {
  try { await closeCard(deps.documents, orgOf(key), key.project, weekOf(deps.now()), lessonId, state, deps.now()); } catch { deps.log?.("graduation.card_not_closed", {}); }
}

export type { Became };
