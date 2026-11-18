// "Promote to How we work rule". It turns one active lesson into exactly one paragraph and hands it to the same publish
// path the Accept button uses (`acceptSuggestion` through `publishDraft`), which keeps its own less-safe checks. A lesson from a restricted source is
// never promoted: a rule is read by everyone in the project.
import type { TaskVisibilityPort } from "./access-port.js";
import { cleanForLearning } from "./guards.js";
import { createLessonLiveReader } from "./live-visibility.js";
import { mentionsRepoPlace, repoOnlyScopes, viewedForLessons } from "./project-repo-audience.js";
import { trySecondPerson } from "./approve.js";
import { emitAudit, modeAllows, requireAudit, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ApproverDirectory, LessonDeps, LessonVectors, RulePublisher } from "./ports.js";
import { recordBecame } from "./became.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { idIn, isRestricted, sameId, trustAtLeast, type Lesson } from "./types.js";

export interface PromoteDeps extends LessonDeps {
  /** Where the retired lesson's vector is dropped. */
  vectors?: LessonVectors;
  store: LessonStore; directory: ApproverDirectory; settings: LearningSettingsReader; publisher: RulePublisher;
  /**
   * The live Plan 5 visibility of tasks. A rule is a COPY of the text that every stage reads, so a lesson learned from a task that is not project-wide is never promoted (narrowing the task later could
   * not recall the rule). Absent: a lesson that names any task is refused (fail closed).
   */
  taskVisibility?: TaskVisibilityPort | undefined;
}
export type PromoteFailure = "not_found" | "not_active" | "restricted" | "task_not_shared" | "not_trusted" | "not_eligible" | "eligibility_unavailable" | "mode_off" | "publish_failed" | "conflict"
  | "already_approved" | "audit_unavailable" | "second_person_required" | "sole_owner_cool_off" | "request_differs";

/** One paragraph: the title as a sentence, then the body, on one line. No headings, lists or line breaks, so the rule is one paragraph (rule I6). */
export function ruleParagraph(lesson: Pick<Lesson, "title" | "body">): string {
  const title = cleanForLearning(lesson.title, 80).replace(/\s+/gu, " ").replace(/[.!?]+$/u, "");
  const body = cleanForLearning(lesson.body, 600).replace(/\s+/gu, " ").replace(/^[#>*\-+\d.)\s]+/u, "");
  return `${title}. ${body}`.trim();
}


/**
 * Whether a lesson may be made permanent at all, by whatever target (a rule, a draft check task or a skill): a rule, a task and a skill are read by everyone in the project, so the lesson must be project-wide NOW.
 * Returns the refusal, or undefined when nothing stands in the way.
 */
export async function graduationBlock(deps: Pick<PromoteDeps, "taskVisibility">, key: ScopeKey, lesson: Lesson): Promise<PromoteFailure | undefined> {
  // A restriction that is only the readers of the project's own repositories counts as project-wide (read live; unreadable leaves it restricted).
  const reader = createLessonLiveReader({ port: deps.taskVisibility, key, where: "promote" });
  if (isRestricted(viewedForLessons(lesson, mentionsRepoPlace(lesson) ? await reader.projectRepos() : undefined))) return "restricted";
  // A project rule is read in EVERY repository of the project, but a lesson restricted only to one repository is named and published only there. Rules are per project, not per repository, so such a lesson is
  // refused here (the conservative choice); it keeps loading as a lesson, and a person can write the rule themselves.
  if (repoOnlyScopes(lesson) !== undefined) return "restricted";
  // Every task it was learned from must be project-wide NOW (a reader of "nobody in particular" keeps it only then).
  if ((await reader.keep(undefined, [lesson])).length !== 1) return "task_not_shared";
  if (!trustAtLeast(lesson.provenance.minTrust, "rovara")) return "not_trusted";
  return undefined;
}

/**
 * A tier-2 lesson (tests, checks, reviews, security) needs two people to be made permanent, whatever the target (the same second-person rule as approving it). The first request is recorded and waits; the second person's
 * finishes it. Undefined: nothing more is needed (a tier-0 or tier-1 lesson, or the second person has now asked). The sole eligible owner may finish alone through the audited exception.
 */
export async function secondPersonStep(deps: Pick<PromoteDeps, "store" | "now">, key: ScopeKey, lesson: Lesson, group: Awaited<ReturnType<ApproverDirectory["eligibility"]>>, approverId: string,
  /** What this request is for (the target and where it applies, as a digest). When given, the second person must ask for the SAME thing the first did: one person cannot choose a target or a place the other did not. Absent (the older rule promotion): not compared. */
  binding?: string, ask?: { target: "rule" | "check" | "skill"; paths: string[] }, /** Treat the lesson as tier 2 whatever it says (the place it would apply touches what protects the project). */ forceTwo?: boolean):
  Promise<{ ok: true; pending: true; needs: "second_person" } | { ok: false; code: PromoteFailure } | undefined> {
  if (lesson.tier !== 2 && forceTwo !== true) return undefined;
  const asked = lesson.promotionApprovals ?? [];
  if (asked.some((a) => sameId(a.by, approverId))) {
    // The first person may change THEIR OWN request (another target or other paths) while no second person has asked: it replaces theirs, so a disagreement is never a dead end.
    if (binding === undefined || asked.length !== 1 || asked[0]!.binding === binding) return { ok: false, code: "already_approved" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = await deps.store.get(key, lesson.id);
      if (fresh === undefined) return { ok: false, code: "not_found" };
      const setVersion = await deps.store.setVersion(key);
      const result = await deps.store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), promotionApprovals: [{ by: approverId, at: deps.now(), binding, ...(ask === undefined ? {} : { ask }) }], updatedAt: deps.now() }], deps.now());
      if (result.ok) return { ok: true, pending: true, needs: "second_person" };
    }
    return { ok: false, code: "conflict" };
  }
  if (asked.length > 0) {
    if (binding !== undefined && asked[0]!.binding !== binding) return { ok: false, code: "request_differs" };
    // A second person: the same rule as approving the lesson.
    const decision = trySecondPerson(group, asked[0]!.by, approverId, deps.now());
    if (!decision.ok) return { ok: false, code: decision.code === "sole_owner_cool_off" ? "sole_owner_cool_off" : "second_person_required" };
    return undefined;
  }
  // The first request. The sole eligible owner may finish alone through the audited exception; everyone else waits for a second person.
  const alone = trySecondPerson(group, approverId, approverId, deps.now());
  if (!alone.ok && alone.code === "sole_owner_cool_off") return { ok: false, code: "sole_owner_cool_off" };
  if (alone.ok) return undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined) return { ok: false, code: "not_found" };
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), promotionApprovals: [...(fresh.promotionApprovals ?? []), { by: approverId, at: deps.now(), ...(binding === undefined ? {} : { binding }), ...(ask === undefined ? {} : { ask }) }], updatedAt: deps.now() }], deps.now());
    if (result.ok) return { ok: true, pending: true, needs: "second_person" };
  }
  return { ok: false, code: "conflict" };
}

