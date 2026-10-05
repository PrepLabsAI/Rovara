import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cancelCallbackForbidden, verifyCancelCallbackCapability } from "./cancel-callback-capability.js";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AgentXError,
  CHANNEL_TURN_REQUEST_MAX,
  CheckReportSchema,
  LatestChecksSchema,
  PULL_REQUEST_BODY_MAX_CHARS,
  checksForSection,
  StandingFailuresSchema,
  checksMakeDraft,
  checksSection,
  nextStandingFailures,
  type StandingFailure,
  submitWorkflowArtifact,
  blockWorkflow,
  createCandidateManifest,
  recordWorkflowVerification,
  submitWorkflowReview,
  registerWorkflowPullRequest,
  taskResultChecks,
  type CheckEntry,
  type LatestChecks,
  CONNECTOR_SECRET_PREFIX,
  ChannelTurnSchema,
  DEVELOPER_TASK_OWNER_ISSUER,
  SharedTaskRecordSchema,
  sharedTaskKey,
  type SharedTaskRecord,
  ConnectorCallRequestSchema,
  GitHubMcpRequestSchema,
  OperationRequestSchema,
  PullRequestRequestSchema,
  PullRequestLifecycleRequestSchema,
  PullRequestLifecycleResultSchema,
  PullRequestResultSchema,
  ProjectDefinitionSchema,
  ProjectModelOptionsSchema,
  ProjectModelSelectionRequestSchema,
  approvedToolCount,
  githubConnectorOf,
  presentedNameProblems,
  toolBudget,
  TOOL_LIMIT,
  TOOL_WARNING_THRESHOLD,
  legacyProjectFields,
  SLACK_THREAD_OWNER_ISSUER,
  SlackChannelBindingSchema,
  SlackChannelIdSchema,
  SlackRequesterSchema,
  SlackThreadSchema,
  SlackTeamIdSchema,
  WorkspaceClosePreflightResultSchema,
  WorkspaceInstanceSchema,
  agentXError,
  parseSlackThreadSubject,
  slackThreadSubject,
  slackThreadUrl,
  unhandledDeploymentMode,
  workspaceProjectIndexAttributes,
  workspaceRecordFields,
  type Operation,
  type OperationRequester,
  type OperationStatus,
  type ChannelTurn,
  type CodeBuildCheckResult,
  type CodeBuildGateDefinition,
  type ProjectDefinition,
  type ProjectCommand,
  type RegistrationPreflight,
  type PullRequestLifecycleResult,
  type SlackChannelBinding,
  type SlackRequester,
  type SlackThread,
  type SlackThreadPrepareResult,
  type SlackThreadWorkspaceResult,
  type SlackWorkspaceCloseCompleteResult,
  type SlackWorkspaceCloseStartResult,
  type ThreadConnector,
  type WorkerInvocation,
  type WorkspaceInstance,
  type WorkflowSnapshot,
  type CandidateRepository,
  WORKFLOW_PLAN_MAX_BYTES,
  cleanDisplayName,
  redactAndCap,
  redactText,
  DISPLAY_NAME_MAX_ENCODED_LENGTH,
  modelKey,
  type ModelIdentifier,
  type ModelRef,
  type ModelSelection,
  type ProjectModelOptions,
  projectCatalogKey,
  type ChannelMembersRequest,
  isAdminChangePressEvent,
  type AdminChangeOutcome,
  type AdminChangePressEvent,
  INDEX_EXPIRY_ATTRIBUTE,
  indexExpiresAt,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { adminReader, queryAllItems, routeAdminRead, type AdminReadDependencies } from "./admin-reads.js";
import { outcomeMetric } from "./admin-change-audit.js";
import { pressAdminChange, routeAdminChange, type AdminChangeDependencies } from "./admin-changes.js";
import type { AdminChangeHandlers, PlanDependencies } from "./admin-change-plans.js";
import { ZodError } from "zod";
import { healthProbes } from "./health-probes.js";
import { recordPrepareFailureEvent } from "./operation-events.js";
import { releaseFailedPreparation, slackMemberLimitKey, slackOrganizationLimitKey, slackThreadKey } from "./failed-preparation.js";
import { releaseFailedCancelWorkspace } from "./failed-cancel-release.js";
import { assertNoUntrustedRoutingFields } from "../authorization.js";
import { appIdFromSecret, GitHubAppCredentialProvider, privateKeyFromSecret, webhookSecretFromSecret } from "../github-app.js";
import { GithubWebhookRefusal, GithubWebhookRetryableError, authorizeLinkedGithubWebhook, buildGithubFeedbackPlan, findLinkedGithubWorkflowPullRequest, handleGithubWebhook, listDueGithubWebhookDeliveries, processGithubWebhookDelivery, reconcileGithubWorkflowPullRequest, reconcileTaskPullRequestFeedback, recordLinkedGithubWorkflowFeedback, type ReceivedGithubWebhook } from "./github-webhooks.js";
import { CatalogCache, CredentialUnavailable } from "@agentx/gateway";
import { unsupportedThinkingLevels } from "@agentx/model-runtime/thinking-levels";
import { executeGitHubTool, toGitHubCatalog, type GitHubMcpDependencies } from "../github-mcp.js";
import { DynamoConnectorLedger, GITHUB_LEDGER } from "./connector-ledger.js";
import { observeConnectorRoute } from "./connector-metrics.js";
import { attributionDroppedLog, callConnector, connectorCatalogKey, discoverConnector, discoverLegacyGitHubScope, stripCode, type ConnectorContextBase, type ScopeDiscovery } from "./connector-routes.js";
import { resolveConnectors, BUILT_IN_CONNECTOR_TYPES, type ConnectorType, type ConnectorTypeContext, type ResolvedConnector } from "./connector-types.js";
import { CredentialRegistry, secretsManagerSource, type ConnectorCredentialsConfiguration } from "./credentials.js";
import { developerTokenVerifier } from "../developer/verify-token.js";
import {
  TERMINAL, getItem, issueCapability, operationKey, operationRecord, outboxRecord, publicOperation, requestCancellation, requireOperation,
  type CallbackClaims, type OperationRecord,
} from "./cancellation.js";
import { aiToolTurn, completedTurn, developerFooter, githubWorkflowPullRequestKey, inertName, OUTCOME, partyOfTask, taskKey, taskOwnerKey, taskOwnerSubject, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type GithubWorkflowPullRequestRecord, type StoredEvent } from "../developer/task-records.js";
import { readWorkspaceLimits } from "../developer/limits.js";
import { AWS_TEMPORARY_MESSAGE, UNEXPECTED_REQUEST_MESSAGE, hashJson, isConditional, isTemporaryAwsError, workerPrompt } from "./broker-shared.js";
import { channelByNameThroughLambda, channelInfoThroughLambda, channelMembersThroughLambda, developerKeysThroughLambda, developerSinceFromEnvironment, developerTaskRouteDependencies, endDeveloperSessionsThroughLambda, routeDeveloperRequest, slackAuthCheckThroughLambda, slackUserByEmailThroughLambda, type DeveloperApiConfiguration, type DeveloperCaller } from "./developer-routes.js";
import type { DeveloperTaskActions, ExtraItems, TransactItems } from "./developer-task-actions.js";
import { adminShareMode, finishTaskClose, routeDeveloperTaskRequest } from "./developer-tasks.js";
import { credentialRefusals, preflightConnectors, registrationWarnings, type PreflightOutcome } from "./registration-preflight.js";
import { TurnRecordExport, dynamoTurnRecordSource, workspaceProjectReader } from "./turns.js";
import { createCodeBuildGateway, type CodeBuildGateway } from "../codebuild.js";
import { RepositoryGrantService } from "../repository-access.js";
import { publicWorkspace } from "../workspaces.js";
import { SessionManager } from "./sessions.js";
import { STUCK_SETUP_MESSAGE } from "./stuck-setup.js";
import {
  adaptHttpApiEvent,
  identityFromJwtClaims,
  isAssumedRoleOf,
  ownerKeyForSubject,
  parseRuntimeBinding,
  requiredEnvironment,
  type AdaptedHttpRequest,
  type HttpApiV2Event,
  type RuntimeBinding,
} from "./lambda.js";
import {
  deleteSwebenchChannel,
  getSwebenchChannel,
  getSwebenchRunForThread,
  handleSwebenchCallback,
  isSwebenchCallbackPath,
  putSwebenchChannel,
  startSwebenchRun,
  stopSwebenchRun,
  type SwebenchSlackContext,
} from "./swebench.js";
import { withEvalBatches, type EvalBatchDependencies } from "./eval-batch.js";
import { dropWatchedBatch, listWatchedBatches, recordWatchedBatchThread, startSlackBatch, updateWatchedBatch } from "./eval-batch-service.js";
import { batchResults, parseStartBody, requireBatchProject, showBatch, startBatch, stopBatchById } from "./eval-batch-admin.js";
import { swebenchDeploymentFromParameters } from "./swebench-settings.js";

const MAX_ARTIFACT_BYTES = 5_000_000;
const EVENT_TRANSACTION_CHUNK = 80;

export interface RegisteredProjectRecord {
  pk: string;
  sk: string;
  entityType: "PROJECT";
  definition: ProjectDefinition;
  runtimeBinding: RuntimeBinding;
  registeredBy: string;
  registeredAt: string;
}

interface MembershipRecord {
  pk: string;
  sk: string;
  entityType: "MEMBERSHIP";
  ownerKey: string;
  projectName: string;
  role: "developer" | "administrator";
}

interface ProjectModelSelectionRecord {
  pk: string;
  sk: "SELECTION";
  entityType: "PROJECT_MODEL_SELECTION";
  model: ModelIdentifier;
  updatedAt: string;
  updatedBy: SlackRequester;
}

interface PullRequestRecord {
  pk: string;
  sk: string;
  entityType: "PULL_REQUEST";
  workspaceId: string;
  repository: string;
  repositoryUrl: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  expectedHeadCommit: string;
  title: string;
  body: string;
  createdByOperationId: string;
  replacedBy?: number;
  replacementFor?: number;
  updatedAt: string;
}

interface CodeBuildRecord {
  pk: string;
  sk: string;
  entityType: "CODEBUILD";
  workspaceId: string;
  operationId: string;
  fence: number;
  repository: string;
  gate: string;
  projectName: string;
  requestedSourceVersion: string;
  idempotencyToken: string;
  buildId: string;
  evidence: CodeBuildCheckResult;
  createdAt: string;
  updatedAt: string;
}

interface AwsBrokerDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: S3Client;
  /** Starts deleting an ec2-ebs workspace's instance and volume (#84). */
  deleteEc2Session?: (workspaceId: string) => Promise<void>;
  tableName: string;
  artifactBucketName: string;
  issuer: string;
  adminClaim: string;
  adminValues: readonly string[];
  callbackSigningKey: string;
  repositoryGrants: RepositoryGrantService;
  githubPullRequests: Pick<GitHubAppCredentialProvider, "reconcilePullRequest" | "getPullRequest" | "updatePullRequest" | "verifyWebhookRepository"> & Partial<Pick<GitHubAppCredentialProvider, "getPullRequestChangedFiles" | "getPullRequestFeedback">>;
  /** Reads the GitHub webhook HMAC key from the configured GitHub App secret. */
  githubWebhookSecret?: () => Promise<string>;
  /** Refuses, with CONFIG_INVALID, a repository its credential cannot reach; checked at registration. */
  checkRepositoryAccess?: (repository: { credentialRef: string; url: string }) => Promise<void>;
  codeBuild: CodeBuildGateway;
  slack?: SlackServiceConfiguration;
  /** Spec 025 developer sign-in; absent when the deployment has none, and /v1/dev/* answers NOT_FOUND. */
  developer?: DeveloperApiConfiguration;
  githubMcp?: GitHubMcpDependencies;
  catalogs: CatalogCache<ScopeDiscovery>;
  credentialRegistry?: CredentialRegistry;
  /** The administrator turn record export; absent when the deployment has no TurnRecords table. */
  turnRecords?: TurnRecordExport;
  /** The TurnRecords table developer task audit records go to (spec 025); absent when there is none. */
  turnRecordsTableName?: string;
  /** Connector types this deployment serves; the built-in types when absent. */
  connectorTypes?: Record<string, ConnectorType>;
  /** Spec 025 C14: the Slack threads table, read for a shared thread's waiting messages; absent in legacy. */
  slackThreadsTableName?: string;
  /** Spec 025 phase 25d: the admin read routes' injected probes and clock; the defaults serve production. */
  adminReads?: Partial<Pick<AdminReadDependencies, "me" | "health" | "now" | "log">>;
  /** Spec 025 phase 25e: the admin changes' method switch, clock and metric; the defaults serve production. */
  adminChanges?: { confirm?: { elicitation: boolean; slack: boolean }; now?: () => number; metric?: (outcome: AdminChangeOutcome) => void };
  /** Spec 043: SWE-bench runs; absent in a harness that does not exercise them. */
  swebench?: Pick<EvalBatchDependencies, "deployment" | "startExecution" | "stopBatchForThread" | "onRunEnded" | "now" | "estimateRunCostUsd">;
}

/**
 * What callers supply; the handler creates the per-container catalog cache when none is given, and
 * the credential registry from `connectorCredentials` unless one is injected, and the turn record
 * export from `turnRecordsTableName` unless one is injected.
 */
export type AwsBrokerInput = Omit<AwsBrokerDependencies, "catalogs"> & {
  catalogs?: CatalogCache<ScopeDiscovery>;
  connectorCredentials?: ConnectorCredentialsConfiguration;
  turnRecordsTableName?: string;
};

interface SlackServiceConfiguration {
  orchestratorRoleArn: string;
  memberWorkspaceLimit: number;
  organizationWorkspaceLimit: number;
}

/** A "." or ".." path segment, also percent-encoded (%2e in any case). */
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
const DEVELOPER_ROUTE_KEY = "ANY /v1/dev/{proxy+}";

/** The handler's dependencies from what callers supply (see AwsBrokerInput). */
function brokerDependencies(input: AwsBrokerInput): AwsBrokerDependencies {
  // One cache per container: discovery per revision, connector and repository costs one vendor round trip.
  const { connectorCredentials, turnRecordsTableName, ...rest } = input;
  const credentialRegistry = input.credentialRegistry ?? (connectorCredentials
    ? new CredentialRegistry({ ...connectorCredentials, documentClient: input.documentClient, tableName: input.tableName })
    : undefined);
  const turnRecords = input.turnRecords ?? (turnRecordsTableName
    ? new TurnRecordExport({
        source: dynamoTurnRecordSource(input.documentClient, turnRecordsTableName),
        projectOf: workspaceProjectReader(input.documentClient, input.tableName),
      })
    : undefined);
  return {
    ...rest,
    catalogs: input.catalogs ?? new CatalogCache<ScopeDiscovery>({ ttlMs: 600_000, maxEntries: 256 }),
    ...(credentialRegistry ? { credentialRegistry } : {}),
    ...(turnRecords ? { turnRecords } : {}),
    ...(turnRecordsTableName ? { turnRecordsTableName } : {}),
  };
}

/** The broker actions developer task routes call (spec 025); tests and the route wiring use this factory. */
export function createDeveloperTaskActions(input: AwsBrokerInput): DeveloperTaskActions {
  return developerTaskActions(brokerDependencies(input));
}

/** Spec 025 phase 25d: what the admin read routes need, from the broker's own dependencies. */
function adminReadDependencies(dependencies: AwsBrokerDependencies): AdminReadDependencies {
  const developer = dependencies.developer;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: dependencies.turnRecordsTableName }),
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turns: dynamoTurnRecordSource(dependencies.documentClient, dependencies.turnRecordsTableName) }),
    ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    ...(developer?.channelInfo === undefined ? {} : { channelInfo: developer.channelInfo }),
    ...(developer === undefined ? {} : { channelMembers: (request: ChannelMembersRequest) => developer.channelMembers(request) }),
    limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
    now: Date.now,
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    ...dependencies.adminReads,
  };
}

/** Spec 025 phase 25e: the existing admin handlers a confirmed change applies through (FR-040). */
function adminChangeHandlers(dependencies: AwsBrokerDependencies): AdminChangeHandlers {
  return {
    requireAdministrator: (identity, project) => requireAdministrator(dependencies, identity, project),
    bindChannel: async (identity, teamId, channelId, project) => putSlackBinding(dependencies, identity, teamId, channelId, { projectName: project }),
    unbindChannel: async (identity, teamId, channelId) => deleteSlackBinding(dependencies, identity, teamId, channelId),
    checkRevision: async (identity, definitionValue, runtimeBindingValue, options) => {
      if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
      let definition: ProjectDefinition;
      try {
        ({ definition } = parseRegistrationInput({ definition: definitionValue, runtimeBinding: runtimeBindingValue }));
      } catch (error) {
        // registerProject answers a schema failure as the route does; a plan names the first problem.
        if (!(error instanceof ZodError)) throw error;
        const issue = error.issues[0];
        throw agentXError("CONFIG_INVALID", `the project definition is invalid: ${issue?.path.join(".") || "definition"}: ${issue?.message ?? "invalid"}; fix it and plan again`);
      }
      if (await getItem(dependencies, projectKey(definition.name, definition.revision)) !== undefined) {
        throw agentXError("CONFIG_INVALID", `revision ${definition.revision} of ${definition.name} is already registered; use a newer revision number`);
      }
      // C8: the vendor preflight runs here, at planning, and never again at apply: neither in the
      // apply's re-plan (preflight: false, final review M1) nor in its registration.
      const preflight = await registrationChecks(dependencies, identity, definition, options?.preflight !== false);
      return { definition, warnings: registrationWarnings(toolBudget(approvedToolCount(definition)).warning, preflight) };
    },
    registerRevision: async (identity, definition, runtimeBinding) => {
      // E6, FR-015: the applier must still administer the project; registerProject itself checks only the claim.
      await requireAdministrator(dependencies, identity, definition.name);
      return registerProject(dependencies, identity, { definition, runtimeBinding, preflight: false });
    },
    registerCredential: async (identity, registration) => {
      if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment; ask whoever deploys AgentX to set them up");
      return dependencies.credentialRegistry.register(identity, registration);
    },
    cancelWorkspaceTask: async (identity, workspaceId) => cancelWorkspaceTask(dependencies, identity, workspaceId),
  };
}

/** Spec 025 phase 25e: what change plans read and apply through; tests build it the same way. */
export function createPlanDependencies(input: AwsBrokerInput): PlanDependencies {
  return planDependencies(brokerDependencies(input));
}

function planDependencies(dependencies: AwsBrokerDependencies): PlanDependencies {
  const developer = dependencies.developer;
  const registry = dependencies.credentialRegistry;
  return {
    reads: adminReadDependencies(dependencies),
    actions: {
      documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      ...(developer === undefined ? {} : { signInTableName: developer.signInTableName }),
      ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
      limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
      ...(developer?.endDeveloperSessions === undefined ? {} : { endDeveloperSessions: developer.endDeveloperSessions }),
      now: Date.now,
    },
    handlers: adminChangeHandlers(dependencies),
    ...(developer?.channelByName === undefined ? {} : { channelByName: developer.channelByName }),
    ...(registry === undefined ? {} : { credentials: registry, builtInCredentialRef: registry.builtInRef }),
    // C5: the prefix the registry itself enforces.
    connectorSecretPrefix: registry?.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX,
  };
}

/** Spec 025 phase 25e: admin changes exist only with developer sign-in and a TurnRecords table (D14). */
function adminChangeDependencies(dependencies: AwsBrokerDependencies, reads: AdminReadDependencies): AdminChangeDependencies | undefined {
  const developer = dependencies.developer;
  if (developer === undefined || dependencies.turnRecordsTableName === undefined) return undefined;
  const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry }));
  const reader = adminReader(reads);
  const now = dependencies.adminChanges?.now ?? Date.now;
  return {
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    audit: {
      documentClient: dependencies.documentClient, tableName: dependencies.turnRecordsTableName, log,
      metric: dependencies.adminChanges?.metric ?? outcomeMetric(process.env.AGENTX_METRICS_NAMESPACE || "AgentX"),
    },
    plans: planDependencies(dependencies),
    ...(reader === undefined ? {} : { identity: reader }),
    ...(developer.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    // E16: the environment's pop-up switch. R5: Slack is a method wherever a Slack team is set up,
    // whatever Slack sign-in says; each change still needs the admin's own linked Slack user (FR-041).
    confirm: dependencies.adminChanges?.confirm ?? { elicitation: process.env.MCP_CONFIRM_ELICITATION !== "disabled", slack: developer.slackTeamId !== undefined },
    now,
    newId: randomUUID,
    log,
  };
}

function developerTaskActions(dependencies: AwsBrokerDependencies): DeveloperTaskActions {
  /** Every page of a partition's items under a prefix (the admin reads' shared query loop). */
  const query = (pk: string, prefix: string) => queryAllItems(dependencies, pk, prefix);
  return {
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName ? { turnRecordsTableName: dependencies.turnRecordsTableName } : {}),
    limitDefaults: {
      member: dependencies.slack?.memberWorkspaceLimit ?? 3,
      organization: dependencies.slack?.organizationWorkspaceLimit ?? 20,
    },
    latestProject: (name) => requireLatestProject(dependencies, name).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    projectRevision: (name, revision) => requireProject(dependencies, name, revision).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    preparation: (identity, project, requestId) => newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId),
    workspace: (id) => requireWorkspace(dependencies, id),
    operations: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "OPERATION#"))
      .filter((item) => item.entityType === "OPERATION")
      .map((item) => publicOperation(item as unknown as OperationRecord)),
    eventsNewestFirst: (operationId, limit) => operationEventsNewestFirst(dependencies, operationId, limit),
    artifacts: async (workspaceId, operationId) => (await query(`WORKSPACE#${workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operationId)
      .map((item) => ({
        id: String(item.id), operationId: String(item.operationId), name: String(item.name), mediaType: String(item.mediaType), objectKey: String(item.objectKey),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      })),
    readArtifact: async (objectKey, maxBytes) => {
      const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Range: `bytes=0-${maxBytes - 1}` }));
      return object.Body ? await object.Body.transformToString("utf8") : "";
    },
    pullRequests: async (workspaceId) => (await query(`WORKSPACE#${workspaceId}`, "PULL_REQUEST#"))
      .map((item) => ({ repository: String(item.repository), number: Number(item.number), url: String(item.url), state: item.state as "open" | "closed" | "merged" })),
    acceptTask: (identity, workspaceId, request, extra, options) => acceptTask(dependencies, identity, workspaceId, request, extra, options),
    acceptPullRequest: (identity, workspaceId, request, extra) => acceptPullRequest(dependencies, identity, workspaceId, request, extra),
    cancelRunning: async (identity, workspace, extra) => {
      if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
      const result = await cancelRunningTask(dependencies, workspace, requesterOf(identity), extra);
      return result.outcome === "CANCEL_REQUESTED"
        ? { outcome: "CANCEL_REQUESTED", targetOperationId: result.targetOperationId, cancelOperationId: result.cancelOperationId }
        : { outcome: "NOTHING_RUNNING" };
    },
    startClose: (identity, workspace, requestId, extra) => startTaskClose(dependencies, identity, workspace, requestId, extra),
    deleteCompute: (workspace) => deleteWorkspaceCompute(dependencies, workspace),
    transact: async (items) => {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    },
    channelActivity: async ({ taskId, operationId, threadSubject }) => {
      const marker = await getItem<{ slackUserId?: unknown; name?: unknown }>(dependencies, { pk: `DEVTASK#${taskId}`, sk: `CHANNEL_OPERATION#${operationId}` });
      let waiting = 0;
      if (marker !== undefined && dependencies.slackThreadsTableName !== undefined) {
        try {
          const thread = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.slackThreadsTableName, Key: { pk: `THREAD#${threadSubject}`, sk: "META" } })) as { Item?: { pendingRequests?: unknown } };
          const pending = Number(thread.Item?.pendingRequests ?? 0);
          // F18: the running turn may still be one of the thread's pending requests, or may have
          // answered already while its operation runs on, so pending - 1 is a floor, not a count.
          waiting = Number.isFinite(pending) ? Math.max(0, pending - 1) : 0;
        } catch (error) {
          console.log(JSON.stringify({ component: "broker", event: "developer.channel_waiting_unread", taskId, error: error instanceof Error ? error.name : "unknown" }));
        }
      }
      return {
        ...(typeof marker?.slackUserId === "string" ? { driver: { slackUserId: marker.slackUserId, ...(typeof marker.name === "string" ? { name: marker.name } : {}) } } : {}),
        waiting,
      };
    },
    channelTurns: async (threadSubject, taskId, limit) => {
      const table = dependencies.turnRecordsTableName;
      if (table === undefined) return [];
      const found: Array<Record<string, unknown>> = [];
      let startKey: Record<string, unknown> | undefined;
      // A thread's records are few (the thread's rate limit caps them); five pages bound the read anyway.
      const MAX_PAGES = 5;
      let pages = 0;
      for (; pages < MAX_PAGES; pages += 1) {
        const response = await dependencies.documentClient.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `THREAD#${threadSubject}`, ":prefix": "TURN#" },
          ScanIndexForward: false,
          Limit: 100,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }));
        // A record whose time is not a timestamp cannot be shown (the view's `at` is one), so it is left out.
        found.push(...(response.Items ?? []).filter((item) => item.taskId === taskId && ChannelTurnSchema.shape.at.safeParse(item.receivedAt).success));
        startKey = response.LastEvaluatedKey;
        if (startKey === undefined || found.length >= limit) break;
      }
      if (pages === MAX_PAGES && startKey !== undefined) {
        // Counts only: the records hold teammates' text.
        console.log(JSON.stringify({ component: "broker", event: "developer.channel_turns_capped", pages, found: found.length }));
      }
      const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
      return found.slice(0, limit).map((item): ChannelTurn => {
        const requester = item.requestedBy as { userId?: unknown } | undefined;
        return {
          // Only who spoke, when, the capped request and the outcome: never the reply or the channel's name (FR-036).
          author: { slackUserId: text(requester?.userId, "unknown"), ...(typeof item.requesterName === "string" ? { name: item.requesterName } : {}) },
          at: text(item.receivedAt, ""),
          // Stored redacted; redacted again here, so a record from an older writer cannot leak.
          request: redactAndCap(text(item.requestText, ""), CHANNEL_TURN_REQUEST_MAX).text,
          outcome: text(item.disposition, "unknown"),
        };
      });
    },
  };
}

