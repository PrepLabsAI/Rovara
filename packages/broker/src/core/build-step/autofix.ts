// Lane L10, the build step: what Rovara does by itself when checks or reviews block (Cloud's `workflow-autofix-runner.ts`, the policy in `@agentx/contracts` `workflow-autofix.ts`).
//
// The owner's rule (2026-10-23, failure handling): a code fault is sent back to the coding agent by Rovara at most twice per approved plan, then it asks; a one-off hiccup of the checks or
// the reviews is retried once; an unclear fault, a person's job or a reached limit is asked about, with what failed. It never approves, skips, publishes, picks optional checks or acts in a plan
// review or a pull request: the only moves are the two below (and an ask), each of which holds the policy's limits again itself.
//
// What Code does not have, and so what the facts leave out: the original-code (baseline) round (an unclear check fault is asked about rather than waited on; the plan's dry run of its proposed checks on the unchanged code tells the code's fault from the rest when it was recorded),
// the browser and API checks, and Cloud's day budgets (the room is always "yes").
//
// Decision 70(c): after a merge of the base into an open pull request (the block `baseMergedRecheck`, an AUTOFIX row with cause `base-merged`) the checks re-run by themselves, once per candidate and
// three times per task per day, only where Rovara may act (the autonomy is read again; `suggest` asks), the pull request still holds the merged head, and the company's allowance of such starts per
// ten minutes (an `Admission` decision, never a counter of the core's own) has room; otherwise the owner is asked or the row waits and is looked at again.
import {
  AUTO_FIX_DEFAULT_CAP_USD, AgentXError, BASE_MERGED_NEEDS_YOU_MILESTONE, BASE_MERGED_RETRY_REASON, WorkflowTransitionError, agentXError, autoFixDecision, change, returnWorkflowToImplementationAutomatically, wholeTaskSpendUsd, when, workflowAutomaticRetryDecision,
  type AutoFixAskReason, type AutoFixCode, type AutoFixDecision, type AutoFixFacts, type OriginalCodeResult, type WorkflowAutoSpend, type WorkflowSnapshot,
} from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import { loadPlanSelfCheck } from "../../developer/plan-self-check.js";
import { textReaderOf } from "./plan-input.js";
import { AutoFixAskSchema, autoFixRetryReason, autoFixSendBackReason } from "../../developer/autofix-messages.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem, rescheduleRowItem, resolveRowItem } from "../task-flow/dispatch-rows.js";
import { dispatchRowKey, taskKey } from "../task-flow/keys.js";
import { fromDocument, type DispatchRowRecord, type TaskRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { commitWorkflow, runDispatchRow, type StepStart } from "../task-flow/stage-machine.js";
import { iso, log } from "../task-flow/support.js";
import { toDocument } from "../task-flow/records.js";
import { startChecksRerun, startReview } from "./start.js";

/** One more automatic round: a coding run, the checks and two reviews. A deliberately high figure; the cap is checked against spend plus this. */
export const AUTOFIX_ROUND_ESTIMATE_USD = 3;

/** The action name of the request to `Admission` for one of the company's re-runs after a merge of the base in a ten-minute window (Cloud's adapter holds five; the core asks and keeps no counter of its own). */
export const BASE_MERGED_ADMISSION_ACTION = "autofix.base-merged";

/** `DEFERRED`: the company's allowance of re-runs after a merge of the base is used for now; the row waits (with jitter) and is looked at again. */
export type AutofixOutcome = "DISABLED" | "STALE" | "NONE" | "SENT_BACK" | "RETRIED" | "DUPLICATE" | "ASKED" | "DEFERRED";

/**
 * Decision 70(c): whether ANY open pull request of the task no longer holds the head Rovara recorded for it (a person pushed since the merge). Every open pull request is looked at, not just the first; a head
 * that cannot be read throws, and the caller asks instead of starting. A pull request recorded without a head is not judged.
 */
export async function openPullRequestHeadMoved(workflow: { pullRequests?: WorkflowSnapshot["pullRequests"] | undefined } | undefined, readHead: (pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number]) => Promise<string>): Promise<boolean> {
  for (const pullRequest of workflow?.pullRequests ?? []) {
    if ((pullRequest.state !== "OPEN" && pullRequest.state !== "UNKNOWN") || pullRequest.headSha === undefined) continue;
    if (await readHead(pullRequest) !== pullRequest.headSha) return true;
  }
  return false;
}

