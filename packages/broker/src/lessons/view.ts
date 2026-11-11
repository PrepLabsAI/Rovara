// What the Lessons tab, the Sources tab and the task page's lessons list read (design 1.2). Everything a viewer is told goes through `readVisible` (the frozen
// snapshot AND the access records now), so a lesson from a source the viewer cannot see is counted for a person who decides and otherwise not mentioned. People are named the way the
// rest of Rovara names them (`attributionNameOf`; an erased or unreadable person is "a former member"). Nothing here writes: the writes are in routes.ts, through the lesson library.
import { agentXError, type LessonPerson, type LessonsPauseCode, type LessonView, type LessonsViewAnswer, type OrgId } from "@agentx/contracts";
import { attributionNameOf, type AttributionReader } from "./people.js";
import type { AccessCheckPort } from "./access-port.js";
import { approversRequired, resolveLearning, stricterMode, LearningModeSchema, type LearningSettingsReader } from "./policy.js";
import { buildWeeklyDigest } from "./digest.js";
import { lessonPanelRows } from "./panel.js";
import { createLessonLiveReader, LESSON_LIVE_TIMEOUT_MS } from "./live-visibility.js";
import { readVisible, readVisibleRanked, type LessonLog } from "./read-visible.js";
import type { ApproverDirectory } from "./ports.js";
import type { LessonsPauseStore } from "./pause.js";
import type { LessonStore, ScopeKey } from "./store.js";
import { ERASED_MARK, idIn, normId, normSource, sameId, type IdentitySet, type Lesson } from "./types.js";
import { lessonValue } from "./value.js";

export interface LessonViewDeps {
  store: LessonStore; directory: ApproverDirectory; settings: LearningSettingsReader; access: AccessCheckPort;
  /** Names of the people a lesson mentions. */
  names: AttributionReader;
  now: () => number;
  log?: LessonLog;
  /** Why learning cannot run for the project right now (lessons in production). Absent: the tab says nothing about it. */
  pause?: LessonsPauseStore;
  /** Whether a recorded reason still holds (true), or its cause is gone (false: a provider was connected, the budget was raised). A reason whose cause is gone is cleared when it is read. Absent: every reason is shown until a learning call succeeds. */
  pauseStillApplies?: (workspaceId: string, project: string, code: LessonsPauseCode) => Promise<boolean>;
}
export interface LessonCaller { orgId: OrgId; developerId: string }

export const WAITING_MAX = 100;
export const ACTIVE_MAX = 200;
export const REMOVED_MAX = 50;
export const SNAPSHOTS_MAX = 20;
const FORMER = "a former member";
const NAME_BATCH = 10;
const NAMES_MAX = 300;

const keyOf = (caller: LessonCaller, project: string): ScopeKey => ({ workspaceId: caller.orgId, project });

/** Who may decide lessons here: the project's maintainers, How-we-work editors and company admins, as the directory says. An incomplete answer is nobody. */
async function deciderState(deps: LessonViewDeps, key: ScopeKey, caller: LessonCaller): Promise<{ canDecide: boolean; eligibleCount: number; eligible: readonly string[]; viewer: IdentitySet }> {
  const [group, viewer] = await Promise.all([
    deps.directory.eligibility(key.workspaceId, key.project).catch(() => undefined),
    deps.directory.identity(key.workspaceId, caller.developerId),
  ]);
  const canDecide = group !== undefined && group.complete && idIn(group.eligibleIds, caller.developerId);
  return { canDecide, eligibleCount: group?.eligibleIds.length ?? 0, eligible: group?.complete === true ? group.eligibleIds : [], viewer };
}