export function createAwsBrokerHandler(input: AwsBrokerInput) {
  const dependencies = brokerDependencies(input);
  if (Buffer.byteLength(dependencies.callbackSigningKey, "utf8") < 32) {
    throw new Error("CALLBACK_SIGNING_KEY must contain at least 32 bytes");
  }
  // Spec 025: the broker actions the developer task routes call, built once per handler.
  const tasks = developerTaskActions(dependencies);
  const adminReads = adminReadDependencies(dependencies);
  const adminChanges = adminChangeDependencies(dependencies, adminReads);
  return async (event: HttpApiV2Event | SlackStopTaskEvent | SlackWorkflowStartEvent | SlackWorkflowDecisionEvent | AdminChangePressEvent | { source: "agentx.github-webhook-recovery" }): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    // Spec 025 E14: a Slack Confirm or Cancel press, invoked directly by the ingress (never through API Gateway).
    if (isAdminChangePressEvent(event)) {
      if (adminChanges === undefined) return json({ error: { code: "NOT_FOUND", message: "admin changes are not set up in this deployment" } }, "slack-ingress", 404);
      try {
        return json(await pressAdminChange(adminChanges, event), "slack-ingress");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "admin_change.press_failed", changeId: event.changeId, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
        return json({ outcome: "failed", changeId: event.changeId }, "slack-ingress", 500);
      }
    }
    if (isGithubWebhookRecoveryEvent(event)) {
      try { return json(await retryDueGithubWebhookEvents(dependencies), "github-webhook-recovery"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "github.webhook_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "recovery_failed" }, "github-webhook-recovery", 500);
      }
    }
    if (isSlackStopTaskEvent(event)) {
      try {
        return json(await stopSlackThreadTask(dependencies, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) {
          return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        }
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackWorkflowStartEvent(event)) {
      try {
        const task = await startSlackWorkflow(dependencies, tasks, event);
        return json({ taskId: task.task.taskId }, "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackWorkflowDecisionEvent(event)) {
      try {
        return json(await decideSlackWorkflow(dependencies, tasks, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackWorkflowFeedbackDecisionEvent(event)) {
      try {
        return json(await decideSlackWorkflowFeedback(dependencies, tasks, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    const request = adaptHttpApiEvent(event);
    try {
      // Checked on the raw path, before URL parsing normalizes it: /v1/dev/../v1/admin/x reaches
      // the broker through the authorizer-free /v1/dev route (D17), so it must never be resolved.
      if (DOT_SEGMENT.test(event.rawPath ?? "/")) throw agentXError("NOT_FOUND", "route not found");
      const url = new URL(request.path, "https://agentx.invalid");
      // The /v1/dev route has no API Gateway authorizer, so what it carries goes to the developer API or nowhere.
      if (event.routeKey === DEVELOPER_ROUTE_KEY && !url.pathname.startsWith("/v1/dev/")) throw agentXError("NOT_FOUND", "route not found");
      if (url.pathname === "/v1/github/webhooks") {
        if (request.method !== "POST") return json({ error: { code: "NOT_FOUND", message: "route not found" } }, request.requestId, 404);
        if (request.body === undefined || dependencies.githubWebhookSecret === undefined) {
          return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook handling is not configured" } }, request.requestId, 503);
        }
        try {
          const result = await handleGithubWebhook({
            documentClient: dependencies.documentClient,
            tableName: dependencies.tableName,
            rawBody: request.body,
            headers: request.headers,
            secret: await dependencies.githubWebhookSecret(),
            authorizeRepository: (scope) => authorizeLinkedGithubWebhook({
              documentClient: dependencies.documentClient,
              tableName: dependencies.tableName,
              scope,
              loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
              repositoryUrl: async (projectName, revision, repositoryId) => {
                const project = await requireProject(dependencies, projectName, revision);
                return project.definition.repositories.find((repository) => repository.name === repositoryId)?.url;
              },
              verifyRepository: (repositoryUrl, webhookScope) => dependencies.githubPullRequests.verifyWebhookRepository(repositoryUrl, webhookScope),
            }),
            process: (workflowEvent, deliveryId) => processGithubWorkflowEvent(dependencies, workflowEvent, deliveryId),
            now: () => new Date().toISOString(),
          });
          if (result.status === "IN_PROGRESS") return json({ delivery: result.status, deliveryId: result.deliveryId }, request.requestId, 503);
          return json({ delivery: result.status, deliveryId: result.deliveryId }, request.requestId);
        } catch (error) {
          if (error instanceof GithubWebhookRefusal) return json({ error: { code: "FORBIDDEN", message: error.message } }, request.requestId, 403);
          if (error instanceof GithubWebhookRetryableError) return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook processing will be retried" } }, request.requestId, 503);
          if (error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE") return json({ error: { code: error.code, message: "GitHub webhook processing will be retried" } }, request.requestId, 503);
          throw error;
        }
      }
      // Spec 043: an eval runner's callbacks, authorized by the run's own capability.
      const evalCallback = isSwebenchCallbackPath(url.pathname);
      if (request.method === "POST" && evalCallback !== undefined) {
        return json(await handleSwebenchCallback(swebenchDependencies(dependencies), request.headers["x-agentx-callback-capability"], evalCallback.runId, evalCallback.action, parseBody(request.body)), request.requestId);
      }
      // Internal worker routes authenticate with operation-scoped capabilities; user JWT auth starts below them.
      const callback = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/(events|artifacts|result|pull-request|pull-request-update|codebuild)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && callback?.[1] && callback[2] && callback[3]) {
        return await handleCallback(dependencies, request, callback[1], callback[2], callback[3]);
      }
      const credentialExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/repository-credentials$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && credentialExchange?.[1] && credentialExchange[2]) {
        return json(
          {
            credential: await exchangeRepositoryCredential(
              dependencies,
              request,
              credentialExchange[1],
              credentialExchange[2],
            ),
          },
          request.requestId,
        );
      }

      // The hosted Slack orchestrator authenticates with its IAM role and acts only as a Slack thread owner.
      if (url.pathname.startsWith("/v1/service/")) {
        const serviceUrl = new URL(`/v1${url.pathname.slice("/v1/service".length)}${url.search}`, "https://agentx.invalid");
        // Spec 052 Task 6: the batch watcher's list is the whole Slack service's, not one thread's.
        if (request.method === "GET" && serviceUrl.pathname === "/v1/evals/batches/active") {
          requireSlackServiceRole(dependencies, request);
          if (dependencies.swebench === undefined) return json({ batches: [], dropped: [] }, request.requestId);
          return json(await listWatchedBatches(swebenchDependencies(dependencies), async (teamId, channelId) => (await getSlackBinding(dependencies, teamId, channelId))?.projectName), request.requestId);
        }
        const identity = await slackServiceIdentity(dependencies, request);
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace") {
          return json(await ensureThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/prepare") {
          return json(await prepareThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close") {
          return json(await startThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId, 202);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close/complete") {
          return json(await completeThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "GET" && serviceUrl.pathname === "/v1/project/models") {
          return json(await getProjectModels(dependencies, identity), request.requestId);
        }
        if (request.method === "PUT" && serviceUrl.pathname === "/v1/project/model") {
          return json(await putProjectModel(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/evals/swebench") {
          return json(await startSwebenchRun(swebenchDependencies(dependencies), swebenchSlackContext(dependencies, identity), parseBody(request.body)), request.requestId);
        }
        // Spec 052 FR-002 and Task 6: the Slack batch form, and the watcher's thread and posts for one batch.
        if (request.method === "POST" && serviceUrl.pathname === "/v1/evals/batches") {
          return json(await startSlackBatch(swebenchDependencies(dependencies), swebenchSlackContext(dependencies, identity), parseBody(request.body)), request.requestId);
        }
        const watchedBatch = /^\/v1\/evals\/batches\/([0-9a-f-]{36})\/(thread|watch|drop)$/.exec(serviceUrl.pathname);
        if (request.method === "POST" && watchedBatch?.[1] && watchedBatch[2]) {
          const slack = identity.slack;
          if (!slack) throw agentXError("FORBIDDEN", "Slack thread context is required");
          const scope = { thread: slack.thread, projectName: slack.binding.projectName };
          const swebench = swebenchDependencies(dependencies);
          const body = parseBody(request.body);
          const answer = watchedBatch[2] === "thread" ? await recordWatchedBatchThread(swebench, scope, watchedBatch[1], body)
            : watchedBatch[2] === "drop" ? await dropWatchedBatch(swebench, scope, watchedBatch[1], body)
            : await updateWatchedBatch(swebench, scope, watchedBatch[1], body);
          return json(answer, request.requestId);
        }
        const evalRun = /^\/v1\/evals\/swebench\/([0-9a-f-]{36})$/.exec(serviceUrl.pathname);
        if (request.method === "GET" && evalRun?.[1]) {
          const thread = identity.slack?.thread;
          if (!thread) throw agentXError("FORBIDDEN", "Slack thread context is required");
          return json({ run: await getSwebenchRunForThread(swebenchDependencies(dependencies), thread, evalRun[1]) }, request.requestId);
        }
        return await observeConnectorRoute(request.method, serviceUrl.pathname, () => routeWorkspaceRequest(dependencies, request, serviceUrl, identity));
      }

      // Spec 025: the developer API. /v1/dev/* has no API Gateway authorizer (D17): the broker
      // verifies the developer token, then checks the method and session (FR-009).
      if (url.pathname.startsWith("/v1/dev/")) {
        if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
        return json(await routeDeveloperRequest({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, request, url), request.requestId);
      }

      const identity = identityFromJwtClaims(request.jwtClaims, {
        issuer: dependencies.issuer,
        adminClaim: dependencies.adminClaim,
        adminValues: dependencies.adminValues,
      });
      const webhookRetry = /^\/v1\/admin\/github\/webhook-deliveries\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
      if (request.method === "POST" && webhookRetry?.[1]) {
        return json(await retryGithubWebhookAsAdministrator(dependencies, identity, webhookRetry[1]), request.requestId, 202);
      }
      const body = parseBody(request.body);
      // Spec 025 phase 25e: admin changes (FR-039 to FR-041, FR-052).
      const changed = await routeAdminChange(adminChanges, identity, { method: request.method, headers: request.headers, body }, url);
      if (changed !== undefined) return json(changed.body, request.requestId, changed.status);
      // Spec 025 phase 25d: the admin read routes (FR-038), each behind the admin claim (A2).
      const adminRead = await routeAdminRead(adminReads, identity, request, url);
      if (adminRead !== undefined) return json(adminRead, request.requestId);

      if (request.method === "POST" && url.pathname === "/v1/admin/projects") {
        return json(await registerProject(dependencies, identity, body), request.requestId, 201);
      }
      if (url.pathname === "/v1/admin/credentials" && (request.method === "POST" || request.method === "GET")) {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
        return request.method === "POST"
          ? json(await dependencies.credentialRegistry.register(identity, body), request.requestId, 201)
          : json(await dependencies.credentialRegistry.list(identity), request.requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/turns") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.turnRecords) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment");
        return json(await dependencies.turnRecords.page(url.searchParams), request.requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/workspaces/prepare") {
        return json(await prepareWorkspace(dependencies, identity, body), request.requestId, 202);
      }
      const slackBinding = /^\/v1\/admin\/slack\/bindings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (slackBinding?.[1] && slackBinding[2] && request.method === "PUT") {
        return json(await putSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2], body), request.requestId);
      }
      if (slackBinding?.[1] && slackBinding[2] && request.method === "DELETE") {
        return json(await deleteSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2]), request.requestId);
      }
      // Spec 052: batches of eval runs, started, shown, stopped and read by an administrator of the channel's project.
      if (url.pathname === "/v1/admin/evals/batches" && request.method === "POST") {
        return json(await routeStartEvalBatch(dependencies, identity, body), request.requestId);
      }
      const evalBatch = /^\/v1\/admin\/evals\/batches\/([0-9a-f-]{36})(?:\/(stop|results))?$/.exec(url.pathname);
      if (evalBatch?.[1]) {
        const action = evalBatch[2];
        if ((action === undefined || action === "results") && request.method === "GET") {
          return json(await routeEvalBatch(dependencies, identity, evalBatch[1], action ?? "show"), request.requestId);
        }
        if (action === "stop" && request.method === "POST") return json(await routeEvalBatch(dependencies, identity, evalBatch[1], "stop"), request.requestId);
      }
      const evalChannel = /^\/v1\/admin\/evals\/channels\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (evalChannel?.[1] && evalChannel[2] && (request.method === "PUT" || request.method === "DELETE" || request.method === "GET")) {
        return json(await routeSwebenchChannel(dependencies, identity, request.method, evalChannel[1], evalChannel[2], body), request.requestId);
      }
      const cancelTask = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelTask?.[1]) {
        return json(await cancelWorkspaceTask(dependencies, identity, cancelTask[1]), request.requestId, 202);
      }
      const stop = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/stop$/.exec(url.pathname);
      if (request.method === "POST" && stop?.[1]) {
        return json({ workspace: await stopWorkspace(dependencies, identity, stop[1]) }, request.requestId, 202);
      }
      // Spec 025 C25: an admin switches a shared task's mode, within its project's policy.
      // Any segment: a mistyped task ID gets TASK_NOT_FOUND from the handler, not the catch-all refusal.
      const taskShareMode = /^\/v1\/admin\/tasks\/([^/]+)\/share-mode$/.exec(url.pathname);
      if (request.method === "POST" && taskShareMode?.[1]) {
        return json(await adminTaskShareMode(dependencies, identity, taskShareMode[1], body, tasks), request.requestId);
      }

      // Developer workflows run in Slack threads, which reach the same handlers through
      // /v1/service/*. The OIDC entry point serves administration only.
      throw agentXError(
        "FORBIDDEN",
        "AgentX developer workflows run in the project's Slack channel; this endpoint serves administration only",
      );
    } catch (error) {
      if (error instanceof AgentXError) {
        return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, request.requestId, error.statusCode);
      }
      return unexpectedErrorAnswer(error, request.requestId);
    }
  };
}

/**
 * Where an error was thrown: its stack's first frame, a location that carries no data. Read only
 * after the stack's header, so a message that spans lines can never be mistaken for a frame.
 */
function thrownAt(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  // Node writes the bare name when the message is empty.
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  if (!error.stack.startsWith(header)) return undefined;
  return error.stack.slice(header.length).split("\n").map((line) => line.trim()).find((line) => line.startsWith("at "));
}

/**
 * Issue #48: the answer to an error that is not an AgentXError. A temporary AWS error answers 503
 * RUNTIME_UNAVAILABLE, so the caller tries again; any other keeps CONFIG_INVALID. Apart from a
 * schema refusal or a CredentialUnavailable, no answer carries the error's own words, and the log
 * carries only its name and, for an unexpected one, where it was thrown.
 */
function unexpectedErrorAnswer(error: unknown, requestId: string): { statusCode: number; headers: Record<string, string>; body: string } {
  // A schema refusal is AgentX's own words: zod 4 never quotes the raw input, though a refinement
  // may name the admin's own values, such as a repository name. A CredentialUnavailable is too: it
  // names only credential references and secret names, never a secret.
  if (error instanceof ZodError || error instanceof CredentialUnavailable) {
    return json({ error: { code: "CONFIG_INVALID", message: error.message } }, requestId, 400);
  }
  const name = error instanceof Error ? error.name : "unknown";
  if (isTemporaryAwsError(error)) {
    console.log(JSON.stringify({ component: "broker", event: "aws.temporary_error", requestId, name }));
    return json({ error: { code: "RUNTIME_UNAVAILABLE", message: AWS_TEMPORARY_MESSAGE } }, requestId, 503);
  }
  const at = thrownAt(error);
  console.log(JSON.stringify({ component: "broker", event: "request.unexpected_error", requestId, name, ...(at === undefined ? {} : { at }) }));
  return json({ error: { code: "CONFIG_INVALID", message: UNEXPECTED_REQUEST_MESSAGE } }, requestId, 400);
}

async function routeWorkspaceRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const body = parseBody(request.body);
  const githubMcp = /^\/v1\/workspaces\/([0-9a-f-]+)\/github\/(tools|call)$/.exec(url.pathname);
  if (githubMcp?.[1] && ((request.method === "GET" && githubMcp[2] === "tools") || (request.method === "POST" && githubMcp[2] === "call"))) {
    // Feature 007 shapes, kept for Slack services from before feature 013.
    const { workspace, project, github } = await authorizeGitHubConnector(dependencies, identity, githubMcp[1]);
    if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
    const parsed = request.method === "POST" ? GitHubMcpRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid GitHub MCP request");
    const repositoryName = parsed?.success ? parsed.data.repository : url.searchParams.get("repository");
    const repository = github.repositories.find((entry) => entry.name === repositoryName);
    if (!repository) throw agentXError("NOT_FOUND", "registered repository not found");
    const revision = project.definition.revision;
    if (!parsed?.success) {
      const types = dependencies.connectorTypes ?? BUILT_IN_CONNECTOR_TYPES;
      const discovery = await discoverLegacyGitHubScope({
        connectors: resolveConnectors(project.definition, connectorTypeContext(dependencies), types),
        githubTypeKnown: Object.hasOwn(types, "github"),
        connectorName: github.name, repository: repository.name, projectName: workspace.projectName,
        context: connectorContext(identity, workspace, project), catalogs: dependencies.catalogs,
      });
      return json({ catalog: toGitHubCatalog(discovery) }, request.requestId);
    }
    const attribution = attributionText(identity, github);
    const result = await executeGitHubTool(parsed.data, gitHubContext(identity, workspace, project, github, repository), {
      ...withoutDeploymentAttribution(dependencies.githubMcp),
      ...(attribution === undefined ? {} : { attribution }),
      onAttributionDropped: attributionDroppedLog(workspace.projectName, revision, github.name, repository.name, parsed.data.requestId),
      store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, github.name),
      onDefinitionChanged: () => dependencies.catalogs.delete(connectorCatalogKey(workspace.projectName, revision, github.name, repository.name)),
    });
    return json({ result }, request.requestId);
  }

  const connectorRoute = /^\/v1\/workspaces\/([0-9a-f-]+)\/connectors\/([a-z][a-z0-9-]{0,19})\/(tools|call)$/.exec(url.pathname);
  if (connectorRoute?.[1] && connectorRoute[2] && ((request.method === "GET" && connectorRoute[3] === "tools") || (request.method === "POST" && connectorRoute[3] === "call"))) {
    const { workspace, project } = await authorizeWorkspaceConnectors(dependencies, identity, connectorRoute[1]);
    const connector = resolveConnectors(project.definition, connectorTypeContext(dependencies), dependencies.connectorTypes)
      .find((entry) => entry.name === connectorRoute[2]);
    if (!connector) throw agentXError("NOT_FOUND", "connector not found");
    const parsed = request.method === "POST" ? ConnectorCallRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid connector request");
    const context = connectorContext(identity, workspace, project);
    if (!parsed?.success) {
      // Only a caller that sends x-agentx-include: gate gets the action gate's fields (feature 014); they are not secret.
      const includeGateFields = request.headers["x-agentx-include"]?.split(",").map((entry) => entry.trim()).includes("gate") === true;
      return json({ catalog: await discoverConnector({
        connector, workspace, context, catalogs: dependencies.catalogs, refresh: url.searchParams.get("refresh") === "1", includeGateFields,
      }) }, request.requestId);
    }
    const attribution = attributionText(identity, connector);
    const result = await callConnector({
      connector, request: parsed.data, workspace, context, catalogs: dependencies.catalogs,
      ...(attribution === undefined ? {} : { attribution }),
      ledger: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, connector.ledger, connector.name),
    });
    return json({ result }, request.requestId);
  }

  const resolve = /^\/v1\/projects\/([^/]+)\/workspace$/.exec(url.pathname);
  if (request.method === "GET" && resolve?.[1]) {
    const revision = Number.parseInt(url.searchParams.get("revision") ?? "", 10);
    return json(
      { workspace: await resolveWorkspace(dependencies, identity, decodeURIComponent(resolve[1]), revision) },
      request.requestId,
    );
  }

  const conversations = /^\/v1\/workspaces\/([0-9a-f-]+)\/conversations$/.exec(url.pathname);
  if (request.method === "POST" && conversations?.[1]) {
    return json(
      { conversation: await createConversation(dependencies, identity, conversations[1]) },
      request.requestId,
      201,
    );
  }

  const tasks = /^\/v1\/workspaces\/([0-9a-f-]+)\/tasks$/.exec(url.pathname);
  if (request.method === "POST" && tasks?.[1]) {
    return json(await acceptTask(dependencies, identity, tasks[1], body, channelOperation(dependencies, identity)), request.requestId, 202);
  }

  const pullRequests = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-requests$/.exec(url.pathname);
  if (request.method === "POST" && pullRequests?.[1]) {
    return json(await acceptPullRequest(dependencies, identity, pullRequests[1], body, channelOperation(dependencies, identity)), request.requestId, 202);
  }
  const pullRequestActions = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-request-actions$/.exec(url.pathname);
  if (request.method === "POST" && pullRequestActions?.[1]) {
    return json(
      await acceptPullRequestLifecycle(dependencies, identity, pullRequestActions[1], body, channelOperation(dependencies, identity)),
      request.requestId,
      202,
    );
  }

  const operation = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && operation?.[1] && operation[2]) {
    return json(
      { operation: await getAuthorizedOperation(dependencies, identity, operation[1], operation[2]) },
      request.requestId,
    );
  }

  const events = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/events$/.exec(url.pathname);
  if (request.method === "GET" && events?.[1] && events[2]) {
    return json(
      await pageEvents(dependencies, identity, events[1], events[2], {
        limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
        ...(url.searchParams.get("cursor") === null
          ? {}
          : { cursor: url.searchParams.get("cursor")! }),
      }),
      request.requestId,
    );
  }

  const artifact = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifact?.[1] && artifact[2]) {
    return json(
      { artifact: await getArtifact(dependencies, identity, artifact[1], artifact[2]) },
      request.requestId,
    );
  }

  const cancel = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel?.[1] && cancel[2]) {
    return json(await acceptCancellation(dependencies, identity, cancel[1], cancel[2]), request.requestId, 202);
  }

  throw agentXError("NOT_FOUND", "route not found");
}

/** Workspace ownership, channel binding and membership, then the project's latest revision, which configures at least one connector. */
async function authorizeWorkspaceConnectors(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  if (identity.slack && identity.slack.binding.projectName !== workspace.projectName) throw agentXError("FORBIDDEN", "Slack channel is no longer bound to this project");
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  // The policy and the scopes it may address come from the project's latest registered revision,
  // so enabling, narrowing or revoking a tool reaches an existing thread at once.
  const project = await requireLatestProject(dependencies, workspace.projectName);
  const integrations = project.definition.integrations;
  if (!integrations?.githubMcp && !integrations?.connectors?.length) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
  return { workspace, project };
}

/** The workspace and latest revision, then that revision's GitHub connector. */
async function authorizeGitHubConnector(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const { workspace, project } = await authorizeWorkspaceConnectors(dependencies, identity, workspaceId);
  const github = githubConnectorOf(project.definition);
  if (!github) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
  return { workspace, project, github };
}

function connectorTypeContext(dependencies: AwsBrokerDependencies): ConnectorTypeContext {
  return {
    ...(dependencies.githubMcp ? { githubMcp: dependencies.githubMcp } : {}),
    ...(dependencies.credentialRegistry ? { credentialRegistry: dependencies.credentialRegistry } : {}),
  };
}

function connectorContext(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, project: RegisteredProjectRecord): ConnectorContextBase {
  return { workspaceId: workspace.id, ownerKey: identity.ownerKey, settingsRevision: project.definition.revision, ...slackRequesterOf(identity) };
}

type GitHubConnector = NonNullable<ReturnType<typeof githubConnectorOf>>;
type GitHubRepository = GitHubConnector["repositories"][number];

/** Only the connector decides attribution: a deployment-level value must not survive attribution: false. */
function withoutDeploymentAttribution(dependencies: GitHubMcpDependencies): Omit<GitHubMcpDependencies, "attribution"> {
  const rest = { ...dependencies };
  delete rest.attribution;
  return rest;
}

function attributionText(identity: AuthenticatedIdentity, connector: Pick<ResolvedConnector, "attribution">): string | undefined {
  if (!connector.attribution || !identity.slack) return undefined;
  const name = identity.slack.requesterName;
  const who = inertName(name ?? `Slack member ${identity.slack.requester.userId}`);
  return `Requested by ${who} via AgentX · ${slackThreadUrl(identity.slack.thread)}`;
}

function gitHubContext(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, project: RegisteredProjectRecord, github: GitHubConnector, repository: GitHubRepository) {
  return {
    workspaceId: workspace.id,
    ownerKey: identity.ownerKey,
    repository,
    policy: github.policy,
    settingsRevision: project.definition.revision,
    ...slackRequesterOf(identity),
  };
}

/** The registration request's parse, shared by registerProject and a change plan (spec 025 C4). */
function parseRegistrationInput(value: unknown): { definition: ProjectDefinition; runtimeBinding: ReturnType<typeof parseRuntimeBinding>; wantsPreflight: boolean } {
  const input = object(value, "project registration");
  const retired = legacyProjectFields(input.definition);
  if (retired.length > 0) {
    throw agentXError("CONFIG_INVALID", `project definition must not contain ${retired.join(", ")}; remove them and register again`);
  }
  const definition = ProjectDefinitionSchema.parse(input.definition);
  const runtimeBinding = parseRuntimeBinding(input.runtimeBinding);
  // Preflight contacts the vendor, so it runs only when the caller asks; older clients never do.
  return { definition, runtimeBinding, wantsPreflight: input.preflight === true };
}

/** Registration's refusals and preflight, for a new revision; registerProject and a change plan share them. */
async function registrationChecks(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, definition: ProjectDefinition, wantsPreflight: boolean): Promise<PreflightOutcome | undefined> {
  const budget = toolBudget(approvedToolCount(definition));
  const connectors = () => resolveConnectors(definition, connectorTypeContext(dependencies), dependencies.connectorTypes);
  const nameProblems = presentedNameProblems(definition);
  if (nameProblems.length > 0) throw agentXError("CONFIG_INVALID", nameProblems.join("; "));
  if (budget.refusal) throw agentXError("CONFIG_INVALID", budget.refusal);
  // Spec 053 FR-003: Pi would clamp an unsupported level to another one; refuse the admin's choice instead.
  const levelProblems = definition.models === undefined ? [] : unsupportedThinkingLevels(definition.models);
  if (levelProblems.length > 0) throw agentXError("CONFIG_INVALID", levelProblems.join("; "));
  const credentialProblems = await credentialRefusals(connectors(), dependencies.credentialRegistry);
  if (credentialProblems.length > 0) throw agentXError("CONFIG_INVALID", credentialProblems.join("; "));
  // A repository the GitHub App cannot reach would otherwise fail only at prepare (#123).
  for (const repository of definition.repositories) {
    await dependencies.checkRepositoryAccess?.(repository);
  }
  if (!wantsPreflight) return undefined;
  const result = await preflightConnectors(connectors(), definition, identity.ownerKey);
  if (result.refusals.length > 0) throw agentXError("CONFIG_INVALID", result.refusals.join("; "));
  return { report: result.report, warnings: result.warnings };
}

async function registerProject(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
  checked?: { preflight?: PreflightOutcome },
): Promise<{ project: Omit<RegisteredProjectRecord, "pk" | "sk">; duplicate: boolean; warnings?: string[]; preflight?: RegistrationPreflight }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const { definition, runtimeBinding, wantsPreflight } = parseRegistrationInput(value);
  const budget = toolBudget(approvedToolCount(definition));
  const connectors = () => resolveConnectors(definition, connectorTypeContext(dependencies), dependencies.connectorTypes);
  const respond = (project: Omit<RegisteredProjectRecord, "pk" | "sk">, duplicate: boolean, preflight: PreflightOutcome | undefined) => {
    const warnings = registrationWarnings(budget.warning, preflight);
    return {
      project, duplicate,
      tools: { maximum: budget.maximum, warnAbove: TOOL_WARNING_THRESHOLD, limit: TOOL_LIMIT },
      ...(warnings.length ? { warnings } : {}), ...(preflight ? { preflight: preflight.report } : {}),
    };
  };
  const key = projectKey(definition.name, definition.revision);
  const existing = await getItem<RegisteredProjectRecord>(dependencies, key);
  if (existing) {
    if (
      JSON.stringify(existing.definition) !== JSON.stringify(definition) ||
      JSON.stringify(existing.runtimeBinding) !== JSON.stringify(runtimeBinding)
    ) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revisions and runtime bindings are immutable");
    }
    // A revision stored before the static checks existed stays idempotent: report, never refuse.
    const preflight = checked?.preflight
      ?? (wantsPreflight ? await preflightConnectors(connectors(), definition, identity.ownerKey) : undefined);
    return respond(withoutKeys(existing), true, preflight);
  }
  const preflight = await registrationChecks(dependencies, identity, definition, wantsPreflight);
  const now = new Date().toISOString();
  const record: RegisteredProjectRecord = {
    ...key,
    entityType: "PROJECT",
    definition,
    runtimeBinding,
    registeredBy: identity.ownerKey,
    registeredAt: now,
  };
  const membership = membershipRecord(identity.ownerKey, definition.name, "administrator");
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: membership } },
      // Spec 025 A3: the admin project list reads this row instead of scanning the table.
      { Update: {
        TableName: dependencies.tableName,
        Key: projectCatalogKey(definition.name),
        UpdateExpression: "SET entityType = :entity, #name = :name, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": definition.name, ":now": now },
      } },
    ] }));
  } catch (error) {
    // A concurrent registration won; answer as a duplicate without contacting the vendor again.
    if (isConditional(error)) return registerProject(dependencies, identity, value, preflight ? { preflight } : {});
    throw error;
  }
  return respond(withoutKeys(record), false, preflight);
}

