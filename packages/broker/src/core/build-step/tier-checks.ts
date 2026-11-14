// The lighter flow after each push: for a task whose planning steps were skipped (`flow.skippedSteps`), the checks that stand in for them run on the CURRENT head of its pull requests, read from the code host
// with the merge gate's own read (`readReviewInput`), never from the worker, the agent or a cached copy:
//   - the tier of that head (only up; a head the post-push writer has not tiered, such as a person's own push, is tiered here), and the growth past the level the planning steps were chosen at;
//   - the reviewer floor on a small change (`applyReviewerFloor`), once per head and patch;
//   - a code review of a small change whose head no review step saw (a person's push), on the same patch;
//   - the quick checks by kind (secret scan, tests, dependency source, install link pairs, CI file);
//   - for a change that grew: the stop in plain words (`tierGrowthSentence`), then the code and security reviews of the GROWN tier on the current head, and `recordTierReview` only when both ran and found
//     nothing that must be fixed. A failed or unanswered review is recorded for the head and never asked again for it (no shopping for a clean review); a new push gets a new review.
// The record is written under `flowIs` (the record read), re-applied to the newer record when another writer got in first, so a yes is never lost to a race. It reads the record, never the switch: a task that
// skipped steps owes these checks whether or not the lighter flow is still on.
import { change, when, type FlowQuickCheck, type FlowTierKind, type HostScope, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import {
  DOCS_ROUTE_LINES_MAX, higherLevel, plannedPathsExceeded, planningLevelOf, recordGrowth, recordTier, recordTierReview, skippedPlanning, tierFromDiff, tierGrowthSentence, tierRank, tierReviewRecorded, type ChangeTier, type TierFile, type TierLevel,
} from "../decisions/change-tier.js";
import { floorOwed, reviewTextOf, withoutTierReviews } from "../decisions/tier-floor-state.js";
import { applyReviewerFloor, recordReviewerFloor, type ReviewerFloorResult } from "../decisions/tier-reviewer.js";
import { boundCommits, readTierInput, type TierReadTarget } from "../merge/change-tier-read.js";
import { changeRequestRef } from "../merge/host-port.js";
import { inertLine } from "../proof/inert-text.js";
import { SessionStore } from "../sessions/store.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { flowIs } from "../task-flow/flow-guard.js";
import { taskKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import type { TaskRecord } from "../task-flow/records.js";
import { namedPaths, ownQuickChecks, quickCheckEntry, withQuickChecks } from "../task-flow/stage-selection.js";
import { iso, log } from "../task-flow/support.js";
import { isOutageReason, planScopeQuestion, readScopeQuestion, scopeBanner, scopeHolds, withScopeBanner, type ScopeQuestionRecord } from "./scope-question.js";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "./plan-input.js";
import { pathsIn, planFiles } from "../decisions/plan-facts.js";
import { fileTypeOf } from "../decisions/sensitive-list.js";
import { pullRequestRecordKey, pullRequestRecordOf } from "./records.js";
import { checkingModelOf, runCodeReview, runGrownReviews, tierReviewerOf, type CheckingModel, type GrownReviewResult, type TierReviewPurpose } from "./tier-review-calls.js";
import { createHash } from "node:crypto";

export type TierChecksOutcome = "not_owed" | "checked" | "unavailable";

/** How many times the record is written before the pass gives up (the next pass reads it again). */
const WRITE_ATTEMPTS = 5;

/** The reasons a tier carries that a quick check reads. */
const SECRET_REASONS = new Set(["secret_like_text"]);
const SOURCE_REASONS = new Set(["dependency_source", "registry_source_changed", "package_source_setting"]);

const inert = (text: string, max = 120): string => inertLine(text, max);

/** The old and new install commands or links a change shows, side by side, from the host's patch text: each removed line that holds a link or an install command beside the added one in its place. */
export function installLinkPairs(files: readonly TierFile[]): Array<{ path: string; before: string; after: string }> {
  const LINK = /https?:\/\/|\b(?:curl|wget|pip3? install|npm (?:i|install)|brew install|apt(?:-get)? install|go install|cargo install)\b/iu;
  const pairs: Array<{ path: string; before: string; after: string }> = [];
  for (const file of files) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of (file.patch ?? "").split("\n")) {
      if (line.startsWith("-") && !line.startsWith("---") && LINK.test(line)) removed.push(line.slice(1).trim());
      if (line.startsWith("+") && !line.startsWith("+++") && LINK.test(line)) added.push(line.slice(1).trim());
    }
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) pairs.push({ path: file.path, before: removed[index] ?? "(none)", after: added[index] ?? "(none)" });
  }
  return pairs;
}