/** Display names for the people a set of lessons names. A person who was erased, or whose record cannot be read, is "a former member"; the signed-in person is marked. */
async function namePeople(deps: LessonViewDeps, orgId: OrgId, me: string, ids: readonly string[]): Promise<(id: string) => LessonPerson> {
  const unique = new Map<string, string>();
  for (const id of ids) if (id !== ERASED_MARK && !id.startsWith("system:") && !unique.has(normId(id))) unique.set(normId(id), id);
  const wanted = [...unique.values()].slice(0, NAMES_MAX);
  const found = new Map<string, string>();
  for (let at = 0; at < wanted.length; at += NAME_BATCH) {
    await Promise.all(wanted.slice(at, at + NAME_BATCH).map(async (id) => {
      try {
        if (await deps.names.isErased(orgId, id)) return;
        const name = await deps.names.memberName(orgId, id);
        if (name !== undefined) found.set(normId(id), attributionNameOf(name));
      } catch { /* in doubt, the person is not named */ }
    }));
  }
  return (id) => {
    // A lesson written in the repository file is approved by the repository edit, not by a person (read-back): shown as that.
    if (id === REPOSITORY_APPROVER) return { name: "repository edit" };
    const name = found.get(normId(id));
    return name === undefined ? { name: FORMER } : { name, ...(sameId(id, me) ? { you: true as const } : {}) };
  };
}

/** The `by` of the approval read-back gives (`repo-file-readback.ts`). */
const REPOSITORY_APPROVER = "system:repository-edit";
const personIdsOf = (lesson: Lesson): string[] => [...lesson.provenance.authors, ...lesson.approvals.map((a) => a.by)];

/** What a pending lesson still needs: the people the policy asks for, who approved first, and the groups not yet represented. */
function needsOf(lesson: Lesson, required: 0 | 1 | 2, groups: readonly string[], eligible: readonly string[], person: (id: string) => LessonPerson): LessonView["needs"] {
  // Only approvals from people who can still approve count: a first approver who left no longer stands (the next approval drops it).
  const people = lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial" && idIn(eligible, a.by));
  const distinct = new Set(people.map((a) => normId(a.by)));
  const total = Math.max(required, lesson.reviewRequired === true ? 1 : 0, 1) as 1 | 2;
  const first = people[0];
  return {
    required: total, have: Math.min(5, distinct.size), groups: [...groups],
    ...(first === undefined ? {} : { first: person(first.by), firstAt: first.at }),
  };
}

interface Context { canDecide: boolean; eligibleCount: number; eligible: readonly string[]; me: string; required: (lesson: Lesson) => 0 | 1 | 2; groups: readonly string[]; person: (id: string) => LessonPerson }

/** The people a lesson comes from, each once; everyone who cannot be named is one "a former member", so the count of erased people is not shown. */
function fromPeople(ids: readonly string[], person: (id: string) => LessonPerson): LessonPerson[] {
  const named = new Map<string, LessonPerson>();
  let former = false;
  for (const id of ids) {
    if (id === ERASED_MARK) { former = true; continue; }
    const p = person(id);
    if (p.name === FORMER) former = true; else named.set(normId(id), p);
  }
  return [...named.values(), ...(former ? [{ name: FORMER }] : [])];
}

