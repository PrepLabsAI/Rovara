// /: the path from a reflector draft to a lesson in front of people (or live). Curate, check the code citations against the base commit,
// classify the tier, decide whether the lesson has earned a person's attention (promotion), and apply tier 0 by itself only when the project's policy says "auto" (the pilot default is one person) and the mode allows.
import { AuditUnavailable, activateLesson } from "./approve.js";
import { curateDraft, type CurateDeps, type CurateOutcome } from "./curate.js";
import { pendingExpiry } from "./expiry.js";
import { approversRequired, emitAudit, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { CitationVerifier, CodeFacts } from "./ports.js";
import { gatherMaterial } from "./material.js";
import { mentionsRepoPlace } from "./project-repo-audience.js";
import { attributableSources, clearSourcePause, coldSourcesOf, isHeldBySource, projectBrakeOn } from "./sources.js";
import { lessonValue } from "./value.js";
import { isCorroborated } from "./value.js";
import { isMeaningfulAnchor } from "@agentx/contracts";
import type { LessonDraft } from "./reflect.js";
import { nextVersion, type ScopeKey } from "./store.js";
import { classifyTier, type TierContext } from "./tier.js";
import { TRIAL_APPROVER, trialBlockers, type TrialContext } from "./trial.js";
import { sameSource, type Lesson } from "./types.js";

export interface ProcessDeps extends CurateDeps {
  verifier: CitationVerifier; facts: CodeFacts; settings: LearningSettingsReader;
  /** How many person-approved lessons a source needs before it may auto-apply one (default `AUTO_APPLY_GUARDS.coldStartLessons`). Only a test sets it lower. */
  coldStartLessons?: number;
  /**
   * the places (`<source>:repo/<id>`) of the repositories the project has NOW, read live from the project definition. Asked only for a lesson whose restriction is exactly "readers of repositories" (or that names
   * one); a lesson restricted to the project's own repositories is then tiered and put on trial as a project-wide one. Absent, or `undefined` back (unreadable): the lesson stays restricted (fail closed). Must not throw.
   */
  projectRepos?: (key: ScopeKey) => Promise<ReadonlySet<string> | undefined>;
}

/** The project's repositories, live, when this lesson's audience depends on them; undefined otherwise or when they cannot be read. Never throws. */
async function projectReposFor(deps: Pick<ProcessDeps, "projectRepos">, key: ScopeKey, lesson: Pick<Lesson, "provenance">): Promise<ReadonlySet<string> | undefined> {
  if (deps.projectRepos === undefined || !mentionsRepoPlace(lesson)) return undefined;
  try { return await deps.projectRepos(key); } catch { return undefined; }
}
const VERIFY_TIMEOUT_MS = 3000;

/**
 * A promotion rule (step 5, with the owner's corroboration rule): two independent tasks, or one task plus a member's own signal, or a
 * corroborated tier-0 fact (a measured outcome behind it). A single-source fact waits as a candidate until something backs it up. Nothing is dropped.
 */
export function earnedAttention(lesson: Lesson, tier: Lesson["tier"], reasons: readonly string[] = []): boolean {
  if (lesson.contradictsWith !== undefined) return true;
  // A possible duplicate is in front of people at once: they decide whether it merges, stays beside the other lesson or is rejected.
  if (lesson.possibleDuplicateOf !== undefined) return true;
  // A draft that resembles advice a person rejected is in front of people at once, with or without a link to the rejected lesson (it has none when the draft's audience cannot read that lesson).
  if (reasons.includes("matches_rejected")) return true;
  // A lesson that asks for a capability change is in front of people at once: the guard that used to drop it now only sends it to them.
  if (reasons.includes("capability_request")) return true;
  if (new Set(lesson.provenance.supportTasks).size >= 2) return true;
  if (lesson.provenance.supportTasks.length >= 1 && lesson.provenance.memberSignal) return true;
  return tier === 0 && isCorroborated(lesson.provenance);
}

async function verifyCitations(deps: ProcessDeps, lesson: Lesson): Promise<Lesson> {
  const now = deps.now();
  const checks: NonNullable<Lesson["citationChecks"]> = [];
  const citations = [...lesson.citations];
  for (const [index, citation] of lesson.citations.entries()) {
    if (citation.kind !== "code") continue;
    // A trivial anchor (a lone brace) proves nothing: it is recorded as stale, so the lesson cannot be tier 0.
    if (!isMeaningfulAnchor(citation.anchor)) { checks.push({ index, result: "stale", at: now }); continue; }
    try {
      const answer = await Promise.race([
        deps.verifier.verify({ workspaceId: lesson.workspaceId, project: lesson.project, repo: citation.repo, commit: citation.commit, path: citation.path, startLine: citation.startLine, endLine: citation.endLine, anchor: citation.anchor }),
        new Promise<{ result: "unknown" }>((resolve) => setTimeout(() => resolve({ result: "unknown" }), VERIFY_TIMEOUT_MS).unref?.()),
      ]);
      if (answer.result === "valid") checks.push({ index, result: "valid", at: now });
      else if (answer.result === "moved" && "startLine" in answer && answer.startLine !== undefined && answer.endLine !== undefined) {
        citations[index] = { ...citation, startLine: answer.startLine, endLine: answer.endLine };
        checks.push({ index, result: "valid", at: now });
      } else if (answer.result === "stale") checks.push({ index, result: "stale", at: now });
      // unknown: no check is recorded, so the lesson is not trusted as verified.
    } catch { /* an unreadable check is the same as no check */ }
  }
  return { ...lesson, citations, citationChecks: checks };
}

/** What a settle can change in a lesson, for telling a pass that changed nothing from one that did (checks are compared by result, not by the time they were made). */
const settledShape = (lesson: Lesson): string => JSON.stringify([
  lesson.status, lesson.tier, lesson.tierReasons, lesson.approvals, lesson.reviewRequired ?? null, lesson.pendingExpiresAt ?? null, lesson.title, lesson.description, lesson.body, lesson.citations,
  (lesson.citationChecks ?? []).map((check) => [check.index, check.result]),
]);

export interface SettleOptions { /** A repeat of a settle that already ran (a retry, `draft-retry.ts`): a pass that would change nothing writes nothing, so a repeat never adds a version of its own. */ resume?: boolean; contradiction?: boolean; judgeEscalate?: boolean; /** Never apply by itself: used when a pause lifts, so a person decides. */ noAutoApply?: boolean }

/**
 * Verifies, tiers and routes one lesson that the curator just wrote or changed. A lesson that is not yet supported stays a candidate. A lesson that is
 * "never" is rejected (and audited as refused when it asked for a capability). Tier 0 goes live when the policy and the mode allow and the project's
 * tier-0 brake is off; everything else becomes pending for people.
 */
export async function settleLesson(deps: ProcessDeps, key: ScopeKey, lessonId: string, options: SettleOptions = {}): Promise<Lesson | undefined> {
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "reflect")) return undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await deps.store.get(key, lessonId);
    if (current === undefined || (current.status !== "candidate" && current.status !== "pending")) return current;
    const verified = await verifyCitations(deps, current);
    // The judge's escalate flag and a contradiction stay with the lesson: settling again can raise a tier, never lower it.
    const context: TierContext = { contradiction: current.contradictsWith !== undefined || current.tierReasons.includes("matches_rejected") || options.contradiction === true, judgeEscalate: options.judgeEscalate === true || current.tierReasons.includes("judge_escalate") };
    // A refinement is at least as risky as the lesson it replaces. A lesson already tiered keeps its tier and reasons: settling again only raises.
    const superseded = current.supersedes === undefined ? undefined : await deps.store.get(key, current.supersedes);
    if (superseded !== undefined) context.supersedesTier = superseded.tier;
    // What the renderer may rely on: identifiers and paths read from the repository at the cited commit.
    const material = await gatherMaterial(deps.facts, verified);
    const projectRepos = await projectReposFor(deps, key, verified);
    const decision = classifyTier({ ...verified, ...(material === undefined ? {} : { material }) }, { ...context, projectRepos }, current.tierReasons.length > 0 ? { tier: current.tier, reasons: current.tierReasons } : undefined);
    const now = deps.now();
    const setVersion = await deps.store.setVersion(key);
    const version = nextVersion(current, await deps.store.versions(key, lessonId));

    if (decision.tier === "never") {
      const result = await deps.store.commit(key, setVersion, [{ ...verified, version, status: "rejected", rejectedReason: decision.reasons[0] ?? "refused", updatedAt: now }], now);
      if (!result.ok) continue;
      await emitAudit(deps.audit, { action: "lesson.refused", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { reason: decision.reasons[0] ?? "refused" } });
      return deps.store.get(key, lessonId);
    }

    const flags = await deps.store.flags(key);
    // A lesson from a source that spiked is collected but held: it is not queued for people or applied until a maintainer resumes the source.
    const held = isHeldBySource(flags, attributableSources(verified.provenance));
    const brakeOn = projectBrakeOn(flags, deps.now());
    // Approve by exception: a low-risk lesson from a member's own correction with verified citations goes live on trial with no approval and no corroboration. Anything the rules
    // send to a person (tier 2, a contradiction, a refinement, a held or braked source, the Regulated preset) is decided by the old rules below.
    const trialContext = (settings: Pick<typeof resolved, "preset" | "mode" | "trialAllowed">, braked: boolean, heldNow: boolean, repos: ReadonlySet<string> | undefined = projectRepos): TrialContext => ({
      projectRepos: repos, preset: settings.preset, mode: settings.mode, trialAllowed: settings.trialAllowed, contradiction: context.contradiction === true, refinement: current.supersedes !== undefined,
      reviewRequired: options.noAutoApply === true || current.reviewRequired === true, held: heldNow, braked,
    });
    const trialWhy = trialBlockers({ ...verified, ...(decision.tier === 0 && decision.rendered !== undefined ? { title: decision.rendered.title, description: decision.rendered.description, body: decision.rendered.body } : {}) }, decision.tier, trialContext(resolved, brakeOn, held));
    const trial = trialWhy.length === 0;
    const earned = trial || (earnedAttention(verified, decision.tier, decision.reasons) && (!held || current.status === "pending"));
    // The project brake: while the volume alert is fresh, a tier-0 lesson that WOULD have applied by itself is sent to a person instead, and stays with a person (no source is paused).
    const autoOn = decision.tier === 0 && approversRequired(0, resolved.approval) === 0 && modeAllows(resolved.mode, "auto_apply");
    const braked = autoOn && brakeOn;
    // A higher tier than before means earlier approvals were for less risk: they no longer count.
    const approvals = decision.tier > current.tier ? [] : current.approvals;
    const settled: Lesson = {
      ...verified, ...(decision.tier === 0 && decision.rendered !== undefined ? { title: decision.rendered.title, description: decision.rendered.description, body: decision.rendered.body } : {}), version, tier: decision.tier, tierReasons: decision.reasons.slice(0, 12), approvals, updatedAt: now,
      ...(options.noAutoApply === true || held || braked || current.reviewRequired === true ? { reviewRequired: true } : {}),
      status: earned ? "pending" : "candidate", ...(earned ? { pendingExpiresAt: current.pendingExpiresAt ?? pendingExpiry(now) } : {}),
    };
    // A repeat that finds the lesson already as this pass would leave it keeps its version (the later steps read `next.version`).
    const next: Lesson = options.resume === true && settledShape(settled) === settledShape(current) ? { ...settled, version: current.version, updatedAt: current.updatedAt } : settled;
    const result = options.resume === true && settledShape(next) === settledShape(current) ? { ok: true as const, setVersion } : await deps.store.commit(key, setVersion, [next], now);
    if (!result.ok) continue;
    if (next.status === "pending" && current.status !== "pending" && !trial) await emitAudit(deps.audit, { action: "lesson.pending", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { tier: next.tier, ...(decision.reasons.includes("capability_request") ? { reason: "capability_request" } : {}) } });

    // Trial: pending only for the moment it takes to go live; if it cannot (the audit is down, the settings changed, the lesson no longer passes, a newer version landed), a person decides it, and
    // says so in the ledger (`lesson.pending`, which is skipped above for the trial path).
    if (trial && next.status === "pending") {
      const toPerson = async (reason: string): Promise<Lesson | undefined> => {
        await emitAudit(deps.audit, { action: "lesson.pending", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { tier: next.tier, reason } });
        return deps.store.get(key, lessonId);
      };
      // The settings are read AGAIN at the moment of go-live, and the trial rules run AGAIN on the lesson as stored: its text (tier 0 text is rendered), its flags, the brake and the pause flags as they are now.
      const again = await resolveLearning(deps.settings, key.workspaceId, key.project);
      const stored = await deps.store.get(key, lessonId);
      if (stored === undefined || stored.version !== next.version) return stored;
      const flagsNow = await deps.store.flags(key);
      const brakedNow = projectBrakeOn(flagsNow, deps.now());
      if (brakedNow) deps.metrics?.count("learning_trial_held", { reason: "project_brake" });
      // The project's repositories are read AGAIN too: a repository removed from the project while this settle ran leaves the lesson restricted.
      const recheck = trialBlockers(stored, stored.tier, trialContext(again, brakedNow, isHeldBySource(flagsNow, attributableSources(stored.provenance)), await projectReposFor(deps, key, stored)));
      if (recheck.length > 0) return toPerson("trial_recheck");
      try {
        const live = await activateLesson(deps, key, stored, [{ approvalId: `trial-${lessonId}`, by: TRIAL_APPROVER, at: deps.now(), mode: "trial" }], again.expiryDays, "lesson.trial_started", { version: stored.version, setVersion: result.setVersion });
        if (live !== undefined) return live;
      } catch (error) {
        if (!(error instanceof AuditUnavailable)) throw error;
      }
      return toPerson("trial_not_started");
    }

    // Auto-apply: tier 0, corroborated, not held, not a refinement of an existing lesson, and the policy and mode allow it.
    if (next.status === "pending" && next.tier === 0 && next.supersedes === undefined && isCorroborated(next.provenance) && !held && next.possibleDuplicateOf === undefined
      && options.noAutoApply !== true && next.reviewRequired !== true && approversRequired(0, resolved.approval) === 0 && modeAllows(resolved.mode, "auto_apply")) {
      // The policy is read AGAIN at the moment of go-live: a setting tightened while this settle ran wins.
      const now = await resolveLearning(deps.settings, key.workspaceId, key.project);
      if (approversRequired(0, now.approval) !== 0 || !modeAllows(now.mode, "auto_apply")) return deps.store.get(key, lessonId);
      // The brake is read AGAIN too (an alert that fired while this settle ran), and the cold-start rule is asked of the sources that vouch for the lesson: both leave it with a person.
      if (projectBrakeOn(await deps.store.flags(key), deps.now())) { deps.metrics?.count("learning_auto_apply_held", { reason: "project_brake" }); return deps.store.get(key, lessonId); }
      const cold = await coldSourcesOf(deps.store, key, attributableSources(next.provenance), lessonId, deps.coldStartLessons);
      if (cold.unattributed || cold.cold.length > 0) { deps.metrics?.count("learning_auto_apply_held", { reason: cold.unattributed ? "no_source" : "cold_start" }); return deps.store.get(key, lessonId); }
      try {
        const active = await activateLesson(deps, key, next, [{ approvalId: `auto-${lessonId}`, by: "system:auto", at: deps.now(), mode: "auto" }], resolved.expiryDays, "lesson.auto_applied", { version: next.version, setVersion: result.setVersion });
        if (active !== undefined) return active;
      } catch (error) {
        // If the go-live cannot be audited it does not happen: the lesson stays pending for a person.
        if (!(error instanceof AuditUnavailable)) throw error;
      }
    }
    return deps.store.get(key, lessonId);
  }
  return undefined;
}