async function prepareWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<{ operationId: string; workspace: ReturnType<typeof publicWorkspace>; alreadyReady: boolean; duplicate?: boolean }> {
  const input = object(value, "workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  const projectName = name(input.projectName, "projectName");
  const projectRevision = positiveInteger(input.projectRevision, "projectRevision");
  if (typeof input.ownerSubject !== "string") throw agentXError("CONFIG_INVALID", "ownerSubject is required");
  await requireAdministrator(dependencies, identity, projectName);
  const targetOwnerKey = ownerKeyForSubject(dependencies.issuer, input.ownerSubject);
  const idempotency = await getItem<{ operationId: string; workspaceId: string }>(dependencies, {
    pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
    sk: `REQUEST#${requestId}`,
  });
  if (idempotency) {
    const workspace = await requireWorkspace(dependencies, idempotency.workspaceId);
    return { operationId: idempotency.operationId, workspace: publicWorkspace(workspace), alreadyReady: workspace.status === "READY", duplicate: true };
  }
  const project = await requireProject(dependencies, projectName, projectRevision);
  const existing = await getDefaultWorkspace(dependencies, targetOwnerKey, projectName);
  if (existing) {
    if (existing.projectRevision !== projectRevision) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "existing workspace is pinned to another revision");
    }
    if (["READY", "STOPPED"].includes(existing.status)) {
      return { operationId: randomUUID(), workspace: publicWorkspace(existing), alreadyReady: true };
    }
    if (existing.status === "PREPARING" && existing.activeOperationId) {
      return {
        operationId: existing.activeOperationId,
        workspace: publicWorkspace(existing),
        alreadyReady: false,
        duplicate: true,
      };
    }
    if (existing.status === "PREPARATION_FAILED" && !existing.activeOperationId) {
      return retryWorkspacePreparation(
        dependencies,
        identity,
        requestId,
        targetOwnerKey,
        project,
        existing,
      );
    }
    throw agentXError("WORKSPACE_BUSY", `workspace cannot be prepared while ${existing.status}`);
  }

  const preparation = await newWorkspacePreparation(dependencies, identity, project, targetOwnerKey, requestId);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    ...preparation.items,
    { Put: { TableName: dependencies.tableName, Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id }, ConditionExpression: "attribute_not_exists(pk)" } },
  ] }));
  return { operationId: preparation.operationId, workspace: publicWorkspace(preparation.workspace), alreadyReady: false };
}

async function newWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  targetOwnerKey: string,
  requestId: string,
): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems }> {
  const projectName = project.definition.name;
  const projectRevision = project.definition.revision;
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const workspace = WorkspaceInstanceSchema.parse({
    id: workspaceId,
    ownerKey: targetOwnerKey,
    projectName,
    projectRevision,
    ...workspaceRuntime(project.runtimeBinding),
    rootPath: "/mnt/workspace",
    status: "PREPARING",
    activeOperationId: operationId,
    fence: 1,
    createdAt: now,
    updatedAt: now,
  });
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName, projectRevision, targetOwnerKey }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: {
      project: project.definition,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspaceId,
        operationId,
      ),
    },
  };
  const outbox = outboxRecord(workspace, invocation, project.runtimeBinding);
  const existingMembership = await getMembership(dependencies, targetOwnerKey, projectName);
  const membership = membershipRecord(
    targetOwnerKey,
    projectName,
    existingMembership?.role ?? "developer",
  );
  return {
    workspace,
    operationId,
    items: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { pk: `OWNER#${targetOwnerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: membership } },
    ],
  };
}

/** The service routes' caller must be the Slack orchestrator's role. */
function requireSlackServiceRole(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest): void {
  const configuration = dependencies.slack;
  if (!configuration) throw agentXError("NOT_FOUND", "route not found");
  if (!request.iamPrincipalArn || !isAssumedRoleOf(request.iamPrincipalArn, configuration.orchestratorRoleArn)) {
    throw agentXError("FORBIDDEN", "only the Slack orchestrator role may call service routes");
  }
}

async function slackServiceIdentity(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
): Promise<AuthenticatedIdentity> {
  requireSlackServiceRole(dependencies, request);
  const context = parseSlackHeaders(request.headers);
  const binding = await getSlackBinding(dependencies, context.thread.teamId, context.thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  const subject = slackThreadSubject(context.thread);
  const own: AuthenticatedIdentity = {
    issuer: SLACK_THREAD_OWNER_ISSUER,
    subject,
    ownerKey: ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, subject),
    isAdministrator: false,
    claims: {},
    slack: { ...context, binding },
  };
  const shared = await sharedThread(dependencies, context.thread);
  if (shared === undefined) return own;
  const sharedTask = { taskId: shared.taskId, workspaceId: shared.workspaceId, developerName: shared.developerName };
  // C11: open only while continue, not closed, and the channel still serves the task's project.
  if (!sharedThreadOpen(shared, binding)) {
    return { ...own, sharedTask: { ...sharedTask, state: shared.closedAt !== undefined ? "closed" : "view" } };
  }
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(shared.developerId, shared.taskId),
    ownerKey: shared.ownerKey,
    isAdministrator: false,
    claims: {},
    // The teammate's Slack context: requesterOf records them on every operation (FR-054).
    slack: { ...context, binding },
    sharedTask: { ...sharedTask, state: "continue" },
  };
}

/** Spec 025 FR-035, FR-054: the thread's shared task record, or undefined for an ordinary thread. */
async function sharedThread(dependencies: AwsBrokerDependencies, thread: SlackThread): Promise<SharedTaskRecord | undefined> {
  // Developer tasks exist only where developer sign-in is set up (D14); nothing else reads this key.
  if (dependencies.developer === undefined) return undefined;
  const item = await getItem<Record<string, unknown>>(dependencies, sharedTaskKey(thread));
  if (item === undefined) return undefined;
  const record = SharedTaskRecordSchema.safeParse(item);
  // Fail closed: an unreadable record must never let the thread act as an ordinary one.
  if (!record.success || record.data.ownerKey !== taskOwnerKey(record.data.developerId, record.data.taskId)) {
    throw agentXError("FORBIDDEN", "this thread's shared task record cannot be read; ask an admin");
  }
  return record.data;
}

/** C11, F16: a shared thread acts on the task only in continue, before the close, while its channel serves the task's project. */
function sharedThreadOpen(shared: SharedTaskRecord, binding: SlackChannelBinding): boolean {
  return shared.mode === "continue" && shared.closedAt === undefined && binding.projectName === shared.project;
}

function parseSlackHeaders(headers: Record<string, string | undefined>): Omit<NonNullable<AuthenticatedIdentity["slack"]>, "binding"> {
  try {
    const thread = parseSlackThreadSubject(headers["x-agentx-slack-thread"] ?? "");
    const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: headers["x-agentx-slack-user"] });
    const requesterName = displayName(headers["x-agentx-slack-user-name"]);
    return { thread, requester, ...(requesterName === undefined ? {} : { requesterName }) };
  } catch {
    throw agentXError("CONFIG_INVALID", "valid x-agentx-slack-thread and x-agentx-slack-user headers are required");
  }
}

/** A Slack display name from the orchestrator, percent-encoded, cleaned by the same rules the Slack service used. */
function displayName(value: string | undefined): string | undefined {
  if (!value || value.length > DISPLAY_NAME_MAX_ENCODED_LENGTH) return undefined;
  try {
    return cleanDisplayName(decodeURIComponent(value));
  } catch { return undefined; }
}

async function putSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  value: unknown,
): Promise<{ binding: SlackChannelBinding; latestRevision: number }> {
  const input = object(value, "Slack channel binding");
  // Older CLIs still send projectRevision; the binding follows the project's latest revision instead.
  const binding = SlackChannelBindingSchema.parse({
    teamId: decodeURIComponent(teamIdValue),
    channelId: decodeURIComponent(channelIdValue),
    projectName: input.projectName,
    updatedAt: new Date().toISOString(),
  });
  await requireAdministrator(dependencies, identity, binding.projectName);
  const existing = await getSlackBinding(dependencies, binding.teamId, binding.channelId);
  if (existing && existing.projectName !== binding.projectName) {
    await requireAdministrator(dependencies, identity, existing.projectName);
  }
  const latest = await requireLatestProject(dependencies, binding.projectName);
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { ...slackBindingKey(binding.teamId, binding.channelId), entityType: "SLACK_BINDING", ...binding, updatedBy: identity.ownerKey },
  }));
  return { binding, latestRevision: latest.definition.revision };
}

async function deleteSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
): Promise<{ deleted: true; binding: SlackChannelBinding }> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found");
  await requireAdministrator(dependencies, identity, binding.projectName);
  await dependencies.documentClient.send(new DeleteCommand({
    TableName: dependencies.tableName,
    Key: slackBindingKey(teamId, channelId),
  }));
  return { deleted: true, binding };
}

async function getSlackBinding(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  channelId: string,
): Promise<SlackChannelBinding | undefined> {
  const item = await getItem<Record<string, unknown>>(dependencies, slackBindingKey(teamId, channelId));
  if (!item) return undefined;
  // Bindings written before channels followed the latest revision also carry projectRevision; it is ignored.
  return SlackChannelBindingSchema.parse({
    teamId: item.teamId,
    channelId: item.channelId,
    projectName: item.projectName,
    updatedAt: item.updatedAt,
  });
}

/** The close preflight's operation, worker invocation and outbox item: the Slack close's and a developer task's. */
function closeOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  requestId: string,
  requester: { requestedBy?: OperationRequester },
  now: string,
): { operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number } {
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "close",
    requestId,
    payloadHash: hashJson({ action: "close", workspaceId: workspace.id }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requester,
  });
  if (workspace.status === "READY" || workspace.status === "STOPPED") operation.closePreviousStatus = workspace.status;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "close",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {},
  };
  return { operation, outbox: outboxRecord(workspace, invocation), fence };
}

async function startThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseStartResult> {
  if (!identity.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close request");
  // C11: only the developer closes a shared task, from their AI tool.
  if (identity.sharedTask !== undefined) {
    if (input.includeSharedTask === true) return { outcome: "REFUSED", reason: "shared_task" };
    throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  }
  const requestId = uuid(input.requestId, "requestId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) return { outcome: "NOT_FOUND" };
  // Spec 014: a thread that never needed the worker has no compute, so there is nothing to close.
  if (workspace.status === "UNPREPARED") return { outcome: "NOT_FOUND" };
  // #213: a failed preparation that was released holds no slot and has nothing to check, and a
  // lazy turn was told it has no compute; answered as an UNPREPARED thread is.
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, slackThreadKey(identity.ownerKey));
    if (typeof thread?.starterUserId !== "string") return { outcome: "NOT_FOUND" };
  }
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.status === "CLOSING" && workspace.closeOperationId) {
    const operation = await requireOperation(dependencies, workspace.id, workspace.closeOperationId);
    return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId: operation.id, status: operation.status };
  }

  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
  if (previous) {
    const operation = await requireOperation(dependencies, previous.workspaceId, previous.operationId);
    return { outcome: "PREFLIGHT", workspaceId: previous.workspaceId, operationId: operation.id, status: operation.status };
  }
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }

  const now = new Date().toISOString();
  const { operation, outbox, fence } = closeOperationParts(dependencies, workspace, requestId, requesterOf(identity), now);
  const operationId = operation.id;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, closedBy = :requester, fence = :fence, updatedAt = :now REMOVE closeError",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":requester": identity.slack.requester,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
    if (concurrent) {
      const existing = await requireOperation(dependencies, concurrent.workspaceId, concurrent.operationId);
      return { outcome: "PREFLIGHT", workspaceId: concurrent.workspaceId, operationId: existing.id, status: existing.status };
    }
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId, status: "ACCEPTED" };
}

/**
 * A developer task's close preflight (spec 025): the Slack close's flow, keyed the same way, with
 * no Slack `closedBy`, and with the task's extra items in the same transaction.
 */
async function startTaskClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  requestId: string,
  extra: ExtraItems,
): Promise<{ operationId: string; duplicate: boolean }> {
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
  if ((workspace.status === "CLOSING" || workspace.status === "CLOSED") && workspace.closeOperationId) {
    return { operationId: workspace.closeOperationId, duplicate: true };
  }
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string }>(dependencies, idempotencyKey);
  if (previous) return { operationId: previous.operationId, duplicate: true };
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }
  const now = new Date().toISOString();
  const { operation, outbox, fence } = closeOperationParts(dependencies, workspace, requestId, requesterOf(identity), now);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, fence = :fence, updatedAt = :now REMOVE closeError",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operation.id,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId: operation.id, workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string }>(dependencies, idempotencyKey);
    if (concurrent) return { operationId: concurrent.operationId, duplicate: true };
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { operationId: operation.id, duplicate: false };
}

/** Deletes a workspace's compute and storage by its deployment mode; the one place that switch lives (FR-024). */
async function deleteWorkspaceCompute(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance): Promise<void> {
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace storage cannot be managed");
    case "ec2-ebs":
      // The session deleter terminates the instance and deletes the volume; without it, refuse
      // rather than mark the workspace CLOSED and leak the volume.
      if (dependencies.deleteEc2Session === undefined) {
        throw agentXError("RUNTIME_UNAVAILABLE", "this control plane cannot delete ec2-ebs workspace storage");
      }
      try {
        await dependencies.deleteEc2Session(workspace.id);
      } catch (error) {
        // Compute that is starting or stopping refuses with WORKSPACE_BUSY; the close is retried.
        if (error instanceof AgentXError) throw error;
        throw agentXError("RUNTIME_UNAVAILABLE", "workspace resource cleanup failed; retry the close request");
      }
      break;
    default:
      unhandledDeploymentMode(workspace);
  }
}

async function completeThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseCompleteResult> {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close completion");
  if (identity.sharedTask !== undefined) throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  uuid(input.requestId, "requestId");
  const operationId = uuid(input.operationId, "operationId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt && workspace.closeOperationId === operationId) {
    return { outcome: "CLOSED", workspaceId: workspace.id, operationId, closedAt: workspace.closedAt, storageReleased: closeReleasesStorage(workspace) };
  }
  const operation = await requireOperation(dependencies, workspace.id, operationId);
  if (operation.kind !== "close" || operation.status !== "SUCCEEDED" || workspace.status !== "CLOSING" || workspace.closeOperationId !== operationId) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace close preflight has not completed safely");
  }
  const preflight = WorkspaceClosePreflightResultSchema.parse(operation.result);
  if (!preflight.safeToClose) throw agentXError("WORKSPACE_NOT_READY", "workspace contains unpublished work");

  await deleteWorkspaceCompute(dependencies, workspace);
  const storageReleased = closeReleasesStorage(workspace);

  const thread = await getItem<{ starterUserId?: string; closedAt?: string }>(dependencies, slackThreadKey(identity.ownerKey));
  if (typeof thread?.starterUserId !== "string") throw agentXError("CONFIG_INVALID", "Slack thread starter is missing");
  const organizationKey = slackOrganizationLimitKey(slack.thread.teamId);
  const memberKey = slackMemberLimitKey(slack.thread.teamId, thread.starterUserId);
  const organization = await getItem<{ count?: number }>(dependencies, organizationKey);
  const member = await getItem<{ count?: number; threads?: string[] }>(dependencies, memberKey);
  const organizationCount = organization?.count ?? 0;
  const memberCount = member?.count ?? 0;
  if (organizationCount < 1 || memberCount < 1) throw agentXError("CONFIG_INVALID", "workspace quota record is inconsistent");
  const remainingThreads = (member?.threads ?? []).filter((subject) => subject !== identity.subject);
  const closedAt = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closed, closedAt = :closedAt, updatedAt = :closedAt REMOVE activeOperationId, closeError",
        ConditionExpression: "#status = :closing AND closeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":closing": "CLOSING", ":closedAt": closedAt, ":operation": operationId, ":fence": operation.fence },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: organizationKey,
        UpdateExpression: "SET #count = :next",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":next": organizationCount - 1, ":current": organizationCount },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: memberKey,
        UpdateExpression: "SET #count = :next, #threads = :threads",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: { ":next": memberCount - 1, ":current": memberCount, ":threads": remainingThreads },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackThreadKey(identity.ownerKey),
        UpdateExpression: "SET closedAt = :closedAt, closeOperationId = :operation",
        ConditionExpression: "attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":closedAt": closedAt, ":operation": operationId },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const closed = await requireWorkspace(dependencies, workspace.id);
    if (closed.status === "CLOSED" && closed.closedAt) {
      return { outcome: "CLOSED", workspaceId: closed.id, operationId, closedAt: closed.closedAt, storageReleased };
    }
    throw agentXError("WORKSPACE_BUSY", "workspace close completion conflicted; retry");
  }
  return { outcome: "CLOSED", workspaceId: workspace.id, operationId, closedAt, storageReleased };
}

async function ensureThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace request");
  const requestId = uuid(input.requestId, "requestId");
  // Older deployed Slack services parse a strict response; add discovery metadata only on opt-in.
  const includeIntegrations = input.includeIntegrations === true;
  const includeSettingsRevision = input.includeSettingsRevision === true;
  const includeConnectors = input.includeConnectors === true;
  // A separate opt-in: an older Slack service parses the connectors array with a schema that
  // still requires type "github", so every other resolved connector type is withheld unless the
  // service says it can parse them too.
  const includeAllConnectorTypes = input.includeAllConnectorTypes === true;
  // A separate opt-in: the Slack service released before this field existed already sends
  // includeConnectors: true but parses the WORKSPACE result with a strict schema that lacks
  // recoverableOperations. The control plane deploys first, so gating this on includeConnectors
  // would fail every turn until the Slack service caught up.
  const includeRecoverableOperations = input.includeRecoverableOperations === true;
  // Spec 014, a separate opt-in: a service that sends lazyPreparation: true parses status
  // UNPREPARED and prepares compute through POST /v1/threads/workspace/prepare when a tool first
  // needs the worker. Every other service keeps getting a workspace whose compute is prepared now.
  const lazyPreparation = input.lazyPreparation === true;
  // A separate opt-in (feature 014): services released before the action gate parse strictly.
  const includeActionPolicy = input.includeActionPolicy === true;
  const include: IntegrationInclude = {
    integrations: includeIntegrations,
    connectors: includeConnectors,
    allConnectorTypes: includeAllConnectorTypes,
    recoverableOperations: includeRecoverableOperations,
    actionPolicy: includeActionPolicy,
  };
  if (identity.sharedTask !== undefined) {
    return sharedThreadWorkspace(dependencies, identity, identity.sharedTask, input.includeSharedTask === true, include, includeSettingsRevision);
  }
  const threadWorkspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (threadWorkspace) {
    if (threadWorkspace.status === "CLOSED" && threadWorkspace.closedAt) {
      return { outcome: "CLOSED", workspaceId: threadWorkspace.id, closedAt: threadWorkspace.closedAt };
    }
    if (threadWorkspace.projectName !== slack.binding.projectName) {
      throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
    }
  }
  const existing = threadWorkspace ?? await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
  if (existing) {
    if (existing.status === "CLOSED" && existing.closedAt) {
      return { outcome: "CLOSED", workspaceId: existing.id, closedAt: existing.closedAt };
    }
    if (existing.status === "UNPREPARED" && !lazyPreparation) {
      // An older Slack service cannot parse UNPREPARED and expects compute now: prepare it at once.
      const prepared = await startThreadPreparation(dependencies, identity, requestId, existing, input.includeOpenTaskCount === true);
      if (prepared.outcome !== "WORKSPACE") return prepared;
      const current = await requireWorkspace(dependencies, existing.id);
      const result = await existingThreadWorkspace(dependencies, identity, requestId, current, include, includeSettingsRevision, input.includeOpenTaskCount === true);
      return result.outcome === "WORKSPACE" ? { ...result, created: prepared.created } : result;
    }
    return existingThreadWorkspace(dependencies, identity, requestId, existing, include, includeSettingsRevision, input.includeOpenTaskCount === true, lazyPreparation);
  }

  // New threads use the latest revision; an existing thread keeps the revision its workspace was prepared with.
  const project = await requireLatestProject(dependencies, slack.binding.projectName);
  if (lazyPreparation) {
    return createUnpreparedThreadWorkspace(dependencies, identity, requestId, project, include, includeSettingsRevision);
  }
  const effective = await effectiveSlackLimits(dependencies, limits);
  const preparation = await newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId);
  const { teamId, userId } = slack.requester;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...preparation.items,
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      // #213: the starter is recorded with the charge, so a failed preparation can always find it.
      ...threadChargeItems(dependencies, identity, effective, preparation.workspace.id),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
    if (concurrent) {
      return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision, input.includeOpenTaskCount === true);
    }
    return threadWorkspaceLimitRefusal(dependencies, teamId, userId, effective, input.includeOpenTaskCount === true);
  }
  await recordThreadRequester(dependencies, identity, preparation.workspace.id, true);
  return {
    outcome: "WORKSPACE",
    workspaceId: preparation.workspace.id,
    status: "PREPARING",
    operationId: preparation.operationId,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
    ...(include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
  };
}

/**
 * Spec 014: a new thread's record with no compute and no limit charge. The workspace ID exists
 * from the first message because connector routes, the connector ledger and conversations are keyed
 * by it. startThreadPreparation prepares compute the first time the thread needs the worker.
 */
async function createUnpreparedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const projectName = project.definition.name;
  const workspace = unpreparedWorkspace(project, identity.ownerKey);
  const existingMembership = await getMembership(dependencies, identity.ownerKey, projectName);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `OWNER#${identity.ownerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: { TableName: dependencies.tableName, Item: membershipRecord(identity.ownerKey, projectName, existingMembership?.role ?? "developer") } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      // Capture creation provenance atomically, before a later participant can touch the thread.
      { Update: {
        TableName: dependencies.tableName,
        Key: slackThreadKey(identity.ownerKey),
        UpdateExpression: "SET #creator = if_not_exists(#creator, :creator)",
        ExpressionAttributeNames: { "#creator": "creator" },
        ExpressionAttributeValues: { ":creator": { userId: identity.slack!.requester.userId, ...(identity.slack!.requesterName === undefined ? {} : { name: identity.slack!.requesterName }) } },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // Another first message in this thread created the record.
    const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
    if (concurrent) return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision);
    throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
  }
  // The starter is recorded when compute is prepared, because that member is the one charged.
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  // Each optional field is its own spread, so a later opt-in (phase 14c's action policy) adds one
  // more spread line here, after settingsRevision, the same way ensureThreadWorkspace gains it.
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: "UNPREPARED",
    operationId: null,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
    ...(include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
  };
}

/**
 * A workspace record naming the thread's starting revision and runtime, with fence 0 and no
 * operation. startThreadPreparation replaces the revision with the latest one when it prepares.
 */
function unpreparedWorkspace(project: RegisteredProjectRecord, ownerKey: string): WorkspaceInstance {
  const now = new Date().toISOString();
  return WorkspaceInstanceSchema.parse({
    id: randomUUID(),
    ownerKey,
    projectName: project.definition.name,
    projectRevision: project.definition.revision,
    ...workspaceRuntime(project.runtimeBinding),
    rootPath: "/mnt/workspace",
    status: "UNPREPARED",
    fence: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** POST /v1/threads/workspace/prepare (spec 014): prepares compute for this thread's workspace. */
async function prepareThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  if (!slack || !dependencies.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  // C11: a shared task's workspace is the developer's; the thread never prepares it.
  if (identity.sharedTask !== undefined) {
    // Q3: as the ensure route does, a service that sends includeSharedTask hears VIEW_ONLY, never
    // the ordinary "start a new thread" or a bare refusal.
    const includeSharedTask = input.includeSharedTask === true;
    const shared = identity.sharedTask;
    if (shared.state !== "continue") {
      if (!includeSharedTask) throw agentXError("FORBIDDEN", SHARED_VIEW_ONLY);
      return { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: shared.state === "closed" };
    }
    const workspace = await requireWorkspace(dependencies, shared.workspaceId);
    if (workspace.ownerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "the workspace does not belong to this task");
    if (workspace.status === "CLOSED" && workspace.closedAt) {
      return includeSharedTask
        ? { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: true }
        : { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
    }
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: (await activeOperationForChannel(dependencies, workspace)).operationId, created: false };
  }
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey)
    ?? await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.projectName !== slack.binding.projectName) {
    throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
  }
  return startThreadPreparation(dependencies, identity, requestId, workspace, input.includeOpenTaskCount === true);
}

/**
 * Moves an UNPREPARED thread workspace to PREPARING. The same transaction writes the prepare
 * operation and outbox item, charges the requesting member and the organization, and records that
 * member as the thread's starter, whose charge closing releases. So a limit counts only prepared
 * threads. An UNPREPARED workspace has no disk yet, so it is built from the project's latest
 * registered revision (#12), not the one the thread started with. The same transaction writes
 * that revision onto the workspace record, so the record, the operation's payload hash, the
 * invocation and the outbox routing all name one revision. From then on the workspace stays on
 * it, as retryWorkspacePreparation does. Any other status is answered as it stands: a racing
 * request prepared it already.
 */
async function startThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
  includeOpenTaskCount = false,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    // #213: a released failed workspace a lazy turn was told is UNPREPARED; prepared again, charged afresh.
    const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
    const retried = await retryThreadPreparation(dependencies, identity, requestId, pinned, workspace, includeOpenTaskCount);
    if ("outcome" in retried) {
      if (retried.outcome === "LIMIT_REACHED") return retried;
      throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
    }
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: retried.status, operationId: retried.operationId, created: false };
  }
  if (workspace.status !== "UNPREPARED") {
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: workspace.activeOperationId, created: false };
  }
  const effective = await effectiveSlackLimits(dependencies, limits);
  // One read of the latest revision feeds every field below, so a revision registered meanwhile
  // cannot mix in. The fence condition refuses the write if the workspace changed since it was read.
  const latest = await requireLatestProject(dependencies, workspace.projectName);
  const projectRevision = latest.definition.revision;
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName: workspace.projectName, projectRevision, targetOwnerKey: identity.ownerKey }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: latest.definition,
      repositoryGrant: issueRepositoryGrant(dependencies, latest, identity.ownerKey, workspace.id, operationId),
    },
  };
  // The runtime fields stay the workspace's own (only deploymentMode today); outboxRecord refuses a
  // latest revision whose runtime does not match, before anything is written.
  const updated = WorkspaceInstanceSchema.parse({ ...workspace, projectRevision, status: "PREPARING", activeOperationId: operationId, fence, updatedAt: now });
  const outbox = outboxRecord(updated, invocation, latest.runtimeBinding);
  const { teamId, userId } = slack.requester;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :preparing, projectRevision = :revision, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND #status = :unprepared AND fence = :currentFence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":preparing": "PREPARING",
          ":revision": projectRevision,
          ":unprepared": "UNPREPARED",
          ":operation": operationId,
          ":nextFence": fence,
          ":currentFence": workspace.fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      ...threadChargeItems(dependencies, identity, effective, workspace.id),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const current = await requireWorkspace(dependencies, workspace.id);
    if (current.status !== "UNPREPARED") {
      return { outcome: "WORKSPACE", workspaceId: current.id, status: current.status, operationId: current.activeOperationId, created: false };
    }
    // threadWorkspaceLimitRefusal throws its own WORKSPACE_BUSY, worded for creation, when no limit
    // is reached. Answer with this route's wording instead.
    try {
      const refusal = await threadWorkspaceLimitRefusal(dependencies, teamId, userId, effective, includeOpenTaskCount);
      if (refusal.outcome === "LIMIT_REACHED") return refusal;
    } catch (refusalError) {
      if (!(refusalError instanceof AgentXError) || refusalError.code !== "WORKSPACE_BUSY") throw refusalError;
    }
    throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
  }
  return { outcome: "WORKSPACE", workspaceId: workspace.id, status: "PREPARING", operationId, created: true };
}