function toView(lesson: Lesson, ctx: Context): LessonView {
  const checks = lesson.citationChecks ?? [];
  const citations: LessonView["citations"] = lesson.citations.map((citation, index): LessonView["citations"][number] => {
    if (citation.kind === "code") {
      const check = checks.find((c) => c.index === index);
      return { kind: "code", repo: citation.repo, path: citation.path, startLine: citation.startLine, endLine: citation.endLine, check: check?.result ?? "unchecked", ...(check === undefined ? {} : { checkedAt: check.at }) };
    }
    if (citation.kind === "pr") return { kind: "pr", url: citation.url };
    if (citation.kind === "task") return { kind: "task", taskId: citation.taskId };
    // A record citation is a row id inside the Team record: it carries no link a person could follow, and the id is not shown.
    return { kind: "record" };
  });
  const pending = lesson.status === "pending";
  const approvedByMe = lesson.approvals.some((a) => sameId(a.by, ctx.me));
  const isAuthor = idIn(lesson.provenance.authors, ctx.me);
  // The library decides at the click; this only hides a button the person could not use (they approved already, or they helped write it and someone else could decide).
  const canApprove = ctx.canDecide && pending && !approvedByMe && !(isAuthor && ctx.eligibleCount > 1);
  const last = lesson.lastHelpfulAt;
  return {
    id: lesson.id, version: lesson.version, type: lesson.type, stages: [...lesson.stages], title: lesson.title, description: lesson.description, body: lesson.body,
    scope: { repos: [...(lesson.scope.repos ?? [])], paths: [...(lesson.scope.paths ?? [])], languages: [...(lesson.scope.languages ?? [])] },
    tier: lesson.tier, tierReasons: [...lesson.tierReasons], status: lesson.status,
    counters: { loaded: lesson.counters.loaded, helpful: lesson.counters.helpful, harmful: lesson.counters.harmful },
    createdAt: lesson.createdAt, updatedAt: lesson.updatedAt, expiresAt: lesson.expiresAt, ...(last === undefined ? {} : { lastUsedAt: last }),
    citations,
    from: fromPeople(lesson.provenance.authors, ctx.person),
    measured: lesson.provenance.measured, supportTasks: new Set(lesson.provenance.supportTasks).size,
    ...(pending ? { needs: needsOf(lesson, ctx.required(lesson), ctx.groups, ctx.eligible, ctx.person) } : {}),
    // Who approved is for people who decide; a reader sees the lesson, not its approvers.
    approvals: ctx.canDecide ? lesson.approvals.map((a) => ({ by: ctx.person(a.by), at: a.at, mode: a.mode })) : [],
    ...(lesson.trial === undefined ? {} : { trial: lesson.trial.state }),
    ...(lesson.reviewRequired === true ? { reviewRequired: true as const } : {}), ...(lesson.contradictsWith === undefined ? {} : { contradicts: lesson.contradictsWith }), ...(lesson.possibleDuplicateOf === undefined ? {} : { possibleDuplicate: lesson.possibleDuplicateOf }), ...(lesson.possibleDuplicateOf !== undefined && lesson.tierReasons.includes("repo_twin") ? { mergeBlocked: true as const } : {}),
    ...(lesson.retireProposedAt === undefined ? {} : { retireProposed: true as const }), ...(lesson.supersedes === undefined ? {} : { supersedes: lesson.supersedes }),
    ...(lesson.status === "rejected" && lesson.rejectedReason !== undefined ? { rejectedReason: lesson.rejectedReason } : {}),
    canApprove, canReject: ctx.canDecide && pending, canRetire: ctx.canDecide && (lesson.status === "active" || lesson.status === "stale" || pending),
  };
}

/** The company's preset is the reason the project is Regulated: it is Regulated and the project's own choice is not. */
const companyPresetLocks = (raw: { preset?: unknown; companyPreset?: unknown }): boolean => raw.companyPreset === "regulated" && raw.preset !== "regulated";

/** The whole Lessons tab stops reading task visibility after this long (API Gateway answers a 504 at 29 s; the rest of the tab needs a few seconds). */
export const TAB_DEADLINE_MS = 20_000;

/** How many candidate lessons this viewer may read now, checked a page at a time (one reader, the tab's deadline). Lessons not checked in time are not counted. */
async function queuedCount(deps: LessonViewDeps, key: ScopeKey, viewer: IdentitySet | undefined, deadlineAt: number, legacy: Set<string>): Promise<number> {
  const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "view", log: deps.log, timeoutMs: () => Math.max(1, Math.min(LESSON_LIVE_TIMEOUT_MS, deadlineAt - Date.now())) });
  const ranked = await deps.store.list(key, { statuses: ["candidate"] });
  const kept = (await readVisibleRanked({ access: deps.access, key, viewer, where: "view", log: deps.log, live, ranked, pageSize: 50, enough: () => false, deadlineAt })).kept.length;
  for (const id of live.legacyWithheld()) legacy.add(id);
  return kept;
}