/** The head the code host shows for a pull request of the task (throws when it cannot be read: a head that cannot be read is not "not moved"). */
async function hostHeadOf(deps: TaskFlowDeps, task: TaskRecord, pullRequest: NonNullable<WorkflowSnapshot["pullRequests"]>[number]): Promise<string> {
  const project = await deps.projects.revision(task.project, task.startingRevision);
  const definition = project?.definition.repositories.find((entry) => entry.name === pullRequest.repositoryId);
  if (definition === undefined || deps.codeHosts === undefined) throw agentXError("CONFIG_INVALID", "the pull request's repository is not in the task's project");
  const host = codeHostForRecord(deps.codeHosts, definition);
  return (await host.getChangeRequest({ repository: { url: definition.url }, id: String(pullRequest.number), url: pullRequest.url }, { orgId: deps.companyId })).headRevision;
}

/** The milestone line "needs you", written when Rovara asks instead of re-running a merged base's checks (best effort: the ask itself is already stored). */
async function needsYou(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot): Promise<void> {
  const pullRequest = workflow.pullRequests?.find((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN");
  if (deps.milestones === undefined || pullRequest === undefined) return;
  try {
    const items = deps.milestones.items({
      kind: "stuck", orgId: deps.companyId, taskId: task.taskId, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }), at: iso(deps), text: BASE_MERGED_NEEDS_YOU_MILESTONE.slice(0, 500),
      pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }],
    }, workflow.revision);
    await deps.store.transact([...items]);
  } catch (error) {
    log(deps, { event: "autofix.needs_you_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}

async function writeAsk(deps: TaskFlowDeps, taskId: string, revision: number, reason: AutoFixAskReason, codes: readonly AutoFixCode[], at: string): Promise<boolean> {
  const ask = AutoFixAskSchema.parse({ workflowRevision: revision, reason, codes: [...codes].slice(0, 30), at });
  // Only while the task is still blocked at the revision the fixing looked at: the owner may have acted first, and then there is nothing left to ask about.
  const written = await deps.store.update({
    key: taskKey(taskId), ops: [change.set("autofixAsk", toDocument(ask))],
    condition: when.and(when.eq(["workflow", "revision"], revision), when.eq(["workflow", "state"], "BLOCKED"), when.notExists("closedAt")),
  });
  return written.applied;
}

/** What a proposed check did on the original code, from the dry run recorded beside the approved plan. Empty when none was recorded (or the record cannot be trusted). */
async function proposedCheckOriginals(deps: TaskFlowDeps, workflow: WorkflowSnapshot): Promise<Record<string, OriginalCodeResult>> {
  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined || deps.artifacts === undefined) return {};
  const read = textReaderOf(deps.artifacts);
  const view = await loadPlanSelfCheck((key) => read(key, 70_000), plan);
  return Object.fromEntries(Object.entries(view.tried).map(([checkId, result]) => [checkId, result === "passed" ? "passed" as const : result === "failed" ? "failed" as const : "cannot-run" as const]));
}

/** Looks at one blocked VERIFY or REVIEW once, and acts or asks. Never throws for a task that moved on. */
export async function runAutofix(deps: TaskFlowDeps, row: { taskId: string; workflowRevision: number }): Promise<StepStart> {
  const done = async (result: AutofixOutcome): Promise<StepStart> => {
    // The row goes whatever was decided, unless the move itself already took it (a send back or a retry resolves it in its own transaction).
    await deps.store.transact([resolveRowItem(deps, row.taskId, row.workflowRevision)]).catch(() => undefined);
    log(deps, { event: "autofix.decided", taskId: row.taskId, revision: row.workflowRevision, outcome: result });
    return result === "STALE" ? "STALE" : "STARTED";
  };
  const config = deps.autofix ?? {};
  if (config.enabled === false) return done("DISABLED");
  const task = await readTask(deps, row.taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== row.workflowRevision || workflow.state !== "BLOCKED" || (workflow.stage !== "VERIFY" && workflow.stage !== "REVIEW")) return done("STALE");
  const stage: "VERIFY" | "REVIEW" = workflow.stage;
  // The whole task's spend, when it can be told; nothing priced counts as nothing spent, and the count limits alone then bound the rounds.
  let spent: number | undefined;
  try { spent = deps.taskSpendUsd === undefined ? 0 : (await deps.taskSpendUsd(task.taskId)) ?? 0; } catch { spent = undefined; }
  const spend: WorkflowAutoSpend = { spentUsd: wholeTaskSpendUsd(spent ?? Number.NaN), roundEstimateUsd: config.roundEstimateUsd ?? AUTOFIX_ROUND_ESTIMATE_USD, capUsd: config.capUsd ?? AUTO_FIX_DEFAULT_CAP_USD };
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  // How the block came about when no finished run wrote it (the row says so): a lost run is the infrastructure's, one automatic retry, never a send back to coding; a merged base is rechecked at once.
  const row_ = fromDocument<DispatchRowRecord>(await deps.store.get(dispatchRowKey(deps.companyId, row.taskId, row.workflowRevision)));
  const cause = row_?.cause;
  const facts: AutoFixFacts = cause === undefined ? {} : { blockCause: cause };
  let first = autoFixDecision(workflow, facts, { enabled: true, spend, dayBudgetHasRoom: true, baselineRequests: 1, nowMs });
  // An unclear check fault is told from the code's own by what the plan's dry run found: a proposed check that already failed (or could not run) on the unchanged code is not the change's fault. The dry run is
  // recorded beside the plan the owner approved (Cloud's `proposedCheckOriginals`); a task without one leaves the fault unclear.
  if (first.action !== "NONE" && first.codes.includes("check-failed-cause-unknown")) {
    const originals = await proposedCheckOriginals(deps, workflow);
    if (Object.keys(originals).length > 0) {
      facts.checkOriginal = originals;
      first = autoFixDecision(workflow, facts, { enabled: true, spend, dayBudgetHasRoom: true, baselineRequests: 1, nowMs });
    }
  }
  // There is no original-code round in Code, so an unclear fault is the owner's to settle.
  const decision: AutoFixDecision = first.action === "WAIT_FOR_BASELINE" || first.action === "REQUEST_BASELINE" ? { action: "ASK", reason: "unclear-fault", codes: first.codes } : first;
  const at = iso(deps);
  const ask = async (reason: AutoFixAskReason, codes: readonly AutoFixCode[]): Promise<StepStart> => {
    const written = await writeAsk(deps, task.taskId, workflow.revision, reason, codes, at);
    // Decision 70(c): a merged base's checks Rovara does not re-run by itself wait for the owner: the milestone feed says so (it said "re-checking" when the row was written, never "needs you" while Rovara acts).
    if (written && cause === "base-merged") await needsYou(deps, task, workflow);
    return done("ASKED");
  };
  /** A guard in the system move refused although the policy allowed it (a limit read differently, a stale revision): nobody else will look, so the owner is asked. */
  const guardRefused = async (askCodes: readonly AutoFixCode[]): Promise<StepStart> => {
    const fresh = await readTask(deps, task.taskId);
    if (fresh?.workflow?.revision !== workflow.revision || fresh.workflow.state !== "BLOCKED") return done("STALE");
    return ask("needs-a-person", askCodes);
  };
  try {
    // Decision 70(c): a merged base's checks are re-run by Rovara itself only where it may act: the autonomy is read again here, and `suggest` (or a setting that cannot be read, or no company) asks the owner
    // instead, with the sentence that is true. A person who pushed since the merge ends the re-run too: the checks would be of code the pull request no longer holds.
    if (cause === "base-merged") {
      const found: Awaited<ReturnType<NonNullable<TaskFlowDeps["autonomy"]>>> = await deps.autonomy?.(task).catch(() => ({ autonomy: "suggest" as const, unreadable: true as const })) ?? { autonomy: "suggest" as const };
      if (found.autonomy === "suggest") return await ask(found.noCompany === true ? "autonomy-no-company" : found.unreadable === true ? "autonomy-unreadable" : "autonomy-suggest", ["base-merged"]);
      // A head that cannot be read is not "not moved": the owner is asked at once, not left to the sweep's retries.
      let headMoved: boolean;
      try { headMoved = await openPullRequestHeadMoved(workflow, (pullRequest) => hostHeadOf(deps, task, pullRequest)); } catch { return await guardRefused(["base-merged"]); }
      if (headMoved) return await ask("head-moved", ["base-merged"]);
    }
    switch (decision.action) {
      case "NONE": return await done("NONE");
      case "ASK": return await ask(decision.reason, decision.codes);
      case "SEND_BACK": {
        const next = returnWorkflowToImplementationAutomatically(workflow, { expectedRevision: workflow.revision, reason: autoFixSendBackReason(decision.codes), spend, now: at });
        // The send back and the coding that follows it are one commit; the row of the block goes with it.
        const committed = await commitWorkflow(deps, task, next, [resolveRowItem(deps, task.taskId, workflow.revision), dispatchRowItem(deps, task.taskId, next.revision, "IMPLEMENT", at)]);
        if (!committed) return await done("STALE");
        await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "IMPLEMENT" }).catch((error: unknown) => log(deps, { event: "autofix.start_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
        log(deps, { event: "autofix.decided", taskId: task.taskId, revision: row.workflowRevision, outcome: "SENT_BACK", codes: decision.codes });
        return "STARTED";
      }
      case "RETRY": {
        // A re-run after a merge of the base starts only inside the company's allowance for these ten minutes (admission's answer); the rest wait, with jitter, instead of starting together.
        if (cause === "base-merged" && row_ !== undefined) {
          const admitted = await baseMergedStartAdmitted(deps, task, workflow, nowMs, row_);
          if (admitted === "deferred") return "STARTED";
          if (admitted === "ask") return await ask("needs-a-person", ["base-merged"]);
        }
        const automaticDecision = workflowAutomaticRetryDecision(workflow, {
          expectedRevision: workflow.revision, stage: decision.stage, reason: cause === "base-merged" ? BASE_MERGED_RETRY_REASON : autoFixRetryReason(decision.stage, decision.codes), spend, now: at,
        });
        const ref = { taskId: task.taskId, workflowRevision: workflow.revision };
        const started = decision.stage === "VERIFY"
          ? await startChecksRerun(deps, ref, { requestId: `autofix-${task.taskId}-${String(workflow.revision)}`, actorId: automaticDecision.actorId, automaticDecision })
          : await startReview(deps, ref, { retry: true, automaticDecision });
        log(deps, { event: "autofix.decided", taskId: task.taskId, revision: row.workflowRevision, outcome: "RETRIED", result: started, codes: decision.codes, stage });
        return started === "STALE" ? "STALE" : "STARTED";
      }
    }
  } catch (error) {
    // A guard of the engine refused although the policy allowed it, or a refusal the same call would repeat (CONFIG_INVALID: no check selected to run, a setting that does not hold): the owner is asked at once,
    // not left to the sweep's retries every minute.
    if (!(error instanceof WorkflowTransitionError) && !(error instanceof AgentXError && error.code === "CONFIG_INVALID")) throw error;
    return guardRefused(first.action === "NONE" ? [] : first.codes);
  }
}

/** One minute plus up to two (so a herd of merged bases spreads out): how long a row waits when the company's allowance of re-runs is used. */
const deferralMs = (): number => 60_000 + Math.floor(Math.random() * 120_000);
/** The refusal that means "the allowance is used for now" (an adapter's rate limit): the only refusal that makes a re-run wait. Any other (a budget, a trial, a block) asks the owner at once. */
export const BASE_MERGED_ALLOWANCE_USED_CODE = "rate_limited";
/** A row that has waited this long for the company's allowance asks the owner instead of waiting on (the hosts are read at every look). */
export const BASE_MERGED_DEFERRAL_MAX_MS = 3_600_000;

/**
 * Decision 70(c), the fleet guard: asks `Admission` for one of the company's re-runs after a merge of the base. `start`: granted (kept on the row, so a start that did not finish does not take a second allowance).
 * `deferred`: the rate-limit refusal; the row waits (a minute plus up to two, or what the adapter named) with no attempt counted. `ask`: any other refusal, or a wait that went past an hour: the owner is asked.
 * The first request is keyed by task and candidate; Admission answers one key one way, so after a deferral the key carries the ten-minute window, or a refusal would stay a refusal. The per-task cap (the
 * spend read before each start) is the money backstop.
 */
async function baseMergedStartAdmitted(deps: TaskFlowDeps, task: TaskRecord, workflow: WorkflowSnapshot, nowMs: number, row: DispatchRowRecord): Promise<"start" | "deferred" | "ask"> {
  if (row.admittedAt !== undefined) return "start";
  const waitedMs = row.deferredSince === undefined ? 0 : nowMs - Date.parse(row.deferredSince);
  if (waitedMs > BASE_MERGED_DEFERRAL_MAX_MS) return "ask";
  const base = `${BASE_MERGED_ADMISSION_ACTION}:${task.taskId}:${workflow.candidate?.digest ?? "none"}`;
  const decision = await deps.admission.admit({
    companyId: deps.companyId, idempotencyKey: row.deferredSince === undefined ? base : `${base}:${String(Math.floor(nowMs / 600_000))}`, action: BASE_MERGED_ADMISSION_ACTION, projectName: task.project, subject: { type: "task", id: task.taskId },
  });
  const key = { pk: row.pk, sk: row.sk };
  if (decision.allowed) {
    await deps.store.update({ key, ops: [change.set("admittedAt", new Date(nowMs).toISOString())], condition: when.present() })
      .catch((error: unknown) => log(deps, { event: "autofix.admitted_mark_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
    return "start";
  }
  if (decision.code.toLowerCase() !== BASE_MERGED_ALLOWANCE_USED_CODE) {
    log(deps, { event: "autofix.decided", taskId: task.taskId, revision: workflow.revision, outcome: "ASK", reason: "admission-refused", code: decision.code });
    return "ask";
  }
  const delayMs = decision.retryAfterSeconds === undefined ? deferralMs() : Math.min(Math.max(decision.retryAfterSeconds, 30), 3_600) * 1_000;
  const next = new Date(nowMs + delayMs).toISOString();
  const moved = rescheduleRowItem(row, next, row.attempts);
  if (moved.kind !== "update") return "deferred";
  await deps.store.transact([{ ...moved, ops: [...moved.ops, change.set("deferredSince", row.deferredSince ?? new Date(nowMs).toISOString())] }])
    .catch((error: unknown) => log(deps, { event: "autofix.defer_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  log(deps, { event: "autofix.decided", taskId: task.taskId, revision: workflow.revision, outcome: "DEFERRED", reason: "company-allowance" });
  return "deferred";
}