export type PromoteResult =
  | { ok: true; ruleId: string; already: boolean }
  | { ok: true; pending: true; needs: "second_person" }
  | { ok: false; code: PromoteFailure };

/**
 * Promotes an active lesson. A How we work rule reaches every stage, reviewers included, so a tier-2 lesson (anything about tests, checks, reviews or
 * security) needs two people to promote, through the same second-person rule as approving it; the first request waits. The audit record is written before the
 * rule is published, and a failed write stops the promotion. The `RulePublisher` is the accept path and must run its own check-word and less-safe rules.
 */
export async function promoteToRule(deps: PromoteDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string }): Promise<PromoteResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { ok: false, code: "mode_off" };
  const group = await deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined);
  if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
  if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  if (lesson.promotedRuleId !== undefined) return { ok: true, ruleId: lesson.promotedRuleId, already: true };
  if (lesson.status !== "active") return { ok: false, code: "not_active" };
  const blocked = await graduationBlock(deps, key, lesson);
  if (blocked !== undefined) return { ok: false, code: blocked };

  const second = await secondPersonStep(deps, key, lesson, group, input.approverId);
  if (second !== undefined) return second;

  if (!(await requireAudit(deps.audit, { action: "lesson.promoted", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier: lesson.tier } }))) return { ok: false, code: "audit_unavailable" };
  let published: { ruleId: string };
  try {
    published = await deps.publisher.publish({ workspaceId: key.workspaceId, project: key.project, paragraph: ruleParagraph(lesson), lessonId: lesson.id, approverId: input.approverId, paths: lesson.scope.paths ?? [], repos: lesson.scope.repos ?? [], stages: lesson.stages });
  } catch {
    await emitAudit(deps.audit, { action: "lesson.promote_failed", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: {} });
    return { ok: false, code: "publish_failed" };
  }
  // The lesson becomes the rule: retired (so it is not handed out as a lesson again) and linked to it, with its history kept.
  const linked = await recordBecame({ store: deps.store, now: deps.now, vectors: deps.vectors }, key, lesson.id, { kind: "rule", ref: published.ruleId });
  if (!linked.ok) return { ok: false, code: linked.code === "not_found" ? "not_found" : "conflict" };
  return linked.already ? { ok: true, ruleId: linked.became.ref, already: true } : { ok: true, ruleId: published.ruleId, already: false };
}