/**
 * The Lessons tab. `surface: "home"` is Home's card: it needs only the lessons waiting for this person, so only those are read and checked (the other lists come back empty). Either way each status is
 * read on its own, the lists are ranked BEFORE the visibility check and checked a page at a time until one more than the list's cap survives, and one reader serves the whole request (no task is read twice).
 */
export async function buildLessonsView(deps: LessonViewDeps, caller: LessonCaller, project: string, options: { surface?: "tab" | "home"; /** Tests: the whole tab's deadline (default `TAB_DEADLINE_MS`). */ deadlineMs?: number } = {}): Promise<LessonsViewAnswer> {
  const key = keyOf(caller, project);
  const [resolved, raw, state] = await Promise.all([
    resolveLearning(deps.settings, key.workspaceId, key.project),
    deps.settings.read(key.workspaceId, key.project).catch(() => ({})),
    deciderState(deps, key, caller),
  ]);
  const own = LearningModeSchema.safeParse((raw as { mode?: unknown }).mode ?? "On");
  const lock = LearningModeSchema.safeParse((raw as { companyLock?: unknown }).companyLock);
  // The lock is "the reason" only when it made the mode stricter than the project's own choice.
  const lockedByCompany = lock.success && own.success && stricterMode(own.data, lock.data) !== own.data;

  // Why learning is paused is for the people who decide here (the same rule as Home): it names the company's budget state, which a reader has no use for. A reason whose cause has gone is cleared, not shown.
  let paused = resolved.mode === "Off" || resolved.switchedOff || !state.canDecide ? undefined : await deps.pause?.read(key.workspaceId, key.project).catch(() => undefined);
  if (paused !== undefined && deps.pauseStillApplies !== undefined && !(await deps.pauseStillApplies(key.workspaceId, key.project, paused.code).catch(() => true))) {
    // Only the reason that was shown: one a learning call recorded since is not deleted.
    await deps.pause?.clear(key.workspaceId, key.project, paused.scope, paused.code).catch(() => undefined);
    paused = undefined;
  }
  const home = options.surface === "home";
  // Each list has its OWN reader (so the active list's tasks can't use up the bound the waiting list needs) and the whole tab has one deadline, under API Gateway's 29 s: each task read gets only the time that
  // is left, and a list not finished by then shows what was checked (and says it was cut). Anything not checked is not shown.
  const deadlineAt = Date.now() + (options.deadlineMs ?? TAB_DEADLINE_MS);
  const byValue = (a: Lesson, b: Lesson): number => lessonValue(b) - lessonValue(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const byUpdated = (a: Lesson, b: Lesson): number => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  let checked = 0, kept = 0;
  // The lessons (of the waiting, active and queued lists that were looked at) withheld because they were learned from a legacy task with no session item.
  const legacyHeld = new Set<string>();
  // Of those, the ones inside the lists' `checked` count: they are counted as held, so they are not also "left out". The queued count reads lessons apart from `checked`.
  const legacyChecked = new Set<string>();
  const cut = new Set<"waiting" | "active" | "removed">();
  /** The first `max + 1` lessons (in `order`) this viewer may read now: one more than the list shows tells whether it was cut. */
  const top = async (list: "waiting" | "active" | "removed", statuses: Lesson["status"][], order: (a: Lesson, b: Lesson) => number, max: number): Promise<Lesson[]> => {
    const ranked = (await deps.store.list(key, { statuses })).sort(order);
    const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "view", log: deps.log, timeoutMs: () => Math.max(1, Math.min(LESSON_LIVE_TIMEOUT_MS, deadlineAt - Date.now())) });
    const result = await readVisibleRanked({ access: deps.access, key, viewer: state.viewer, where: "view", log: deps.log, live, ranked, pageSize: max + 1, enough: (found) => found.length > max, deadlineAt });
    checked += result.checked; kept += result.kept.length;
    if (list !== "removed") for (const id of live.legacyWithheld()) { legacyHeld.add(id); legacyChecked.add(id); }
    if (!result.complete) cut.add(list);
    return result.kept;
  };
  // People who do not decide read the active lessons only: the approval queue, who approved and what waits are for the people who can act on them. What waits for a decision is read first.
  const waitingAll = state.canDecide ? await top("waiting", ["pending"], byValue, WAITING_MAX) : [];
  const activeAll = home ? [] : await top("active", ["active", "stale"], byValue, ACTIVE_MAX);
  const queued = state.canDecide && !home ? await queuedCount(deps, key, state.viewer, deadlineAt, legacyHeld) : 0;
  const removedAll = state.canDecide && !home ? await top("removed", ["retired", "expired", "rejected"], byUpdated, REMOVED_MAX) : [];
  const waiting = waitingAll.slice(0, WAITING_MAX), active = activeAll.slice(0, ACTIVE_MAX), removed = removedAll.slice(0, REMOVED_MAX);
  const person = await namePeople(deps, caller.orgId, caller.developerId, [...waiting, ...active, ...removed].flatMap(personIdsOf));
  const ctx: Context = { canDecide: state.canDecide, eligibleCount: state.eligibleCount, eligible: state.eligible, me: caller.developerId, required: (lesson) => approversRequired(lesson.tier, resolved.approval), groups: resolved.requiredGroups, person };

  const setVersion = await deps.store.setVersion(key);
  const snapshots = state.canDecide && !home ? (await deps.store.snapshots(key)).filter((s) => s.setVersion !== setVersion).slice(-SNAPSHOTS_MAX).map((s) => ({ setVersion: s.setVersion, at: s.at, lessons: s.members.length })) : [];
  const truncated: Array<"waiting" | "active" | "removed"> = [];
  if (waitingAll.length > WAITING_MAX || cut.has("waiting")) truncated.push("waiting");
  if (activeAll.length > ACTIVE_MAX || cut.has("active")) truncated.push("active");
  if (removedAll.length > REMOVED_MAX || cut.has("removed")) truncated.push("removed");
  return {
    // `mode` is the project's own setting (after the company's lock); while the install's lessons switch is off the pipeline runs as Collect whatever it says, which `lessonsSwitchedOff` tells the people who decide.
    project, mode: resolved.chosenMode, lockedByCompany, ...(resolved.switchedOff && state.canDecide ? { lessonsSwitchedOff: true as const } : {}), preset: resolved.preset, presetLockedByCompany: companyPresetLocks(raw),
    approval: { tier0: resolved.approval.tier0, tier1: resolved.approval.tier1, requiredGroups: [...resolved.requiredGroups] },
    ...(resolved.expiryDays === undefined ? {} : { expiryDays: resolved.expiryDays }),
    canDecide: state.canDecide,
    waiting: waiting.map((l) => toView(l, ctx)), active: active.map((l) => toView(l, ctx)), removed: removed.map((l) => toView(l, ctx)),
    queued,
    // Lessons the person could not see among those the lists checked (the lists check only as many as they show, so this is a count of what was looked at, not of the whole project).
    hidden: state.canDecide ? Math.max(0, checked - kept - legacyChecked.size) : 0,
    // For people who decide: how many lessons wait because the task they were learned from has no session item (started before sessions). They stay out until that changes; the count says they are not lost.
    ...(state.canDecide && legacyHeld.size > 0 ? { legacyHeld: legacyHeld.size } : {}),
    truncated, setVersion, snapshots,
    ...(paused === undefined ? {} : { paused: { code: paused.code, at: paused.at, scope: paused.scope } }),
  };
}