/**
 * A thread preparation's charge: the requesting member and the organization, each refused at its
 * limit, and the member recorded as the thread's starter, whose charge a close or a failed
 * preparation (#213) gives back. A thread already charged fails the starter condition.
 */
function threadChargeItems(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  effective: SlackServiceConfiguration,
  workspaceId: string,
): TransactItems {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const { teamId, userId } = slack.requester;
  return [
    { Update: {
      TableName: dependencies.tableName,
      Key: slackOrganizationLimitKey(teamId),
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": effective.organizationWorkspaceLimit, ":entity": "SLACK_LIMIT" },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: slackMemberLimitKey(teamId, userId),
      UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #threads = list_append(if_not_exists(#threads, :none), :thread), entityType = :entity",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
      ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":limit": effective.memberWorkspaceLimit,
        ":none": [],
        ":thread": [identity.subject],
        ":entity": "SLACK_LIMIT",
      },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: slackThreadKey(identity.ownerKey),
      // The same record recordThreadRequester(..., true) writes, so a missing thread row is
      // created whole and the charged member is among its requesters.
      UpdateExpression: "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace), starterUserId = :user, #starter = :starter ADD #requesters :users",
      ConditionExpression: "attribute_not_exists(starterUserId)",
      ExpressionAttributeNames: { "#entity": "entityType", "#thread": "thread", "#workspace": "workspaceId", "#requesters": "requesters", "#starter": "starter" },
      ExpressionAttributeValues: {
        ":entity": "SLACK_THREAD",
        ":thread": identity.subject,
        ":workspace": workspaceId,
        ":user": userId,
        ":users": new Set([userId]),
        ":starter": { userId, ...(identity.slack?.requesterName === undefined ? {} : { name: identity.slack.requesterName }) },
      },
    } },
  ];
}

const SHARED_VIEW_ONLY = "this thread follows a task started from an AI tool and is view only";
const SHARED_CLOSE_REFUSED = "only the developer who started this task can close it, from their AI tool";

/**
 * Spec 025 C11: a shared thread's workspace. View or closed: VIEW_ONLY, and nothing is created.
 * Continue: the task's workspace as it is, never created, prepared again or charged (FR-054), with
 * no recoverable operations, because the running one may be the developer's own.
 */
async function sharedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  shared: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  includeSharedTask: boolean,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  if (shared.state !== "continue") {
    if (!includeSharedTask) throw agentXError("FORBIDDEN", SHARED_VIEW_ONLY);
    return { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: shared.state === "closed" };
  }
  const workspace = await requireWorkspace(dependencies, shared.workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "the workspace does not belong to this task");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    // Q3: a shared task's thread says the task is closed, never the ordinary "start a new thread".
    return includeSharedTask
      ? { outcome: "VIEW_ONLY", taskId: shared.taskId, closed: true }
      : { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const active = await activeOperationForChannel(dependencies, workspace);
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: active.operationId,
    created: false,
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...await threadIntegrations(settings.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
    ...(includeSharedTask ? { sharedTask: { taskId: shared.taskId, developerName: shared.developerName } } : {}),
    ...(includeSharedTask && active.developer ? { activeOperation: "developer" as const } : {}),
  };
}

/**
 * D22: the task's active operation, named to the channel only when the channel started it. The
 * developer's own run stays private (its events and result are theirs), so the channel learns only
 * that the developer is running something, and the Slack service waits for it (C12).
 */
async function activeOperationForChannel(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance): Promise<{ operationId: string | null; developer: boolean }> {
  if (!workspace.activeOperationId) return { operationId: null, developer: false };
  const operation = await getItem<OperationRecord>(dependencies, operationKey(workspace.id, workspace.activeOperationId));
  // A pointer to a record that is gone names nothing to wait for: the workspace reads as idle.
  if (!operation) return { operationId: null, developer: false };
  const developer = developerRequested(operation);
  return developer ? { operationId: null, developer: true } : { operationId: operation.id, developer: false };
}

async function existingThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
  includeOpenTaskCount = false,
  lazyPreparation = false,
): Promise<SlackThreadWorkspaceResult> {
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  // Preparation rebuilds the workspace's disk, so it keeps the revision recorded on the workspace
  // (for a Slack thread, the latest revision when its compute was first prepared). Everything the
  // model is told comes from the project's latest registered revision.
  const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const applied = {
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...await threadIntegrations(settings.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: workspace.status === "BUSY" && workspace.activeOperationId ? [workspace.activeOperationId] : [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
    ...(include.actionPolicy && settings.definition.actionPolicy ? { actionPolicy: settings.definition.actionPolicy } : {}),
  };
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    const retried = await retryThreadPreparation(dependencies, identity, requestId, pinned, workspace, includeOpenTaskCount);
    // #213: a lazy service's turn is never refused for a slot it may not need. Its released
    // workspace has no compute and no charge, as a new thread's has, so it is answered UNPREPARED,
    // and the prepare route retries it (and refuses at the limit) when a tool needs the worker.
    if ("outcome" in retried && retried.outcome === "LIMIT_REACHED" && lazyPreparation) {
      return { outcome: "WORKSPACE", workspaceId: workspace.id, status: "UNPREPARED", operationId: null, created: false, ...applied };
    }
    if ("outcome" in retried) return retried;
    return {
      outcome: "WORKSPACE",
      workspaceId: workspace.id,
      status: retried.status,
      operationId: retried.operationId,
      created: false,
      ...applied,
    };
  }
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: workspace.activeOperationId,
    created: false,
    ...applied,
  };
}

interface IntegrationInclude { integrations: boolean; connectors: boolean; allConnectorTypes: boolean; recoverableOperations: boolean; actionPolicy: boolean }

/**
 * Every connector the project's latest revision configures, for services that opt in with
 * includeConnectors. An older Slack service's schema still requires type "github", so every other
 * resolved type is withheld unless the service also sends includeAllConnectorTypes.
 * githubMcpRepositories stays github-only regardless, for feature 007's included integrations.
 */
async function threadIntegrations(project: ProjectDefinition, include: IntegrationInclude, dependencies: AwsBrokerDependencies): Promise<{
  githubMcpRepositories?: string[];
  connectors?: ThreadConnector[];
  repositories?: string[];
}> {
  const github = githubConnectorOf(project);
  const repositories = github?.repositories.map((repository) => repository.name) ?? [];
  let connectors: ThreadConnector[] | undefined;
  if (include.connectors) {
    const resolved = resolveConnectors(project, connectorTypeContext(dependencies), dependencies.connectorTypes);
    const visible = include.allConnectorTypes ? resolved : resolved.filter((connector) => connector.type === "github");
    connectors = await Promise.all(visible.map(async (connector) => ({
      name: connector.name,
      type: connector.type,
      label: connector.label,
      scopes: connector.scopes.map((scope) => scope.alias),
      connected: await configuredSafely(connector, project),
    })));
  }
  return {
    ...(include.integrations && github ? { githubMcpRepositories: repositories } : {}),
    ...(include.connectors ? { repositories: project.repositories.map((repository) => repository.name), connectors: connectors ?? [] } : {}),
  };
}

/**
 * One connector's `configured()` throwing, for example a DynamoDB error in CredentialRegistry.has,
 * must not fail the whole Slack turn: every other connector, GitHub included, still needs to reach
 * the thread. Log the connector's name and its error's class name only, never its message, which
 * could carry vendor detail.
 */
async function configuredSafely(connector: ResolvedConnector, project: ProjectDefinition): Promise<boolean> {
  try {
    return await connector.configured();
  } catch (error) {
    console.log(JSON.stringify({
      component: "broker", event: "connector.configured_failed",
      project: project.name, revision: project.revision, connector: connector.name,
      error: error instanceof Error ? error.constructor.name : "UnknownError",
    }));
    return false;
  }
}

async function threadWorkspaceLimitRefusal(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  userId: string,
  limits: SlackServiceConfiguration,
  includeOpenTaskCount: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const member = await getItem<{ count?: number; threads?: string[]; tasks?: unknown }>(dependencies, slackMemberLimitKey(teamId, userId));
  if ((member?.count ?? 0) >= limits.memberWorkspaceLimit) {
    return {
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: limits.memberWorkspaceLimit,
      starterThreads: (member?.threads ?? []).map((subject) => parseSlackThreadSubject(subject)),
      // C16: the member's open AI-tool tasks share this counter (25b R6), so the reply counts them.
      // A count only: a task's title stays with its developer, never in the channel (D22).
      ...(includeOpenTaskCount ? { openTaskCount: openTaskCount(member?.tasks) } : {}),
    };
  }
  const organization = await getItem<{ count?: number }>(dependencies, slackOrganizationLimitKey(teamId));
  if ((organization?.count ?? 0) >= limits.organizationWorkspaceLimit) {
    return { outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: limits.organizationWorkspaceLimit, starterThreads: [] };
  }
  throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
}

/** The size of the member counter's `tasks` string set, which the document client reads as a Set. */
function openTaskCount(tasks: unknown): number {
  if (tasks instanceof Set) return tasks.size;
  return Array.isArray(tasks) ? tasks.length : 0;
}

/** The Slack limits with the admin's setting applied (R7); read only when a workspace is created. */
async function effectiveSlackLimits(dependencies: AwsBrokerDependencies, configured: SlackServiceConfiguration): Promise<SlackServiceConfiguration> {
  const limits = await readWorkspaceLimits(dependencies.documentClient, dependencies.tableName, {
    member: configured.memberWorkspaceLimit,
    organization: configured.organizationWorkspaceLimit,
  });
  return { ...configured, memberWorkspaceLimit: limits.member, organizationWorkspaceLimit: limits.organization };
}

async function recordThreadRequester(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  starter: boolean,
): Promise<void> {
  const slack = identity.slack;
  if (!slack) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: slackThreadKey(identity.ownerKey),
    UpdateExpression: [
      "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace)",
      ...(starter ? [", #starter = if_not_exists(#starter, :user), #creator = if_not_exists(#creator, :creator)"] : []),
      " ADD #requesters :users",
    ].join(""),
    ExpressionAttributeNames: {
      "#entity": "entityType",
      "#thread": "thread",
      "#workspace": "workspaceId",
      "#requesters": "requesters",
      ...(starter ? { "#starter": "starterUserId", "#creator": "creator" } : {}),
    },
    ExpressionAttributeValues: {
      ":entity": "SLACK_THREAD",
      ":thread": identity.subject,
      ":workspace": workspaceId,
      ":users": new Set([slack.requester.userId]),
      ...(starter ? { ":user": slack.requester.userId, ":creator": { userId: slack.requester.userId, ...(slack.requesterName === undefined ? {} : { name: slack.requesterName }) } } : {}),
    },
  }));
}

/** A pull request body with who asked for it: the developer footer (FR-023) or the Slack thread. */
async function attributedBody(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  body: string | undefined,
): Promise<string | undefined> {
  if (identity.developer) {
    const footer = developerFooter(identity.developer.name, identity.developer.client);
    const attributed = body ? `${body}\n\n---\n${footer}` : footer;
    return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
  }
  const slack = identity.slack;
  if (!slack) return body;
  const thread = await getItem<{ requesters?: Iterable<string> }>(dependencies, slackThreadKey(identity.ownerKey));
  const requesters = [...new Set([...(thread?.requesters ?? []), slack.requester.userId])].sort();
  const link = `https://slack.com/archives/${slack.thread.channelId}/p${slack.thread.threadTs.replace(".", "")}`;
  const attribution = `Requested in Slack thread ${link} by ${requesters.join(", ")}.`;
  const attributed = body ? `${body}\n\n---\n${attribution}` : attribution;
  return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
}

/** C13: who started an operation from a shared thread, for the developer's TASK_BUSY (C14). */
function channelOperation(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): ExtraItems {
  const shared = identity.sharedTask;
  const slack = identity.slack;
  if (shared?.state !== "continue" || slack === undefined) return () => [];
  return (operation) => [{ Put: {
    TableName: dependencies.tableName,
    Item: {
      pk: `DEVTASK#${shared.taskId}`, sk: `CHANNEL_OPERATION#${operation.id}`, entityType: "CHANNEL_OPERATION",
      slackUserId: slack.requester.userId, ...(slack.requesterName === undefined ? {} : { name: slack.requesterName }), createdAt: operation.createdAt,
      // 25c note 2: the State table's TTL attribute, 30 days on; the busy read needs it only while the
      // operation runs. Shared threads exist only in named environments, whose State table expires on it.
      [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(operation.createdAt),
    },
    ConditionExpression: "attribute_not_exists(pk)",
  } }];
}

/** Who asked, for the operation record (FR-022): a Slack member or a developer. */
function requesterOf(identity: AuthenticatedIdentity): { requestedBy?: OperationRequester } {
  if (identity.slack) return { requestedBy: identity.slack.requester };
  if (identity.developer) return { requestedBy: { kind: "developer", developerId: identity.developer.developerId, provider: identity.developer.provider } };
  return {};
}

/** Connector calls come from Slack turns only; their context keeps the Slack requester alone (R13). */
function slackRequesterOf(identity: AuthenticatedIdentity): { requestedBy?: SlackRequester } {
  return identity.slack ? { requestedBy: identity.slack.requester } : {};
}

function slackBindingKey(teamId: string, channelId: string) {
  return { pk: `SLACK_BINDING#${teamId}`, sk: `CHANNEL#${channelId}` };
}


/** Attempts at a thread's retry: a release or another retry that commits meanwhile is decided again once. */
const THREAD_RETRY_ATTEMPTS = 2;

/**
 * #213: a thread's failed preparation gave its charge back (releaseFailedPreparation), so its
 * retry charges again, as a first preparation does: the member who asked and the organization,
 * refused at either limit, with the workspace left failed and uncharged. A failure recorded before
 * #213, or one whose release did not land, still holds its starter's charge, and that retry is held
 * to it, so a release that commits meanwhile cancels the retry instead of leaving a preparing
 * workspace uncharged. A racing retry that won is answered with the workspace as it now stands.
 */
async function retryThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
  includeOpenTaskCount: boolean,
): Promise<{ status: WorkspaceInstance["status"]; operationId: string | null } | SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  let current = workspace;
  for (let attempt = 0; attempt < THREAD_RETRY_ATTEMPTS; attempt += 1) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, slackThreadKey(identity.ownerKey));
    const starter = typeof thread?.starterUserId === "string" ? thread.starterUserId : undefined;
    const effective = starter === undefined ? await effectiveSlackLimits(dependencies, limits) : undefined;
    const charge: TransactItems = effective === undefined
      ? [{ ConditionCheck: {
        TableName: dependencies.tableName,
        Key: slackThreadKey(identity.ownerKey),
        ConditionExpression: "starterUserId = :user",
        ExpressionAttributeValues: { ":user": starter },
      } }]
      : threadChargeItems(dependencies, identity, effective, current.id);
    try {
      const retried = await retryWorkspacePreparation(dependencies, identity, requestId, identity.ownerKey, project, current, charge);
      return { status: "PREPARING", operationId: retried.operationId };
    } catch (error) {
      if (!isConditional(error)) throw error;
      current = await requireWorkspace(dependencies, workspace.id);
      if (current.status !== "PREPARATION_FAILED" || current.activeOperationId) {
        return { status: current.status, operationId: current.activeOperationId ?? null };
      }
      if (effective !== undefined) {
        // threadWorkspaceLimitRefusal throws its own WORKSPACE_BUSY when no limit is reached.
        try {
          const refusal = await threadWorkspaceLimitRefusal(dependencies, slack.requester.teamId, slack.requester.userId, effective, includeOpenTaskCount);
          if (refusal.outcome === "LIMIT_REACHED") return refusal;
        } catch (refusalError) {
          if (!(refusalError instanceof AgentXError) || refusalError.code !== "WORKSPACE_BUSY") throw refusalError;
        }
      }
    }
  }
  throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
}

async function retryWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  targetOwnerKey: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
  /** Items that join the retry's transaction: a Slack thread's charge, or its check (#213). */
  extra: TransactItems = [],
): Promise<{
  operationId: string;
  workspace: ReturnType<typeof publicWorkspace>;
  alreadyReady: false;
}> {
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      targetOwnerKey,
    }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: project.definition,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspace.id,
        operationId,
      ),
    },
  };
  const updated = WorkspaceInstanceSchema.parse({
    ...workspace,
    status: "PREPARING",
    activeOperationId: operationId,
    fence,
    updatedAt: now,
  });
  const outbox = outboxRecord(updated, invocation, project.runtimeBinding);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :preparing, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
      ConditionExpression: "#status = :failed AND attribute_not_exists(activeOperationId) AND fence = :currentFence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":preparing": "PREPARING",
        ":failed": "PREPARATION_FAILED",
        ":operation": operationId,
        ":nextFence": fence,
        ":currentFence": workspace.fence,
        ":now": now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: {
        pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
        sk: `REQUEST#${requestId}`,
        entityType: "IDEMPOTENCY",
        operationId,
        workspaceId: workspace.id,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra,
  ] }));
  return { operationId, workspace: publicWorkspace(updated), alreadyReady: false };
}

async function resolveWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
  revision: number,
) {
  if (!Number.isInteger(revision) || revision < 1) throw agentXError("CONFIG_INVALID", "revision is required");
  await requireMembership(dependencies, identity.ownerKey, projectName);
  await requireProject(dependencies, projectName, revision);
  const workspace = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
  if (!workspace) throw agentXError("WORKSPACE_NOT_READY", "workspace has not been prepared by an administrator");
  if (workspace.projectRevision !== revision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "workspace is pinned to another project revision");
  }
  return publicWorkspace(workspace);
}

