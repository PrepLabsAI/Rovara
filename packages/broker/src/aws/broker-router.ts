// Top-level Lambda event & HTTP route dispatchers for the AWS broker (extracted and decomposed from aws/broker.ts).
import {
  ActorRefSchema,
  AgentXError,
  CORE_OFFERED_MODELS_ADMIN_PATH,
  OrgIdSchema,
  SLACK_CHANNEL,
  WEB_API_RUNTIME_PROFILE_ID,
  agentXError,
  companyLog,
  isAdminChangePressEvent,
  type AdminChangePressEvent,
  type OfferedAgentModels,
  type SlackThread,
} from "@agentx/contracts";
import { z } from "zod";
import type { AuthenticatedIdentity } from "../auth.js";
import { CORE_OFFERED_MODELS_NOT_SET_UP, OFFERED_MODELS_READ_FAILED } from "../core-host/offered-models-http.js";
import { isCoreJobEvent } from "../core-host/jobs.js";
import { pressAdminChange, routeAdminChange, type AdminChangeDependencies } from "./admin-changes.js";
import { OFFERED_MODELS_COMPANY_PARAMETER, offeredModelsCompany } from "./admin-offered-models.js";
import { routeAdminRead, type AdminReadDependencies } from "./admin-reads.js";
import { getItem } from "./cancellation.js";
import {
  deleteChannelAdapter,
  deleteChannelBinding,
  listChannelAdapters,
  putChannelBinding,
  registerChannelAdapter,
} from "./channel-adapters.js";
import { removeLink } from "./channel-links.js";
import { resolveAdminCompany } from "./company-check.js";
import { stripCode } from "./connector-routes.js";
import { outboxCompaniesOf } from "./core-engine-root.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js";
import { releasePendingFinishedTasks } from "./developer-tasks.js";
import { readE2ERuntimeStatus } from "./e2e-runtime-readiness.js";
import { githubBindingRefusal, type GithubInstallationBindings } from "./github-credentials.js";
import { planCompanyImport, planCompanyImportUndo } from "./install-company-import.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { handleLinearAppWebhook, LINEAR_WEBHOOK_PATH, linearWebhookResponse } from "./linear-app-webhook.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "./runtime-installation.js";
import { SLACK_WEB_SIGNIN_NOTICE } from "./slack-action-classes.js";
import { answerSlackChatGpt, isSlackChatGptCommandEvent, isSlackChatGptFinishEvent } from "./slack-chatgpt.js";
import { handleSlackWorkspaceRemoved } from "./slack-company-install.js";
import { answerSlackLinkNotice, isSlackLinkNoticeEvent } from "./slack-company-wiring.js";
import { answerSlackTaskAction, isSlackTaskActionEvent } from "./slack-core-task-action.js";
import { handleSlackRovara, isSlackRovaraEvent, SlackRovaraEventSchema, slackSignInUrlOf } from "./slack-rovara-command.js";
import { createSlackWorkspaceBindings, isSlackWorkspaceOperatorEvent, SlackWorkspaceOperatorEventSchema } from "./slack-workspace-binding.js";
import { isSlackWorkspaceRemovedEvent, SlackWorkspaceRemovedEventSchema } from "./slack-workspace-removal.js";
import { handleSwebenchCallback, isSwebenchCallbackPath } from "./swebench.js";
import { runDueWorkflowMergeRecovery, type GithubMergeReadBudget, type MergeRecoveryResult } from "./workflow-merge-recovery.js";
import { channelAdapterDependencies, channelLinkRouteDependencies, json, parseBody } from "./broker-primitives.js";
import {
  isSlackIntakeRecordEvent,
  isSlackStopTaskEvent,
  isSlackTaskAuthorizationEvent,
  isSlackTaskPeopleChangeEvent,
  isSlackTaskPeopleConfirmEvent,
  isSlackTaskPeopleReadEvent,
  isSlackTaskPeopleTakeOwnershipEvent,
  isSlackThreadNoteEvent,
  isSlackWorkflowCloseEvent,
  isSlackWorkflowDecisionEvent,
  isSlackWorkflowFeedbackFindingsDecisionEvent,
  isSlackWorkflowFeedbackNoteEvent,
  isSlackWorkflowFeedbackReviewRetryEvent,
  isSlackWorkflowKeepPullRequestsEvent,
  isSlackWorkflowPublishRetryEvent,
  isSlackWorkflowResolveFindingsEvent,
  isSlackWorkflowRetryEvent,
  isSlackWorkflowReviewRetryEvent,
  isSlackWorkflowSendBackEvent,
  isSlackWorkflowStartEvent,
  slackIngressThreadTeam,
  type SlackIntakeRecordEvent,
  type SlackStopTaskEvent,
  type SlackTaskAuthorizationEvent,
  type SlackTaskPeopleChangeEvent,
  type SlackTaskPeopleConfirmEvent,
  type SlackTaskPeopleReadEvent,
  type SlackTaskPeopleTakeOwnershipEvent,
  type SlackThreadNoteEvent,
  type SlackWorkflowCloseEvent,
  type SlackWorkflowDecisionEvent,
  type SlackWorkflowFeedbackFindingsDecisionEvent,
  type SlackWorkflowFeedbackNoteEvent,
  type SlackWorkflowFeedbackReviewRetryEvent,
  type SlackWorkflowKeepPullRequestsEvent,
  type SlackWorkflowPublishRetryEvent,
  type SlackWorkflowResolveFindingsEvent,
  type SlackWorkflowRetryEvent,
  type SlackWorkflowReviewRetryEvent,
  type SlackWorkflowSendBackEvent,
  type SlackWorkflowStartEvent,
} from "./broker-slack-events.js";
import { routeEvalBatch, routeStartEvalBatch, routeSwebenchChannel, swebenchDependencies } from "./broker-swebench-routes.js";
import type { AwsBrokerDependencies, AwsBrokerInput } from "./broker-types.js";

