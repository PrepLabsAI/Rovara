// S1: the task action registry's entries, one plain exported array (4.2). An entry says who may take the action (a named rule), when it is offered (pure over the stored task and the host's capability), what it asks of the person
// (its form and confirm), and how it is performed (ONE call into the function the web already uses). There is no registration function and no hook; the feature interface of F4 later adds a feature's entries to this list.
// The held entries (people add and role) are declared here so every surface lists them as excluded with their reason (`TASK_ACTION_NOTES`).
import { ACTION_WORDS, stepRetryLabel, type TaskActionId, type TaskActionRisk } from "@agentx/contracts";
import type { TaskRecord } from "../task-flow/records.js";
import { closeRisk, closeWhen, describeClose, performClose } from "./effects/close.js";
import { describeFix, feedbackChoiceWhen, feedbackRetryWhen, performAnswer as performFeedbackAnswer, performDismiss, performFix, performRetryReview, describeAnswer as describeFeedbackAnswer } from "./effects/feedback.js";
import { describeFindings, findingsRisk, findingsWhen, performFindings } from "./effects/findings.js";
import { answerWhen, describeAnswer, describeMerge, describeTakeOwnership, heldWhen, mergeRisk, mergeWhen, peopleViewWhen, performAnswer, performHeld, performMerge, performPeopleView, performTakeOwnership, takeOwnershipWhen } from "./effects/more.js";
import {
  checkChoiceOf, continueWhen, describeContinue, describePullRequest, describeReview, describeSendBack, describeStepRetry, keepWhen, openPullRequestWhen, performContinue, performKeep, performPullRequest, performReview, performSendBack, performStepRetry, performStop,
  retryKindOf, reviewWhen, sendBackWhen, stepRetryWhen, stopWhen,
} from "./effects/moves.js";
import { describeApprove, describeReject, describeRequestChanges, performApprove, performReject, performRequestChanges, planApproveRisk, planWhen } from "./effects/plan.js";
import type { TaskActionEntry } from "./types.js";

const routine = (): TaskActionRisk => "routine";
const money = (): TaskActionRisk => "money";
const wordsOf = (id: TaskActionId) => (): string => ACTION_WORDS[id].label;
const retryLabel = (task: TaskRecord): string => (task.workflow === undefined || retryKindOf(task.workflow) === "publish" ? stepRetryLabel("PULL_REQUEST") : stepRetryLabel(task.workflow.stage));

export const TASK_ACTION_ENTRIES: readonly TaskActionEntry[] = [
  { id: "plan.approve", who: "owner", risk: planApproveRisk, dialog: () => false, label: wordsOf("plan.approve"), when: (env, task, caller) => planWhen(env, task, caller), describe: (env, caller, task) => describeApprove(env, caller, task), perform: performApprove },
  { id: "plan.request-changes", who: "owner", risk: routine, label: wordsOf("plan.request-changes"), when: (env, task, caller) => planWhen(env, task, caller), describe: describeRequestChanges, perform: performRequestChanges },
  { id: "plan.reject", who: "owner", risk: routine, label: wordsOf("plan.reject"), when: (env, task, caller) => planWhen(env, task, caller), describe: describeReject, perform: performReject },
  { id: "step.retry", who: "owner", risk: money, label: retryLabel, dialog: (task) => task.workflow !== undefined && retryKindOf(task.workflow) === "checks" && checkChoiceOf(task.workflow) !== undefined, when: (_env, task) => stepRetryWhen(task), describe: (env, _caller, task) => describeStepRetry(env, task), perform: performStepRetry },
  { id: "task.review", who: "owner", risk: money, label: () => stepRetryLabel("REVIEW"), dialog: () => false, when: (_env, task) => reviewWhen(task), describe: describeReview, perform: performReview },
  { id: "work.send-back", who: "owner", risk: money, label: wordsOf("work.send-back"), when: (_env, task) => sendBackWhen(task), describe: describeSendBack, perform: performSendBack },
  { id: "findings.resolve", who: "owner", risk: findingsRisk, label: wordsOf("findings.resolve"), when: (_env, task) => findingsWhen(task), describe: describeFindings, perform: performFindings },
  { id: "feedback.fix", who: "owner", risk: money, label: wordsOf("feedback.fix"), when: (_env, task) => feedbackChoiceWhen(task), describe: describeFix, perform: performFix },
  { id: "feedback.dismiss", who: "owner", risk: routine, label: wordsOf("feedback.dismiss"), when: (_env, task) => feedbackChoiceWhen(task), perform: performDismiss },
  { id: "feedback.answer", who: "owner", risk: money, label: wordsOf("feedback.answer"), when: (_env, task) => feedbackChoiceWhen(task), describe: describeFeedbackAnswer, perform: performFeedbackAnswer },
  { id: "feedback.retry-review", who: "owner", risk: money, label: wordsOf("feedback.retry-review"), when: (_env, task) => feedbackRetryWhen(task), perform: performRetryReview },
  { id: "pull-request.keep", who: "owner", risk: routine, label: wordsOf("pull-request.keep"), when: (_env, task) => keepWhen(task), perform: performKeep },
  { id: "task.close", who: "owner", risk: closeRisk, label: wordsOf("task.close"), when: (_env, task) => closeWhen(task), describe: describeClose, perform: performClose },
  { id: "task.stop", who: "owner-or-admin", risk: routine, label: wordsOf("task.stop"), when: (_env, task) => stopWhen(task), perform: performStop },
  { id: "task.merge", who: "merge", risk: mergeRisk, label: wordsOf("task.merge"), when: (env, task) => mergeWhen(env, task), describe: describeMerge, perform: performMerge },
  { id: "task.continue", who: "owner", risk: money, label: wordsOf("task.continue"), when: (_env, task) => continueWhen(task), describe: describeContinue, perform: performContinue },
  { id: "pull-request.open", who: "owner", risk: money, label: wordsOf("pull-request.open"), when: (_env, task) => openPullRequestWhen(task), describe: (env, _caller, task) => describePullRequest(env, task), perform: performPullRequest },
  { id: "task.answer", who: "owner", risk: money, label: wordsOf("task.answer"), when: (_env, task) => answerWhen(task), describe: describeAnswer, perform: performAnswer },
  { id: "people.view", who: "readers", risk: routine, label: wordsOf("people.view"), when: (env, task) => (env.people === undefined ? undefined : peopleViewWhen(task)), perform: performPeopleView },
  { id: "people.take-ownership", who: "take-over", risk: routine, label: wordsOf("people.take-ownership"), when: (env, task, caller) => takeOwnershipWhen(env, task, caller), describe: describeTakeOwnership, perform: performTakeOwnership },
  // Held for the second cut: declared, never offered (a surface lists them as excluded, with their reason).
  { id: "people.add", who: "held", risk: () => "high", label: wordsOf("people.add"), when: heldWhen, perform: performHeld },
  { id: "people.set-role", who: "held", risk: () => "high", label: wordsOf("people.set-role"), when: heldWhen, perform: performHeld },
];

const BY_ID = new Map(TASK_ACTION_ENTRIES.map((entry) => [entry.id, entry]));
export const entryOf = (id: TaskActionId): TaskActionEntry | undefined => BY_ID.get(id);