/** The quick checks of a head, by the kinds the change touches. A failed one blocks the merge (the caller raises the tier and never writes a review record for the head while it stands); not_run is never a pass. */
function quickChecksOf(input: { kinds: readonly FlowTierKind[]; tier: ChangeTier; head: string; workflow: WorkflowSnapshot; files: readonly TierFile[]; checking: CheckingModel; floorAnswered: boolean; at: string }): FlowQuickCheck[] {
  const at = input.at;
  const head = `head=${input.head}`;
  const reasons = (codes: Set<string>) => input.tier.reasons.filter((reason) => codes.has(reason.code));
  const results = input.workflow.verification?.results ?? [];
  const tests: FlowQuickCheck["outcome"] = results.length === 0 ? "not_run" : results.every((result) => result.status === "PASS") ? "passed" : "failed";
  const model = input.checking.model === undefined ? "the install's model" : `${input.checking.model.provider}/${input.checking.model.modelId}`;
  const entries: FlowQuickCheck[] = [];
  for (const kind of input.kinds) {
    if (kind === "docs") {
      const found = reasons(SECRET_REASONS);
      entries.push(quickCheckEntry({ kind, outcome: found.length > 0 ? "failed" : "passed", at,
        detail: found.length > 0 ? `docs secret scan ${head} found text that looks like a credential in ${inert(found[0]!.path ?? "a file", 80)}` : `docs secret scan ${head} found nothing` }));
    } else if (kind === "code_config") {
      entries.push(quickCheckEntry({ kind, outcome: tests, at, detail: `code_config tests ${tests} ${head}; reviewer ${inert(model, 80)}, same model as the build: ${input.checking.sameModelAsChecked ? "yes" : "no"}` }));
    } else if (kind === "dependency") {
      const source = reasons(SOURCE_REASONS);
      const outcome: FlowQuickCheck["outcome"] = source.length > 0 ? "failed" : tests;
      entries.push(quickCheckEntry({ kind, outcome, at, detail: source.length > 0 ? `dependency source ${head} changed where packages come from (${inert(source[0]!.path ?? "a lock file", 80)})` : `dependency install in the test run ${tests} ${head}` }));
    } else if (kind === "install_link") {
      const pairs = installLinkPairs(input.files).slice(0, 3);
      entries.push(quickCheckEntry({ kind, outcome: pairs.length > 0 ? "passed" : "not_run", at,
        detail: `install_link ${head} ${pairs.length === 0 ? "no command or link was found in the patch" : pairs.map((pair) => `${inert(pair.path, 60)}: old ${inert(pair.before, 100)} | new ${inert(pair.after, 100)}`).join("; ")}` }));
    } else {
      entries.push(quickCheckEntry({ kind, outcome: input.floorAnswered ? "passed" : "not_run", at, detail: `ci_file reviewer questions (secrets and data sent out) ${input.floorAnswered ? "answered" : "not answered"} ${head}` }));
    }
  }
  return entries;
}

/** The tier with a failed quick check: at least standard, with the reason in front (only up). */
function raisedByCheck(tier: ChangeTier, failed: FlowQuickCheck): ChangeTier {
  const level: TierLevel = tierRank(tier.level) >= tierRank("standard") ? tier.level : "standard";
  return { ...tier, level, reasons: [{ code: "quick_check_failed", path: inert((failed.detail ?? "").replace(/^check /u, ""), 200) }, ...tier.reasons].slice(0, 50) };
}

const reviewAttempt = (level: TierLevel, head: string) => `review level=${level} head=${head}`;