async function createConversation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), workspaceId, createdAt: now, updatedAt: now };
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversation.id}`, entityType: "CONVERSATION", ...conversation },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return conversation;
}

/** A task operation, its worker invocation and outbox item: acceptTask's and the first developer task's (R3). */
async function taskOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  input: { requestId: string; conversationId: string; prompt: string; conversationStarted: boolean; requester: { requestedBy?: OperationRequester }; shared?: boolean; workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW"; workflowPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; readiness?: ProjectCommand[] },
  now: string,
): Promise<{ operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number }> {
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const resolvedModel = await resolveProjectModel(dependencies, settings);
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    conversationId: input.conversationId,
    kind: "task",
    ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
    requestId: input.requestId,
    payloadHash: hashJson({ conversationId: input.conversationId, prompt: input.prompt }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...input.requester,
  });
  operation.settingsRevision = settings.definition.revision;
  // 25c note 1: the hash above is the request's own; only the worker's copy gets the re-read line.
  const phaseInstructions = input.workflowPhase === "REQUIREMENTS"
    ? "Prepare a concise requirements brief with Goal, Scope, Non-goals, Acceptance criteria, and Assumptions. Do not design implementation or edit files."
    : input.workflowPhase === "DESIGN"
      ? "Prepare a concise design proposal with Proposed approach, Affected areas, Risks, and Alternatives. Do not edit files."
      : input.workflowPhase === "IMPLEMENTATION_PLAN"
        ? "Prepare an ordered coding plan with Goal, Files or areas, Steps, Checks, and Risks. Do not edit files."
        : "Return a concise plan with Goal, What will change, Checks, and Risks or questions. Name relevant files and exact checks where known.";
  const selectedPrompt = input.workflowMode === "PLAN"
    ? `Planning phase only. Do not edit, write, or create files. Inspect the request and repository. ${phaseInstructions} Avoid filler and include only material risks or genuine unanswered questions. This linked detail is shown to the owner for approval before the next phase or code changes.\n\nRequest:\n${input.prompt}`
    : input.workflowMode === "REVIEW"
      ? `Review the current code read-only for the current task. Do not edit files or run commands that modify the workspace. Return concise critic and security review findings. The broker will bind your reports to this operation and candidate.\n\n${input.prompt}`
      : input.prompt;
  const prompt = workerPrompt(selectedPrompt, input.shared === true);
  if (input.shared === true && prompt === input.prompt) {
    console.log(JSON.stringify({ component: "broker", event: "developer.shared_reread_omitted", operationId }));
  }
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "task",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      conversationId: input.conversationId,
      prompt,
      conversationStarted: input.conversationStarted,
      ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }),
      ...(resolvedModel.model === undefined ? {} : { model: resolvedModel.model }),
      ...(resolvedModel.diagnostic === undefined ? {} : { modelSelectionDiagnostic: resolvedModel.diagnostic }),
      // Spec 051 (P-1): the checks the worker reruns when the agent finishes. The latest revision's readiness, as
      // publicationProject merges it, since that is what publication gates on. None when the project has none.
      ...((input.readiness ?? settings.definition.readiness).length === 0 ? {} : { readiness: input.readiness ?? settings.definition.readiness }),
    },
  };
  return { operation, outbox: outboxRecord(workspace, invocation), fence };
}

async function acceptTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  extra: ExtraItems = () => [],
  options: { sharedTask?: boolean; workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW"; workflowPhase?: "REQUIREMENTS" | "DESIGN" | "IMPLEMENTATION_PLAN"; readiness?: ProjectCommand[] } = {},
): Promise<{ operation: Operation; duplicate: boolean }> {
  assertNoUntrustedRoutingFields(value);
  const request = OperationRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({ conversationId: request.conversationId, prompt: request.prompt });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  const conversation = await getItem<{ startedAt?: string }>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CONVERSATION#${request.conversationId}`,
  });
  if (!conversation) throw agentXError("NOT_FOUND", "conversation not found");
  // Only a recorded attribute means "started"; conversations from before this attribute existed
  // have none, so their next task creates the session instead of failing closed.
  const conversationStarted = typeof conversation.startedAt === "string";
  if (!["READY", "STOPPED"].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const now = new Date().toISOString();
  const { operation, outbox, fence } = await taskOperationParts(dependencies, workspace, {
    requestId: request.requestId,
    conversationId: request.conversationId,
    prompt: request.prompt,
    conversationStarted,
    requester: requesterOf(identity),
    // 25c note 1: a turn from an open shared thread, or the developer's own turn on a shared task.
    shared: identity.sharedTask?.state === "continue" || options.sharedTask === true,
    ...(options.workflowMode === undefined ? {} : { workflowMode: options.workflowMode }),
    ...(options.workflowPhase === undefined ? {} : { workflowPhase: options.workflowPhase }),
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
  }, now);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        // Spec 051 Ruling T: until its own result arrives, the task reads as interrupted, so no older report stands.
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now, latestChecks = :latestChecks",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED", ":operation": operation.id, ":fence": fence, ":now": now,
          ":latestChecks": latestChecksItem({ status: "not_verified", reason: "interrupted" }, operation.id, fence, now),
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId: operation.id, payloadHash: requestHash }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptPullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  extra: ExtraItems = () => [],
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({
    repository: request.repository,
    title: request.title,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.draft === undefined ? {} : { draft: request.draft }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return {
      operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)),
      duplicate: true,
    };
  }
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(
      workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY",
      `workspace is ${workspace.status}`,
    );
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const body = await attributedBody(dependencies, identity, request.body);

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const headBranch = `agentx/${operationId}`;
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "publish",
    requestId: request.requestId,
    payloadHash: requestHash,
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.publication = {
    repository: repository.name,
    repositoryUrl: repository.url,
    headBranch,
    baseBranch: repository.defaultBranch,
    title: request.title,
    codeBuildGates: repository.codeBuildGates ?? [],
    ...(body === undefined ? {} : { body }),
    ...(request.draft === undefined ? {} : { draft: request.draft }),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "publish",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
    payload: {
      mode: "create",
      project: project.definition,
      repository: repository.name,
      title: request.title,
      ...(body === undefined ? {} : { body }),
      headBranch,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        identity.ownerKey,
        workspaceId,
        operationId,
        "push",
        repository.name,
      ),
      // Spec 051 P-2: a failing check opens a draft (reconcilePullRequest) rather than refusing the publication.
      // Without readiness there is no check to report, and the worker need not be asked whether it can.
      ...(project.definition.readiness.length === 0 ? {} : { reportChecks: true as const }),
    },
  };
  const outbox = outboxRecord(workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":busy": "BUSY",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptPullRequestLifecycle(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  // C13: a continue thread's marker naming the teammate, as tasks and pull requests write (final review M2).
  extra: ExtraItems = () => [],
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestLifecycleRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({
    repository: request.repository,
    pullRequestNumber: request.pullRequestNumber,
    action: request.action,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const existingRecord = await getItem<PullRequestRecord>(
    dependencies,
    pullRequestKey(workspaceId, request.repository, request.pullRequestNumber),
  );
  const remote = await dependencies.githubPullRequests.getPullRequest(repository.url, request.pullRequestNumber);
  const record = existingRecord ?? await adoptLegacyPullRequest(
    dependencies,
    workspaceId,
    repository.name,
    repository.url,
    remote,
  );
  if (record.repositoryUrl !== repository.url) throw agentXError("FORBIDDEN", "pull request repository is outside this project revision");
  if (remote.headBranch !== record.headBranch || remote.baseBranch !== record.baseBranch) {
    throw agentXError("STALE_FENCE", "pull request branch identity changed outside AgentX");
  }
  if (remote.headCommit !== record.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request head changed outside AgentX; reconcile it before retrying");
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  if (request.action === "edit" || request.action === "close" || request.action === "reopen") {
    if (request.action === "edit" && remote.state === "merged") {
      throw agentXError("CONFIG_INVALID", "merged pull request metadata is immutable through AgentX");
    }
    if (request.action === "close" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be closed");
    }
    if (request.action === "reopen" && remote.state !== "closed") {
      throw agentXError("CONFIG_INVALID", "only a closed, unmerged pull request can be reopened");
    }
    const updated = await dependencies.githubPullRequests.updatePullRequest(record.repositoryUrl, record.number, {
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.body === undefined
        ? {}
        : { body: (await attributedBody(dependencies, identity, request.body)) ?? request.body }),
      ...(request.action === "close" ? { state: "closed" as const } : {}),
      ...(request.action === "reopen" ? { state: "open" as const } : {}),
    });
    const result: PullRequestLifecycleResult = PullRequestLifecycleResultSchema.parse({
      action: request.action,
      repository: record.repository,
      number: record.number,
      url: updated.url,
      state: updated.state,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      commit: updated.headCommit,
      checks: [],
      reconciled: false,
    });
    const operation = operationRecord({
      id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
      payloadHash: requestHash, status: "SUCCEEDED", fence: workspace.fence,
      createdAt: now, updatedAt: now, result,
      ...requesterOf(identity),
    });
    const updatedRecord: PullRequestRecord = {
      ...record,
      state: updated.state,
      expectedHeadCommit: updated.headCommit,
      title: updated.title,
      body: updated.body,
      updatedAt: now,
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: updatedRecord } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action === "replace" || request.action === "revert") {
    if (request.action === "replace" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be replaced");
    }
    if (request.action === "revert" && (remote.state !== "merged" || !remote.mergeCommit)) {
      throw agentXError("CONFIG_INVALID", "only a merged pull request with a merge commit can be reverted");
    }
    if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
      throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
    }
    const fence = workspace.fence + 1;
    const title = request.title ?? `${request.action === "replace" ? "Replace" : "Revert"}: ${remote.title}`;
    const baseBody = request.body ?? (request.action === "replace"
      ? `Clean replacement for #${record.number}.`
      : `Reverts merged pull request #${record.number}.`);
    const body = (await attributedBody(dependencies, identity, baseBody)) ?? baseBody;
    const headBranch = `agentx/${operationId}`;
    const operation = operationRecord({
      id: operationId, workspaceId, kind: "publish", requestId: request.requestId,
      payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
      ...requesterOf(identity),
    });
    operation.settingsRevision = settingsRevision;
    operation.publication = {
      repository: record.repository,
      repositoryUrl: record.repositoryUrl,
      headBranch,
      baseBranch: record.baseBranch,
      title,
      body,
      codeBuildGates: repository.codeBuildGates ?? [],
      mode: request.action,
      targetPullRequestNumber: record.number,
      ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
    };
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      kind: "publish",
      operationId,
      workspaceId,
      fence,
      projectRevision: workspace.projectRevision,
      callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
      payload: {
        mode: request.action,
        project: project.definition,
        repository: record.repository,
        title,
        body,
        headBranch,
        repositoryGrant: issueRepositoryGrant(
          dependencies, project, identity.ownerKey, workspaceId, operationId, "push", record.repository,
        ),
        targetPullRequestNumber: record.number,
        ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
        // Spec 051 P-2, as for a new pull request.
        ...(project.definition.readiness.length === 0 ? {} : { reportChecks: true as const }),
      },
    };
    const outbox = outboxRecord(workspace, invocation);
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
          ":operation": operationId, ":fence": fence, ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      ...extra(publicOperation(operation)),
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action !== "append" && request.action !== "sync") {
    throw agentXError("CONFIG_INVALID", "pull request action is not supported");
  }
  if (remote.state !== "open") throw agentXError("CONFIG_INVALID", "only an open pull request can be maintained");
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
    payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.maintenance = {
    action: request.action,
    repository: record.repository,
    repositoryUrl: record.repositoryUrl,
    pullRequestNumber: record.number,
    headBranch: record.headBranch,
    baseBranch: record.baseBranch,
    expectedHeadCommit: record.expectedHeadCommit,
    codeBuildGates: repository.codeBuildGates ?? [],
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "maintain",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
    payload: {
      action: request.action,
      project: project.definition,
      repository: record.repository,
      pullRequestNumber: record.number,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      expectedHeadCommit: record.expectedHeadCommit,
      repositoryGrant: issueRepositoryGrant(
        dependencies, project, identity.ownerKey, workspaceId, operationId, "push", record.repository,
      ),
    },
  };
  const outbox = outboxRecord(workspace, invocation);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspaceId),
      UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
      ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
        ":operation": operationId, ":fence": fence, ":now": now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra(publicOperation(operation)),
  ] }));
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptCancellation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  targetOperationId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  return requestCancellation(dependencies, workspace, targetOperationId, requesterOf(identity));
}

async function stopWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  await requireAdministrator(dependencies, identity, workspace.projectName);
  if (workspace.status !== "READY" || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", "cancel or finish active work before stopping compute");
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "manual compute stop is not supported; idle sessions stop automatically");
}

/** Only a coding task is cancelled: stopping a prepare or a publish midway could leave half a clone or push. */
const CANCELLABLE_KINDS: ReadonlySet<string> = new Set(["task"]);

type TaskCancellation =
  | { outcome: "CANCEL_REQUESTED"; workspaceId: string; targetOperationId: string; cancelOperationId: string }
  // Issue 196: finishedStatus names the final status when the running task had already finished.
  | { outcome: "NOTHING_RUNNING"; workspaceId?: string; finishedStatus?: OperationStatus };

/** Cancels the workspace's running task, if it has one (#126). */
async function cancelRunningTask(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  requester: { requestedBy?: OperationRequester },
  extra: ExtraItems = () => [],
): Promise<TaskCancellation> {
  const targetOperationId = workspace.activeOperationId;
  if (!targetOperationId) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id };
  const target = await requireOperation(dependencies, workspace.id, targetOperationId);
  if (!CANCELLABLE_KINDS.has(target.kind) || target.status === "CANCEL_REQUESTED") {
    return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id };
  }
  if (TERMINAL.has(target.status)) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, finishedStatus: target.status };
  const result = await requestCancellation(dependencies, workspace, targetOperationId, requester, extra);
  // A duplicate here means the task finished before the cancel was recorded.
  if (result.duplicate) return { outcome: "NOTHING_RUNNING", workspaceId: workspace.id, finishedStatus: result.operation.status };
  return { outcome: "CANCEL_REQUESTED", workspaceId: workspace.id, targetOperationId, cancelOperationId: result.operation.id };
}

/** An administrator cancels any workspace's running task (#126). */
async function cancelWorkspaceTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<TaskCancellation> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  await requireAdministrator(dependencies, identity, workspace.projectName);
  return cancelRunningTask(dependencies, workspace, {});
}

/**
 * The Slack ingress's stop command (#126): a thread's messages queue behind its running task, so a
 * "stop" in the thread is handled before the queue, here. Invoked by the ingress Lambda only, never
 * through API Gateway. Any member of the bound channel may stop the thread's task, as any member
 * may start one.
 */
export interface SlackStopTaskEvent {
  source: "agentx.slack-ingress";
  action: "stop-task";
  thread: SlackThread;
  userId: string;
}

export interface SlackWorkflowStartEvent {
  source: "agentx.slack-ingress";
  action: "start-workflow";
  thread: SlackThread;
  userId: string;
  instructions: string;
  workflowPath?: "QUICK" | "FULL";
  requestId: string;
}

export interface SlackWorkflowDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-decision";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  artifactDigest: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
  reason: string;
  selectedOptionalCheckIds: string[];
}

export interface SlackWorkflowFeedbackDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-feedback-decision";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  feedbackId: string;
  candidateDigest: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
}

export function isSlackWorkflowStartEvent(event: unknown): event is SlackWorkflowStartEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "start-workflow" && value.requestContext === undefined
    && typeof value.instructions === "string" && value.instructions.trim().length > 0
    && typeof value.requestId === "string" && (value.workflowPath === undefined || value.workflowPath === "QUICK" || value.workflowPath === "FULL");
}

async function startSlackWorkflow(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowStartEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const instructions = event.instructions.trim();
  if (!instructions || Buffer.byteLength(instructions, "utf8") > 65_536) throw agentXError("CONFIG_INVALID", "workflow request is empty or too long");
  if (dependencies.developer.slackTeamId !== thread.teamId) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
  const binding = await getSlackBinding(dependencies, thread.teamId, thread.channelId);
  if (binding === undefined) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  const existingWorkflowThread = await getItem(dependencies, sharedTaskKey(thread));
  const threadOwnerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, slackThreadSubject(thread));
  const existingThreadTask = await getItem<{ workspaceId?: string; closedAt?: string }>(dependencies, slackThreadKey(threadOwnerKey));
  if (existingWorkflowThread !== undefined || (typeof existingThreadTask?.workspaceId === "string" && existingThreadTask.closedAt === undefined)) {
    throw agentXError("WORKSPACE_BUSY", "this Slack thread already has a task; start the workflow in a new thread");
  }
  const caller: DeveloperCaller = { developerId: userId, sessionId: "slack-workflow", amr: "slack", name: `Slack user ${userId}`, slackUserId: userId };
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller, thread);
  const request = {
    method: "POST", path: "/v1/dev/tasks", headers: {}, requestId,
    body: JSON.stringify({ requestId, project: binding.projectName, instructions, client: "slack", workflow: true, workflowPath: event.workflowPath ?? "QUICK", shareToChannel: true, channel: thread.channelId }),
  };
  return await routeDeveloperTaskRequest(routeDeps, caller, request, new URL(request.path, "https://agentx.invalid")) as { task: { taskId: string } };
}

const randomUUIDSchema = { parse(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw agentXError("CONFIG_INVALID", "workflow request ID is invalid"); return value; } };

export function isSlackWorkflowDecisionEvent(event: unknown): event is SlackWorkflowDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.artifactDigest === "string"
    && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES") && typeof value.reason === "string"
    && Array.isArray(value.selectedOptionalCheckIds);
}

async function decideSlackWorkflow(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowDecisionEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined || task.slackUserId !== userId) throw agentXError("FORBIDDEN", "only the task owner can decide this plan");
  if (task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this plan belongs to another Slack thread");
  }
  const caller: DeveloperCaller = { developerId: userId, sessionId: "slack-workflow", amr: "slack", name: task.developerName, slackUserId: userId };
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  const body = JSON.stringify({
    requestId, expectedRevision: event.expectedRevision, artifactDigest: event.artifactDigest,
    decision: event.decision, reason: event.reason, selectedOptionalCheckIds: event.selectedOptionalCheckIds,
  });
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/decision`, headers: {}, requestId, body }, new URL(`/v1/dev/tasks/${taskId}/workflow/decision`, "https://agentx.invalid"));
}

export function isSlackWorkflowFeedbackDecisionEvent(event: unknown): event is SlackWorkflowFeedbackDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-feedback-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.feedbackId === "string" && /^[a-f0-9]{64}$/.test(value.feedbackId)
    && typeof value.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(value.candidateDigest)
    && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES");
}

async function decideSlackWorkflowFeedback(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackWorkflowFeedbackDecisionEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const taskId = randomUUIDSchema.parse(event.taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined || task.slackUserId !== userId) throw agentXError("FORBIDDEN", "only the task owner can decide this PR feedback");
  if (task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this PR feedback belongs to another Slack thread");
  }
  const feedback = task.workflow?.feedback;
  if (feedback?.status !== "PENDING" || feedback.feedbackId !== event.feedbackId || feedback.candidateDigest !== event.candidateDigest
    || task.workflow?.revision !== event.expectedRevision || task.workflow.candidate?.digest !== event.candidateDigest) {
    throw agentXError("CONFIG_INVALID", "this PR feedback changed; use the latest AgentX message");
  }
  const caller: DeveloperCaller = { developerId: userId, sessionId: "slack-workflow", amr: "slack", name: task.developerName, slackUserId: userId };
  const routeDeps = developerTaskRouteDependencies({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  const body = JSON.stringify({
    requestId, expectedRevision: event.expectedRevision, feedbackId: event.feedbackId,
    candidateDigest: event.candidateDigest, decision: event.decision,
  });
  return routeDeveloperTaskRequest(routeDeps, caller, { method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, headers: {}, requestId, body }, new URL(`/v1/dev/tasks/${taskId}/workflow/feedback-decision`, "https://agentx.invalid"));
}

export function isSlackStopTaskEvent(event: unknown): event is SlackStopTaskEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.slack-ingress" && value.action === "stop-task" && value.requestContext === undefined;
}

async function stopSlackThreadTask(dependencies: AwsBrokerDependencies, event: SlackStopTaskEvent): Promise<TaskCancellation> {
  const thread = SlackThreadSchema.parse(event.thread);
  const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: event.userId });
  const binding = await getSlackBinding(dependencies, thread.teamId, thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  // Spec 043 FR-005: a thread running a SWE-bench run stops the run.
  if (dependencies.swebench !== undefined) {
    const runId = await stopSwebenchRun(swebenchDependencies(dependencies), thread, requester);
    if (runId !== undefined) return { outcome: "CANCEL_REQUESTED", workspaceId: runId, targetOperationId: runId, cancelOperationId: runId };
  }
  // Q8: in a continue thread a teammate's stop cancels the task's running task operation, whoever
  // started it, as the developer's own cancel would. A view-only or closed thread, or one whose
  // channel now serves another project (F16), stops nothing.
  const shared = await sharedThread(dependencies, thread);
  if (shared !== undefined) {
    if (!sharedThreadOpen(shared, binding)) return { outcome: "NOTHING_RUNNING" };
    const workspace = await requireWorkspace(dependencies, shared.workspaceId);
    if (workspace.ownerKey !== shared.ownerKey) throw agentXError("FORBIDDEN", "workspace does not belong to this task");
    return cancelRunningTask(dependencies, workspace, { requestedBy: requester });
  }
  const ownerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, slackThreadSubject(thread));
  const record = await getItem<{ workspaceId?: string; closedAt?: string }>(dependencies, slackThreadKey(ownerKey));
  if (typeof record?.workspaceId !== "string" || record.closedAt !== undefined) return { outcome: "NOTHING_RUNNING" };
  const workspace = await requireWorkspace(dependencies, record.workspaceId);
  if (workspace.ownerKey !== ownerKey) throw agentXError("FORBIDDEN", "workspace does not belong to this thread");
  return cancelRunningTask(dependencies, workspace, { requestedBy: requester });
}

async function handleCallback(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
  action: string,
) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  // #201 Release A: accept the child format before any reconciler starts issuing it. The key
  // family is selected by the envelope, never by unverified claims or signature fallback.
  const cancelClaims = token.startsWith("cancel-v1.")
    ? verifyCancelCallbackCapability(dependencies.callbackSigningKey, token, action)
    : undefined;
  const claims = cancelClaims ?? verifyCapability(dependencies, token, action as CallbackClaims["actions"][number]);
  if (claims.workspaceId !== workspaceId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
  }
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  if (cancelClaims !== undefined) {
    if (operation.kind !== "cancel" || operation.id !== operationId || operation.workspaceId !== workspaceId
      || operation.fence !== cancelClaims.fence || operation.targetOperationId !== cancelClaims.targetOperationId) {
      throw cancelCallbackForbidden();
    }
    const target = await getItem<OperationRecord>(dependencies, operationKey(workspaceId, cancelClaims.targetOperationId));
    if (target === undefined || target.id !== cancelClaims.targetOperationId
      || target.workspaceId !== workspaceId || target.fence !== cancelClaims.fence) {
      throw cancelCallbackForbidden();
    }
  }
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (action !== "result" && TERMINAL.has(operation.status)) {
    throw agentXError("STALE_FENCE", "terminal operations cannot publish more output");
  }
  const body = parseBody(request.body);
  if (action === "events") {
    const accepted = await appendEvents(dependencies, operation, body);
    return json({ accepted }, request.requestId);
  }
  if (action === "artifacts") {
    const artifactId = await putArtifact(dependencies, operation, body);
    return json({ artifactId }, request.requestId);
  }
  if (action === "pull-request") {
    const pullRequest = await reconcilePullRequest(dependencies, operation, body);
    return json(pullRequest, request.requestId);
  }
  if (action === "pull-request-update") {
    const pullRequest = await reconcilePullRequestUpdate(dependencies, operation, body);
    return json(pullRequest, request.requestId);
  }
  if (action === "codebuild") {
    const build = await handleCodeBuild(dependencies, operation, body);
    return json(build, request.requestId);
  }
  const result = await recordTerminalResult(dependencies, operation, body);
  return json({ operation: publicOperation(result) }, request.requestId);
}

async function handleCodeBuild(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<CodeBuildCheckResult> {
  const scope = operation.publication ?? operation.maintenance;
  if ((operation.kind !== "publish" && operation.kind !== "maintain") || !scope) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot start CodeBuild gates");
  }
  const input = object(value, "CodeBuild callback");
  const allowed = new Set(["action", "repository", "gate", "projectName", "commit", "buildId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "CodeBuild callback contains unknown fields");
  }
  if (input.action !== "start" && input.action !== "status") {
    throw agentXError("CONFIG_INVALID", "CodeBuild callback action is invalid");
  }
  if (input.repository !== scope.repository) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild repository is outside the operation scope");
  }
  if (typeof input.gate !== "string" || typeof input.projectName !== "string") {
    throw agentXError("CONFIG_INVALID", "CodeBuild gate and projectName are required");
  }
  const gate = scope.codeBuildGates.find((candidate) => candidate.name === input.gate);
  if (!gate || gate.projectName !== input.projectName) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild gate is outside the registered project scope");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "CodeBuild candidate commit is invalid");
  }

  await bindCandidateCommit(dependencies, operation, input.commit);
  const key = codeBuildKey(operation.workspaceId, operation.id, gate.name);
  const existing = await getItem<CodeBuildRecord>(dependencies, key);
  if (existing) {
    assertCodeBuildRecord(existing, operation, scope.repository, gate, input.commit);
    if (input.action === "start") return existing.evidence;
    if (input.buildId !== existing.buildId) {
      throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild build ID is outside the operation scope");
    }
    return refreshCodeBuildRecord(dependencies, existing);
  }
  if (input.action !== "start" || input.buildId !== undefined) {
    throw agentXError("NOT_FOUND", "CodeBuild gate has not been started");
  }

  const idempotencyToken = createHash("sha256")
    .update(`${operation.id}:${gate.name}:${input.commit}`)
    .digest("hex");
  const evidence = await dependencies.codeBuild.start({
    gate: gate.name,
    projectName: gate.projectName,
    commit: input.commit,
    timeoutMinutes: gate.timeoutMinutes,
    idempotencyToken,
  });
  const now = new Date().toISOString();
  const record: CodeBuildRecord = {
    ...key,
    entityType: "CODEBUILD",
    workspaceId: operation.workspaceId,
    operationId: operation.id,
    fence: operation.fence,
    repository: scope.repository,
    gate: gate.name,
    projectName: gate.projectName,
    requestedSourceVersion: input.commit,
    idempotencyToken,
    buildId: evidence.buildId,
    evidence,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<CodeBuildRecord>(dependencies, key);
    if (!concurrent) throw error;
    assertCodeBuildRecord(concurrent, operation, scope.repository, gate, input.commit);
    return concurrent.evidence;
  }
  return evidence;
}

async function bindCandidateCommit(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  commit: string,
): Promise<void> {
  if (operation.candidateCommit !== undefined && operation.candidateCommit !== commit) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild candidate commit changed during the operation");
  }
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET candidateCommit = if_not_exists(candidateCommit, :commit)",
      ConditionExpression: "attribute_not_exists(candidateCommit) OR candidateCommit = :commit",
      ExpressionAttributeValues: { ":commit": commit },
    }));
  } catch (error) {
    if (isConditional(error)) {
      throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild candidate commit changed during the operation");
    }
    throw error;
  }
}

function assertCodeBuildRecord(
  record: CodeBuildRecord,
  operation: OperationRecord,
  repository: string,
  gate: CodeBuildGateDefinition,
  commit: string,
): void {
  if (
    record.operationId !== operation.id || record.fence !== operation.fence ||
    record.repository !== repository || record.gate !== gate.name ||
    record.projectName !== gate.projectName || record.requestedSourceVersion !== commit
  ) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild record is outside the operation scope");
  }
}

async function refreshCodeBuildRecord(
  dependencies: AwsBrokerDependencies,
  record: CodeBuildRecord,
): Promise<CodeBuildCheckResult> {
  const evidence = await dependencies.codeBuild.status({
    gate: record.gate,
    projectName: record.projectName,
    commit: record.requestedSourceVersion,
    buildId: record.buildId,
  });
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: record.pk, sk: record.sk },
    UpdateExpression: "SET evidence = :evidence, updatedAt = :now",
    ConditionExpression: "buildId = :buildId AND fence = :fence",
    ExpressionAttributeValues: {
      ":evidence": evidence,
      ":now": new Date().toISOString(),
      ":buildId": record.buildId,
      ":fence": record.fence,
    },
  }));
  return evidence;
}

async function reconcilePullRequestUpdate(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
) {
  if (operation.kind !== "maintain" || !operation.maintenance) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot update a pull request");
  }
  const input = object(value, "pull request update callback");
  const expected = operation.maintenance;
  const allowed = new Set([
    "repository", "pullRequestNumber", "action", "headBranch", "baseBranch", "previousCommit", "commit",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "pull request update callback contains unknown fields");
  }
  for (const key of ["repository", "pullRequestNumber", "action", "headBranch", "baseBranch"] as const) {
    if (input[key] !== expected[key]) {
      throw agentXError("CALLBACK_FORBIDDEN", `pull request update callback ${key} is outside the operation scope`);
    }
  }
  if (input.previousCommit !== expected.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request update used a stale expected head");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "updated pull request commit is invalid");
  }
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  const record = await requirePullRequest(
    dependencies,
    operation.workspaceId,
    expected.repository,
    expected.pullRequestNumber,
  );
  if (record.expectedHeadCommit === input.commit) {
    return { url: record.url, state: record.state, reconciled: true };
  }
  if (record.expectedHeadCommit !== expected.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request record changed before callback reconciliation");
  }
  const remote = await dependencies.githubPullRequests.getPullRequest(record.repositoryUrl, record.number);
  if (
    remote.state !== "open" || remote.headBranch !== record.headBranch ||
    remote.baseBranch !== record.baseBranch || remote.headCommit !== input.commit
  ) {
    throw agentXError("STALE_FENCE", "GitHub pull request state does not match the worker update");
  }
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: pullRequestKey(operation.workspaceId, expected.repository, expected.pullRequestNumber),
    UpdateExpression: "SET expectedHeadCommit = :commit, #state = :state, updatedAt = :now",
    ConditionExpression: "expectedHeadCommit = :previous",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":commit": input.commit,
      ":previous": expected.expectedHeadCommit,
      ":state": remote.state,
      ":now": new Date().toISOString(),
    },
  }));
  return { url: remote.url, state: remote.state, reconciled: false };
}

async function reconcilePullRequest(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
) {
  if (operation.kind !== "publish" || !operation.publication) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot create a pull request");
  }
  const input = object(value, "pull request callback");
  const expected = operation.publication;
  const allowed = new Set(["repository", "repositoryUrl", "headBranch", "baseBranch", "commit", "title", "body", "checks"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "pull request callback contains unknown fields");
  }
  for (const key of ["repository", "repositoryUrl", "headBranch", "baseBranch", "title"] as const) {
    const expectedValue = expected[key];
    if (input[key] !== expectedValue) {
      throw agentXError("CALLBACK_FORBIDDEN", `pull request callback ${key} is outside the operation scope`);
    }
  }
  if (expected.body === undefined && input.body !== undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "pull request callback body is outside the operation scope");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "published commit is invalid");
  }
  const publishChecks = publicationChecks(input.checks);
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  // A revert undoes a merged pull request, so the workspace's own task work is not what it publishes.
  const latestChecks = expected.mode === "revert" ? undefined : await latestWorkspaceChecks(dependencies, operation.workspaceId);
  const standingFailures = expected.mode === "revert" ? [] : await workspaceStandingFailures(dependencies, operation.workspaceId);
  const { body, draft } = checkedPullRequest(expected.body, expected.draft, publishChecks, latestChecks, standingFailures);
  const pullRequest = await dependencies.githubPullRequests.reconcilePullRequest({
    repositoryUrl: expected.repositoryUrl,
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    title: expected.title,
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
  });
  const record: PullRequestRecord = {
    ...pullRequestKey(operation.workspaceId, expected.repository, pullRequest.number),
    entityType: "PULL_REQUEST",
    workspaceId: operation.workspaceId,
    repository: expected.repository,
    repositoryUrl: expected.repositoryUrl,
    number: pullRequest.number,
    url: pullRequest.url,
    state: "open",
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    expectedHeadCommit: input.commit,
    title: expected.title,
    body: body ?? "",
    createdByOperationId: operation.id,
    ...(expected.mode === "replace" && expected.targetPullRequestNumber !== undefined
      ? { replacementFor: expected.targetPullRequestNumber }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  if (expected.mode === "replace" && expected.targetPullRequestNumber !== undefined) {
    const original = await requirePullRequest(
      dependencies,
      operation.workspaceId,
      expected.repository,
      expected.targetPullRequestNumber,
    );
    const closed = await dependencies.githubPullRequests.updatePullRequest(
      original.repositoryUrl,
      original.number,
      { state: "closed" },
    );
    const linkedOriginal: PullRequestRecord = {
      ...original,
      state: closed.state,
      replacedBy: pullRequest.number,
      updatedAt: new Date().toISOString(),
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: record } },
      { Put: { TableName: dependencies.tableName, Item: linkedOriginal } },
    ] }));
  } else {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: record,
    }));
  }
  // Ruling Z: the worker's result says whether the pull request is a draft, so the reply can say so.
  return { ...pullRequest, draft: draft === true };
}

/** Spec 051 (D-7): the checks the worker ran at publish, judged against their befores; none from an older worker. */
function publicationChecks(value: unknown): CheckEntry[] | undefined {
  if (value === undefined) return undefined;
  const parsed = CheckReportSchema.shape.checks.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "pull request callback checks are invalid");
  return parsed.data;
}

/**
 * The workspace's latest checks (Ruling T), or undefined: none yet. One that does not parse is logged and treated as
 * none; a failing publish check still makes the draft (Ruling S).
 */
async function latestWorkspaceChecks(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<LatestChecks | undefined> {
  const workspace = await getItem<{ latestChecks?: { report?: unknown; operationId?: unknown } }>(dependencies, workspaceKey(workspaceId));
  if (workspace?.latestChecks === undefined) return undefined;
  const parsed = LatestChecksSchema.safeParse(workspace.latestChecks.report);
  if (parsed.success) return parsed.data;
  console.log(JSON.stringify({ component: "broker", event: "pull_request.latest_checks_unreadable", workspaceId, operationId: typeof workspace.latestChecks.operationId === "string" ? workspace.latestChecks.operationId : undefined }));
  return undefined;
}

/** Spec 051 M-1: labels and outputs redacted again at the broker before they reach GitHub (as #154 does for errors). */
function redactedEntries(checks: readonly CheckEntry[]): CheckEntry[] {
  return checks.map((check) => ({ ...check, label: redactText(check.label), output: redactText(check.output) }));
}

/**
 * Spec 051 FR-008 (D-2): the pull request's description and draft flag, given the checks. A draft when a check that
 * passed before fails now, whatever was asked; otherwise the draft flag stays as asked (the developer API asks for a
 * draft by default). The checks section goes after the description, cut so the whole stays within GitHub's limit.
 * With nothing to report, both are exactly as asked (Review Focus 5).
 */
function checkedPullRequest(
  body: string | undefined,
  draft: boolean | undefined,
  publishChecks: readonly CheckEntry[] | undefined,
  latestChecks: LatestChecks | undefined,
  standingFailures: readonly StandingFailure[] = [],
): { body: string | undefined; draft: boolean | undefined } {
  const separator = body === undefined || body === "" ? "" : "\n\n";
  const shownPublish = publishChecks === undefined ? undefined : redactedEntries(publishChecks);
  const shownLatest = latestChecks === undefined || "reason" in latestChecks ? latestChecks : { ...latestChecks, checks: redactedEntries(latestChecks.checks) };
  const shownStanding = standingFailures.map((failure) => ({ ...failure, label: redactText(failure.label) }));
  const section = checksSection(shownPublish, shownLatest, PULL_REQUEST_BODY_MAX_CHARS - (body?.length ?? 0) - separator.length, shownStanding);
  return {
    body: section === "" ? body : `${body ?? ""}${separator}${section}`,
    draft: checksMakeDraft(publishChecks, latestChecks, standingFailures) ? true : draft,
  };
}

async function assertCodeBuildGatesPassed(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  commit: string,
): Promise<void> {
  const scope = operation.publication ?? operation.maintenance;
  if (!scope) throw agentXError("CALLBACK_FORBIDDEN", "operation has no publication scope");
  if (
    operation.maintenance?.action === "sync" &&
    commit === operation.maintenance.expectedHeadCommit
  ) return;
  for (const gate of scope.codeBuildGates) {
    const record = await getItem<CodeBuildRecord>(
      dependencies,
      codeBuildKey(operation.workspaceId, operation.id, gate.name),
    );
    if (
      !record || record.fence !== operation.fence || record.repository !== scope.repository ||
      record.projectName !== gate.projectName || record.requestedSourceVersion !== commit ||
      record.evidence.status !== "SUCCEEDED" || record.evidence.resolvedSourceVersion !== commit
    ) {
      throw agentXError("CALLBACK_FORBIDDEN", `CodeBuild gate ${gate.name} has not passed for this candidate`);
    }
  }
}

async function appendEvents(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<number> {
  const input = object(value, "event callback");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 500) {
    throw agentXError("CONFIG_INVALID", "callback must contain 1 through 500 events");
  }
  const events = input.events.map((event) => {
    const item = object(event, "event");
    if (typeof item.type !== "string" || typeof item.timestamp !== "string") {
      throw agentXError("CONFIG_INVALID", "event type and timestamp are required");
    }
    return { type: item.type, timestamp: item.timestamp, payload: item.payload };
  });
  for (let offset = 0; offset < events.length; offset += EVENT_TRANSACTION_CHUNK) {
    const chunk = events.slice(offset, offset + EVENT_TRANSACTION_CHUNK);
    await appendEventChunk(dependencies, operation, chunk, offset, hashJson(value));
  }
  if (events.some((event) => event.type === "lifecycle" && isStatus(event.payload, "RUNNING"))) {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :running, updatedAt = :now",
      ConditionExpression: "#status = :dispatching OR #status = :accepted OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":running": "RUNNING", ":dispatching": "DISPATCHING", ":accepted": "ACCEPTED", ":now": new Date().toISOString() },
    })).catch(() => undefined);
  }
  if (events.some((event) => event.type === "lifecycle" && startsConversation(event.payload))) {
    await markConversationStarted(dependencies, operation);
  }
  return events.length;
}

/**
 * The authoritative record that a conversation owns a session. It outlives the workspace volume,
 * so a replaced volume fails closed on the next turn instead of silently starting the thread over.
 */
async function markConversationStarted(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
): Promise<void> {
  if (!operation.conversationId) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CONVERSATION#${operation.conversationId}` },
    UpdateExpression: "SET startedAt = :now, updatedAt = :now",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(startedAt)",
    ExpressionAttributeValues: { ":now": new Date().toISOString() },
  })).catch((error: unknown) => {
    // Already marked by an earlier delivery of the same event. Anything else must reach the worker,
    // which retries the batch, so the record cannot quietly fall behind the workspace.
    if (!isConditional(error)) throw error;
  });
}