export type BrokerHttpResponse = { statusCode: number; headers: Record<string, string>; body: string };

export interface OperatorEventHooks {
  operatorGithubBindings: (dependencies: AwsBrokerDependencies) => GithubInstallationBindings;
  brokerLogLine: (entry: Record<string, unknown>) => void;
  operatorEventRefused: (event: string, error: unknown) => void;
  isGithubWebhookRecoveryEvent: (event: unknown) => event is { source: "agentx.github-webhook-recovery"; continuation?: unknown };
  retryDueGithubWebhookEvents: (dependencies: AwsBrokerDependencies, continuation?: unknown) => Promise<unknown>;
  isWorkflowMergeRecoveryEvent: (event: unknown) => boolean;
  reconcileWorkflowMergeRecoveryTask: (dependencies: AwsBrokerDependencies, taskId: string, budget: GithubMergeReadBudget) => Promise<MergeRecoveryResult>;
  isWorkflowDispatchRecoveryEvent: (event: unknown) => boolean;
  retryDueWorkflowDispatches: (dependencies: AwsBrokerDependencies) => Promise<Record<string, unknown>>;
  startDuePlanEvidenceJobs: (dependencies: AwsBrokerDependencies) => Promise<unknown>;
  developerTaskActions: (dependencies: AwsBrokerDependencies) => DeveloperTaskActions;
}

export interface SlackIngressHooks {
  namedInstallTeamView: (dependencies: AwsBrokerDependencies, teamId: string) => Promise<AwsBrokerDependencies>;
  developerTaskActions: (dependencies: AwsBrokerDependencies) => DeveloperTaskActions;
  unexpectedErrorAnswer: (error: unknown, requestId: string) => BrokerHttpResponse;
  replyNotSavedAnswer: (error: unknown, event: { taskId: string; eventId: string }) => BrokerHttpResponse;
  stopSlackThreadTask: (dependencies: AwsBrokerDependencies, event: SlackStopTaskEvent) => Promise<unknown>;
  authorizeSlackTaskAction: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskAuthorizationEvent) => Promise<unknown>;
  confirmSlackTaskPeople: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskPeopleConfirmEvent) => Promise<unknown>;
  handleSlackTaskPeople: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskPeopleReadEvent | SlackTaskPeopleChangeEvent | SlackTaskPeopleTakeOwnershipEvent) => Promise<unknown>;
  startSlackWorkflow: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowStartEvent) => Promise<{ task: { taskId: string } }>;
  answerSlackWorkflowEvent: (
    dependencies: AwsBrokerDependencies,
    event: { taskId: string; userId: string; thread: SlackThread; requestId: string },
    name: string,
    run: () => Promise<unknown>,
    options: { outOfDate: string; awsRequestId?: string | undefined },
  ) => Promise<BrokerHttpResponse>;
  decideSlackWorkflow: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowDecisionEvent) => Promise<unknown>;
  retrySlackWorkflowChecks: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowRetryEvent) => Promise<unknown>;
  retrySlackWorkflowReviews: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowReviewRetryEvent) => Promise<unknown>;
  retrySlackWorkflowPublication: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowPublishRetryEvent) => Promise<unknown>;
  keepSlackWorkflowPullRequests: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowKeepPullRequestsEvent) => Promise<unknown>;
  sendSlackWorkflowBack: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowSendBackEvent) => Promise<unknown>;
  resolveSlackWorkflowFindings: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowResolveFindingsEvent) => Promise<unknown>;
  closeSlackWorkflowTask: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowCloseEvent) => Promise<unknown>;
  decideSlackWorkflowFeedbackFindings: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackFindingsDecisionEvent) => Promise<unknown>;
  retrySlackWorkflowFeedbackReview: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackReviewRetryEvent) => Promise<unknown>;
  recordSlackIntake: (dependencies: AwsBrokerDependencies, event: SlackIntakeRecordEvent) => Promise<unknown>;
  dispatchSlackCorePress: (slackView: AwsBrokerDependencies, event: unknown) => Promise<BrokerHttpResponse | undefined>;
  companySlackCaller: (dependencies: AwsBrokerDependencies, thread: SlackThread, userId: string) => Promise<DeveloperCaller>;
  recordSlackThreadNote: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackThreadNoteEvent) => Promise<{ outcome: string; [key: string]: unknown }>;
  captureSlackWorkflowFeedbackNote: (dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackNoteEvent) => Promise<unknown>;
  approvalOutOfDate: string;
  buttonOutOfDate: string;
}

export interface PreAuthHttpHooks {
  routeGithubWebhook: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest) => Promise<BrokerHttpResponse>;
  handleProjectSetupCallback: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupId: string, operationId: string) => Promise<unknown>;
  handleProjectSetupExecutionRead: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupId: string, offset: string | null) => Promise<unknown>;
  handleProjectSetupEvidenceInit: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupId: string) => Promise<unknown>;
  handleProjectSetupEvidenceChunk: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupId: string) => Promise<unknown>;
  handleProjectSetupEvidenceFinalize: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupId: string) => Promise<unknown>;
}