export interface ProcessResult { outcome: CurateOutcome; lesson?: Lesson }

/** What the curate step's answer tells the settle step (kept apart so a retry can settle without curating again: `draft-retry.ts`). */
export function settleOptionsOf(outcome: CurateOutcome): SettleOptions {
  return outcome.outcome === "contradiction" ? { contradiction: true } : outcome.outcome === "added" || outcome.outcome === "updated" || outcome.outcome === "possible_duplicate" ? { judgeEscalate: outcome.judgeEscalate } : {};
}

/** Curates one reflector draft and settles the resulting lesson. */
export async function processDraft(deps: ProcessDeps, key: ScopeKey, draft: LessonDraft): Promise<ProcessResult> {
  const outcome = await curateDraft(deps, key, draft);
  if (outcome.outcome === "dropped") return { outcome };
  const lesson = await settleLesson(deps, key, outcome.lesson.id, settleOptionsOf(outcome));
  return lesson === undefined ? { outcome } : { outcome, lesson };
}

export const RESUME_RESETTLE_LIMIT = 200;
/**
 * A maintainer resumes a paused source, and the candidates held while it was paused are settled again, most valuable first, under the rules in force now
 * (tier, corroboration, spike holds from OTHER sources that are still paused). Nothing is applied just because the pause lifted: a held lesson that has
 * earned attention goes to people as pending; it never goes live from here. Bounded at RESUME_RESETTLE_LIMIT lessons per call.
 */
export async function resumeAndResettle(deps: ProcessDeps, key: ScopeKey, source: string, actor: string): Promise<{ resumed: boolean; settled: string[] }> {
  if (!(await clearSourcePause(deps, deps.store, key, source, actor))) return { resumed: false, settled: [] };
  const held = (await deps.store.list(key, { statuses: ["candidate"] }))
    .filter((l) => attributableSources(l.provenance).some((s) => sameSource(s, source)))
    .sort((a, b) => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id))
    .slice(0, RESUME_RESETTLE_LIMIT);
  const settled: string[] = [];
  for (const lesson of held) {
    const result = await settleLesson(deps, key, lesson.id, { noAutoApply: true });
    if (result !== undefined) settled.push(lesson.id);
  }
  return { resumed: true, settled };
}