async function appendEventChunk(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  events: Array<{ type: string; timestamp: string; payload: unknown }>,
  chunkOffset: number,
  batchHash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await requireOperation(dependencies, operation.workspaceId, operation.id);
    const start = current.eventSequence + 1;
    const markerKey = { pk: `OPERATION#${operation.id}`, sk: `EVENTBATCH#${batchHash}#${chunkOffset}` };
    if (await getItem(dependencies, markerKey)) return;
    const items = events.map((event, index) => ({
      pk: `OPERATION#${operation.id}`,
      sk: `EVENT#${String(start + index).padStart(12, "0")}`,
      entityType: "EVENT",
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      sequence: start + index,
      ...event,
    }));
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: dependencies.tableName,
          Key: operationKey(operation.workspaceId, operation.id),
          UpdateExpression: "SET eventSequence = :next",
          ConditionExpression: "eventSequence = :current AND fence = :fence",
          ExpressionAttributeValues: { ":next": current.eventSequence + events.length, ":current": current.eventSequence, ":fence": operation.fence },
        } },
        { Put: { TableName: dependencies.tableName, Item: { ...markerKey, entityType: "EVENT_BATCH" }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...items.map((item) => ({ Put: { TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } })),
      ] }));
      return;
    } catch (error) {
      if (!isConditional(error) || attempt === 3) throw error;
    }
  }
}

async function putArtifact(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<string> {
  const input = object(value, "artifact callback");
  if (typeof input.name !== "string" || typeof input.mediaType !== "string" || typeof input.content !== "string") {
    throw agentXError("CONFIG_INVALID", "artifact name, mediaType and content are required");
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw agentXError("CONFIG_INVALID", "artifact exceeds the 5 MB demo limit");
  }
  if (operation.workflowMode === "PLAN" && input.name === "plan.md" && Buffer.byteLength(input.content, "utf8") > WORKFLOW_PLAN_MAX_BYTES) {
    throw agentXError("CONFIG_INVALID", "plan artifact exceeds the workflow plan size limit");
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const artifactId = randomUUID();
  const objectKey = `private/${workspace.ownerKey}/${workspace.id}/${operation.id}/${artifactId}`;
  await dependencies.s3.send(new PutObjectCommand({
    Bucket: dependencies.artifactBucketName,
    Key: objectKey,
    Body: input.content,
    ContentType: input.mediaType,
  }));
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: {
      pk: `WORKSPACE#${workspace.id}`,
      sk: `ARTIFACT#${artifactId}`,
      entityType: "ARTIFACT",
      id: artifactId,
      workspaceId: workspace.id,
      operationId: operation.id,
      ownerKey: workspace.ownerKey,
      name: input.name,
      mediaType: input.mediaType,
      objectKey,
      size: Buffer.byteLength(input.content, "utf8"),
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return artifactId;
}

/**
 * Spec 025 R3: the first instructions of a developer task, queued in the prepare's own result
 * transaction. Returns the workspace update that replaces the prepare's (PREPARING straight to
 * BUSY) and the task's items. The pointer's condition makes a cancel that lands first win.
 */
async function queuedFirstTask(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  prepare: OperationRecord,
  pointer: DeveloperTaskPointerRecord & { pendingPrompt: string },
  now: string,
): Promise<{ workspaceUpdate: TransactItems[number]; items: TransactItems }> {
  const task = pointer.pendingWorkflowMode === "PLAN" ? await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId)) : undefined;
  const { operation, outbox, fence } = await taskOperationParts(dependencies, workspace, {
    requestId: pointer.firstRequestId,
    conversationId: pointer.conversationId,
    prompt: pointer.pendingPrompt,
    conversationStarted: false,
    requester: { requestedBy: pointer.requester },
    workflowMode: pointer.pendingWorkflowMode ?? "IMPLEMENT",
    ...(task?.workflow?.reviewPhase === undefined ? {} : { workflowPhase: task.workflow.reviewPhase }),
  }, now);
  return {
    workspaceUpdate: { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :busy, updatedAt = :now, preparationManifest = :manifest, activeOperationId = :task, fence = :taskFence, latestChecks = :latestChecks",
      ConditionExpression: "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":busy": "BUSY", ":now": now, ":manifest": ".agentx/preparation-manifest.json",
        ":task": operation.id, ":taskFence": fence, ":operation": prepare.id, ":fence": prepare.fence,
        ":latestChecks": latestChecksItem({ status: "not_verified", reason: "interrupted" }, operation.id, fence, now),
      },
    } },
    items: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${workspace.ownerKey}#${workspace.id}`, sk: `REQUEST#${pointer.firstRequestId}`, entityType: "IDEMPOTENCY", operationId: operation.id, payloadHash: operation.payloadHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: taskPointerKey(workspace.id),
        UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
        ConditionExpression: "attribute_exists(pendingPrompt) AND attribute_not_exists(cancelledAt)",
      } },
    ],
  };
}

/** The queuing transaction met a transaction in flight; `cause` is DynamoDB's error. */
class QueuingConflict extends Error {
  constructor(override readonly cause: unknown) {
    super("the first task's transaction met another transaction in flight");
  }
}

function isTransactionConflict(error: unknown): boolean {
  const reasons = error instanceof Error ? (error as Error & { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons : undefined;
  return error instanceof Error && error.name === "TransactionCanceledException"
    && Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "TransactionConflict");
}

/**
 * Sends a terminal result. For a developer task's prepare (it has a pointer; a Slack workspace has
 * none) a success queues the first instructions in this same transaction (R3), and any other
 * outcome clears the raw instructions (controller ruling, Task 9 fix round 1). The pointer update
 * is always conditioned on the pointer existing, so it never creates one. `taskPointer` is the
 * caller's one read of the pointer for this decision (P39).
 */
async function sendTerminalResult(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  taskPointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  now: string,
  transactItems: TransactItems,
  workspaceUpdate: TransactItems[number],
  send: (items: TransactItems) => Promise<unknown>,
): Promise<OperationStatus> {
  const pointer = operation.kind === "prepare" ? taskPointer : undefined;
  const withoutTask: TransactItems = pointer === undefined ? transactItems : [...transactItems, { Update: {
    TableName: dependencies.tableName,
    Key: taskPointerKey(workspace.id),
    UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
    ConditionExpression: "attribute_exists(pk)",
  } }];
  let queued: Awaited<ReturnType<typeof queuedFirstTask>> | undefined;
  if (terminalStatus === "SUCCEEDED" && pointer?.pendingPrompt !== undefined && pointer.cancelledAt === undefined) {
    try {
      queued = await queuedFirstTask(dependencies, workspace, operation, { ...pointer, pendingPrompt: pointer.pendingPrompt }, now);
    } catch (partsError) {
      if (isConditional(partsError)) throw partsError;
      // FR-055, C19: the worker tries the result again; if every try fails, the stuck-setup sweep
      // ends the prepare (D21). Nothing is recorded, so the next try can still queue the task.
      if (isTemporaryAwsError(partsError)) throw firstTaskQueueRetry(pointer.taskId, operation.id, partsError);
      // Final review I1: the task's parts could not be built (the project's latest revision or
      // its model could not be read). The prepare is recorded as FAILED, so the task reads as
      // setup_failed, its instructions are cleared and its slot is released (#213), instead of
      // the task waiting in STARTING forever. The error name only: its message could quote the task.
      console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_failed", taskId: pointer.taskId, operationId: operation.id, error: partsError instanceof Error ? partsError.name : "unknown" }));
      await send(failedPrepareItems(dependencies, workspace, operation, now));
      return "FAILED";
    }
  }
  if (queued === undefined) {
    await send(withoutTask);
    return terminalStatus;
  }
  try {
    await send([...transactItems.filter((item) => item !== workspaceUpdate), queued.workspaceUpdate, ...queued.items]);
  } catch (queueError) {
    // C19: a temporary error from the one queuing write committed nothing; the worker tries again.
    // A TransactionCanceledException with a TransactionConflict reason is not temporary here: it
    // keeps the QueuingConflict path below.
    if (isTemporaryAwsError(queueError)) throw firstTaskQueueRetry(pointer?.taskId ?? "unknown", operation.id, queueError);
    if (!isConditional(queueError)) throw queueError;
    if (isTransactionConflict(queueError)) throw new QueuingConflict(queueError);
    // R16: a cancel that removed the instructions first wins; record the prepare without the task.
    // A concurrent duplicate callback that already queued the task lands here too, and the plain
    // write below then fails its fence condition and is answered by the caller's handler.
    const again = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id));
    if (again?.pendingPrompt !== undefined) throw queueError;
    await send(withoutTask);
  }
  return terminalStatus;
}

/** C19: logs a temporary error while queuing a task's first instructions (its name only) and answers 503. */
function firstTaskQueueRetry(taskId: string, operationId: string, error: Error): AgentXError {
  console.log(JSON.stringify({ component: "broker", event: "developer.first_task_queue_retry", taskId, operationId, error: error.name }));
  return agentXError("RUNTIME_UNAVAILABLE", "the task's first instructions could not be queued yet; send the result again");
}

/** The error a prepare is recorded with when its task's first instructions could not be queued (final review I1). */
const FIRST_TASK_QUEUE_FAILED = "the task's first instructions could not be queued; close this task and start a new one";

/** A prepare that the worker reported SUCCEEDED but that was recorded FAILED because its first task could not be queued. */
const isQueueFailedPrepare = (operation: OperationRecord, reported: unknown): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && operation.error === FIRST_TASK_QUEUE_FAILED && reported === "SUCCEEDED";

/** C18: a prepare the stuck-setup sweep failed; the worker's late result is answered, not refused. */
const isSweptPrepare = (operation: OperationRecord): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && operation.error === STUCK_SETUP_MESSAGE;

/**
 * A developer task's prepare recorded as FAILED (final review I1): the operation, the workspace
 * released as PREPARATION_FAILED, and the raw instructions cleared from an existing pointer.
 */
function failedPrepareItems(dependencies: AwsBrokerDependencies, workspace: WorkspaceInstance, operation: OperationRecord, now: string): TransactItems {
  return [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #error = :error",
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: { ":status": "FAILED", ":now": now, ":error": FIRST_TASK_QUEUE_FAILED, ":fence": operation.fence },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "PREPARATION_FAILED", ":now": now, ":operation": operation.id, ":fence": operation.fence },
    } },
    { Update: {
      TableName: dependencies.tableName,
      Key: taskPointerKey(workspace.id),
      UpdateExpression: "REMOVE pendingPrompt, pendingWorkflowMode",
      ConditionExpression: "attribute_exists(pk)",
    } },
  ];
}

/** The operation kinds whose result may concern a developer task: one pointer read serves them all (P39). */
const TASK_POINTER_KINDS: ReadonlySet<string> = new Set(["prepare", "task", "publish", "close", "cancel"]);

/** What a successful cancel's result makes of its target, and what a failed one does. */
const cancelledTargetStatus = (cancelStatus: OperationStatus): OperationStatus => (cancelStatus === "SUCCEEDED" ? "CANCELLED" : "INTERRUPTED");

/** At most `limit` of an operation's events, newest first, across pages. */
async function operationEventsNewestFirst(dependencies: AwsBrokerDependencies, operationId: string, limit: number): Promise<StoredEvent[]> {
  const items = await queryAllItems(dependencies, `OPERATION#${operationId}`, "EVENT#", { limit, newestFirst: true });
  return items.filter((item) => item.entityType === "EVENT").map((item) => parseStoredEvent(item));
}

/**
 * Spec 025 R12: the `completed` turn record of the developer task or publish operation this result
 * ends, for the result's own transaction, so the record and the result land together or not at
 * all. A task's own result ends it; a cancel's result ends its target (ruling F13: the target's
 * own later result finds it terminal and writes nothing). A Slack workspace has no pointer and
 * gets none.
 */
async function completedTurnItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  pointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  outcome: { result: unknown; error: string | undefined },
  now: string,
): Promise<TransactItems> {
  const table = dependencies.turnRecordsTableName;
  if (pointer === undefined || table === undefined) return [];
  let ended: { operation: OperationRecord; status: OperationStatus } | undefined;
  if (operation.kind === "task" || operation.kind === "publish") {
    ended = {
      operation: { ...operation, ...(outcome.result === undefined ? {} : { result: outcome.result }), ...(outcome.error === undefined ? {} : { error: outcome.error }) },
      status: terminalStatus,
    };
  } else if (operation.kind === "cancel" && operation.targetOperationId) {
    const target = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.targetOperationId));
    if (target !== undefined && (target.kind === "task" || target.kind === "publish") && !TERMINAL.has(target.status)) {
      ended = { operation: target, status: cancelledTargetStatus(terminalStatus) };
    }
  }
  // E20 (25c C22): a close that did not close gets its completed record in the preflight result's
  // transaction: refused for unpublished work, or the check's own outcome when it did not finish.
  // A safe preflight's record is finishTaskClose's, which writes it with the close.
  if (operation.kind === "close") {
    const requester = operation.requestedBy;
    const preflight = terminalStatus === "SUCCEEDED" ? WorkspaceClosePreflightResultSchema.safeParse(outcome.result) : undefined;
    const refusal = preflight?.success === true && !preflight.data.safeToClose
      ? `Not closed: unpublished work in ${preflight.data.repositories.map((repository) => `${repository.name} (${repository.reasons.join(", ")})`).join("; ")}`
      : undefined;
    const unfinished = terminalStatus !== "SUCCEEDED";
    if ((refusal !== undefined || unfinished) && requester !== undefined && "kind" in requester && requester.kind === "developer") {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
      if (task === undefined) {
        // The pointer and the task are written in one transaction, so this is not expected.
        console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId: operation.id }));
        return [];
      }
      return [{ Put: { TableName: table, Item: aiToolTurn({
        party: partyOfTask(task), turnId: operation.id, operationId: operation.id, action: "close", phase: "completed",
        outcome: refusal !== undefined ? "refused" : OUTCOME[terminalStatus] ?? "failed",
        receivedAt: operation.createdAt, finishedAt: now, request: "close",
        response: refusal ?? "Not closed: the check for unpublished work did not finish",
      }), ConditionExpression: "attribute_not_exists(pk)" } }];
    }
  }
  if (ended === undefined) return [];
  // F3: a teammate's operation from a continue thread gets an ordinary Slack turn record (FR-037,
  // FR-054), never an AI-tool record under the developer's name.
  const endedBy = ended.operation.requestedBy;
  if (endedBy === undefined || !("kind" in endedBy) || endedBy.kind !== "developer") return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task === undefined) {
    // The pointer and the task are written in one transaction, so this is not expected.
    console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId: ended.operation.id }));
    return [];
  }
  // A task's summary is its last assistant message; a publish's is its pull request.
  const events = ended.operation.kind === "task" ? (await operationEventsNewestFirst(dependencies, ended.operation.id, 500)).reverse() : [];
  let item: Record<string, unknown>;
  try {
    item = completedTurn({ task, pointer, operation: ended.operation, status: ended.status, events, now });
  } catch (error) {
    // Together or not at all (R12): the result is not recorded either, and the worker's callback
    // fails. The error name only: its message could quote the task's text.
    console.log(JSON.stringify({ component: "broker", event: "developer.completed_turn_failed", taskId: task.taskId, operationId: ended.operation.id, error: error instanceof Error ? error.name : "unknown" }));
    throw error;
  }
  return [{ Put: { TableName: table, Item: item, ConditionExpression: "attribute_not_exists(pk)" } }];
}

/** Reconcile every PR webhook against GitHub; comments and delivery order never grant authority. */
export async function processGithubWorkflowEvent(dependencies: AwsBrokerDependencies, event: ReceivedGithubWebhook["event"], deliveryId: string): Promise<void> {
  const getFeedback = dependencies.githubPullRequests.getPullRequestFeedback;
  if (getFeedback === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "current GitHub feedback collection is not configured");
  await reconcileTaskPullRequestFeedback({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName,
    repositoryFullName: event.fullName, number: event.number, deliveryId,
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: async (projectName, revision, repositoryId) => {
      const project = await requireProject(dependencies, projectName, revision);
      return project.definition.repositories.find(repository => repository.name === repositoryId)?.url;
    },
    getCurrentFeedback: (url, number) => getFeedback.call(dependencies.githubPullRequests, url, number),
    persistBundle: async (bundle, bytes, sha256) => {
      const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(bundle.taskId));
      if (!task) throw new GithubWebhookRefusal("linked feedback task no longer exists");
      const objectKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${sha256}.json`;
      try {
        await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey,
          Body: bytes, ContentType: "application/json", IfNoneMatch: "*" }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "PreconditionFailed") throw error;
        const existing = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey }));
        const existingBytes = await existing.Body?.transformToString();
        if (existingBytes === undefined || createHash("sha256").update(existingBytes, "utf8").digest("hex") !== sha256) {
          throw agentXError("RUNTIME_UNAVAILABLE", "immutable feedback artifact failed digest validation");
        }
      }
      return objectKey;
    },
    saveWorkflow: async (taskId, expectedRevision, workflow) => {
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":workflow": workflow, ":now": workflow.updatedAt, ":revision": expectedRevision },
      }));
    },
    now: new Date().toISOString(),
  });
}

async function githubEventStillAuthorized(dependencies: AwsBrokerDependencies, event: ReceivedGithubWebhook["event"]): Promise<boolean> {
  return authorizeLinkedGithubWebhook({
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    scope: { installationId: event.installationId, repositoryId: event.repositoryId, fullName: event.fullName, pullRequestNumber: event.number },
    loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
    repositoryUrl: async (projectName, revision, repositoryId) => {
      const project = await requireProject(dependencies, projectName, revision);
      return project.definition.repositories.find((repository) => repository.name === repositoryId)?.url;
    },
    verifyRepository: (repositoryUrl, scope) => dependencies.githubPullRequests.verifyWebhookRepository(repositoryUrl, scope),
  });
}

async function retryDueGithubWebhookEvents(dependencies: AwsBrokerDependencies): Promise<{ attempted: number; processed: number; delayed: number }> {
  const now = new Date().toISOString();
  const due = await listDueGithubWebhookDeliveries({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now, limit: 25 });
  let processed = 0;
  let delayed = 0;
  for (const delivery of due) {
    try {
      const result = await processGithubWebhookDelivery({
        documentClient: dependencies.documentClient,
        tableName: dependencies.tableName,
        received: { delivery: "ACCEPTED", deliveryId: delivery.deliveryId, event: delivery.event },
        process: async (event) => {
          // Revalidate under the delivery lease. Revoked scope is terminal; transient GitHub/API
          // errors consume the ordinary bounded retry budget instead of leaving a hot due row.
          if (!await githubEventStillAuthorized(dependencies, event)) {
            throw new GithubWebhookRefusal("linked GitHub pull request is no longer authorized");
          }
          await processGithubWorkflowEvent(dependencies, event, delivery.deliveryId);
        },
        now: () => new Date().toISOString(),
      });
      if (result === "PROCESSED") processed += 1;
      else delayed += 1;
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "github.webhook_retry_failed", deliveryId: delivery.deliveryId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return { attempted: due.length, processed, delayed };
}

async function retryGithubWebhookAsAdministrator(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, deliveryId: string) {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId)) throw agentXError("NOT_FOUND", "webhook delivery not found");
  const key = { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: "META" };
  const stored = await getItem<Record<string, unknown>>(dependencies, key);
  if (stored === undefined || (stored.status !== "RETRYABLE" && stored.status !== "DEAD") || stored.event === undefined) throw agentXError("CONFIG_INVALID", "only a failed GitHub delivery can be retried");
  const event = stored.event as ReceivedGithubWebhook["event"];
  if (!await githubEventStillAuthorized(dependencies, event)) throw agentXError("FORBIDDEN", "linked GitHub pull request is no longer authorized");
  const now = new Date().toISOString();
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: dependencies.tableName, Key: key,
      UpdateExpression: "SET #status = :received, updatedAt = :now, nextAttemptAt = :now, webhookRecoveryPk = :pk, webhookRecoverySk = :sk REMOVE leaseToken, leaseExpiresAt, attempts",
      ConditionExpression: "#status = :retryable OR #status = :dead",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":received": "RECEIVED", ":retryable": "RETRYABLE", ":dead": "DEAD", ":now": now, ":pk": "GITHUB_WEBHOOK_RECOVERY", ":sk": `${now}#${deliveryId}` },
    } },
    { Put: { TableName: dependencies.tableName, Item: { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: `RETRY#${now}`, entityType: "GITHUB_WEBHOOK_RETRY_AUDIT", deliveryId, actor: identity.subject, at: now }, ConditionExpression: "attribute_not_exists(pk)" } },
  ] }));
  return { deliveryId, status: "RETRY_QUEUED" as const };
}