/** One pass of the lighter flow's checks for a task. Never throws for a host or a model that cannot answer: the record then stays as it was (the merge gate refuses what is owed). */
export async function runTierChecks(deps: TaskFlowDeps, task: TaskRecord, beforeRequest?: () => void): Promise<TierChecksOutcome> {
  const workflow = task.workflow;
  if (workflow === undefined || task.closedAt !== undefined || !skippedPlanning(workflow.flow) || deps.codeHosts === undefined) return "not_owed";
  const open = (workflow.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN");
  if (open.length === 0) return "not_owed";
  const call = deps.tierReviewCall;
  const scope: HostScope = { orgId: deps.companyId };
  const at = iso(deps);
  try {
    const project = await deps.projects.revision(task.project, task.startingRevision);
    const targets: Array<TierReadTarget & { headSha: string }> = [];
    for (const entry of open) {
      const definition = project?.definition.repositories.find((repository) => repository.name === entry.repositoryId);
      if (definition === undefined) return "unavailable";
      const host = codeHostForRecord(deps.codeHosts, definition);
      beforeRequest?.();
      const remote = await host.getChangeRequest(changeRequestRef(definition.url, entry.number), scope);
      if (remote.state !== "open") return "not_owed";
      targets.push({ host, repositoryId: entry.repositoryId, repositoryUrl: definition.url, number: entry.number, headSha: remote.headRevision });
    }
    const bound = boundCommits(targets.map((target) => ({ repositoryId: target.repositoryId, headSha: target.headSha, baseCommitSha: workflow.reviewBase?.find((base) => base.repositoryId === target.repositoryId)?.baseCommitSha })));
    const head = bound.headSha;
    if (head === undefined) return "unavailable";
    // The gate's own read of the change at the pinned heads, once: the reviewer is given exactly its patch (the form `readReviewInput` gives), and the tier reads the head facts the same read returned.
    const read = await readTierInput(targets, scope, beforeRequest);
    const input = { ...reviewTextOf(read.diff), diff: read.diff };
    // A head the record has no tier for (a person's push, or one the post-push writer could not read) is tiered here, from the same files.
    const flow = workflow.flow;
    // A reviewer outage holds the head it happened on, not the next ones: the head of the first tier an outage raised.
    const outageOnly = flow?.tier !== undefined && flow.tier.reasons.length > 0 && flow.tier.reasons.every(isOutageReason);
    const outageHead = [...(flow?.tierHistory ?? []), ...(flow?.tier === undefined ? [] : [flow.tier])].find((tier) => tier.reasons.some((reason) => reason.code === "reviewer_unavailable"))?.headSha;
    const outageElsewhere = outageOnly && outageHead !== head;
    const needsTier = flow?.tier?.headSha !== head || flow.tier.source === "estimate" || outageElsewhere;
    const fresh = needsTier ? tierFromDiff(read.diff, { ...bound, at, head: read.head }) : undefined;
    // The heads must not have moved while they were read.
    for (const target of targets) {
      beforeRequest?.();
      const again = await target.host.getChangeRequest(changeRequestRef(target.repositoryUrl, target.number), scope);
      if (again.state === "open" && again.headRevision !== target.headSha) return "unavailable";
    }
    const planned: TierLevel = planningLevelOf(flow) ?? "small";
    const withTier = (current: WorkflowFlow | undefined): WorkflowFlow | undefined => {
      if (fresh === undefined) return current;
      // A reviewer outage holds the head it happened on, not the next ones: a tier raised by nothing but an outage on another head does not carry over (the new head is asked again).
      const previous = current?.tier;
      if (current !== undefined && previous !== undefined && outageElsewhere && previous.reasons.length > 0 && previous.reasons.every(isOutageReason)) {
        // The outage's raise is kept in the history (it is what happened on that head); the growth it alone caused does not stand for the new head.
        const { grewAfterBuild: _grew, ...rest } = current;
        void _grew;
        const next: WorkflowFlow = { ...rest, tier: fresh, tierHistory: [...(current.tierHistory ?? []), previous].slice(-20) };
        return tierRank(fresh.level) > tierRank(planned) ? recordGrowth(next, planned, fresh.level, at) : next;
      }
      const recorded = recordTier(current, fresh);
      return tierRank(recorded.tier.level) > tierRank(planned) ? recordGrowth(recorded.flow, planned, recorded.tier.level, at) : recorded.flow;
    };
    // The docs route carries at most 300 changed lines for the WHOLE change (additions plus deletions, against the base), not per document: a change of only documents past that takes the standard flow.
    const docsLines = input.diff.files.reduce((total, file) => total + file.additions + file.deletions, 0);
    const withDocsTotal = (current: WorkflowFlow | undefined): WorkflowFlow | undefined => {
      const tier = current?.tier;
      if (tier === undefined || tier.level !== "small" || tier.headSha !== head || tier.kinds.some((kind) => kind !== "docs") || docsLines <= DOCS_ROUTE_LINES_MAX) return current;
      const recorded = recordTier(current, { ...tier, level: "standard", reasons: [{ code: "docs_large", path: `${String(docsLines)} changed document lines in all` }, ...tier.reasons].slice(0, 50) });
      return tierRank(recorded.tier.level) > tierRank(planned) ? recordGrowth(recorded.flow, planned, recorded.tier.level, at) : recorded.flow;
    };
    // The plan's own files: a code file the plan (or the request and Understand) did not name is at least standard; in a change planned as documents only, it is risky (and so asks the scope question).
    const plannedFiles = await plannedPathsOf(deps, workflow, task.requestText);
    const firstEstimate = [...(flow?.tierHistory ?? []), ...(flow?.tier === undefined ? [] : [flow.tier])].find((tier) => tier.source === "estimate");
    const docsPlan = firstEstimate !== undefined && firstEstimate.kinds.length > 0 && firstEstimate.kinds.every((kind) => kind === "docs");
    const outside = plannedFiles === undefined ? [] : plannedPathsExceeded(plannedFiles, read.diff.files).filter((path) => fileTypeOf(path) !== "prose" && read.diff.files.some((file) => file.path === path) && !(!docsPlan && testOfPlannedFile(path, plannedFiles)));
    const withPlanScope = (current: WorkflowFlow | undefined): WorkflowFlow | undefined => {
      const tier = current?.tier;
      if (current === undefined || tier === undefined || tier.headSha !== head || outside.length === 0) return current;
      const level: TierLevel = docsPlan ? "risky" : tierRank(tier.level) >= tierRank("standard") ? tier.level : "standard";
      if (tierRank(level) <= tierRank(tier.level) && tier.reasons.some((reason) => reason.code === "outside_plan_code")) return current;
      const recorded = recordTier(current, { ...tier, level: higherLevel(tier.level, level), reasons: [...outside.slice(0, 5).map((path) => ({ code: "outside_plan_code", path: path.slice(0, 200) })), ...tier.reasons].slice(0, 50) });
      return tierRank(recorded.tier.level) > tierRank(planned) ? recordGrowth(recorded.flow, planned, recorded.tier.level, at) : recorded.flow;
    };
    let draft = withPlanScope(withDocsTotal(withTier(flow)));
    const checking = await checkingModelOf(deps, task.workspaceId);
    // Every reviewer call is counted against the task's spend when the install meters it; a refusal is an unavailable reviewer (fail closed).
    const meterFor = (purpose: TierReviewPurpose) => (deps.tierReviewMeter === undefined ? undefined : () => deps.tierReviewMeter!({ taskId: task.taskId, purpose, model: checking.model, promptChars: input.patchText.length }));
    // The floor: a small change is put to the one strongest-available reviewer once per head and patch. Without a reviewer wired, nothing is asked and the gate keeps refusing.
    let floor: ReviewerFloorResult | undefined;
    if (draft?.tier !== undefined && draft.tier.level === "small" && draft.tier.headSha === head && floorOwed(draft, head, input.patchText) && call !== undefined) {
      floor = await applyReviewerFloor({ tier: draft.tier, reviewer: tierReviewerOf({ call, model: checking.model, refused: checking.refused, meter: meterFor("questions") }), files: input.files, patchText: input.patchText });
      draft = recordReviewerFloor(draft, floor, at) ?? draft;
    }
    // A head no review step saw (it is not the head Rovara published for the reviewed code): the small change's one code reviewer reads the same patch the floor was asked about.
    const reviewedHead = open.every((entry) => entry.candidateDigest === workflow.candidate?.digest && targets.some((target) => target.repositoryId === entry.repositoryId && target.headSha === entry.headSha));
    let unreviewed: GrownReviewResult | undefined;
    if (!reviewedHead && draft?.tier?.level === "small" && call !== undefined && !ownQuickChecks(draft).some((check) => check.detail?.includes(reviewAttempt("small", head)) === true)) {
      unreviewed = await runCodeReview({ call, model: checking, files: input.files, patchText: input.patchText, meter: (purpose) => meterFor(purpose)?.() ?? Promise.resolve(true) });
    }
    // The quick checks of this head, by kind.
    const tierNow = draft?.tier;
    const floorAnswered = draft?.quickChecks?.some((check) => check.detail?.startsWith(`tier_questions head=${head} `) === true) === true;
    const checks = tierNow === undefined ? [] : quickChecksOf({ kinds: tierNow.kinds, tier: tierNow, head, workflow, files: input.diff.files, checking, floorAnswered, at });
    if (unreviewed !== undefined) {
      checks.push(quickCheckEntry({ kind: "code_config", outcome: unreviewed.completed && unreviewed.mustFix === 0 ? "passed" : "failed", at,
        detail: `${reviewAttempt("small", head)} code review of a version no review step saw: ${unreviewed.completed ? `${String(unreviewed.mustFix)} must be fixed` : `did not run (${unreviewed.failure ?? "unknown"})`}` }));
    }
    const withChecks = (current: WorkflowFlow | undefined): WorkflowFlow | undefined => {
      if (current === undefined || checks.length === 0) return current;
      let next = withQuickChecks(current, checks);
      const failed = blockingFailure(next, head);
      if (failed !== undefined && next.tier !== undefined) {
        const recorded = recordTier(next, raisedByCheck(next.tier, failed));
        next = tierRank(recorded.tier.level) > tierRank(planned) ? recordGrowth(recorded.flow, planned, recorded.tier.level, at) : recorded.flow;
      }
      return next;
    };
    draft = withChecks(draft);
    // The grow-after-build stop: the grown tier's reviews on this head, once.
    let grown: { level: TierLevel; result: GrownReviewResult } | undefined;
    const level = draft?.tier?.level;
    const grew = level !== undefined && (tierRank(level) > tierRank(planned) || draft?.grewAfterBuild !== undefined);
    // A review that could not run (an outage, nothing found) is run again on a later pass, once the reviewer is back: it gave no answer, so running it again cannot shop for one. One that ran is not.
    // At most `REVIEW_RUNS_MAX` runs on one head, each a while after the one before (10, 20, 40 minutes...); then only Retry or a new push runs it again.
    const nowMs = Date.parse(at);
    const attempted = level !== undefined && ownQuickChecks(draft).some((check) => {
      if (check.detail?.includes(reviewAttempt(level, head)) !== true) return false;
      if (!isOutageEntry(check)) return true;
      const runs = runsOf(check);
      return runs >= REVIEW_RUNS_MAX || nowMs - Date.parse(check.at) < REVIEW_RERUN_WAIT_MS * 2 ** (runs - 1);
    });
    // A failed check of this head (a failed review included) holds it: nothing is asked again for it, and no review record is written while it stands.
    if (grew && level !== "small" && draft?.tier?.headSha === head && !tierReviewRecorded(draft, level, head) && !attempted && blockingFailure(draft, head) === undefined && call !== undefined) {
      grown = { level, result: await runGrownReviews({ call, model: checking, level, files: input.files, patchText: input.patchText, meter: (purpose) => meterFor(purpose)?.() ?? Promise.resolve(true) }) };
    }
    const withReview = (current: WorkflowFlow | undefined): WorkflowFlow | undefined => {
      if (current === undefined || grown === undefined) return current;
      // Only up: a review of this head and level that failed (in this pass or another one that ran at the same time) is never overwritten by a clean one, and takes away any review record of the head.
      const failedBefore = ownQuickChecks(current).some((check) => check.outcome === "failed" && check.detail?.includes(reviewAttempt(grown.level, head)) === true && !isOutageEntry(check));
      if (failedBefore) return withoutTierReviews(current, head);
      const passed = grown.result.completed && grown.result.mustFix === 0;
      if (!passed) {
        const earlier = ownQuickChecks(current).find((check) => check.detail?.includes(reviewAttempt(grown.level, head)) === true && isOutageEntry(check));
        const runs = (earlier === undefined ? 0 : runsOf(earlier)) + 1;
        const noted = withQuickChecks(current, [quickCheckEntry({ kind: "code_config", outcome: "failed", at,
          detail: `${reviewAttempt(grown.level, head)} ${String(grown.result.findings)} findings, ${String(grown.result.mustFix)} must be fixed${grown.result.completed ? "" : `; did not run (${grown.result.failure ?? "unknown"}); runs=${String(runs)}`}` })]);
        return withoutTierReviews(noted, head);
      }
      const noted = withQuickChecks(current, [quickCheckEntry({ kind: "code_config", outcome: passed ? "passed" : "failed", at,
        detail: `${reviewAttempt(grown.level, head)} ${String(grown.result.findings)} findings, ${String(grown.result.mustFix)} must be fixed${grown.result.completed ? "" : `; did not run (${grown.result.failure ?? "unknown"})`}` })]);
      // Only reviews that ran, both, at the grown level, on this head, with nothing to fix, are recorded as the review of that tier.
      return passed ? recordTierReview(noted, { level: grown.level, headSha: head, findings: grown.result.findings, mustFix: grown.result.mustFix, at }) : noted;
    };
    const headTier = tierFromDiff(read.diff, { ...bound, at, head: read.head });
    const earlierQuestion = await readScopeQuestion(deps, task.taskId);
    let scoped: ReturnType<typeof planScopeQuestion> = { asked: false };
    // Written under the record read, with the scope question in the SAME commit; another writer that got in first gets the same results applied to its record.
    let current: WorkflowSnapshot = workflow;
    let written = false;
    let finalFlow: WorkflowFlow | undefined = flow;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS && !written; attempt += 1) {
      const base = current.flow;
      const tiered = withPlanScope(withDocsTotal(withTier(base)));
      const next = withReview(withChecks(floor === undefined ? tiered : recordReviewerFloor(tiered, floor, at) ?? tiered));
      finalFlow = next ?? base;
      scoped = finalFlow === undefined ? { asked: false } : planScopeQuestion(attempt === 0 ? earlierQuestion : await readScopeQuestion(deps, task.taskId), task, {
        flow: finalFlow, headTier, files: read.diff.files, head, at,
        reviewsDown: finalFlow.tier !== undefined && finalFlow.tier.headSha === head && tierRank(finalFlow.tier.level) > tierRank(planned) && !tierReviewRecorded(finalFlow, finalFlow.tier.level, head)
          && ownQuickChecks(finalFlow).some((check) => isOutageEntry(check) && check.detail?.includes(reviewAttempt(finalFlow!.tier!.level, head)) === true),
      });
      const flowChanged = next !== undefined && JSON.stringify(next) !== JSON.stringify(base);
      if (!flowChanged && scoped.item === undefined) { written = true; break; }
      written = await deps.store.transact([
        ...(flowChanged ? [{ kind: "update" as const, key: taskKey(task.taskId), ops: [change.set(["workflow", "flow"], JSON.parse(JSON.stringify(next)) as never)], condition: when.and(when.notExists("closedAt"), flowIs(base)) }] : []),
        ...(scoped.item === undefined ? [] : [scoped.item]),
      ]).then((result) => result.applied).catch(() => false);
      if (!written) {
        const again = await readTask(deps, task.taskId);
        if (again?.workflow === undefined || again.closedAt !== undefined) break;
        current = again.workflow;
      }
    }
    if (!written) return "unavailable";
    // A small change that grew to risky: the scope question (from the head's own deterministic reasons), the banner on the pull request, and the notice, once per question.
    if (finalFlow !== undefined && scoped.question !== undefined) await scopeNotice(deps, task, { flow: finalFlow, question: scoped.question, asked: scoped.asked, at, targets });
    // The person is told what grew, once per head and level (the review's own record says whether it passed).
    if (grown !== undefined && task.sessionId !== undefined && draft?.tier !== undefined) {
      const sentence = tierGrowthSentence(draft.tier, (path) => inertLine(path, 80));
      const outcome = grown.result.completed && grown.result.mustFix === 0 ? `The ${grown.level} reviews ran on the current version and found nothing that must be fixed.`
        : grown.result.completed ? `The ${grown.level} reviews found ${String(grown.result.mustFix)} things that must be fixed before it can merge.` : `The ${grown.level} reviews could not run, so it can't be merged until a new version is reviewed.`;
      const eventId = `evt_${createHash("sha256").update(`tier-growth\u0000${task.taskId}\u0000${grown.level}\u0000${head}`).digest("hex").slice(0, 24)}`;
      await new SessionStore(deps.store).appendEvent(deps.companyId as never, task.sessionId as never, { eventId, at, type: "status", actor: { kind: "system" }, text: `${sentence} ${outcome}` })
        .catch((error: unknown) => log(deps, { event: "tier_checks.notice_not_written", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
    log(deps, { event: "tier_checks.done", taskId: task.taskId, level: draft?.tier?.level, floor: floor === undefined ? "not_asked" : floor.answered === true ? (floor.raised ? "yes" : "no") : "failed_closed", grown: grown === undefined ? "none" : grown.result.completed ? "ran" : "did_not_run", reviewer: call === undefined ? "missing" : "wired" });
    return "checked";
  } catch (error) {
    if (error instanceof Error && error.name === "HostRateLimitError") throw error;
    log(deps, { event: "tier_checks.unavailable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    return "unavailable";
  }
}

/** The banner at the top of the pull request description (only a description Rovara wrote and nobody edited since) and the person's notice, once per question. Best effort: the question itself is already recorded. */
async function scopeNotice(deps: TaskFlowDeps, task: TaskRecord, input: { flow: WorkflowFlow; question: ScopeQuestionRecord; asked: boolean; at: string; targets: ReadonlyArray<TierReadTarget & { headSha: string }> }): Promise<void> {
  try {
    const { question, asked } = input;
    const banner = scopeBanner(question, scopeHolds(input.flow, question));
    for (const target of input.targets) {
      const record = await pullRequestRecordOf(deps, task.workspaceId, target.repositoryId, target.number);
      const ref = changeRequestRef(target.repositoryUrl, target.number);
      const now = await target.host.getChangeRequest(ref, { orgId: deps.companyId });
      if (record === undefined || (now.body !== record.body)) continue;
      const body = withScopeBanner(now.body ?? "", banner);
      if (body === now.body) continue;
      await target.host.updateChangeRequest(ref, { body }, { orgId: deps.companyId });
      await deps.store.update({ key: pullRequestRecordKey(task.workspaceId, target.repositoryId, target.number), ops: [change.set("body", body), change.set("updatedAt", input.at)], condition: when.present() });
    }
    if (asked && task.sessionId !== undefined) {
      const text = question.kind === "couldnt_check"
        ? "Rovara could not check this change, so it stays a draft. Retry the check from the task page, or stop the task."
        : `This grew from small to risky. It also changed ${question.area}: ${question.files.map((file) => `${file.path} (+${String(file.additions)} -${String(file.deletions)})`).join(", ")}. It stays a draft: keep these files, remove them, or stop the task on the task page.`;
      const eventId = `evt_${createHash("sha256").update(`scope-question\u0000${task.taskId}\u0000${String(question.version)}`).digest("hex").slice(0, 24)}`;
      await new SessionStore(deps.store).appendEvent(deps.companyId, task.sessionId, { eventId, at: input.at, type: "status", actor: { kind: "system" }, text });
    }
  } catch (error) {
    log(deps, { event: "tier_checks.scope_notice_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

/** The files the plan names (a structured plan's cited files, the paths a Markdown plan's words name) and the files the request and Understand's reading name. Undefined: the plan cannot be read (nothing is judged by it). */
async function plannedPathsOf(deps: TaskFlowDeps, workflow: WorkflowSnapshot, requestText: string | undefined): Promise<string[] | undefined> {
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined) return undefined;
  const loaded = await loadWorkflowDocument(textReaderOf(deps.artifacts), artifact, {}).catch(() => undefined);
  if (loaded === undefined) return undefined;
  return [...new Set([...(loaded.format === "structured" ? planFiles(loaded.plan) : []), ...pathsIn(loaded.markdown), ...namedPaths(requestText, workflow.intent?.assessment)])];
}

/** A grown review that could not run (an outage) and found nothing that must be fixed: it holds nothing by itself, and is run again. */
function isOutageEntry(check: FlowQuickCheck): boolean {
  const detail = check.detail ?? "";
  const kinds = /did not run \(([^)]*)\)/u.exec(detail)?.[1]?.split(", ") ?? [];
  return check.outcome === "failed" && /\breview level=/u.test(detail) && kinds.length > 0 && kinds.every((kind) => kind === "unavailable" || kind === "refused") && /\b0 must be fixed/u.test(detail);
}

/** A failed check of this head that blocks it: every failed own entry except an outage of a review (which is run again). */
function blockingFailure(flow: WorkflowFlow | undefined, head: string): FlowQuickCheck | undefined {
  return ownQuickChecks(flow).find((check) => check.outcome === "failed" && (check.detail ?? "").includes(`head=${head}`) && !isOutageEntry(check));
}

/** The extensions of test code (a shell script, a JSON or YAML file named like a test is not one). */
const TEST_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|java|kt|kts|rs|cs|swift|php|scala|ex|exs|c|cc|cpp|h|hpp)$/u;
const TEST_FOLDERS = new Set(["tests", "test", "__tests__", "spec"]);
/** The usual buckets inside a tests folder (`tests/unit/...`). */
const TEST_BUCKETS = new Set(["unit", "integration", "e2e", "functional"]);
/** The usual source folders a tests folder mirrors (`src/a.ts` is tested by `tests/a.test.ts`). */
const SOURCE_FOLDERS = new Set(["src", "lib", "app"]);

/**
 * Whether a file is the test of a CODE file the plan names: test code (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*`, with a code extension) with the planned file's name, either beside it, or in the tests
 * folder of the same package at the mirrored path (`src/a.ts` and `tests/a.test.ts`, `tests/unit/a.test.ts` or `tests/src/a.test.ts`; `packages/ui/src/a.ts` and `packages/ui/test/a.test.ts`). Never for a
 * planned document. A lock file a planned manifest changes is covered already (`plannedPathsExceeded`).
 */
export function testOfPlannedFile(path: string, planned: readonly string[]): boolean {
  if (!TEST_EXTENSIONS.test(path)) return false;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  const folder = parts.slice(0, -1);
  const isTest = /(?:^test_|[._-](?:test|spec)\.[A-Za-z0-9]+$)/u.test(name);
  const match = /^(?:test_)?(.+?)(?:[._-](?:test|spec))?\.[A-Za-z0-9]+$/u.exec(name);
  if (!isTest || match === null) return false;
  const stem = match[1]!;
  return planned.some((entry) => {
    if (fileTypeOf(entry) !== "code") return false;
    const plannedParts = entry.split("/");
    if ((plannedParts.at(-1) ?? "").replace(/\.[A-Za-z0-9]+$/u, "") !== stem) return false;
    const plannedFolder = plannedParts.slice(0, -1);
    if (plannedFolder.join("/") === folder.join("/")) return true;
    const at = folder.findIndex((part) => TEST_FOLDERS.has(part));
    if (at < 0) return false;
    const root = folder.slice(0, at);
    let rest = folder.slice(at + 1);
    if (rest.length > 0 && TEST_BUCKETS.has(rest[0]!)) rest = rest.slice(1);
    // The same package: the tests folder sits where the planned file's package starts.
    if (root.some((part, index) => plannedFolder[index] !== part)) return false;
    let remainder = plannedFolder.slice(root.length);
    if (remainder.length > 0 && SOURCE_FOLDERS.has(remainder[0]!) && rest[0] !== remainder[0]) remainder = remainder.slice(1);
    return rest.join("/") === remainder.join("/");
  });
}

/** How many times a review that could not run is run on one head before only Retry or a new push runs it again, and the wait before the second run (doubling after it). */
const REVIEW_RUNS_MAX = 3;
const REVIEW_RERUN_WAIT_MS = 10 * 60_000;

/** The runs an outage entry counts (an entry from before the count was kept is one run). */
function runsOf(check: FlowQuickCheck): number {
  const found = /\bruns=(\d+)/u.exec(check.detail ?? "");
  return found === null ? 1 : Number(found[1]);
}