export interface AdminHttpHooks {
  adminChanges: AdminChangeDependencies | undefined;
  adminReads: AdminReadDependencies;
  tasks: DeveloperTaskActions;
  retryGithubWebhookAsAdministrator: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, deliveryId: string) => Promise<unknown>;
  retryProjectSetupAsAdministrator: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, executionId: string, body: unknown) => Promise<unknown>;
  routeSetupProposal: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, identity: AuthenticatedIdentity, body: unknown) => Promise<BrokerHttpResponse>;
  routeSetupApproval: (dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, identity: AuthenticatedIdentity, body: unknown) => Promise<BrokerHttpResponse>;
  registerProject: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, body: unknown) => Promise<unknown>;
  adminModelChecks: (dependencies: AwsBrokerDependencies, method: string, checkId: string | undefined, body: unknown, requestId: string) => Promise<BrokerHttpResponse>;
  prepareWorkspace: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, body: unknown) => Promise<unknown>;
  putSlackBinding: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, teamId: string, channelId: string, body: unknown) => Promise<unknown>;
  deleteSlackBinding: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, teamId: string, channelId: string) => Promise<unknown>;
  cancelWorkspaceTask: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) => Promise<unknown>;
  stopWorkspace: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) => Promise<unknown>;
  adminTaskE2EReplay: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, taskId: string, method: "POST" | "GET", body: unknown, query: URLSearchParams) => Promise<unknown>;
  adminTaskShareMode: (dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, taskId: string, body: unknown, tasks: DeveloperTaskActions) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 1. Core engine, operator & scheduled recovery direct-invoke events
// ---------------------------------------------------------------------------