/** One lesson's versions: who approved each. Only for a person who decides, and only for a lesson they may see. */
export async function buildLessonHistory(deps: LessonViewDeps, caller: LessonCaller, project: string, lessonId: string) {
  const key = keyOf(caller, project);
  const state = await deciderState(deps, key, caller);
  if (!state.canDecide) throw agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can see a lesson's history.");
  const head = await deps.store.getHead(key, lessonId);
  if (head === undefined || (await readVisible({ access: deps.access, key, viewer: state.viewer, lessons: [head], where: "view", log: deps.log })).length !== 1) throw agentXError("NOT_FOUND", "This lesson isn't available.");
  const versions = (await readVisible({ access: deps.access, key, viewer: state.viewer, lessons: await deps.store.versions(key, lessonId), where: "view", log: deps.log })).sort((a, b) => b.version - a.version).slice(0, 50);
  const person = await namePeople(deps, caller.orgId, caller.developerId, versions.flatMap((v) => v.approvals.map((a) => a.by)));
  return { versions: versions.map((v) => ({ version: v.version, at: v.updatedAt, status: v.status, title: v.title, body: v.body, approvedBy: v.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => person(a.by)) })) };
}

/** The weekly digest, led by the top lessons. For people who decide. */
export async function buildLessonsDigest(deps: LessonViewDeps, caller: LessonCaller, project: string) {
  const key = keyOf(caller, project);
  const state = await deciderState(deps, key, caller);
  if (!state.canDecide) throw agentXError("FORBIDDEN", "Only a maintainer of this project, or an admin, can read the weekly digest.");
  const digest = await buildWeeklyDigest(deps.store, key, deps.now(), state.viewer, deps.access, deps.log);
  const item = (i: { id: string; title: string; type: Lesson["type"]; tier: Lesson["tier"]; links: string[] }) => ({ id: i.id, title: i.title, type: i.type, tier: i.tier, links: i.links.slice(0, 10) });
  return {
    since: digest.since, top: digest.top.map(item), needsReview: digest.needsReview.map(item), autoApplied: digest.autoApplied.map(item), waiting: digest.waiting.slice(0, 100).map(item),
    retired: digest.retired.slice(0, 100).map(item), staleOrRetireProposed: digest.staleOrRetireProposed.slice(0, 100).map(item),
    queued: digest.queuedCount, pausedSources: digest.pausedSources.slice(0, 50), pausedSourcesHidden: digest.pausedSourcesHidden, hidden: digest.restrictedHidden,
  };
}

