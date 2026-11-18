// The third answer to a conflict (lessons phase 4): "both are right, in different places". Two lessons advise opposite things (a waiting card that `contradictsWith` a live lesson). The first two answers keep one of them. This
// one keeps both and gives each its own place: the person sets a path on each, the contradiction is cleared, and the waiting card then goes through the normal approval (its tier, its second person if it needs one).
//   - an eligible person who could read BOTH lessons now (`mayHandle`); the card must be waiting and name the other lesson, which must still be live;
//   - every path is a plain relative glob (`validGlob`), each lesson gets at least one, and the two sets must differ (the same place for both settles nothing);
//   - the older, already approved lesson may only be NARROWED: with paths of its own, each new path must lie inside one it has; with none (the whole project), any paths narrow it. It is never widened by this;
//   - the waiting card's approvals start again (its words did not change but its place did: a person approves the place they read); the older lesson keeps its approvals (it only got narrower);
//   - ONE commit writes both (a lost race changes neither), after the ledger (no record, no change), recorded as an edit of each.
// The card is NOT approved here: the person approves it next as usual. Until then the older lesson already applies only to its new place; the answer says so.
import { approveLesson, mayHandle, type ApprovalFailure, type ApproveDeps } from "./approve.js";
import { modeAllows, requireAudit, resolveLearning } from "./policy.js";
import { touchesRiskyPath } from "./guards.js";
import { pathsWithin, validGlob, TEAM_RULE_PATHS_MAX } from "./team-rules.js";
import { nextVersion, type ScopeKey } from "./store.js";
import { idIn, type Lesson } from "./types.js";

export type SettleFailure = "mode_off" | "not_eligible" | "eligibility_unavailable" | "not_found" | "not_pending" | "not_a_conflict" | "other_not_live" | "not_permitted" | "conflict" | "bad_paths" | "same_place" | "wider_than_before" | "audit_unavailable";

export type SettleResult = { ok: true; cardVersion: number; otherId: string; otherPaths: string[]; cardPaths: string[] } | { ok: false; code: SettleFailure };

export async function settleBothPlaces(deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string; expectedVersion: number; cardPaths: readonly string[]; otherPaths: readonly string[] }): Promise<SettleResult> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.chosenMode, "load")) return { ok: false, code: "mode_off" };
  const cardPaths = [...new Set(input.cardPaths)], otherPaths = [...new Set(input.otherPaths)];
  if (cardPaths.length === 0 || otherPaths.length === 0 || cardPaths.length > TEAM_RULE_PATHS_MAX || otherPaths.length > TEAM_RULE_PATHS_MAX || ![...cardPaths, ...otherPaths].every(validGlob)) return { ok: false, code: "bad_paths" };
  if (cardPaths.length === otherPaths.length && cardPaths.every((path) => otherPaths.includes(path))) return { ok: false, code: "same_place" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const group = await deps.directory.eligibility(key.workspaceId, key.project, { approverId: input.approverId }).catch(() => undefined);
    if (group === undefined || !group.complete) return { ok: false, code: "eligibility_unavailable" };
    if (!idIn(group.eligibleIds, input.approverId)) return { ok: false, code: "not_eligible" };
    const setVersion = await deps.store.setVersion(key);
    const card = await deps.store.get(key, input.lessonId);
    if (card === undefined) return { ok: false, code: "not_found" };
    if (card.status !== "pending") return { ok: false, code: "not_pending" };
    if (card.contradictsWith === undefined) return { ok: false, code: "not_a_conflict" };
    if (card.version !== input.expectedVersion) return { ok: false, code: "conflict" };
    const other = await deps.store.get(key, card.contradictsWith);
    if (other === undefined || other.status !== "active") return { ok: false, code: "other_not_live" };
    if (!(await mayHandle(deps, key, card, input.approverId)) || !(await mayHandle(deps, key, other, input.approverId))) return { ok: false, code: "not_permitted" };
    // Neither lesson is moved: each only gets narrower than it was (a lesson with paths of its own keeps inside them; one with none is the whole project).
    if (!pathsWithin(otherPaths, other.scope.paths) || !pathsWithin(cardPaths, card.scope.paths)) return { ok: false, code: "wider_than_before" };
    const now = deps.now();
    for (const lesson of [card, other]) {
      if (!(await requireAudit(deps.audit, { action: "lesson.updated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor: input.approverId, facts: { tier: lesson.tier, fromTier: lesson.tier } }))) return { ok: false, code: "audit_unavailable" };
    }
    const cardRest: Lesson = { ...card };
    delete cardRest.contradictsWith;
    // A place that touches what protects the project (tests, CI, secrets, deploys) makes the card a tier-2 matter, worked out again here: it then needs two people to approve, however it was tiered before.
    const risky = touchesRiskyPath(cardPaths) && card.tier < 2;
    const writeCard: Lesson = { ...cardRest, scope: { ...card.scope, paths: cardPaths }, approvals: [], ...(risky ? { tier: 2 as const, tierReasons: [...new Set([...card.tierReasons, "risky_path"])].slice(0, 12) } : {}), version: nextVersion(card, await deps.store.versions(key, card.id)), updatedAt: now };
    const writeOther: Lesson = { ...other, scope: { ...other.scope, paths: otherPaths }, version: nextVersion(other, await deps.store.versions(key, other.id)), updatedAt: now };
    const result = await deps.store.commit(key, setVersion, [writeCard, writeOther], now, group.fence);
    if (result.ok) return { ok: true, cardVersion: writeCard.version, otherId: other.id, otherPaths, cardPaths };
    if (result.reason === "fenced" || result.reason === "erased") return { ok: false, code: result.reason === "erased" ? "not_found" : "not_eligible" };
  }
  return { ok: false, code: "conflict" };
}

/** The card is approved next, as always: this is the normal approval of the waiting card at its new version (a convenience for the route; no new rule). */
export const approveAfterSettle = (deps: ApproveDeps, input: { workspaceId: string; project: string; lessonId: string; approverId: string; expectedVersion: number }): ReturnType<typeof approveLesson> => approveLesson(deps, input);
export type { ApprovalFailure };