function isGithubWebhookRecoveryEvent(event: unknown): event is { source: "agentx.github-webhook-recovery" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.github-webhook-recovery";
}

async function completedWorkflowItems(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  pointer: DeveloperTaskPointerRecord | undefined,
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
): Promise<TransactItems> {
  if (pointer === undefined) return [];
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task?.workflow === undefined) return [];
  if (operation.kind === "publish") {
    if (terminalStatus !== "SUCCEEDED" || task.workflow.stage !== "PULL_REQUEST" || task.workflow.state !== "READY" || task.workflow.candidate === undefined) return [];
    const published = PullRequestResultSchema.safeParse(result);
    if (!published.success) throw agentXError("CONFIG_INVALID", "workflow pull request result is invalid");
    const project = await requireProject(dependencies, task.project, task.startingRevision);
    const repository = project.definition.repositories.find((entry) => entry.name === published.data.repository);
    if (repository === undefined) throw agentXError("CONFIG_INVALID", "published pull request repository is not part of the task's registered project revision");
    const repositoryFullName = githubRepositoryFullName(repository.url);
    if (!pullRequestMatchesRepository(published.data.url, repositoryFullName, published.data.number)) {
      throw agentXError("CONFIG_INVALID", "published pull request URL does not match the task's registered repository");
    }
    const indexKey = githubWorkflowPullRequestKey(repositoryFullName, published.data.number);
    const existingIndex = await getItem<GithubWorkflowPullRequestRecord>(dependencies, indexKey);
    const indexRecord: GithubWorkflowPullRequestRecord = {
      ...indexKey,
      entityType: "GITHUB_WORKFLOW_PR",
      repositoryFullName,
      repositoryId: published.data.repository,
      number: published.data.number,
      url: published.data.url,
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      candidateDigest: task.workflow.candidate.digest,
      createdAt: now,
    };
    if (existingIndex !== undefined && (existingIndex.taskId !== indexRecord.taskId
      || existingIndex.candidateDigest !== indexRecord.candidateDigest
      || existingIndex.url !== indexRecord.url)) {
      throw agentXError("CONFIG_INVALID", "this pull request is already linked to another task or candidate");
    }
    const next = registerWorkflowPullRequest(task.workflow, {
      repositoryId: published.data.repository,
      number: published.data.number,
      url: published.data.url,
      candidateDigest: task.workflow.candidate.digest,
      required: true,
    }, now);
    return [{ Update: {
      TableName: dependencies.tableName,
      Key: taskKey(task.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.stage = :stage AND workflow.state = :ready",
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": task.workflow.revision, ":stage": "PULL_REQUEST", ":ready": "READY" },
    } }, ...(existingIndex === undefined ? [{ Put: {
      TableName: dependencies.tableName,
      Item: indexRecord,
      ConditionExpression: "attribute_not_exists(pk)",
    } }] : [])];
  }
  if (operation.kind !== "task" || operation.workflowMode === undefined || task.workflow.state !== "RUNNING") return [];
  let next: WorkflowSnapshot;
  if (operation.workflowMode === "IMPLEMENT") {
    if (terminalStatus !== "SUCCEEDED") {
      next = blockWorkflow(task.workflow, `implementation operation ended ${terminalStatus.toLowerCase()}`, now);
    } else {
      const reported = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
      const repositories = Array.isArray(reported.workflowCandidateRepositories) ? reported.workflowCandidateRepositories : [];
      const checkedRepositories = Array.isArray(reported.workflowCheckCandidateRepositories) ? reported.workflowCheckCandidateRepositories : [];
      const checks = CheckReportSchema.safeParse(reported.checks);
      const verifying = { ...blockWorkflow(task.workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const };
      try {
        const project = await requireProject(dependencies, task.project, task.startingRevision);
        const expectedRepositoryIds = project.definition.repositories.map((repository) => repository.name).sort();
        const candidateInput = repositories as CandidateRepository[];
        const candidate = createCandidateManifest(candidateInput);
        const checkedCandidate = createCandidateManifest(checkedRepositories as CandidateRepository[]);
        if (candidate.repositories.map((repository) => repository.repositoryId).sort().join("\n") !== expectedRepositoryIds.join("\n")
          || checkedCandidate.digest !== candidate.digest || !checks.success) {
          throw new Error("candidate or checks are incomplete");
        }
        const selectedChecks = task.workflow.checkPolicy === undefined ? [] : [
          ...task.workflow.checkPolicy.required,
          ...task.workflow.checkPolicy.optional.filter((check) => task.workflow?.checkPolicy?.selectedOptionalIds.includes(check.id)),
        ];
        const results = selectedChecks.length > 0
          ? selectedChecks.map((check, index) => ({ checkId: check.id, status: checks.data.status === "verified" && checks.data.checks[index]?.after === "passed" ? "PASS" as const : checks.data.checks[index] === undefined ? "UNKNOWN" as const : "FAILED" as const }))
          : checks.data.checks.map((check) => ({ checkId: check.id, status: checks.data.status === "verified" && check.after === "passed" ? "PASS" as const : check.after === "not_run" ? "UNKNOWN" as const : "FAILED" as const }));
        next = recordWorkflowVerification(verifying, {
          candidate,
          checks: {
            candidateDigest: candidate.digest,
            producer: "agentx-worker-checks",
            environmentId: task.workspaceId,
            recordedAt: now,
            results,
          },
          now,
        });
      } catch {
        next = blockWorkflow(verifying, "implementation finished without complete candidate-bound check evidence", now);
      }
    }
  } else if (operation.workflowMode === "REVIEW") {
    if (terminalStatus !== "SUCCEEDED") {
      next = blockWorkflow(task.workflow, `independent review operation ended ${terminalStatus.toLowerCase()}`, now);
    } else {
      const reported = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
      const repositories = Array.isArray(reported.workflowCandidateRepositories) ? reported.workflowCandidateRepositories : [];
      const reviews = Array.isArray(reported.workflowReviews) ? reported.workflowReviews : [];
      try {
        const candidate = createCandidateManifest(repositories as CandidateRepository[]);
        if (task.workflow.stage !== "REVIEW" || task.workflow.candidate?.digest !== candidate.digest
          || reviews.length !== 2
          || reviews.some((review) => review === null || typeof review !== "object" || (review as Record<string, unknown>).operationId !== operation.id)) {
          throw new Error("review result is stale, incomplete, or came from another operation");
        }
        next = task.workflow;
        for (const review of reviews) next = submitWorkflowReview(next, review, now);
      } catch {
        next = blockWorkflow(task.workflow, "independent candidate review was invalid, incomplete, or stale", now);
      }
    }
  } else if (task.workflow.stage !== "PLAN") {
    return [];
  } else if (terminalStatus === "SUCCEEDED") {
    const artifacts = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operation.id && item.name === "plan.md")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const artifact = artifacts.at(-1);
    if (artifact === undefined) {
      next = blockWorkflow(task.workflow, "planning run succeeded without a saved plan artifact", now);
    } else {
      const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: String(artifact.objectKey) }));
      const content = object.Body ? await object.Body.transformToString("utf8") : "";
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      const artifactType = task.workflow.path === "FULL" && task.workflow.reviewPhase === "REQUIREMENTS" ? "requirements"
        : task.workflow.path === "FULL" && task.workflow.reviewPhase === "DESIGN" ? "design" : "plan";
      next = submitWorkflowArtifact(task.workflow, {
        expectedRevision: task.workflow.revision,
        now,
        artifact: {
          id: String(artifact.id), type: artifactType, version: task.workflow.artifacts.filter((entry) => entry.type === artifactType).length + 1,
          sha256, producer: "agentx-worker-untrusted", objectKey: String(artifact.objectKey), createdAt: String(artifact.createdAt),
        },
      });
    }
  } else {
    next = blockWorkflow(task.workflow, `planning operation ended ${terminalStatus.toLowerCase()}`, now);
  }
  return [{ Update: {
    TableName: dependencies.tableName,
    Key: taskKey(task.taskId),
    UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
    ConditionExpression: "workflow.revision = :revision AND workflow.stage = :stage AND workflow.state = :running",
    ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": task.workflow.revision, ":stage": task.workflow.stage, ":running": "RUNNING" },
  } }];
}

const TERMINAL_ERROR_MAX = 16_384;

async function recordTerminalResult(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<OperationRecord> {
  const input = object(value, "terminal result");
  const status = input.status;
  if (!TERMINAL.has(status as OperationStatus)) throw agentXError("CONFIG_INVALID", "terminal status is invalid");
  if (TERMINAL.has(operation.status)) {
    // Issue 202: a task whose cancel failed ended INTERRUPTED but kept its workspace, as it might
    // still run. Its own result proves the run ended, so it frees the workspace; the result itself
    // is not stored (results stay immutable), and the worker gets the stored operation.
    if (operation.kind === "task" && operation.status === "INTERRUPTED") {
      const released = await releaseOnOwnResult(dependencies, operation);
      if (released !== undefined) return released;
    }
    if (operation.status !== status && !isQueueFailedPrepare(operation, status) && !isSweptPrepare(operation)) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal result is immutable");
    // #213: a repeated result releases a failed prepare's slot too, in case the first one's release
    // did not land (the release is idempotent, and does nothing to a workspace that moved on).
    if (operation.kind === "prepare" && operation.status !== "SUCCEEDED") {
      await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, operation.workspaceId);
      // #225 review: and records its failure event, in case the first one's did not land (once per prepare).
      await repeatPrepareFailureEvent(dependencies, operation);
    }
    return operation;
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const now = new Date().toISOString();
  const terminalStatus = status as OperationStatus;
  let recordedStatus: OperationStatus = terminalStatus;
  // #154: the worker's error can quote a command's output, so it is redacted before it is stored,
  // and redactAndCap redacts before it caps.
  const error = typeof input.error === "string" ? redactAndCap(input.error, TERMINAL_ERROR_MAX).text : undefined;
  const result = operation.kind === "publish" && status === "SUCCEEDED"
    ? PullRequestResultSchema.parse(input.result)
    : operation.kind === "close" && status === "SUCCEEDED"
      ? WorkspaceClosePreflightResultSchema.parse(input.result)
      : input.result;
  const closePreflight = operation.kind === "close" && terminalStatus === "SUCCEEDED"
    ? WorkspaceClosePreflightResultSchema.parse(result)
    : undefined;
  const workspaceStatus =
    operation.kind === "prepare"
      ? terminalStatus === "SUCCEEDED"
        ? "READY"
        : "PREPARATION_FAILED"
      : operation.kind === "close"
        ? closePreflight?.safeToClose === true
          ? "CLOSING"
          : operation.closePreviousStatus ?? "READY"
        : "READY";
  const terminalTarget = operation.kind === "cancel" && operation.targetOperationId
    ? operationKey(operation.workspaceId, operation.targetOperationId)
    : undefined;
  const transactItems: TransactItems = [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result, #error = :error",
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
      ExpressionAttributeValues: { ":status": terminalStatus, ":now": now, ":result": result ?? null, ":error": error ?? null, ":fence": operation.fence },
    } },
  ];
  if (operation.kind === "cancel" && terminalTarget) {
    transactItems.push({ Update: {
      TableName: dependencies.tableName,
      Key: terminalTarget,
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      // Issue 195: a cancel that did not succeed (a duplicate the worker no longer knows, say)
      // never turns a target that already ended into INTERRUPTED. A failed condition falls back
      // below to recording the cancel's own result only.
      ...(terminalStatus === "SUCCEEDED" ? {} : { ConditionExpression: "#status = :cancelRequested" }),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": cancelledTargetStatus(terminalStatus), ":now": now,
        ...(terminalStatus === "SUCCEEDED" ? {} : { ":cancelRequested": "CANCEL_REQUESTED" }),
      },
    } });
  }
  // Spec 051 Ruling T: a task's end, or its cancel's, sets the workspace's latest checks in the same transaction. That
  // update holds only while this operation owns the workspace at its fence, so a late or repeated result never
  // replaces a newer task's, and no write can be lost after the result commits.
  const latestChecks = await terminalLatestChecks(dependencies, operation, terminalStatus, result, now);
  const standingFailures = latestChecks === undefined ? undefined : await nextWorkspaceStanding(dependencies, operation.workspaceId, latestChecks.report);
  const workspaceExpression = operation.kind === "prepare" && terminalStatus === "SUCCEEDED"
    ? "SET #status = :status, updatedAt = :now, preparationManifest = :manifest REMOVE activeOperationId"
    : operation.kind === "close" && closePreflight?.safeToClose !== true
      ? "SET #status = :status, updatedAt = :now, closeError = :closeError REMOVE activeOperationId"
      : "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError";
  const workspaceUpdate: TransactItems[number] = { Update: {
    TableName: dependencies.tableName,
    Key: workspaceKey(workspace.id),
    UpdateExpression: latestChecks === undefined ? workspaceExpression : workspaceExpression.replace(" REMOVE ", ", latestChecks = :latestChecks, standingFailures = :standingFailures REMOVE "),
    ConditionExpression: operation.kind === "cancel"
      ? "activeOperationId = :target AND fence = :fence"
      : "activeOperationId = :operation AND fence = :fence",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": workspaceStatus,
      ":now": now,
      ":fence": operation.fence,
      ...(operation.kind === "cancel" ? { ":target": operation.targetOperationId } : { ":operation": operation.id }),
      ...(operation.kind === "prepare" && terminalStatus === "SUCCEEDED" ? { ":manifest": ".agentx/preparation-manifest.json" } : {}),
      ...(latestChecks === undefined ? {} : { ":latestChecks": latestChecks, ":standingFailures": standingFailures }),
      ...(operation.kind === "close" && closePreflight?.safeToClose !== true
        ? { ":closeError": error ?? (closePreflight ? "workspace contains unpublished work" : "workspace close preflight failed") }
        : {}),
    },
  } };
  if (operation.kind !== "cancel" || terminalStatus === "SUCCEEDED") transactItems.push(workspaceUpdate);
  const send = (items: TransactItems) => dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  let taskPointer: DeveloperTaskPointerRecord | undefined;
  try {
    // A queuing transaction that met another one in flight (TransactionConflict, not a failed
    // condition) is decided again once from fresh reads before it counts as a stale callback.
    // Each decision reads the task pointer once (P39); a Slack workspace has none.
    const decideAndSend = async () => {
      const pointer = TASK_POINTER_KINDS.has(operation.kind)
        ? await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspace.id))
        : undefined;
      taskPointer = pointer;
      const completed = await completedTurnItems(dependencies, operation, pointer, terminalStatus, { result, error }, now);
      const workflow = await completedWorkflowItems(dependencies, operation, pointer, terminalStatus, now, result);
      recordedStatus = await sendTerminalResult(dependencies, workspace, operation, pointer, terminalStatus, now, [...transactItems, ...completed, ...workflow], workspaceUpdate, send);
    };
    try {
      await decideAndSend();
    } catch (firstError) {
      if (!(firstError instanceof QueuingConflict)) throw firstError;
      await decideAndSend().catch((secondError: unknown) => {
        throw secondError instanceof QueuingConflict ? secondError.cause : secondError;
      });
    }
  } catch (transactionError) {
    if (!isConditional(transactionError)) throw transactionError;
    const existing = await requireOperation(dependencies, operation.workspaceId, operation.id);
    if (existing.status === terminalStatus || isQueueFailedPrepare(existing, terminalStatus) || isSweptPrepare(existing)) {
      if (existing.kind === "prepare" && existing.status !== "SUCCEEDED") {
        await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, existing.workspaceId);
        await repeatPrepareFailureEvent(dependencies, existing);
      }
      return existing;
    }
    // A cancel whose target finished first (its own result, and for a developer task its
    // completed record, committed meanwhile): decided again once, from a fresh read, the cancel
    // records only its own result. The target, the workspace and the audit record stay as the
    // target's result left them, so there is exactly one completed record and no worker retry.
    if (operation.kind === "cancel" && operation.targetOperationId) {
      const target = await requireOperation(dependencies, operation.workspaceId, operation.targetOperationId);
      if (TERMINAL.has(target.status)) {
        try {
          await send([transactItems[0]!]);
        } catch (ownError) {
          if (!isConditional(ownError)) throw ownError;
          const again = await requireOperation(dependencies, operation.workspaceId, operation.id);
          if (again.status === terminalStatus) return again;
          throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
        }
        return { ...operation, status: terminalStatus, updatedAt: now, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
      }
    }
    throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
  }
  if (closePreflight?.safeToClose === true && taskPointer !== undefined) await finishDeveloperClose(dependencies, taskPointer, operation.id, operation.createdAt);
  // #213: a prepare that did not succeed leaves the workspace PREPARATION_FAILED, which stops
  // counting toward the workspace limits now; the release logs, and never fails the callback.
  if (operation.kind === "prepare" && recordedStatus !== "SUCCEEDED") {
    await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, workspace.id);
    // #225: a developer task's failed setup is an event of its own, so the task shows when it failed.
    if (taskPointer !== undefined) {
      await recordPrepareFailureEvent(dependencies.documentClient, dependencies.tableName, {
        workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: recordedStatus,
        error: recordedStatus !== terminalStatus ? FIRST_TASK_QUEUE_FAILED : error, at: now,
        // The setup itself finished; it was the task's start that failed.
        ...(recordedStatus !== terminalStatus ? { lead: "The task could not start" } : {}),
      });
    }
  }
  if (recordedStatus !== terminalStatus) return { ...operation, status: recordedStatus, updatedAt: now, error: FIRST_TASK_QUEUE_FAILED };
  return { ...operation, status: terminalStatus, updatedAt: now, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
}

/** Spec 051 Ruling T: the workspace's latest checks, as stored: what is known, which task, and when. */
function latestChecksItem(latest: LatestChecks, operationId: string, fence: number, recordedAt: string) {
  return { report: checksForSection(latest), operationId, fence, recordedAt };
}

/**
 * Spec 051 Ruling Y: the workspace's standing failures once `latest` is recorded: the earlier ones not shown passing in
 * it, and every check failing in it. A task that ends without a report keeps the earlier ones. Written with the latest
 * checks in the terminal transaction, so the fence guards both.
 */
async function nextWorkspaceStanding(dependencies: AwsBrokerDependencies, workspaceId: string, latest: LatestChecks): Promise<StandingFailure[]> {
  return nextStandingFailures(await workspaceStandingFailures(dependencies, workspaceId), latest);
}

async function workspaceStandingFailures(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<StandingFailure[]> {
  const workspace = await getItem<{ standingFailures?: unknown }>(dependencies, workspaceKey(workspaceId));
  const parsed = StandingFailuresSchema.safeParse(workspace?.standingFailures ?? []);
  if (parsed.success) return parsed.data;
  console.log(JSON.stringify({ component: "broker", event: "workspace.standing_failures_unreadable", workspaceId }));
  return [];
}

/**
 * Spec 051 Ruling T: the latest checks a task's terminal result records: its report, or why it has none. A successful
 * cancel records its task as cancelled. Undefined for every other operation, which leaves them as they are.
 */
async function terminalLatestChecks(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  status: OperationStatus,
  result: unknown,
  now: string,
) {
  if (operation.kind === "task") {
    const report = taskResultChecks(result);
    const reason = status === "SUCCEEDED" ? "no_report" : status === "FAILED" ? "failed" : status === "CANCELLED" ? "cancelled" : "interrupted";
    return latestChecksItem(report ?? { status: "not_verified", reason }, operation.id, operation.fence, now);
  }
  if (operation.kind === "cancel" && status === "SUCCEEDED" && operation.targetOperationId) {
    const target = await getItem<OperationRecord>(dependencies, operationKey(operation.workspaceId, operation.targetOperationId));
    if (target?.kind === "task") return latestChecksItem({ status: "not_verified", reason: "cancelled" }, target.id, operation.fence, now);
  }
  return undefined;
}

/**
 * #225 review: a repeated result of a developer task's failed prepare records the failure event the
 * first result's best-effort write may have missed; the event's once-key keeps it to one.
 */
async function repeatPrepareFailureEvent(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<void> {
  try {
    if ((await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId))) === undefined) return;
  } catch (error) {
    // Best effort, as the event itself: a failed read never fails the result callback.
    console.log(JSON.stringify({ component: "broker", event: "developer.prepare_failure_event_failed", operationId: operation.id, error: error instanceof Error ? error.name : "unknown" }));
    return;
  }
  await recordPrepareFailureEvent(dependencies.documentClient, dependencies.tableName, {
    workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: operation.status, error: operation.error, at: operation.updatedAt,
    ...(operation.error === FIRST_TASK_QUEUE_FAILED ? { lead: "The task could not start" } : {}),
  });
}

/**
 * Issue 202: frees the workspace an INTERRUPTED task still holds after its cancel failed, when the
 * task's own late result arrives, under the fence the callback holds. Returns the stored operation
 * when the workspace is freed now, or was already freed after the failed cancel (by an earlier copy
 * of this result or by the reconciler); undefined when the task no longer holds the workspace for
 * another reason (a newer operation, a moved fence), so the result is refused as before. Only a
 * task: the Slack and AI-tool stop only ever cancels a task, and any other kind is left to the
 * reconciler's sweep.
 */
async function releaseOnOwnResult(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<OperationRecord | undefined> {
  const stored = operation as OperationRecord & { workspaceReleasedAt?: unknown; workspaceReleaseReason?: unknown };
  if (typeof stored.workspaceReleasedAt === "string") {
    // Already freed (by an earlier copy of this result, or by the reconciler): answered, never stored.
    if (stored.workspaceReleaseReason !== "own-result") {
      console.log(JSON.stringify({ component: "broker", event: "stuck_cancel.late_result_after_release", workspaceId: operation.workspaceId, operationId: operation.id, reason: stored.workspaceReleaseReason }));
    }
    return operation;
  }
  const workspace = await getItem<{ activeOperationId?: unknown; fence?: unknown }>(dependencies, workspaceKey(operation.workspaceId));
  if (workspace?.activeOperationId !== operation.id || workspace.fence !== operation.fence) return undefined;
  const at = new Date();
  if (!(await releaseFailedCancelWorkspace(dependencies.documentClient, dependencies.tableName, { workspaceId: operation.workspaceId, operationId: operation.id }, operation, "own-result", at))) {
    // Something moved first: read again, so a copy of this result that won the race is answered too.
    const again = await requireOperation(dependencies, operation.workspaceId, operation.id) as OperationRecord & { workspaceReleasedAt?: unknown };
    return typeof again.workspaceReleasedAt === "string" ? again : undefined;
  }
  console.log(JSON.stringify({ component: "broker", event: "stuck_cancel.released", workspaceId: operation.workspaceId, operationId: operation.id, reason: "own-result" }));
  return await requireOperation(dependencies, operation.workspaceId, operation.id);
}

/**
 * Spec 025 R15: a developer task's safe close preflight finishes the close itself, after its result
 * committed. A failure is logged by its name and left to resumeClose (the task's next read or
 * close); the worker's callback never fails because of it. A Slack workspace has no pointer and
 * keeps its own completion flow.
 */
async function finishDeveloperClose(dependencies: AwsBrokerDependencies, pointer: DeveloperTaskPointerRecord, operationId: string, requestedAt: string): Promise<void> {
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
    if (task === undefined) {
      console.log(JSON.stringify({ component: "broker", event: "developer.task_record_missing", taskId: pointer.taskId, operationId }));
      return;
    }
    await finishTaskClose({ tableName: dependencies.tableName, actions: developerTaskActions(dependencies), documentClient: dependencies.documentClient }, task, operationId, [], requestedAt);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.task_close_failed", taskId: pointer.taskId, operationId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

async function pageEvents(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
  input: { cursor?: string; limit: number },
) {
  await getAuthorizedOperation(dependencies, identity, workspaceId, operationId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw agentXError("CONFIG_INVALID", "event limit must be from 1 through 500");
  }
  const after = decodeCursor(input.cursor);
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    ExpressionAttributeValues: {
      ":pk": `OPERATION#${operationId}`,
      ":after": `EVENT#${String(after).padStart(12, "0")}`,
      ":end": "EVENT#\uffff",
    },
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :after AND :end",
    Limit: input.limit,
    ConsistentRead: true,
  }));
  const events = (response.Items ?? [])
    .filter((item) => item.entityType === "EVENT")
    .map((item) => parseStoredEvent(item));
  const last = events.at(-1)?.sequence;
  return { events, ...(response.LastEvaluatedKey && last !== undefined ? { cursor: encodeCursor(last) } : {}) };
}

async function getArtifact(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  artifactId: string,
) {
  await requireOwnedWorkspace(dependencies, identity, workspaceId);
  const artifact = await getItem<Record<string, unknown>>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `ARTIFACT#${artifactId}`,
  });
  if (!artifact || artifact.ownerKey !== identity.ownerKey || typeof artifact.objectKey !== "string") {
    throw agentXError("NOT_FOUND", "artifact not found");
  }
  if (identity.sharedTask?.state === "continue") {
    // D22: an artifact of the developer's own run is theirs, answered as if it did not exist.
    const operation = typeof artifact.operationId === "string" ? await getItem<OperationRecord>(dependencies, operationKey(workspaceId, artifact.operationId)) : undefined;
    if (operation === undefined || developerRequested(operation)) throw agentXError("NOT_FOUND", "artifact not found");
  }
  const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: artifact.objectKey }));
  const content = object.Body ? await object.Body.transformToString("utf8") : "";
  return { id: artifactId, name: artifact.name, mediaType: artifact.mediaType, operationId: artifact.operationId, content };
}

async function getAuthorizedOperation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
): Promise<Operation> {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  // D22: from a shared thread, the developer's own run (its status, result and events) answers
  // exactly as an unknown operation does, so it cannot be probed. Channel operations stay readable.
  if (identity.sharedTask?.state === "continue" && developerRequested(operation)) throw agentXError("NOT_FOUND", "operation not found");
  return publicOperation(operation);
}

/** An operation a developer started from an AI tool (FR-022), rather than from Slack. */
function developerRequested(operation: Pick<OperationRecord, "requestedBy">): boolean {
  const requester = operation.requestedBy;
  return requester !== undefined && "kind" in requester && requester.kind === "developer";
}

async function requireOwnedWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<WorkspaceInstance> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
  return workspace;
}

async function requireWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<WorkspaceInstance> {
  const item = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (!item) throw agentXError("NOT_FOUND", "workspace not found");
  return WorkspaceInstanceSchema.parse(workspaceRecordFields(item));
}

async function getDefaultWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<WorkspaceInstance | undefined> {
  const mapping = await getItem<{ workspaceId: string }>(dependencies, {
    pk: `OWNER#${ownerKey}`,
    sk: `PROJECT#${projectName}`,
  });
  return mapping ? requireWorkspace(dependencies, mapping.workspaceId) : undefined;
}