/** Does a pause key (`slack:C9`, `github:acme/api`) belong to a source row? Either the whole scope, or the source's name and the last part of its scope. */
export function pauseMatches(pauseKey: string, source: string, scope: string): boolean {
  const key = normSource(pauseKey).toLowerCase();
  return key === scope.toLowerCase() || key === `${source}:${scope.split("/").pop() ?? ""}`.toLowerCase();
}

/** The lessons a task loaded, as this viewer may see them. */
export async function buildLoadedLessons(deps: LessonViewDeps, caller: LessonCaller, project: string, taskId: string) {
  const key = keyOf(caller, project);
  const viewer = await deps.directory.identity(key.workspaceId, caller.developerId);
  const rows = await lessonPanelRows(deps.store, key, taskId, viewer, deps.access, deps.log);
  return { lessons: rows.slice(0, 500).map((r) => ({ stage: r.stage, round: r.round, lessonId: r.lessonId, version: r.version, why: r.why, citation: r.citation, visible: r.visible, ...(r.title === undefined ? {} : { title: r.title }), ...(r.type === undefined ? {} : { type: r.type }), ...(r.helpful === undefined ? {} : { helpful: r.helpful }), ...(r.harmful === undefined ? {} : { harmful: r.harmful }), canMark: r.canMark, ...(r.trial === undefined ? {} : { trial: r.trial }) })) };
}