async function handleCoreEngineEvent(
  core: NonNullable<AwsBrokerInput["core"]>,
  event: unknown,
  context?: { getRemainingTimeInMillis?: () => number },
): Promise<BrokerHttpResponse> {
  try {
    const remainingMs = typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : undefined;
    return json((await core.handleEvent(event, { remainingMs })) ?? { skipped: "not_core" }, "core-engine");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ component: "broker", event: "core_engine.event_failed", error: error instanceof Error ? error.name : "unknown" })}\n`);
    if (error instanceof Error && error.message === "The core engine settings are not readable.") {
      return json({ error: { code: "CORE_SWITCH_BLOCKED", message: "The core engine settings are not readable." } }, "core-engine", 503);
    }
    return json({ error: "core_event_failed" }, "core-engine", 500);
  }
}

async function handleAdminChangePress(
  dependencies: AwsBrokerDependencies,
  adminChanges: AdminChangeDependencies | undefined,
  event: AdminChangePressEvent,
): Promise<BrokerHttpResponse> {
  if (dependencies.workspaces !== undefined) return json({ error: { code: "FORBIDDEN", message: SLACK_WEB_SIGNIN_NOTICE } }, "slack-ingress", 403);
  if (adminChanges === undefined) return json({ error: { code: "NOT_FOUND", message: "admin changes are not set up in this deployment" } }, "slack-ingress", 404);
  try {
    return json(await pressAdminChange(adminChanges, event), "slack-ingress");
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "admin_change.press_failed", changeId: event.changeId, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
    return json({ outcome: "failed", changeId: event.changeId }, "slack-ingress", 500);
  }
}

async function handleSlackWorkspaceOperator(dependencies: AwsBrokerDependencies, event: unknown): Promise<BrokerHttpResponse> {
  const parsed = SlackWorkspaceOperatorEventSchema.safeParse(event);
  if (!parsed.success) return json({ outcome: "refused" }, "slack-workspace", 404);
  const workspaces = createSlackWorkspaceBindings({ client: dependencies.documentClient, tableName: dependencies.tableName, legacyTeamId: dependencies.slackWorkspaceLegacyTeamId });
  try {
    if (parsed.data.source === "agentx.slack-workspace-backfill") return json({ outcome: "backfilled", ...await workspaces.backfill() }, "slack-workspace");
    await workspaces.bind(parsed.data.companyId, parsed.data.teamId, parsed.data.by);
    return json({ outcome: "bound" }, "slack-workspace");
  } catch { return json({ outcome: "refused" }, "slack-workspace", 404); }
}

async function handleSlackWorkspaceRemovedEvent(dependencies: AwsBrokerDependencies, event: unknown): Promise<BrokerHttpResponse> {
  const parsed = SlackWorkspaceRemovedEventSchema.safeParse(event);
  if (!parsed.success || dependencies.slackInstall === undefined) {
    return parsed.success ? json({ outcome: "ignored" }, "slack-workspace") : json({ outcome: "refused" }, "slack-workspace", 404);
  }
  try {
    return json(await handleSlackWorkspaceRemoved({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, wiring: dependencies.slackInstall }, parsed.data), "slack-workspace");
  } catch { return json({ outcome: "failed" }, "slack-workspace", 500); }
}

async function handleSlackRovaraEvent(dependencies: AwsBrokerDependencies, event: unknown): Promise<BrokerHttpResponse> {
  const parsed = SlackRovaraEventSchema.safeParse(event);
  if (!parsed.success) return json({ error: "invalid_request" }, "slack-rovara", 400);
  const signInTableName = dependencies.developer?.signInTableName;
  const signInUrl = slackSignInUrlOf(dependencies.slackSignInUrl);
  const context = dependencies.slackChannels === undefined || signInTableName === undefined ? undefined : {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName, now: Date.now, wiring: dependencies.slackChannels,
    ...(dependencies.slackWorkspaceLegacyTeamId === undefined ? {} : { installTeamId: dependencies.slackWorkspaceLegacyTeamId }),
    ...(signInUrl === undefined ? {} : { signInUrl }),
  };
  return json(await handleSlackRovara(context, parsed.data), "slack-rovara");
}

function eventSource(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("source" in event)) return undefined;
  return typeof (event as { source?: unknown }).source === "string" ? (event as { source: string }).source : undefined;
}

async function handleGithubBindingEvent(
  dependencies: AwsBrokerDependencies,
  event: unknown,
  hooks: OperatorEventHooks,
): Promise<BrokerHttpResponse | undefined> {
  const source = eventSource(event);
  if (source === "agentx.github-binding-claim") {
    try {
      const input = z.object({ source: z.literal("agentx.github-binding-claim"), installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), companyId: OrgIdSchema }).strict().parse(event);
      const bindings = hooks.operatorGithubBindings(dependencies);
      if (dependencies.githubBindingInstallations === undefined) throw githubBindingRefusal();
      const installation = await dependencies.githubBindingInstallations.get(input.installationId);
      if (installation === undefined || installation.installationId !== input.installationId) throw githubBindingRefusal();
      await bindings.claimOperator(input.companyId, installation);
      companyLog(input.companyId, hooks.brokerLogLine)({ event: "github.binding_claimed", installationId: input.installationId });
      return json({ claimed: true }, "github-binding-claim");
    } catch (error) {
      hooks.operatorEventRefused("github.binding_claim_refused", error);
      return json({ error: { code: "GITHUB_NOT_CONNECTED", message: "the GitHub installation is not connected" } }, "github-binding-claim", 403);
    }
  }
  if (source === "agentx.github-binding-backfill") {
    try {
      const input = z.object({ source: z.literal("agentx.github-binding-backfill"), continuation: z.number().int().positive().max(1_000_000).optional() }).strict().parse(event);
      const bindings = hooks.operatorGithubBindings(dependencies);
      if (dependencies.githubBindingInstallations === undefined) throw githubBindingRefusal();
      return json(await bindings.backfillPage(page => dependencies.githubBindingInstallations!.page(page), input.continuation), "github-binding-backfill");
    } catch (error) {
      hooks.operatorEventRefused("github.binding_backfill_refused", error);
      return json({ error: "backfill_failed" }, "github-binding-backfill", 500);
    }
  }
  return undefined;
}

async function handleWorkflowDispatchRecovery(dependencies: AwsBrokerDependencies, hooks: OperatorEventHooks): Promise<BrokerHttpResponse> {
  try {
    const dispatches = await hooks.retryDueWorkflowDispatches(dependencies);
    const planEvidence = await hooks.startDuePlanEvidenceJobs(dependencies).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "plan_evidence.sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
      return { attempted: 0, started: 0 };
    });
    const releases = await releasePendingFinishedTasks({ tableName: dependencies.tableName, actions: hooks.developerTaskActions(dependencies), documentClient: dependencies.documentClient })
      .catch((error: unknown) => {
        console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
        return { attempted: 0, released: 0 };
      });
    return json({ ...dispatches, planEvidence, releases }, "workflow-dispatch-recovery");
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
    return json({ error: "recovery_failed" }, "workflow-dispatch-recovery", 500);
  }
}

async function handleRecoveryEvent(
  dependencies: AwsBrokerDependencies,
  event: unknown,
  hooks: OperatorEventHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (hooks.isGithubWebhookRecoveryEvent(event)) {
    try { return json(await hooks.retryDueGithubWebhookEvents(dependencies, "continuation" in event ? event.continuation : undefined), "github-webhook-recovery"); }
    catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "github.webhook_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
      return json({ error: "recovery_failed" }, "github-webhook-recovery", 500);
    }
  }
  if (hooks.isWorkflowMergeRecoveryEvent(event)) {
    try {
      const result = await runDueWorkflowMergeRecovery({
        documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
        reconcile: (taskId, budget) => hooks.reconcileWorkflowMergeRecoveryTask(dependencies, taskId, budget),
      });
      return json(result, "workflow-merge-recovery");
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "workflow.merge_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
      return json({ error: "recovery_failed" }, "workflow-merge-recovery", 500);
    }
  }
  if (hooks.isWorkflowDispatchRecoveryEvent(event)) return handleWorkflowDispatchRecovery(dependencies, hooks);
  return undefined;
}

export async function dispatchCoreAndOperatorEvent(
  core: AwsBrokerInput["core"],
  dependencies: AwsBrokerDependencies,
  adminChanges: AdminChangeDependencies | undefined,
  event: unknown,
  context: { awsRequestId?: string; getRemainingTimeInMillis?: () => number } | undefined,
  hooks: OperatorEventHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (core !== undefined && (isCoreJobEvent(event) || outboxCompaniesOf(event) !== undefined)) return handleCoreEngineEvent(core, event, context);
  if (dependencies.workspaces !== undefined && isSlackLinkNoticeEvent(event)) return json(await answerSlackLinkNotice(dependencies, event), "slack-link-notice");
  if (isAdminChangePressEvent(event)) return handleAdminChangePress(dependencies, adminChanges, event);
  if (isSlackWorkspaceOperatorEvent(event)) return handleSlackWorkspaceOperator(dependencies, event);
  if (isSlackWorkspaceRemovedEvent(event)) return handleSlackWorkspaceRemovedEvent(dependencies, event);
  if (isSlackRovaraEvent(event)) return handleSlackRovaraEvent(dependencies, event);
  const githubBinding = await handleGithubBindingEvent(dependencies, event, hooks);
  if (githubBinding !== undefined) return githubBinding;
  return handleRecoveryEvent(dependencies, event, hooks);
}

// ---------------------------------------------------------------------------
// 2. Slack ingress direct-invoke events
// ---------------------------------------------------------------------------

async function runSlackIngressAction(
  run: () => Promise<unknown>,
  unexpectedErrorAnswer: (error: unknown, requestId: string) => BrokerHttpResponse,
): Promise<BrokerHttpResponse> {
  try {
    return json(await run(), "slack-ingress");
  } catch (error) {
    if (error instanceof AgentXError) {
      return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
    }
    return unexpectedErrorAnswer(error, "slack-ingress");
  }
}

async function dispatchSlackDirectActions(
  slackView: AwsBrokerDependencies,
  slackTasks: DeveloperTaskActions,
  event: unknown,
  hooks: SlackIngressHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (isSlackStopTaskEvent(event)) return runSlackIngressAction(() => hooks.stopSlackThreadTask(slackView, event), hooks.unexpectedErrorAnswer);
  if (isSlackTaskAuthorizationEvent(event)) return runSlackIngressAction(() => hooks.authorizeSlackTaskAction(slackView, slackTasks, event), hooks.unexpectedErrorAnswer);
  if (isSlackTaskPeopleConfirmEvent(event)) return runSlackIngressAction(() => hooks.confirmSlackTaskPeople(slackView, slackTasks, event), hooks.unexpectedErrorAnswer);
  if (isSlackTaskPeopleReadEvent(event) || isSlackTaskPeopleChangeEvent(event) || isSlackTaskPeopleTakeOwnershipEvent(event)) {
    return runSlackIngressAction(() => hooks.handleSlackTaskPeople(slackView, slackTasks, event), hooks.unexpectedErrorAnswer);
  }
  if (isSlackWorkflowStartEvent(event)) {
    return runSlackIngressAction(async () => ({ taskId: (await hooks.startSlackWorkflow(slackView, slackTasks, event)).task.taskId }), hooks.unexpectedErrorAnswer);
  }
  return undefined;
}

function dispatchSlackWorkflowPress(
  slackView: AwsBrokerDependencies,
  slackTasks: DeveloperTaskActions,
  event: unknown,
  awsRequestId: string | undefined,
  hooks: SlackIngressHooks,
): Promise<BrokerHttpResponse> | undefined {
  const approval = { outOfDate: hooks.approvalOutOfDate, awsRequestId };
  const button = { outOfDate: hooks.buttonOutOfDate, awsRequestId };
  if (isSlackWorkflowDecisionEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "decision", () => hooks.decideSlackWorkflow(slackView, slackTasks, event), approval);
  if (isSlackWorkflowRetryEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "verification_retry", () => hooks.retrySlackWorkflowChecks(slackView, slackTasks, event), button);
  if (isSlackWorkflowReviewRetryEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "review_retry", () => hooks.retrySlackWorkflowReviews(slackView, slackTasks, event), button);
  if (isSlackWorkflowPublishRetryEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "publish_retry", () => hooks.retrySlackWorkflowPublication(slackView, slackTasks, event), button);
  if (isSlackWorkflowKeepPullRequestsEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "keep_pull_requests", () => hooks.keepSlackWorkflowPullRequests(slackView, slackTasks, event), button);
  if (isSlackWorkflowSendBackEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "send_back", () => hooks.sendSlackWorkflowBack(slackView, slackTasks, event), button);
  if (isSlackWorkflowResolveFindingsEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "resolve_findings", () => hooks.resolveSlackWorkflowFindings(slackView, slackTasks, event), button);
  if (isSlackWorkflowCloseEvent(event)) return hooks.answerSlackWorkflowEvent(slackView, event, "close", () => hooks.closeSlackWorkflowTask(slackView, slackTasks, event), button);
  if (isSlackWorkflowFeedbackFindingsDecisionEvent(event)) {
    return hooks.answerSlackWorkflowEvent(slackView, event, "feedback_findings_decision", () => hooks.decideSlackWorkflowFeedbackFindings(slackView, slackTasks, event), approval);
  }
  if (isSlackWorkflowFeedbackReviewRetryEvent(event)) {
    return hooks.answerSlackWorkflowEvent(slackView, event, "feedback_review_retry", () => hooks.retrySlackWorkflowFeedbackReview(slackView, slackTasks, event), button);
  }
  return undefined;
}

async function dispatchSlackNotesAndCore(
  slackView: AwsBrokerDependencies,
  slackTasks: DeveloperTaskActions,
  event: unknown,
  hooks: SlackIngressHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (isSlackIntakeRecordEvent(event)) return runSlackIngressAction(() => hooks.recordSlackIntake(slackView, event), hooks.unexpectedErrorAnswer);
  const corePress = await hooks.dispatchSlackCorePress(slackView, event);
  if (corePress !== undefined) return corePress;
  if (isSlackTaskActionEvent(event)) return answerSlackTaskAction(slackView.developer?.coreTasks, event, (thread, userId) => hooks.companySlackCaller(slackView, thread, userId));
  if (isSlackThreadNoteEvent(event)) {
    try {
      const result = await hooks.recordSlackThreadNote(slackView, slackTasks, event);
      console.log(JSON.stringify({ component: "broker", event: "slack.thread_note", taskId: event.taskId, eventId: event.eventId, outcome: result.outcome }));
      return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(result) };
    } catch (error) {
      return hooks.replyNotSavedAnswer(error, event);
    }
  }
  if (isSlackWorkflowFeedbackNoteEvent(event)) {
    try {
      return json(await hooks.captureSlackWorkflowFeedbackNote(slackView, slackTasks, event), "slack-ingress");
    } catch (error) {
      if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
      return hooks.replyNotSavedAnswer(error, event);
    }
  }
  return undefined;
}

export async function dispatchSlackIngressEvent(
  dependencies: AwsBrokerDependencies,
  tasks: DeveloperTaskActions,
  event: unknown,
  awsRequestId: string | undefined,
  hooks: SlackIngressHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (isSlackChatGptCommandEvent(event) || isSlackChatGptFinishEvent(event)) {
    if (dependencies.workspaces !== undefined) return json({ error: { code: "FORBIDDEN", message: SLACK_WEB_SIGNIN_NOTICE } }, "slack-ingress", 403);
    return runSlackIngressAction(() => answerSlackChatGpt({
      ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
      ...(dependencies.developer?.slackTeamId === undefined ? {} : { slackTeamId: dependencies.developer.slackTeamId }),
    }, event), hooks.unexpectedErrorAnswer);
  }
  let slackView = dependencies;
  const slackTeam = slackIngressThreadTeam(event);
  if (slackTeam !== undefined) {
    try { slackView = await hooks.namedInstallTeamView(dependencies, slackTeam); }
    catch { return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "This Slack workspace is not available." } }, "slack-ingress", 503); }
  }
  const slackTasks = slackView === dependencies ? tasks : hooks.developerTaskActions(slackView);
  const direct = await dispatchSlackDirectActions(slackView, slackTasks, event, hooks);
  if (direct !== undefined) return direct;
  const press = dispatchSlackWorkflowPress(slackView, slackTasks, event, awsRequestId, hooks);
  if (press !== undefined) return press;
  return dispatchSlackNotesAndCore(slackView, slackTasks, event, hooks);
}

// ---------------------------------------------------------------------------
// 3. Pre-JWT webhooks & internal project-setup routes
// ---------------------------------------------------------------------------

async function dispatchProjectSetupInternalRoute(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  hooks: PreAuthHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  const setupCallback = /^\/v1\/internal\/project-setups\/([0-9a-f-]{36})\/operations\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
  if (request.method === "POST" && setupCallback?.[1] && setupCallback[2]) {
    return json(await hooks.handleProjectSetupCallback(dependencies, request, setupCallback[1], setupCallback[2]), request.requestId);
  }
  const setupArtifact = /^\/v1\/internal\/project-setups\/([0-9a-f-]{36})\/(execution|evidence(?:\/init|\/chunks|\/finalize)?)$/.exec(url.pathname);
  const setupId = setupArtifact?.[1];
  const kind = setupArtifact?.[2];
  if (!setupId || !kind) return undefined;
  if (kind === "execution" && request.method === "GET") return json(await hooks.handleProjectSetupExecutionRead(dependencies, request, setupId, url.searchParams.get("offset")), request.requestId);
  if (request.method !== "POST") return undefined;
  if (kind === "evidence/init") return json(await hooks.handleProjectSetupEvidenceInit(dependencies, request, setupId), request.requestId);
  if (kind === "evidence/chunks") return json(await hooks.handleProjectSetupEvidenceChunk(dependencies, request, setupId), request.requestId);
  if (kind === "evidence/finalize") return json(await hooks.handleProjectSetupEvidenceFinalize(dependencies, request, setupId), request.requestId);
  return undefined;
}

export async function dispatchPreAuthHttpRoute(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  hooks: PreAuthHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (url.pathname === LINEAR_WEBHOOK_PATH) {
    if (request.method !== "POST" || dependencies.linearWebhook === undefined) return json({ error: { code: "NOT_FOUND", message: "route not found" } }, request.requestId, 404);
    return linearWebhookResponse(await handleLinearAppWebhook(dependencies.linearWebhook, { rawBody: request.body, headers: request.headers }), request.requestId);
  }
  if (url.pathname === "/v1/github/webhooks") return hooks.routeGithubWebhook(dependencies, request);
  const evalCallback = isSwebenchCallbackPath(url.pathname);
  if (request.method === "POST" && evalCallback !== undefined) {
    return json(await handleSwebenchCallback(swebenchDependencies(dependencies), request.headers["x-agentx-callback-capability"], evalCallback.runId, evalCallback.action, parseBody(request.body)), request.requestId);
  }
  return dispatchProjectSetupInternalRoute(dependencies, request, url, hooks);
}

// ---------------------------------------------------------------------------
// 4. OIDC /v1/admin/* routes
// ---------------------------------------------------------------------------

function requireAdminClaim(identity: AuthenticatedIdentity): void {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
}

function runtimeInstallationDeps(dependencies: AwsBrokerDependencies): RuntimeInstallationDependencies {
  if (!dependencies.projectSetupRuntimeCatalogId || !dependencies.e2eFeatureRuntimeCatalogId) {
    throw agentXError("RUNTIME_UNAVAILABLE", "runtime installation catalogs are not configured in this deployment");
  }
  return {
    documentClient: dependencies.documentClient, s3: dependencies.s3,
    tableName: dependencies.tableName, artifactBucketName: dependencies.artifactBucketName,
    setupCatalogId: dependencies.projectSetupRuntimeCatalogId, featureCatalogId: dependencies.e2eFeatureRuntimeCatalogId,
  };
}

async function dispatchAdminRuntimeAndSetup(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
  hooks: AdminHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (request.method === "POST" && url.pathname === "/v1/admin/runtime-installation/challenges") {
    requireAdminClaim(identity);
    return json(await issueRuntimeInstallChallenge(runtimeInstallationDeps(dependencies), identity, body), request.requestId, 201);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/runtime-installation/registrations") {
    requireAdminClaim(identity);
    return json(await registerRuntimeInstallation(runtimeInstallationDeps(dependencies), identity, body), request.requestId, 201);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/projects/setup-proposals") return hooks.routeSetupProposal(dependencies, request, identity, body);
  if (request.method === "POST" && url.pathname === "/v1/admin/projects/setup-approvals") return hooks.routeSetupApproval(dependencies, request, identity, body);
  if (request.method === "POST" && url.pathname === "/v1/admin/projects") return json(await hooks.registerProject(dependencies, identity, body), request.requestId, 201);
  if (url.pathname === "/v1/admin/credentials" && (request.method === "POST" || request.method === "GET")) {
    requireAdminClaim(identity);
    if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
    return request.method === "POST"
      ? json(await dependencies.credentialRegistry.register(identity, body), request.requestId, 201)
      : json(await dependencies.credentialRegistry.list(identity), request.requestId);
  }
  if (request.method === "GET" && url.pathname === "/v1/admin/runtime-installation/status") {
    requireAdminClaim(identity);
    if (!dependencies.e2eFeatureRuntimeCatalogId) throw agentXError("NOT_FOUND", "browser and API runtimes are not set up in this deployment");
    return json(await readE2ERuntimeStatus({ runtimeCatalogId: dependencies.e2eFeatureRuntimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID,
      read: (key) => getItem<Record<string, unknown>>(dependencies, key) }), request.requestId);
  }
  return undefined;
}

async function handleAdminCompanyImport(dependencies: AwsBrokerDependencies, url: URL, requestId: string): Promise<BrokerHttpResponse> {
  const developer = dependencies.developer;
  if (developer?.companyImport === undefined) throw agentXError("NOT_FOUND", "company import is not set up in this deployment");
  const companyId = OrgIdSchema.safeParse(url.searchParams.get("companyId"));
  const mode = url.searchParams.get("mode") ?? "import";
  if (!companyId.success || (mode !== "import" && mode !== "undo")) {
    throw agentXError("CONFIG_INVALID", "give the install's company id (org_ and 20 letters or digits), and the mode import or undo");
  }
  const reads = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName: developer.signInTableName };
  return json((mode === "undo" ? await planCompanyImportUndo(reads, companyId.data) : await planCompanyImport(reads, companyId.data)).preview, requestId);
}

async function handleAdminOfferedModels(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  url: URL,
  requestId: string,
): Promise<BrokerHttpResponse> {
  if (dependencies.coreOfferedModels === undefined) throw agentXError("NOT_FOUND", CORE_OFFERED_MODELS_NOT_SET_UP);
  const signIn = dependencies.developer ?? dependencies.linking;
  const company = await offeredModelsCompany({
    named: url.searchParams.getAll(OFFERED_MODELS_COMPANY_PARAMETER),
    companies: signIn?.companies,
    ownerKey: identity.ownerKey,
    signIn: signIn === undefined ? undefined : { documentClient: dependencies.documentClient, signInTableName: signIn.signInTableName },
  });
  let offered: OfferedAgentModels;
  try { offered = await dependencies.coreOfferedModels(company); } catch { throw agentXError("RUNTIME_UNAVAILABLE", OFFERED_MODELS_READ_FAILED); }
  return json(offered, requestId);
}

async function dispatchAdminDirectoryAndHealth(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
  hooks: AdminHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  const modelCheck = /^\/v1\/admin\/e2e\/model-checks(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  if (modelCheck !== null && ((request.method === "POST" && modelCheck[1] === undefined) || (request.method === "GET" && (modelCheck[1] !== undefined || url.pathname.endsWith("/model-checks"))))) {
    requireAdminClaim(identity);
    return hooks.adminModelChecks(dependencies, request.method, modelCheck[1], body, request.requestId);
  }
  if (request.method !== "GET") return undefined;
  if (url.pathname === "/v1/admin/sign-in-clients") {
    requireAdminClaim(identity);
    const registry = (dependencies.developer ?? dependencies.linking)?.signInClients;
    if (registry === undefined) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
    return json({ clients: await registry.list(await resolveAdminCompany((dependencies.developer ?? dependencies.linking)?.companies, identity.ownerKey)) }, request.requestId);
  }
  if (url.pathname === "/v1/admin/company-invites") {
    requireAdminClaim(identity);
    const invites = dependencies.developer?.companyInvites;
    if (invites === undefined) throw agentXError("NOT_FOUND", "company sign-up is not set up in this deployment");
    return json(await invites.list(), request.requestId);
  }
  if (url.pathname === "/v1/admin/company-import") { requireAdminClaim(identity); return handleAdminCompanyImport(dependencies, url, request.requestId); }
  if (url.pathname === "/v1/admin/chatgpt") {
    requireAdminClaim(identity);
    if (!dependencies.chatgpt) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
    return json(await dependencies.chatgpt.health(), request.requestId);
  }
  if (url.pathname === CORE_OFFERED_MODELS_ADMIN_PATH) { requireAdminClaim(identity); return handleAdminOfferedModels(dependencies, identity, url, request.requestId); }
  if (url.pathname === "/v1/admin/turns") {
    requireAdminClaim(identity);
    if (!dependencies.turnRecords) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment");
    return json(await dependencies.turnRecords.page(url.searchParams), request.requestId);
  }
  return undefined;
}

async function dispatchAdminChannelAdapterRoute(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
  match: RegExpExecArray,
): Promise<BrokerHttpResponse | undefined> {
  const channels = channelAdapterDependencies(dependencies);
  const [, channel, tenant, space] = match;
  if (channel === undefined && request.method === "GET") return json(await listChannelAdapters(channels, identity), request.requestId);
  if (channel !== undefined && tenant === undefined && request.method === "PUT") {
    return json(await registerChannelAdapter(channels, identity, channel, body, { rotate: url.searchParams.get("rotate") === "true" }), request.requestId);
  }
  if (channel !== undefined && tenant === undefined && request.method === "DELETE") return json(await deleteChannelAdapter(channels, identity, channel), request.requestId);
  if (channel !== undefined && tenant !== undefined && space !== undefined && request.method === "PUT") {
    return json(await putChannelBinding(channels, identity, channel, tenant, space, body), request.requestId);
  }
  if (channel !== undefined && tenant !== undefined && space !== undefined && request.method === "DELETE") {
    return json(await deleteChannelBinding(channels, identity, channel, tenant, space), request.requestId);
  }
  return undefined;
}

async function dispatchAdminChannelsAndEvals(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
  hooks: AdminHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  const slackBinding = /^\/v1\/admin\/slack\/bindings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (slackBinding?.[1] && slackBinding[2] && request.method === "PUT") return json(await hooks.putSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2], body), request.requestId);
  if (slackBinding?.[1] && slackBinding[2] && request.method === "DELETE") return json(await hooks.deleteSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2]), request.requestId);
  const channelRoute = /^\/v1\/admin\/channels(?:\/([^/]+)(?:\/bindings\/([^/]+)\/([^/]+))?)?$/.exec(url.pathname);
  if (channelRoute !== null) {
    const handled = await dispatchAdminChannelAdapterRoute(dependencies, identity, request, url, body, channelRoute);
    if (handled !== undefined) return handled;
  }
  const adminLink = /^\/v1\/admin\/channel-links\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (adminLink !== null && request.method === "DELETE") {
    requireAdminClaim(identity);
    const links = channelLinkRouteDependencies(dependencies).channelLinks;
    if (links === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
    const actor = ActorRefSchema.safeParse({ channel: decodeURIComponent(adminLink[1]!), tenant: decodeURIComponent(adminLink[2]!), userId: decodeURIComponent(adminLink[3]!) });
    if (!actor.success || actor.data.channel === SLACK_CHANNEL) throw agentXError("NOT_FOUND", "link not found");
    return json(await removeLink(links, actor.data, undefined), request.requestId);
  }
  return dispatchAdminEvalRoutes(dependencies, identity, request, url, body);
}

async function dispatchAdminEvalRoutes(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
): Promise<BrokerHttpResponse | undefined> {
  if (url.pathname === "/v1/admin/evals/batches" && request.method === "POST") return json(await routeStartEvalBatch(dependencies, identity, body), request.requestId);
  const evalBatch = /^\/v1\/admin\/evals\/batches\/([0-9a-f-]{36})(?:\/(stop|results))?$/.exec(url.pathname);
  if (evalBatch?.[1]) {
    const action = evalBatch[2];
    if ((action === undefined || action === "results") && request.method === "GET") return json(await routeEvalBatch(dependencies, identity, evalBatch[1], action ?? "show"), request.requestId);
    if (action === "stop" && request.method === "POST") return json(await routeEvalBatch(dependencies, identity, evalBatch[1], "stop"), request.requestId);
  }
  const evalChannel = /^\/v1\/admin\/evals\/channels\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (evalChannel?.[1] && evalChannel[2] && (request.method === "PUT" || request.method === "DELETE" || request.method === "GET")) {
    return json(await routeSwebenchChannel(dependencies, identity, request.method, evalChannel[1], evalChannel[2], body), request.requestId);
  }
  return undefined;
}

async function dispatchAdminWorkspaceAndTaskOps(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  body: unknown,
  hooks: AdminHttpHooks,
): Promise<BrokerHttpResponse | undefined> {
  if (request.method === "POST" && url.pathname === "/v1/admin/workspaces/prepare") return json(await hooks.prepareWorkspace(dependencies, identity, body), request.requestId, 202);
  const cancelTask = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelTask?.[1]) return json(await hooks.cancelWorkspaceTask(dependencies, identity, cancelTask[1]), request.requestId, 202);
  const stop = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/stop$/.exec(url.pathname);
  if (request.method === "POST" && stop?.[1]) return json({ workspace: await hooks.stopWorkspace(dependencies, identity, stop[1]) }, request.requestId, 202);
  const taskE2EReplay = /^\/v1\/admin\/tasks\/([^/]+)\/e2e-replay$/.exec(url.pathname);
  if ((request.method === "POST" || request.method === "GET") && taskE2EReplay?.[1]) {
    return json(await hooks.adminTaskE2EReplay(dependencies, identity, taskE2EReplay[1], request.method, body, url.searchParams), request.requestId, request.method === "POST" ? 202 : 200);
  }
  const taskShareMode = /^\/v1\/admin\/tasks\/([^/]+)\/share-mode$/.exec(url.pathname);
  if (request.method === "POST" && taskShareMode?.[1]) return json(await hooks.adminTaskShareMode(dependencies, identity, taskShareMode[1], body, hooks.tasks), request.requestId);
  return undefined;
}

export async function dispatchAdminHttpRoute(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  request: AdaptedHttpRequest,
  url: URL,
  hooks: AdminHttpHooks,
): Promise<BrokerHttpResponse> {
  const webhookRetry = /^\/v1\/admin\/github\/webhook-deliveries\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
  if (request.method === "POST" && webhookRetry?.[1]) return json(await hooks.retryGithubWebhookAsAdministrator(dependencies, identity, webhookRetry[1]), request.requestId, 202);
  const projectSetupRetry = /^\/v1\/admin\/projects\/setup-executions\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
  if (request.method === "POST" && projectSetupRetry?.[1]) return json(await hooks.retryProjectSetupAsAdministrator(dependencies, identity, projectSetupRetry[1], parseBody(request.body)), request.requestId, 202);
  const body = parseBody(request.body);
  const changed = await routeAdminChange(hooks.adminChanges, identity, { method: request.method, headers: request.headers, body }, url);
  if (changed !== undefined) return json(changed.body, request.requestId, changed.status);
  const adminRead = await routeAdminRead(hooks.adminReads, identity, request, url);
  if (adminRead !== undefined) return json(adminRead, request.requestId);
  const handled = await dispatchAdminRuntimeAndSetup(dependencies, identity, request, url, body, hooks)
    ?? await dispatchAdminDirectoryAndHealth(dependencies, identity, request, url, body, hooks)
    ?? await dispatchAdminChannelsAndEvals(dependencies, identity, request, url, body, hooks)
    ?? await dispatchAdminWorkspaceAndTaskOps(dependencies, identity, request, url, body, hooks);
  if (handled !== undefined) return handled;
  throw agentXError("FORBIDDEN", "AgentX developer workflows run in the project's Slack channel; this endpoint serves administration only");
}