async function getThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
): Promise<WorkspaceInstance | undefined> {
  const thread = await getItem<{ workspaceId?: string }>(dependencies, slackThreadKey(ownerKey));
  return typeof thread?.workspaceId === "string" ? requireWorkspace(dependencies, thread.workspaceId) : undefined;
}

async function requireProject(
  dependencies: AwsBrokerDependencies,
  projectName: string,
  revision: number,
): Promise<RegisteredProjectRecord> {
  const project = await getItem<RegisteredProjectRecord>(dependencies, projectKey(projectName, revision));
  if (!project) throw agentXError("NOT_FOUND", "registered project revision not found");
  return project;
}

/**
 * The definition a publication or maintenance run works from: the workspace's own revision for
 * everything that touches its disk, and the project's latest registered revision for the settings
 * that do not. Returns the revision whose settings applied, for the operation record.
 */
async function publicationProject(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
): Promise<{ project: RegisteredProjectRecord; settingsRevision: number }> {
  const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  if (settings.definition.revision === pinned.definition.revision) {
    return { project: pinned, settingsRevision: pinned.definition.revision };
  }
  const definition: ProjectDefinition = {
    ...pinned.definition,
    readiness: settings.definition.readiness,
    repositories: pinned.definition.repositories.map((repository) => {
      const latest = settings.definition.repositories.find((candidate) => candidate.name === repository.name);
      // A repository the latest revision dropped keeps the gates it was registered with.
      if (!latest) return repository;
      const withoutGates = { ...repository };
      delete withoutGates.codeBuildGates;
      return { ...withoutGates, ...(latest.codeBuildGates === undefined ? {} : { codeBuildGates: latest.codeBuildGates }) };
    }),
  };
  return { project: { ...pinned, definition }, settingsRevision: settings.definition.revision };
}

async function requireLatestProject(
  dependencies: AwsBrokerDependencies,
  projectName: string,
): Promise<RegisteredProjectRecord> {
  // Revision sort keys are zero-padded, so the last key in descending order is the highest revision.
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${projectName}`, ":revision": "REV#" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  }));
  const project = response.Items?.[0] as RegisteredProjectRecord | undefined;
  if (!project) throw agentXError("NOT_FOUND", "registered project not found");
  return project;
}

function projectModelSelectionKey(projectName: string) {
  return { pk: `PROJECT#${projectName}`, sk: "SELECTION" as const };
}

async function getProjectModels(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
): Promise<ProjectModelOptions> {
  const projectName = identity.slack?.binding.projectName;
  if (!projectName) throw agentXError("FORBIDDEN", "Slack project binding is required");
  const project = await requireLatestProject(dependencies, projectName);
  const policy = project.definition.models;
  if (!policy) throw agentXError("CONFIG_INVALID", "this project has no approved coding models; ask an administrator to configure models");
  const selection = await getItem<ProjectModelSelectionRecord>(dependencies, projectModelSelectionKey(projectName));
  const selected = selection === undefined
    ? undefined
    : policy.approved.find((candidate) => modelKey(candidate) === modelKey(selection.model));
  const current = selected ?? approvedDefault(policy.default, policy.approved);
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current,
    source: selected === undefined ? "default" : "selection",
  });
}

async function putProjectModel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<ProjectModelOptions> {
  const projectName = identity.slack?.binding.projectName;
  const requester = identity.slack?.requester;
  if (!projectName || !requester) throw agentXError("FORBIDDEN", "Slack project binding and requester are required");
  const requested = ProjectModelSelectionRequestSchema.parse(value);
  const project = await requireLatestProject(dependencies, projectName);
  const policy = project.definition.models;
  if (!policy) throw agentXError("CONFIG_INVALID", "this project has no approved coding models; ask an administrator to configure models");
  const selected = policy.approved.find((candidate) => modelKey(candidate) === modelKey(requested));
  if (!selected) throw agentXError("CONFIG_INVALID", `model ${requested.provider}/${requested.modelId} is not approved for this project`);
  const record: ProjectModelSelectionRecord = {
    ...projectModelSelectionKey(projectName),
    entityType: "PROJECT_MODEL_SELECTION",
    model: { provider: selected.provider, modelId: selected.modelId },
    updatedAt: new Date().toISOString(),
    updatedBy: requester,
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return ProjectModelOptionsSchema.parse({
    projectName,
    approved: policy.approved,
    current: selected,
    source: "selection",
  });
}

async function resolveProjectModel(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
): Promise<{ model?: ModelSelection; diagnostic?: string }> {
  const policy = project.definition.models;
  if (!policy) return {};
  const selection = await getItem<ProjectModelSelectionRecord>(dependencies, projectModelSelectionKey(project.definition.name));
  const selected = selection === undefined
    ? undefined
    : policy.approved.find((candidate) => modelKey(candidate) === modelKey(selection.model));
  const effective = selected ?? approvedDefault(policy.default, policy.approved);
  return {
    model: approvedSelection(effective),
    ...(selection !== undefined && selected === undefined
      ? { diagnostic: `The project's selected coding model ${selection.model.provider}/${selection.model.modelId} is no longer approved. This task uses the project default ${effective.provider}/${effective.modelId}.` }
      : {}),
  };
}

/** Spec 053: what a task or eval run runs: the approved entry's model and, only when it has one, its level. */
function approvedSelection(model: ModelRef): ModelSelection {
  return {
    provider: model.provider,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  };
}

function approvedDefault(defaultModel: ModelRef, approved: readonly ModelRef[]): ModelRef {
  const model = approved.find((candidate) => modelKey(candidate) === modelKey(defaultModel));
  if (!model) throw agentXError("CONFIG_INVALID", "project default model is not approved");
  return model;
}

async function requirePullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  number: number,
): Promise<PullRequestRecord> {
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repository, number));
  if (!record) throw agentXError("NOT_FOUND", "AgentX pull request record not found");
  return record;
}

async function adoptLegacyPullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  repositoryUrl: string,
  remote: Awaited<ReturnType<GitHubAppCredentialProvider["getPullRequest"]>>,
): Promise<PullRequestRecord> {
  const match = /^agentx\/([0-9a-f-]{36})$/iu.exec(remote.headBranch);
  if (!match?.[1]) throw agentXError("NOT_FOUND", "pull request is not owned by this AgentX workspace");
  const operation = await requireOperation(dependencies, workspaceId, match[1]);
  if (
    operation.kind !== "publish" || operation.status !== "SUCCEEDED" || !operation.publication ||
    operation.publication.repository !== repository || operation.publication.repositoryUrl !== repositoryUrl ||
    operation.publication.headBranch !== remote.headBranch || operation.publication.baseBranch !== remote.baseBranch
  ) {
    throw agentXError("NOT_FOUND", "pull request is not backed by a successful AgentX publication");
  }
  const record: PullRequestRecord = {
    ...pullRequestKey(workspaceId, repository, remote.number),
    entityType: "PULL_REQUEST",
    workspaceId,
    repository,
    repositoryUrl,
    number: remote.number,
    url: remote.url,
    state: remote.state,
    headBranch: remote.headBranch,
    baseBranch: remote.baseBranch,
    expectedHeadCommit: remote.headCommit,
    title: remote.title,
    body: remote.body,
    createdByOperationId: operation.id,
    updatedAt: new Date().toISOString(),
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return record;
}

async function requireMembership(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<MembershipRecord> {
  const membership = await getMembership(dependencies, ownerKey, projectName);
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  return membership;
}

async function getMembership(dependencies: AwsBrokerDependencies, ownerKey: string, projectName: string) {
  return getItem<MembershipRecord>(dependencies, { pk: `MEMBER#${ownerKey}`, sk: `PROJECT#${projectName}` });
}

async function requireAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
): Promise<void> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const membership = await requireMembership(dependencies, identity.ownerKey, projectName);
  if (membership.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
}

/** Spec 043: the SWE-bench module's dependencies, from the broker's; spec 052 wires its batches into them. */
function swebenchDependencies(dependencies: AwsBrokerDependencies): EvalBatchDependencies {
  const swebench = dependencies.swebench;
  if (swebench === undefined) throw agentXError("NOT_FOUND", "SWE-bench runs are not available in this deployment");
  return withEvalBatches({
    documentClient: dependencies.documentClient,
    s3: dependencies.s3,
    tableName: dependencies.tableName,
    artifactBucketName: dependencies.artifactBucketName,
    callbackSigningKey: dependencies.callbackSigningKey,
    ...swebench,
  });
}

/** The thread, requester and project model a SWE-bench run takes from the Slack service identity. */
function swebenchSlackContext(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): SwebenchSlackContext {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "Slack thread context is required");
  return { thread: slack.thread, requester: slack.requester, ...swebenchProjectContext(dependencies, slack.binding.projectName) };
}

/** The project and its approved models, for a run or batch whose thread and requester the caller supplies. */
function swebenchProjectContext(dependencies: AwsBrokerDependencies, projectName: string): Pick<SwebenchSlackContext, "projectName" | "projectModel"> {
  return {
    projectName,
    projectModel: async (requested) => {
      const project = await requireLatestProject(dependencies, projectName);
      const policy = project.definition.models;
      if (requested !== undefined) {
        const approved = policy?.approved.find((candidate) => modelKey(candidate) === modelKey(requested));
        if (!approved) throw agentXError("CONFIG_INVALID", `model ${requested.provider}/${requested.modelId} is not approved for this project`);
        return approvedSelection(approved);
      }
      return (await resolveProjectModel(dependencies, project)).model;
    },
  };
}

/** Spec 052 FR-001: an administrator of the channel's project starts a batch from a file. */
async function routeStartEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<unknown> {
  const body = parseStartBody(value);
  const binding = await getSlackBinding(dependencies, body.teamId, body.channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  return startBatch(swebenchDependencies(dependencies), swebenchProjectContext(dependencies, binding.projectName), body);
}

/** Spec 052 FR-009, FR-010: show, stop or read the results of a batch, for an administrator of its channel's project. */
async function routeEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, batchId: string, action: "show" | "stop" | "results"): Promise<unknown> {
  // The admin claim first, so a non-administrator learns nothing about which batch IDs exist.
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const swebench = swebenchDependencies(dependencies);
  // The project stored on the batch, not the channel's current binding: a rebound channel does not hand over old batches.
  await requireAdministrator(dependencies, identity, await requireBatchProject(swebench, batchId));
  if (action === "stop") return stopBatchById(swebench, batchId);
  return action === "results" ? batchResults(swebench, batchId) : showBatch(swebench, batchId);
}

/** Spec 043 FR-002: an administrator of the channel's project enables, reads or disables SWE-bench runs there. */
async function routeSwebenchChannel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  method: "PUT" | "DELETE" | "GET",
  teamIdValue: string,
  channelIdValue: string,
  body: unknown,
): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  const swebench = swebenchDependencies(dependencies);
  if (method === "PUT") return { channel: await putSwebenchChannel(swebench, teamId, channelId, body), projectName: binding.projectName };
  if (method === "DELETE") return deleteSwebenchChannel(swebench, teamId, channelId);
  const channel = await getSwebenchChannel(swebench, teamId, channelId);
  if (!channel) throw agentXError("NOT_FOUND", "SWE-bench runs are not enabled in this channel");
  return { channel, projectName: binding.projectName };
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Spec 025 C25: the admin claim first, so a non-admin learns nothing about task IDs; then the task;
 * then the administrator membership on the task's project (FR-015). The audit record names the
 * admin by issuer and subject, and by the token's name or email claim when it has one.
 */
async function adminTaskShareMode(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, taskId: string, value: unknown, tasks: DeveloperTaskActions) {
  if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  // A malformed ID is never echoed back: it could be long or carry markup.
  if (!TASK_ID_PATTERN.test(taskId)) throw agentXError("TASK_NOT_FOUND", "that is not a task ID");
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) throw agentXError("TASK_NOT_FOUND", `no task ${taskId}`);
  // FR-015's membership check, answered FORBIDDEN (requireAdministrator's missing-membership answer
  // is NOT_FOUND, which would read as "no such task").
  const membership = await getMembership(dependencies, identity.ownerKey, task.project);
  if (membership?.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
  const claimed = [identity.claims.name, identity.claims.email].find((claim): claim is string => typeof claim === "string" && claim.trim() !== "");
  return adminShareMode(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: tasks, now: Date.now },
    { issuer: identity.issuer, subject: identity.subject, ...(claimed === undefined ? {} : { displayName: claimed.trim() }) },
    task,
    value,
  );
}

/** Whether closing a workspace of this mode deletes its storage. */
function closeReleasesStorage(workspace: WorkspaceInstance): boolean {
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "ec2-ebs":
      return true;
    case "demo-microvm":
      return false;
    default:
      return unhandledDeploymentMode(workspace);
  }
}

/** The workspace fields a project's runtime binding fixes. An ec2-ebs workspace keeps only its mode. */
function workspaceRuntime(runtimeBinding: RuntimeBinding) {
  switch (runtimeBinding.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("CONFIG_INVALID", "retired project revision cannot create workspaces; register an ec2-ebs revision");
    case "ec2-ebs":
      return { deploymentMode: runtimeBinding.deploymentMode };
    default:
      return unhandledDeploymentMode(runtimeBinding);
  }
}

function workspaceItem(workspace: WorkspaceInstance) {
  // Spec 041: the sparse byWorkspaceProject index attributes make this record findable by project,
  // which is how a developer's workspaces are listed. They are storage keys, not record fields, so
  // workspaceRecordFields strips them again on the way back.
  return {
    ...workspaceKey(workspace.id),
    entityType: "WORKSPACE",
    ...workspaceProjectIndexAttributes(workspace),
    ...workspace,
  };
}

function membershipRecord(ownerKey: string, projectName: string, role: MembershipRecord["role"]): MembershipRecord {
  return { pk: `MEMBER#${ownerKey}`, sk: `PROJECT#${projectName}`, entityType: "MEMBERSHIP", ownerKey, projectName, role };
}

function projectKey(nameValue: string, revision: number) {
  return { pk: `PROJECT#${nameValue}`, sk: `REV#${String(revision).padStart(12, "0")}` };
}

function githubRepositoryFullName(repositoryUrl: string): string {
  let url: URL;
  try { url = new URL(repositoryUrl); } catch { throw agentXError("CONFIG_INVALID", "registered repository URL is invalid for GitHub PR tracking"); }
  const segments = url.pathname.split("/").filter(Boolean);
  const name = segments[1]?.endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port !== ""
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || segments.length !== 2 || segments.some((segment) => segment.includes("%"))
    || !segments[0] || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(segments[0])
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw agentXError("CONFIG_INVALID", "registered repository URL is not a canonical GitHub repository");
  }
  return `${segments[0]}/${name}`;
}

function pullRequestMatchesRepository(pullRequestUrl: string, repositoryFullName: string, number: number): boolean {
  try {
    const url = new URL(pullRequestUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && url.port === ""
      && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.pathname.toLowerCase() === `/${repositoryFullName.toLowerCase()}/pull/${number}`;
  } catch {
    return false;
  }
}

function workspaceKey(id: string) {
  return { pk: `WORKSPACE#${id}`, sk: "META" };
}

function pullRequestKey(workspaceId: string, repository: string, number: number) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}`,
  };
}

function codeBuildKey(workspaceId: string, operationId: string, gate: string) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CODEBUILD#${operationId}#${gate}`,
  };
}

function issueRepositoryGrant(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  ownerKey: string,
  workspaceId: string,
  operationId: string,
  access: "clone" | "push" = "clone",
  repositoryName?: string,
): string {
  return dependencies.repositoryGrants.issue({
    ownerKey,
    projectName: project.definition.name,
    workspaceId,
    operationId,
    repositories: project.definition.repositories
      .filter((repository) => repositoryName === undefined || repository.name === repositoryName)
      .map((repository) => ({
      credentialRef: repository.credentialRef,
      repositoryUrl: repository.url,
      access,
    })),
  });
}

async function exchangeRepositoryCredential(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
) {
  const grant = request.headers["x-agentx-repository-grant"];
  if (!grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const input = object(parseBody(request.body), "repository credential exchange");
  const credentialRef = name(input.credentialRef, "credentialRef");
  const access = input.access === "clone" || input.access === "push" ? input.access : undefined;
  if (!access) throw agentXError("CONFIG_INVALID", "repository access is invalid");
  if (typeof input.repositoryUrl !== "string" || input.repositoryUrl.length > 2_048) {
    throw agentXError("CONFIG_INVALID", "repositoryUrl is invalid");
  }
  return dependencies.repositoryGrants.exchange(grant, {
    workspaceId,
    operationId,
    credentialRef,
    repositoryUrl: input.repositoryUrl,
    access,
  });
}

function verifyCapability(
  dependencies: AwsBrokerDependencies,
  token: string,
  action: CallbackClaims["actions"][number],
): CallbackClaims {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability");
  const expected = createHmac("sha256", dependencies.callbackSigningKey).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw agentXError("CALLBACK_FORBIDDEN", "invalid callback signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallbackClaims;
  if (claims.expiresAt <= Math.floor(Date.now() / 1_000) || !claims.actions.includes(action)) {
    throw agentXError("CALLBACK_FORBIDDEN", `callback capability does not allow ${action}`);
  }
  return claims;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseBody(body: string | undefined): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Issue #48: the parser's own words quote the body, so fixed words instead.
    throw agentXError("CONFIG_INVALID", "the request body is not valid JSON");
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be a UUID`);
  }
  return value;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw agentXError("CONFIG_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(value) || value < 0) throw agentXError("CONFIG_INVALID", "event cursor is invalid");
  return value;
}

/** The worker reports, once per conversation, that a saved session now exists for it. */
function startsConversation(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("conversation" in value)) return false;
  const conversation = value.conversation;
  return Boolean(
    conversation && typeof conversation === "object" && "started" in conversation && conversation.started === true,
  );
}

function isStatus(value: unknown, status: string): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === status);
}

function withoutKeys(record: RegisteredProjectRecord): Omit<RegisteredProjectRecord, "pk" | "sk"> {
  return {
    entityType: record.entityType,
    definition: record.definition,
    runtimeBinding: record.runtimeBinding,
    registeredBy: record.registeredBy,
    registeredAt: record.registeredAt,
  };
}

function parseStoredEvent(item: Record<string, unknown>): {
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
} {
  if (
    typeof item.sequence !== "number" ||
    typeof item.type !== "string" ||
    typeof item.timestamp !== "string"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored event is invalid");
  }
  return {
    sequence: item.sequence,
    type: item.type,
    timestamp: item.timestamp,
    payload: item.payload,
  };
}

function json(
  value: unknown,
  requestId: string,
  statusCode = 200,
): { statusCode: number; headers: Record<string, string>; body: string } {
  const body = value && typeof value === "object" ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client(awsClientConfiguration);
const secretsManager = new SecretsManagerClient(awsClientConfiguration);
const codeBuild = createCodeBuildGateway(awsClientConfiguration);
const stepFunctions = new SFNClient(awsClientConfiguration);
const ssm = new SSMClient(awsClientConfiguration);
// The broker only deletes ec2-ebs sessions when a workspace closes (#84).
const ec2Sessions = new SessionManager({
  documentClient,
  tableName: process.env.STATE_TABLE_NAME ?? "",
  executions: {
    provisionerArn: process.env.PROVISIONER_ARN ?? "",
    deleterArn: process.env.DELETER_ARN ?? "",
    async start(input) {
      return (await stepFunctions.send(new StartExecutionCommand(input))).executionArn!;
    },
  },
});
const githubPrivateKeySecretArn = requiredEnvironment("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
const githubAppIdSetting = process.env.GITHUB_APP_ID ?? "";
let githubAppSecret: Promise<string> | undefined;
const loadGitHubAppSecret = (): Promise<string> => {
  githubAppSecret ??= secretsManager.send(new GetSecretValueCommand({
    SecretId: githubPrivateKeySecretArn,
  })).then((response) => {
    const secret = response.SecretString ?? (
      response.SecretBinary === undefined
        ? undefined
        : Buffer.from(response.SecretBinary).toString("utf8")
    );
    if (!secret) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty");
    return secret;
  }).catch((error: unknown) => {
    githubAppSecret = undefined;
    // The secret has no version until `agentx init` creates the GitHub App.
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty; finish agentx init to create the GitHub App");
    }
    throw error;
  });
  return githubAppSecret;
};
let githubApp: Promise<{ appId: string; privateKey: string }> | undefined;
const loadGitHubApp = (): Promise<{ appId: string; privateKey: string }> => {
  githubApp ??= loadGitHubAppSecret().then((secret) => ({
    appId: githubAppIdSetting !== "" ? githubAppIdSetting : appIdFromSecret(secret),
    privateKey: privateKeyFromSecret(secret),
  })).catch((error: unknown) => {
    githubApp = undefined;
    throw error;
  });
  return githubApp;
};
const loadGitHubPrivateKey = (): Promise<string> => loadGitHubAppSecret().then(privateKeyFromSecret);
const loadGitHubWebhookSecret = (): Promise<string> => loadGitHubAppSecret().then(webhookSecretFromSecret);
const githubCredentials = new GitHubAppCredentialProvider({
  credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
  appId: githubAppIdSetting !== "" ? githubAppIdSetting : async () => (await loadGitHubApp()).appId,
  getPrivateKey: loadGitHubPrivateKey,
});
const repositoryGrantSigningKey = createHmac("sha256", requiredEnvironment("CALLBACK_SIGNING_KEY"))
  .update("agentx:repository-grants:v3")
  .digest();
const repositoryGrants = new RepositoryGrantService(
  repositoryGrantSigningKey,
  (credentialRef, repositoryUrl, access) => githubCredentials.resolve(credentialRef, repositoryUrl, access),
);

const lambdaClient = new LambdaClient(awsClientConfiguration);
/** Set only in named environments with developer sign-in (infra/lib/developer-signin.ts). */
function developerConfiguration(): DeveloperApiConfiguration | undefined {
  const issuer = process.env.DEVELOPER_TOKEN_ISSUER;
  if (!issuer) return undefined;
  const functionName = requiredEnvironment("DEVELOPER_IDENTITY_FUNCTION_ARN");
  const teamId = process.env.SLACK_TEAM_ID ?? "";
  return {
    issuer,
    env: requiredEnvironment("AGENTX_ENV"),
    methods: { slack: process.env.DEVELOPER_SIGNIN_SLACK === "enabled", oidc: (process.env.DEVELOPER_OIDC_ISSUER ?? "") !== "" },
    ...(teamId === "" ? {} : { slackTeamId: teamId }),
    since: developerSinceFromEnvironment(process.env),
    signInTableName: requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME"),
    channelMembers: channelMembersThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelInfo: channelInfoThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackUserByEmail: slackUserByEmailThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackAuthCheck: slackAuthCheckThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    endDeveloperSessions: endDeveloperSessionsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelByName: channelByNameThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    // D17: kept for the Lambda's lifetime; an unknown kid refetches at most once a minute.
    verifyAccessToken: developerTokenVerifier({
      issuer,
      keys: developerKeysThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
      now: Date.now,
    }),
  };
}
const developer = developerConfiguration();

// Spec 025 A13: the health route's probes (health-probes.ts); clients are called only per request.
const cloudWatch = new CloudWatchClient(awsClientConfiguration);
const sqs = new SQSClient(awsClientConfiguration);

export const handler = createAwsBrokerHandler({
  documentClient,
  s3,
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
  issuer: requiredEnvironment("OIDC_ISSUER"),
  adminClaim: process.env.ADMIN_CLAIM ?? "cognito:groups",
  adminValues: JSON.parse(process.env.ADMIN_VALUES ?? "[\"agentx-admin\"]") as string[],
  callbackSigningKey: requiredEnvironment("CALLBACK_SIGNING_KEY"),
  repositoryGrants,
  githubPullRequests: githubCredentials,
  githubWebhookSecret: loadGitHubWebhookSecret,
  checkRepositoryAccess: (repository) => githubCredentials.checkRepository(repository),
  githubMcp: { credentials: (repository, access) => githubCredentials.issueCredentials(repository, access) },
  connectorCredentials: {
    secrets: secretsManagerSource(secretsManager, process.env.CONNECTOR_SECRET_PREFIX),
    githubApp: { ref: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), secretName: githubPrivateKeySecretArn },
    ...(process.env.CONNECTOR_SECRET_PREFIX ? { connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX } : {}),
  },
  codeBuild,
  ...(developer ? { developer } : {}),
  // Spec 025 A12: set only here, so a test harness without its own `me` never reaches the network.
  adminReads: {
    me: { issuer: requiredEnvironment("OIDC_ISSUER"), fetch, ...(developer?.slackUserByEmail === undefined ? {} : { slackUserByEmail: developer.slackUserByEmail }) },
    health: healthProbes({
      cloudWatch,
      sqs,
      release: process.env.AGENTX_RELEASE_VERSION,
      alarmPrefix: process.env.AGENTX_ALARM_PREFIX,
      deadLetterQueues: process.env.HEALTH_DEAD_LETTER_QUEUES,
      slackAuthCheck: developer?.slackAuthCheck,
      github: githubCredentials,
      log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    }),
  },
  ...(process.env.TURN_RECORDS_TABLE_NAME ? { turnRecordsTableName: process.env.TURN_RECORDS_TABLE_NAME } : {}),
  ...(process.env.SLACK_THREADS_TABLE_NAME ? { slackThreadsTableName: process.env.SLACK_THREADS_TABLE_NAME } : {}),
  ...(process.env.SLACK_ORCHESTRATOR_ROLE_ARN
    ? {
        slack: {
          orchestratorRoleArn: process.env.SLACK_ORCHESTRATOR_ROLE_ARN,
          memberWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_MEMBER_WORKSPACE_LIMIT ?? "3"),
            "SLACK_MEMBER_WORKSPACE_LIMIT",
          ),
          organizationWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_ORGANIZATION_WORKSPACE_LIMIT ?? "20"),
            "SLACK_ORGANIZATION_WORKSPACE_LIMIT",
          ),
        },
      }
    : {}),
  async deleteEc2Session(workspaceId) {
    await ec2Sessions.deleteSession(workspaceId);
  },
  // Spec 043: read per request, so installing the eval stack or a new runner image needs no broker release.
  ...(process.env.SWEBENCH_SETTINGS_PREFIX
    ? {
        swebench: {
          deployment: () => swebenchDeploymentFromParameters(requiredEnvironment("SWEBENCH_SETTINGS_PREFIX"), async (names) => {
            const response = await ssm.send(new GetParametersCommand({ Names: [...names] }));
            return new Map((response.Parameters ?? []).flatMap((parameter) => parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []));
          }),
          async startExecution(input) {
            const response = await stepFunctions.send(new StartExecutionCommand(input));
            // Spec 052 Ruling 13: recorded on the run, so the batch tick can find a dead execution.
            return { executionArn: response.executionArn };
          },
        },
      }
    : {}),
});
