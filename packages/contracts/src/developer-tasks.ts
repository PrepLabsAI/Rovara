import { z } from "zod";
import { TaskStatusSchema } from "./task-status.js";
import {ModelFallbacksSchema} from "./stage-model-shared.js";
import { DeveloperShareModeSchema } from "./project.js";
import { AGENT_RUN_STATES, AGENT_RUN_STEP_STATUSES, AgentStepToolsSchema } from "./agent-run.js";
import { StepIdSchema } from "./agent-recipe.js";
import { ApprovalIdSchema, AgentIdSchema, SpendRequestIdSchema } from "./agent.js";
import { WorkflowSnapshotViewSchema, WORKFLOW_PLAN_MAX_BYTES, WorkflowSnapshotReaderShape, type WorkflowSnapshotReader } from "./task-workflow.js";
import { E2ESharedViewSchema } from "./e2e-view.js";
import { RunEstimateSchema } from "./run-estimate.js";
import { SessionIdSchema } from "./agent-sessions.js";
import { TestingViewSchema } from "./verification-result.js";
import { EvidenceViewReadSchema } from "./evidence.js";
import { PlanOneScreenSchema } from "./plan-one-screen.js";
import { MergeTrackingItemSchema, MergeViewSchema, ProofTableViewSchema, VerificationReportSchema } from "./rovara-code.js";
import { readsAsUnknown } from "./forward-reader-unknown.js";
import { ErrorRefSchema } from "./live-interaction.js";
import { EarlyRiskSignalReadSchema } from "./early-risk-signal.js";
import { DesignActionsViewSchema } from "./design-review-words.js";

export const DEVELOPER_TASK_SUMMARY_MAX = 4_000;

export const DEVELOPER_FAILURE_MESSAGE_MAX = 1_000;

export const DEVELOPER_EVENT_TEXT_MAX = 300;

export const DEVELOPER_EVENTS_MAX = 50;

export const CHANNEL_TURNS_MAX = 20;

export const CHANNEL_TURN_REQUEST_MAX = 300;

export const DeveloperTaskShareSchema = z.object({
  mode: DeveloperShareModeSchema,
  channelId: z.string(),
  /** A public channel's name only (R10). */
  channelName: z.string().optional(),
  sharedReason: z.enum(["requested", "required"]),
  modeReason: z.literal("continue_not_allowed").optional(),
  /** Absent while the notifier has not posted the start message yet (C6). */
  threadUrl: z.string().url().optional(),
  /** The start message could not be posted within an hour (C9). */
  postFailed: z.boolean().optional(),
});

/** C15: one Slack turn a teammate ran on the task in its shared thread. */
export const ChannelTurnSchema = z.object({
  author: z.object({ slackUserId: z.string(), name: z.string().optional() }),
  at: z.string().datetime(),
  request: z.string().max(CHANNEL_TURN_REQUEST_MAX),
  outcome: z.string(),
});

export const DeveloperTaskStatusSchema = z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "CLOSED"]);

export const DeveloperTaskFailureCategorySchema = z.enum(["setup_failed", "worker_unavailable", "task_failed", "timed_out", "interrupted", "publication_failed", "budget_exhausted"]);

/** #154: where a failure happened. "setup" means the workspace was never set up, so the task
 * cannot be continued. Optional (a control plane that predates it sends none), and a stage this
 * release does not know is dropped rather than refusing the view. */
export const DeveloperTaskFailureStageSchema = z.enum(["setup"]);

export const DeveloperTaskFailureSchema = z.object({
  category: DeveloperTaskFailureCategorySchema,
  stage: DeveloperTaskFailureStageSchema.optional().catch(undefined),
  message: z.string().max(DEVELOPER_FAILURE_MESSAGE_MAX),
});

export const DeveloperTaskEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["status", "progress", "tool", "message", "error"]),
  text: z.string().max(DEVELOPER_EVENT_TEXT_MAX),
});

export const PullRequestSummarySchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
});

/**
 * Plan 3, Task 22: where an agent-step run is. `currentStep` is the step the run is at (the one that runs or waits); a step's `report` is its
 * latest one; `pendingApprovals` are the actions and approval steps waiting for a person, each with the page where it is decided; `finalReport` is
 * the last step's report once the run is COMPLETE, `branch` the result the worker chose, `endReason` why a FAILED or CANCELLED run ended ("Unverified, needs a person: ..." when the report was not backed by the agent's tool calls; the report is then the `finalReport`).
 */
export const DeveloperTaskRunViewSchema = z.object({
  state: z.enum(AGENT_RUN_STATES),
  currentStep: z.object({ id: StepIdSchema, name: z.string() }).strict().optional(),
  // A step is read tolerantly (an unknown field is dropped, not refused): the broker may show a client more about a step than this build knows, and `tools` and `unverified` are optional.
  steps: z.array(z.object({
    id: StepIdSchema, name: z.string(), status: z.enum(AGENT_RUN_STEP_STATUSES), report: z.string().optional(),
    /** The tool calls the step made and the ones that failed (shown when one failed or the report was unverified). */
    tools: AgentStepToolsSchema.optional(),
    /** Why the step's report was not backed by what the agent did: the run ended FAILED with these words, "Unverified, needs a person". */
    unverified: z.array(z.string().max(300)).max(10).optional(),
  })),
  pendingApprovals: z.array(z.object({ approvalId: ApprovalIdSchema, kind: z.enum(["write", "step"]), text: z.string(), confirmUrl: z.string().optional() }).strict()),
  finalReport: z.string().optional(),
  branch: z.string().optional(),
  endReason: z.string().optional(),
}).strict();

export const DeveloperTaskViewSchema = z.object({
  /** Actual audited fallback history; absent only on older servers. Current broker emits [] when none. */
  modelFallbacks:ModelFallbacksSchema.optional(),
  taskId: z.string().uuid(),
  title: z.string(),
  project: z.string(),
  status: DeveloperTaskStatusSchema,
  /** UX2 slice 2: where the task stands in the one status model (state, reason, next step), the words every surface shows instead of `status`. Absent from older servers. */
  statusView: TaskStatusSchema.optional(),
  /**
   * UX2 slice 2 item 3: a blocked task's review findings and the two ways on that the task page offers (Resolve findings, Send back to coding), as Slack and the MCP tools offer them. The findings are the
   * blocking ones of the current code not yet accepted (reviewer words, redacted and capped; plain text every reader escapes). The routes re-check who may. Absent unless the task is blocked with one to offer.
   */
  reviewFindings: z.object({
    findings: z.array(z.object({ findingId: z.string().regex(/^[a-f0-9]{64}$/), role: z.enum(["CRITIC", "SECURITY"]), text: z.string().min(1).max(1000), file: z.string().max(500).optional(), line: z.number().int().positive().optional() }).strict()).max(50),
    resolve: z.boolean(),
    sendBack: z.boolean(),
  }).strict().optional(),
  workflow: WorkflowSnapshotViewSchema.extend({
    planContent: z.string().max(WORKFLOW_PLAN_MAX_BYTES).optional(),
    workBreakdownDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
  e2ePresentation: z.object({ shared: E2ESharedViewSchema, slackBlocks: z.array(z.unknown()).max(16), pageHtml: z.string().max(65_536), mcp: z.object({ scope: z.string().max(2_000), view: E2ESharedViewSchema }).strict() }).strict().optional(),
  failure: DeveloperTaskFailureSchema.optional(),
  /** Live interaction F1: what the "Fix with agent" button is about, when the task shows an error (a blocked step or a failed run). Fixed codes and ids only, never text; absent when there is no error to fix. */
  errorRef: ErrorRefSchema.optional(),
  /** Ruling R60: set when the task's creator was removed from the org; the task has ended (status CANCELLED) and `outcomeReason` says why. */
  outcome: z.literal("creator_removed").optional(),
  outcomeReason: z.string().max(1000).optional(),
  startingRevision: z.number().int().positive(),
  client: z.string(),
  shared: z.boolean(),
  closing: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  events: z.array(DeveloperTaskEventSchema).max(DEVELOPER_EVENTS_MAX),
  summary: z.string().max(DEVELOPER_TASK_SUMMARY_MAX).optional(),
  changedFiles: z.array(z.object({ repository: z.string(), path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).optional(),
  artifacts: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative().optional() })).optional(),
  pullRequests: z.array(PullRequestSummarySchema).optional(),
  /** R22: what the latest close preflight found, when it refused to close. */
  unpublished: z.array(z.object({ repository: z.string(), reasons: z.array(z.string()) })).optional(),
  /** C1: how the task is shared; absent for a private task. */
  share: DeveloperTaskShareSchema.optional(),
  /** C15: the shared thread's channel turns on this task, newest first. */
  channelTurns: z.array(ChannelTurnSchema).max(CHANNEL_TURNS_MAX).optional(),
  /** Plan 3, Task 15: the agent and version the task runs; absent on a task from before agents. */
  agent: z.object({ agentId: AgentIdSchema, name: z.string(), version: z.union([z.number().int().min(1), z.literal("draft")]), builtin: z.boolean() }).strict().optional(),
  /** Plan 3, Task 22: an agent-step run's progress; absent on every other task. */
  run: DeveloperTaskRunViewSchema.optional(),
  /** Plan 3, Task 32: the task is waiting for money: the limit it reached (`PauseScope`) and, when one was made, the request that asks for more. */
  paused: z.object({ reason: z.literal("budget"), spendRequestId: SpendRequestIdSchema.optional(), scope: z.record(z.string(), z.string()), message: z.string().max(300).optional() }).strict().optional(),
  /** Plan 3, Task 32: what a planning run found before it reached its limit (its last answer), at most 4,096 characters. */
  planningSoFar: z.string().max(4096).optional(),
  /** Plan 3, Task 32: a test run that reached its cap may go on as a normal task (`POST /v1/app/tasks/{id}/continue-as-task`). */
  testOffer: z.object({ capUsd: z.number().nonnegative() }).strict().optional(),
  /** Plan 3, Task 34: what the coding plan under review is expected to cost and the run limit approving it accepts. */
  runEstimate: RunEstimateSchema.optional(),
  /**
   * 0.5.11 (QA6-12b): while the coding plan waits for approval, what approving does to the run limit: the limit now, the one approving sets and whether that raises it. A raise is approved only with `proposedUsd`
   * acknowledged (the tool's `acknowledged_run_limit_usd`, the API's `acknowledgedRunLimitUsd`). Absent unless the coding plan waits and the task carries an estimate.
   */
  planRunLimit: z.object({ currentUsd: z.number().nonnegative(), proposedUsd: z.number().nonnegative(), raises: z.boolean() }).strict().optional(),
  /** Plan 5, Task 2: the task's session and its link (`<origin>/s/<sessionId>`); absent on a task with no session (before sessions, a chain step, an install without agents). */
  sessionId: SessionIdSchema.optional(),
  sessionUrl: z.string().url().optional(),
  /**
   * Setup and test health (SH28, switch `nh`): present on a task start and a task read ONLY while the project's setup needs repair. The task still starts and runs; this says its testing may be blocked.
   * Fixed words from the broker. Absent with the switch off, and for every project that is not in that state.
   */
  testingNotice: z.object({ state: z.literal("needs_repair"), text: z.string().min(1).max(200) }).strict().optional(),
  /**
   * Plan 3, Task 35b: a plan blocked on its run limit: the limit it waits for, the request that asks for it while one is open, and whether its owner may ask
   * again (`POST /v1/app/tasks/{id}/run-limit-request`, once the last request was denied or ran out, not while its start is pending, and at most once per ten
   * minutes: `askAgainAfter` is when). Absent unless the plan is blocked on its run limit.
   */
  runLimit: z.object({ limitUsd: z.number().nonnegative(), spendRequestId: SpendRequestIdSchema.optional(), canAskAgain: z.boolean(), askAgainAfter: z.string().max(40).optional() }).strict().optional(),
  /**
   * Plan 6, Task 12 (Rovara Code version 2 only; the broker leaves it out of a version 1 task's view, and out of a client that does not send `x-agentx-task-view: 2`):
   * what passed, what failed, what could not be checked and which tests the change added, for the code the checks ran on. Worker output, redacted and bounded; plain
   * text that every reader escapes for its own markup.
   */
  verificationReport: VerificationReportSchema.optional(),
  /** Playbook P3 (version 2 only, full reads only, like `verificationReport`): the proof table of the approved plan's requirements, as the pull request's Proof section has it. Absent when there is no approved plan with claims. */
  proofTable: ProofTableViewSchema.optional(),
  /** Proof and evidence P1 (version 2 only, full reads only, like `proofTable`): the evidence of the code now on the task, with every artifact as a link behind sign-in. Absent until the broker has built one for the current candidate. */
  evidence: EvidenceViewReadSchema.optional(),
  /** Setup and test health SH19 (version 2 only, full reads only, only while the four-results switch is on): one of Verified, Code failed, Partially verified or Blocked by environment for the code now on the task, with one row per check. Absent while the switch is off or the result is not decided yet. */
  testing: TestingViewSchema.optional(),
  /** Design review (DR11, version 2 only): the Design first and Skip buttons for the person reading, decided by the broker. Absent when design review is not offered for the task. */
  designActions: DesignActionsViewSchema.optional().catch(undefined),
  /**
   * OWNER DECISION 7 (version 2 only, full reads only): what the old review page offered on a task that stopped, now on the task page: Retry the browser and API checks (a blocked round a retry can fix),
   * Revise the plan (coding stopped for the owner's live message) and a held spec's choices. Each says whether THIS reader may press it; the routes check again. Fixed words from the broker only.
   */
  pageActions: z.object({
    checksRetry: z.object({ canRetry: z.boolean() }).strict().optional(),
    revisePlan: z.object({ canRevise: z.boolean() }).strict().optional(),
    specHold: z.object({ title: z.string().min(1).max(120), message: z.string().min(1).max(600), choices: z.array(z.enum(["retry", "continue", "keep", "replan"])).max(4), canChoose: z.boolean() }).strict().optional(),
  }).strict().optional().catch(undefined),
  /** Decisions D5 (version 2 only): the coding plan under review on one screen (about 1,500 characters), derived from the plan document with no model call. Absent when there is no readable plan. */
  planOneScreen: PlanOneScreenSchema.optional(),
  /**
   * Playbook P2 (version 2 only, like `verificationReport`): which model reviewed the code now on the task, and, when it was the build's own, the note that says so. These are the lines the pull request's Reviews section has
   * (Trust fix A2's `reviewModelLines`), passed on word for word; absent before any review of the current code. Plain text that every reader escapes for its own markup.
   */
  reviewModelLines: z.array(z.string().min(1).max(300)).min(1).max(4).optional(),
  /**
   * SH34 (version 2 only, only while the install switch `cr` is on): the second review by another AI company, for the code now on the task. `lines` are plain text (an answer's findings, or "Second review did not run: <reason>");
   * `needsAcknowledgement` is true for an `on` review that did not run until the task owner acknowledges it, and `acknowledged` says they have. Absent when there is nothing to show (shadow that did not run is silent).
   */
  secondReview: z.object({ lines: z.array(z.string().min(1).max(320)).min(1).max(7), needsAcknowledgement: z.boolean(), acknowledged: z.boolean(), /** True for the task's owner while an acknowledgement is asked for: the page offers "I've seen it". */ canAcknowledge: z.boolean().optional() }).strict().optional(),
  /** Plan 6, Task 12 (version 2 only, like `verificationReport`): the review round whose problems are being fixed, with the sentence the thread says. */
  reviewRound: z.object({ round: z.number().int().min(1).max(100), max: z.number().int().min(1).max(5), message: z.string().min(1).max(200) }).strict().optional(),
  /**
   * Plan 6, Task 14 (version 2 only, full reads only, and only for a client that sends `x-agentx-task-view: 2`): what GitHub says about each pull request of the task,
   * as merge tracking last read it. The merge claim is the broker's own and is never part of the view.
   */
  mergeTracking: z.array(MergeTrackingItemSchema.omit({ mergeClaim: true })).max(32).optional(),
  /**
   * Plan 6, Task 19 (version 2 only, full reads only, and only for a client that sends `x-agentx-task-view: 2`): whether the viewer pressing Merge now would be allowed to, from what merge
   * tracking last read. Advisory: the press re-reads GitHub.
   */
  merge: MergeViewSchema.optional(),
  /**
   * v1.2 track record (version 2 only, full reads only, like `mergeTracking`): how the pull requests this project rated low risk went in the last 30 days, for the task's own owner and only when this task's
   * pull request was published with risk low. Private: it is left out for every other viewer, and it is never on the shared card, in a Slack thread or on the pull request.
   */
  earlyRiskSignal: EarlyRiskSignalReadSchema.optional(),
});

/**
 * The task as a client that sends `x-agentx-task-view: 2` reads it: the same view, with the workflow read tolerantly (`WorkflowSnapshotReaderShape`), so a stage or
 * outcome a newer control plane added reads as "unknown" instead of failing the whole answer. The type says what the reader does: `stage` and `outcome` may be
 * "unknown", so a caller has to decide what to do with a stage it does not know.
 */
export type DeveloperTaskClientView = Omit<z.infer<typeof DeveloperTaskViewSchema>, "workflow"> & {
  workflow?: (WorkflowSnapshotReader & { planContent?: string | undefined; workBreakdownDigest?: string | undefined }) | undefined;
};
export const DeveloperTaskClientViewSchema = DeveloperTaskViewSchema.extend({
  workflow: z.looseObject({
    ...WorkflowSnapshotReaderShape,
    planContent: z.string().max(WORKFLOW_PLAN_MAX_BYTES).optional(),
    workBreakdownDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
}) as unknown as z.ZodType<DeveloperTaskClientView>;
/**
 * The task as the strict view, or undefined when the control plane named a stage, outcome or other value this build does not know (a newer server), which the
 * reader gave as "unknown". The reader differs from the strict view only by those markers and by keeping fields it does not know, so a task with no marker
 * is the strict view. Code that decides what to do from a stage reads the task through this, and tells the person when it is undefined. Only the places the
 * reader can write the marker count (`readsAsUnknown` walks the strict schema), so free text that is the word "unknown" does not.
 */
export function knownTaskView(view: DeveloperTaskClientView): z.infer<typeof DeveloperTaskViewSchema> | undefined {
  return readsAsUnknown(DeveloperTaskViewSchema.shape.workflow, view.workflow) ? undefined : (view as z.infer<typeof DeveloperTaskViewSchema>);
}
