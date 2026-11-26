import "./broker-environment-init.js"; import { companyMembershipFromDynamo, resolveCompany } from "./company-check.js"; // ENV-ROOM: the init first (broker-environment-init.ts; kept first by tests/contract/broker-environment-first.test.ts)
import { coreKeepPullRequests } from "./slack-core-feedback.js";
import { coreContextWorkerRouteOf } from "./dev-route-scopes.js";
import { isServerReadRequest } from "./developer-routes.js";
import { createHostedBrokerCoreServices } from "./core-job-services.js"; import { codeSettingsReader, companyCodeSettingsReader } from "./project-code-settings.js"; import { hostedPolicySource } from "./core-policy-source.js";
import { guardCoreProjectSource, planCoreProjectWrites, planCanonicalProjectIdentity, coreProjectSnapshotFence } from "./core-project-backfill.js"; import { coreCopyRefusalWords } from "./core-copy-refusal.js";
import { listSlackWorkspaceScopes } from "./slack-workspace-binding.js";
import { createSlackPersonResolver, slackBindingCompany, slackCompanyPerson, slackCompanyProject, type SlackCompanyDependencies } from "./slack-person.js";
import { latestRevisionRowFor } from "./company-layout.js";
import { slackChannelBindingKeyFor } from "./slack-company-layout.js";
import { installTeamOnLegacyPath, splitBySlackTeam, withoutSlackCompanyMode } from "./slack-company-split.js";
import { slackCompanyDependenciesFromEnvironment } from "./slack-company-wiring.js";
import { askSlackAnswerForIdentity } from "./slack-answers.js";
import { askSlackModelAccessForIdentity } from "./slack-model-access.js";
import { SLACK_WEB_SIGNIN_NOTICE } from "./slack-action-classes.js";
import { createSlackWorkspaceBindings, type SlackWorkspaceOperatorEvent } from "./slack-workspace-binding.js";
import { type SlackInstallWiring } from "./slack-company-install.js";
import { slackInstallThroughLambda } from "./slack-install-identity.js";
import type { SlackChannelWiring } from "./slack-channel-link.js";
import { refuseBrowserEvidenceOnCloud } from "./browser-evidence-seam.js";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { cancelCallbackForbidden, verifyCancelCallbackCapability } from "./cancel-callback-capability.js";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { machineSizePicker, optionalPicker } from "./worker-machines/machine-size-pick.js";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AgentXError, E2ESetupProposalSchema, E2EPolicySchema, E2EScenarioBundleSchema, e2eScenarioBundleDigest, E2ERunBindingSchema, E2ERoundSchema, inspectE2ERepository, inspectE2ERepositoryBeforeContractApiTargets, proposeE2ESetup, WEB_API_RUNTIME_PROFILE_ID, verifyE2ESourceSnapshot, verifyE2ESetupProposal, CHANNEL_TURN_REQUEST_MAX, AGENTX_PROTOCOL_VERSION, CheckReportSchema, LatestChecksSchema, PULL_REQUEST_BODY_MAX_CHARS, checksForSection, StandingFailuresSchema, checksMakeDraft, checksSection, nextStandingFailures, type StandingFailure, plainPageRefs, canonicalJson, taskResultChecks, type CheckEntry, type LatestChecks, CONNECTOR_SECRET_PREFIX, ChannelTurnSchema, DEVELOPER_TASK_OWNER_ISSUER, sharedTaskKey, type SharedTaskRecord, ConnectorCallRequestSchema, GitHubMcpRequestSchema, OperationRequestSchema, PullRequestRequestSchema, PullRequestLifecycleRequestSchema, PullRequestLifecycleResultSchema, PullRequestResultSchema, ProjectDefinitionSchema, type ClientRepositoriesResponse, approvedToolCount, githubConnectorOf, presentedNameProblems, toolBudget, TOOL_LIMIT, TOOL_WARNING_THRESHOLD, legacyProjectFields, SLACK_THREAD_OWNER_ISSUER, SlackChannelBindingSchema, channelBindingAttributes, channelBindingFromSlack, SlackChannelIdSchema, SlackMessageTimestampSchema, SlackRequesterSchema, SlackTaskAnswerRequestSchema, SlackThreadNoteAnsweredRequestSchema, SlackCommentAnsweredRequestSchema, SlackThreadSchema, SlackTeamIdSchema, WorkspaceClosePreflightResultSchema, WorkspaceInstanceSchema, agentXError, parseSlackThreadSubject, slackThreadSubject, slackThreadUrl, unhandledDeploymentMode, workspaceRecordFields, type Operation, type OperationRequester, type OperationStatus, type ChannelTurn, type CodeBuildCheckResult, type CodeBuildGateDefinition, codeBuildGatesOf, type ProjectDefinition, type ProjectCommand, type RegistrationPreflight, type PullRequestLifecycleResult, type SlackChannelBinding, type SlackRequester, type SlackThread, type SlackThreadPrepareResult, type SlackThreadWorkspaceResult, type SlackWorkspaceCloseCompleteResult, type SlackWorkspaceCloseStartResult, type ThreadConnector, type WorkerInvocation, type WorkspaceInstance, WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_FEEDBACK_REVIEW_ANSWER_ARTIFACT, cleanDisplayName, redactAndCap, redactText, DISPLAY_NAME_MAX_ENCODED_LENGTH, projectCatalogKey, orgProjectCatalogKey, type OrgId, type ChannelMembersRequest, type AdminChangePressEvent, INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, sameJsonContent, type E2ESourceSnapshot, type E2ESetupProposal, type E2EPolicy, type PlanApprovalRef, E2E_AGENT_UNAVAILABLE_REASONS, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_ROUTE_CHANGED_REAPPROVE, ProjectSetupExecutionSchema, ProjectSetupOperationSchema, ProjectSetupSessionSchema, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema, projectSetupExecutionKey, projectSetupOperationKey, projectSetupSessionKey, WorkerInvocationSchema, EVAL_PLAN_DELIVERY_ACTION } from "@agentx/contracts";
import { selectE2EExecutionPlan } from "@agentx/contracts/e2e-execution-plan";
import { compileE2EScenarios, collectE2EActualCliRun, e2eSnapshotSourceDigest, parseE2EFirstPartyCapture, e2ePrivateTransferMaxBytes } from "@agentx/verifier";




import type { AuthenticatedIdentity } from "../auth.js";
import { adminReader, queryAllItems, type AdminReadDependencies } from "./admin-reads.js";
import { outcomeMetric } from "./admin-change-audit.js";
import { type AdminChangeDependencies } from "./admin-changes.js";
import type { AdminChangeHandlers, PlanDependencies, ReviewedChannelBinding } from "./admin-change-plans.js";
import { ZodError, z } from "zod";
import { healthProbes } from "./health-probes.js";

import { releaseFailedPreparation, slackMemberLimitKey, slackOrganizationLimitKey, slackThreadKey } from "./failed-preparation.js"; import { coreThreadNote } from "./slack-core-thread-input.js";   import type { ThreadInputNotice } from "./slack-thread-input-words.js"; import { isOwnSlackStart, startSlackWorkflowOnCore } from "./slack-core-start.js"; import { hostedSlackThreads } from "./slack-thread-channel.js";
import { releaseFailedCancelWorkspace } from "./failed-cancel-release.js";
import { assertNoUntrustedRoutingFields } from "../authorization.js";
import { isWebhookSecretMissing, parseGitHubRepository, pullRequestBodyWithDraftNote } from "../github-app.js";
import { createGitHubAppCredentials, filterInstallationsFor, githubBindingRefusal, githubDisconnectedRefusal, GithubInstallationBindings, isGithubDisconnected } from "./github-credentials.js"; import { handleGithubInstallationWebhook } from "./github-lifecycle.js"; import { GitHubAppCredentialProvider as GitHubAppClient } from "../plugins/code-host/github/client.js"; import { bulkCreate, COMMIT_DEADLINE_MS, companyProjectCreatorOf, eachLimited, LOOKUP_CONCURRENCY, nameTaken, notAvailable, onCompanyInstallations, projectRepositoryName, projectsByRepository, repositoryChoices, REPOSITORY_CHOICES_UNAVAILABLE, unavailable, uniqueRepositoryNames } from "./client-project-create.js"; import { brokerCoreCodeHost } from "./core-code-host.js"; import { companyNameClaimWrites, companyNameTaken, companyProjectNaming, type ClientProjectNaming } from "./company-project-names.js";
import { linearCompanyWiring } from "./linear-wiring.js";
import { readTaskLegacyProject, boundedCompanyReads, ownPartitionRow, recordInCompany } from "./company-check.js"; import { grantKeyFor, namedCompany, revisionKeyFor } from "./company-layout.js";

import { handleGithubWebhookRoute } from "./github-webhook-route.js";

import { CredentialUnavailable } from "@agentx/gateway";
import { unsupportedThinkingLevels } from "@agentx/model-runtime/thinking-levels";
import { executeGitHubTool, toGitHubCatalog, type GitHubMcpDependencies } from "../github-mcp.js";
import { DynamoConnectorLedger, GITHUB_LEDGER } from "./connector-ledger.js";
import { observeConnectorRoute } from "./connector-metrics.js";
import { attributionDroppedLog, callConnector, connectorCatalogKey, discoverConnector, discoverLegacyGitHubScope, stripCode, type ConnectorContextBase } from "./connector-routes.js";
import { resolveConnectors, BUILT_IN_CONNECTOR_TYPES, type ConnectorTypeContext, type ResolvedConnector } from "./connector-types.js";
import { secretsManagerSource } from "./credentials.js";
import { secretsManagerAdapterSecrets } from "./channel-adapters.js";
import { channelCharge, channelConversationIdentity, channelRequester, channelThreadChargeItems, channelThreadReleaseItems, isConversationChargeMarker, readConversationHeaders, storedCharge } from "./channel-conversation.js";
import { companyReadsFromEnvironment, policyHookInstallFromEnvironment } from "./hosted-wiring.js";
import { developerTokenVerifier } from "../developer/verify-token.js";
import { brokerCoreWorkerMachines } from "./worker-machines/broker-core.js";
import { adminOfferedModelsFromEnvironment } from "../core-host/offered-models-http.js";
import { installEngineModel } from "../core-host/company-engine-model.js"; import { installLearningModel } from "../core-host/company-learning-model.js";
import { createHostedLessonsPeople } from "./hosted-lessons-people.js"; import { hostedLessonsSlack } from "./hosted-slack-thread.js";
import { hostedLessonsLearning } from "../core-host/hosted-learning.js";
import { CORE_MODEL_ACCESS_PATH, brokerCoreModuleDeps, createBrokerCoreRoot, taskTokensFromEnvironment, withCoreRoutes } from "./core-engine-root.js";


import { isPageRefusal, writeCommentAnswer, type SlackRequestQueue } from "../developer/page-comments.js";
import { loadWorkflowDocument, readObjectText as readStoredText } from "../developer/plan-artifacts.js";





import { requireProject } from "./project-records.js";
import { admitProjectSetupRuntime, projectSetupBindingDigest, projectSetupRuntimeKey, ProjectSetupRuntimeRecordSchema, setupSessionInstance } from "./project-setup-runtime-catalog.js";
import { projectSetupTerminalAuthorityChecks } from "./project-setup-terminal-conditions.js";
import { verifyProjectSetupCapability } from "./project-setup-capability.js";
import { issueProjectSetupCapability } from "./project-setup-capability.js";
import { deriveProjectSetupSourceSmoke } from "../e2e/project-setup-source-smoke.js";


import { e2eRegisteredRuntimeKey, readReadyE2ERuntimeProfiles } from "./e2e-runtime-readiness.js";
import { planSetupAccountWrites } from "./e2e-account-registry.js";
import { E2EAccountRegistryError } from "../e2e/application-account-registry.js";


import { isCoreTask, isCoreTaskThatExists, isCoreWorkspace } from "./engine-boundary.js"; import { NOT_ON_THE_CORE_YET } from "../core-host/dev-routes.js"; import { WORKFLOW_BUTTON_OUT_OF_DATE } from "../developer/workflow-actions.js"; import { coreAdminStop, type CoreStopOutcome } from "./core-stop-entry.js"; import { coreStopButton, coreThreadStop } from "./slack-core-stop.js";
import {
  TERMINAL, getItem, issueCapability, operationKey, operationRecord, outboxRecord, publicOperation, requestCancellation, requireOperation,
  type CallbackClaims, type OperationRecord,
} from "./cancellation.js";
import { developerFooter, inertName, taskKey, taskOwnerKey, taskOwnerSubject, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type StoredEvent } from "../developer/task-records.js";
import { limitReached, readWorkspaceLimits } from "../developer/limits.js";
import { AWS_TEMPORARY_MESSAGE, GATED_TASK_PULL_REQUEST_ACTION_REFUSAL, GATED_TASK_PULL_REQUEST_REFUSAL, GATED_TASK_TURN_REFUSAL, UNEXPECTED_REQUEST_MESSAGE, hashJson, isConditional, isTemporaryAwsError, workerPrompt } from "./broker-shared.js";
import { isExactFeatureE2ESourceSnapshot } from "../e2e/feature-plan-planning-context.js";




import { assertNoRequalifyHold, rethrowAsDeferredIfHeld, requalifyHoldFence, requalifySetupWorkRow } from "../e2e/requalify-hold.js";



import { EGRESS_ADDRESSES_VARIABLE, SLACK_ANSWER_SERVICE_PATH, SLACK_MODEL_ACCESS_SERVICE_PATH, OrgIdSchema, QuickAutoStartRequestSchema, REQUEST_ROUTE_MESSAGE_MAX, SLACK_INTAKE_RECORD_SECONDS, type QuickAutoStartResult } from "@agentx/contracts"; import { EVIDENCE_RETENTION_TAGS } from "../core-host/hosted-evidence.js";
import { quickAutoStartRefusal } from "../core/intake/quick-auto-start.js";

import { handleE2EModelBudgetCallback } from "../e2e/model-budget-endpoint.js";
import { ModelCheckError, readCurrentTiers, readModelCheck, startModelCheck, type ModelCheckDependencies } from "../e2e/model-checks.js";
import { E2EModelRouteError, agentRouteSummary, approveE2EAgentRoute, e2eAgentInstallationFromParameters, readE2EModelRouteShape, type E2EAgentInstallation } from "../e2e/model-route-registry.js";

import { developerIdForSlackUser, projectMemberKey } from "./admin-actions.js";
import { workerBindingFromPairs } from "./worker-binding.js";
import { chatGptOwner, chatGptTaskSelection } from "../chatgpt/task-model.js";
import { chatGptConnections, kmsChatGptSealer } from "../chatgpt/connections.js";
import { chatGptHostId } from "../chatgpt/oauth.js";
import { companyInvitesThroughLambda, companyPreapprovalsThroughLambda, companySelfCreateThroughLambda, channelByNameThroughLambda, channelInfoThroughLambda, channelMembersThroughLambda, developerKeysThroughLambda, developerTaskRouteDependencies, endDeveloperSessionsThroughLambda, setDisplayNameThroughLambda, routeAppRequest, routeDeveloperRequest, routeLinkingRequest, signInClientsThroughLambda, slackAuthCheckThroughLambda, slackUserByEmailThroughLambda, taskChannelPeopleThroughLambda, taskPeopleDisplayReadThroughLambda, taskPersonProofThroughLambda, type DeveloperApiConfiguration, type DeveloperCaller, type DeveloperRouteDependencies } from "./developer-routes.js";
import { companyMemberActionsThroughLambda } from "./company-member-forwarding.js"; import { githubLinkWiringFromEnvironment } from "./github-link-wiring.js"; import { signInLinksThroughLambda } from "./sign-in-link-routes.js";
import { companyImportThroughLambda } from "./company-import-forwarding.js";
import type { DeveloperTaskActions, ExtraItems, TransactItems } from "./developer-task-actions.js";
import { adminShareMode, confirmTaskPeopleProposal, releaseFinishedTasksOf, getTaskPeople, markWorkflowThreadNoteAnswered, routeDeveloperTaskRequest, submitSlackTaskOwnership, submitSlackTaskPeopleRole, workflowTaskAnswerContext } from "./developer-tasks.js";
import { createDeveloperApiConfiguration } from "./workflow-dependencies-configuration.js";







import { credentialRefusals, preflightConnectors, registrationWarnings, type PreflightOutcome } from "./registration-preflight.js";
import { dynamoTurnRecordSource } from "./turns.js";
import { createCodeBuildGateway } from "../codebuild.js";
import { RepositoryGrantService } from "../repository-access.js"; import { exchangeLegacyGitCredential } from "./legacy-repository-exchange.js";
import { publicWorkspace } from "../workspaces.js";
import { SessionManager } from "./sessions.js"; import { loadCallbackSigningKey } from "./callback-signing-key.js"; // one line: no line of broker.ts moves (the company inventory pins its sites by line)
import { STUCK_SETUP_MESSAGE } from "./stuck-setup.js";



import { adaptHttpApiEvent, identityFromJwtClaims, isAssumedRoleOf, ownerKeyForSubject, parseRuntimeBinding, requiredEnvironment, type AdaptedHttpRequest, type HttpApiV2Event } from "./lambda.js";
import { slackWorkflowCaller } from "./slack-workflow-caller.js";
import { can, resolveTaskAccess, type TaskAccess, type TaskAction } from "../developer/task-access.js";
import { taskAccessFence } from "../developer/task-people.js";
import { MAX_ARTIFACT_BYTES, MAX_SETUP_PROPOSAL_BYTES, MAX_SETUP_EVIDENCE_BYTES, LEGACY_E2E_COMPANY, SETUP_ARTIFACT_CHUNK_BYTES, EVENT_TRANSACTION_CHUNK, NAMED_COMPANY_CANDIDATE_WAITING, type RegisteredProjectRecord, type MembershipRecord, type PullRequestRecord, type CodeBuildRecord, type AwsBrokerDependencies, type AwsBrokerInput, type SlackServiceConfiguration, DOT_SEGMENT, DEVELOPER_ROUTE_KEY, CORE_APP_ROUTE_KEY, FEEDBACK_REVIEW_ROUTE_KEY, CLIENT_PROJECT_INSTRUCTIONS, TASK_ID_PATTERN, LEGACY_REVISION_GRANT } from "./broker-types.js";
import { type SlackStopTaskEvent, type SlackWorkflowStartEvent, type SlackWorkflowDecisionEvent, type SlackWorkflowRetryEvent, type SlackWorkflowSendBackEvent, type SlackWorkflowResolveFindingsEvent, type SlackWorkflowCloseEvent, type SlackWorkflowReviewRetryEvent, type SlackTaskAuthorizationEvent, type SlackTaskPeopleConfirmEvent, type SlackTaskPeopleReadEvent, type SlackTaskPeopleChangeEvent, type SlackTaskPeopleTakeOwnershipEvent, type SlackIntakeRecordEvent, type SlackThreadNoteEvent } from "./slack-broker-events.js";
import { projectSetupPolicy, plannedAgentRoute, untestedAgentRouteNote, brokerDependencies, adminCompanyReader, sharedThread, sharedThreadOpen, slackThreadOwnRow, taskLegacyScope, readWorkspaceTaskLegacyProject, getSlackBinding, developerRequested, requireOwnedWorkspace, requireWorkspace, getDefaultWorkspace, getThreadWorkspace, slackCallerRouteDependencies, channelLinkRouteDependencies, channelConversationDependencies, conversationStarterId, conversationProjectName, requireLatestProject, getProjectModels, putProjectModel, resolveProjectModel, requirePullRequest, adoptLegacyPullRequest, requireMembership, getMembership, grantCompany, storedCompanyOf, requireAdministrator, requireAdministratorGrant, closeReleasesStorage, workspaceRuntime, workspaceItem, membershipRecord, workspaceKey, pullRequestKey, codeBuildKey, issueRepositoryGrant, requireGithubProjectBinding, verifyCapability, object, parseBody, uuid, name, positiveInteger, encodeCursor, decodeCursor, startsConversation, isStatus, parseStoredEvent, json } from "./broker-primitives.js";
import { dispatchAdminHttpRoute, dispatchCoreAndOperatorEvent, dispatchPreAuthHttpRoute, dispatchSlackIngressEvent } from "./broker-router.js";
export { PROJECT_SETUP_CAPTURE_POLICY, NAMED_COMPANY_CANDIDATE_WAITING, type RegisteredProjectRecord, type AwsBrokerInput } from "./broker-types.js";
export { type SlackStopTaskEvent, type SlackWorkflowStartEvent, type SlackWorkflowDecisionEvent, type SlackWorkflowRetryEvent, type SlackWorkflowSendBackEvent, type SlackWorkflowResolveFindingsEvent, type SlackWorkflowCloseEvent, type SlackWorkflowReviewRetryEvent, type SlackWorkflowFeedbackFindingsDecisionEvent, type SlackWorkflowFeedbackNoteEvent, type SlackTaskAuthorizationEvent, type SlackTaskPeopleConfirmEvent, type SlackTaskPeopleReadEvent, type SlackTaskPeopleChangeEvent, type SlackTaskPeopleTakeOwnershipEvent, isSlackTaskPeopleReadEvent, isSlackTaskPeopleChangeEvent, isSlackTaskPeopleTakeOwnershipEvent, isSlackTaskPeopleConfirmEvent, isSlackTaskAuthorizationEvent, isSlackWorkflowStartEvent, type SlackIntakeRecordEvent, isSlackIntakeRecordEvent, isSlackWorkflowDecisionEvent, isSlackWorkflowRetryEvent, isSlackWorkflowSendBackEvent, isSlackWorkflowResolveFindingsEvent, isSlackWorkflowCloseEvent, isSlackWorkflowReviewRetryEvent, type SlackWorkflowPublishRetryEvent, isSlackWorkflowPublishRetryEvent, type SlackWorkflowKeepPullRequestsEvent, isSlackWorkflowKeepPullRequestsEvent, isSlackWorkflowFeedbackFindingsDecisionEvent, isSlackWorkflowFeedbackNoteEvent, type SlackWorkflowFeedbackReviewRetryEvent, isSlackWorkflowFeedbackReviewRetryEvent, type SlackThreadNoteEvent, isSlackThreadNoteEvent, isSlackStopTaskEvent } from "./slack-broker-events.js";
export { channelLinkRouteDependencies } from "./broker-primitives.js";
import { answerSlackCorePress, isSlackCorePressEvent } from "./slack-core-decision.js";
import { rethrowMembershipReadFailure } from "../core/membership-read.js";
import { recordRetiredSlackButtonNote } from "./slack-retired-buttons.js";
import { RETIRED_SLACK_BUTTON_ANSWER } from "./slack-retired-buttons.js";
export const NAMED_COMPANY_SETUP_APPROVAL_REFUSED = "a company's browser testing is set up on the project's Browser testing page, and the rest of its setup goes through the project's setup flow, not through a setup approval sent with registration";

/** The broker actions developer task routes call (spec 025); tests and the route wiring use this factory. */
export function createDeveloperTaskActions(input: AwsBrokerInput): DeveloperTaskActions {
  return developerTaskActions(brokerDependencies(input));
}

/** Spec 025 phase 25d: what the admin read routes need, from the broker's own dependencies. */
function adminReadDependencies(dependencies: AwsBrokerDependencies): AdminReadDependencies {
  const developer = dependencies.developer;
  // DEC 254zzz6 D2: production sets the membership reader on the developer configuration only (COMPANY_SIGNIN), never top-level; without it here every admin read's company check passed.
  const companies = adminCompanyReader(dependencies);
  return {
    ...(companies === undefined ? {} : { companies }),
    ...(dependencies.workspaces === undefined ? {} : { slackWorkspaces: {
      requireCompany: (teamId: string) => dependencies.workspaces!.requireCompany(teamId),
      scopesForCompany: (companyId: string) => listSlackWorkspaceScopes({ client: dependencies.documentClient, tableName: dependencies.tableName }, companyId),
    } }),
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turnRecordsTableName: dependencies.turnRecordsTableName }),
    ...(dependencies.turnRecordsTableName === undefined ? {} : { turns: dynamoTurnRecordSource(dependencies.documentClient, dependencies.turnRecordsTableName) }),
    ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
    ...(developer?.channelInfo === undefined ? {} : { channelInfo: developer.channelInfo }),
    ...(developer === undefined ? {} : { channelMembers: (request: ChannelMembersRequest) => developer.channelMembers(request) }),
    limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
    now: Date.now,
    log: brokerLogLine,
    ...dependencies.adminReads,
  };
}

/** Spec 025 phase 25e: the existing admin handlers a confirmed change applies through (FR-040). */
function adminChangeHandlers(dependencies: AwsBrokerDependencies): AdminChangeHandlers {
  return {
    requireAdministrator: (identity, project) => requireAdministrator(dependencies, identity, project),
    readChannelBinding: (teamId, channelId) => getSlackBinding(dependencies, teamId, channelId),
    bindChannel: async (identity, teamId, channelId, project, reviewed) => putSlackBinding(dependencies, identity, teamId, channelId, { projectName: project }, reviewed),
    unbindChannel: async (identity, teamId, channelId, reviewed) => deleteSlackBinding(dependencies, identity, teamId, channelId, reviewed),
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
      // DEC 254zzz80: the revision's key in the company registration will write to (registerProject's own company rule: no developer, no company).
      const planCompany = identity.developer === undefined ? undefined : await githubCallerCompany(dependencies, identity.developer.developerId, boundedCompanyReads(dependencies.documentClient));
      if (await getItem(dependencies, revisionKeyFor(planCompany, definition.name, definition.revision)) !== undefined) {
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
  // Spec 064: the legacy deployment's linking sign-in serves the sign-in client changes, its only kinds.
  const signIn = developer ?? dependencies.linking;
  const registry = dependencies.credentialRegistry;
  return {
    reads: adminReadDependencies(dependencies),
    actions: {
      documentClient: dependencies.documentClient, tableName: dependencies.tableName,
      ...(signIn === undefined ? {} : { signInTableName: signIn.signInTableName }),
      ...(developer?.slackTeamId === undefined ? {} : { slackTeamId: developer.slackTeamId }),
      limitDefaults: { member: dependencies.slack?.memberWorkspaceLimit ?? 3, organization: dependencies.slack?.organizationWorkspaceLimit ?? 20 },
      ...(developer?.endDeveloperSessions === undefined ? {} : { endDeveloperSessions: developer.endDeveloperSessions }),
      ...(signIn?.signInClients === undefined ? {} : { signInClients: signIn.signInClients }),
      ...(signIn?.companies === undefined ? {} : { companies: signIn.companies }),
      ...(developer?.companyInvites === undefined ? {} : { companyInvites: developer.companyInvites }),
      ...(developer?.companyImport === undefined ? {} : { companyImport: developer.companyImport }),
      now: Date.now,
    },
    handlers: adminChangeHandlers(dependencies),
    ...(developer?.channelByName === undefined ? {} : { channelByName: developer.channelByName }),
    ...(registry === undefined ? {} : { credentials: registry, builtInCredentialRef: registry.builtInRef }),
    // C5: the prefix the registry itself enforces.
    connectorSecretPrefix: registry?.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX,
  };
}

/**
 * The only admin changes the legacy deployment takes (spec 064), confirmed in the CLI: sign-in clients, and granting a
 * signed-in person a project, so a service such as the web app shows them the projects they may use.
 */
const LINKING_CHANGE_KINDS: ReadonlySet<string> = new Set(["register_sign_in_client", "remove_sign_in_client", "grant_project_access", "revoke_project_access"]);

/**
 * Spec 025 phase 25e: admin changes exist only with developer sign-in and a TurnRecords table (D14). Spec 064: the
 * legacy deployment's linking sign-in serves them too, for the sign-in client kinds alone.
 */
function adminChangeDependencies(dependencies: AwsBrokerDependencies, reads: AdminReadDependencies): AdminChangeDependencies | undefined {
  const linkingOnly = dependencies.developer === undefined && dependencies.linking !== undefined;
  const developer = dependencies.developer ?? dependencies.linking;
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
    // The legacy deployment has no AI-tool pop-up (no MCP server there): the CLI, or Slack where a team is set.
    confirm: dependencies.adminChanges?.confirm ?? { elicitation: !linkingOnly && process.env.MCP_CONFIRM_ELICITATION !== "disabled", slack: developer.slackTeamId !== undefined },
    ...(linkingOnly ? { kinds: LINKING_CHANGE_KINDS } : {}),
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
    latestProject: (name) => requireLatestProject(dependencies, name).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    projectRevision: (name, revision) => requireProject(dependencies, name, revision).catch((error: unknown) => {
      if (error instanceof AgentXError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }),
    workspace: (id) => requireWorkspace(dependencies, id),
    operations: async (workspaceId) => (await isCoreWorkspace(dependencies, workspaceId) ? [] : await query(`WORKSPACE#${workspaceId}`, "OPERATION#"))
      .filter((item) => item.entityType === "OPERATION")
      .map((item) => publicOperation(item as unknown as OperationRecord)),
    eventsNewestFirst: (operationId, limit) => operationEventsNewestFirst(dependencies, operationId, limit),
    artifacts: async (workspaceId, operationId) => (await isCoreWorkspace(dependencies, workspaceId) ? [] : await query(`WORKSPACE#${workspaceId}`, "ARTIFACT#"))
      .filter((item) => item.operationId === operationId)
      .map((item) => ({
        id: String(item.id), operationId: String(item.operationId), name: String(item.name), mediaType: String(item.mediaType), objectKey: String(item.objectKey),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
      })),
    readArtifact: async (objectKey, maxBytes) => {
      const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Range: `bytes=0-${maxBytes - 1}` }));
      return object.Body ? await object.Body.transformToString("utf8") : "";
    },
    pullRequests: async (workspaceId) => (await isCoreWorkspace(dependencies, workspaceId) ? [] : await query(`WORKSPACE#${workspaceId}`, "PULL_REQUEST#"))
      .map((item) => ({ repository: String(item.repository), number: Number(item.number), url: String(item.url), state: item.state as "open" | "closed" | "merged" })),
    deleteCompute: (workspace) => deleteWorkspaceCompute(dependencies, workspace),
    canDeleteCompute: (workspace) => workspace.deploymentMode === "ec2-ebs" && dependencies.deleteEc2Session !== undefined,
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
  const { core, ...brokerInput } = input;
  const dependencies = brokerDependencies({ ...brokerInput, ...(core === undefined ? {} : { core }) });
  if (Buffer.byteLength(dependencies.callbackSigningKey, "utf8") < 32) {
    throw new Error("CALLBACK_SIGNING_KEY must contain at least 32 bytes");
  }
  // L2-2 PR 18b (slack-company-split.ts): without `workspaces` (Slack company mode off) this is today's handler, unchanged. With it, SLACK_TEAM_ID's team and every request
  // naming no team get a handler built without `workspaces` (today's legacy path); every other team gets the company path.
  const company = dependencies.workspaces === undefined ? undefined
    : brokerEventHandler(core, { ...dependencies, ...(dependencies.companies === undefined && dependencies.slackCompanies !== undefined ? { companies: dependencies.slackCompanies } : {}) });
  // #1300: the install's team takes today's handler only while its workspace binding names the built-in company; moved to a named company, it is served like any other team.
  const legacyTeam = dependencies.slackWorkspaceLegacyTeamId;
  const workspaces = dependencies.workspaces;
  const installOnLegacy = legacyTeam === undefined || workspaces === undefined ? undefined : installTeamOnLegacyPath((team) => workspaces.requireCompany(team), legacyTeam);
  return splitBySlackTeam(brokerEventHandler(core, company === undefined ? dependencies : installTeamView(dependencies)), company, legacyTeam, installOnLegacy);
}

/**
 * The install team's legacy view (withoutSlackCompanyMode), which also knows the install team's company (DEC 254zzz80, R2-F1): its channel bindings are read in a NAMED company's
 * own partition, and its Slack start becomes that company's start (installTeamCompanyMode). The built-in company keeps today's legacy view exactly.
 */
function installTeamView(dependencies: AwsBrokerDependencies): AwsBrokerDependencies {
  const workspaces = dependencies.workspaces!;
  const companies = dependencies.companies ?? dependencies.slackCompanies;
  return { ...withoutSlackCompanyMode(dependencies, dependencies.slackWorkspaceLegacyTeamId ?? ""), installTeamCompany: (team: string) => workspaces.requireCompany(team),
    installTeamCompanyMode: { workspaces, ...(companies === undefined ? {} : { companies }) } };
}

/**
 * #1161: the GitHub binding operator events (backfill, claim) need the bindings store over the State table. The deployed broker gives the broker-wide
 * `githubBindings` only where the host set it (it never does), but it always gives the client project routes theirs (`clientProjects.bindings`, the same
 * table): the events use the host's when there is one, else that one. Neither: refused, as before.
 */
function operatorGithubBindings(dependencies: AwsBrokerDependencies): GithubInstallationBindings {
  const bindings = dependencies.githubBindings ?? dependencies.clientProjects?.bindings;
  if (bindings === undefined) throw githubBindingRefusal();
  return bindings;
}

/** #1161: an operator event's refusal is logged with its reason (the error's name and a bounded message; the answer itself stays the fixed words). */
function operatorEventRefused(event: string, error: unknown): void {
  brokerLogLine({ event, reason: error instanceof Error ? `${error.name}: ${error.message}`.replace(/\s+/gu, " ").slice(0, 200) : "unknown" });
}

/** #1315: the HTTP request the event handler routes, and the caller it identified from the request's JWT claims. */
type BrokerHttpRequest = ReturnType<typeof adaptHttpApiEvent>;
type BrokerCallerIdentity = ReturnType<typeof identityFromJwtClaims>;

/**
 * POST /v1/admin/projects/setup-proposals (#1315: moved out of the event handler unchanged). An administrator's GitHub repository and ref are captured from the
 * trusted source, inspected, and turned into a setup proposal, stored once under its own digest.
 */
async function routeSetupProposal(dependencies: AwsBrokerDependencies, request: BrokerHttpRequest, identity: BrokerCallerIdentity, body: unknown): Promise<ReturnType<typeof json>> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (!dependencies.projectSetupSource) throw agentXError("RUNTIME_UNAVAILABLE", "trusted project source capture is not configured");
  const requestBody = z.object({ repositoryUrl: z.string().url().max(500), ref: z.string().min(1).max(255) }).strict().parse(body);
  const urlParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(requestBody.repositoryUrl);
  if (!urlParts?.[1] || !urlParts[2]) throw agentXError("CONFIG_INVALID", "setup repository must be a canonical GitHub repository URL");
  const snapshot = await dependencies.projectSetupSource.capture({ repositoryUrl: requestBody.repositoryUrl, ref: requestBody.ref });
  const candidate = snapshot.candidate;
  const sourceRepository = candidate.repositories.length === 1 ? candidate.repositories[0] : undefined;
  const expectedRepositoryId = `${urlParts[1]}/${urlParts[2]}`;
  if (!sourceRepository || sourceRepository.repositoryId.toLowerCase() !== expectedRepositoryId.toLowerCase()) throw agentXError("FORBIDDEN", "captured source repository does not match the selected repository");
  verifyE2ESourceSnapshot(snapshot, candidate);
  const inspection = inspectE2ERepository(snapshot, candidate).inspection;
  // Web and API targets are proposed against the qualified runtime profile when this installation has one READY (Ruling Y4: one row per kind).
  const readyProfiles = dependencies.e2eFeatureRuntimeCatalogId === undefined ? []
    : await readReadyE2ERuntimeProfiles({ runtimeCatalogId: dependencies.e2eFeatureRuntimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, now: Date.now(),
      read: (key) => getItem<Record<string, unknown>>(dependencies, key) });
  const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate, readyProfiles });
  const agentRoute = await plannedAgentRoute(dependencies);
  const policy = projectSetupPolicy(proposal, agentRoute);
  const aiNavigation = agentRoute === undefined ? null : agentRouteSummary(agentRoute.definition, { drivingTest: agentRoute.drivingTest });
  const aiNavigationUntested = agentRoute === undefined ? await untestedAgentRouteNote(dependencies) : null;
  const repositoryName = urlParts[2].replace(/\.git$/i, "");
  const cleanedRepositoryName = repositoryName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  const registeredRepositoryId = /^[a-z]/.test(cleanedRepositoryName) ? cleanedRepositoryName : `repo-${cleanedRepositoryName}`.slice(0, 63);
  const artifact = {
    schemaVersion: "project-setup-source-proposal/v1",
    issuerOwnerKey: identity.ownerKey,
    repositoryUrl: requestBody.repositoryUrl,
    selectedRef: requestBody.ref,
    identityMapping: { schemaVersion: "github-source-to-agentx-registration/v1", sourceRepositoryId: expectedRepositoryId, registeredRepositoryId },
    candidate,
    snapshot: { ...snapshot, sources: snapshot.sources.map(source => ({ ...source, bytesBase64: Buffer.from(source.bytes).toString("base64"), bytes: undefined })) },
    proposal,
    policy,
    ...(aiNavigation === null ? {} : { aiNavigation }),
  };
  const artifactBytes = canonicalJson(artifact);
  if (Buffer.byteLength(artifactBytes, "utf8") > MAX_SETUP_PROPOSAL_BYTES) throw agentXError("RUNTIME_UNAVAILABLE", "immutable setup proposal exceeds its bounded object size");
  const artifactDigest = createHash("sha256").update(artifactBytes, "utf8").digest("hex");
  const proposalRef = `project-setup-proposals/${identity.ownerKey}/${artifactDigest}.json`;
  try {
    await dependencies.s3.send(new PutObjectCommand({
      Bucket: dependencies.artifactBucketName,
      Key: proposalRef,
      Body: artifactBytes,
      ContentType: "application/json",
      Metadata: { sha256: artifactDigest, owner: identity.ownerKey, candidate: candidate.digest },
      IfNoneMatch: "*",
    }));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (code !== "PreconditionFailed" && status !== 412) throw error;
    const retained = await readStoredText(dependencies.s3, dependencies.artifactBucketName, proposalRef, MAX_SETUP_PROPOSAL_BYTES);
    if (retained !== artifactBytes) throw agentXError("RUNTIME_UNAVAILABLE", "content-addressed setup proposal object conflicts with its expected bytes");
  }
  return json({ proposalRef, proposalSha256: artifactDigest, candidateDigest: candidate.digest, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, proposal, policy, aiNavigation, aiNavigationUntested }, request.requestId);
}

function parseStoredSetupSources(rawSources: unknown): Array<{ path: string; sha256: string; bytes: Buffer; kind: "blob" }> {
  if (!Array.isArray(rawSources)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source inventory is invalid");
  return rawSources.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source item is invalid");
    const source = raw as Record<string, unknown>;
    if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") {
      throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source item is invalid");
    }
    return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
  });
}

async function loadStoredSetupProposalArtifact(
  dependencies: AwsBrokerDependencies,
  identity: BrokerCallerIdentity,
  approvalInput: { proposalRef: string; proposalSha256: string },
) {
  const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, approvalInput.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
  if (!stored || createHash("sha256").update(stored, "utf8").digest("hex") !== approvalInput.proposalSha256) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal is missing or its digest changed");
  }
  let artifact: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(stored);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
    artifact = decoded as Record<string, unknown>;
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal is unreadable"); }
  if (artifact.schemaVersion !== "project-setup-source-proposal/v1" || artifact.issuerOwnerKey !== identity.ownerKey) {
    throw agentXError("FORBIDDEN", "stored setup proposal belongs to another administrator");
  }
  const storedSnapshot = artifact.snapshot;
  if (!storedSnapshot || typeof storedSnapshot !== "object" || Array.isArray(storedSnapshot)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source snapshot is missing");
  }
  const snapshotObject = storedSnapshot as Record<string, unknown>;
  const sources = parseStoredSetupSources(snapshotObject.sources);
  const snapshot = { ...snapshotObject, sources } as unknown as E2ESourceSnapshot;
  const candidate = snapshot.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored setup candidate is invalid");
  }
  verifyE2ESourceSnapshot(snapshot, candidate);
  const inspection = inspectE2ERepository(snapshot, candidate).inspection;
  const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(artifact.proposal), snapshot, candidate);
  return { stored, artifact, snapshotObject, sources, snapshot, candidate, inspection, proposal };
}

async function handleSetupApprovalPolicyMismatch(
  dependencies: AwsBrokerDependencies,
  identity: BrokerCallerIdentity,
  request: BrokerHttpRequest,
  approvalInput: { projectName: string; proposalRef: string; proposalSha256: string; decision: "approve" | "decline" },
  artifact: Record<string, unknown>,
  policy: ReturnType<typeof projectSetupPolicy>,
  agentRoute: Awaited<ReturnType<typeof plannedAgentRoute>>,
): Promise<ReturnType<typeof json>> {
  // A proposal made under an earlier default is not approvable now, but a decision already recorded for it is still answered the same way (an idempotent retry).
  const decided = await getItem<Record<string, unknown>>(dependencies, { pk: `PROJECT_SETUP#${approvalInput.projectName}`, sk: `PROPOSAL#${approvalInput.proposalSha256}` });
  if (decided) {
    if (decided.ownerKey !== identity.ownerKey || decided.decision !== approvalInput.decision) throw agentXError("PROJECT_REVISION_MISMATCH", "setup proposal already has a different immutable decision");
    return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: true }, request.requestId);
  }
  // The only difference is the AI navigation route: the installation's provider, model, secret or OpenRouter policy changed (or another approval moved the registry) since the proposal.
  if (sameJsonContent({ ...(artifact.policy as Record<string, unknown>), modelRouteRevision: null, limits: null }, { ...policy, modelRouteRevision: null, limits: null })) {
    // With no route now, the settings were not read or no longer give a usable route; they have not been shown to have changed.
    if (agentRoute === undefined) {
      const untested = await untestedAgentRouteNote(dependencies);
      throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: ${untested !== null ? `${untested.sentence}; run the driving test, then propose the setup again`
        : "The AI navigation settings of this installation could not be read, or no longer give a usable route; propose the setup again once they can be"}`);
    }
    throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_MODEL_ROUTE_CHANGED_REAPPROVE}: The AI navigation settings changed; propose the setup again, then approve the new proposal`);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "this setup proposal was made under an earlier default policy and can no longer be approved: propose the setup again (re-propose the setup), then approve the new proposal");
}

function verifySetupProposalIdentityAndBytes(
  artifact: Record<string, unknown>,
  snapshotObject: Record<string, unknown>,
  sources: Array<{ path: string; sha256: string; bytes: Buffer; kind: "blob" }>,
  snapshot: E2ESourceSnapshot,
  candidate: E2ESourceSnapshot["candidate"],
  inspection: ReturnType<typeof inspectE2ERepository>["inspection"],
  proposal: E2ESetupProposal,
  stored: string,
): Record<string, unknown> {
  const identityMapping = artifact.identityMapping;
  if (!identityMapping || typeof identityMapping !== "object" || Array.isArray(identityMapping)
    || (identityMapping as Record<string, unknown>).schemaVersion !== "github-source-to-agentx-registration/v1"
    || (identityMapping as Record<string, unknown>).sourceRepositoryId !== candidate.repositories[0]?.repositoryId
    || typeof (identityMapping as Record<string, unknown>).registeredRepositoryId !== "string") {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored setup repository identity mapping is invalid");
  }
  const canonicalArtifact = { ...artifact, snapshot: { ...snapshotObject, sources: sources.map(source => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytesBase64: source.bytes.toString("base64") })) }, proposal };
  if (canonicalJson(canonicalArtifact) !== stored || proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate }).candidateDigest !== proposal.candidateDigest) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal does not match its source-derived bytes");
  }
  return identityMapping as Record<string, unknown>;
}

async function approvePinnedSetupAgentRoute(
  dependencies: AwsBrokerDependencies,
  identity: BrokerCallerIdentity,
  projectName: string,
  modelRouteRevision: NonNullable<ReturnType<typeof projectSetupPolicy>["modelRouteRevision"]>,
): Promise<void> {
  const unreadable = () => agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: The AI navigation settings of this installation could not be read; propose the setup again once they can be`);
  if (dependencies.e2eAgentInstallation === undefined) throw unreadable();
  let installation: E2EAgentInstallation;
  try { installation = await dependencies.e2eAgentInstallation(); } catch { throw unreadable(); }
  try {
    // The revision row records who approved it and for which project (audit; the installation's route is one for every project).
    await approveE2EAgentRoute({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, installation, modelRouteRevision,
      { approvedBy: identity.ownerKey, projectName });
  } catch (error) {
    if (error instanceof E2EModelRouteError) throw agentXError("RUNTIME_UNAVAILABLE", error.message);
    throw error;
  }
}

/** POST /v1/admin/projects/setup-approvals (#1315: moved out of the event handler unchanged): records an administrator's decision on a stored setup proposal, after checking its digest and owner again. */
async function routeSetupApproval(dependencies: AwsBrokerDependencies, request: BrokerHttpRequest, identity: BrokerCallerIdentity, body: unknown): Promise<ReturnType<typeof json>> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const approvalInput = z.object({ projectName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), proposalRef: z.string().min(1).max(512), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "decline"]) }).strict().parse(body);
  const expectedPrefix = `project-setup-proposals/${identity.ownerKey}/`;
  if (!approvalInput.proposalRef.startsWith(expectedPrefix) || approvalInput.proposalRef !== `${expectedPrefix}${approvalInput.proposalSha256}.json`) {
    throw agentXError("FORBIDDEN", "setup proposal reference is outside the authenticated administrator scope");
  }
  const { stored, artifact, snapshotObject, sources, snapshot, candidate, inspection, proposal } = await loadStoredSetupProposalArtifact(dependencies, identity, approvalInput);
  const agentRoute = await plannedAgentRoute(dependencies);
  const policy = projectSetupPolicy(proposal, agentRoute);
  if (!sameJsonContent(artifact.policy, policy)) {
    return await handleSetupApprovalPolicyMismatch(dependencies, identity, request, approvalInput, artifact, policy, agentRoute);
  }
  const identityMapping = verifySetupProposalIdentityAndBytes(artifact, snapshotObject, sources, snapshot, candidate, inspection, proposal, stored);
  const approvalKey = { pk: `PROJECT_SETUP#${approvalInput.projectName}`, sk: `PROPOSAL#${approvalInput.proposalSha256}` };
  const existing = await getItem<Record<string, unknown>>(dependencies, approvalKey);
  if (existing) {
    if (existing.ownerKey !== identity.ownerKey || existing.decision !== approvalInput.decision) throw agentXError("PROJECT_REVISION_MISMATCH", "setup proposal already has a different immutable decision");
    return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: true }, request.requestId);
  }
  // The approval that pins a route records it first: revision n+1 only when the route's digest changed, conditionally, never overwriting a revision. A route that is no
  // longer the one the proposal showed is refused here, before the approval is recorded.
  if (approvalInput.decision === "approve" && policy.modelRouteRevision !== null) {
    await approvePinnedSetupAgentRoute(dependencies, identity, approvalInput.projectName, policy.modelRouteRevision);
  }
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: {
    ...approvalKey, entityType: "PROJECT_SETUP_APPROVAL", ownerKey: identity.ownerKey, projectName: approvalInput.projectName,
    proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, candidateDigest: proposal.candidateDigest,
    repositoryUrl: artifact.repositoryUrl, identityMapping, decision: approvalInput.decision, approvedAt: new Date().toISOString(),
    policyDigest: createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex"), policy, targetIds: proposal.targets.map(target => target.targetId),
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
  return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: false }, request.requestId);
}

async function handleSlackModelAccessService(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, requestId: string): Promise<ReturnType<typeof json>> {
  const bindings = createSlackWorkspaceBindings({ client: dependencies.documentClient, tableName: dependencies.tableName, legacyTeamId: dependencies.slackWorkspaceLegacyTeamId });
  return json(await askSlackModelAccessForIdentity({
    companyMode: dependencies.workspaces !== undefined || (dependencies as SlackCompanyDependencies).slackInstallTeamOnly !== undefined, companyOf: (team) => bindings.companyOf(team),
    env: dependencies.slackModelAccess?.env ?? {}, taskTokens: dependencies.slackModelAccess?.taskTokens,
  }, identity), requestId);
}

async function handleSlackAnswerService(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, request: BrokerHttpRequest): Promise<ReturnType<typeof json>> {
  const view = identity.slack === undefined ? dependencies : await namedInstallTeamView(dependencies, identity.slack.thread.teamId);
  return json(await askSlackAnswerForIdentity({ company: view, core: view.developer?.coreApp }, identity, parseBody(request.body)), request.requestId);
}

// The hosted Slack orchestrator's /v1/service/* routes (#1315): it authenticates with its IAM role and acts only as a Slack thread owner.
async function routeServiceRequest(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, request: BrokerHttpRequest, url: URL): Promise<ReturnType<typeof json>> {
  const serviceUrl = new URL(`/v1${url.pathname.slice("/v1/service".length)}${url.search}`, "https://agentx.invalid");
  const identity = await slackServiceIdentity(dependencies, request);
  const exactRoutes: ReadonlyArray<readonly [string, string, () => Promise<ReturnType<typeof json>>]> = [
    ["POST", "/v1/threads/workspace", async () => json(await ensureThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId)],
    ["POST", "/v1/tasks/thread-notes/answered", async () => json(await markThreadNoteAnswered(dependencies, identity, parseBody(request.body)), request.requestId)],
    // Decision 134: a clear small change starts Quick on its own, after the broker's own check of the text.
    ["POST", "/v1/workflows/quick-start", async () => json(await startQuickFromIntake(dependencies, tasks, identity, parseBody(request.body)), request.requestId)],
    // DEC 254zzz79 (3): how this thread's chat and routing model calls are made (the company's AI through the gateway, never Rovara-paid; slack-model-access.ts).
    ["POST", SLACK_MODEL_ACCESS_SERVICE_PATH, async () => await handleSlackModelAccessService(dependencies, identity, request.requestId)],
    // Lead 4 J2: the smart Just answer for a Slack thread (slack-answers.ts). Who may ask and which project is decided there from the verified thread and member, never from the body.
    ["POST", SLACK_ANSWER_SERVICE_PATH, async () => await handleSlackAnswerService(dependencies, identity, request)],
    ["POST", "/v1/tasks/comments/answered", async () => json(await markCommentAnswered(dependencies, identity, parseBody(request.body)), request.requestId)],
    ["POST", "/v1/threads/workspace/prepare", async () => json(await prepareThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId)],
    ["POST", "/v1/threads/workspace/close", async () => json(await startThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId, 202)],
    ["POST", "/v1/threads/workspace/close/complete", async () => json(await completeThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId)],
    ["GET", "/v1/project/models", async () => json(await getProjectModels(dependencies, identity), request.requestId)],
    ["PUT", "/v1/project/model", async () => json(await putProjectModel(dependencies, identity, parseBody(request.body)), request.requestId)],
  ];
  const exact = exactRoutes.find(([method, path]) => request.method === method && serviceUrl.pathname === path);
  if (exact !== undefined) return await exact[2]();
  return await observeConnectorRoute(request.method, serviceUrl.pathname, () => routeWorkspaceRequest(dependencies, request, serviceUrl, identity));
}

// GitHub's webhook deliveries (#1315): verified by signature, with one retry on a freshly read secret.
/**
 * The installation bindings the webhook route reads (the core branch and the installation lifecycle events): the host's broker-wide `githubBindings` where it set them, else the client project
 * routes' `clientProjects.bindings`, which the deployed broker always gives (same class, same State table, same role: no new table or permission). The deployed host never sets `githubBindings`, so
 * before this fallback the core branch and the lifecycle events were dead on hosted and every delivery fell to the legacy handler (`not_linked` for a core task). Deliberately NOT used for the legacy
 * handler's company scoping (`companyForInstallation`): that stays tied to the broker-wide `githubBindings`, because the legacy delivery recovery reads its partition by the same condition.
 */
function webhookGithubBindings(dependencies: AwsBrokerDependencies): GithubInstallationBindings | undefined {
  return dependencies.githubBindings ?? dependencies.clientProjects?.bindings;
}

async function routeGithubWebhook(dependencies: AwsBrokerDependencies, request: BrokerHttpRequest): Promise<ReturnType<typeof json>> {
  if (request.method !== "POST") return json({ error: { code: "NOT_FOUND", message: "route not found" } }, request.requestId, 404);
  const bindings = webhookGithubBindings(dependencies);
  // Webhook lane W0: the route's front half (shape, secret, HMAC over the raw body, then the core branch) is aws/github-webhook-route.ts; the installation lifecycle handler runs with the secret that verified.
  const answer = await handleGithubWebhookRoute({
    headers: request.headers, body: request.body, secret: dependencies.githubWebhookSecret, isSecretMissing: isWebhookSecretMissing, now: Date.now, log: brokerLogLine,
    ...(bindings === undefined ? {} : { core: { documentClient: dependencies.documentClient, tableName: dependencies.tableName, bindings } }),
    // Guided onboarding PR 3: an `installation` event (uninstalled, suspended, unsuspended) marks the binding; it is verified by the same signature check first. D1: the old workflow engine's
    // pull request handler is gone: every other delivery that maps to no core task is answered 202 IGNORED by the route.
    installation: bindings === undefined ? undefined : (webhookSecret) => handleGithubInstallationWebhook({ rawBody: request.body ?? "", headers: request.headers, secret: webhookSecret, bindings, log: brokerLogLine }),
  });
  return json(answer.body, request.requestId, answer.status);
}

async function dispatchReviewHttpRoute(
  core: AwsBrokerInput["core"],
  dependencies: AwsBrokerDependencies,
  tasks: DeveloperTaskActions,
  request: AdaptedHttpRequest,
  url: URL,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  if (url.pathname.startsWith("/review/") && !dependencies.developer && dependencies.linking) {
    return await routeLinkingRequest(linkingRouteDependencies(dependencies, dependencies.linking), request, url) as { statusCode: number; headers: Record<string, string>; body: string };
  }
  if (!url.pathname.startsWith("/review/") || !dependencies.developer) throw agentXError("NOT_FOUND", "route not found");
  return await routeDeveloperRequest({
    ...(dependencies.developer.companies === undefined ? {} : { companies: dependencies.developer.companies }),
    ...(core?.lessons === undefined ? {} : { lessons: core.lessons }),
    ...(core?.lessonsSlackSwitch === undefined ? {} : { lessonsSlackSwitch: core.lessonsSlackSwitch }),
    ...(core?.knowledgeSwitch === undefined ? {} : { knowledgeSwitch: core.knowledgeSwitch }),
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks,
    ...channelLinkRouteDependencies(dependencies),
    ...clientProjectRouteDependencies(dependencies),
    ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
  }, request, url) as { statusCode: number; headers: Record<string, string>; body: string };
}

async function dispatchWorkerInternalHttpRoute(
  core: AwsBrokerInput["core"],
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
  // Lane E2 step 6: a worker's callback for a workspace a core task holds is the core's (its own capability and grant exchange; the root matches the paths).
  const contextRead = coreContextWorkerRouteOf(request.method, url.pathname);
  const isCoreGet = request.method === "GET" && (url.pathname === CORE_MODEL_ACCESS_PATH
    || contextRead?.path === "/v1/internal/context-tools" || contextRead?.path === "/v1/internal/design-review/packet");
  if (core !== undefined && (request.method === "POST" || isCoreGet)) {
    const answer = await core.callback(request);
    if (answer !== undefined) return answer;
  }
  // Internal worker routes authenticate with operation-scoped capabilities; user JWT auth starts below them.
  const callback = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/(events|artifacts|result|browser-evidence|e2e-model-budget|pull-request|pull-request-update|codebuild|chatgpt-token|chatgpt-status|eval-plan)$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && callback?.[1] && callback[2] && callback[3]) {
    return await handleCallback(dependencies, request, callback[1], callback[2], callback[3]);
  }
  const credentialExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/repository-credentials$/.exec(url.pathname);
  if (request.method === "POST" && credentialExchange?.[1] && credentialExchange[2]) {
    return json({ credential: await exchangeRepositoryCredential(dependencies, request, credentialExchange[1], credentialExchange[2]) }, request.requestId);
  }
  return undefined;
}

async function dispatchDevAndAppHttpRoute(
  core: AwsBrokerInput["core"],
  dependencies: AwsBrokerDependencies,
  tasks: DeveloperTaskActions,
  routeKey: string | undefined,
  request: AdaptedHttpRequest,
  url: URL,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
  if (url.pathname.startsWith("/v1/service/")) return await routeServiceRequest(dependencies, tasks, request, url);
  if (url.pathname.startsWith("/v1/app/") && (routeKey === CORE_APP_ROUTE_KEY || dependencies.developer?.coreApp !== undefined)) {
    if (dependencies.developer?.coreApp === undefined) throw agentXError("NOT_FOUND", "route not found");
    return await routeAppRequest({ ...(dependencies.developer.companies === undefined ? {} : { companies: dependencies.developer.companies }), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now }, request, url);
  }
  if (!url.pathname.startsWith("/v1/dev/")) return undefined;
  if (!dependencies.developer && dependencies.linking) return json(await routeLinkingRequest(linkingRouteDependencies(dependencies, dependencies.linking), request, url), request.requestId);
  if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
  const developer = dependencies.developer;
  return await developerRouteResponse(request, url, () => routeDeveloperRequest({
    serverReadSender: { send: (command, options) => dependencies.documentClient.send(command as never, options) },
    ...(developer.companies === undefined ? {} : { companies: developer.companies }),
    ...(core?.lessons === undefined ? {} : { lessons: core.lessons }),
    ...(core?.lessonsSlackSwitch === undefined ? {} : { lessonsSlackSwitch: core.lessonsSlackSwitch }),
    ...(core?.knowledgeSwitch === undefined ? {} : { knowledgeSwitch: core.knowledgeSwitch }),
    ...(core?.knowledge === undefined ? {} : { knowledge: core.knowledge }),
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, tasks,
    ...channelLinkRouteDependencies(dependencies),
    ...clientProjectRouteDependencies(dependencies),
    ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
  }, request, url));
}

function brokerEventHandler(core: AwsBrokerInput["core"], dependencies: AwsBrokerDependencies) {
  // Spec 025: the broker actions the developer task routes call, built once per handler.
  const tasks = developerTaskActions(dependencies);
  const adminReads = adminReadDependencies(dependencies);
  const adminChanges = adminChangeDependencies(dependencies, adminReads);
  const operatorHooks = {
    operatorGithubBindings, brokerLogLine,
    logStderr: (entry: Record<string, unknown>) => { process.stderr.write(`${JSON.stringify(entry)}\n`); },
    operatorEventRefused,
  };
  const slackHooks = {
    brokerLogLine,
    namedInstallTeamView, developerTaskActions, unexpectedErrorAnswer, replyNotSavedAnswer,
    stopSlackThreadTask, authorizeSlackTaskAction, confirmSlackTaskPeople, handleSlackTaskPeople,
    startSlackWorkflow, recordSlackIntake, companySlackCaller, recordSlackThreadNote,
    answerCoreTaskLegacyPress, answerRetiredSlackPress,
    dispatchSlackCorePress: async (slackView: AwsBrokerDependencies, event: unknown) => (isSlackCorePressEvent(event) ? answerSlackCorePress(slackView.developer?.coreTasks, event, (thread, userId) => companySlackCaller(slackView, thread, userId)) : undefined),
  };
  const preAuthHooks = {
    routeGithubWebhook, handleProjectSetupCallback, handleProjectSetupExecutionRead,
    handleProjectSetupEvidenceInit, handleProjectSetupEvidenceChunk, handleProjectSetupEvidenceFinalize,
  };
  const adminHooks = {
    adminChanges, adminReads, tasks,
    retryProjectSetupAsAdministrator,
    routeSetupProposal, routeSetupApproval, registerProject, adminModelChecks,
    prepareWorkspace, putSlackBinding, deleteSlackBinding, cancelWorkspaceTask,
    adminTaskShareMode,
  };
  return async (event: HttpApiV2Event | SlackWorkspaceOperatorEvent | SlackStopTaskEvent | SlackTaskAuthorizationEvent | SlackTaskPeopleConfirmEvent | SlackTaskPeopleReadEvent | SlackTaskPeopleChangeEvent | SlackTaskPeopleTakeOwnershipEvent | SlackWorkflowStartEvent | SlackWorkflowDecisionEvent | SlackWorkflowRetryEvent | SlackWorkflowReviewRetryEvent | SlackWorkflowSendBackEvent | SlackWorkflowResolveFindingsEvent | SlackWorkflowCloseEvent | AdminChangePressEvent | { source: "agentx.github-webhook-recovery" } | { source: "agentx.github-binding-backfill"; continuation?: number } | { source: "agentx.github-binding-claim"; installationId: number; companyId: string } | { source: "agentx.workflow-dispatch-recovery" } | { source: "agentx.workflow-merge-recovery" }, context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number }): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    const coreOrOperator = await dispatchCoreAndOperatorEvent(core, dependencies, adminChanges, event, context, operatorHooks);
    if (coreOrOperator !== undefined) return coreOrOperator;
    const slackIngress = await dispatchSlackIngressEvent(dependencies, tasks, event, context?.awsRequestId, slackHooks);
    if (slackIngress !== undefined) return slackIngress;
    const request = adaptHttpApiEvent(event as HttpApiV2Event);
    try {
      // Checked on the raw path, before URL parsing normalizes it (D17).
      if (DOT_SEGMENT.test((event as HttpApiV2Event).rawPath ?? "/")) throw agentXError("NOT_FOUND", "route not found");
      const url = new URL(request.path, "https://agentx.invalid");
      const routeKey = (event as HttpApiV2Event).routeKey;
      if (routeKey === FEEDBACK_REVIEW_ROUTE_KEY) return await dispatchReviewHttpRoute(core, dependencies, tasks, request, url);
      if (routeKey === DEVELOPER_ROUTE_KEY && !url.pathname.startsWith("/v1/dev/")) throw agentXError("NOT_FOUND", "route not found");
      if (routeKey === CORE_APP_ROUTE_KEY && !url.pathname.startsWith("/v1/app/")) throw agentXError("NOT_FOUND", "route not found");
      const handled = await dispatchPreAuthHttpRoute(dependencies, request, url, preAuthHooks)
        ?? await dispatchWorkerInternalHttpRoute(core, dependencies, request, url)
        ?? await dispatchDevAndAppHttpRoute(core, dependencies, tasks, routeKey, request, url);
      if (handled !== undefined) return handled;
      const identity = identityFromJwtClaims(request.jwtClaims, {
        issuer: dependencies.issuer,
        adminClaim: dependencies.adminClaim,
        adminValues: dependencies.adminValues,
      });
      return await dispatchAdminHttpRoute(dependencies, identity, request, url, adminHooks);
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
const SLACK_REFUSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the presser hears when their press could not be saved for a reason AgentX did not expect. */
const SLACK_PRESS_NOT_SAVED = "I couldn't save that. Try again.";

/**
 * D1 ruling (a): the answer to a press of an old workflow card (handed over asynchronously by the interactivity). Told to the presser privately, with a stable code, in the words of
 * slack-retired-buttons.ts; nothing about the task is read or written. 200 `{ refused: true }`: never an error that Slack would show as a failed save. In company mode a presser who is not
 * signed in to Rovara hears the sign-in notice, as before.
 */
/** The words a refused Stop press hears (what the old Slack workflow said to a person who is not the task's owner). */
const SLACK_STOP_NOT_OWNER_WORDS = "Only the task owner can do that.";

function corePressRefusalMessage(error: AgentXError): string | undefined {
  if (error.code === "FORBIDDEN") return SLACK_STOP_NOT_OWNER_WORDS;
  if (error.code === "TASK_NOT_FOUND") return "This task can't be changed from Slack. Continue it where it was started, or start a new request.";
  if (error.code === "NOT_FOUND" && error.message.includes(NOT_ON_THE_CORE_YET)) return "This action is not available on this install yet.";
  if (error.code === "WORKSPACE_BUSY" || error.code === "TASK_BUSY") return "AgentX is still working on the previous step. Try again when it posts.";
  if (error.code === "CONFIG_INVALID" || error.code === "IDEMPOTENCY_CONFLICT") return WORKFLOW_BUTTON_OUT_OF_DATE;
  return undefined;
}

async function handleCoreTaskLegacyPressError(
  dependencies: AwsBrokerDependencies,
  event: { taskId: string; userId: string; thread: SlackThread; requestId: string },
  attemptId: string,
  error: unknown,
  refuse: (message: string) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  if (error instanceof AgentXError) {
    const message = corePressRefusalMessage(error);
    console.log(JSON.stringify({ component: "broker", event: "slack.core_press_refused", taskId: event.taskId, requestId: event.requestId, errorCode: error.code }));
    if (message !== undefined) return await refuse(message);
    await recordRetiredSlackButtonNote(dependencies, event, attemptId, undefined, SLACK_PRESS_NOT_SAVED, false);
    return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode >= 500 ? error.statusCode : 500);
  }
  console.log(JSON.stringify({ component: "broker", event: "slack.core_press_failed", taskId: event.taskId, requestId: event.requestId, errorName: error instanceof Error ? error.name : "unknown" }));
  await recordRetiredSlackButtonNote(dependencies, event, attemptId, undefined, SLACK_PRESS_NOT_SAVED, false);
  const answer = unexpectedErrorAnswer(error, "slack-ingress");
  return answer.statusCode >= 500 ? answer : { ...answer, statusCode: 500 };
}

async function verifyCompanySlackPressAccess(
  dependencies: AwsBrokerDependencies,
  event: { thread: SlackThread; userId: string },
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
  if (dependencies.workspaces === undefined) return undefined;
  try { await companySlackCaller(dependencies, event.thread, event.userId); return undefined; }
  catch { return json({ refused: true, message: SLACK_WEB_SIGNIN_NOTICE }, "slack-ingress"); }
}

/**
 * A legacy-event press (the invoke path, used where the channel path is off) whose task carries the core's mark, answered as it was before D1: the Stop button is the core's own stop, Keep the pull
 * request is the core's Keep route, as the pressing person; every other of the ten buttons was refused for a core task ("Only the task owner can do that.") and still is. `undefined`: the task has
 * no core mark, so the press is an old workflow card's and gets the retired-button answer.
 */
async function answerCoreTaskLegacyPress(
  dependencies: AwsBrokerDependencies,
  event: { taskId: string; userId: string; thread: SlackThread; requestId: string; action?: string; stop?: true; expectedRevision?: number },
  awsRequestId: string | undefined,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
  if (dependencies.developer === undefined || !await isCoreTask(dependencies, event.taskId)) return undefined;
  const signInNotice = await verifyCompanySlackPressAccess(dependencies, event);
  if (signInNotice !== undefined) return signInNotice;
  const attemptId = awsRequestId !== undefined && SLACK_REFUSAL_ID.test(awsRequestId) ? awsRequestId : randomUUID();
  const refuse = async (message: string) => { await recordRetiredSlackButtonNote(dependencies, event, attemptId, undefined, message, false); return json({ refused: true, message }, "slack-ingress"); };
  const callerOf = async () => {
    const thread = SlackThreadSchema.parse(event.thread);
    if (!await slackWorkspaceEnabled(dependencies, thread)) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
    return await companySlackCaller(dependencies, thread, SlackRequesterSchema.shape.userId.parse(event.userId));
  };
  try {
    if (event.action === "workflow-close" && event.stop === true) {
      const stopped = await coreStopButton(dependencies, dependencies.developer.coreTasks, { taskId: event.taskId, stop: true }, callerOf);
      return stopped === undefined ? undefined : json(stopped, "slack-ingress");
    }
    if (event.action === "workflow-keep-pull-requests") {
      const kept = await coreKeepPullRequests(dependencies, dependencies.developer.coreTasks, { taskId: event.taskId, requestId: event.requestId, expectedRevision: event.expectedRevision ?? 0 }, callerOf);
      return kept === undefined ? undefined : json(kept, "slack-ingress");
    }
    // The other eight buttons: a core task was never served by these events (its cards act through the channel path); the refusal is the one it always got.
    return await refuse(SLACK_STOP_NOT_OWNER_WORDS);
  } catch (error) {
    return await handleCoreTaskLegacyPressError(dependencies, event, attemptId, error, refuse);
  }
}

async function answerRetiredSlackPress(
  dependencies: AwsBrokerDependencies,
  event: { taskId: string; userId: string; thread: SlackThread; requestId: string },
  awsRequestId: string | undefined,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  if (dependencies.workspaces !== undefined) {
    try { await companySlackCaller(dependencies, event.thread, event.userId); }
    catch { return json({ refused: true, message: SLACK_WEB_SIGNIN_NOTICE }, "slack-ingress"); }
  }
  // Without an invoke's own request ID (a direct call), each answer is its own attempt.
  const attemptId = awsRequestId !== undefined && SLACK_REFUSAL_ID.test(awsRequestId) ? awsRequestId : randomUUID();
  console.log(JSON.stringify({ component: "broker", event: "slack.retired_button_pressed", taskId: event.taskId, requestId: event.requestId }));
  await recordRetiredSlackButtonNote(dependencies, event, attemptId);
  return json(RETIRED_SLACK_BUTTON_ANSWER, "slack-ingress");
}


/** A Slack thread reply that could not be saved: logged by task, event and error name only (never the text), answered 503 so Slack retries it. */
function replyNotSavedAnswer(error: unknown, event: { taskId: string; eventId: string }): { statusCode: number; headers: Record<string, string>; body: string } {
  const at = thrownAt(error);
  console.log(JSON.stringify({ component: "broker", event: "slack.thread_reply_not_saved", taskId: event.taskId, eventId: event.eventId,
    name: error instanceof Error ? error.name : "unknown", ...(at === undefined ? {} : { at }) }));
  return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "the reply could not be saved; Slack will retry it" } }, "slack-ingress", 503);
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

function matchesConnectorVerb(method: string, action: string | undefined): boolean {
  return (method === "GET" && action === "tools") || (method === "POST" && action === "call");
}

async function handleWorkspaceGitHubMcpRoute(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  body: unknown,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  // Feature 007 shapes, kept for Slack services from before feature 013.
  const { workspace, project, github } = await authorizeGitHubConnector(dependencies, identity, workspaceId);
  if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
  const parsed = request.method === "POST" ? GitHubMcpRequestSchema.safeParse(body) : undefined;
  if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid GitHub MCP request");
  const repositoryName = parsed?.success ? parsed.data.repository : url.searchParams.get("repository");
  const repository = github.repositories.find((entry) => entry.name === repositoryName);
  if (!repository) throw agentXError("NOT_FOUND", "registered repository not found");
  await requireGithubProjectBinding(dependencies, project, repository.url);
  const revision = project.definition.revision;
  if (!parsed?.success) {
    const types = dependencies.connectorTypes ?? BUILT_IN_CONNECTOR_TYPES;
    const discovery = await discoverLegacyGitHubScope({
      connectors: resolveConnectors(project.definition, connectorTypeContext(dependencies, project), types),
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

async function handleWorkspaceConnectorRoute(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  connectorName: string,
  body: unknown,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const { workspace, project } = await authorizeWorkspaceConnectors(dependencies, identity, workspaceId);
  const connector = resolveConnectors(project.definition, connectorTypeContext(dependencies, project), dependencies.connectorTypes)
    .find((entry) => entry.name === connectorName);
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

async function routeWorkspaceResourceRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
  body: unknown,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
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
    return json({ conversation: await createConversation(dependencies, identity, conversations[1]) }, request.requestId, 201);
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
    return json(await acceptPullRequestLifecycle(dependencies, identity, pullRequestActions[1], body, channelOperation(dependencies, identity)), request.requestId, 202);
  }
  return undefined;
}

async function routeWorkspaceOperationRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string } | undefined> {
  const operation = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && operation?.[1] && operation[2]) {
    return json({ operation: await getAuthorizedOperation(dependencies, identity, operation[1], operation[2]) }, request.requestId);
  }
  const events = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/events$/.exec(url.pathname);
  if (request.method === "GET" && events?.[1] && events[2]) {
    return json(
      await pageEvents(dependencies, identity, events[1], events[2], {
        limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
        ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
      }),
      request.requestId,
    );
  }
  const artifact = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifact?.[1] && artifact[2]) {
    return json({ artifact: await getArtifact(dependencies, identity, artifact[1], artifact[2]) }, request.requestId);
  }
  const cancel = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel?.[1] && cancel[2]) {
    return json(await acceptCancellation(dependencies, identity, cancel[1], cancel[2]), request.requestId, 202);
  }
  return undefined;
}

async function routeWorkspaceRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const body = parseBody(request.body);
  const githubMcp = /^\/v1\/workspaces\/([0-9a-f-]+)\/github\/(tools|call)$/.exec(url.pathname);
  if (githubMcp?.[1] && matchesConnectorVerb(request.method, githubMcp[2])) {
    return await handleWorkspaceGitHubMcpRoute(dependencies, request, url, identity, githubMcp[1], body);
  }
  const connectorRoute = /^\/v1\/workspaces\/([0-9a-f-]+)\/connectors\/([a-z][a-z0-9-]{0,19})\/(tools|call)$/.exec(url.pathname);
  if (connectorRoute?.[1] && connectorRoute[2] && matchesConnectorVerb(request.method, connectorRoute[3])) {
    return await handleWorkspaceConnectorRoute(dependencies, request, url, identity, connectorRoute[1], connectorRoute[2], body);
  }
  const resource = await routeWorkspaceResourceRequest(dependencies, request, url, identity, body);
  if (resource !== undefined) return resource;
  const operation = await routeWorkspaceOperationRequest(dependencies, request, url, identity);
  if (operation !== undefined) return operation;
  throw agentXError("NOT_FOUND", "route not found");
}

/** Workspace ownership, channel binding and membership, then the project's latest revision, which configures at least one connector. */
async function authorizeWorkspaceConnectors(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  if (identity.slack && identity.slack.binding.projectName !== workspace.projectName) throw agentXError("FORBIDDEN", "Slack channel is no longer bound to this project");
  if (identity.channel && identity.channel.projectName !== workspace.projectName) throw agentXError("FORBIDDEN", "this space is no longer bound to the workspace's project");
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  // The policy and the scopes it may address come from the project's latest registered revision,
  // so enabling, narrowing or revoking a tool reaches an existing thread at once.
  const project = slackThreadOwnRow(identity, await requireLatestProject(dependencies, workspace.projectName));
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

function connectorTypeContext(dependencies: AwsBrokerDependencies, project?: RegisteredProjectRecord): ConnectorTypeContext {
  const githubMcp = dependencies.githubMcp === undefined || project === undefined || dependencies.githubBindings === undefined
    ? dependencies.githubMcp
    : { ...dependencies.githubMcp, credentials: async (repository: { url: string; credentialRef: string }, access: "read" | "write") => {
      await requireGithubProjectBinding(dependencies, project, repository.url);
      return dependencies.githubMcp!.credentials(repository, access);
    } };
  return {
    ...(githubMcp ? { githubMcp } : {}),
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
  if (connector.attribution && identity.channel) return `Requested by ${inertName(identity.channel.developer.name)} via AgentX · ${identity.channel.ref.channel}`;
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
function parseRegistrationInput(value: unknown): { definition: ProjectDefinition; runtimeBinding: ReturnType<typeof parseRuntimeBinding>; wantsPreflight: boolean; setupApproval?: { proposalRef: string; proposalSha256: string; decision: "approve" | "decline" }; takeover?: { reason: string } } {
  const input = object(value, "project registration");
  const retired = legacyProjectFields(input.definition);
  if (retired.length > 0) {
    throw agentXError("CONFIG_INVALID", `project definition must not contain ${retired.join(", ")}; remove them and register again`);
  }
  const definition = ProjectDefinitionSchema.parse(input.definition);
  const runtimeBinding = parseRuntimeBinding(input.runtimeBinding);
  const setupApproval = input.setupApproval === undefined ? undefined : z.object({
    proposalRef: z.string().min(1).max(512), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "decline"]),
  }).strict().parse(input.setupApproval);
  // Task AUTH1: taking over a project is an explicit request with a reason, never implied by a reason alone and never by anything but the boolean `true`.
  if (input.takeOwnership !== undefined && typeof input.takeOwnership !== "boolean") {
    throw agentXError("CONFIG_INVALID", "takeOwnership must be true or false");
  }
  let takeover: { reason: string } | undefined;
  if (input.takeOwnership === true) {
    const reason = typeof input.takeOwnershipReason === "string" ? input.takeOwnershipReason.trim() : "";
    if (reason === "" || reason.length > TAKEOVER_REASON_MAX) {
      throw agentXError("CONFIG_INVALID", `taking over a project needs a takeOwnershipReason of 1 to ${TAKEOVER_REASON_MAX} characters, recorded with who took it over and when`);
    }
    takeover = { reason };
  }
  // Preflight contacts the vendor, so it runs only when the caller asks; older clients never do.
  return { definition, runtimeBinding, wantsPreflight: input.preflight === true, ...(setupApproval === undefined ? {} : { setupApproval }), ...(takeover === undefined ? {} : { takeover }) };
}

const TAKEOVER_REASON_MAX = 500;

/** Missing membership wiring cannot turn on the legacy path when bindings are enabled. */
async function githubCallerCompany(dependencies: AwsBrokerDependencies, personId: string, budget: ReturnType<typeof boundedCompanyReads>) {
  if (dependencies.githubBindings === undefined) return undefined;
  if (personId === "") throw agentXError("AUTH_REQUIRED", "your AgentX sign-in has ended; run agentx login <url> again");
  return budget.read(() => resolveCompany(dependencies.companies ?? { companyOf: async () => undefined }, personId));
}

async function checkRegistrationCompany(dependencies: AwsBrokerDependencies, name: string, companyId: string | undefined, budget: ReturnType<typeof boundedCompanyReads>) {
  // DEC 254zzz80: a named company registers in its own partition; this legacy check stays for it too, so an id another company (or the built-in one) holds in the install's
  // rows is still refused: project ids stay unique against the legacy namespace.
  if (companyId === undefined) return;
  const response = await budget.client.send(new QueryCommand({ TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)", ExpressionAttributeValues: { ":pk": `PROJECT#${name}`, ":revision": "REV#" },
    ScanIndexForward: false, Limit: 1, ConsistentRead: true })) as { Items?: unknown[] };
  if (response.Items?.[0] !== undefined && !recordInCompany(response.Items[0], companyId)) throw agentXError("NOT_FOUND", "registered project not found");
}

async function checkCompanyRepository(dependencies: AwsBrokerDependencies, companyId: string | undefined, url: string, budget: ReturnType<typeof boundedCompanyReads>) {
  if (dependencies.githubBindings === undefined) return;
  const repository = parseGitHubRepository(url);
  try {
    if (companyId === undefined || dependencies.githubPullRequests.installationIdFor === undefined) throw githubBindingRefusal();
    const installationId = await budget.read(() => dependencies.githubPullRequests.installationIdFor!(url));
    await dependencies.githubBindings.withBudget(budget).requireBound(companyId, installationId);
  } catch (error) {
    if (isGithubDisconnected(error)) throw githubDisconnectedRefusal();
    throw agentXError("CONFIG_INVALID", `the GitHub App cannot access ${repository.owner}/${repository.name}; install it on ${repository.owner} with access to that repository`);
  }
}

/** Registration's refusals and preflight, for a new revision; registerProject and a change plan share them. */
async function registrationChecks(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, definition: ProjectDefinition, wantsPreflight: boolean, scoped?: { companyId: string | undefined; budget: ReturnType<typeof boundedCompanyReads> }): Promise<PreflightOutcome | undefined> {
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
  const companyBudget = scoped?.budget ?? boundedCompanyReads(dependencies.documentClient);
  const companyId = scoped === undefined ? await githubCallerCompany(dependencies, identity.developer?.developerId ?? "", companyBudget) : scoped.companyId;
  await checkRegistrationCompany(dependencies, definition.name, companyId, companyBudget);
  for (const repository of definition.repositories) {
    await checkCompanyRepository(dependencies, companyId, repository.url, companyBudget);
    await dependencies.checkRepositoryAccess?.(repository);
  }
  if (!wantsPreflight) return undefined;
  const result = await preflightConnectors(connectors(), definition, identity.ownerKey);
  if (result.refusals.length > 0) throw agentXError("CONFIG_INVALID", result.refusals.join("; "));
  return { report: result.report, warnings: result.warnings };
}

async function resolveSetupRuntimeAdmission(
  dependencies: AwsBrokerDependencies,
  runtimeBinding: RegisteredProjectRecord["runtimeBinding"],
): Promise<ReturnType<typeof admitProjectSetupRuntime>> {
  if (!dependencies.projectSetupRuntimeCatalogId || runtimeBinding.deploymentMode !== "ec2-ebs") return undefined;
  const bindingDigest = projectSetupBindingDigest(runtimeBinding);
  const runtimeKey = projectSetupRuntimeKey(dependencies.projectSetupRuntimeCatalogId, bindingDigest);
  const catalogItem = await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: runtimeKey,
    ConsistentRead: true,
  }));
  const parsedCatalog = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(catalogItem.Item, runtimeKey));
  if (!parsedCatalog.success) return undefined;
  return admitProjectSetupRuntime(parsedCatalog.data, {
    runtimeCatalogId: dependencies.projectSetupRuntimeCatalogId, binding: runtimeBinding,
    scope: "source-interface", now: Date.now(),
  });
}

function assertSetupApprovalMatchesDefinition(
  definition: ProjectDefinition,
  setupApproval: NonNullable<ReturnType<typeof parseRegistrationInput>["setupApproval"]>,
  approval: Record<string, unknown>,
): void {
  const repository = definition.repositories[0];
  const mapping = approval.identityMapping;
  if (!repository || !mapping || typeof mapping !== "object" || Array.isArray(mapping)
    || (mapping as Record<string, unknown>).registeredRepositoryId !== repository.name
    || typeof approval.repositoryUrl !== "string" || approval.repositoryUrl.toLowerCase() !== repository.url.toLowerCase()) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "registered repository identity does not match the source-backed setup decision");
  }
  if (setupApproval.decision === "approve") {
    if (definition.e2e === undefined || !sameJsonContent(definition.e2e, approval.policy)) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "E2E policy does not match the approved source-backed setup proposal");
    }
  } else if (definition.e2e !== undefined) {
    throw agentXError("FORBIDDEN", "declined setup decision cannot register an E2E policy");
  }
}

async function resolveRegistrationSetupApproval(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  definition: ProjectDefinition,
  runtimeBinding: RegisteredProjectRecord["runtimeBinding"],
  setupApproval: ReturnType<typeof parseRegistrationInput>["setupApproval"],
): Promise<{
  setupApprovalBinding: RegisteredProjectRecord["setupApproval"];
  setupApprovedAt: string;
  setupRuntimeAdmission: ReturnType<typeof admitProjectSetupRuntime>;
}> {
  if (definition.e2e === undefined && setupApproval === undefined) {
    return { setupApprovalBinding: undefined, setupApprovedAt: "", setupRuntimeAdmission: undefined };
  }
  if (setupApproval === undefined) throw agentXError("FORBIDDEN", "E2E project registration requires a stored source-backed setup decision");
  const expectedProposalPrefix = `project-setup-proposals/${identity.ownerKey}/`;
  if (!setupApproval.proposalRef.startsWith(expectedProposalPrefix) || setupApproval.proposalRef !== `${expectedProposalPrefix}${setupApproval.proposalSha256}.json`) {
    throw agentXError("FORBIDDEN", "setup approval reference is outside the authenticated administrator scope");
  }
  const approval = await getItem<Record<string, unknown>>(dependencies, { pk: `PROJECT_SETUP#${definition.name}`, sk: `PROPOSAL#${setupApproval.proposalSha256}` });
  if (!approval || approval.ownerKey !== identity.ownerKey || approval.proposalRef !== setupApproval.proposalRef || approval.decision !== setupApproval.decision) {
    throw agentXError("FORBIDDEN", "setup decision is missing, stale, or belongs to another administrator");
  }
  assertSetupApprovalMatchesDefinition(definition, setupApproval, approval);
  const setupApprovalBinding: RegisteredProjectRecord["setupApproval"] = {
    proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256,
    candidateDigest: String(approval.candidateDigest), decision: setupApproval.decision,
  };
  const setupApprovedAt = typeof approval.approvedAt === "string" ? approval.approvedAt : "";
  const setupRuntimeAdmission = setupApproval.decision === "approve" && definition.e2e !== undefined
    ? await resolveSetupRuntimeAdmission(dependencies, runtimeBinding)
    : undefined;
  return { setupApprovalBinding, setupApprovedAt, setupRuntimeAdmission };
}

async function readRegistrationAccountSetup(
  dependencies: AwsBrokerDependencies,
  record: RegisteredProjectRecord,
  definition: ProjectDefinition,
  setupApprovalBinding: RegisteredProjectRecord["setupApproval"],
  setupApprovedAt: string,
): Promise<{ snapshot: E2ESourceSnapshot; approvedAt: string; proposalSha256: string } | undefined> {
  // Owner decision D5 (Task 3.1): registering the setup is the step that makes it effective, so it registers the project's synthetic test accounts too, in the transaction
  // that stores the revision. The setup is the one this registration binds (the registering administrator's own approved proposal for this project), never another.
  if (setupApprovalBinding?.decision !== "approve" || definition.e2e === undefined || setupApprovedAt === "") return undefined;
  const repository = definition.repositories[0]!;
  const repositoryParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repository.url);
  const setup = await readApprovedSetupSource(dependencies, record, E2EPolicySchema.parse(definition.e2e), repository,
    repositoryParts?.[1] && repositoryParts[2] ? `${repositoryParts[1]}/${repositoryParts[2]}` : undefined);
  if (!setup.ok) throw agentXError("PROJECT_REVISION_MISMATCH", `the approved setup could not be read to register the project's test accounts: ${setup.reason}`);
  return { snapshot: setup.snapshot, approvedAt: setupApprovedAt, proposalSha256: setupApprovalBinding.proposalSha256 };
}

function assertImmutableProjectMatch(
  stored: RegisteredProjectRecord,
  inCompany: (row: unknown) => boolean,
  definition: ProjectDefinition,
  runtimeBinding: RegisteredProjectRecord["runtimeBinding"],
  setupApprovalBinding: RegisteredProjectRecord["setupApproval"],
): void {
  if (!inCompany(stored)) throw agentXError("NOT_FOUND", "registered project not found");
  // The stored revision is read back from DynamoDB, which keeps no map's attribute order: compare content, not text.
  if (!sameJsonContent(stored.definition, definition) || !sameJsonContent(stored.runtimeBinding, runtimeBinding) || !sameJsonContent(stored.setupApproval, setupApprovalBinding)) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revisions and runtime bindings are immutable");
  }
}

function resolveRegistrationAttemptCompany(
  record: RegisteredProjectRecord,
  snapshot: Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>,
  companyId: string | undefined,
): void {
  // Ownership may be carried forward only from the stored legacy revision (or the checked membership already used above).
  const storedCompany = snapshot.newest?.companyId;
  if (storedCompany !== undefined) {
    if (!OrgIdSchema.safeParse(storedCompany).success || (record.companyId !== undefined && storedCompany !== record.companyId)) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "core project ownership conflict");
    }
    record.companyId = storedCompany;
  } else if (record.companyId !== undefined && companyId === undefined) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "core project ownership conflict");
  }
}

function registrationCatalogUpdateItem(
  dependencies: AwsBrokerDependencies,
  ownCompany: OrgId | undefined,
  projectName: string,
  latestRevision: number,
  now: string,
  incarnationRevision: number,
  snapshot: Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>,
): TransactItems[number] {
  const condition = snapshot.catalog === undefined ? "attribute_not_exists(pk)"
    : snapshot.catalog.latestRevision === undefined ? "attribute_not_exists(latestRevision)"
      : "latestRevision = :observed AND latestRevision < :revision";
  const updateExpression = ownCompany !== undefined
    ? "SET entityType = :entity, #name = :name, companyId = :company, incarnationRevision = :incarnation, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)"
    : "SET entityType = :entity, #name = :name, incarnationRevision = :incarnation, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)";
  return { Update: {
    TableName: dependencies.tableName,
    Key: ownCompany !== undefined ? orgProjectCatalogKey(ownCompany, projectName) : projectCatalogKey(projectName),
    UpdateExpression: updateExpression,
    ConditionExpression: condition,
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: {
      ":entity": "PROJECT_CATALOG", ":name": projectName, ":revision": latestRevision, ":now": now,
      ":incarnation": incarnationRevision,
      ...(ownCompany === undefined ? {} : { ":company": ownCompany }),
      ...(snapshot.catalog?.latestRevision === undefined ? {} : { ":observed": snapshot.catalog.latestRevision }),
    },
  } };
}

function registrationAuthorityItems(
  tableName: string,
  authority: "first" | "administrator" | "takeover",
  identity: AuthenticatedIdentity,
  definition: ProjectDefinition,
  grantCompanyId: OrgId | undefined,
  takeover: ReturnType<typeof parseRegistrationInput>["takeover"],
  now: string,
): TransactItems {
  // DEC 254zzz98: the grant this attempt reads and writes is beside the revision (grantCompanyId, from the revision key's company).
  const membership = membershipRecord(identity.ownerKey, definition.name, "administrator", grantCompanyId);
  const membershipKey = grantKeyFor(grantCompanyId, identity.ownerKey, definition.name);
  // A first registration and a takeover write the registrant's administrator membership; an administrator's own is left as it is (its grant is not reissued)
  // but must still hold when the revision commits.
  const grantItems: TransactItems = authority === "administrator"
    ? [{ ConditionCheck: { TableName: tableName, Key: membershipKey, ConditionExpression: "#role = :administrator",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":administrator": "administrator" } } }]
    : [{ Put: { TableName: tableName, Item: membership } },
      // Spec 065: the project's side of the membership, so its members can be listed.
      { Put: { TableName: tableName, Item: { ...projectMemberKey(definition.name, identity.ownerKey, grantCompanyId), entityType: "PROJECT_MEMBER", role: "administrator", grantedAt: now } } }];
  if (authority !== "takeover" || takeover === undefined) return grantItems;
  return [...grantItems, { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
    pk: `PROJECT_TAKEOVER#${definition.name}`, sk: `AT#${now}#${randomUUID()}`, entityType: "PROJECT_OWNERSHIP_TAKEOVER",
    projectName: definition.name, revision: definition.revision, takenBy: identity.ownerKey, subject: identity.subject, reason: takeover.reason, at: now,
  } } }];
}

async function handleRegistrationCommitConflict(
  dependencies: AwsBrokerDependencies,
  error: unknown,
  context: {
    key: { pk: string; sk: string };
    inCompany: (row: unknown) => boolean;
    definition: ProjectDefinition;
    runtimeBinding: RegisteredProjectRecord["runtimeBinding"];
    setupApprovalBinding: RegisteredProjectRecord["setupApproval"];
    repairCatalogPointerFromHistory: () => Promise<void>;
    readCatalogSnapshot: () => Promise<Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>>;
    snapshot: Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>;
    accountSetup: { snapshot: E2ESourceSnapshot; approvedAt: string; proposalSha256: string } | undefined;
    planAccounts: () => Promise<{ items: TransactItems; written: number; planKey: string }>;
    accountsPlanKey: string;
    judgeAuthority: (newestRevision: number) => Promise<"first" | "administrator" | "takeover">;
    authority: "first" | "administrator" | "takeover";
    isLastAttempt: boolean;
  },
): Promise<RegisteredProjectRecord | undefined> {
  await rethrowAsDeferredIfHeld(dependencies, error, Date.now()); // AUTOREQUALIFY: the start fence refused the setup run: say so, not "catalog conflict"
  if (!isConditional(error)) throw error;
  // A same-revision registration may have won concurrently. Validate the immutable record and
  // catalog before returning duplicate success; otherwise retry only a catalog/history advance.
  const winner = await getItem<RegisteredProjectRecord>(dependencies, context.key);
  if (winner !== undefined) {
    assertImmutableProjectMatch(winner, context.inCompany, context.definition, context.runtimeBinding, context.setupApprovalBinding);
    await context.repairCatalogPointerFromHistory();
    return winner;
  }
  const refreshed = await context.readCatalogSnapshot();
  const advanced = refreshed.newestRevision > context.snapshot.newestRevision
    || (refreshed.catalog?.latestRevision ?? 0) > (context.snapshot.catalog?.latestRevision ?? 0);
  // Another registration may have moved an account under this one: plan again (a stale setup is refused then) rather than give up.
  const accountsMoved = context.accountSetup !== undefined && (await context.planAccounts()).planKey !== context.accountsPlanKey;
  // The registrant's standing may have changed under this attempt (the membership removed or downgraded outside the API, the project registered by a rival): refused here, not as a catalog conflict.
  const authorityMoved = (await context.judgeAuthority(refreshed.newestRevision)) !== context.authority;
  if ((!advanced && !accountsMoved && !authorityMoved) || context.isLastAttempt) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project revision registration could not commit against the current catalog");
  }
  return undefined;
}

async function commitProjectRegistration(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  context: {
    key: { pk: string; sk: string };
    record: RegisteredProjectRecord;
    definition: ProjectDefinition;
    runtimeBinding: RegisteredProjectRecord["runtimeBinding"];
    setupApprovalBinding: RegisteredProjectRecord["setupApproval"];
    takeover: ReturnType<typeof parseRegistrationInput>["takeover"];
    companyId: string | undefined;
    ownCompany: OrgId | undefined;
    grantCompanyId: OrgId | undefined;
    companyBudget: ReturnType<typeof boundedCompanyReads>;
    now: string;
    inCompany: (row: unknown) => boolean;
    readCatalogSnapshot: () => Promise<Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>>;
    repairCatalogPointerFromHistory: () => Promise<void>;
    judgeAuthority: (newestRevision: number) => Promise<"first" | "administrator" | "takeover">;
    setupAdmissionRows: { transactionItems: Array<Record<string, unknown>> } | undefined;
    accountSetup: { snapshot: E2ESourceSnapshot; approvedAt: string; proposalSha256: string } | undefined;
    planAccounts: () => Promise<{ items: TransactItems; written: number; planKey: string }>;
    nameClaimWrites: TransactItems;
  },
): Promise<{ project: Omit<RegisteredProjectRecord, "pk" | "sk">; duplicate: boolean; ownershipTakenOver: boolean }> {
  const maxRegistrationAttempts = 3;
  for (let attempt = 0; attempt < maxRegistrationAttempts; attempt += 1) {
    const snapshot = await context.readCatalogSnapshot();
    const latestRevision = Math.max(context.definition.revision, snapshot.newestRevision);
    const updateCatalog = snapshot.catalog?.latestRevision !== latestRevision;
    resolveRegistrationAttemptCompany(context.record, snapshot, context.companyId);
    // An existing project changes (its test accounts included) only at the hand of one of its administrators, or of an instance administrator who takes it over explicitly.
    // Judged against the project as it is on this attempt: an administrator who raced a first registration and lost finds the project there on the next one.
    const authority = await context.judgeAuthority(snapshot.newestRevision);
    const accounts = await context.planAccounts();
    let corePlan: Awaited<ReturnType<typeof planCoreProjectWrites>>;
    try {
      corePlan = await planRegistrationCoreWrites({ tableName: dependencies.tableName, documentClient: context.companyBudget.client }, context.ownCompany, context.record, snapshot);
    } catch {
      throw agentXError("PROJECT_REVISION_MISMATCH", await coreCopyRefusalWords({ tableName: dependencies.tableName, documentClient: context.companyBudget.client }, context.record.companyId, context.definition.name));
    }
    // One transaction holds at most 100 items; the project revision, its membership, the catalog and the setup admission take the rest.
    if (accounts.items.length > 60) throw agentXError("CONFIG_INVALID", "the setup declares more synthetic test accounts than one registration can store");
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: dependencies.tableName, Item: context.record, ConditionExpression: "attribute_not_exists(pk)" } },
        ...registrationAuthorityItems(dependencies.tableName, authority, identity, context.definition, context.grantCompanyId, context.takeover, context.now),
        // Spec 025 A3: the admin project list reads this row instead of scanning the table.
        ...(updateCatalog ? [registrationCatalogUpdateItem(dependencies, context.ownCompany, context.definition.name, latestRevision, context.now, corePlan.incarnationRevision, snapshot)] : []),
        ...(context.setupAdmissionRows?.transactionItems ?? []),
        ...accounts.items,
        ...corePlan.writes, ...context.nameClaimWrites,
      ] }));
      const ownershipTakenOver = authority === "takeover";
      if (ownershipTakenOver) {
        console.log(JSON.stringify({ component: "broker", event: "project.ownership_taken_over", project: context.definition.name, revision: context.definition.revision, takenBy: identity.ownerKey }));
      }
      return { project: withoutKeys(context.record), duplicate: false, ownershipTakenOver };
    } catch (error) {
      const winner = await handleRegistrationCommitConflict(dependencies, error, {
        key: context.key, inCompany: context.inCompany, definition: context.definition, runtimeBinding: context.runtimeBinding,
        setupApprovalBinding: context.setupApprovalBinding, repairCatalogPointerFromHistory: context.repairCatalogPointerFromHistory,
        readCatalogSnapshot: context.readCatalogSnapshot, snapshot, accountSetup: context.accountSetup,
        planAccounts: context.planAccounts, accountsPlanKey: accounts.planKey, judgeAuthority: context.judgeAuthority,
        authority, isLastAttempt: attempt + 1 === maxRegistrationAttempts,
      });
      if (winner !== undefined) return { project: withoutKeys(winner), duplicate: true, ownershipTakenOver: false };
    }
  }
  throw agentXError("PROJECT_REVISION_MISMATCH", "project revision registration exceeded its bounded catalog retries");
}

async function handleExistingProjectRegistration(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  existing: RegisteredProjectRecord,
  context: {
    companyId: string | undefined;
    companyBudget: ReturnType<typeof boundedCompanyReads>;
    definition: ProjectDefinition;
    runtimeBinding: RegisteredProjectRecord["runtimeBinding"];
    setupApprovalBinding: RegisteredProjectRecord["setupApproval"];
    wantsPreflight: boolean;
    checkedPreflight: PreflightOutcome | undefined;
    inCompany: (row: unknown) => boolean;
    connectors: () => ResolvedConnector[];
    repairCatalogPointerFromHistory: () => Promise<void>;
  },
): Promise<{ project: Omit<RegisteredProjectRecord, "pk" | "sk">; preflight: PreflightOutcome | undefined }> {
  if (!context.inCompany(existing)) throw agentXError("NOT_FOUND", "registered project not found");
  for (const repository of context.definition.repositories) await checkCompanyRepository(dependencies, context.companyId, repository.url, context.companyBudget);
  assertImmutableProjectMatch(existing, context.inCompany, context.definition, context.runtimeBinding, context.setupApprovalBinding);
  await context.repairCatalogPointerFromHistory();
  // A revision stored before the static checks existed stays idempotent: report, never refuse.
  const preflight = context.checkedPreflight
    ?? (context.wantsPreflight ? await preflightConnectors(context.connectors(), context.definition, identity.ownerKey) : undefined);
  return { project: withoutKeys(existing), preflight };
}

async function registerProject(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
  checked?: { preflight?: PreflightOutcome; githubCompany?: { companyId: string | undefined; budget: ReturnType<typeof boundedCompanyReads> }; nameClaim?: { name: string } },
): Promise<{ project: Omit<RegisteredProjectRecord, "pk" | "sk">; duplicate: boolean; warnings?: string[]; preflight?: RegistrationPreflight }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const { definition, runtimeBinding, wantsPreflight, setupApproval, takeover } = parseRegistrationInput(value);
  const companyBudget = checked?.githubCompany?.budget ?? boundedCompanyReads(dependencies.documentClient);
  const companyId = checked?.githubCompany === undefined ? await githubCallerCompany(dependencies, identity.developer?.developerId ?? "", companyBudget) : checked.githubCompany.companyId;
  // DEC 254zzz80: a named company's revision, catalog pointer and checks live in its own partition (company-layout.ts); the built-in company and no company keep the legacy rows.
  const ownCompany = namedCompany(companyId);
  // The admin setup-approval run (its execution, dispatch and terminal checks) reads only the legacy revision row: a named company's setup goes through the project setup flow instead.
  if (ownCompany !== undefined && (definition.e2e !== undefined || setupApproval !== undefined)) throw agentXError("FORBIDDEN", NAMED_COMPANY_SETUP_APPROVAL_REFUSED);
  /** A stored revision is this registration's company's: by its own partition for a named company (a row there may leave its company out), else by its stored company. */
  const inCompany = (row: unknown) => ownCompany !== undefined ? row !== null && typeof row === "object" && ownPartitionRow(row as Record<string, unknown>, ownCompany) : recordInCompany(row, companyId);
  await checkRegistrationCompany(dependencies, definition.name, companyId, companyBudget);
  const { setupApprovalBinding, setupApprovedAt, setupRuntimeAdmission } = await resolveRegistrationSetupApproval(dependencies, identity, definition, runtimeBinding, setupApproval);
  let setupExecutionCreated = false;
  let ownershipTakenOver = false;
  const budget = toolBudget(approvedToolCount(definition));
  const connectors = () => resolveConnectors(definition, connectorTypeContext(dependencies), dependencies.connectorTypes);
  const respond = (project: Omit<RegisteredProjectRecord, "pk" | "sk">, duplicate: boolean, preflight: PreflightOutcome | undefined) => {
    const warnings = registrationWarnings(budget.warning, preflight);
    return {
      project, duplicate,
      tools: { maximum: budget.maximum, warnAbove: TOOL_WARNING_THRESHOLD, limit: TOOL_LIMIT },
      ...(warnings.length ? { warnings } : {}), ...(preflight ? { preflight: preflight.report } : {}),
      ...(setupApprovalBinding?.decision === "approve" ? { setupRuntime: setupExecutionCreated ? "QUEUED" : "UNAVAILABLE" } : {}),
      ...(ownershipTakenOver ? { ownershipTakenOver: true } : {}),
    };
  };
  /**
   * Task AUTH1 (finding N2b): who may store this revision. The first revision of a project makes its registrant the administrator; a later revision needs the
   * registrant to administer the project already; an instance administrator who does not can take it over only by asking explicitly, with a reason.
   * Judged against the project as it is now, and again on every attempt, so a registrant who lost a race for the first revision is refused on the next one.
   */
  // DEC 254zzz98 (one rule; review L1): the registrant's grant lives where this revision is stored. The revision's key is `revisionKeyFor(companyId, …)`, so the grant's is
  // `grantKeyFor(companyId, …)`: never the company a stamped legacy row names (a registration with no company writes the legacy revision, so its grant is the legacy row).
  const grantCompanyId = grantCompany(dependencies, companyId);
  const judgeAuthority = async (newestRevision: number): Promise<"first" | "administrator" | "takeover"> => {
    await checkRegistrationCompany(dependencies, definition.name, companyId, companyBudget);
    if (newestRevision === 0) return "first";
    const authority = await getItem<{ role?: unknown }>(dependencies, grantKeyFor(grantCompanyId, identity.ownerKey, definition.name));
    if (authority?.role === "administrator") return "administrator";
    if (takeover !== undefined) return "takeover";
    throw agentXError("FORBIDDEN", `only an administrator of project ${definition.name} can register a new revision of it. An instance administrator who is not one can take the project over by asking explicitly: send takeOwnership: true with a takeOwnershipReason (agentx admin project register --take-ownership --ownership-reason <why>); the takeover is recorded`);
  };
  const key = revisionKeyFor(companyId, definition.name, definition.revision);
  const readCatalogSnapshot = () => ownCompany !== undefined ? readNamedCompanyCatalogSnapshot(dependencies, ownCompany, definition.name) : readProjectCatalogSnapshot(dependencies, definition.name);
  const repairCatalogPointerFromHistory = () => ownCompany !== undefined ? repairNamedCompanyCatalogPointer(dependencies, ownCompany, definition.name, definition.revision) : repairProjectCatalogPointerFromHistory(dependencies, definition.name);
  const existing = await getItem<RegisteredProjectRecord>(dependencies, key);
  if (existing) {
    const duplicate = await handleExistingProjectRegistration(dependencies, identity, existing, {
      companyId, companyBudget, definition, runtimeBinding, setupApprovalBinding, wantsPreflight,
      checkedPreflight: checked?.preflight, inCompany, connectors, repairCatalogPointerFromHistory,
    });
    return respond(duplicate.project, true, duplicate.preflight);
  }
  // Refused before any vendor is contacted for a registrant who may not store this revision; the commit judges it again.
  const firstSnapshot = await readCatalogSnapshot();
  await judgeAuthority(firstSnapshot.newestRevision);
  const preflight = await registrationChecks(dependencies, identity, definition, wantsPreflight, { companyId, budget: companyBudget });
  const now = new Date().toISOString(); const nameClaimWrites = checked?.nameClaim === undefined ? [] : companyNameClaimWrites(dependencies.tableName, { companyId, name: checked.nameClaim.name, projectId: definition.name, revision: definition.revision, by: identity.ownerKey, at: now }); // L2-1: in the same transaction
  const record: RegisteredProjectRecord = {
    ...key,
    entityType: "PROJECT",
    ...(companyId === undefined ? {} : { companyId }),
    definition,
    runtimeBinding,
    registeredBy: identity.ownerKey,
    registeredAt: now,
    ...(setupApprovalBinding === undefined ? {} : { setupApproval: setupApprovalBinding }),
  };
  const setupAdmissionRows = setupRuntimeAdmission && setupApprovalBinding?.decision === "approve" && definition.e2e !== undefined
    ? await createProjectSetupAdmissionRows(dependencies, identity, record, setupApprovalBinding, setupRuntimeAdmission)
    : undefined;
  setupExecutionCreated = setupAdmissionRows !== undefined;
  const accountSetup = await readRegistrationAccountSetup(dependencies, record, definition, setupApprovalBinding, setupApprovedAt);
  const planAccounts = async () => {
    if (accountSetup === undefined) return { items: [] as TransactItems, written: 0, planKey: "" };
    try { return await planSetupAccountWrites(dependencies, { orgId: LEGACY_E2E_COMPANY, projectId: definition.name, snapshot: accountSetup.snapshot, setup: accountSetup, now: Date.now() }); }
    catch (error) {
      if (error instanceof E2EAccountRegistryError) throw agentXError("PROJECT_REVISION_MISMATCH", error.message);
      throw error;
    }
  };
  const committed = await commitProjectRegistration(dependencies, identity, {
    key, record, definition, runtimeBinding, setupApprovalBinding, takeover, companyId, ownCompany, grantCompanyId,
    companyBudget, now, inCompany, readCatalogSnapshot, repairCatalogPointerFromHistory, judgeAuthority,
    setupAdmissionRows, accountSetup, planAccounts, nameClaimWrites,
  });
  ownershipTakenOver = committed.ownershipTakenOver;
  return respond(committed.project, committed.duplicate, preflight);
}

/** The identity and source fences join the registration transaction, in their original order. */
async function planRegistrationCoreWrites(
  deps: Parameters<typeof planCanonicalProjectIdentity>[0],
  company: OrgId | undefined,
  record: RegisteredProjectRecord,
  snapshot: Awaited<ReturnType<typeof readNamedCompanyCatalogSnapshot>>,
): ReturnType<typeof planCoreProjectWrites> {
  // A named company's record IS its own-partition row (no legacy source to copy from).
  const identity = company === undefined ? undefined : await planCanonicalProjectIdentity(deps, company, record.definition.name, snapshot.newestRevision > 0 || snapshot.catalog !== undefined);
  const plan = identity !== undefined ? { status: "ready" as const, writes: identity.writes, incarnationRevision: identity.revision } : await planCoreProjectWrites(deps, record);
  if (plan.status === "unknown_company") brokerLogLine({ event: "core.project_copy_skipped", reason: "unknown_company" });
  if (snapshot.newest !== undefined) {
    if (company === undefined) plan.writes = guardCoreProjectSource(deps, snapshot.newest, plan.writes);
    else plan.writes.push({ ConditionCheck: { TableName: deps.tableName, Key: revisionKeyFor(company, record.definition.name, snapshot.newestRevision), ...coreProjectSnapshotFence(snapshot.newest) } });
  }
  return plan;
}

async function readProjectCatalogSnapshot(dependencies: AwsBrokerDependencies, projectName: string, task?: { companyId?: unknown }): Promise<{ catalog: { entityType?: string; name?: string; latestRevision?: number } | undefined; newestRevision: number; newest?: RegisteredProjectRecord }> {
  const catalog = await getItem<{ entityType?: string; name?: string; latestRevision?: number }>(dependencies, projectCatalogKey(projectName));
  if (catalog !== undefined && (catalog.entityType !== "PROJECT_CATALOG" || catalog.name !== projectName
    || (catalog.latestRevision !== undefined && (!Number.isSafeInteger(catalog.latestRevision) || catalog.latestRevision < 1)))) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is unavailable or invalid");
  }
  let newestRevision = 0;
  let newest: RegisteredProjectRecord | undefined;
  try {
    newest = task === undefined ? await requireLatestProject(dependencies, projectName)
      : await readTaskLegacyProject(await taskLegacyScope(dependencies, task), () => requireLatestProject(dependencies, projectName));
    newestRevision = newest.definition.revision;
    if (newest.definition.name !== projectName || !Number.isSafeInteger(newestRevision) || newestRevision < 1) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision history is invalid");
    }
  } catch (error) {
    if (!(error instanceof AgentXError) || error.code !== "NOT_FOUND") throw error;
  }
  if (catalog?.latestRevision !== undefined && catalog.latestRevision > newestRevision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is ahead of registered revision history");
  }
  return { catalog, newestRevision, ...(newest === undefined ? {} : { newest }) };
}

/**
 * DEC 254zzz80: registerProject's snapshot for a named company, from its own partition: the catalog row (`orgProjectCatalogKey`; a row written by the core may leave its name and
 * company out, but one that names another project or company is refused) and the newest stored revision of any kind (a candidate occupies its revision number too).
 */
async function readNamedCompanyCatalogSnapshot(dependencies: AwsBrokerDependencies, company: OrgId, projectName: string, options: { waitingCandidate?: "allow" } = {}): Promise<{ catalog: { entityType?: string; name?: string; latestRevision?: number } | undefined; newestRevision: number; newest?: RegisteredProjectRecord }> {
  const catalogKey = orgProjectCatalogKey(company, projectName);
  const catalog = await getItem<{ pk?: unknown; sk?: unknown; entityType?: string; name?: string; latestRevision?: number }>(dependencies, catalogKey);
  if (catalog !== undefined && (catalog.pk !== catalogKey.pk || catalog.sk !== catalogKey.sk || catalog.entityType !== "PROJECT_CATALOG" || (catalog.name !== undefined && catalog.name !== projectName)
    || !ownPartitionRow(catalog, company) || (catalog.latestRevision !== undefined && (!Number.isSafeInteger(catalog.latestRevision) || catalog.latestRevision < 1)))) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is unavailable or invalid");
  }
  const pk = revisionKeyFor(company, projectName, 1).pk;
  const response = await dependencies.documentClient.send(new QueryCommand({ TableName: dependencies.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": pk, ":revision": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true })) as { Items?: Array<Record<string, unknown>> };
  const raw = response.Items?.[0];
  // L1: the newest row is parsed, never assumed: a row with no readable definition is refused in fixed words (no TypeError, no 500).
  const definition = raw?.definition as { name?: unknown; revision?: unknown } | null | undefined;
  if (raw !== undefined && (raw.pk !== pk || !ownPartitionRow(raw, company) || typeof definition !== "object" || definition === null || definition.name !== projectName
    || typeof definition.revision !== "number" || !Number.isSafeInteger(definition.revision) || definition.revision < 1)) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision history is invalid");
  }
  const newest = raw as RegisteredProjectRecord | undefined;
  const newestRevision = newest?.definition.revision ?? 0;
  // M1: a setup change waiting for approval (a candidate revision the catalog does not point at) holds the project: no other revision is registered meanwhile, as the
  // core's own setup flow refuses (core/setup-agent/apply.ts), so the catalog pointer is never moved onto or past an unapproved candidate.
  const waiting = raw !== undefined && raw.candidate === true && (catalog?.latestRevision ?? 0) < newestRevision;
  if (waiting && options.waitingCandidate !== "allow") throw agentXError("PROJECT_REVISION_MISMATCH", NAMED_COMPANY_CANDIDATE_WAITING);
  if (catalog?.latestRevision !== undefined && catalog.latestRevision > newestRevision) throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog is ahead of registered revision history");
  // A waiting candidate (allowed only for the duplicate path's pointer repair) is never the newest the pointer may move to.
  return waiting ? { catalog, newestRevision: catalog?.latestRevision ?? 0 } : { catalog, newestRevision, ...(newest === undefined ? {} : { newest }) };
}

/**
 * A named company's duplicate registration: the catalog points at least at the revision just found stored (a candidate is never made the latest here: only its approval does that).
 * Moves the pointer forward only, conditionally on what was read.
 */
async function repairNamedCompanyCatalogPointer(dependencies: AwsBrokerDependencies, company: OrgId, projectName: string, revision: number): Promise<void> {
  const stored = await getItem<Record<string, unknown>>(dependencies, revisionKeyFor(company, projectName, revision));
  if (stored === undefined || stored.candidate === true) return;
  const snapshot = await readNamedCompanyCatalogSnapshot(dependencies, company, projectName, { waitingCandidate: "allow" });
  let identity: Awaited<ReturnType<typeof planCanonicalProjectIdentity>>;
  try { identity = await planCanonicalProjectIdentity(dependencies, company, projectName, true); }
  catch { throw agentXError("PROJECT_REVISION_MISMATCH", "project identity is unavailable; verified operator migration is required"); }
  if ((snapshot.catalog?.latestRevision ?? 0) >= revision) return;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [...identity.writes, { Update: {
      TableName: dependencies.tableName, Key: orgProjectCatalogKey(company, projectName),
      UpdateExpression: "SET entityType = :entity, #name = :name, companyId = :company, incarnationRevision = :incarnation, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)",
      ConditionExpression: snapshot.catalog === undefined ? "attribute_not_exists(pk)" : snapshot.catalog.latestRevision === undefined ? "attribute_not_exists(latestRevision)" : "latestRevision = :observed",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": projectName, ":company": company, ":incarnation": identity.revision, ":revision": revision, ":now": new Date().toISOString(),
        ...(snapshot.catalog?.latestRevision === undefined ? {} : { ":observed": snapshot.catalog.latestRevision }) },
    } }] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog pointer changed without revision history advancing");
  }
}

async function planCatalogRepairCoreWrites(
  dependencies: AwsBrokerDependencies,
  coreBudget: ReturnType<typeof boundedCompanyReads>,
  snapshot: Awaited<ReturnType<typeof readProjectCatalogSnapshot>>,
  projectName: string,
): ReturnType<typeof planCoreProjectWrites> {
  let corePlan: Awaited<ReturnType<typeof planCoreProjectWrites>>;
  try {
    corePlan = await planCoreProjectWrites({ tableName: dependencies.tableName, documentClient: coreBudget.client }, snapshot.newest!);
    corePlan.writes = guardCoreProjectSource(dependencies, snapshot.newest!, corePlan.writes);
  } catch {
    throw agentXError("PROJECT_REVISION_MISMATCH", await coreCopyRefusalWords({ tableName: dependencies.tableName, documentClient: coreBudget.client }, snapshot.newest?.companyId, projectName));
  }
  if (corePlan.status === "unknown_company") brokerLogLine({ event: "core.project_copy_skipped", reason: "unknown_company" });
  return corePlan;
}

function legacyCatalogRepairUpdateItem(
  tableName: string,
  projectName: string,
  targetRevision: number,
  snapshot: Awaited<ReturnType<typeof readProjectCatalogSnapshot>>,
): TransactItems[number] {
  const condition = snapshot.catalog === undefined ? "attribute_not_exists(pk)"
    : snapshot.catalog.latestRevision === undefined
      ? "entityType = :entity AND #name = :name AND attribute_not_exists(latestRevision)"
      : "entityType = :entity AND #name = :name AND latestRevision = :observed AND latestRevision < :revision";
  return { Update: {
    TableName: tableName,
    Key: projectCatalogKey(projectName),
    UpdateExpression: "SET entityType = :entity, #name = :name, latestRevision = :revision, firstRegisteredAt = if_not_exists(firstRegisteredAt, :now)",
    ConditionExpression: condition,
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: {
      ":entity": "PROJECT_CATALOG", ":name": projectName, ":revision": targetRevision,
      ":now": new Date().toISOString(),
      ...(snapshot.catalog?.latestRevision === undefined ? {} : { ":observed": snapshot.catalog.latestRevision }),
    },
  } };
}

async function assertCatalogRepairRetryable(
  dependencies: AwsBrokerDependencies,
  projectName: string,
  options: { createCatalogRow?: boolean; task?: { companyId?: unknown } },
  snapshot: Awaited<ReturnType<typeof readProjectCatalogSnapshot>>,
  attempt: number,
  error: unknown,
): Promise<void> {
  if (!isConditional(error)) throw error;
  if (attempt === 2) throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog pointer could not be reconciled with immutable revision history");
  const refreshed = await readProjectCatalogSnapshot(dependencies, projectName, options.task);
  if (refreshed.newestRevision <= snapshot.newestRevision
    && (refreshed.catalog?.latestRevision ?? 0) <= (snapshot.catalog?.latestRevision ?? 0)) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "project catalog pointer changed without revision history advancing");
  }
}

async function repairProjectCatalogPointerFromHistory(dependencies: AwsBrokerDependencies, projectName: string, options: { createCatalogRow?: boolean; task?: { companyId?: unknown } } = {}): Promise<void> {
  // Legacy index repair and the known-company core copy commit together. No legacy revision is rewritten.
  const coreBudget = boundedCompanyReads(dependencies.documentClient);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await readProjectCatalogSnapshot(dependencies, projectName, options.task);
    const targetRevision = snapshot.newestRevision;
    if (targetRevision < 1) throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision history is unavailable");
    if (snapshot.catalog === undefined && options.createCatalogRow === false) throw agentXError("PROJECT_REVISION_MISMATCH", "catalog-row-absent");
    const corePlan = await planCatalogRepairCoreWrites(dependencies, coreBudget, snapshot, projectName);
    const repairLegacy = snapshot.catalog?.latestRevision !== targetRevision;
    if (!repairLegacy && corePlan.status !== "ready") return;
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...corePlan.writes,
        ...(repairLegacy ? [legacyCatalogRepairUpdateItem(dependencies.tableName, projectName, targetRevision, snapshot)] : []),
      ] }));
      return;
    } catch (error) {
      await assertCatalogRepairRetryable(dependencies, projectName, options, snapshot, attempt, error);
    }
  }
}

function decodeSetupSourceEntries(rawSources: unknown[]): Array<{ path: string; sha256: string; bytes: Buffer; kind: "blob" }> {
  return rawSources.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid source record");
    const source = raw as Record<string, unknown>;
    if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") {
      throw new Error("invalid source record");
    }
    return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
  });
}

async function loadVerifiedProjectSetupProposal(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  setupApproval: NonNullable<RegisteredProjectRecord["setupApproval"]>,
): Promise<{ policyDigest: string; snapshot: E2ESourceSnapshot; policy: E2EPolicy } | undefined> {
  const approval = await getItem<Record<string, unknown>>(dependencies, { pk: `PROJECT_SETUP#${project.definition.name}`, sk: `PROPOSAL#${setupApproval.proposalSha256}` });
  if (!approval || approval.ownerKey !== identity.ownerKey || approval.decision !== "approve" || approval.proposalRef !== setupApproval.proposalRef
    || typeof approval.policyDigest !== "string" || !sameJsonContent(approval.policy, project.definition.e2e)) return undefined;
  const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, setupApproval.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
  if (!stored || createHash("sha256").update(stored, "utf8").digest("hex") !== setupApproval.proposalSha256) return undefined;
  let artifact: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(stored);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
    artifact = decoded as Record<string, unknown>;
  } catch { return undefined; }
  if (artifact.schemaVersion !== "project-setup-source-proposal/v1" || artifact.issuerOwnerKey !== identity.ownerKey
    || !artifact.snapshot || typeof artifact.snapshot !== "object" || Array.isArray(artifact.snapshot)) return undefined;
  const rawSnapshot = artifact.snapshot as Record<string, unknown>;
  if (!Array.isArray(rawSnapshot.sources)) return undefined;
  let snapshot: E2ESourceSnapshot;
  try {
    snapshot = { ...rawSnapshot, sources: decodeSetupSourceEntries(rawSnapshot.sources) } as unknown as E2ESourceSnapshot;
    verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  } catch { return undefined; }
  const policy = E2EPolicySchema.safeParse(project.definition.e2e);
  if (!policy.success) return undefined;
  return { policyDigest: approval.policyDigest, snapshot, policy: policy.data };
}

function buildProjectSetupRunContext(
  derived: ReturnType<typeof deriveProjectSetupSourceSmoke>,
  project: RegisteredProjectRecord,
  setupApproval: NonNullable<RegisteredProjectRecord["setupApproval"]>,
  policy: E2EPolicy,
  policyDigest: string,
  runtime: NonNullable<ReturnType<typeof admitProjectSetupRuntime>>,
  ids: { setupExecutionId: string; operationId: string; fence: number },
  now: Date,
  stableUuid: (label: string) => string,
): { setupRunContext: Record<string, unknown>; evidenceByteLimit: number } | undefined {
  try {
    const plan = selectE2EExecutionPlan(derived.selectionInput);
    if (plan.groups.length === 0 || plan.groups.some((group) => group.expectedCases.length === 0)) return undefined;
    const bundleBody = { schemaVersion: 1 as const, planDigest: derived.planDigest, templateVersion: "trusted-e2e/v1", scenarios: derived.scenarios, bundleDigest: "0".repeat(64) };
    const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
    const compiledGroups = plan.groups.map((group) => ({ group, compiled: compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput: derived.selectionInput, executionPlan: plan, group }) }));
    const totalCases = compiledGroups.reduce((total, item) => total + item.group.expectedCases.length, 0);
    const evidenceByteLimit = e2ePrivateTransferMaxBytes(totalCases, compiledGroups.length);
    const roundId = stableUuid("round");
    const admittedAt = now.toISOString();
    const deadlineAt = new Date(now.getTime() + policy.limits.runTimeoutMs).toISOString();
    const taskId = `project-setup:${ids.setupExecutionId}`;
    const groupAdmissions = compiledGroups.map(({ group, compiled }, index) => {
      const runId = stableUuid(`run-${index}-${group.groupId}`);
      const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId, roundId, taskId, operationId: ids.operationId, operationFence: ids.fence,
        workflowRevision: project.definition.revision, groupId: group.groupId, executionPlanDigest: plan.digest, executionMode: group.mode,
        mockManifestDigest: group.mockManifestDigest, authorizationRevision: `setup:${1}`, candidateDigest: setupApproval.candidateDigest,
        planDigest: derived.planDigest, policyDigest, bundleDigest: bundle.bundleDigest,
        appBuildDigest: createHash("sha256").update(canonicalJson(compiled.inventory)).digest("hex"),
        environmentDigest: createHash("sha256").update(canonicalJson(runtime.runnerEnvironment), "utf8").digest("hex"), runtimeManifestDigest: runtime.manifestDigest,
        modelRouteRevision: null, expectedCases: compiled.expectedCases, admittedAt, deadlineAt });
      return { group, binding, expectedConfigDigest: compiled.expectedConfigDigest, compiledInventoryDigest: compiled.inventory.digest,
        expectedCases: compiled.expectedCases, selectionPacketPath: compiled.selectionPacketPath };
    });
    const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId, operationId: ids.operationId, operationFence: ids.fence,
      workflowRevision: project.definition.revision, executionPlanDigest: plan.digest, admittedAt, deadlineAt,
      limits: policy.limits, groupBindings: groupAdmissions.map((item) => item.binding) });
    return {
      setupRunContext: { roundId, admittedAt, deadlineAt, runnerEnvironment: runtime.runnerEnvironment,
        runnerToolchain: runtime.runnerToolchain, runnerToolchainDigest: runtime.runnerToolchainDigest, plan, bundle, round, groupAdmissions },
      evidenceByteLimit,
    };
  } catch { return undefined; }
}

async function uploadProjectSetupExecutionObject(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  setupApproval: NonNullable<RegisteredProjectRecord["setupApproval"]>,
  executionObject: Record<string, unknown>,
): Promise<{ key: string; sha256: string; byteLength: number } | undefined> {
  const executionBytes = Buffer.from(canonicalJson(executionObject), "utf8");
  const executionDigest = createHash("sha256").update(executionBytes).digest("hex");
  const executionRef = { key: `project-setup-executions/sha256/${executionDigest}.json`, sha256: executionDigest, byteLength: executionBytes.byteLength };
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: executionRef.key, Body: executionBytes,
      ContentType: "application/json", Metadata: { sha256: executionDigest, owner: identity.ownerKey, candidate: setupApproval.candidateDigest }, IfNoneMatch: "*" }));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (code !== "PreconditionFailed" && status !== 412) throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, executionRef.key, MAX_SETUP_PROPOSAL_BYTES) !== executionBytes.toString("utf8")) return undefined;
  }
  return executionRef;
}

async function createProjectSetupAdmissionRows(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  setupApproval: NonNullable<RegisteredProjectRecord["setupApproval"]>,
  runtime: NonNullable<ReturnType<typeof admitProjectSetupRuntime>>,
  retry?: { attemptId: string; retryOfExecutionId: string },
): Promise<{ transactionItems: Array<Record<string, unknown>> } | undefined> {
  if (!dependencies.projectSetupRuntimeCatalogId || project.runtimeBinding.deploymentMode !== "ec2-ebs") return undefined;
  const endpoint = new URL(runtime.endpoint);
  if (endpoint.protocol !== "http:" || !z.ipv4().safeParse(endpoint.hostname).success) return undefined;
  const verifiedProposal = await loadVerifiedProjectSetupProposal(dependencies, identity, project, setupApproval);
  if (!verifiedProposal) return undefined;
  const { policyDigest, snapshot, policy } = verifiedProposal;
  let derived: ReturnType<typeof deriveProjectSetupSourceSmoke>;
  try {
    derived = deriveProjectSetupSourceSmoke({
      projectName: project.definition.name, proposalSha256: setupApproval.proposalSha256,
      approval: { proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: setupApproval.candidateDigest,
        policyDigest, runtimeCatalogId: runtime.runtimeCatalogId, catalogRevision: runtime.catalogRevision,
        bindingDigest: runtime.bindingDigest, manifestDigest: runtime.manifestDigest, generation: runtime.generation },
      snapshot, policy,
      sandboxAvailability: { targetId: "default-sandbox", profileId: policy.defaultSandboxProfileId, connection: "connected", approval: "approved",
        qualification: "qualified", authorizationRevision: `catalog-${runtime.catalogRevision}` },
      runtimeAvailability: [],
    });
  } catch { return undefined; }

  const now = new Date();
  const stableUuid = (label: string) => {
    const stableInput = retry
      ? `project-setup/retry/v1\0${retry.retryOfExecutionId}\0${retry.attemptId}\0${identity.ownerKey}\0${project.definition.name}\0${project.definition.revision}\0${setupApproval.proposalSha256}\0${runtime.generation}\0${label}`
      : `project-setup/v1\0${identity.ownerKey}\0${project.definition.name}\0${project.definition.revision}\0${setupApproval.proposalSha256}\0${runtime.generation}\0${label}`;
    const bytes = createHash("sha256").update(stableInput).digest().subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const setupExecutionId = stableUuid("execution");
  const subjectId = stableUuid("subject");
  // This is the exact server-configured worker identity from the ready registry, never a caller
  // supplied workspace id or a value inferred from the setup execution.
  const transportCorrelationId = runtime.transportCorrelationId;
  const operationId = stableUuid("operation");
  const outboxId = stableUuid("outbox");
  const fence = 1;
  const builtRunContext = buildProjectSetupRunContext(derived, project, setupApproval, policy, policyDigest, runtime, { setupExecutionId, operationId, fence }, now, stableUuid);
  if (!builtRunContext) return undefined;
  const { setupRunContext, evidenceByteLimit } = builtRunContext;
  const executionObject = {
    domain: "project-setup-source-interface/v1", schemaVersion: 1, setupExecutionId, subjectId,
    transportCorrelationId, ownerKey: identity.ownerKey, projectName: project.definition.name, projectRevision: project.definition.revision,
    approvalRevision: 1, proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256,
    candidateDigest: setupApproval.candidateDigest, policyDigest, policy,
    sourceSnapshot: { ...snapshot, sources: snapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytesBase64: Buffer.from(source.bytes).toString("base64") })) },
    // The worker reconstructs this exact selection against the retained snapshot bytes and then
    // recompiles. Snapshot bytes live once in the bounded content-addressed object above.
    selectionInput: Object.fromEntries(Object.entries(derived.selectionInput).filter(([key]) => key !== "sourceSnapshot")),
    setupRunContext, evidenceByteLimit,
    semanticApproval: derived.semanticApproval, planDigest: derived.planDigest, portableApprovalBinding: derived.portableApprovalBinding,
    scenarios: derived.scenarios, selectedTargetIds: derived.targetIds,
    unsupportedTargetIds: derived.unsupportedTargetIds,
    discoveredApplications: derived.discoveredApplications, discoveryMissingInputs: derived.discoveryMissingInputs,
    discoveredTargetIds: derived.discoveredTargetIds,
    notExecutedTargetIds: derived.unsupportedTargetIds,
    runtime: { runtimeCatalogId: runtime.runtimeCatalogId, catalogRevision: runtime.catalogRevision, bindingDigest: runtime.bindingDigest,
      manifestDigest: runtime.manifestDigest, runnerEnvironment: runtime.runnerEnvironment, generation: runtime.generation,
      transportCorrelationId, endpoint: runtime.endpoint, expiresAt: runtime.expiresAt },
    ...(retry ? { retryOfExecutionId: retry.retryOfExecutionId, retryActorKey: identity.ownerKey } : {}),
  };
  await assertNoRequalifyHold(dependencies, Date.now()); // AUTOREQUALIFY: no new setup run while the test machine is being switched
  const executionRef = await uploadProjectSetupExecutionObject(dependencies, identity, setupApproval, executionObject);
  if (!executionRef) return undefined;
  const execution = ProjectSetupExecutionSchema.parse({ schemaVersion: 1, setupExecutionId, subjectId, transportCorrelationId,
    projectName: project.definition.name, projectRevision: project.definition.revision, ownerKey: identity.ownerKey, approvalRevision: 1,
    proposalRef: setupApproval.proposalRef, proposalSha256: setupApproval.proposalSha256, candidateDigest: setupApproval.candidateDigest,
    policyDigest, bindingDigest: runtime.bindingDigest, runtimeGeneration: runtime.generation,
    executionRef, runtimeCatalogId: runtime.runtimeCatalogId, runtimeCatalogRevision: runtime.catalogRevision,
    state: "ACCEPTED", operationId, outboxId, fence,
    deadlineAt: setupRunContext.deadlineAt, evidenceByteLimit, createdAt: now.toISOString(),
    ...(retry ? { retryOfExecutionId: retry.retryOfExecutionId, retryActorKey: identity.ownerKey } : {}) });
  const session = ProjectSetupSessionSchema.parse({ schemaVersion: 1, setupExecutionId, subjectId, transportCorrelationId,
    approvalRevision: 1, bindingDigest: runtime.bindingDigest, state: "READY", generation: runtime.generation, privateIp: endpoint.hostname, ...setupSessionInstance(runtime) });
  const operation = { ...projectSetupOperationKey(setupExecutionId, operationId), entityType: "PROJECT_SETUP_OPERATION",
    ...ProjectSetupOperationSchema.parse({ schemaVersion: 1, setupExecutionId, operationId, transportCorrelationId, fence,
      status: "ACCEPTED", createdAt: now.toISOString(), updatedAt: now.toISOString() }) };
  const callbackCapability = issueProjectSetupCapability(dependencies.callbackSigningKey, { domain: "PROJECT_SETUP", setupExecutionId, subjectId,
    transportCorrelationId, operationId, approvalRevision: 1, fence, expiresAt: Math.floor(now.getTime() / 1_000) + 32_400,
    actions: ["read-execution", "write-evidence", "result"] });
  const invocation = WorkerInvocationSchema.parse({ protocolVersion: AGENTX_PROTOCOL_VERSION, operationId, workspaceId: transportCorrelationId,
    fence, projectRevision: project.definition.revision, callbackCapability, kind: "project-setup-smoke",
    payload: { domain: "project-setup-source-interface/v1", setupExecutionId, subjectId, approvalRevision: 1, transportCorrelationId, executionRef } });
  const outbox = { pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "PENDING", operationId,
    workspaceId: transportCorrelationId, deploymentMode: "ec2-ebs", invocation, createdAt: now.toISOString() };
  const put = (item: Record<string, unknown>) => ({ Put: { TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
  return { transactionItems: [put({ ...projectSetupExecutionKey(setupExecutionId), entityType: "PROJECT_SETUP_EXECUTION", ...execution }),
    put({ ...projectSetupSessionKey(setupExecutionId), entityType: "PROJECT_SETUP_SESSION", ...session }), put(operation), put(outbox),
    put(requalifySetupWorkRow(setupExecutionId, execution.deadlineAt)), requalifyHoldFence(dependencies.tableName, Date.now())] };
}

function matchingSetupRetryDuplicate(
  record: Record<string, unknown> | undefined,
  setupExecutionId: string,
  retryActorKey: string,
  originalCreatorKey: string,
): { setupExecutionId: string; operationId: string; status: "QUEUED"; duplicate: true } | undefined {
  if (record?.entityType === "PROJECT_SETUP_RETRY" && record.previousExecutionId === setupExecutionId
    && record.retryActorKey === retryActorKey && record.originalCreatorKey === originalCreatorKey
    && typeof record.setupExecutionId === "string" && typeof record.operationId === "string") {
    return { setupExecutionId: record.setupExecutionId, operationId: record.operationId, status: "QUEUED", duplicate: true };
  }
  return undefined;
}

async function loadRetryableProjectSetupExecution(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  setupExecutionId: string,
) {
  const executionKey = projectSetupExecutionKey(setupExecutionId);
  const raw = await getItem<Record<string, unknown>>(dependencies, executionKey);
  const parked = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(raw, executionKey, "PROJECT_SETUP_EXECUTION"));
  if (!parked.success) throw agentXError("STALE_FENCE", "only a current setup execution can be retried");
  const expiredDispatch = parked.data.state === "DISPATCHING" && parked.data.result === undefined && Date.parse(parked.data.deadlineAt) <= Date.now();
  const priorOperationKey = projectSetupOperationKey(setupExecutionId, parked.data.operationId);
  const priorOperationResponse = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: priorOperationKey, ConsistentRead: true }));
  const priorOperation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(priorOperationResponse.Item, priorOperationKey, "PROJECT_SETUP_OPERATION"));
  const parkedRetry = parked.data.state === "PARKED" && parked.data.result !== undefined
    && priorOperation.success && priorOperation.data.status === "PARKED";
  const expiredDispatchRetry = expiredDispatch && priorOperation.success
    && (priorOperation.data.status === "DISPATCHING" || priorOperation.data.status === "DELIVERED")
    && priorOperation.data.setupExecutionId === setupExecutionId && priorOperation.data.operationId === parked.data.operationId
    && priorOperation.data.fence === parked.data.fence && priorOperation.data.transportCorrelationId === parked.data.transportCorrelationId;
  if (!parkedRetry && !expiredDispatchRetry) throw agentXError("STALE_FENCE", "only an owned parked setup execution or an expired matching dispatch can be retried");
  if (identity.ownerKey !== parked.data.ownerKey) throw agentXError("FORBIDDEN", "setup retry actor must be the original project creator");
  return { executionKey, priorOperationKey, parked: parked.data, expiredDispatchRetry };
}

async function verifyProjectSetupRetryEligibility(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  parked: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  setupExecutionId: string,
) {
  const project = await requireProject(dependencies, parked.projectName, parked.projectRevision);
  await requireAdministrator(dependencies, identity, parked.projectName);
  if (project.runtimeBinding.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "the approved setup runtime profile is unavailable");
  if (project.registeredBy !== parked.ownerKey || project.setupApproval?.decision !== "approve"
    || project.setupApproval.proposalRef !== parked.proposalRef || project.setupApproval.proposalSha256 !== parked.proposalSha256
    || project.setupApproval.candidateDigest !== parked.candidateDigest || project.definition.e2e === undefined
    || !dependencies.projectSetupRuntimeCatalogId || dependencies.projectSetupRuntimeCatalogId !== parked.runtimeCatalogId
    || projectSetupBindingDigest(project.runtimeBinding) !== parked.bindingDigest) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "setup source, policy, binding, or catalog changed; complete normal approval before retry");
  }
  const approval = await getItem<Record<string, unknown>>(dependencies, { pk: `PROJECT_SETUP#${project.definition.name}`, sk: `PROPOSAL#${parked.proposalSha256}` });
  if (!approval || approval.ownerKey !== parked.ownerKey || approval.decision !== "approve" || approval.proposalRef !== parked.proposalRef
    || approval.policyDigest !== parked.policyDigest || !sameJsonContent(approval.policy, project.definition.e2e)) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "current setup approval no longer matches the parked source and policy");
  }
  const runtimeKey = projectSetupRuntimeKey(parked.runtimeCatalogId, parked.bindingDigest);
  const runtimeItem = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: runtimeKey, ConsistentRead: true }));
  const runtime = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(runtimeItem.Item, runtimeKey));
  if (!runtime.success) throw agentXError("RUNTIME_UNAVAILABLE", "the exact approved setup runtime binding is unavailable");
  const admittedRuntime = admitProjectSetupRuntime(runtime.data, { runtimeCatalogId: parked.runtimeCatalogId, binding: project.runtimeBinding,
    scope: "source-interface", now: Date.now() });
  if (!admittedRuntime || admittedRuntime.catalogRevision !== parked.runtimeCatalogRevision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "the admitted setup catalog revision changed; complete normal approval before retry");
  }
  if (!(await setupAdmissionMatchesExecution(dependencies, parked))) {
    throw agentXError("RUNTIME_UNAVAILABLE", "the immutable setup admission does not match its stored execution identity");
  }
  const sessionKey = projectSetupSessionKey(setupExecutionId);
  const sessionResponse = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: sessionKey, ConsistentRead: true }));
  const session = ProjectSetupSessionSchema.safeParse(projectSetupDomainRecord(sessionResponse.Item, sessionKey, "PROJECT_SETUP_SESSION"));
  if (!session.success || session.data.setupExecutionId !== setupExecutionId || session.data.subjectId !== parked.subjectId
    || session.data.transportCorrelationId !== parked.transportCorrelationId || session.data.approvalRevision !== parked.approvalRevision
    || session.data.bindingDigest !== parked.bindingDigest || session.data.generation !== parked.runtimeGeneration || session.data.state !== "READY") {
    throw agentXError("RUNTIME_UNAVAILABLE", "the exact approved setup session is no longer ready");
  }
  return { project, setupApproval: project.setupApproval, runtime: runtime.data, admittedRuntime, session: session.data };
}

function buildSetupRetryPriorMutations(
  tableName: string,
  setupExecutionId: string,
  executionKey: { pk: string; sk: string },
  priorOperationKey: { pk: string; sk: string },
  parked: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  expiredDispatchRetry: boolean,
  now: string,
): { priorExecutionMutation: TransactItems[number]; priorOperationMutation: TransactItems[number] } {
  const parkResult = { domain: "project-setup-source-interface/v1", candidateDigest: parked.candidateDigest,
    processStatus: "UNKNOWN", qualification: "UNKNOWN", cleanupConfirmed: false, parkReason: "setup-deadline-expired" };
  const priorExecutionMutation: TransactItems[number] = expiredDispatchRetry
    ? { Update: { TableName: tableName, Key: executionKey,
        UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
        ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation AND deadlineAt = :deadlineAt AND deadlineAt <= :now",
        ExpressionAttributeNames: { "#state": "state", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":now": now, ":result": parkResult,
          ":operationId": parked.operationId, ":subjectId": parked.subjectId, ":fence": parked.fence,
          ":approvalRevision": parked.approvalRevision, ":correlation": parked.transportCorrelationId,
          ":deadlineAt": parked.deadlineAt } } }
    : { ConditionCheck: { TableName: tableName, Key: executionKey,
        ConditionExpression: "#state = :parked AND operationId = :operationId AND fence = :fence",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":operationId": parked.operationId, ":fence": parked.fence } } };
  const priorOperationMutation: TransactItems[number] = expiredDispatchRetry
    ? { Update: { TableName: tableName, Key: priorOperationKey,
        UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
        ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": now,
          ":result": parkResult, ":setupExecutionId": setupExecutionId, ":operationId": parked.operationId,
          ":fence": parked.fence, ":correlation": parked.transportCorrelationId } } }
    : { ConditionCheck: { TableName: tableName, Key: priorOperationKey,
        ConditionExpression: "#status = :parked AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":setupExecutionId": setupExecutionId,
          ":operationId": parked.operationId, ":fence": parked.fence, ":correlation": parked.transportCorrelationId } } };
  return { priorExecutionMutation, priorOperationMutation };
}

async function retryProjectSetupAsAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  setupExecutionId: string,
  value: unknown,
): Promise<{ setupExecutionId: string; operationId: string; status: "QUEUED"; duplicate: boolean }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required for an explicit setup retry");
  const input = z.object({ requestId: z.string().uuid() }).strict().parse(value);
  const idempotencyKey = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `RETRY#${identity.ownerKey}#${input.requestId}` };
  const { executionKey, priorOperationKey, parked, expiredDispatchRetry } = await loadRetryableProjectSetupExecution(dependencies, identity, setupExecutionId);
  const { project, setupApproval, runtime, admittedRuntime, session } = await verifyProjectSetupRetryEligibility(dependencies, identity, parked, setupExecutionId);
  const prior = await getItem<Record<string, unknown>>(dependencies, idempotencyKey);
  const priorDuplicate = matchingSetupRetryDuplicate(prior, setupExecutionId, identity.ownerKey, parked.ownerKey);
  if (priorDuplicate) return priorDuplicate;
  const rows = await createProjectSetupAdmissionRows(dependencies, identity, project, setupApproval, admittedRuntime,
    { attemptId: input.requestId, retryOfExecutionId: setupExecutionId });
  if (!rows) throw agentXError("RUNTIME_UNAVAILABLE", "the approved source-interface setup run cannot be admitted");
  const executionPut = rows.transactionItems.find((item) => "Put" in item && (item as { Put: { Item?: { entityType?: unknown } } }).Put.Item?.entityType === "PROJECT_SETUP_EXECUTION") as { Put: { Item: Record<string, unknown> } } | undefined;
  const operationPut = rows.transactionItems.find((item) => "Put" in item && (item as { Put: { Item?: { entityType?: unknown } } }).Put.Item?.entityType === "PROJECT_SETUP_OPERATION") as { Put: { Item: Record<string, unknown> } } | undefined;
  if (!executionPut || !operationPut) throw agentXError("RUNTIME_UNAVAILABLE", "setup retry admission rows are incomplete");
  const nextExecution = executionPut.Put.Item;
  const nextOperation = operationPut.Put.Item;
  const marker = { ...idempotencyKey, entityType: "PROJECT_SETUP_RETRY", previousExecutionId: setupExecutionId,
    setupExecutionId: nextExecution.setupExecutionId, operationId: nextOperation.operationId, retryActorKey: identity.ownerKey,
    originalCreatorKey: parked.ownerKey, createdAt: new Date().toISOString() };
  const now = new Date().toISOString();
  const terminalAuthorityChecks = projectSetupTerminalAuthorityChecks(dependencies.tableName, parked, runtime, session, LEGACY_REVISION_GRANT);
  const { priorExecutionMutation, priorOperationMutation } = buildSetupRetryPriorMutations(
    dependencies.tableName, setupExecutionId, executionKey, priorOperationKey, parked, expiredDispatchRetry, now,
  );
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...terminalAuthorityChecks,
      priorExecutionMutation,
      priorOperationMutation,
      ...rows.transactionItems,
      { Put: { TableName: dependencies.tableName, Item: marker, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    ] }));
  } catch (error) {
    const duplicate = matchingSetupRetryDuplicate(await getItem<Record<string, unknown>>(dependencies, idempotencyKey), setupExecutionId, identity.ownerKey, parked.ownerKey);
    if (duplicate) return duplicate;
    await rethrowAsDeferredIfHeld(dependencies, error, Date.now()); // AUTOREQUALIFY: the start fence refused the retry
    throw error;
  }
  return { setupExecutionId: String(nextExecution.setupExecutionId), operationId: String(nextOperation.operationId), status: "QUEUED", duplicate: false };
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

  // The target's membership is created here only when absent, recording who granted it. An existing row is checked, never rewritten: when it changed since
  // it was read, the transaction is refused and decided again from the row as it now is.
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const preparation = await newWorkspacePreparation(dependencies, identity, project, targetOwnerKey, requestId, { grantedBy: { issuer: identity.issuer, subject: identity.subject } });
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...preparation.items,
        { Put: { TableName: dependencies.tableName, Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id }, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      if (!isConditional(error) || !await membershipMovedSince(dependencies, targetOwnerKey, project.definition.name, preparation.membership, LEGACY_REVISION_GRANT)) throw error;
      continue;
    }
    return { operationId: preparation.operationId, workspace: publicWorkspace(preparation.workspace), alreadyReady: false };
  }
  throw agentXError("WORKSPACE_BUSY", "the project membership kept changing while the workspace was prepared; try again with the same requestId");
}

/** Attempts to create a workspace around a project membership that another request keeps changing; the registration retry style. */
const MEMBERSHIP_PREPARATION_ATTEMPTS = 3;

/** True when the membership row is no longer the one a transaction was built from: gone, created, or another role or grantId. */
async function membershipMovedSince(dependencies: AwsBrokerDependencies, ownerKey: string, projectName: string, observed: MembershipRecord | undefined, companyId: string | undefined): Promise<boolean> {
  const current = await getMembership(dependencies, ownerKey, projectName, companyId);
  return current?.role !== observed?.role || current?.grantId !== observed?.grantId;
}

/**
 * The transaction item for the membership of a workspace's owner, decided from the row as it was read. An absent row is created as a
 * developer, only if still absent. An existing row keeps its role and grantId: the item only requires it to be as it was read (a legacy row with no
 * grantId also gains one).
 */
function membershipPreparationItem(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
  observed: MembershipRecord | undefined,
  companyId: string | undefined,
  grantedBy?: { issuer: string; subject: string },
): TransactItems[number] {
  // DEC 254zzz98: `companyId` is where the grant beside the revision is (LEGACY_REVISION_GRANT for the legacy revisions every caller here reads).
  if (observed === undefined) {
    const created: MembershipRecord = { ...membershipRecord(ownerKey, projectName, "developer", companyId), ...(grantedBy === undefined ? {} : { grantedBy, grantedAt: new Date().toISOString() }) };
    return { Put: { TableName: dependencies.tableName, Item: created, ConditionExpression: "attribute_not_exists(pk)" } };
  }
  const key = grantKeyFor(companyId, ownerKey, projectName);
  // A row from before grants were versioned has no grantId. It gets one here, in the same transaction, and keeps everything else it has;
  // the condition lets it happen only to the row that was read, and never replaces a grantId that exists.
  if (typeof observed.grantId !== "string") {
    return { Update: {
      TableName: dependencies.tableName,
      Key: key,
      UpdateExpression: "SET grantId = :grantId",
      ConditionExpression: "#role = :role AND attribute_not_exists(grantId)",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":role": observed.role, ":grantId": randomUUID() },
    } };
  }
  return { ConditionCheck: {
    TableName: dependencies.tableName,
    Key: key,
    ConditionExpression: "#role = :role AND grantId = :grantId",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":role": observed.role, ":grantId": observed.grantId },
  } };
}

async function newWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  targetOwnerKey: string,
  requestId: string,
  options: { grantedBy?: { issuer: string; subject: string } } = {},
): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems; membership: MembershipRecord | undefined }> {
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
  const existingMembership = await getMembership(dependencies, targetOwnerKey, projectName, LEGACY_REVISION_GRANT);
  return {
    workspace,
    operationId,
    membership: existingMembership,
    items: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { pk: `OWNER#${targetOwnerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      membershipPreparationItem(dependencies, targetOwnerKey, projectName, existingMembership, LEGACY_REVISION_GRANT, options.grantedBy),
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
  // Spec 062 Phase 4: an adapter conversation names itself with its own headers, never with Slack's.
  const conversation = readConversationHeaders(request.headers);
  if (conversation !== undefined) {
    if (request.headers["x-agentx-slack-thread"] !== undefined) throw agentXError("CONFIG_INVALID", "a call names a Slack thread or an adapter conversation, not both");
    if (dependencies.channelAdapters === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
    return channelConversationIdentity(channelConversationDependencies(dependencies), conversation.ref, conversation.actor);
  }
  const context = parseSlackHeaders(request.headers);
  let view: AwsBrokerDependencies;
  try { view = await namedInstallTeamView(dependencies, context.thread.teamId); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "This Slack workspace is not available."); }
  await companySlackCaller(view, context.thread, context.requester.userId);
  const binding = await getSlackBinding(view, context.thread.teamId, context.thread.channelId);
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
  const shared = await sharedThread(view, context.thread);
  if (shared === undefined) return own;
  await requireSlackTaskCompany(view, context.thread, shared.taskId);
  const sharedTask = { taskId: shared.taskId, workspaceId: shared.workspaceId, developerName: shared.developerName };
  // C11: open only while continue, not closed, and the channel still serves the task's project.
  // A Slack-started task's own thread is driven by its owner's buttons, never by the channel's chat agent: closed to it.
  if (!sharedThreadOpen(shared, binding)) {
    // The ordinary chat workspace stays closed; only a request for task mode (a read-only view with no tools) may use an open one.
    const taskAnswer = shared.workflowThread === true && shared.closedAt === undefined && binding.projectName === shared.project;
    return { ...own, sharedTask: { ...sharedTask, state: shared.closedAt !== undefined || shared.workflowThread === true ? "closed" : "view", ...(taskAnswer ? { taskAnswer: true as const } : {}) } };
  }
  if (dependencies.developer === undefined) throw agentXError("FORBIDDEN", "developer task workflows are not configured");
  let access: TaskAccess;
  try { ({ access } = await slackTaskAccess(view, developerTaskActions(view), shared.taskId, context.requester.userId, "comment", false, context.thread)); }
  catch { throw agentXError("FORBIDDEN", "this Slack member cannot continue the task"); }
  if (access.task.share?.teamId !== context.thread.teamId || access.task.share.channelId !== context.thread.channelId
    || access.task.share.threadTs !== context.thread.threadTs) throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  const authorizedSharedTask = { ...sharedTask, state: "continue" as const, peopleAccessBound: true as const, peopleRevision: access.peopleRevision };
  return {
    issuer: DEVELOPER_TASK_OWNER_ISSUER,
    subject: taskOwnerSubject(shared.developerId, shared.taskId),
    ownerKey: shared.ownerKey,
    isAdministrator: false,
    claims: {},
    // The teammate's Slack context: requesterOf records them on every operation (FR-054).
    slack: { ...context, binding },
    sharedTask: authorizedSharedTask,
  };
}

function sharedStopForbidden(): never {
  throw agentXError("FORBIDDEN", "this shared thread is not bound to the task's workspace");
}

async function verifiedSharedStopBinding(
  dependencies: AwsBrokerDependencies,
  thread: SlackThread,
  binding: SlackChannelBinding,
  shared: SharedTaskRecord,
): Promise<{ task: DeveloperTaskRecord; workspace: WorkspaceInstance }> {
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(shared.taskId));
  if (task === undefined || task.pk !== `DEVTASK#${shared.taskId}` || task.sk !== "META" || task.entityType !== "DEVELOPER_TASK"
    || task.taskId !== shared.taskId || task.developerId !== shared.developerId || task.ownerKey !== shared.ownerKey
    || task.ownerKey !== taskOwnerKey(task.developerId, task.taskId) || task.project !== shared.project
    || task.workspaceId !== shared.workspaceId || task.closedAt !== undefined || binding.projectName !== task.project
    || task.share?.teamId !== thread.teamId || task.share.channelId !== thread.channelId || task.share.threadTs !== thread.threadTs
    || task.share.mode !== shared.mode || !Number.isSafeInteger(task.shareVersion)) sharedStopForbidden();

  const workspaceItem = await getItem<Record<string, unknown>>(dependencies, workspaceKey(shared.workspaceId));
  const parsedWorkspace = workspaceItem === undefined
    ? undefined
    : WorkspaceInstanceSchema.safeParse(workspaceRecordFields(workspaceItem));
  if (parsedWorkspace === undefined || !parsedWorkspace.success || parsedWorkspace.data.id !== shared.workspaceId
    || parsedWorkspace.data.ownerKey !== task.ownerKey || parsedWorkspace.data.projectName !== task.project) sharedStopForbidden();
  return { task, workspace: parsedWorkspace.data };
}

function sharedStopFences(
  dependencies: AwsBrokerDependencies,
  thread: SlackThread,
  shared: SharedTaskRecord,
  task: DeveloperTaskRecord,
  workspace: WorkspaceInstance,
  peopleRevision: number | undefined,
): ExtraItems {
  const taskShare = task.share!;
  return () => [
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: taskKey(task.taskId),
      ConditionExpression: "taskId = :taskId AND developerId = :developerId AND ownerKey = :ownerKey AND #project = :project AND workspaceId = :workspaceId AND shareVersion = :shareVersion AND #share.#team = :team AND #share.#channel = :channel AND #share.#thread = :thread AND #share.#mode = :mode AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#project": "project", "#share": "share", "#team": "teamId", "#channel": "channelId", "#thread": "threadTs", "#mode": "mode" },
      ExpressionAttributeValues: {
        ":taskId": task.taskId, ":developerId": task.developerId, ":ownerKey": task.ownerKey, ":project": task.project,
        ":workspaceId": workspace.id, ":shareVersion": task.shareVersion, ":team": taskShare.teamId, ":channel": taskShare.channelId,
        ":thread": thread.threadTs, ":mode": "continue",
      },
    } },
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: sharedTaskKey(thread),
      ConditionExpression: "taskId = :taskId AND developerId = :developerId AND ownerKey = :ownerKey AND #project = :project AND workspaceId = :workspaceId AND #mode = :mode AND attribute_not_exists(closedAt) AND attribute_not_exists(workflowThread)",
      ExpressionAttributeNames: { "#project": "project", "#mode": "mode" },
      ExpressionAttributeValues: {
        ":taskId": shared.taskId, ":developerId": shared.developerId, ":ownerKey": shared.ownerKey, ":project": shared.project,
        ":workspaceId": workspace.id, ":mode": "continue",
      },
    } },
    { ConditionCheck: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      ConditionExpression: "ownerKey = :ownerKey AND projectName = :project AND activeOperationId = :operationId AND fence = :fence",
      ExpressionAttributeValues: {
        ":ownerKey": workspace.ownerKey, ":project": workspace.projectName,
        ":operationId": workspace.activeOperationId, ":fence": workspace.fence,
      },
    } },
    taskAccessFence(dependencies.tableName, task.taskId, peopleRevision),
  ];
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

/** DP-E1-R2: reject reread drift and fence the final write, including reviewed absence.
 * Only the internal confirmation path supplies this value; direct binding routes keep their contract.
 */
function reviewedBindingCondition(reviewed: ReviewedChannelBinding | undefined, current: SlackChannelBinding | undefined) {
  if (reviewed === undefined) return {};
  if (reviewed === null ? current !== undefined : current?.projectName !== reviewed.projectName || current.updatedAt !== reviewed.updatedAt) {
    throw agentXError("CHANGE_STALE", "The channel binding changed after review; ask for the change again to review its current binding.");
  }
  return reviewed === null
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : { ConditionExpression: "projectName = :reviewedProject AND updatedAt = :reviewedAt",
      ExpressionAttributeValues: { ":reviewedProject": reviewed.projectName, ":reviewedAt": reviewed.updatedAt } };
}

async function putSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  value: unknown,
  reviewed?: ReviewedChannelBinding,
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
  // DEC 254zzz80 (R2-F1): a NAMED company's binding is written in its own partition, for a project of its own partition; the built-in company as before.
  const named = await slackBindingCompany(dependencies, binding.teamId);
  if (!(named === undefined ? await slackCompanyProject(dependencies, binding.teamId, binding.projectName) : await latestRevisionRowFor(dependencies.documentClient, dependencies.tableName, named, binding.projectName) !== undefined)) {
    throw agentXError("NOT_FOUND", "Slack channel binding not found");
  }
  const existing = await getSlackBinding(dependencies, binding.teamId, binding.channelId);
  if (existing && existing.projectName !== binding.projectName) {
    await requireAdministrator(dependencies, identity, existing.projectName);
  }
  const condition = reviewedBindingCondition(reviewed, existing);
  const latest = await requireLatestProject(dependencies, binding.projectName);
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: { ...slackChannelBindingKeyFor(named, binding.teamId, binding.channelId), ...channelBindingAttributes(channelBindingFromSlack(binding)), updatedBy: identity.ownerKey },
      ...condition,
    }));
  } catch (error) {
    if (reviewed === undefined || !isConditional(error)) throw error;
    throw agentXError("CHANGE_STALE", "The channel binding changed after review; ask for the change again to review its current binding.");
  }
  return { binding, latestRevision: latest.definition.revision };
}

async function deleteSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  reviewed?: ReviewedChannelBinding,
): Promise<{ deleted: true; binding: SlackChannelBinding }> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, teamId, channelId);
  const condition = reviewedBindingCondition(reviewed, binding);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found");
  await requireAdministrator(dependencies, identity, binding.projectName);
  // DEC 254zzz80 (R2-F1): the row the read found: a NAMED company's own (its binding carries companyId), else the legacy one.
  try {
    await dependencies.documentClient.send(new DeleteCommand({
      TableName: dependencies.tableName,
      Key: slackChannelBindingKeyFor((binding as { companyId?: string }).companyId, teamId, channelId),
      ...condition,
    }));
  } catch (error) {
    if (reviewed === undefined || !isConditional(error)) throw error;
    throw agentXError("CHANGE_STALE", "The channel binding changed after review; ask for the change again to review its current binding.");
  }
  return { deleted: true, binding };
}

/** The close preflight's operation, worker invocation and outbox item: the Slack close's and a developer task's. */
function closeOperationParts(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  requestId: string,
  requester: { requestedBy?: OperationRequester },
  now: string,
  discardUnpublished = false,
): { operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number } {
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "close",
    requestId,
    payloadHash: hashJson({ action: "close", workspaceId: workspace.id, discardUnpublished }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requester,
  });
  if (discardUnpublished) operation.discardUnpublished = true;
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

async function closedThreadWorkspaceStartResult(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance & { closedAt: string },
): Promise<SlackWorkspaceCloseStartResult> {
  const closeOperation = workspace.closeOperationId
    ? await requireOperation(dependencies, workspace.id, workspace.closeOperationId)
    : undefined;
  const closePreflight = closeOperation?.kind === "close" && closeOperation.status === "SUCCEEDED"
    ? WorkspaceClosePreflightResultSchema.safeParse(closeOperation.result)
    : undefined;
  return {
    outcome: "CLOSED",
    workspaceId: workspace.id,
    closedAt: workspace.closedAt,
    ...(closeOperation?.kind === "close" && closeOperation.discardUnpublished === true && closePreflight?.success && !closePreflight.data.safeToClose
      ? { discardedUnpublished: true }
      : {}),
  };
}

async function preflightCloseStartResult(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  operationId: string,
): Promise<SlackWorkspaceCloseStartResult> {
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  return { outcome: "PREFLIGHT", workspaceId, operationId: operation.id, status: operation.status };
}

async function commitThreadWorkspaceCloseStart(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  requestId: string,
  idempotencyKey: { pk: string; sk: string },
  discardUnpublished: boolean,
): Promise<SlackWorkspaceCloseStartResult> {
  const now = new Date().toISOString();
  const { operation, outbox, fence } = closeOperationParts(dependencies, workspace, requestId, requesterOf(identity), now, discardUnpublished);
  const operationId = operation.id;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        // closedBy names a Slack member; an adapter conversation's closer is the close operation's requestedBy.
        UpdateExpression: `SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, ${identity.slack ? "closedBy = :requester, " : ""}fence = :fence, updatedAt = :now REMOVE closeError`,
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ...(identity.slack ? { ":requester": identity.slack.requester } : {}),
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
    if (concurrent) return await preflightCloseStartResult(dependencies, concurrent.workspaceId, concurrent.operationId);
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId, status: "ACCEPTED" };
}

async function resolveEarlyThreadCloseStart(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  charging: ReturnType<typeof threadCharging>,
  workspace: WorkspaceInstance,
  discardUnpublished: boolean,
): Promise<SlackWorkspaceCloseStartResult | undefined> {
  if (discardUnpublished) {
    const starter = charging.starterOf(await getItem<Record<string, unknown>>(dependencies, slackThreadKey(identity.ownerKey)));
    if (starter === undefined || starter !== conversationStarterId(identity)) {
      return { outcome: "REFUSED", reason: "not_owner" };
    }
  }
  // Spec 014: a thread that never needed the worker has no compute, so there is nothing to close.
  if (workspace.status === "UNPREPARED") return { outcome: "NOT_FOUND" };
  // #213: a failed preparation that was released holds no slot and has nothing to check, and a
  // lazy turn was told it has no compute; answered as an UNPREPARED thread is.
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    if (charging.starterOf(await getItem<Record<string, unknown>>(dependencies, slackThreadKey(identity.ownerKey))) === undefined) return { outcome: "NOT_FOUND" };
  }
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return await closedThreadWorkspaceStartResult(dependencies, { ...workspace, closedAt: workspace.closedAt });
  }
  if (workspace.status === "CLOSING" && workspace.closeOperationId) {
    return await preflightCloseStartResult(dependencies, workspace.id, workspace.closeOperationId);
  }
  return undefined;
}

async function startThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseStartResult> {
  const charging = threadCharging(dependencies, identity);
  const input = object(value, "thread workspace close request");
  // C11: only the developer closes a shared task, from their AI tool.
  if (identity.sharedTask !== undefined) {
    if (input.includeSharedTask === true) return { outcome: "REFUSED", reason: "shared_task" };
    throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  }
  const requestId = uuid(input.requestId, "requestId");
  if (input.discard_unpublished !== undefined && typeof input.discard_unpublished !== "boolean") {
    throw agentXError("CONFIG_INVALID", "discard_unpublished must be a boolean");
  }
  const discardUnpublished = input.discard_unpublished === true;
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) return { outcome: "NOT_FOUND" };
  const early = await resolveEarlyThreadCloseStart(dependencies, identity, charging, workspace, discardUnpublished);
  if (early !== undefined) return early;

  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
  if (previous) return await preflightCloseStartResult(dependencies, previous.workspaceId, previous.operationId);
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }
  return await commitThreadWorkspaceCloseStart(dependencies, identity, workspace, requestId, idempotencyKey, discardUnpublished);
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

async function assertDiscardUnpublishedAuthorized(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  operation: OperationRecord,
): Promise<void> {
  if (operation.discardUnpublished !== true) return;
  if (identity.channel) {
    // Spec 062: the starter is the linked developer, who must also be the one who asked to discard.
    const thread = await getItem<{ starterDeveloperId?: unknown }>(dependencies, slackThreadKey(identity.ownerKey));
    const requestedBy = operation.requestedBy;
    if (typeof thread?.starterDeveloperId !== "string" || thread.starterDeveloperId !== identity.channel.developer.developerId
      || requestedBy === undefined || !("kind" in requestedBy) || requestedBy.developerId !== thread.starterDeveloperId) {
      throw agentXError("FORBIDDEN", "only the conversation starter who authorized discard may complete this close");
    }
  }
  if (identity.slack) {
    const thread = await getItem<{ starterUserId?: unknown }>(dependencies, slackThreadKey(identity.ownerKey));
    const requestedBy = operation.requestedBy;
    if (typeof thread?.starterUserId !== "string"
      || thread.starterUserId !== identity.slack.requester.userId
      || requestedBy === undefined
      || "kind" in requestedBy
      || requestedBy.userId !== thread.starterUserId
      || requestedBy.teamId !== identity.slack.thread.teamId) {
      throw agentXError("FORBIDDEN", "only the Slack thread starter who authorized discard may complete this close");
    }
  }
}

function closedThreadCompleteResult(
  workspaceId: string,
  operationId: string,
  closedAt: string,
  storageReleased: boolean,
  discardedUnpublished: boolean,
): SlackWorkspaceCloseCompleteResult {
  return {
    outcome: "CLOSED",
    workspaceId,
    operationId,
    closedAt,
    storageReleased,
    ...(discardedUnpublished ? { discardedUnpublished: true } : {}),
  };
}

async function completeSlackThreadClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  slack: NonNullable<AuthenticatedIdentity["slack"]>,
  storageReleased: boolean,
  discardedUnpublished: boolean,
  safeToClose: boolean,
): Promise<SlackWorkspaceCloseCompleteResult> {
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
        ExpressionAttributeValues: { ":closed": "CLOSED", ":closing": "CLOSING", ":closedAt": closedAt, ":operation": operation.id, ":fence": operation.fence },
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
        ExpressionAttributeValues: { ":closedAt": closedAt, ":operation": operation.id },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const closed = await requireWorkspace(dependencies, workspace.id);
    if (closed.status === "CLOSED" && closed.closedAt) {
      return closedThreadCompleteResult(closed.id, operation.id, closed.closedAt, storageReleased, discardedUnpublished);
    }
    throw agentXError("WORKSPACE_BUSY", "workspace close completion conflicted; retry");
  }
  return { outcome: "CLOSED", workspaceId: workspace.id, operationId: operation.id, closedAt, storageReleased, ...(operation.discardUnpublished === true ? { discardedUnpublished: !safeToClose } : {}) };
}

async function completeThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseCompleteResult> {
  const slack = identity.slack;
  const channel = identity.channel;
  if (!slack && !channel) throw agentXError("FORBIDDEN", "a conversation identity is required");
  const input = object(value, "thread workspace close completion");
  if (identity.sharedTask !== undefined) throw agentXError("FORBIDDEN", SHARED_CLOSE_REFUSED);
  uuid(input.requestId, "requestId");
  const operationId = uuid(input.operationId, "operationId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  const operation = await requireOperation(dependencies, workspace.id, operationId);
  if (operation.kind !== "close") throw agentXError("CONFIG_INVALID", "operation is not a workspace close");
  const preflight = operation.status === "SUCCEEDED" ? WorkspaceClosePreflightResultSchema.safeParse(operation.result) : undefined;
  const discardedUnpublished = operation.discardUnpublished === true && preflight?.success === true && !preflight.data.safeToClose;
  if (workspace.status === "CLOSED" && workspace.closedAt && workspace.closeOperationId === operationId) {
    return closedThreadCompleteResult(workspace.id, operationId, workspace.closedAt, closeReleasesStorage(workspace), discardedUnpublished);
  }
  if (operation.kind !== "close" || operation.status !== "SUCCEEDED" || workspace.status !== "CLOSING" || workspace.closeOperationId !== operationId) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace close preflight has not completed safely");
  }
  const parsedPreflight = WorkspaceClosePreflightResultSchema.parse(operation.result);
  if (!parsedPreflight.safeToClose && operation.discardUnpublished !== true) throw agentXError("WORKSPACE_NOT_READY", "workspace contains unpublished work");
  await assertDiscardUnpublishedAuthorized(dependencies, identity, operation);
  await deleteWorkspaceCompute(dependencies, workspace);
  const storageReleased = closeReleasesStorage(workspace);
  if (!slack) {
    return completeChannelThreadClose(dependencies, identity, workspace, operation, storageReleased, discardedUnpublished, parsedPreflight.safeToClose);
  }
  return completeSlackThreadClose(dependencies, identity, workspace, operation, slack, storageReleased, discardedUnpublished, parsedPreflight.safeToClose);
}

/** Spec 062: an adapter conversation's close gives back the charge stored on its thread record, in the close's write. */
async function completeChannelThreadClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  storageReleased: boolean,
  discardedUnpublished: boolean,
  safeToClose: boolean,
): Promise<SlackWorkspaceCloseCompleteResult> {
  const thread = await getItem<{ starterDeveloperId?: unknown; charge?: unknown }>(dependencies, slackThreadKey(identity.ownerKey));
  const charge = storedCharge(thread?.charge);
  if (typeof thread?.starterDeveloperId !== "string" || charge === undefined) throw agentXError("CONFIG_INVALID", "the conversation's starter is missing");
  const closedAt = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closed, closedAt = :closedAt, updatedAt = :closedAt REMOVE activeOperationId, closeError",
        ConditionExpression: "#status = :closing AND closeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":closing": "CLOSING", ":closedAt": closedAt, ":operation": operation.id, ":fence": operation.fence },
      } },
      ...channelThreadReleaseItems({
        tableName: dependencies.tableName, threadKey: slackThreadKey(identity.ownerKey), subject: identity.subject,
        developerId: thread.starterDeveloperId, charge, close: { closedAt, operationId: operation.id },
      }),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const closed = await requireWorkspace(dependencies, workspace.id);
    if (closed.status === "CLOSED" && closed.closedAt) {
      return { outcome: "CLOSED", workspaceId: closed.id, operationId: operation.id, closedAt: closed.closedAt, storageReleased, ...(discardedUnpublished ? { discardedUnpublished: true } : {}) };
    }
    throw agentXError("WORKSPACE_BUSY", "workspace close completion conflicted; retry");
  }
  return { outcome: "CLOSED", workspaceId: workspace.id, operationId: operation.id, closedAt, storageReleased, ...(operation.discardUnpublished === true ? { discardedUnpublished: !safeToClose } : {}) };
}

function parseThreadWorkspaceFlags(input: Record<string, unknown>) {
  // Older deployed Slack services parse a strict response; add discovery metadata only on opt-in.
  const include: IntegrationInclude = {
    integrations: input.includeIntegrations === true,
    connectors: input.includeConnectors === true,
    // A separate opt-in: an older Slack service parses the connectors array with a schema that
    // still requires type "github", so every other resolved connector type is withheld unless the
    // service says it can parse them too.
    allConnectorTypes: input.includeAllConnectorTypes === true,
    // A separate opt-in: the Slack service released before this field existed already sends
    // includeConnectors: true but parses the WORKSPACE result with a strict schema that lacks
    // recoverableOperations. The control plane deploys first, so gating this on includeConnectors
    // would fail every turn until the Slack service caught up.
    recoverableOperations: input.includeRecoverableOperations === true,
    // A separate opt-in (feature 014): services released before the action gate parse strictly.
    actionPolicy: input.includeActionPolicy === true,
  };
  return {
    include,
    includeSettingsRevision: input.includeSettingsRevision === true,
    // Spec 014, a separate opt-in: a service that sends lazyPreparation: true parses status
    // UNPREPARED and prepares compute through POST /v1/threads/workspace/prepare when a tool first
    // needs the worker. Every other service keeps getting a workspace whose compute is prepared now.
    lazyPreparation: input.lazyPreparation === true,
    includeOpenTaskCount: input.includeOpenTaskCount === true,
  };
}

async function ensureSharedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  sharedTask: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  input: Record<string, unknown>,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  // Task mode (a separate opt-in, so a service that never sends it keeps the closed workflow thread): only for exactly
  // the open Slack-started task whose own thread this is.
  const taskAnswer = input.taskAnswer === undefined ? undefined : SlackTaskAnswerRequestSchema.safeParse(input.taskAnswer);
  if (taskAnswer !== undefined && !taskAnswer.success) throw agentXError("CONFIG_INVALID", "taskAnswer needs the task's ID");
  if (taskAnswer?.data.taskId === sharedTask.taskId && sharedTask.taskAnswer === true && identity.slack !== undefined) {
    const answer = await taskAnswerWorkspace(dependencies, identity.slack.thread, sharedTask, taskAnswer.data.commentId, identity);
    if (answer !== undefined) return answer;
  }
  return sharedThreadWorkspace(dependencies, identity, sharedTask, input.includeSharedTask === true, include, includeSettingsRevision);
}

async function prepareUnpreparedThreadWorkspaceNow(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  existing: WorkspaceInstance,
  flags: ReturnType<typeof parseThreadWorkspaceFlags>,
): Promise<SlackThreadWorkspaceResult> {
  // An older Slack service cannot parse UNPREPARED and expects compute now: prepare it at once.
  const prepared = await startThreadPreparation(dependencies, identity, requestId, existing, flags.includeOpenTaskCount);
  if (prepared.outcome !== "WORKSPACE") return prepared;
  const current = await requireWorkspace(dependencies, existing.id);
  const result = await existingThreadWorkspace(dependencies, identity, requestId, current, flags.include, flags.includeSettingsRevision, flags.includeOpenTaskCount);
  return result.outcome === "WORKSPACE" ? { ...result, created: prepared.created } : result;
}

async function resolveExistingThreadWorkspaceResult(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  projectName: string,
  flags: ReturnType<typeof parseThreadWorkspaceFlags>,
): Promise<SlackThreadWorkspaceResult | undefined> {
  const threadWorkspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (threadWorkspace) {
    if (threadWorkspace.status === "CLOSED" && threadWorkspace.closedAt) {
      return { outcome: "CLOSED", workspaceId: threadWorkspace.id, closedAt: threadWorkspace.closedAt };
    }
    if (threadWorkspace.projectName !== projectName) {
      throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
    }
  }
  const existing = threadWorkspace ?? await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
  if (!existing) return undefined;
  if (existing.status === "CLOSED" && existing.closedAt) {
    return { outcome: "CLOSED", workspaceId: existing.id, closedAt: existing.closedAt };
  }
  if (existing.status === "UNPREPARED" && !flags.lazyPreparation) {
    return await prepareUnpreparedThreadWorkspaceNow(dependencies, identity, requestId, existing, flags);
  }
  return existingThreadWorkspace(dependencies, identity, requestId, existing, flags.include, flags.includeSettingsRevision, flags.includeOpenTaskCount, flags.lazyPreparation);
}

async function buildCreatedSlackThreadWorkspaceResult(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  preparation: Awaited<ReturnType<typeof newWorkspacePreparation>>,
  flags: ReturnType<typeof parseThreadWorkspaceFlags>,
): Promise<SlackThreadWorkspaceResult> {
  return {
    outcome: "WORKSPACE",
    workspaceId: preparation.workspace.id,
    status: "PREPARING",
    operationId: preparation.operationId,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, flags.include, dependencies),
    ...(flags.include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(flags.includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
    ...(flags.include.actionPolicy && project.definition.actionPolicy ? { actionPolicy: project.definition.actionPolicy } : {}),
  };
}

async function createEagerSlackThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  projectName: string,
  project: RegisteredProjectRecord,
  slack: NonNullable<AuthenticatedIdentity["slack"]>,
  limits: NonNullable<AwsBrokerDependencies["slack"]>,
  flags: ReturnType<typeof parseThreadWorkspaceFlags>,
): Promise<SlackThreadWorkspaceResult> {
  const effective = await effectiveSlackLimits(dependencies, limits);
  await healMemberSlots(dependencies, slackMemberLimitKey(slack.requester.teamId, slack.requester.userId), effective);
  const { teamId, userId } = slack.requester;
  let preparation: Awaited<ReturnType<typeof newWorkspacePreparation>> | undefined;
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const attempted = await newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId);
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        ...attempted.items,
        { Put: {
          TableName: dependencies.tableName,
          Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: attempted.operationId, workspaceId: attempted.workspace.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // #213: the starter is recorded with the charge, so a failed preparation can always find it.
        ...threadChargeItems(dependencies, identity, effective, attempted.workspace.id),
      ] }));
      preparation = attempted;
      break;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The membership changed since it was read: decide again from the row as it now is, never over it.
      if (await membershipMovedSince(dependencies, identity.ownerKey, projectName, attempted.membership, LEGACY_REVISION_GRANT)) continue;
      const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
      if (concurrent) {
        return existingThreadWorkspace(dependencies, identity, requestId, concurrent, flags.include, flags.includeSettingsRevision, flags.includeOpenTaskCount);
      }
      return threadWorkspaceLimitRefusal(dependencies, teamId, userId, effective, flags.includeOpenTaskCount);
    }
  }
  if (preparation === undefined) throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
  await recordThreadRequester(dependencies, identity, preparation.workspace.id, true);
  return await buildCreatedSlackThreadWorkspaceResult(dependencies, project, preparation, flags);
}

async function ensureThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  const projectName = conversationProjectName(identity);
  if (projectName === undefined || !limits) throw agentXError("FORBIDDEN", "a conversation identity is required");
  const input = object(value, "thread workspace request");
  const requestId = uuid(input.requestId, "requestId");
  const flags = parseThreadWorkspaceFlags(input);
  if (identity.sharedTask !== undefined) {
    return await ensureSharedThreadWorkspace(dependencies, identity, identity.sharedTask, input, flags.include, flags.includeSettingsRevision);
  }
  const existingResult = await resolveExistingThreadWorkspaceResult(dependencies, identity, requestId, projectName, flags);
  if (existingResult !== undefined) return existingResult;
  // New threads use the latest revision; an existing thread keeps the revision its workspace was prepared with.
  const project = slackThreadOwnRow(identity, await requireLatestProject(dependencies, projectName));
  if (flags.lazyPreparation) {
    return createUnpreparedThreadWorkspace(dependencies, identity, requestId, project, flags.include, flags.includeSettingsRevision);
  }
  // Spec 062: an adapter conversation is served by a service that prepares lazily, so it is never charged here.
  if (!slack) throw agentXError("CONFIG_INVALID", "an adapter conversation's workspace is prepared through the prepare route");
  return await createEagerSlackThreadWorkspace(dependencies, identity, requestId, projectName, project, slack, limits, flags);
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
  let workspace: WorkspaceInstance | undefined;
  for (let attempt = 0; attempt < MEMBERSHIP_PREPARATION_ATTEMPTS; attempt += 1) {
    const attempted = unpreparedWorkspace(project, identity.ownerKey);
    const existingMembership = await getMembership(dependencies, identity.ownerKey, projectName, LEGACY_REVISION_GRANT);
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: dependencies.tableName, Item: workspaceItem(attempted), ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: {
          TableName: dependencies.tableName,
          Item: { pk: `OWNER#${identity.ownerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId: attempted.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // Created only when absent; an existing row is required to be as it was read, never rewritten.
        membershipPreparationItem(dependencies, identity.ownerKey, projectName, existingMembership, LEGACY_REVISION_GRANT),
        { Put: {
          TableName: dependencies.tableName,
          Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", workspaceId: attempted.id },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        // Capture creation provenance atomically, before a later participant can touch the thread.
        { Update: {
          TableName: dependencies.tableName,
          Key: slackThreadKey(identity.ownerKey),
          UpdateExpression: "SET #creator = if_not_exists(#creator, :creator)",
          ExpressionAttributeNames: { "#creator": "creator" },
          ExpressionAttributeValues: { ":creator": threadCreator(identity) },
        } },
      ] }));
      workspace = attempted;
      break;
    } catch (error) {
      if (!isConditional(error)) throw error;
      // The membership changed since it was read: decide again from the row as it now is, never over it.
      if (await membershipMovedSince(dependencies, identity.ownerKey, projectName, existingMembership, LEGACY_REVISION_GRANT)) continue;
      // Another first message in this thread created the record.
      const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
      if (concurrent) return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision);
      throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
    }
  }
  if (workspace === undefined) throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
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

/** Who first wrote in the thread: a Slack member, or an adapter conversation's linked developer. */
function threadCreator(identity: AuthenticatedIdentity): Record<string, string> {
  if (identity.slack) return { userId: identity.slack.requester.userId, ...(identity.slack.requesterName === undefined ? {} : { name: identity.slack.requesterName }) };
  if (identity.channel) return { developerId: identity.channel.developer.developerId, name: identity.channel.developer.name };
  throw agentXError("FORBIDDEN", "a conversation identity is required");
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
  const projectName = conversationProjectName(identity);
  if (projectName === undefined || !dependencies.slack) throw agentXError("FORBIDDEN", "a conversation identity is required");
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
    ?? await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.projectName !== projectName) {
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
  const limits = dependencies.slack;
  if (!limits) throw agentXError("FORBIDDEN", "a conversation identity is required");
  const charging = threadCharging(dependencies, identity);
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    // #213: a released failed workspace a lazy turn was told is UNPREPARED; prepared again, charged afresh.
    const pinned = slackThreadOwnRow(identity, await requireProject(dependencies, workspace.projectName, workspace.projectRevision));
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
  await charging.heal(effective);
  // One read of the latest revision feeds every field below, so a revision registered meanwhile
  // cannot mix in. The fence condition refuses the write if the workspace changed since it was read.
  const latest = slackThreadOwnRow(identity, await requireLatestProject(dependencies, workspace.projectName));
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
      ...charging.items(effective, workspace.id),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const current = await requireWorkspace(dependencies, workspace.id);
    if (current.status !== "UNPREPARED") {
      return { outcome: "WORKSPACE", workspaceId: current.id, status: current.status, operationId: current.activeOperationId, created: false };
    }
    // The refusal throws its own WORKSPACE_BUSY, worded for creation, when no limit
    // is reached. Answer with this route's wording instead.
    try {
      const refusal = await charging.refusal(effective, includeOpenTaskCount);
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

/**
 * How a thread's preparation is charged: a Slack thread to its member's and team's counters, an adapter conversation
 * (spec 062) to its linked developer's, which are their Slack member's when they have one (R6).
 */
interface ThreadCharging {
  /** Gives back slots the member's finished developer tasks still hold, when the member is at the limit. */
  heal(effective: SlackServiceConfiguration): Promise<void>;
  /** The charge, joined to the preparation's transaction; a thread already charged fails its starter condition. */
  items(effective: SlackServiceConfiguration, workspaceId: string): TransactItems;
  /** The starter a thread record names, when it holds a charge. */
  starterOf(thread: Record<string, unknown> | undefined): string | undefined;
  /** Holds a retry to the charge a thread still has (#213). */
  heldCheck(starter: string): TransactItems;
  /** LIMIT_REACHED when a counter is full; WORKSPACE_BUSY when neither is. */
  refusal(effective: SlackServiceConfiguration, includeOpenTaskCount: boolean): Promise<SlackThreadWorkspaceResult>;
}

function threadCharging(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): ThreadCharging {
  const threadKey = slackThreadKey(identity.ownerKey);
  const heldCheck = (attribute: string) => (starter: string): TransactItems => [{ ConditionCheck: {
    TableName: dependencies.tableName, Key: threadKey, ConditionExpression: `${attribute} = :starter`, ExpressionAttributeValues: { ":starter": starter },
  } }];
  const slack = identity.slack;
  if (slack) {
    return {
      heal: (effective) => healMemberSlots(dependencies, slackMemberLimitKey(slack.requester.teamId, slack.requester.userId), effective),
      items: (effective, workspaceId) => threadChargeItems(dependencies, identity, effective, workspaceId),
      starterOf: (thread) => (typeof thread?.starterUserId === "string" ? thread.starterUserId : undefined),
      heldCheck: heldCheck("starterUserId"),
      refusal: (effective, includeOpenTaskCount) => threadWorkspaceLimitRefusal(dependencies, slack.requester.teamId, slack.requester.userId, effective, includeOpenTaskCount),
    };
  }
  const channel = identity.channel;
  if (!channel) throw agentXError("FORBIDDEN", "a conversation identity is required");
  const charge = channelCharge(channel, (dependencies.developer ?? dependencies.linking)?.slackTeamId);
  const limitsOf = (effective: SlackServiceConfiguration) => ({ member: effective.memberWorkspaceLimit, organization: effective.organizationWorkspaceLimit });
  return {
    heal: (effective) => healMemberSlots(dependencies, charge.member, effective),
    items: (effective, workspaceId) => channelThreadChargeItems({
      tableName: dependencies.tableName, threadKey, subject: identity.subject, workspaceId, developerId: channel.developer.developerId, charge, limits: limitsOf(effective),
    }),
    starterOf: (thread) => (typeof thread?.starterDeveloperId === "string" ? thread.starterDeveloperId : undefined),
    heldCheck: heldCheck("starterDeveloperId"),
    refusal: async (effective) => {
      const full = await limitReached(dependencies.documentClient, dependencies.tableName, charge, limitsOf(effective));
      if (full === "member") return { outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: effective.memberWorkspaceLimit, starterThreads: [] };
      if (full === "organization") return { outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: effective.organizationWorkspaceLimit, starterThreads: [] };
      throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
    },
  };
}

/**
 * Task mode for the chat agent in a Slack-started task's own thread: a read-only view. No repositories, connectors or
 * actions, no operation and no compute (nothing is created, prepared or charged); `taskContext` is the broker's
 * untrusted-data text about the task. Undefined (the thread stays closed) when the task is closed or its context
 * cannot be built.
 */
async function taskAnswerWorkspace(
  dependencies: AwsBrokerDependencies,
  thread: SlackThread,
  shared: NonNullable<AuthenticatedIdentity["sharedTask"]>,
  commentId: string | undefined,
  identity: AuthenticatedIdentity,
): Promise<SlackThreadWorkspaceResult | undefined> {
  const workspace = await requireWorkspace(dependencies, shared.workspaceId);
  // A merged (or rejected) task gave back its workspace but is not closed: its thread is still answered, which needs no
  // compute. A closed task's thread stays closed (the context below is undefined for it).
  if (workspace.status === "CLOSED" && (await getItem<DeveloperTaskRecord>(dependencies, taskKey(shared.taskId)))?.releasedAt === undefined) return undefined;
  const taskContext = await workflowTaskAnswerContext(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: developerTaskActions(dependencies) },
    { taskId: shared.taskId, workspaceId: shared.workspaceId, thread, ...(commentId === undefined ? {} : { commentId }) },
  );
  if (taskContext === undefined) return undefined;
  const settings = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireLatestProject(dependencies, workspace.projectName)));
  return {
    outcome: "WORKSPACE", mode: "task-answer", workspaceId: workspace.id, status: workspace.status, operationId: null, created: false,
    orchestratorInstructions: settings.definition.orchestratorInstructions, taskContext,
  };
}

/**
 * POST /v1/service/tasks/thread-notes/answered: the chat agent answered a reply in a Slack-started task's thread as a
 * question, so the next step skips it. The call must be from that task's own open thread and name it; the broker then
 * marks the saved reply (and nothing else). A repeat answers the same.
 */
async function markThreadNoteAnswered(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<{ outcome: "ANSWERED" }> {
  if (dependencies.developer === undefined || identity.slack === undefined) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = SlackThreadNoteAnsweredRequestSchema.safeParse(value);
  if (!input.success) throw agentXError("CONFIG_INVALID", "taskId, messageTs and thread are required");
  const { thread } = identity.slack;
  const body = input.data;
  const own = identity.sharedTask;
  if (own?.taskAnswer !== true || own.taskId !== body.taskId || body.thread.teamId !== thread.teamId || body.thread.channelId !== thread.channelId || body.thread.threadTs !== thread.threadTs
    || !await slackWorkspaceEnabled(dependencies, thread)) {
    throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  }
  const outcome = await markWorkflowThreadNoteAnswered({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, { taskId: body.taskId, thread, messageTs: body.messageTs });
  if (outcome === "refused") throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  if (outcome === "missing") throw agentXError("NOT_FOUND", "that reply was not saved for this task");
  return { outcome: "ANSWERED" };
}

/**
 * POST /v1/service/tasks/comments/answered (spec 061 slice 2): AgentX's answer to a task page comment, from the Slack
 * service. The call must come from that task's own open thread and name it; only a comment still waiting for an answer
 * takes one, and a repeat answers the same. The answer becomes AgentX's reply on the page; nothing is posted in Slack.
 */
async function markCommentAnswered(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<{ outcome: "ANSWERED" | "FAILED" }> {
  if (dependencies.developer === undefined || identity.slack === undefined) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = SlackCommentAnsweredRequestSchema.safeParse(value);
  if (!input.success) throw agentXError("CONFIG_INVALID", "taskId, commentId, thread and outcome are required");
  const { thread } = identity.slack;
  const body = input.data;
  const own = identity.sharedTask;
  if (own?.taskAnswer !== true || own.taskId !== body.taskId || body.thread.teamId !== thread.teamId || body.thread.channelId !== thread.channelId || body.thread.threadTs !== thread.threadTs
    || !await slackWorkspaceEnabled(dependencies, thread)) {
    throw agentXError("FORBIDDEN", "this thread is not that task's own thread");
  }
  let state: "answered" | "failed";
  try {
    state = await writeCommentAnswer(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: developerTaskActions(dependencies), now: Date.now },
      { taskId: body.taskId, commentId: body.commentId, outcome: body.outcome, ...(body.outcome === "ANSWERED" ? { text: await withPlainRefs(dependencies, body.taskId, body.commentId, body.text) } : {}) },
    );
  } catch (error) {
    if (isPageRefusal(error)) throw agentXError("IDEMPOTENCY_CONFLICT", "that comment is not waiting for an answer");
    throw error;
  }
  console.log(JSON.stringify({ component: "broker", event: "developer.comment_answer_written", taskId: body.taskId, outcome: state }));
  return { outcome: state === "answered" ? "ANSWERED" : "FAILED" };
}

/**
 * AgentX's answer to a page comment with the plan's labels made plain: "decision d1" names the decision by its question,
 * read from the document and version the question was asked on, and "comment c1" reads "that comment". The model is told
 * not to use them; this is for the one that slips through. Where the document cannot be read, the label is only dropped.
 */
async function withPlainRefs(dependencies: AwsBrokerDependencies, taskId: string, commentId: string, text: string): Promise<string> {
  if (!/\b(?:decisions?|comments?)\s+[dc][1-9][0-9]{0,2}\b/iu.test(text)) return text;
  const decisions = new Map<string, string>();
  try {
    const asked = await getItem<{ document?: string; version?: number }>(dependencies, { pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}` });
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    const entry = task?.workflow?.artifacts.find((artifact) => artifact.type === asked?.document && artifact.version === asked.version);
    if (entry?.format === "structured") {
      const loaded = await loadWorkflowDocument((key) => readObjectText(dependencies, key, EARLIER_PLAN_MAX_BYTES), entry, {}).catch(() => undefined);
      if (loaded?.format === "structured") for (const decision of loaded.plan.decisions) decisions.set(decision.id, decision.question);
    }
  } catch {
    // The labels are still removed below, only without the decision's words.
  }
  return plainPageRefs(text, { decisions });
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
  const settings = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireLatestProject(dependencies, workspace.projectName)));
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
  // Preparation rebuilds the workspace's disk, so it keeps the revision recorded on the workspace
  // (for a Slack thread, the latest revision when its compute was first prepared). Everything the
  // model is told comes from the project's latest registered revision.
  const pinned = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireProject(dependencies, workspace.projectName, workspace.projectRevision)));
  const settings = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireLatestProject(dependencies, workspace.projectName)));
  await recordThreadRequester(dependencies, identity, workspace.id, false);
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
  const entries: unknown[] = tasks instanceof Set ? [...tasks as Set<unknown>] : Array.isArray(tasks) ? tasks : [];
  // Spec 062: an adapter conversation shares the counter's set but is not an AI-tool task.
  return entries.filter((entry) => typeof entry !== "string" || !isConversationChargeMarker(entry)).length;
}

/** The Slack limits with the admin's setting applied (R7); read only when a workspace is created. */
/**
 * Before a Slack thread workspace is charged: a member at the limit first gives back the slots their finished developer
 * tasks still hold (the counter is shared, so they count here too). Best effort; never fails the request.
 */
async function healMemberSlots(dependencies: AwsBrokerDependencies, key: { pk: string; sk: string }, effective: SlackServiceConfiguration): Promise<void> {
  try {
    const member = await getItem<{ count?: number }>(dependencies, key);
    if ((member?.count ?? 0) < effective.memberWorkspaceLimit) return;
    await releaseFinishedTasksOf({ tableName: dependencies.tableName, actions: developerTaskActions(dependencies), documentClient: dependencies.documentClient }, key);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_heal_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}

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
  if (!slack) {
    // Spec 062: an adapter conversation's record names its subject and workspace; its starter is written with its charge.
    if (!identity.channel) return;
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: slackThreadKey(identity.ownerKey),
      UpdateExpression: "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace)",
      ExpressionAttributeNames: { "#entity": "entityType", "#thread": "thread", "#workspace": "workspaceId" },
      ExpressionAttributeValues: { ":entity": "CHANNEL_THREAD", ":thread": identity.subject, ":workspace": workspaceId },
    }));
    return;
  }
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
  if (!slack) {
    if (!identity.channel) return body;
    // Spec 062: the accountable person is the linked developer; the adapter's own user ID stays out of the pull request.
    const attribution = `Requested through ${identity.channel.ref.channel} by ${inertName(identity.channel.developer.name)}.`;
    const attributed = body ? `${body}\n\n---\n${attribution}` : attribution;
    return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
  }
  const thread = await getItem<{ requesters?: Iterable<string> }>(dependencies, slackThreadKey(identity.ownerKey));
  const requesters = [...new Set([...(thread?.requesters ?? []), slack.requester.userId])].sort();
  const link = `https://slack.com/archives/${slack.thread.channelId}/p${slack.thread.threadTs.replace(".", "")}`;
  const attribution = `Requested in Slack thread ${link} by ${requesters.join(", ")}.`;
  const attributed = body ? `${body}\n\n---\n${attribution}` : attribution;
  return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
}

/** C13: who started an operation from a shared thread, for the developer's TASK_BUSY (C14). */
function channelOperation(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): ExtraItems {
  const shared = identity.sharedTask as (NonNullable<AuthenticatedIdentity["sharedTask"]> & { peopleAccessBound?: true; peopleRevision?: number }) | undefined;
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
  } }, ...(shared.peopleAccessBound === true ? [taskAccessFence(dependencies.tableName, shared.taskId, shared.peopleRevision)] : [])];
}

/** Who asked, for the operation record (FR-022): a Slack member or a developer. */
function requesterOf(identity: AuthenticatedIdentity): { requestedBy?: OperationRequester } {
  if (identity.slack) return { requestedBy: identity.slack.requester };
  if (identity.channel) return { requestedBy: channelRequester(identity.channel) };
  if (identity.developer) return { requestedBy: { kind: "developer", developerId: identity.developer.developerId, provider: identity.developer.provider } };
  return {};
}

/** Connector calls come from Slack turns only; their context keeps the Slack requester alone (R13). */
function slackRequesterOf(identity: AuthenticatedIdentity): { requestedBy?: SlackRequester } {
  return identity.slack ? { requestedBy: identity.slack.requester } : {};
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
async function handleThreadPreparationRetryConflict(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  charging: ReturnType<typeof threadCharging>,
  effective: Awaited<ReturnType<typeof effectiveSlackLimits>> | undefined,
  includeOpenTaskCount: boolean,
  error: unknown,
): Promise<{ retry: true; current: WorkspaceInstance } | { retry: false; result: { status: WorkspaceInstance["status"]; operationId: string | null } | SlackThreadWorkspaceResult }> {
  if (!isConditional(error)) throw error;
  const current = await requireWorkspace(dependencies, workspaceId);
  if (current.status !== "PREPARATION_FAILED" || current.activeOperationId) {
    return { retry: false, result: { status: current.status, operationId: current.activeOperationId ?? null } };
  }
  if (effective !== undefined) {
    // The refusal throws its own WORKSPACE_BUSY when no limit is reached.
    try {
      const refusal = await charging.refusal(effective, includeOpenTaskCount);
      if (refusal.outcome === "LIMIT_REACHED") return { retry: false, result: refusal };
    } catch (refusalError) {
      if (!(refusalError instanceof AgentXError) || refusalError.code !== "WORKSPACE_BUSY") throw refusalError;
    }
  }
  return { retry: true, current };
}

async function retryThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
  includeOpenTaskCount: boolean,
): Promise<{ status: WorkspaceInstance["status"]; operationId: string | null } | SlackThreadWorkspaceResult> {
  const limits = dependencies.slack;
  if (!limits) throw agentXError("FORBIDDEN", "a conversation identity is required");
  const charging = threadCharging(dependencies, identity);
  let current = workspace;
  for (let attempt = 0; attempt < THREAD_RETRY_ATTEMPTS; attempt += 1) {
    const starter = charging.starterOf(await getItem<Record<string, unknown>>(dependencies, slackThreadKey(identity.ownerKey)));
    const effective = starter === undefined ? await effectiveSlackLimits(dependencies, limits) : undefined;
    if (effective !== undefined) await charging.heal(effective);
    const charge: TransactItems = effective === undefined ? charging.heldCheck(starter!) : charging.items(effective, current.id);
    try {
      const retried = await retryWorkspacePreparation(dependencies, identity, requestId, identity.ownerKey, project, current, charge);
      return { status: "PREPARING", operationId: retried.operationId };
    } catch (error) {
      const outcome = await handleThreadPreparationRetryConflict(dependencies, workspace.id, charging, effective, includeOpenTaskCount, error);
      if (!outcome.retry) return outcome.result;
      current = outcome.current;
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
  slackThreadOwnRow(identity, await requireProject(dependencies, projectName, revision));
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
  input: { requestId: string; conversationId: string; prompt: string; conversationStarted: boolean; requester: { requestedBy?: OperationRequester }; operationId?: string; shared?: boolean; readiness?: ProjectCommand[]; slackThread?: SlackThread },
  now: string,  /** The Slack thread's identity when a thread asked (acceptTask): its binding's company checks the legacy revision read (slackThreadOwnRow). */
  identity?: AuthenticatedIdentity,
): Promise<{ operation: OperationRecord; outbox: ReturnType<typeof outboxRecord>; fence: number }> {
  const settings = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireLatestProject(dependencies, workspace.projectName)));
  const resolvedModel = await resolveProjectModel(dependencies, settings);
  // #341: a task whose owner connected a working ChatGPT plan runs on it; `model` stays the default it falls back to.
  const chatgpt = dependencies.chatgpt === undefined ? undefined
    : await chatGptTaskSelection(dependencies.chatgpt, chatGptOwner(await workspaceTaskOwner(dependencies, workspace.id), input.requester.requestedBy, developerIdForSlackUser));
  const operationId = input.operationId ?? randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    conversationId: input.conversationId,
    kind: "task",
    requestId: input.requestId,
    payloadHash: hashJson({ conversationId: input.conversationId, prompt: input.prompt }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...input.requester,
  });
  operation.settingsRevision = settings.definition.revision;
  if (chatgpt !== undefined) {
    operation.chatgptDeveloperId = chatgpt.developerId;
    // #342: where a fallback is told when the task ends.
    if (input.slackThread !== undefined) operation.chatgptThread = { teamId: input.slackThread.teamId, channelId: input.slackThread.channelId, threadTs: input.slackThread.threadTs };
  }
  // 25c note 1: the hash above is the request's own; only the worker's copy gets the re-read line.
  const prompt = workerPrompt(input.prompt, input.shared === true);
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
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence, false, false, false, chatgpt !== undefined, false, false, false, false),
    payload: {
      conversationId: input.conversationId,
      prompt,
      conversationStarted: input.conversationStarted,
      ...(resolvedModel.model === undefined ? {} : { model: resolvedModel.model }),
      ...(chatgpt === undefined ? {} : { chatgpt: { model: chatgpt.model } }),
      ...(resolvedModel.diagnostic === undefined ? {} : { modelSelectionDiagnostic: resolvedModel.diagnostic }),
      // Spec 051 (P-1): the checks the worker reruns when the agent finishes. The latest revision's readiness, as
      // publicationProject merges it, since that is what publication gates on. None when the project has none.
      ...((input.readiness ?? settings.definition.readiness).length === 0 ? {} : { readiness: input.readiness ?? settings.definition.readiness }),
    },
  };
  return { operation, outbox: outboxRecord(workspace, invocation), fence };
}

/**
 * The approved setup's source snapshot and proposal, decoded from the stored proposal artifact and independently verified against the registered
 * project, repository, policy and approval digests. Never the prepared checkout, and never trusted beyond what verification re-derives; a stored
 * proposal that cannot be verified is a reason, not a snapshot.
 */
async function readApprovedSetupSource(dependencies: AwsBrokerDependencies, project: RegisteredProjectRecord, policy: E2EPolicy,
  repository: { url: string; name: string }, expectedRepositoryId: string | undefined):
  Promise<{ ok: true; snapshot: E2ESourceSnapshot; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef } | { ok: false; reason: string }> {
  const setupApproval = project.setupApproval;
  if (setupApproval?.decision !== "approve") return { ok: false, reason: "the pinned project has no approved setup" };
  try {
    const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, setupApproval.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
    if (stored === undefined || createHash("sha256").update(stored, "utf8").digest("hex") !== setupApproval.proposalSha256) {
      return { ok: false, reason: "the approved setup proposal is missing or does not match its approval digest" };
    }
    const artifact: unknown = JSON.parse(stored);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return { ok: false, reason: "the approved setup proposal is not an object" };
    const record = artifact as Record<string, unknown>;
    const rawSnapshot = record.snapshot;
    if (!(record.schemaVersion === "project-setup-source-proposal/v1" && record.issuerOwnerKey === project.registeredBy
      && record.repositoryUrl === repository.url && sameJsonContent(record.policy, policy)
      && record.identityMapping && typeof record.identityMapping === "object" && !Array.isArray(record.identityMapping)
      && (record.identityMapping as Record<string, unknown>).registeredRepositoryId === repository.name
      && rawSnapshot && typeof rawSnapshot === "object" && !Array.isArray(rawSnapshot))) {
      return { ok: false, reason: "the approved setup proposal does not belong to this project, repository and policy" };
    }
    const sourceRecord = rawSnapshot as Record<string, unknown>;
    const rawSources = sourceRecord.sources;
    if (!Array.isArray(rawSources)) return { ok: false, reason: "the approved setup proposal holds no source snapshot" };
    const sources = rawSources.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid stored source record");
      const source = raw as Record<string, unknown>;
      if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") {
        throw new Error("invalid stored source record");
      }
      return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
    });
    const decoded = { ...sourceRecord, sources } as unknown as E2ESourceSnapshot;
    const setupProposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(record.proposal), decoded, decoded.candidate);
    if (!(expectedRepositoryId !== undefined && isExactFeatureE2ESourceSnapshot(decoded, expectedRepositoryId, decoded.commitSha)
      && decoded.candidate.digest === setupApproval.candidateDigest && setupProposal.candidateDigest === setupApproval.candidateDigest)) {
      return { ok: false, reason: "the approved setup snapshot does not match the registered repository and its approved candidate" };
    }
    return { ok: true, snapshot: decoded, setupProposal,
      setupApproval: { artifactId: `setup-proposal-${setupApproval.proposalSha256}`, digest: createHash("sha256").update(canonicalJson(E2ESetupProposalSchema.parse(setupProposal)), "utf8").digest("hex") } };
  } catch {
    // A stored setup snapshot that cannot be independently verified is not planner context and not approval authority.
    return { ok: false, reason: "the approved setup snapshot could not be read and verified" };
  }
}

/** Whether the workspace belongs to a developer task with the gated workflow. */
/**
 * #341: a running ChatGPT task's owner's current access token, for the worker's next model requests. The refresh token
 * never leaves the control plane, and only the task the owner's plan was chosen for gets it.
 */
async function chatGptTaskToken(dependencies: AwsBrokerDependencies, operation: OperationRecord): Promise<{ accessToken: string; expiresAt: string }> {
  if (operation.kind !== "task" || operation.chatgptDeveloperId === undefined || dependencies.chatgpt === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "this operation does not run on a ChatGPT plan");
  }
  const token = await dependencies.chatgpt.accessToken(operation.chatgptDeveloperId);
  return { accessToken: token.access, expiresAt: new Date(token.expiresAt).toISOString() };
}

/**
 * #342: a ChatGPT task's worker stopped using the plan. The connection learns why, so the owner's next tasks start
 * right: a plan at its limit waits an hour, a refused connection is revoked, a model list is read again. The task
 * keeps the reason, once, for the warning its thread is shown.
 */
async function recordChatGptFallback(dependencies: AwsBrokerDependencies, operation: OperationRecord, value: unknown): Promise<{ recorded: boolean }> {
  const reason = object(value, "ChatGPT status").reason;
  if (reason !== "limit" && reason !== "revoked" && reason !== "model") throw agentXError("CONFIG_INVALID", "reason must be limit, revoked or model");
  if (operation.kind !== "task" || operation.chatgptDeveloperId === undefined || dependencies.chatgpt === undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "this operation does not run on a ChatGPT plan");
  }
  const developerId = operation.chatgptDeveloperId;
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName, Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET chatgptFallback = :reason", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(chatgptFallback)",
      ExpressionAttributeValues: { ":reason": reason },
    }));
  } catch (error) {
    // Told already (a retried callback): the connection was marked the first time.
    if (isConditional(error)) return { recorded: false };
    throw error;
  }
  if (reason === "limit") await dependencies.chatgpt.markStatus(developerId, "limit-reached");
  else if (reason === "revoked") await dependencies.chatgpt.markStatus(developerId, "revoked");
  else {
    // Best effort: a list that cannot be read now is read at the next model refusal.
    await dependencies.chatgpt.refreshModels(developerId).catch((error: unknown) => {
      console.log(JSON.stringify({ component: "broker", event: "chatgpt.models_refresh_failed", operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
    });
  }
  console.log(JSON.stringify({ component: "broker", event: "chatgpt.fallback", operationId: operation.id, reason }));
  return { recorded: true };
}

/** #341: the developer who owns the task a workspace runs, or undefined for a workspace that runs no developer task. */
async function workspaceTaskOwner(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<string | undefined> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  return pointer === undefined ? undefined : (await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId)))?.developerId;
}

async function gatedTaskWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(workspaceId));
  return pointer !== undefined && (await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId)))?.workflow !== undefined;
}

async function acceptTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
  extra: ExtraItems = () => [],
  options: { sharedTask?: boolean; operationId?: string; readiness?: ProjectCommand[] } = {},
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
  // Gap 10a: a gated developer task's workspace (the retired spec 056 workflow's) takes no ordinary write-capable turn, whoever asks (the owner, a shared-thread service identity, anyone).
  if (await gatedTaskWorkspace(dependencies, workspaceId)) {
    throw agentXError("WORKSPACE_BUSY", GATED_TASK_TURN_REFUSAL);
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
    ...(identity.slack === undefined ? {} : { slackThread: identity.slack.thread }),
    // 25c note 1: a turn from an open shared thread, or the developer's own turn on a shared task.
    shared: identity.sharedTask?.state === "continue" || options.sharedTask === true,
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
  }, now, identity);
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
      // Which of the caller's own items failed (after this function's four), so it can tell its own conditions apart.
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
      throw Object.assign(agentXError("WORKSPACE_BUSY", "workspace already has an active writer"), { extraCancellation: reasons.slice(4).map((reason) => reason.Code ?? "None") });
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

/** The four items every accepted request writes first: the workspace claim, the operation, its outbox row and the idempotency record. */
const ACCEPTANCE_OWN_ITEMS = ["workspace", "operation", "outbox", "idempotency"] as const;

/**
 * A cancelled acceptance transaction, read item by item and logged (item names and DynamoDB reason codes only). When
 * the four own items held and only the caller's extra items failed their conditions, the workspace was not the
 * conflict: the refusal is CONFIG_INVALID naming the extra items, not WORKSPACE_BUSY. `extraCancellation` keeps each
 * extra item's reason in the order the caller built them, so the caller can name which one it was.
 */
function acceptancePullRequestCancellation(error: unknown, context: { workspaceId: string; requestId: string; action: string }): AgentXError {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  const codes = reasons.map((reason) => reason.Code ?? "None");
  console.log(JSON.stringify({ component: "broker", event: "pull_request.acceptance_cancelled", action: context.action,
    workspaceId: context.workspaceId, requestId: context.requestId,
    items: codes.map((code, index) => ({ item: index < ACCEPTANCE_OWN_ITEMS.length ? ACCEPTANCE_OWN_ITEMS[index] : `extra-${index - ACCEPTANCE_OWN_ITEMS.length}`, code })) }));
  const extraCancellation = codes.slice(ACCEPTANCE_OWN_ITEMS.length);
  const ownItemsHeld = codes.length > ACCEPTANCE_OWN_ITEMS.length
    && codes.slice(0, ACCEPTANCE_OWN_ITEMS.length).every((code) => code !== "ConditionalCheckFailed");
  const failedExtras = extraCancellation.flatMap((code, index) => code === "ConditionalCheckFailed" ? [index] : []);
  if (ownItemsHeld && failedExtras.length > 0) {
    return Object.assign(agentXError("CONFIG_INVALID",
      `the records this request depends on changed while it was being accepted (extra item${failedExtras.length === 1 ? "" : "s"} ${failedExtras.join(", ")} failed its condition); the workspace itself was free`), { extraCancellation });
  }
  return Object.assign(agentXError("WORKSPACE_BUSY", "workspace already has an active writer"), { extraCancellation });
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
  // Ruling A: a gated developer task's workspace (the retired spec 056 workflow's) takes no pull request anyone asks for (the owner, a shared thread's teammate, anyone).
  if (await gatedTaskWorkspace(dependencies, workspaceId)) {
    throw agentXError("CONFIG_INVALID", GATED_TASK_PULL_REQUEST_REFUSAL);
  }
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(
      workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY",
      `workspace is ${workspace.status}`,
    );
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace, identity);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const body = await attributedBody(dependencies, identity, request.body);
  const draft = request.draft;

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
    codeBuildGates: codeBuildGatesOf(repository),
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
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
      throw acceptancePullRequestCancellation(error, { workspaceId, requestId: request.requestId, action: "publish" });
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

async function loadVerifiedLifecyclePullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  request: ReturnType<typeof PullRequestLifecycleRequestSchema.parse>,
) {
  const { project, settingsRevision } = await publicationProject(dependencies, workspace, identity);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const existingRecord = await getItem<PullRequestRecord>(
    dependencies,
    pullRequestKey(workspace.id, request.repository, request.pullRequestNumber),
  );
  const remote = await dependencies.githubPullRequests.getPullRequest(repository.url, request.pullRequestNumber);
  const record = existingRecord ?? await adoptLegacyPullRequest(
    dependencies,
    workspace.id,
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
  return { project, settingsRevision, repository, remote, record };
}

async function executeMetadataPullRequestLifecycle(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  request: ReturnType<typeof PullRequestLifecycleRequestSchema.parse> & { action: "edit" | "close" | "reopen" },
  record: PullRequestRecord,
  remote: Awaited<ReturnType<AwsBrokerDependencies["githubPullRequests"]["getPullRequest"]>>,
  meta: { operationId: string; now: string; requestHash: string; idempotencyKey: { pk: string; sk: string } },
  extra: ExtraItems,
): Promise<{ operation: Operation; duplicate: false }> {
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
    id: meta.operationId, workspaceId: workspace.id, kind: "maintain", requestId: request.requestId,
    payloadHash: meta.requestHash, status: "SUCCEEDED", fence: workspace.fence,
    createdAt: meta.now, updatedAt: meta.now, result,
    ...requesterOf(identity),
  });
  const updatedRecord: PullRequestRecord = {
    ...record,
    state: updated.state,
    expectedHeadCommit: updated.headCommit,
    title: updated.title,
    body: updated.body,
    updatedAt: meta.now,
  };
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: updatedRecord } },
    { Put: {
      TableName: dependencies.tableName,
      Item: { ...meta.idempotencyKey, entityType: "IDEMPOTENCY", operationId: meta.operationId, payloadHash: meta.requestHash },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra(publicOperation(operation)),
  ] }));
  return { operation: publicOperation(operation), duplicate: false };
}

function assertPullRequestWorkspaceReady(workspace: WorkspaceInstance): void {
  if (!["READY", "STOPPED"].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
}

async function enqueueReplaceOrRevertPullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  target: { project: RegisteredProjectRecord; settingsRevision: number; repository: ProjectDefinition["repositories"][number]; record: PullRequestRecord; remote: Awaited<ReturnType<AwsBrokerDependencies["githubPullRequests"]["getPullRequest"]>> },
  request: ReturnType<typeof PullRequestLifecycleRequestSchema.parse> & { action: "replace" | "revert" },
  meta: { operationId: string; now: string; requestHash: string; idempotencyKey: { pk: string; sk: string } },
  extra: ExtraItems,
): Promise<{ operation: Operation; duplicate: false }> {
  const { project, settingsRevision, repository, record, remote } = target;
  if (request.action === "replace" && remote.state !== "open") {
    throw agentXError("CONFIG_INVALID", "only an open pull request can be replaced");
  }
  if (request.action === "revert" && (remote.state !== "merged" || !remote.mergeCommit)) {
    throw agentXError("CONFIG_INVALID", "only a merged pull request with a merge commit can be reverted");
  }
  assertPullRequestWorkspaceReady(workspace);
  const fence = workspace.fence + 1;
  const title = request.title ?? `${request.action === "replace" ? "Replace" : "Revert"}: ${remote.title}`;
  const baseBody = request.body ?? (request.action === "replace"
    ? `Clean replacement for #${record.number}.`
    : `Reverts merged pull request #${record.number}.`);
  const body = (await attributedBody(dependencies, identity, baseBody)) ?? baseBody;
  const headBranch = `agentx/${meta.operationId}`;
  const operation = operationRecord({
    id: meta.operationId, workspaceId: workspace.id, kind: "publish", requestId: request.requestId,
    payloadHash: meta.requestHash, status: "ACCEPTED", fence, createdAt: meta.now, updatedAt: meta.now,
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
    codeBuildGates: codeBuildGatesOf(repository),
    mode: request.action,
    targetPullRequestNumber: record.number,
    ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "publish",
    operationId: meta.operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, meta.operationId, fence, true),
    payload: {
      mode: request.action,
      project: project.definition,
      repository: record.repository,
      title,
      body,
      headBranch,
      repositoryGrant: issueRepositoryGrant(
        dependencies, project, identity.ownerKey, workspace.id, meta.operationId, "push", record.repository,
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
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
      ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
        ":operation": meta.operationId, ":fence": fence, ":now": meta.now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: { ...meta.idempotencyKey, entityType: "IDEMPOTENCY", operationId: meta.operationId, payloadHash: meta.requestHash },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra(publicOperation(operation)),
  ] }));
  return { operation: publicOperation(operation), duplicate: false };
}

async function enqueueMaintainPullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  target: { project: RegisteredProjectRecord; settingsRevision: number; repository: ProjectDefinition["repositories"][number]; record: PullRequestRecord; remote: Awaited<ReturnType<AwsBrokerDependencies["githubPullRequests"]["getPullRequest"]>> },
  request: ReturnType<typeof PullRequestLifecycleRequestSchema.parse> & { action: "append" | "sync" },
  meta: { operationId: string; now: string; requestHash: string; idempotencyKey: { pk: string; sk: string } },
  extra: ExtraItems,
): Promise<{ operation: Operation; duplicate: false }> {
  const { project, settingsRevision, repository, record, remote } = target;
  if (remote.state !== "open") throw agentXError("CONFIG_INVALID", "only an open pull request can be maintained");
  if (!["READY", "STOPPED"].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: meta.operationId, workspaceId: workspace.id, kind: "maintain", requestId: request.requestId,
    payloadHash: meta.requestHash, status: "ACCEPTED", fence, createdAt: meta.now, updatedAt: meta.now,
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
    codeBuildGates: codeBuildGatesOf(repository),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "maintain",
    operationId: meta.operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, meta.operationId, fence, true),
    payload: {
      action: request.action,
      project: project.definition,
      repository: record.repository,
      pullRequestNumber: record.number,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      expectedHeadCommit: record.expectedHeadCommit,
      repositoryGrant: issueRepositoryGrant(
        dependencies, project, identity.ownerKey, workspace.id, meta.operationId, "push", record.repository,
      ),
    },
  };
  const outbox = outboxRecord(workspace, invocation);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
      ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
        ":operation": meta.operationId, ":fence": fence, ":now": meta.now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: { ...meta.idempotencyKey, entityType: "IDEMPOTENCY", operationId: meta.operationId, payloadHash: meta.requestHash },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
    ...extra(publicOperation(operation)),
  ] }));
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
  // Ruling A: nothing replaces, reverts, edits, closes or reopens a gated task's (the retired spec 056 workflow's) pull request through AgentX on request.
  if (await gatedTaskWorkspace(dependencies, workspaceId)) throw agentXError("CONFIG_INVALID", GATED_TASK_PULL_REQUEST_ACTION_REFUSAL);
  const target = await loadVerifiedLifecyclePullRequest(dependencies, identity, workspace, request);
  const meta = { operationId: randomUUID(), now: new Date().toISOString(), requestHash, idempotencyKey };
  if (request.action === "edit" || request.action === "close" || request.action === "reopen") {
    return await executeMetadataPullRequestLifecycle(dependencies, identity, workspace, { ...request, action: request.action }, target.record, target.remote, meta, extra);
  }
  if (request.action === "replace" || request.action === "revert") {
    return await enqueueReplaceOrRevertPullRequest(dependencies, identity, workspace, target, { ...request, action: request.action }, meta, extra);
  }
  if (request.action !== "append" && request.action !== "sync") {
    throw agentXError("CONFIG_INVALID", "pull request action is not supported");
  }
  return await enqueueMaintainPullRequest(dependencies, identity, workspace, target, { ...request, action: request.action }, meta, extra);
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
): Promise<TaskCancellation | CoreStopOutcome> {
  const core = await coreAdminStop(dependencies, dependencies.developer?.coreTasks, identity, workspaceId, (project) => requireAdministratorGrant(dependencies, identity, project)); if (core !== undefined) return core; // S2: a core task's workspace: the core's stop (core-stop-entry.ts), which binds the grant to the task's company itself (D2)
  const workspace = await requireWorkspace(dependencies, workspaceId); await requireAdministrator(dependencies, identity, workspace.projectName);
  return cancelRunningTask(dependencies, workspace, {});
}

/** Resolve on each backend execution, including requests that waited in a queue. */
async function companySlackCaller(dependencies: AwsBrokerDependencies, thread: SlackThread, userId: string): Promise<DeveloperCaller> {
  const legacy = slackWorkflowCaller(userId);
  if (dependencies.workspaces === undefined) return legacy;
  try {
    const person = await slackCompanyPerson(dependencies, thread.teamId, userId);
    if (person.kind === "linked") return { developerId: person.personId, sessionId: legacy.sessionId, amr: legacy.amr, name: "Rovara member" };
  } catch { /* One refusal, no directory or member diagnostics. */ }
  throw agentXError("FORBIDDEN", SLACK_WEB_SIGNIN_NOTICE);
}

async function slackWorkspaceEnabled(dependencies: AwsBrokerDependencies, thread: SlackThread): Promise<boolean> {
  if (dependencies.workspaces === undefined) return dependencies.developer?.slackTeamId === thread.teamId;
  return await getSlackBinding(dependencies, thread.teamId, thread.channelId) !== undefined;
}

async function requireSlackTaskCompany(dependencies: AwsBrokerDependencies, thread: SlackThread, taskId: string): Promise<void> {
  if (dependencies.workspaces === undefined) return;
  try {
    const company = await dependencies.workspaces.requireCompany(thread.teamId);
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
    if (recordInCompany(task, company) && task !== undefined && await slackCompanyProject(dependencies, thread.teamId, task.project)) return;
  } catch { /* A foreign, missing or unreadable task has the same answer. */ }
  throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
}

async function handleSlackTaskPeople(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions,
  event: SlackTaskPeopleReadEvent | SlackTaskPeopleChangeEvent | SlackTaskPeopleTakeOwnershipEvent) {
  if (dependencies.workspaces !== undefined) throw agentXError("FORBIDDEN", SLACK_WEB_SIGNIN_NOTICE);
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await companySlackCaller(dependencies, thread, SlackRequesterSchema.shape.userId.parse(event.userId));
  const taskId = randomUUIDSchema.parse(event.taskId);
  const routeDeps = developerTaskRouteDependencies({ ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  const access = await resolveTaskAccess(routeDeps, caller, taskId, event.action === "task-people-read" ? "read" : event.action === "task-people-change" ? "peopleManage" : "takeOwnership");
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  }
  if (event.action === "task-people-read") return getTaskPeople(routeDeps, caller, taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  if (!Number.isSafeInteger(event.expectedPeopleRevision) || event.expectedPeopleRevision < 1) throw agentXError("CONFIG_INVALID", "People revision is invalid");
  if (event.action === "task-people-take-ownership") return submitSlackTaskOwnership(routeDeps, caller, taskId, { requestId, expectedPeopleRevision: event.expectedPeopleRevision });
  return submitSlackTaskPeopleRole(routeDeps, caller, taskId, { requestId, expectedPeopleRevision: event.expectedPeopleRevision,
    slackUserId: SlackRequesterSchema.shape.userId.parse(event.slackUserId), role: event.role, teamId: thread.teamId, channelId: thread.channelId });
}

async function confirmSlackTaskPeople(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskPeopleConfirmEvent) {
  if (dependencies.workspaces !== undefined) throw agentXError("FORBIDDEN", SLACK_WEB_SIGNIN_NOTICE);
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await companySlackCaller(dependencies, thread, SlackRequesterSchema.shape.userId.parse(event.userId));
  const taskId = randomUUIDSchema.parse(event.taskId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const routeDeps = developerTaskRouteDependencies({ ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  const access = await resolveTaskAccess(routeDeps, caller, taskId, "read");
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  return confirmTaskPeopleProposal(routeDeps, caller, taskId, requestId);
}

async function authorizeSlackTaskAction(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, event: SlackTaskAuthorizationEvent) {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  const caller = await companySlackCaller(dependencies, thread, SlackRequesterSchema.shape.userId.parse(event.userId));
  const taskId = randomUUIDSchema.parse(event.taskId);
  await requireSlackTaskCompany(dependencies, thread, taskId);
  const routeDeps = developerTaskRouteDependencies({ ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks }, caller);
  // This signed UI port reports the current lifecycle state (for example, a retired button) after
  // a fresh read+role check. The separately invoked mutation route still requires an open task.
  const access = await resolveTaskAccess(routeDeps, caller, taskId, "read");
  if (!can(access.role, event.taskAction)) throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  if (access.task.share?.teamId !== thread.teamId || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) {
    throw agentXError("FORBIDDEN", "this task belongs to another Slack thread");
  }
  return { authorized: true };
}

async function startSlackWorkflow(view: AwsBrokerDependencies, event: SlackWorkflowStartEvent) {
  if (view.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const thread = SlackThreadSchema.parse(event.thread);
  // DEC 254zzz80 (R2-F1): the install team of a NAMED company starts as that company (its linked person, its own binding, the core); the built-in company as before.
  const dependencies = await namedInstallTeamView(view, thread.teamId);
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  const caller = await companySlackCaller(dependencies, thread, userId);
  const requestId = randomUUIDSchema.parse(event.requestId);
  const instructions = event.instructions.trim();
  if (!instructions || Buffer.byteLength(instructions, "utf8") > 65_536) throw agentXError("CONFIG_INVALID", "workflow request is empty or too long");
  if (!await slackWorkspaceEnabled(dependencies, thread)) throw agentXError("FORBIDDEN", "Slack workspace is not enabled for developer tasks");
  const binding = await getSlackBinding(dependencies, thread.teamId, thread.channelId);
  if (binding === undefined) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  const existingWorkflowThread = await getItem<Record<string, unknown>>(dependencies, sharedTaskKey(thread));
  const threadOwnerKey = ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, slackThreadSubject(thread));
  const existingThreadTask = await getItem<{ workspaceId?: string; closedAt?: string }>(dependencies, slackThreadKey(threadOwnerKey));
  // L4-U5c: in company mode, this company's own guard row for THIS request id is Slack's retry of the same event (it goes on to the core, whose idempotency answers the first task); any other row is a thread that already has a task.
  const company = dependencies.workspaces === undefined ? undefined : await dependencies.workspaces.requireCompany(thread.teamId);
  if ((existingWorkflowThread !== undefined && !isOwnSlackStart(existingWorkflowThread, { companyId: company, requestId })) || (typeof existingThreadTask?.workspaceId === "string" && existingThreadTask.closedAt === undefined)) throw agentXError("WORKSPACE_BUSY", "this Slack thread already has a task; start the workflow in a new thread");
  // L4-U5b: a company the core serves starts the task on the core (no channel share: the core has none) and remembers this Slack thread, so the task's pause at Build, its pull request and its end are told here too.
  // Only where Slack runs in company mode (the thread can then be remembered and told); the single-workspace install keeps the start it always had.
  const onCore = dependencies.workspaces === undefined || company === undefined ? undefined : await startSlackWorkflowOnCore(dependencies.developer.coreTasks, { caller, companyId: company, thread, userId, requestId, project: binding.projectName, instructions, workflowPath: event.workflowPath },
    brokerLogLine);
  if (onCore !== undefined) return { task: { taskId: onCore.taskId } };
  // The single-workspace install (no company mode) keeps the start it always had: the developer start route, which starts on the core where this install has one and otherwise refuses with the route's fixed words (the spec 056 workflow no longer starts tasks, #1275).
  const developer = dependencies.workspaces === undefined ? dependencies.developer : { ...dependencies.developer, slackTeamId: thread.teamId };
  const routeDeps = developerTaskRouteDependencies({ ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now }, caller, thread);
  const request = {
    method: "POST", path: "/v1/dev/tasks", headers: {}, requestId,
    body: JSON.stringify({ requestId, project: binding.projectName, instructions, client: "slack", workflow: true, workflowPath: event.workflowPath, shareToChannel: true, channel: thread.channelId }),
  };
  return await routeDeveloperTaskRequest(routeDeps, caller, request, new URL(request.path, "https://agentx.invalid")) as { task: { taskId: string } };
}

/**
 * DEC 254zzz80 (R2-F1), DEC 254zzz95: the dependencies a Slack start, and every install-team Slack action, runs with. In the install team's legacy view, when the team's operator binding names a NAMED company, the start is that
 * company's: the company path's own `workspaces` and membership reader (installTeamCompanyMode), so the caller is the linked Rovara person, the binding is the company's own row
 * and the task starts on the core for that company. Every other case (the company handler, another team, the built-in company, company mode off) is returned unchanged.
 */
async function namedInstallTeamView(dependencies: AwsBrokerDependencies, teamId: string): Promise<AwsBrokerDependencies> {
  const mode = dependencies.installTeamCompanyMode;
  if (dependencies.workspaces !== undefined || mode === undefined || dependencies.slackInstallTeamOnly === undefined || teamId !== dependencies.slackInstallTeamOnly) return dependencies;
  if (await slackBindingCompany(dependencies, teamId) === undefined) return dependencies;
  const { slackInstallTeamOnly: _only, installTeamCompany: _company, installTeamCompanyMode: _mode, ...rest } = dependencies;
  void _only; void _company; void _mode;
  return { ...rest, workspaces: mode.workspaces, ...(mode.companies === undefined ? {} : { companies: mode.companies }) };
}

const slackIntakeKey = (choiceId: string) => ({ pk: `SLACK_INTAKE#${choiceId}`, sk: "META" as const });

/** The routed request's record: one per choice (a redelivery writes nothing), kept a few minutes, used once. */
async function recordSlackIntake(dependencies: AwsBrokerDependencies, event: SlackIntakeRecordEvent): Promise<{ recorded: boolean }> {
  const choiceId = randomUUIDSchema.parse(event.choiceId);
  const thread = SlackThreadSchema.parse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.parse(event.userId);
  await companySlackCaller(dependencies, thread, userId);
  if (dependencies.workspaces !== undefined && !await slackWorkspaceEnabled(dependencies, thread)) throw agentXError("NOT_FOUND", "Slack channel binding not found");
  const text = event.text.trim();
  if (!text || text.length > REQUEST_ROUTE_MESSAGE_MAX) throw agentXError("CONFIG_INVALID", "the request is empty or too long");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  try {
    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: {
      ...slackIntakeKey(choiceId), entityType: "SLACK_INTAKE", choiceId, teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs,
      userId, text, createdAt: new Date().toISOString(), expiresAt: nowSeconds + SLACK_INTAKE_RECORD_SECONDS,
    }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    return { recorded: false };
  }
  return { recorded: true };
}

/**
 * Decision 134: the Slack service's ask to start Quick on a routed request its classifier read as a clear small change.
 * The text and the requester come from the broker's own intake record of that message (written by the Slack ingress
 * from the verified Slack event), never from the Slack service: the record must belong to this thread and this person,
 * be unexpired, and is used once. Only a new request's own thread (no task there yet), only text the broker's check
 * finds clear and not high risk; the start is the same as the requester's Start press (same member, project, limits
 * and admission), and its plan comes first. Anything else answers `started: false`, and the Slack service posts the card.
 */
async function startQuickFromIntake(dependencies: AwsBrokerDependencies, tasks: DeveloperTaskActions, identity: AuthenticatedIdentity, body: unknown): Promise<QuickAutoStartResult> {
  const slack = identity.slack;
  if (slack === undefined) throw agentXError("FORBIDDEN", "only a Slack thread may start a quick change");
  const parsed = QuickAutoStartRequestSchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "a quick start names only its request");
  const choiceId = parsed.data.requestId;
  const record = await getItem<{ teamId?: unknown; channelId?: unknown; threadTs?: unknown; userId?: unknown; text?: unknown; expiresAt?: unknown; usedAt?: unknown }>(dependencies, slackIntakeKey(choiceId));
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (record === undefined || typeof record.text !== "string" || typeof record.userId !== "string" || typeof record.expiresAt !== "number"
    || record.expiresAt <= nowSeconds || record.usedAt !== undefined) return { started: false, reason: "not_recorded" };
  if (record.teamId !== slack.thread.teamId || record.channelId !== slack.thread.channelId || record.threadTs !== slack.thread.threadTs || record.userId !== slack.requester.userId) {
    throw agentXError("FORBIDDEN", "this request belongs to another thread or person");
  }
  if (identity.sharedTask !== undefined) return { started: false, reason: "thread_busy" };
  const refusal = quickAutoStartRefusal(record.text);
  if (refusal !== undefined) return { started: false, reason: refusal };
  // Used once: a second ask for the same message (or a replay of this one) starts nothing.
  try {
    await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: slackIntakeKey(choiceId), UpdateExpression: "SET usedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt) AND expiresAt > :nowSeconds AND teamId = :team AND channelId = :channel AND threadTs = :ts AND userId = :user",
      ExpressionAttributeValues: { ":now": new Date().toISOString(), ":nowSeconds": nowSeconds, ":team": slack.thread.teamId, ":channel": slack.thread.channelId, ":ts": slack.thread.threadTs, ":user": slack.requester.userId } }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    return { started: false, reason: "not_recorded" };
  }
  try {
    const started = await startSlackWorkflow(dependencies, {
      source: "agentx.slack-ingress", action: "start-workflow", thread: slack.thread, userId: record.userId,
      instructions: record.text, workflowPath: "QUICK", requestId: choiceId,
    });
    return { started: true, taskId: started.task.taskId };
  } catch (error) {
    if (error instanceof AgentXError) return { started: false, reason: "start_refused", code: error.code };
    throw error;
  }
}

const randomUUIDSchema = { parse(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw agentXError("CONFIG_INVALID", "workflow request ID is invalid"); return value; } };

/**
 * Resolves the signed Slack actor. A task with PEOPLE uses the canonical native principal. A
 * pre-PEOPLE Slack task may retain its stored native creator ID; exact-thread teammates retain the
 * legacy commenter input path. Linked OIDC principals are never substituted for the Slack actor.
 */
async function slackTaskAccess(
  dependencies: AwsBrokerDependencies,
  tasks: DeveloperTaskActions,
  taskId: string,
  userId: string,
  action: TaskAction,
  legacySlackOwner = false,
  thread?: SlackThread,
): Promise<{ caller: DeveloperCaller; routeDeps: ReturnType<typeof developerTaskRouteDependencies>; access: TaskAccess }> {
  if (dependencies.developer === undefined) throw agentXError("NOT_FOUND", "developer task workflows are not configured");
  if (dependencies.workspaces !== undefined && thread !== undefined) await requireSlackTaskCompany(dependencies, thread, taskId);
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId));
  if (task === undefined) throw agentXError("FORBIDDEN", "task access could not be verified");
  // Lane E2: a task the core owns is never acted on from the workflow's Slack paths (engine-boundary.ts), not even as the legacy commenter below.
  if (await isCoreTaskThatExists(dependencies, taskId)) throw agentXError("FORBIDDEN", "task access could not be verified");
  const sidecar = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${taskId}`, sk: "PEOPLE" });
  if (dependencies.workspaces !== undefined && thread === undefined) throw agentXError("FORBIDDEN", SLACK_WEB_SIGNIN_NOTICE);
  const canonical = await companySlackCaller(dependencies, thread ?? { teamId: "", channelId: "", threadTs: "" }, userId);
  if (thread !== undefined) await requireSlackTaskCompany(dependencies, thread, taskId);
  const caller = dependencies.workspaces === undefined && sidecar === undefined && legacySlackOwner && task.provider === "slack" && task.slackUserId === userId
    ? { ...canonical, developerId: task.developerId, name: task.developerName }
    : canonical;
  const routeDeps = developerTaskRouteDependencies({ ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName,
    developer: dependencies.developer, now: Date.now, tasks }, caller);
  try {
    return { caller, routeDeps, access: await resolveTaskAccess(routeDeps, caller, taskId, action) };
  } catch (error) {
    // A verified Slack message/service call in the task's exact linked thread is the legacy
    // commenter proof. The caller validates that exact thread before using this result.
    if (dependencies.workspaces !== undefined || sidecar !== undefined || action !== "comment" || task.share === undefined) throw error;
    return { caller, routeDeps, access: { task, role: "commenter", ownerActorIds: [taskOwnerKey(task.developerId, task.taskId)] } };
  }
}

/**
 * Gap 2: a reply anyone posted in a Slack-started task's own thread, saved as input for the task's next step.
 * Every expected answer (saved, already saved, or not saved because the thread or task no longer takes notes)
 * is a 200 with its outcome, so Slack is never asked to retry it.
 */
async function recordSlackThreadNote(dependencies: AwsBrokerDependencies, event: SlackThreadNoteEvent): Promise<{ outcome: "captured" | "duplicate" | "refused" | "small_talk"; notice?: ThreadInputNotice; core?: true }> {
  if (dependencies.developer === undefined) return { outcome: "refused" };
  const thread = SlackThreadSchema.safeParse(event.thread);
  const userId = SlackRequesterSchema.shape.userId.safeParse(event.userId);
  const taskId = event.taskId;
  const messageTs = SlackMessageTimestampSchema.safeParse(event.messageTs);
  if (!thread.success || !userId.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId) || !messageTs.success || !await slackWorkspaceEnabled(dependencies, thread.data)) return { outcome: "refused" };
  const shared = await getItem<{ taskId?: string; workflowThread?: unknown; closedAt?: string; companyId?: unknown }>(dependencies, sharedTaskKey(thread.data));
  if (shared === undefined || shared.taskId !== taskId || shared.workflowThread !== true || shared.closedAt !== undefined) return { outcome: "refused" };
  const forCore = await coreThreadNote(dependencies, dependencies.developer.coreTasks, { shared: { taskId, companyId: shared.companyId }, thread: thread.data, userId: userId.data, messageTs: messageTs.data, text: event.text, mention: event.mention === true, smallTalk: event.smallTalk === true, companyOf: async () => dependencies.workspaces?.requireCompany(thread.data.teamId), caller: () => companySlackCaller(dependencies, thread.data, userId.data) }); if (forCore !== undefined) return forCore; /* L4-U5d: a task the core owns takes the reply as the core's own input (slack-core-thread-input.ts). */
  // D1: anything else is a task the retired spec 056 workflow started: its thread takes no reply any more.
  return { outcome: "refused" };
}

async function stopSlackThreadTask(dependencies: AwsBrokerDependencies, event: SlackStopTaskEvent): Promise<TaskCancellation | CoreStopOutcome | { outcome: "NOT_OWNER" }> {
  const thread = SlackThreadSchema.parse(event.thread);
  const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: event.userId });
  const caller = await companySlackCaller(dependencies, thread, requester.userId);
  const binding = await getSlackBinding(dependencies, thread.teamId, thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  // Q8: in a continue thread a teammate's stop cancels the task's running task operation, whoever
  // started it, as the developer's own cancel would. A view-only or closed thread, or one whose
  // channel now serves another project (F16), stops nothing.
  const shared = await sharedThread(dependencies, thread); const core = await coreThreadStop(dependencies, dependencies.developer?.coreTasks, shared, binding, async () => caller); if (core !== undefined) return core; // S2: a thread whose task the core owns: the core's own authorized stop as this Slack person
  // A task started in Slack is driven from its own thread: the core's was answered above. D1: a workflow thread the core does not own is the retired spec 056 workflow's, with nothing running.
  if (shared?.workflowThread === true) return { outcome: "NOTHING_RUNNING" };
  if (shared !== undefined) {
    if (!sharedThreadOpen(shared, binding)) return { outcome: "NOTHING_RUNNING" };
    const { task, workspace } = await verifiedSharedStopBinding(dependencies, thread, binding, shared);
    // A strongly read absence preserves FR-054's verified legacy teammate stop. Any present or
    // unreadable sidecar stays under current People authorization; only the transaction fence below
    // can turn the observed absence into a cancellation.
    const people = await getItem<Record<string, unknown>>(dependencies, { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" });
    if (people === undefined) {
      return cancelRunningTask(dependencies, workspace, { requestedBy: requester },
        sharedStopFences(dependencies, thread, shared, task, workspace, undefined));
    }
    if (dependencies.developer === undefined) return { outcome: "NOT_OWNER" };
    let access: TaskAccess;
    try { ({ access } = await slackTaskAccess(dependencies, developerTaskActions(dependencies), task.taskId, requester.userId, "control", true, thread)); }
    catch { return { outcome: "NOT_OWNER" }; }
    if (access.peopleRevision === undefined || access.task.share?.teamId !== thread.teamId
      || access.task.share.channelId !== thread.channelId || access.task.share.threadTs !== thread.threadTs) return { outcome: "NOT_OWNER" };
    return cancelRunningTask(dependencies, workspace, { requestedBy: requester },
      sharedStopFences(dependencies, thread, shared, task, workspace, access.peopleRevision));
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
  if (!token) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required"); refuseBrowserEvidenceOnCloud(action); // TE-H1: browser evidence is not on Cloud yet (DEFERRED 1b-X5)
  // #201 Release A: accept the child format before any reconciler starts issuing it. The key
  // family is selected by the envelope, never by unverified claims or signature fallback.
  const cancelClaims = token.startsWith("cancel-v1.")
    ? verifyCancelCallbackCapability(dependencies.callbackSigningKey, token, action)
    : undefined;
  const claims = cancelClaims ?? verifyCapability(dependencies, token, action as CallbackClaims["actions"][number]);
  if (claims.workspaceId !== workspaceId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
  } if (action === EVAL_PLAN_DELIVERY_ACTION) throw agentXError("NOT_FOUND", "this callback is not available on this install"); // DEC 253c: only the core callback layer holds the eval sources; refused after the capability check, before any read
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
  if (action === "chatgpt-token") return json(await chatGptTaskToken(dependencies, operation), request.requestId);
  if (action === "chatgpt-status") return json(await recordChatGptFallback(dependencies, operation, parseBody(request.body)), request.requestId);
  const body = parseBody(request.body);
  if (action === "events") {
    const accepted = await appendEvents(dependencies, operation, body);
    return json({ accepted }, request.requestId);
  }
  if (action === "artifacts") {
    const artifactId = await putArtifact(dependencies, operation, body);
    return json({ artifactId }, request.requestId);
  }
  // D1: the old workflow engine's callbacks (candidate-export, candidate-build-source, baseline-source, e2e-admission, e2e-evidence, feedback-bundles, feedback-approval) are gone with it: an old workspace's late worker meets the route table's "route not found", as a path nobody serves. The core serves the same paths for its own workspaces before this.
  if (action === "e2e-model-budget") {
    return json(await handleE2EModelBudgetCallback({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, orgOf: async () => LEGACY_E2E_COMPANY,
      log: brokerLogLine,
      ...(dependencies.e2eAgentInstallation === undefined ? {} : { e2eAgentInstallation: dependencies.e2eAgentInstallation }) }, operation, body), request.requestId);
  }
  if (action === "pull-request") {
    const pullRequest = await logCallbackRefusal(action, operation, () => reconcilePullRequest(dependencies, operation, body));
    return json(pullRequest, request.requestId);
  }
  if (action === "pull-request-update") {
    const pullRequest = await logCallbackRefusal(action, operation, () => reconcilePullRequestUpdate(dependencies, operation, body));
    return json(pullRequest, request.requestId);
  }
  if (action === "codebuild") {
    const build = await handleCodeBuild(dependencies, operation, body);
    return json(build, request.requestId);
  }
  const result = await recordTerminalResult(dependencies, operation, body);
  return json({ operation: publicOperation(result) }, request.requestId);
}

async function handleProjectSetupExecutionRead(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string, rawOffset: string | null): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "read-execution");
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % SETUP_ARTIFACT_CHUNK_BYTES !== 0 || offset >= authorized.execution.executionRef.byteLength) throw agentXError("CONFIG_INVALID", "project setup source chunk offset is invalid");
  const deadlineAt = authorized.execution.deadlineAt;
  if (Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "project setup source read is past its stored deadline");
  const lastByte = Math.min(offset + SETUP_ARTIFACT_CHUNK_BYTES, authorized.execution.executionRef.byteLength) - 1;
  const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: authorized.execution.executionRef.key,
    Range: `bytes=${offset}-${lastByte}` }) as never) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentRange?: string; ContentLength?: number };
  if (!response.Body || typeof response.ContentRange !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source object is unreadable");
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.ContentRange);
  if (!range || Number(range[1]) !== offset || Number(range[2]) !== lastByte || Number(range[3]) !== authorized.execution.executionRef.byteLength) throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source range is inconsistent");
  const totalBytes = Number(range[3]);
  const bytes = await response.Body.transformToByteArray();
  if (totalBytes > MAX_SETUP_PROPOSAL_BYTES || bytes.byteLength !== lastByte - offset + 1 || bytes.byteLength > SETUP_ARTIFACT_CHUNK_BYTES) {
    throw agentXError("RUNTIME_UNAVAILABLE", "approved project setup source object exceeds its bounded range");
  }
  return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, executionRef: authorized.execution.executionRef,
    offset, totalBytes, deadlineAt, chunkBase64: Buffer.from(bytes).toString("base64") };
}

async function handleProjectSetupEvidenceInit(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-upload/v1"), totalBytes: z.number().int().positive().max(MAX_SETUP_EVIDENCE_BYTES),
    chunkCount: z.number().int().positive().max(Math.ceil(MAX_SETUP_EVIDENCE_BYTES / SETUP_ARTIFACT_CHUNK_BYTES)), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const expectedChunkCount = Math.ceil(body.totalBytes / SETUP_ARTIFACT_CHUNK_BYTES);
  if (body.chunkCount !== expectedChunkCount || body.totalBytes > authorized.execution.evidenceByteLimit) throw agentXError("CONFIG_INVALID", "setup evidence exceeds its admitted constituent ceiling or chunk count");
  const deadlineAt = authorized.execution.deadlineAt;
  if (Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "project setup evidence upload is past its stored deadline");
  const uploadKey = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const existing = await getItem<Record<string, unknown>>(dependencies, uploadKey);
  const existingSession = projectSetupDomainRecord(existing, uploadKey, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  if (existing) {
    if (existingSession.status !== "OPEN" || existingSession.setupExecutionId !== setupExecutionId || existingSession.subjectId !== authorized.execution.subjectId
      || existingSession.operationId !== authorized.claims.operationId || existingSession.fence !== authorized.claims.fence
      || existingSession.totalBytes !== body.totalBytes || existingSession.chunkCount !== body.chunkCount || existingSession.sha256 !== body.sha256
      || existingSession.evidenceByteLimit !== authorized.execution.evidenceByteLimit
      || typeof existingSession.uploadId !== "string") throw agentXError("CALLBACK_FORBIDDEN", "project setup operation already owns a different evidence upload");
    return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, uploadId: existingSession.uploadId,
      totalBytes: body.totalBytes, chunkCount: body.chunkCount, chunkBytes: SETUP_ARTIFACT_CHUNK_BYTES, deadlineAt: existingSession.deadlineAt };
  }
  const uploadId = randomUUID();
  const item = { ...uploadKey, entityType: "PROJECT_SETUP_EVIDENCE_UPLOAD",
    schemaVersion: 1, setupExecutionId, subjectId: authorized.execution.subjectId, operationId: authorized.claims.operationId, uploadId, fence: authorized.claims.fence,
    approvalRevision: authorized.execution.approvalRevision, transportCorrelationId: authorized.execution.transportCorrelationId,
    totalBytes: body.totalBytes, evidenceByteLimit: authorized.execution.evidenceByteLimit, chunkCount: body.chunkCount, sha256: body.sha256, nextChunkIndex: 0, deadlineAt, status: "OPEN", createdAt: new Date().toISOString() };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
  return { setupExecutionId, operationId: authorized.claims.operationId, fence: authorized.claims.fence, uploadId, totalBytes: body.totalBytes,
    chunkCount: body.chunkCount, chunkBytes: SETUP_ARTIFACT_CHUNK_BYTES, deadlineAt };
}

async function handleProjectSetupEvidenceChunk(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-chunk/v1"), uploadId: z.string().uuid(), index: z.number().int().nonnegative(),
    bytesBase64: z.string().min(1).max(Math.ceil(SETUP_ARTIFACT_CHUNK_BYTES * 4 / 3) + 8), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const key = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const upload = await getItem<Record<string, unknown>>(dependencies, key);
  const session = projectSetupDomainRecord(upload, key, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  const deadlineAt = typeof session.deadlineAt === "string" ? session.deadlineAt : "";
  if (session.status !== "OPEN" || session.uploadId !== body.uploadId || session.setupExecutionId !== setupExecutionId || session.subjectId !== authorized.execution.subjectId
    || session.operationId !== authorized.claims.operationId || session.fence !== authorized.claims.fence || session.approvalRevision !== authorized.execution.approvalRevision
    || session.transportCorrelationId !== authorized.execution.transportCorrelationId || Date.parse(deadlineAt) <= Date.now()) throw agentXError("STALE_FENCE", "setup evidence upload is not current");
  const totalBytes = Number(session.totalBytes);
  const chunkCount = Number(session.chunkCount);
  if (!Number.isSafeInteger(body.index) || body.index >= chunkCount || totalBytes > authorized.execution.evidenceByteLimit
    || session.evidenceByteLimit !== authorized.execution.evidenceByteLimit || chunkCount !== Math.ceil(totalBytes / SETUP_ARTIFACT_CHUNK_BYTES)) throw agentXError("CONFIG_INVALID", "setup evidence chunk index or admitted total is outside its upload");
  const bytes = Buffer.from(body.bytesBase64, "base64");
  const expectedLength = body.index === chunkCount - 1 ? totalBytes - body.index * SETUP_ARTIFACT_CHUNK_BYTES : SETUP_ARTIFACT_CHUNK_BYTES;
  if (bytes.byteLength !== expectedLength || bytes.toString("base64") !== body.bytesBase64 || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "setup evidence chunk length or digest is invalid");
  const nextChunkIndex = Number(session.nextChunkIndex);
  if (body.index > nextChunkIndex) throw agentXError("CONFIG_INVALID", "setup evidence chunks must arrive in order");
  const objectKey = `project-setup-staging/${setupExecutionId}/${authorized.claims.operationId}/${body.uploadId}/${body.index}.chunk`;
  if (body.index < nextChunkIndex) {
    const existing = await readSetupChunk(dependencies, objectKey);
    if (!existing || !existing.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "replayed setup evidence chunk differs from the owned chunk");
    return { accepted: true, index: body.index, duplicate: true };
  }
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: objectKey, Body: bytes,
      ContentType: "application/octet-stream", Metadata: { sha256: body.sha256, upload: body.uploadId, index: String(body.index) }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    const existing = await readSetupChunk(dependencies, objectKey);
    if (!existing || !existing.equals(bytes)) throw agentXError("CALLBACK_FORBIDDEN", "setup evidence chunk key is already occupied by different bytes");
  }
  await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: key,
    UpdateExpression: "SET nextChunkIndex = :next", ConditionExpression: "#status = :open AND nextChunkIndex = :index AND fence = :fence AND operationId = :operationId",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":next": body.index + 1, ":open": "OPEN", ":index": body.index,
      ":fence": authorized.claims.fence, ":operationId": authorized.claims.operationId } }));
  return { accepted: true, index: body.index, duplicate: false };
}

async function handleProjectSetupEvidenceFinalize(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string): Promise<unknown> {
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "write-evidence");
  const body = z.object({ schemaVersion: z.literal("project-setup-evidence-finalize/v1"), uploadId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(parseBody(request.body));
  const key = { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` };
  const raw = await getItem<Record<string, unknown>>(dependencies, key);
  const session = projectSetupDomainRecord(raw, key, "PROJECT_SETUP_EVIDENCE_UPLOAD");
  if (session.status === "COMPLETE" && session.uploadId === body.uploadId && session.sha256 === body.sha256 && session.operationId === authorized.claims.operationId
    && session.fence === authorized.claims.fence && session.evidenceKey === `project-setup-evidence/sha256/${body.sha256}.json`) {
    return { evidenceRef: { key: session.evidenceKey, sha256: body.sha256 } };
  }
  if (session.status !== "OPEN" || session.uploadId !== body.uploadId || session.setupExecutionId !== setupExecutionId || session.subjectId !== authorized.execution.subjectId
    || session.operationId !== authorized.claims.operationId || session.fence !== authorized.claims.fence || session.sha256 !== body.sha256
    || Number(session.nextChunkIndex) !== Number(session.chunkCount) || Number(session.totalBytes) > authorized.execution.evidenceByteLimit
    || session.evidenceByteLimit !== authorized.execution.evidenceByteLimit || Date.parse(String(session.deadlineAt)) <= Date.now()) throw agentXError("STALE_FENCE", "setup evidence upload is incomplete or no longer current");
  const chunks: Buffer[] = [];
  const chunkKeys: string[] = [];
  for (let index = 0; index < Number(session.chunkCount); index += 1) {
    const chunkKey = `project-setup-staging/${setupExecutionId}/${authorized.claims.operationId}/${body.uploadId}/${index}.chunk`;
    const chunk = await readSetupChunk(dependencies, chunkKey);
    if (!chunk) throw agentXError("RUNTIME_UNAVAILABLE", "an owned setup evidence chunk is missing");
    chunks.push(chunk);
    chunkKeys.push(chunkKey);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== Number(session.totalBytes) || createHash("sha256").update(bytes).digest("hex") !== body.sha256) throw agentXError("CONFIG_INVALID", "assembled setup evidence does not match its declared bytes or digest");
  let evidence: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid evidence");
    evidence = decoded as Record<string, unknown>;
  } catch { throw agentXError("CONFIG_INVALID", "setup evidence object is malformed"); }
  if (evidence.schemaVersion !== "project-setup-smoke-evidence/v1" || evidence.setupExecutionId !== setupExecutionId
    || evidence.subjectId !== authorized.execution.subjectId || evidence.transportCorrelationId !== authorized.execution.transportCorrelationId
    || evidence.executionRefSha256 !== authorized.execution.executionRef.sha256 || evidence.candidateDigest !== authorized.execution.candidateDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "setup evidence is outside its stored project execution");
  }
  const evidenceKey = `project-setup-evidence/sha256/${body.sha256}.json`;
  try {
    await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: evidenceKey, Body: bytes, ContentType: "application/json",
      Metadata: { sha256: body.sha256, domain: "project-setup-smoke-evidence-v1" }, IfNoneMatch: "*" }));
  } catch (error) {
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (status !== 412 && (error as { name?: unknown } | undefined)?.name !== "PreconditionFailed") throw error;
    if (await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceKey, MAX_SETUP_EVIDENCE_BYTES) !== bytes.toString("utf8")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "existing setup evidence object does not match its content address");
    }
  }
  await dependencies.documentClient.send(new UpdateCommand({ TableName: dependencies.tableName, Key: { pk: `PROJECT_SETUP#${setupExecutionId}`, sk: `EVIDENCE_UPLOAD#${authorized.claims.operationId}` },
    UpdateExpression: "SET #status = :complete, evidenceKey = :evidenceKey, completedAt = :completedAt",
    ConditionExpression: "#status = :open AND nextChunkIndex = chunkCount AND operationId = :operationId AND fence = :fence",
    ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":complete": "COMPLETE", ":open": "OPEN", ":evidenceKey": evidenceKey,
      ":completedAt": new Date().toISOString(), ":operationId": authorized.claims.operationId, ":fence": authorized.claims.fence } }));
  for (const chunkKey of chunkKeys) await dependencies.s3.send(new DeleteObjectCommand({ Bucket: dependencies.artifactBucketName, Key: chunkKey }));
  return { evidenceRef: { key: evidenceKey, sha256: body.sha256 } };
}

async function readSetupChunk(dependencies: AwsBrokerDependencies, key: string): Promise<Buffer | undefined> {
  try {
    const response = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!response.Body) return undefined;
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    return bytes.byteLength > 0 && bytes.byteLength <= SETUP_ARTIFACT_CHUNK_BYTES ? bytes : undefined;
  } catch (error) {
    const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
    const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
    if (name === "NoSuchKey" || status === 404) return undefined;
    throw error;
  }
}

async function requireProjectSetupCapability(
  dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest, setupExecutionId: string, action: "read-execution" | "write-evidence" | "result",
): Promise<{ execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>; claims: NonNullable<ReturnType<typeof verifyProjectSetupCapability>>;
  runtime: ReturnType<typeof ProjectSetupRuntimeRecordSchema.parse>; session: ReturnType<typeof ProjectSetupSessionSchema.parse>; companyId: string | undefined }> {
  const token = request.headers["x-agentx-callback-capability"];
  const claims = token ? verifyProjectSetupCapability(dependencies.callbackSigningKey, token) : undefined;
  if (!claims || claims.setupExecutionId !== setupExecutionId || !claims.actions.includes(action)) throw agentXError("CALLBACK_FORBIDDEN", "setup capability does not authorize this artifact action");
  const [executionItem, operationItem, sessionItem] = await Promise.all([
    getItem<Record<string, unknown>>(dependencies, projectSetupExecutionKey(setupExecutionId)),
    getItem<Record<string, unknown>>(dependencies, projectSetupOperationKey(setupExecutionId, claims.operationId)),
    getItem<Record<string, unknown>>(dependencies, projectSetupSessionKey(setupExecutionId)),
  ]);
  const execution = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(executionItem, projectSetupExecutionKey(setupExecutionId), "PROJECT_SETUP_EXECUTION"));
  const operation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(operationItem, projectSetupOperationKey(setupExecutionId, claims.operationId), "PROJECT_SETUP_OPERATION"));
  const session = ProjectSetupSessionSchema.safeParse(projectSetupDomainRecord(sessionItem, projectSetupSessionKey(setupExecutionId), "PROJECT_SETUP_SESSION"));
  if (!execution.success || !operation.success || !session.success || execution.data.state !== "DISPATCHING"
    || operation.data.status !== "DISPATCHING" && operation.data.status !== "DELIVERED"
    || execution.data.operationId !== claims.operationId || execution.data.subjectId !== claims.subjectId
    || execution.data.transportCorrelationId !== claims.transportCorrelationId || execution.data.approvalRevision !== claims.approvalRevision
    || execution.data.fence !== claims.fence || operation.data.fence !== claims.fence || session.data.state !== "READY"
    || session.data.generation !== execution.data.runtimeGeneration || session.data.bindingDigest !== execution.data.bindingDigest) {
    throw agentXError("STALE_FENCE", "setup artifact operation is no longer current");
  }
  if (!(await setupAdmissionMatchesExecution(dependencies, execution.data))) {
    throw agentXError("STALE_FENCE", "immutable setup admission no longer matches its stored execution identity");
  }
  const project = await requireProject(dependencies, execution.data.projectName, execution.data.projectRevision);
  if (project.runtimeBinding.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "project setup requires the configured EC2 setup runtime");
  const approval = await getItem<Record<string, unknown>>(dependencies, { pk: `PROJECT_SETUP#${execution.data.projectName}`, sk: `PROPOSAL#${execution.data.proposalSha256}` });
  if (project.registeredBy !== execution.data.ownerKey || project.setupApproval?.decision !== "approve"
    || project.setupApproval.proposalSha256 !== execution.data.proposalSha256 || !approval || approval.ownerKey !== execution.data.ownerKey
    || approval.decision !== "approve" || approval.proposalRef !== execution.data.proposalRef || approval.policyDigest !== execution.data.policyDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "current project setup approval is no longer valid");
  }
  // DEC 254zzz98 (one rule): `project` is the legacy revision (requireProject), so the owner's grant is the legacy row beside it.
  const companyId = LEGACY_REVISION_GRANT;
  const member = await getMembership(dependencies, execution.data.ownerKey, execution.data.projectName, companyId);
  const catalogId = dependencies.projectSetupRuntimeCatalogId;
  if (member?.role !== "administrator" || !catalogId) throw agentXError("CALLBACK_FORBIDDEN", "project setup owner authority or runtime catalog is unavailable");
  const catalogItem = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName,
    Key: projectSetupRuntimeKey(catalogId, execution.data.bindingDigest), ConsistentRead: true }));
  const runtimeKey = projectSetupRuntimeKey(catalogId, execution.data.bindingDigest);
  const runtime = ProjectSetupRuntimeRecordSchema.safeParse(projectSetupRuntimeRecord(catalogItem.Item, runtimeKey));
  if (!runtime.success || runtime.data.runtimeCatalogId !== execution.data.runtimeCatalogId
    || runtime.data.catalogRevision !== execution.data.runtimeCatalogRevision
    || runtime.data.transportCorrelationId !== execution.data.transportCorrelationId || runtime.data.generation !== execution.data.runtimeGeneration
    || !admitProjectSetupRuntime(runtime.data, { runtimeCatalogId: catalogId, binding: project.runtimeBinding, scope: "source-interface", now: Date.now() })) {
    throw agentXError("STALE_FENCE", "current configured setup runtime is no longer qualified");
  }
  return { execution: execution.data, claims, runtime: runtime.data, session: session.data, companyId };
}

async function setupAdmissionMatchesExecution(
  dependencies: AwsBrokerDependencies,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
): Promise<boolean> {
  const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, execution.executionRef.key, MAX_SETUP_PROPOSAL_BYTES);
  if (text === undefined || Buffer.byteLength(text, "utf8") !== execution.executionRef.byteLength
    || createHash("sha256").update(text, "utf8").digest("hex") !== execution.executionRef.sha256) return false;
  let admission: unknown;
  try { admission = JSON.parse(text); } catch { return false; }
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) return false;
  const value = admission as Record<string, unknown>;
  const runtime = value.runtime && typeof value.runtime === "object" && !Array.isArray(value.runtime)
    ? value.runtime as Record<string, unknown> : undefined;
  return value.domain === "project-setup-source-interface/v1" && value.setupExecutionId === execution.setupExecutionId
    && value.subjectId === execution.subjectId && value.transportCorrelationId === execution.transportCorrelationId
    && value.candidateDigest === execution.candidateDigest && runtime?.runtimeCatalogId === execution.runtimeCatalogId
    && runtime.catalogRevision === execution.runtimeCatalogRevision && runtime.bindingDigest === execution.bindingDigest
    && runtime.generation === execution.runtimeGeneration && runtime.transportCorrelationId === execution.transportCorrelationId;
}

async function parkUnboundWorkerSetupFailure(
  dependencies: AwsBrokerDependencies,
  setupExecutionId: string,
  operationId: string,
  authorized: Awaited<ReturnType<typeof requireProjectSetupCapability>>,
  body: { domain: "project-setup-source-interface/v1"; candidateDigest: string; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN"; qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean; evidenceRef?: { key: string; sha256: string } | undefined },
): Promise<{ accepted: true; parked: true; qualification: "UNKNOWN" }> {
  if ((body.processStatus !== "FAILED" && body.processStatus !== "UNKNOWN") || body.qualification !== "UNKNOWN"
    || body.cleanupConfirmed !== false || body.evidenceRef !== undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "an unbound worker failure may only report an unknown, unqualified terminal result");
  }
  const current = authorized.execution;
  const now = new Date().toISOString();
  const parkedResult = { domain: body.domain, candidateDigest: current.candidateDigest, processStatus: "UNKNOWN", qualification: "UNKNOWN",
    cleanupConfirmed: false, reportedCandidateDigest: body.candidateDigest, reportedProcessStatus: body.processStatus, reportedQualification: body.qualification,
    reportedCleanupConfirmed: body.cleanupConfirmed, parkReason: "worker-failure-without-candidate" };
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    ...projectSetupTerminalAuthorityChecks(dependencies.tableName, current, authorized.runtime, authorized.session, authorized.companyId),
    { Update: { TableName: dependencies.tableName, Key: projectSetupExecutionKey(setupExecutionId),
      UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
      ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation",
      ExpressionAttributeNames: { "#state": "state", "#result": "result" }, ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING",
        ":now": now, ":result": parkedResult, ":operationId": operationId, ":subjectId": current.subjectId, ":fence": current.fence,
        ":approvalRevision": current.approvalRevision, ":correlation": current.transportCorrelationId } } },
    { Update: { TableName: dependencies.tableName, Key: projectSetupOperationKey(setupExecutionId, operationId),
      UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
      ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
      ExpressionAttributeNames: { "#status": "status", "#result": "result" }, ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING",
        ":delivered": "DELIVERED", ":now": now, ":result": parkedResult, ":setupExecutionId": setupExecutionId,
        ":operationId": operationId, ":fence": current.fence, ":correlation": current.transportCorrelationId } } },
  ] }));
  return { accepted: true, parked: true, qualification: "UNKNOWN" };
}

function isSetupTerminalAuthorityCancel(error: unknown): boolean {
  const cancellationReasons = error && typeof error === "object"
    ? (error as { CancellationReasons?: Array<{ Code?: unknown }> }).CancellationReasons : undefined;
  return error instanceof Error && error.name === "TransactionCanceledException"
    && cancellationReasons?.slice(0, 5).some((reason) => reason.Code === "ConditionalCheckFailed") === true;
}

function projectSetupTerminalState(processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN"): "SUCCEEDED" | "FAILED" | "PARKED" {
  if (processStatus === "SUCCEEDED") return "SUCCEEDED";
  if (processStatus === "FAILED") return "FAILED";
  return "PARKED";
}

async function persistProjectSetupTerminalResult(
  dependencies: AwsBrokerDependencies,
  setupExecutionId: string,
  operationId: string,
  claims: NonNullable<ReturnType<typeof verifyProjectSetupCapability>>,
  authorized: Awaited<ReturnType<typeof requireProjectSetupCapability>>,
  body: { domain: "project-setup-source-interface/v1"; setupExecutionId: string; operationId: string; candidateDigest: string },
  verified: Awaited<ReturnType<typeof verifyProjectSetupSmokeEvidence>>,
): Promise<{ accepted: true; parked?: true; qualification?: "UNKNOWN" }> {
  const current = authorized.execution;
  const processStatus = verified?.processStatus ?? "UNKNOWN";
  const qualification = verified?.qualification ?? "UNKNOWN";
  const cleanupConfirmed = verified?.cleanupConfirmed ?? false;
  const terminalState = projectSetupTerminalState(processStatus);
  const evidenceField = verified?.evidenceRef ? { evidenceRef: verified.evidenceRef } : {};
  const persistedResult = { domain: body.domain, candidateDigest: current.candidateDigest, processStatus,
    qualification, cleanupConfirmed, ...evidenceField };
  const parkPayload = {
    setupExecutionId: body.setupExecutionId, operationId: body.operationId, candidateDigest: body.candidateDigest,
    processStatus, qualification, cleanupConfirmed, ...evidenceField,
  };
  const terminalAt = new Date().toISOString();
  if (Date.parse(authorized.runtime.qualifiedAt) > Date.parse(terminalAt) || Date.parse(authorized.runtime.expiresAt) <= Date.parse(terminalAt)) {
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, parkPayload);
    if (parked) return { accepted: true, parked: true, qualification: "UNKNOWN" };
    throw agentXError("STALE_FENCE", "qualified setup runtime expired before terminal persistence");
  }
  const terminalItems = [
    ...projectSetupTerminalAuthorityChecks(dependencies.tableName, current, authorized.runtime, authorized.session, authorized.companyId),
    { Update: { TableName: dependencies.tableName, Key: projectSetupExecutionKey(setupExecutionId),
      UpdateExpression: "SET #state = :state, completedAt = :now, #result = :result",
      ConditionExpression: "#state = :dispatching AND operationId = :operationId AND fence = :fence",
      ExpressionAttributeNames: { "#state": "state", "#result": "result" },
      ExpressionAttributeValues: { ":state": terminalState, ":now": terminalAt, ":result": persistedResult,
        ":dispatching": "DISPATCHING", ":operationId": operationId, ":fence": claims.fence } } },
    { Update: { TableName: dependencies.tableName, Key: projectSetupOperationKey(setupExecutionId, operationId),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result",
      ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#result": "result" },
      ExpressionAttributeValues: { ":status": terminalState, ":now": terminalAt, ":result": persistedResult,
        ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":fence": claims.fence } } },
  ];
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: terminalItems }));
  } catch (error) {
    if (!isSetupTerminalAuthorityCancel(error)) throw error;
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, parkPayload);
    if (!parked) throw error;
    return { accepted: true, parked: true, qualification: "UNKNOWN" };
  }
  return { accepted: true };
}

async function handleProjectSetupCallback(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  setupExecutionId: string,
  operationId: string,
): Promise<{ accepted: true; parked?: true; qualification?: "UNKNOWN" }> {
  const token = request.headers["x-agentx-callback-capability"];
  const claims = token ? verifyProjectSetupCapability(dependencies.callbackSigningKey, token) : undefined;
  if (!claims || claims.setupExecutionId !== setupExecutionId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability is outside the project setup result scope");
  }
  const body = z.object({
    domain: z.literal("project-setup-source-interface/v1"), setupExecutionId: z.string().uuid(), operationId: z.string().uuid(),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), processStatus: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
    qualification: z.enum(["PASS", "FAILED", "UNKNOWN"]), cleanupConfirmed: z.boolean(),
    evidenceRef: z.object({ key: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict().parse(parseBody(request.body));
  const authorized = await requireProjectSetupCapability(dependencies, request, setupExecutionId, "result").catch(async (error: unknown) => {
    if (!(error instanceof AgentXError) || !["CALLBACK_FORBIDDEN", "STALE_FENCE", "RUNTIME_UNAVAILABLE"].includes(error.code)) throw error;
    const parked = await parkProjectSetupResultAfterAuthorityChange(dependencies, setupExecutionId, operationId, claims, {
      setupExecutionId: body.setupExecutionId, operationId: body.operationId, candidateDigest: body.candidateDigest,
      processStatus: body.processStatus, qualification: body.qualification, cleanupConfirmed: body.cleanupConfirmed,
      ...(body.evidenceRef ? { evidenceRef: body.evidenceRef } : {}),
    });
    if (!parked) throw error;
    return undefined;
  });
  if (!authorized) return { accepted: true, parked: true, qualification: "UNKNOWN" };
  const current = authorized.execution;
  if (body.setupExecutionId !== current.setupExecutionId || body.operationId !== current.operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "project setup result does not match its immutable source execution");
  }
  if (body.candidateDigest === "0".repeat(64)) {
    return await parkUnboundWorkerSetupFailure(dependencies, setupExecutionId, operationId, authorized, body);
  }
  if (body.candidateDigest !== current.candidateDigest) {
    throw agentXError("CALLBACK_FORBIDDEN", "project setup result does not match its immutable source execution");
  }
  const verified = body.evidenceRef ? await verifyProjectSetupSmokeEvidence(dependencies, current, body.evidenceRef, authorized.runtime.runnerEnvironment, authorized.runtime.runnerToolchain) : undefined;
  return await persistProjectSetupTerminalResult(dependencies, setupExecutionId, operationId, claims, authorized, body, verified);
}

async function parkProjectSetupResultAfterAuthorityChange(
  dependencies: AwsBrokerDependencies,
  setupExecutionId: string,
  operationId: string,
  claims: NonNullable<ReturnType<typeof verifyProjectSetupCapability>>,
  body: { setupExecutionId: string; operationId: string; candidateDigest: string; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean; evidenceRef?: { key: string; sha256: string } },
): Promise<boolean> {
  const executionKey = projectSetupExecutionKey(setupExecutionId);
  const operationKey = projectSetupOperationKey(setupExecutionId, operationId);
  const [executionItem, operationItem] = await Promise.all([
    getItem<Record<string, unknown>>(dependencies, executionKey), getItem<Record<string, unknown>>(dependencies, operationKey),
  ]);
  const execution = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(executionItem, executionKey, "PROJECT_SETUP_EXECUTION"));
  const operation = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(operationItem, operationKey, "PROJECT_SETUP_OPERATION"));
  if (!execution.success || !operation.success || execution.data.state !== "DISPATCHING"
    || !["DISPATCHING", "DELIVERED"].includes(operation.data.status)
    || claims.setupExecutionId !== setupExecutionId || claims.operationId !== operationId || claims.actions.includes("result") === false
    || execution.data.operationId !== operationId || execution.data.subjectId !== claims.subjectId || execution.data.fence !== claims.fence
    || execution.data.transportCorrelationId !== claims.transportCorrelationId || execution.data.approvalRevision !== claims.approvalRevision
    || operation.data.fence !== claims.fence || body.setupExecutionId !== setupExecutionId || body.operationId !== operationId
    || body.candidateDigest !== execution.data.candidateDigest) return false;
  const now = new Date().toISOString();
  const parkedResult = { domain: "project-setup-source-interface/v1", candidateDigest: execution.data.candidateDigest,
    processStatus: "UNKNOWN", qualification: "UNKNOWN", cleanupConfirmed: false,
    reportedProcessStatus: body.processStatus, reportedQualification: body.qualification, reportedCleanupConfirmed: body.cleanupConfirmed,
    ...(body.evidenceRef ? { unqualifiedEvidenceRef: body.evidenceRef } : {}), parkReason: "current-setup-authority-changed" };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: dependencies.tableName, Key: executionKey,
        UpdateExpression: "SET #state = :parked, updatedAt = :now, completedAt = :now, #result = :result",
        ConditionExpression: "#state = :dispatching AND operationId = :operationId AND subjectId = :subjectId AND fence = :fence AND approvalRevision = :approvalRevision AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#state": "state", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":now": now, ":result": parkedResult,
          ":operationId": operationId, ":subjectId": claims.subjectId, ":fence": claims.fence, ":approvalRevision": claims.approvalRevision,
          ":correlation": claims.transportCorrelationId } } },
      { Update: { TableName: dependencies.tableName, Key: operationKey,
        UpdateExpression: "SET #status = :parked, updatedAt = :now, #result = :result",
        ConditionExpression: "(#status = :dispatching OR #status = :delivered) AND setupExecutionId = :setupExecutionId AND operationId = :operationId AND fence = :fence AND transportCorrelationId = :correlation",
        ExpressionAttributeNames: { "#status": "status", "#result": "result" },
        ExpressionAttributeValues: { ":parked": "PARKED", ":dispatching": "DISPATCHING", ":delivered": "DELIVERED", ":now": now,
          ":result": parkedResult, ":setupExecutionId": setupExecutionId, ":operationId": operationId, ":fence": claims.fence,
          ":correlation": claims.transportCorrelationId } } },
    ] }));
    return true;
  } catch {
    const [latestExecution, latestOperation] = await Promise.all([
      getItem<Record<string, unknown>>(dependencies, executionKey), getItem<Record<string, unknown>>(dependencies, operationKey),
    ]);
    const latestExec = ProjectSetupExecutionSchema.safeParse(projectSetupDomainRecord(latestExecution, executionKey, "PROJECT_SETUP_EXECUTION"));
    const latestOp = ProjectSetupOperationSchema.safeParse(projectSetupDomainRecord(latestOperation, operationKey, "PROJECT_SETUP_OPERATION"));
    return latestExec.success && latestOp.success && latestExec.data.state === "PARKED" && latestOp.data.status === "PARKED"
      && latestExec.data.operationId === operationId && latestExec.data.fence === claims.fence;
  }
}

async function readVerifiedSetupJsonObject(
  dependencies: AwsBrokerDependencies,
  key: string,
  expectedSha256: string,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes);
  if (text === undefined || createHash("sha256").update(text, "utf8").digest("hex") !== expectedSha256) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isMatchingSetupAdmission(
  admission: Record<string, unknown>,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  evidence: Record<string, unknown>,
): boolean {
  const admittedRuntime = admission.runtime && typeof admission.runtime === "object" && !Array.isArray(admission.runtime)
    ? admission.runtime as Record<string, unknown> : undefined;
  if (admittedRuntime?.runtimeCatalogId !== execution.runtimeCatalogId
    || admittedRuntime.catalogRevision !== execution.runtimeCatalogRevision
    || admittedRuntime.bindingDigest !== execution.bindingDigest
    || admittedRuntime.generation !== execution.runtimeGeneration
    || admittedRuntime.transportCorrelationId !== execution.transportCorrelationId) return false;
  if (typeof admission.planDigest !== "string" || evidence.planDigest !== admission.planDigest) return false;
  return admission.domain === "project-setup-source-interface/v1" && admission.setupExecutionId === execution.setupExecutionId
    && admission.subjectId === execution.subjectId && admission.transportCorrelationId === execution.transportCorrelationId
    && admission.candidateDigest === execution.candidateDigest
    && Boolean(admission.sourceSnapshot) && typeof admission.sourceSnapshot === "object"
    && Boolean(admission.selectionInput) && typeof admission.selectionInput === "object"
    && Boolean(admission.setupRunContext) && typeof admission.setupRunContext === "object"
    && Array.isArray(admission.scenarios);
}

function loadAndInspectSetupEvidenceSnapshot(
  admission: Record<string, unknown>,
  evidence: Record<string, unknown>,
): { snapshot: E2ESourceSnapshot; discoveredTargetIds: string[] } | undefined {
  const sourceRecord = admission.sourceSnapshot as Record<string, unknown>;
  if (!Array.isArray(sourceRecord.sources)) return undefined;
  const snapshot = { ...sourceRecord, sources: decodeSetupSourceEntries(sourceRecord.sources) } as unknown as E2ESourceSnapshot;
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  // An admission stored before a web app's contract could name its API target recorded discovery without it; it is read against that derivation as well as the current one.
  const sourceInspections = [inspectE2ERepository(snapshot, snapshot.candidate).inspection, inspectE2ERepositoryBeforeContractApiTargets(snapshot, snapshot.candidate).inspection];
  const sourceInspection = sourceInspections.find((candidate) => canonicalJson(admission.discoveredApplications) === canonicalJson(candidate.applications)
    && canonicalJson(admission.discoveryMissingInputs) === canonicalJson(candidate.missingInputs)
    && canonicalJson(admission.discoveredTargetIds) === canonicalJson(candidate.proposedTargets.map((target) => target.targetId).sort()));
  if (sourceInspection === undefined) return undefined;
  const discoveredTargetIds = sourceInspection.proposedTargets.map((target) => target.targetId).sort();
  if (canonicalJson(evidence.discoveredApplications) !== canonicalJson(sourceInspection.applications)
    || canonicalJson(evidence.discoveryMissingInputs) !== canonicalJson(sourceInspection.missingInputs)
    || canonicalJson(evidence.discoveredTargetIds) !== canonicalJson(discoveredTargetIds)) return undefined;
  return { snapshot, discoveredTargetIds };
}

function validateSetupEvidenceRunContext(
  admission: Record<string, unknown>,
  evidence: Record<string, unknown>,
  snapshot: E2ESourceSnapshot,
  discoveredTargetIds: string[],
  approvedRunnerEnvironment: ReturnType<typeof ProjectSetupRunnerEnvironmentSchema.parse>,
  approvedRunnerToolchain: ReturnType<typeof ProjectSetupRunnerToolchainSchema.parse>,
) {
  E2EPolicySchema.parse(admission.policy);
  const selectionInput = { ...(admission.selectionInput as Record<string, unknown>), sourceSnapshot: snapshot };
  const plan = selectE2EExecutionPlan(selectionInput as never);
  if (plan.groups.length === 0) return undefined;
  const bundleBody = { schemaVersion: 1 as const, planDigest: admission.planDigest as string, templateVersion: "trusted-e2e/v1", scenarios: admission.scenarios as never, bundleDigest: "0".repeat(64) };
  const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
  const runContext = admission.setupRunContext as Record<string, unknown>;
  const round = E2ERoundSchema.parse((evidence.round) ?? null);
  const groupAdmissions = runContext.groupAdmissions;
  if (!Array.isArray(groupAdmissions) || groupAdmissions.length !== plan.groups.length || plan.groups.length === 0
    || canonicalJson(runContext.plan) !== canonicalJson(plan) || canonicalJson(runContext.bundle) !== canonicalJson(bundle)
    || canonicalJson(runContext.round) !== canonicalJson(round) || canonicalJson(runContext.runnerEnvironment) !== canonicalJson(approvedRunnerEnvironment)
    || canonicalJson(runContext.runnerToolchain) !== canonicalJson(approvedRunnerToolchain)
    || runContext.runnerToolchainDigest !== createHash("sha256").update(canonicalJson(approvedRunnerToolchain)).digest("hex")
    || !Array.isArray(evidence.groupRuns) || evidence.groupRuns.length !== plan.groups.length) return undefined;
  const unsupportedTargetIds = admission.unsupportedTargetIds;
  const selectedTargetIds = Array.isArray(admission.selectedTargetIds) ? admission.selectedTargetIds : [];
  const expectedNotExecutedTargetIds = discoveredTargetIds.filter((targetId) => !selectedTargetIds.includes(targetId));
  if (!Array.isArray(unsupportedTargetIds) || canonicalJson(evidence.unsupportedTargetIds) !== canonicalJson(unsupportedTargetIds)) return undefined;
  if (canonicalJson(unsupportedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)
    || canonicalJson(admission.notExecutedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)
    || canonicalJson(evidence.notExecutedTargetIds) !== canonicalJson(expectedNotExecutedTargetIds)) return undefined;
  return {
    selectionInput, plan, bundle, round,
    authenticatedGroupAdmissions: groupAdmissions as unknown as unknown[],
    submittedGroupRuns: evidence.groupRuns as unknown as unknown[],
  };
}

function parseGroupHostRequestIds(
  rawHostRequestIds: unknown,
  hostRequestPayloads: ReadonlyMap<string, unknown>,
): Map<string, string> | undefined {
  if (!Array.isArray(rawHostRequestIds)) return undefined;
  const hostRequestIds = new Map<string, string>();
  for (const row of rawHostRequestIds) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string" || hostRequestIds.has(row[0])) return undefined;
    hostRequestIds.set(row[0], row[1]);
  }
  if (hostRequestIds.size !== hostRequestPayloads.size || [...hostRequestPayloads.keys()].some((caseId) => !hostRequestIds.has(caseId))) return undefined;
  return hostRequestIds;
}

function parseSetupActualCliRun(
  actualValue: unknown,
  approvedRunnerToolchain: ReturnType<typeof ProjectSetupRunnerToolchainSchema.parse>,
): { actualRecord: Record<string, unknown>; actual: never } | undefined {
  if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue)) return undefined;
  const actualRecord = actualValue as Record<string, unknown>;
  if (canonicalJson(actualRecord.runnerToolchain) !== canonicalJson(approvedRunnerToolchain)) return undefined;
  if (typeof actualRecord.launchId !== "string" || typeof actualRecord.rawReportBase64 !== "string" || typeof actualRecord.runStartCaptureBase64 !== "string"
    || !Array.isArray(actualRecord.candidateCaptures) || !Array.isArray(actualRecord.assertionReceipts)
    || typeof actualRecord.cleanupConfirmed !== "boolean" || typeof actualRecord.cleanupServerListening !== "boolean") return undefined;
  const rawReportBytes = Buffer.from(actualRecord.rawReportBase64, "base64");
  const runStartCaptureBytes = Buffer.from(actualRecord.runStartCaptureBase64, "base64");
  const runStartCapture = parseE2EFirstPartyCapture(runStartCaptureBytes, actualRecord.launchId);
  const actual = { launchId: actualRecord.launchId, launchConfigDigest: actualRecord.launchConfigDigest, fixedAssetDigests: actualRecord.fixedAssetDigests,
    publicList: actualRecord.publicList, selected: actualRecord.selected, filtered: actualRecord.filtered,
    rawReportBytes: new Uint8Array(rawReportBytes), runStartCaptureBytes: new Uint8Array(runStartCaptureBytes), runStartCapture,
    assertionReceipts: actualRecord.assertionReceipts, declaredMockComponentIds: actualRecord.declaredMockComponentIds,
    candidateCaptures: actualRecord.candidateCaptures, listProcess: actualRecord.listProcess, runProcess: actualRecord.runProcess,
    cleanupConfirmed: actualRecord.cleanupConfirmed, cleanupServerListening: actualRecord.cleanupServerListening, evidenceDirectory: "" } as never;
  return { actualRecord, actual };
}

function verifySetupEvidenceGroupRun(
  index: number,
  group: ReturnType<typeof selectE2EExecutionPlan>["groups"][number],
  admissionGroup: unknown,
  rawGroupRun: unknown,
  context: {
    execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>;
    admission: Record<string, unknown>;
    snapshot: E2ESourceSnapshot;
    selectionInput: Record<string, unknown>;
    plan: ReturnType<typeof selectE2EExecutionPlan>;
    bundle: ReturnType<typeof E2EScenarioBundleSchema.parse>;
    round: ReturnType<typeof E2ERoundSchema.parse>;
    semanticApprovalDigests: Map<string, string>;
    approvedRunnerEnvironment: ReturnType<typeof ProjectSetupRunnerEnvironmentSchema.parse>;
    approvedRunnerToolchain: ReturnType<typeof ProjectSetupRunnerToolchainSchema.parse>;
  },
): { qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean; processSucceeded: boolean } | undefined {
  if (!admissionGroup || !rawGroupRun || typeof admissionGroup !== "object" || typeof rawGroupRun !== "object" || Array.isArray(rawGroupRun)) return undefined;
  const admitted = admissionGroup as Record<string, unknown>;
  const groupRun = rawGroupRun as Record<string, unknown>;
  const compiled = compileE2EScenarios(context.bundle, context.plan.effectiveTargets, group, { selectionInput: context.selectionInput, executionPlan: context.plan, group } as never);
  if (canonicalJson(admitted.group) !== canonicalJson(group) || admitted.expectedConfigDigest !== compiled.expectedConfigDigest
    || admitted.compiledInventoryDigest !== compiled.inventory.digest || admitted.selectionPacketPath !== compiled.selectionPacketPath
    || canonicalJson(admitted.expectedCases) !== canonicalJson(compiled.expectedCases)) return undefined;
  const binding = E2ERunBindingSchema.parse(admitted.binding);
  if (binding.operationId !== context.execution.operationId || binding.operationFence !== context.execution.fence || binding.workflowRevision !== context.execution.projectRevision
    || binding.candidateDigest !== context.execution.candidateDigest || binding.planDigest !== context.admission.planDigest || binding.groupId !== group.groupId
    || canonicalJson(context.round.groupBindings[index]) !== canonicalJson(binding) || canonicalJson(groupRun.group) !== canonicalJson(group)
    || canonicalJson(groupRun.binding) !== canonicalJson(binding)) return undefined;
  const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as unknown;
  if (canonicalJson(groupRun.selection) !== canonicalJson(selection)) return undefined;
  const hostRequestIds = parseGroupHostRequestIds(groupRun.hostRequestIds, compiled.hostRequestPayloads);
  if (!hostRequestIds) return undefined;
  const parsedActual = parseSetupActualCliRun(groupRun.actual, context.approvedRunnerToolchain);
  if (!parsedActual) return undefined;
  const { actualRecord, actual } = parsedActual;
  const actualQualification = collectE2EActualCliRun({ actual, compiled, binding, round: context.round, selection: selection as never,
    sourceDigest: e2eSnapshotSourceDigest(compiled, context.snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 }))),
    semanticApprovalDigests: context.semanticApprovalDigests, hostRequestIds,
    declaredMockComponentIds: Array.isArray(actualRecord.declaredMockComponentIds) ? actualRecord.declaredMockComponentIds as string[] : [],
    environment: context.approvedRunnerEnvironment,
    usage: { discoveredResults: Number(actualRecord.selected) + Number(actualRecord.filtered), maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
    limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 } });
  const runProcess = actualRecord.runProcess as Record<string, unknown> | undefined;
  return {
    qualification: actualQualification.qualification?.status ?? "UNKNOWN",
    cleanupConfirmed: actualRecord.cleanupConfirmed === true && actualRecord.cleanupServerListening === false,
    processSucceeded: runProcess?.status === 0 && runProcess.signal === null && runProcess.aborted === false && runProcess.timedOut === false,
  };
}

function isMatchingSetupEvidenceHeader(
  evidence: Record<string, unknown>,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  approvedRunnerToolchain: ReturnType<typeof ProjectSetupRunnerToolchainSchema.parse>,
): boolean {
  return evidence.schemaVersion === "project-setup-smoke-evidence/v1" && evidence.setupExecutionId === execution.setupExecutionId
    && evidence.subjectId === execution.subjectId && evidence.transportCorrelationId === execution.transportCorrelationId
    && evidence.executionRefSha256 === execution.executionRef.sha256 && evidence.candidateDigest === execution.candidateDigest
    && canonicalJson(evidence.runnerToolchain) === canonicalJson(approvedRunnerToolchain);
}

function summarizeSetupEvidenceOutcomes(
  reference: { key: string; sha256: string },
  groupCount: number,
  qualifications: Array<"PASS" | "FAILED" | "UNKNOWN">,
  cleanupStates: boolean[],
  processStates: boolean[],
): { evidenceRef: { key: string; sha256: string }; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN"; qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean } {
  const cleanupConfirmed = cleanupStates.length === groupCount && cleanupStates.every(Boolean);
  const processStatus = processStates.every(Boolean) ? "SUCCEEDED" : "FAILED";
  const qualification = qualifications.includes("FAILED") ? "FAILED"
    : qualifications.length === groupCount && qualifications.every((item) => item === "PASS") ? "PASS" : "UNKNOWN";
  return { evidenceRef: reference, processStatus, qualification: cleanupConfirmed ? qualification : "UNKNOWN", cleanupConfirmed };
}

async function verifyProjectSetupSmokeEvidence(
  dependencies: AwsBrokerDependencies,
  execution: ReturnType<typeof ProjectSetupExecutionSchema.parse>,
  reference: { key: string; sha256: string },
  approvedRunnerEnvironmentInput: unknown,
  approvedRunnerToolchainInput: unknown,
): Promise<{ evidenceRef: { key: string; sha256: string }; processStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN"; qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean } | undefined> {
  const approvedRunnerEnvironment = ProjectSetupRunnerEnvironmentSchema.safeParse(approvedRunnerEnvironmentInput);
  const approvedRunnerToolchain = ProjectSetupRunnerToolchainSchema.safeParse(approvedRunnerToolchainInput);
  if (!approvedRunnerEnvironment.success || !approvedRunnerToolchain.success) return undefined;
  if (reference.key !== `project-setup-evidence/sha256/${reference.sha256}.json`) return undefined;
  const evidence = await readVerifiedSetupJsonObject(dependencies, reference.key, reference.sha256, execution.evidenceByteLimit);
  if (!evidence || !isMatchingSetupEvidenceHeader(evidence, execution, approvedRunnerToolchain.data)) return undefined;
  const admission = await readVerifiedSetupJsonObject(dependencies, execution.executionRef.key, execution.executionRef.sha256, MAX_SETUP_PROPOSAL_BYTES);
  if (!admission || !isMatchingSetupAdmission(admission, execution, evidence)) return undefined;
  try {
    const inspected = loadAndInspectSetupEvidenceSnapshot(admission, evidence);
    if (!inspected) return undefined;
    const validated = validateSetupEvidenceRunContext(admission, evidence, inspected.snapshot, inspected.discoveredTargetIds, approvedRunnerEnvironment.data, approvedRunnerToolchain.data);
    if (!validated) return undefined;
    const semanticApprovalDigests = new Map(validated.bundle.scenarios.map((scenario) => [scenario.scenarioId, (admission.semanticApproval as { digest: string }).digest]));
    const qualifications: Array<"PASS" | "FAILED" | "UNKNOWN"> = [];
    const cleanupStates: boolean[] = [];
    const processStates: boolean[] = [];
    for (const [index, group] of validated.plan.groups.entries()) {
      const outcome = verifySetupEvidenceGroupRun(index, group, validated.authenticatedGroupAdmissions[index], validated.submittedGroupRuns[index], {
        execution, admission, snapshot: inspected.snapshot, selectionInput: validated.selectionInput, plan: validated.plan,
        bundle: validated.bundle, round: validated.round, semanticApprovalDigests,
        approvedRunnerEnvironment: approvedRunnerEnvironment.data, approvedRunnerToolchain: approvedRunnerToolchain.data,
      });
      if (!outcome) return undefined;
      qualifications.push(outcome.qualification);
      cleanupStates.push(outcome.cleanupConfirmed);
      processStates.push(outcome.processSucceeded);
    }
    return summarizeSetupEvidenceOutcomes(reference, validated.plan.groups.length, qualifications, cleanupStates, processStates);
  } catch {
    return undefined;
  }
}

function projectSetupDomainRecord(item: Record<string, unknown> | undefined, key: { pk: string; sk: string }, entityType: string): Record<string, unknown> {
  if (!item) return {};
  if (item.pk !== key.pk || item.sk !== key.sk || item.entityType !== entityType) return {};
  const { pk: _pk, sk: _sk, entityType: _entityType, ...domain } = item;
  void _pk; void _sk; void _entityType;
  return domain;
}

/** Runtime catalog's strict domain schema includes entityType; validate storage identity before preserving it. */
function projectSetupRuntimeRecord(item: Record<string, unknown> | undefined, key: { pk: string; sk: string }): Record<string, unknown> {
  const domain = projectSetupDomainRecord(item, key, "PROJECT_SETUP_RUNTIME");
  return Object.keys(domain).length === 0 ? domain : { ...domain, entityType: "PROJECT_SETUP_RUNTIME" };
}

/**
 * A refused pull request callback says why in the broker log: the worker only sees its HTTP status. The reason is the
 * broker's own refusal text (scope, head and state checks), never a request body; any other error is logged by name.
 */
async function logCallbackRefusal<T>(action: string, operation: OperationRecord, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const refusal = error instanceof AgentXError
      ? { code: error.code, reason: error.message.replace(`${error.code}: `, "") }
      : { error: error instanceof Error ? error.name : "unknown" };
    console.log(JSON.stringify({ component: "broker", event: "callback.refused", action, workspaceId: operation.workspaceId, operationId: operation.id, ...refusal }));
    throw error;
  }
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
  // GitHub moves a pull request's head a moment after a push to its branch, and the worker calls back right after its
  // push: a pull request still at the head before the push holds the update when its branch, which GitHub reads from
  // Git itself, already points at the pushed commit.
  const branchHoldsUpdate = async (): Promise<boolean> => {
    const getBranchHead = dependencies.githubPullRequests.getBranchHead;
    if (remote.headCommit !== expected.expectedHeadCommit || getBranchHead === undefined) return false;
    try {
      return await getBranchHead.call(dependencies.githubPullRequests, record.repositoryUrl, record.headBranch) === input.commit;
    } catch {
      return false;
    }
  };
  if (
    remote.state !== "open" || remote.headBranch !== record.headBranch ||
    remote.baseBranch !== record.baseBranch || (remote.headCommit !== input.commit && !await branchHoldsUpdate())
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
  // D1: a publication of the old workflow engine (its checked tree is recorded on the operation) is refused: that engine no longer judges whether the pushed code is the checked code.
  if (expected.expectedTreeSha !== undefined) throw agentXError("CALLBACK_FORBIDDEN", "workflow publication authority is stale");
  const publishChecks = publicationChecks(input.checks);
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  // A revert undoes a merged pull request, so the workspace's own task work is not what it publishes.
  const latestChecks = expected.mode === "revert" ? undefined : await latestWorkspaceChecks(dependencies, operation.workspaceId);
  const standingFailures = expected.mode === "revert" ? [] : await workspaceStandingFailures(dependencies, operation.workspaceId);
  const checked = checkedPullRequest(expected.body, expected.draft, publishChecks, latestChecks, standingFailures);
  const body = checked.body;
  const draft = checked.draft;
  const pullRequest = await dependencies.githubPullRequests.reconcilePullRequest({
    repositoryUrl: expected.repositoryUrl,
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    title: expected.title,
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
  });
  if (pullRequest.draftRefused === true) console.log(JSON.stringify({ component: "broker", event: "pull_request.draft_refused", operationId: operation.id, number: pullRequest.number }));
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
    // What was opened: with the note first when GitHub refused the draft (INTG1), so a later update of the description keeps it.
    body: pullRequest.draftRefused === true ? pullRequestBodyWithDraftNote(body) : body ?? "",
    ...(pullRequest.draftRefused === true ? { draftRefused: true as const } : {}),
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
  // Ruling Z: the worker's result says whether the pull request is a draft, so the reply can say so. INTG1: one that GitHub refused as a draft was opened as a normal one, so it is not.
  return { ...pullRequest, draft: draft === true && pullRequest.draftRefused !== true };
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
    refuseWorkItemProgress(chunk);
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

/**
 * D1: a work breakdown checkpoint (`workItemProgress`) belongs to the old workflow engine's approved implementation run, which no longer exists. An operation that is not bound to one is
 * refused exactly as before (the old check's first refusal), whatever the worker sends.
 */
function refuseWorkItemProgress(events: readonly { type: string; timestamp: string; payload: unknown }[]): void {
  const carries = events.some((event) => event.type === "progress" && event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) && Object.hasOwn(event.payload, "workItemProgress"));
  if (carries) throw agentXError("CALLBACK_FORBIDDEN", "work breakdown progress is not bound to an active approved operation and People revision");
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
  const feedbackReportMatch = operation.workflowMode === "FEEDBACK_REVIEW"
    ? /^workflow-feedback-review-([a-f0-9]{64})\.json$/.exec(input.name) : undefined;
  const feedbackReportDigest = feedbackReportMatch?.[1];
  // Beside the report, a feedback review may keep the reviewer's rejected answer (redacted by the worker), privately
  // under its operation; nothing reads it back into the task.
  const feedbackAnswer = operation.workflowMode === "FEEDBACK_REVIEW" && input.name === WORKFLOW_FEEDBACK_REVIEW_ANSWER_ARTIFACT;
  if (operation.workflowMode === "FEEDBACK_REVIEW" && !feedbackAnswer && (feedbackReportDigest === undefined
    || createHash("sha256").update(input.content, "utf8").digest("hex") !== feedbackReportDigest)) {
    throw agentXError("CONFIG_INVALID", "feedback critic report artifact name must match its content digest");
  }
  const objectKey = feedbackReportDigest === undefined
    ? `private/${workspace.ownerKey}/${workspace.id}/${operation.id}/${artifactId}`
    : `private/${workspace.ownerKey}/${workspace.id}/feedback-reviews/${feedbackReportDigest}.json`;
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

/** C18: a prepare the stuck-setup sweep failed; the worker's late result is answered, not refused. */
const isSweptPrepare = (operation: OperationRecord): boolean =>
  operation.kind === "prepare" && operation.status === "FAILED" && operation.error === STUCK_SETUP_MESSAGE;

/** What a successful cancel's result makes of its target, and what a failed one does. */
const cancelledTargetStatus = (cancelStatus: OperationStatus): OperationStatus => (cancelStatus === "SUCCEEDED" ? "CANCELLED" : "INTERRUPTED");

/** At most `limit` of an operation's events, newest first, across pages. */
async function operationEventsNewestFirst(dependencies: AwsBrokerDependencies, operationId: string, limit: number): Promise<StoredEvent[]> {
  const items = await queryAllItems(dependencies, `OPERATION#${operationId}`, "EVENT#", { limit, newestFirst: true });
  return items.filter((item) => item.entityType === "EVENT").map((item) => parseStoredEvent(item));
}
/** The most bytes of an earlier structured document read back to find the claim numbers that are retired. */
const EARLIER_PLAN_MAX_BYTES = 32_768;

const readObjectText = (dependencies: AwsBrokerDependencies, key: string, maxBytes: number) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes);

const TERMINAL_ERROR_MAX = 16_384;

async function handleAlreadyTerminalOperation(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  status: OperationStatus,
): Promise<OperationRecord> {
  // Issue 202: a task whose cancel failed ended INTERRUPTED but kept its workspace, as it might
  // still run. Its own result proves the run ended, so it frees the workspace; the result itself
  // is not stored (results stay immutable), and the worker gets the stored operation.
  if (operation.kind === "task" && operation.status === "INTERRUPTED") {
    const released = await releaseOnOwnResult(dependencies, operation);
    if (released !== undefined) return released;
  }
  if (operation.status !== status && !isSweptPrepare(operation)) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal result is immutable");
  // #213: a repeated result releases a failed prepare's slot too, in case the first one's release
  // did not land (the release is idempotent, and does nothing to a workspace that moved on).
  if (operation.kind === "prepare" && operation.status !== "SUCCEEDED") {
    await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, operation.workspaceId);
  }
  return operation;
}

function parseTerminalOperationResult(
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  rawResult: unknown,
): { result: unknown; closePreflight: ReturnType<typeof WorkspaceClosePreflightResultSchema.parse> | undefined } {
  if (operation.kind === "publish" && terminalStatus === "SUCCEEDED") {
    return { result: PullRequestResultSchema.parse(rawResult), closePreflight: undefined };
  }
  if (operation.kind === "close" && terminalStatus === "SUCCEEDED") {
    const closePreflight = WorkspaceClosePreflightResultSchema.parse(rawResult);
    return { result: closePreflight, closePreflight };
  }
  return { result: rawResult, closePreflight: undefined };
}

function nextTerminalWorkspaceStatus(
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  closeCanFinish: boolean,
): WorkspaceInstance["status"] {
  if (operation.kind === "prepare") {
    return terminalStatus === "SUCCEEDED" ? "READY" : "PREPARATION_FAILED";
  }
  if (operation.kind === "close") {
    return closeCanFinish ? "CLOSING" : (operation.closePreviousStatus ?? "READY");
  }
  return "READY";
}

function buildTerminalCancelTargetUpdate(
  tableName: string,
  terminalTarget: ReturnType<typeof operationKey>,
  terminalStatus: OperationStatus,
  now: string,
): TransactItems[number] {
  return { Update: {
    TableName: tableName,
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
  } };
}

function buildTerminalWorkspaceUpdate(
  tableName: string,
  workspaceId: string,
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  workspaceStatus: WorkspaceInstance["status"],
  closeCanFinish: boolean,
  closePreflight: ReturnType<typeof WorkspaceClosePreflightResultSchema.parse> | undefined,
  error: string | undefined,
  latestChecks: ReturnType<typeof latestChecksItem> | undefined,
  standingFailures: StandingFailure[] | undefined,
  now: string,
): TransactItems[number] {
  const isPrepareSucceeded = operation.kind === "prepare" && terminalStatus === "SUCCEEDED";
  const isCloseRejected = operation.kind === "close" && !closeCanFinish;
  const workspaceExpression = isPrepareSucceeded
    ? "SET #status = :status, updatedAt = :now, preparationManifest = :manifest REMOVE activeOperationId"
    : isCloseRejected
      ? "SET #status = :status, updatedAt = :now, closeError = :closeError REMOVE activeOperationId"
      : "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError";
  return { Update: {
    TableName: tableName,
    Key: workspaceKey(workspaceId),
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
      ...(isPrepareSucceeded ? { ":manifest": ".agentx/preparation-manifest.json" } : {}),
      ...(latestChecks === undefined ? {} : { ":latestChecks": latestChecks, ":standingFailures": standingFailures }),
      ...(isCloseRejected
        ? { ":closeError": error ?? (closePreflight ? "workspace contains unpublished work" : "workspace close preflight failed") }
        : {}),
    },
  } };
}

function terminalOperationSnapshot(
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  error: string | undefined,
): OperationRecord {
  return { ...operation, status: terminalStatus, updatedAt: now, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
}

async function recordOwnCancelTerminalResult(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  error: string | undefined,
  ownUpdateItem: TransactItems[number],
): Promise<OperationRecord> {
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [ownUpdateItem] }));
  } catch (ownError) {
    if (!isConditional(ownError)) throw ownError;
    const again = await requireOperation(dependencies, operation.workspaceId, operation.id);
    if (again.status === terminalStatus) return again;
    throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
  }
  return terminalOperationSnapshot(operation, terminalStatus, now, result, error);
}

async function handleTerminalResultTransactionConflict(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  now: string,
  result: unknown,
  error: string | undefined,
  ownUpdateItem: TransactItems[number],
  transactionError: unknown,
): Promise<OperationRecord> {
  if (!isConditional(transactionError)) throw transactionError;
  const existing = await requireOperation(dependencies, operation.workspaceId, operation.id);
  if (existing.status === terminalStatus || isSweptPrepare(existing)) {
    if (existing.kind === "prepare" && existing.status !== "SUCCEEDED") {
      await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, existing.workspaceId);
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
      return await recordOwnCancelTerminalResult(dependencies, operation, terminalStatus, now, result, error, ownUpdateItem);
    }
  }
  throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
}

async function buildTerminalResultTransactItems(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  operation: OperationRecord,
  terminalStatus: OperationStatus,
  result: unknown,
  closePreflight: ReturnType<typeof WorkspaceClosePreflightResultSchema.parse> | undefined,
  error: string | undefined,
  now: string,
): Promise<TransactItems> {
  // Explicit discard only bypasses the unpublished-work refusal after the worker has
  // successfully produced a valid preflight. A failed or cancelled check must never delete
  // compute or storage merely because the owner authorized discarding the checked-out changes.
  const closeCanFinish = operation.kind === "close" && closePreflight !== undefined
    && (closePreflight.safeToClose || operation.discardUnpublished === true);
  const workspaceStatus = nextTerminalWorkspaceStatus(operation, terminalStatus, closeCanFinish);
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
  if (operation.kind === "cancel" && operation.targetOperationId) {
    transactItems.push(buildTerminalCancelTargetUpdate(dependencies.tableName, operationKey(operation.workspaceId, operation.targetOperationId), terminalStatus, now));
  }
  // Spec 051 Ruling T: a task's end, or its cancel's, sets the workspace's latest checks in the same transaction. That
  // update holds only while this operation owns the workspace at its fence, so a late or repeated result never
  // replaces a newer task's, and no write can be lost after the result commits.
  const latestChecks = await terminalLatestChecks(dependencies, operation, terminalStatus, result, now);
  const standingFailures = latestChecks === undefined ? undefined : await nextWorkspaceStanding(dependencies, operation.workspaceId, latestChecks.report);
  const workspaceUpdate = buildTerminalWorkspaceUpdate(
    dependencies.tableName, workspace.id, operation, terminalStatus, workspaceStatus,
    closeCanFinish, closePreflight, error, latestChecks, standingFailures, now,
  );
  if (operation.kind !== "cancel" || terminalStatus === "SUCCEEDED") transactItems.push(workspaceUpdate);
  return transactItems;
}

async function recordTerminalResult(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<OperationRecord> {
  const input = object(value, "terminal result");
  const status = input.status;
  if (!TERMINAL.has(status as OperationStatus)) throw agentXError("CONFIG_INVALID", "terminal status is invalid");
  const terminalStatus = status as OperationStatus;
  if (TERMINAL.has(operation.status)) {
    return await handleAlreadyTerminalOperation(dependencies, operation, terminalStatus);
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const now = new Date().toISOString();
  // #154: the worker's error can quote a command's output, so it is redacted before it is stored,
  // and redactAndCap redacts before it caps.
  const error = typeof input.error === "string" ? redactAndCap(input.error, TERMINAL_ERROR_MAX).text : undefined;
  const { result, closePreflight } = parseTerminalOperationResult(operation, terminalStatus, input.result);
  const transactItems = await buildTerminalResultTransactItems(dependencies, workspace, operation, terminalStatus, result, closePreflight, error, now);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (transactionError) {
    return await handleTerminalResultTransactionConflict(
      dependencies, operation, terminalStatus, now, result, error, transactItems[0]!, transactionError,
    );
  }
  // #213: a prepare that did not succeed leaves the workspace PREPARATION_FAILED, which stops
  // counting toward the workspace limits now; the release logs, and never fails the callback.
  if (operation.kind === "prepare" && terminalStatus !== "SUCCEEDED") await releaseFailedPreparation(dependencies.documentClient, dependencies.tableName, workspace.id);
  return terminalOperationSnapshot(operation, terminalStatus, now, result, error);
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

/**
 * The definition a publication or maintenance run works from: the workspace's own revision for
 * everything that touches its disk, and the project's latest registered revision for the settings
 * that do not. Returns the revision whose settings applied, for the operation record.
 */
async function publicationProject(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
  identity: AuthenticatedIdentity,
): Promise<{ project: RegisteredProjectRecord; settingsRevision: number }> {
  const pinned = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireProject(dependencies, workspace.projectName, workspace.projectRevision)));
  const settings = slackThreadOwnRow(identity, await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireLatestProject(dependencies, workspace.projectName)));
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
      delete withoutGates.externalChecks;
      return { ...withoutGates, ...(latest.codeBuildGates === undefined ? {} : { codeBuildGates: latest.codeBuildGates }), ...(latest.externalChecks === undefined ? {} : { externalChecks: latest.externalChecks }) };
    }),
  };
  return { project: { ...pinned, definition }, settingsRevision: settings.definition.revision };
}

/** Spec 062: the link store the developer routes use, when the deployment has channel adapters. */
/** Spec 064: what the legacy deployment's linking routes need: sign-in and the links, never developer tasks. */
function linkingRouteDependencies(dependencies: AwsBrokerDependencies, linking: DeveloperApiConfiguration) {
  return { documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: linking, now: Date.now, ...(linking.companies === undefined ? {} : { companies: linking.companies }), ...channelLinkRouteDependencies(dependencies), ...clientProjectRouteDependencies(dependencies) };
}

/** Spec 065b: a sign-in client's signed-in Rovara administrator creates a project from one GitHub repository. Guided onboarding PR 6: or from several, or one per repository. */
function clientProjectRouteDependencies(brokerDependencies_: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "createClientProject" | "createClientProjects" | "createClientProjectsBulk" | "clientRepositories" | "clientRepositoryChoices" | "companyProjectCreator" | "companyReads"> {
  const dependencies = withClientGithubBindings(brokerDependencies_);
  const clientProjects = dependencies.clientProjects; if (clientProjects === undefined) return dependencies.companyReads === undefined ? {} : { companyReads: dependencies.companyReads };
  const rules = { ...(dependencies.githubBindings === undefined ? {} : { bindings: dependencies.githubBindings }),
    ...(clientProjects.repositoryInstallation === undefined ? {} : { live: (url: string) => clientProjects.repositoryInstallation!(url) }) };
  const revisionIn = async (pk: string) => ((await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": pk, ":rev": "REV#" }, Limit: 1, ConsistentRead: true,
  })) as { Items?: unknown[] }).Items ?? []).length > 0;
  // DEC 254zzz80: a named company's fresh id must be free in its own partition (any revision, a candidate too) as well as globally.
  const projectExists = async (name: string, owner?: string) => await revisionIn(`PROJECT#${name}`) || (namedCompany(owner) !== undefined && await revisionIn(revisionKeyFor(owner, name, 1).pk)); const names = companyProjectNaming(projectExists, (company, name) => companyNameTaken(dependencies.documentClient, dependencies.tableName, company, name)); // L2-1
  // DEC 254zzz80: today's global names (id == name) created for a named company are registered in its own partition, so a name it already holds there is taken too.
  const nameTaken_ = async (owner: string | undefined, companyId: string | undefined, name: string) => await names.taken(owner, name) || (owner === undefined && namedCompany(companyId) !== undefined && await projectExists(name, companyId));
  /**
   * Guided onboarding PR 6: one project from `repositories`, for `companyId` (the caller's, from membership). Every repository is checked against the
   * company's bindings with GitHub's live answer before any token is made for any of them; one that fails refuses the whole create, in one fixed answer.
   */
  const createFromRepositories = async (developerId: string, companyId: string | undefined, repositories: readonly string[], options: { name?: string; setupCommands?: string[]; testCommands?: string[] }, commitBy: number, naming?: ClientProjectNaming) => {
    const urls = repositories.map((repository) => `https://github.com/${repository}.git`);
    const budget = boundedCompanyReads(dependencies.documentClient);
    if (!await onCompanyInstallations(rules, companyId, urls, budget)) throw notAvailable();
    let found: Array<{ name: string; defaultBranch: string }>;
    try {
      found = await eachLimited(urls, LOOKUP_CONCURRENCY, (url) => companyId === undefined ? clientProjects.repositoryDefaults(url) : budget.read(() => clientProjects.repositoryDefaults(url)));
    } catch (error) {
      throw (error as { code?: unknown }).code === "NOT_FOUND" ? notAvailable() : unavailable();
    }
    const repositoryNames = uniqueRepositoryNames(found.map((entry) => entry.name));
    const name = options.name ?? repositoryNames[0]!; const nameOwner = names.owner(naming, companyId);
    if (await nameTaken_(nameOwner, companyId, name)) throw nameTaken(name); const id = await names.idFor(nameOwner, name);
    const cwd = `repo/${repositoryNames[0]!}`;
    // One argument list each, split on spaces: no shell, so quotes and pipes are not interpreted. They run in the first repository.
    const command = (text: string) => { const [executable, ...args] = text.trim().split(/\s+/); return { cwd, executable: executable!, args, timeoutSeconds: 1_800 }; };
    const definition = ProjectDefinitionSchema.parse({
      name: id, revision: 1,
      repositories: urls.map((url, index) => ({ name: repositoryNames[index]!, url, path: `repo/${repositoryNames[index]!}`, defaultBranch: found[index]!.defaultBranch, credentialRef: clientProjects.credentialRef })),
      setup: (options.setupCommands ?? []).map(command), readiness: (options.testCommands ?? []).map(command),
      orchestratorInstructions: CLIENT_PROJECT_INSTRUCTIONS,
    });
    const identity: AuthenticatedIdentity = { issuer: "sign-in-client", subject: developerId, ownerKey: developerId, isAdministrator: true, claims: {} };
    const runtimeBinding = await clientProjects.workerBinding();
    // One wall-clock limit for the whole request: too late to register safely before the gateway gives up, so nothing is written.
    if (Date.now() > commitBy) throw unavailable();
    try {
      // Registration checks every repository's binding once more (its own budget), in the transaction's company; DEC 254zzz81: with the registration preflight on, as any other registration.
      await registerProject(dependencies, identity, { definition, runtimeBinding, preflight: true }, { githubCompany: { companyId, budget: boundedCompanyReads(dependencies.documentClient) }, ...names.claim(nameOwner, name) });
    } catch (error) {
      if (await nameTaken_(nameOwner, companyId, name).catch(() => false)) throw nameTaken(name); if (nameOwner !== undefined && (error as { code?: unknown }).code === "NOT_FOUND") throw unavailable();
      if ((error as { code?: unknown }).code === "CONFIG_INVALID" && /^CONFIG_INVALID: the GitHub App cannot access /.test((error as Error).message)) throw notAvailable();
      throw error;
    }
    return { name: id, latestRevision: 1, ...(companyId === undefined ? {} : { companyId }) };
  };
  const unboundRepositories = async () => { if (((dependencies.developer ?? dependencies.linking)?.companies ?? dependencies.companies) !== undefined) throw githubBindingRefusal(); return clientProjects.repositories(); }; return { // DEC 254zzz81 (CLIENT-ROUTES-BEFORE-ON 3): without the company GitHub bindings the App's installations cannot be filtered to a company: with a company layer, refused (never unfiltered); without one, as before. One line, so the line-keyed inventory sites below do not move.
    ...(dependencies.companyReads === undefined ? {} : { companyReads: dependencies.companyReads }), ...companyProjectCreatorOf(dependencies.githubBindings !== undefined, dependencies.companies),
    async clientRepositories(developerId) {
      if (dependencies.githubBindings === undefined) return unboundRepositories();
      const budget = boundedCompanyReads(dependencies.documentClient);
      const companyId = await githubCallerCompany(dependencies, developerId ?? "", budget);
      try {
        const listed = await budget.read(() => clientProjects.repositories());
        return await filterInstallationsFor(companyId!, listed, dependencies.githubBindings, budget);
      } catch { throw githubBindingRefusal(); }
    },
    async clientRepositoryChoices(developerId, query) {
      const budget = boundedCompanyReads(dependencies.documentClient);
      const companyId = await githubCallerCompany(dependencies, developerId, budget);
      let installations: ClientRepositoriesResponse["installations"];
      if (dependencies.githubBindings === undefined) installations = await unboundRepositories();
      else {
        try {
          installations = await filterInstallationsFor(companyId!, await budget.read(() => clientProjects.repositories()), dependencies.githubBindings, budget);
        } catch { throw githubBindingRefusal(); }
      }
      let marks: Map<string, string[]>;
      try { marks = await projectsByRepository(dependencies.documentClient, dependencies.tableName, companyId, boundedCompanyReads(dependencies.documentClient)); }
      catch { throw agentXError("RUNTIME_UNAVAILABLE", REPOSITORY_CHOICES_UNAVAILABLE); }
      return repositoryChoices(installations, marks, query);
    },
    async createClientProject(developerId, input, naming) {
      const url = `https://github.com/${input.repository}.git`;
      const budget = boundedCompanyReads(dependencies.documentClient);
      const companyId = await githubCallerCompany(dependencies, developerId, budget);
      await checkCompanyRepository(dependencies, companyId, url, budget);
      // Guided onboarding PR 6: where the live lookup is wired, a suspended installation is refused too, in the same words.
      if (rules.live !== undefined && !await onCompanyInstallations(rules, companyId, [url], budget)) {
        const repository = parseGitHubRepository(url);
        throw agentXError("CONFIG_INVALID", `the GitHub App cannot access ${repository.owner}/${repository.name}; install it on ${repository.owner} with access to that repository`);
      }
      const found = companyId === undefined ? await clientProjects.repositoryDefaults(url) : await budget.read(() => clientProjects.repositoryDefaults(url));
      const repositoryName = projectRepositoryName(found.name);
      const name = input.name ?? repositoryName; const nameOwner = names.owner(naming, companyId);
      if (await nameTaken_(nameOwner, companyId, name)) throw agentXError("CONFIG_INVALID", `a project named ${name} already exists; choose another name`); const id = await names.idFor(nameOwner, name);
      const cwd = `repo/${repositoryName}`;
      // One argument list each, split on spaces: no shell, so quotes and pipes are not interpreted.
      const command = (text: string) => { const [executable, ...args] = text.trim().split(/\s+/); return { cwd, executable: executable!, args, timeoutSeconds: 1_800 }; };
      const definition = ProjectDefinitionSchema.parse({
        name: id, revision: 1,
        repositories: [{ name: repositoryName, url, path: cwd, defaultBranch: found.defaultBranch, credentialRef: clientProjects.credentialRef }],
        setup: (input.setupCommands ?? []).map(command), readiness: (input.testCommands ?? []).map(command),
        orchestratorInstructions: CLIENT_PROJECT_INSTRUCTIONS,
      });
      // As the person: their developer ID owns the project, so they administer it and it is listed for them.
      const identity: AuthenticatedIdentity = { issuer: "sign-in-client", subject: developerId, ownerKey: developerId, isAdministrator: true, claims: {} };
      try { await registerProject(dependencies, identity, { definition, runtimeBinding: await clientProjects.workerBinding(), preflight: true }, { githubCompany: { companyId, budget }, ...names.claim(nameOwner, name) }); } catch (error) { if (nameOwner !== undefined && await names.taken(nameOwner, name).catch(() => false)) throw nameTaken(name); if (nameOwner !== undefined && (error as { code?: unknown }).code === "NOT_FOUND") throw unavailable(); throw error; } // L2-1
      return { name: id, latestRevision: 1, ...(companyId === undefined ? {} : { companyId }) };
    },
    async createClientProjects(developerId, input, naming) {
      const commitBy = Date.now() + COMMIT_DEADLINE_MS;
      const companyId = await githubCallerCompany(dependencies, developerId, boundedCompanyReads(dependencies.documentClient));
      return createFromRepositories(developerId, companyId, input.repositories, {
        ...(input.name === undefined ? {} : { name: input.name }), ...(input.setupCommands === undefined ? {} : { setupCommands: input.setupCommands }),
        ...(input.testCommands === undefined ? {} : { testCommands: input.testCommands }),
      }, commitBy, naming);
    },
    async createClientProjectsBulk(developerId, input, naming) {
      const commitBy = Date.now() + COMMIT_DEADLINE_MS;
      const companyId = await githubCallerCompany(dependencies, developerId, boundedCompanyReads(dependencies.documentClient)); names.owner(naming, companyId);
      return bulkCreate(input.repositories, {
        now: Date.now, nameOf: (repository) => projectRepositoryName(repository.split("/")[1]!),
        create: async (repository) => (await createFromRepositories(developerId, companyId, [repository], {}, commitBy, naming)).name,
      });
    },
  };
}

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
  const membership = await getMembership(dependencies, identity.ownerKey, task.project, grantCompany(dependencies, storedCompanyOf(task)));
  if (membership?.role !== "administrator" || !await administratorOfTaskCompany(dependencies, identity, task)) throw agentXError("FORBIDDEN", "administrator project membership is required");
  const claimed = [identity.claims.name, identity.claims.email].find((claim): claim is string => typeof claim === "string" && claim.trim() !== "");
  return adminShareMode(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions: tasks, now: Date.now },
    { issuer: identity.issuer, subject: identity.subject, ...(claimed === undefined ? {} : { displayName: claimed.trim() }) },
    await taskLegacyScope(dependencies, task),
    value,
  );
}

/**
 * M1.4 Task 4.10C: `POST /v1/admin/e2e/model-checks { kind: "drive" | "discover", modelId? }` asks the qualified runner for a driving test or a discovery (202 and the check's id);
 * `GET .../<checkId>` is pending until the runner has answered, then the validated outcome in the owner's sentence; `GET .../model-checks` (no id) is the tiers on record.
 */
async function adminModelChecks(dependencies: AwsBrokerDependencies, method: string, checkId: string | undefined, body: unknown, requestId: string): Promise<ReturnType<typeof json>> {
  if (dependencies.e2eAgentInstallation === undefined || dependencies.e2eFeatureRuntimeCatalogId === undefined) throw agentXError("NOT_FOUND", "AI navigation model checks are not set up in this deployment");
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  const checks: ModelCheckDependencies = {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, installation: dependencies.e2eAgentInstallation,
    readRuntimeRow: async () => (await getItem<Record<string, unknown>>(dependencies, e2eRegisteredRuntimeKey(catalogId, WEB_API_RUNTIME_PROFILE_ID, "web"))) ?? undefined,
    putObject: async (key, text) => { await dependencies.s3.send(new PutObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key, Body: text, ContentType: "application/json" })); },
    getObject: async (key) => {
      try {
        const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key }));
        return object.Body === undefined ? new Uint8Array() : await object.Body.transformToByteArray();
      } catch (error) {
        // Without a list grant S3 answers a missing key with AccessDenied: not there yet.
        const name = error instanceof Error ? error.name : "";
        if (name === "NoSuchKey" || name === "AccessDenied" || name === "Forbidden") return undefined;
        throw error;
      }
    },
  };
  try {
    if (method === "POST") return json(await startModelCheck(checks, body, WEB_API_RUNTIME_PROFILE_ID), requestId, 202);
    if (checkId !== undefined) return json(await readModelCheck(checks, checkId), requestId);
    return json({ tiers: await readCurrentTiers(checks) }, requestId);
  } catch (error) {
    if (!(error instanceof ModelCheckError)) throw error;
    // The code of the error is the fixed one of the check; the message never carries a model id from the request.
    throw agentXError(error.status === 400 ? "CONFIG_INVALID" : error.status === 404 ? "NOT_FOUND" : error.code === "check-in-progress" ? "WORKSPACE_BUSY" : "RUNTIME_UNAVAILABLE", `${error.code}: ${error.message}`);
  }
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
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  const repositoryUrl = input.repositoryUrl;
  return exchangeLegacyGitCredential({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, grants: dependencies.repositoryGrants, log: brokerLogLine }, {
    grant, workspaceId, operationId, operation, credentialRef, repositoryUrl, access,
    async closing() { const workspace = await getItem<{ status?: unknown }>(dependencies, workspaceKey(workspaceId)); return workspace?.status === "CLOSING" || workspace?.status === "CLOSED"; },
    authority: () => assertLegacyPushAuthority(dependencies, operation, access),
    async binding() {
      if (dependencies.githubBindings === undefined) return;
      const claims = dependencies.repositoryGrants.inspect(grant);
      if (claims.workspaceId !== workspaceId || claims.operationId !== operationId || !claims.repositories.some(repository => repository.credentialRef === credentialRef && repository.repositoryUrl === repositoryUrl && repository.access === access)) {
        throw agentXError("FORBIDDEN", "repository credential grant does not cover this request");
      }
      const workspace = await requireWorkspace(dependencies, workspaceId);
      const project = await readWorkspaceTaskLegacyProject(dependencies, workspace.id, () => requireProject(dependencies, workspace.projectName, workspace.projectRevision));
      await requireGithubProjectBinding(dependencies, project, repositoryUrl);
    },
  });
}

/**
 * The authority a legacy exchange needs before it gives out a credential. A publication of the old workflow engine (its checked tree is recorded on the operation) is refused: that engine no longer judges whether the authority is current (D1). The operation must still be its
 * workspace's active one at its fence, for a clone as for a push. A PUSH that has no candidate to check (a maintain, or a publish without `expectedTreeSha`) used to be given with no check at all: it also
 * needs the task (when there is one) to be open, and, for a maintain, the pull request's recorded head to be the one it was started on, and the workflow's candidate (when it has one) to be the one it was started for.
 */
async function assertLegacyPushAuthority(dependencies: AwsBrokerDependencies, operation: OperationRecord, access: "clone" | "push"): Promise<void> {
  if (operation.kind === "publish" && operation.publication?.expectedTreeSha !== undefined) throw agentXError("CALLBACK_FORBIDDEN", "workflow publication authority is stale");
  const stale = (): never => { throw agentXError("CALLBACK_FORBIDDEN", "push authority is stale"); };
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  if (workspace.fence !== operation.fence || workspace.activeOperationId !== operation.id) stale();
  if (access !== "push") return;
  const taskPointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  const task = taskPointer === undefined ? undefined : await getItem<DeveloperTaskRecord>(dependencies, taskKey(taskPointer.taskId));
  if (task !== undefined && (task.workspaceId !== operation.workspaceId || task.closedAt !== undefined)) stale();
  if (operation.kind !== "maintain") return;
  const maintenance = operation.maintenance;
  if (maintenance === undefined) return stale();
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(operation.workspaceId, maintenance.repository, maintenance.pullRequestNumber));
  if (record === undefined || record.expectedHeadCommit !== maintenance.expectedHeadCommit) stale();
  const binding = maintenance.workflowCandidate;
  if (binding !== undefined && (task?.workflow === undefined || task.workflow.stage !== "PULL_REQUEST" || task.workflow.state !== "RUNNING" || task.workflow.candidate?.digest !== binding.candidateDigest)) stale();
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

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const dynamoClient = new DynamoDBClient(awsClientConfiguration);
const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});
// Hosted wiring (d): lanes AU and EV's company reads, only where infra turns them on (COMPANY_READS=enabled, named environments).
const companyReads = companyReadsFromEnvironment(process.env, { dynamo: dynamoClient, documentClient });
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
  ...optionalPicker(machineSizePicker({ documentClient, tableName: process.env.STATE_TABLE_NAME ?? "" })),
});
const github = createGitHubAppCredentials(secretsManager, brokerLogLine);
/** Guided onboarding PR 4: Add to Slack (slack-company-install.ts), with the company layer only. Slack's side (the app's client secret, the code exchange, the token store's
 * writer) runs in DeveloperIdentity (slack-install-identity.ts), which this broker already invokes; the broker never reads the Slack app secret. */
const slackInstallSlack = process.env.COMPANY_SIGNIN !== "enabled" || !process.env.DEVELOPER_IDENTITY_FUNCTION_ARN ? undefined
  : slackInstallThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: process.env.DEVELOPER_IDENTITY_FUNCTION_ARN, Payload: payload })));
const slackInstallWiring: SlackInstallWiring | undefined = slackInstallSlack === undefined ? undefined : { slack: slackInstallSlack, log: brokerLogLine };
/** Guided onboarding PR 5: channel links (slack-channel-link.ts) and /rovara (slack-rovara-command.ts), through the same sign-in Lambda calls (the company's own token stays there). */
const slackChannelWiring: SlackChannelWiring | undefined = slackInstallSlack === undefined ? undefined : { slack: slackInstallSlack, log: brokerLogLine };
const githubCredentials = github.provider;
const lambdaClient = new LambdaClient(awsClientConfiguration);
// Guided onboarding PR 7: Linear by OAuth as the app, only where infra gives the token key (CHATGPT_CONNECTION_KEY_ARN); the app's settings come from its connector secret.
/** Batch 12: the core root buildBrokerHandler made (#872 builds it on the first request); Linear's intake asks it at delivery time. */
let builtCoreRoot: ReturnType<typeof createBrokerCoreRoot> | undefined;
const linear = linearCompanyWiring({ env: process.env, documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), kms: new KMSClient(awsClientConfiguration), secrets: secretsManager,
  connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX ?? CONNECTOR_SECRET_PREFIX, log: brokerLogLine, dynamo: dynamoClient,
  // L2-4: each company's tracker intake from the core root (built below; asked only at delivery time).
  // Batch 12 (#872 builds the core root on the first request, after the callback key is read): the root built then; no delivery reaches this before it.
  intakeFor: async (companyId, options) => await builtCoreRoot?.intake?.intakeFor(companyId, options),
  // R1 + L1 6.2b: a delivery before the root is built is answered 503 so Linear tries again; once it is built, a company with no intake is a quiet skip.
  rootBuilt: () => builtCoreRoot !== undefined });
// Guided onboarding PR 14 (DEC 254n item 1): the company engine model route's read of the gateway's live list for one company; set only where the gateway's origin is.
const companyEngineModelOffered = adminOfferedModelsFromEnvironment(process.env, () => taskTokensFromEnvironment(process.env, new KMSClient(awsClientConfiguration)));
/** Set only in named environments with developer sign-in (infra/lib/developer-signin.ts). */
function developerConfiguration(inviteTaskPerson?: DeveloperApiConfiguration["inviteTaskPerson"]): DeveloperApiConfiguration | undefined {
  return createDeveloperApiConfiguration(process.env, (issuer, functionName) => ({
    // Spec 061 slice 2: "Ask AgentX to reply to this comment" queues on the Slack service's request queue; set only where that service runs.
    ...(process.env.SLACK_REQUEST_QUEUE_URL ? { slackRequestQueue: slackRequestQueue(process.env.SLACK_REQUEST_QUEUE_URL) } : {}),
    channelMembers: channelMembersThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskPersonProof: taskPersonProofThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskChannelPeople: taskChannelPeopleThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskPeopleDisplayRead: taskPeopleDisplayReadThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelInfo: channelInfoThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackUserByEmail: slackUserByEmailThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackAuthCheck: slackAuthCheckThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    endDeveloperSessions: endDeveloperSessionsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    setDisplayName: setDisplayNameThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    ...(process.env.COMPANY_SIGNIN === "enabled" ? { companies: companyMembershipFromDynamo(documentClient, requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME")), companyPreapprovals: companyPreapprovalsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
      // DEC 253z, 254a: self-serve company create and the install's invite codes, through the same sign-in Lambda, which owns those writes.
      companySelfCreate: companySelfCreateThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
      companyInvites: companyInvitesThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
      // Lane W part 4: the company admin routes' member helper (T3b), through the same sign-in Lambda.
      companyMembers: companyMemberActionsThroughLambda({ documentClient, tableName: requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME"), invoke: (payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload })) }),
      // Guided onboarding PR 1: GitHub connect (github-connect-routes.ts), through the same App secret's client (slug, OAuth client) and the State table's bindings.
      githubConnect: { bindings: new GithubInstallationBindings(documentClient, requiredEnvironment("STATE_TABLE_NAME")), github: new GitHubAppClient(github.clientOptions), log: brokerLogLine },
      // L4-GH: a person links their own GitHub account (github-account-link-routes.ts), through the same App client's OAuth client and the core's own store.
      ...((wiring) => (wiring === undefined ? {} : { githubLink: wiring }))(githubLinkWiringFromEnvironment(process.env, { dynamo: dynamoClient, github: new GitHubAppClient(github.clientOptions), log: brokerLogLine })),
      // Guided onboarding PR 4: Add to Slack (slack-company-install.ts).
      ...(slackInstallWiring === undefined ? {} : { slackInstall: slackInstallWiring }),
      ...(slackChannelWiring === undefined ? {} : { slackChannels: slackChannelWiring }),
      // Guided onboarding PR 7: the Linear connect routes (linear-connect-routes.ts), where the token key is given.
      ...(linear === undefined ? {} : { linearConnect: linear.connect }),
      // R1 + L1: a member links their own Linear account; the admin lists and removes links (linear-account-link-routes.ts).
      ...(linear?.link === undefined ? {} : { linearLink: linear.link }),
      // Guided onboarding PR 14: the company engine model route, only where the model gateway is configured (its live list is the authority).
      ...(companyEngineModelOffered === undefined ? {} : { companyEngineModel: { offered: companyEngineModelOffered, installModel: () => installEngineModel(process.env), log: brokerLogLine }, companyLearningModel: { offered: companyEngineModelOffered, installModel: () => installLearningModel(process.env), log: brokerLogLine } }),
      // L4-EGR: Rovara's outbound addresses (the stack parameter NatEgressAddresses); an empty or absent value reads as an empty list.
      companyEgress: { addresses: () => process.env[EGRESS_ADDRESSES_VARIABLE] },
      // DEC 254w: connected sign-ins, through the same sign-in Lambda (it owns the sign-in table).
      signInLinks: signInLinksThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))) } : {}),
    signInClients: signInClientsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    // DEC 254b (b): the operator's company import runs BEFORE COMPANY_SIGNIN is switched on, so it is wired with the company layer on or off.
    companyImport: companyImportThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelByName: channelByNameThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    // D17: kept for the Lambda's lifetime; an unknown kid refetches at most once a minute.
    verifyAccessToken: developerTokenVerifier({
      issuer,
      keys: developerKeysThroughLambda((payload, options) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }), options)),
      now: Date.now,
    }),
  }), inviteTaskPerson);
}
/** The Slack request queue (FIFO) as "Ask AgentX to reply to this comment" sends to it. */
function slackRequestQueue(queueUrl: string): SlackRequestQueue {
  const client = new SQSClient(awsClientConfiguration);
  return {
    async send(message) {
      await client.send(new SendMessageCommand({
        QueueUrl: queueUrl, MessageBody: message.body, MessageGroupId: message.groupId, MessageDeduplicationId: message.deduplicationId, MessageAttributes: message.attributes,
      }));
    },
  };
}
// Spec 064: the legacy deployment's sign-in is for account linking only (DEVELOPER_API_SCOPE=linking, set by infra).
const signIn = developerConfiguration();
const linkingOnly = process.env.DEVELOPER_API_SCOPE === "linking";
const linking = linkingOnly ? signIn : undefined;

// DEC 254g: the gateway's offered models for an administrator's config set; set only where the gateway's origin is.
const offeredModelsKms = new KMSClient(awsClientConfiguration);
const coreOfferedModels = adminOfferedModelsFromEnvironment(process.env, () => taskTokensFromEnvironment(process.env, offeredModelsKms));

// Sign in with ChatGPT (#338): set only where the control plane has the connection key.
const chatGptKeyArn = process.env.CHATGPT_CONNECTION_KEY_ARN;
const chatgpt = chatGptKeyArn === undefined || chatGptKeyArn === "" ? undefined : chatGptConnections({
  documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), fetch, now: Date.now,
  sealer: kmsChatGptSealer(new KMSClient(awsClientConfiguration), chatGptKeyArn),
  // The key is this install's own, so its ARN names the install to OpenAI.
  hostId: chatGptHostId(chatGptKeyArn),
});

// Spec 025 A13: the health route's probes (health-probes.ts); clients are called only per request.
const cloudWatch = new CloudWatchClient(awsClientConfiguration);
const sqs = new SQSClient(awsClientConfiguration);

// L2-2 PR 18c: Slack company mode (both switches on, slack-company-wiring.ts); off, nothing is added and the broker is today's.
// DEC 254zzz35: installToken, so the hosted core's Slack task threads post in the install's own workspace too (its bot token is the install's Slack app secret).
const slackCompany = slackCompanyDependenciesFromEnvironment(process.env, { documentClient, dynamo: dynamoClient, secrets: secretsManager, installToken: true,
  ...(process.env.DEVELOPER_TOKEN_ISSUER ? { linkOrigin: process.env.DEVELOPER_TOKEN_ISSUER } : {}) });

function brokerSlackAndCoreHeaderWiring() {
  return {
    ...(coreOfferedModels === undefined ? {} : { coreOfferedModels }),
    ...(slackCompany === undefined ? {} : { workspaces: slackCompany.workspaces, ...(slackCompany.companies === undefined ? {} : { slackCompanies: slackCompany.companies }) }),
    ...(process.env.SLACK_TEAM_ID === undefined ? {} : { slackWorkspaceLegacyTeamId: process.env.SLACK_TEAM_ID }),
    slackModelAccess: { env: process.env, taskTokens: () => taskTokensFromEnvironment(process.env, new KMSClient(awsClientConfiguration)) },
    ...(slackInstallWiring === undefined ? {} : { slackInstall: slackInstallWiring }),
    ...(slackChannelWiring === undefined ? {} : { slackChannels: slackChannelWiring }),
    ...(process.env.ROVARA_SIGNIN_URL === undefined ? {} : { slackSignInUrl: process.env.ROVARA_SIGNIN_URL }),
  };
}

function brokerOptionalFeatureWiring(developer: DeveloperApiConfiguration | undefined) {
  return {
    ...(process.env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID
      ? { projectSetupRuntimeCatalogId: process.env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID }
      : {}),
    ...(process.env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID
      ? { e2eFeatureRuntimeCatalogId: process.env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID }
      : {}),
    githubWebhookSecret: github.webhookSecret,
    ...(linear === undefined ? {} : { linearWebhook: linear.webhook }),
    checkRepositoryAccess: (repository: { url: string; credentialRef: string }) => githubCredentials.checkRepository(repository),
    githubMcp: { credentials: (repository: { url: string; credentialRef: string }, access: "read" | "write") => githubCredentials.issueCredentials(repository, access) },
    connectorCredentials: {
      secrets: secretsManagerSource(secretsManager, process.env.CONNECTOR_SECRET_PREFIX),
      githubApp: { ref: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), secretName: github.privateKeySecretArn },
      ...(process.env.CONNECTOR_SECRET_PREFIX ? { connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX } : {}),
    },
    codeBuild,
    ...(developer ? { developer } : {}),
    ...(linking ? { linking } : {}),
    ...(companyReads ? { companyReads } : {}),
    ...(chatgpt ? { chatgpt } : {}),
    // Spec 062: channel adapters, only where the deployment turns them on (infra/lib/channel-adapters.ts).
    ...(process.env.CHANNEL_ADAPTERS === "enabled"
      ? { channelAdapters: {
          secretPrefix: requiredEnvironment("CHANNEL_ADAPTER_SECRET_PREFIX"),
          secrets: secretsManagerAdapterSecrets(secretsManager),
        } }
      : {}),
    // M1.4 Task 4.2: the installation's worker model settings (SSM, ids and ARNs only), read per request. Absent until a guarded deploy sets the prefix and grants the read, so the
    // AI navigation route cannot be derived and agent steps stay unavailable (`agent-route-not-approved`).
    ...(process.env.AGENTX_E2E_AGENT_SETTINGS_PREFIX
      ? { e2eAgentInstallation: () => e2eAgentInstallationFromParameters(requiredEnvironment("AGENTX_E2E_AGENT_SETTINGS_PREFIX"), async (names) => {
          const response = await ssm.send(new GetParametersCommand({ Names: [...names] }));
          return new Map((response.Parameters ?? []).flatMap((parameter) => parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []));
        }, process.env.AWS_REGION, { readShape: (modelId) => readE2EModelRouteShape({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }, E2E_DEFAULT_MODEL_ROUTE_ID, modelId) }) }
      : {}),
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
        log: brokerLogLine,
      }),
    },
  };
}

function brokerSlackWiring() {
  return {
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
  };
}

/**
 * The broker's handler, built on the first request, once the callback signing key has been read from Secrets Manager (callback-signing-key.ts): the control plane gives this function
 * the secret's ARN, never the key. A failed read builds nothing and is tried again on the next request.
 */
function buildBrokerHandler(callbackSigningKey: string) {
  const repositoryGrantSigningKey = createHmac("sha256", callbackSigningKey)
    .update("agentx:repository-grants:v3")
    .digest();
  const repositoryGrants = new RepositoryGrantService(
    repositoryGrantSigningKey,
    (credentialRef, repositoryUrl, access) => githubCredentials.resolve(credentialRef, repositoryUrl, access),
  );
  // Lane E2 step 6: the core engine's root. Every new task of a member company starts on it (#1275).
  const coreRoot = createBrokerCoreRoot({
    applicationSource: (repositoryUrl, commit) => githubCredentials.captureE2ESourceSnapshot(repositoryUrl, commit),
    env: process.env,
    documentClient,
    stateTableName: requiredEnvironment("STATE_TABLE_NAME"),
    signInTableName: process.env.DEVELOPER_SIGNIN_TABLE_NAME,
    callbackSigningKey,
    repositoryGrantKey: repositoryGrantSigningKey,
    repositoryCredential: (credentialRef, repositoryUrl, access) => githubCredentials.resolve(credentialRef, repositoryUrl, access),
    checkTaskPerson: async (task, developerId, admission) => {
      if (signIn === undefined) throw new Error("task person proof is unavailable");
      const deps = developerTaskRouteDependencies({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), developer: signIn, now: Date.now, ...slackCompany },
        { developerId, sessionId: "core", name: "", amr: "oidc" }, undefined, null);
      return await deps.checkTaskPerson!(task, developerId, admission);
    },
    // Cloud #188 item 3: a core task's People, readers, events and plan comments use the old task routes' own dependencies for this person (built as the People proof above is), in their live company.
    taskRules: (person, companyId) => {
      if (signIn === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "task people are unavailable in this deployment");
      return { ...developerTaskRouteDependencies({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), developer: signIn, now: Date.now, ...(slackCompany === undefined ? {} : { workspaces: slackCompany.workspaces, companies: slackCompany.companies }) },
        { developerId: person.developerId, sessionId: "core", name: person.name, amr: "oidc" }, undefined, null), companyId };
    },
    // Lane L1b: the core's code host is the same GitHub App, company-scoped (aws/core-code-host.ts): a company's own projects' repositories only, its installation binding at every mint.
    codeModules: (core) => brokerCoreModuleDeps(process.env, {
      dynamo: dynamoClient,
      objects: { bucket: requiredEnvironment("ARTIFACT_BUCKET_NAME"), client: s3, retentionTags: EVIDENCE_RETENTION_TAGS },
      secrets: { namePrefix: process.env.CONNECTOR_SECRET_PREFIX ?? CONNECTOR_SECRET_PREFIX, clientFor: () => secretsManager },
      workerMachines: () => brokerCoreWorkerMachines({ sessions: ec2Sessions, documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }),
      codeHost: () => brokerCoreCodeHost({
        credentials: github.clientOptions,
        ...((bindings) => ({ requireInstallationBound: bindings.requireBound, disconnectedFor: (orgId: string, owner: string) => bindings.disconnectedFor(orgId, owner) }))(new GithubInstallationBindings(documentClient, requiredEnvironment("STATE_TABLE_NAME"))),
        storage: core.storage,
        log: (entry) => console.log(JSON.stringify({ component: "core-engine", ...entry })),
      }),
    }),
    // L4-HW3b: the project's own merge rules (the record the developer API's code-settings route saves), not Code's defaults: for how we work (every company's runtime) and for the merge
    // tracker (this company's only). A project with none saved reads the defaults, as before. The laptop's rules are fixed instead (local/app/app.ts:395 and local/app/tracking.ts:34).
    codeSettings: codeSettingsReader({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }),
    // `taskPeople` (the task People list the merge requesters are read from, aws/hosted-merge-people.ts) is REQUIRED by the job services: a root built without it throws.
    services: (companyId, flow, registry, wiring) => createHostedBrokerCoreServices({ companyId, flow, registry, ciMode: wiring.ciMode!,
      settings: companyCodeSettingsReader({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }, companyId), taskPeople: { documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }, ...(wiring.humanEdit === undefined ? {} : { humanEdit: wiring.humanEdit }), ...(wiring.threadMoments === true ? { threadMoments: true } : {}), ...(wiring.ticketMoments === true ? { ticketMoments: true } : {}), ...(wiring.threadRefresh === undefined ? {} : { threadRefresh: wiring.threadRefresh }),
      // The email seams travel with the upkeep notice's (#959); L4-AK1H: a queued admin notice (unusual team knowledge reading) is told only to someone who is an admin now (the core root answers once built; before that: no one).
      notification: { ...(wiring.notification ?? {}), ...(wiring.upkeep === undefined ? {} : { upkeep: wiring.upkeep }), adminNotice: async (orgId, developerId) => (await builtCoreRoot?.adminNotice?.(orgId, developerId)) === true },
    }),
    // L4-LPPL: who approves, who is on a project's roster and who a lesson may name, from the install's own live member and grant records (aws/hosted-lessons-people.ts). Without the sign-in table
    // (no company layer) nothing is given, so lessons stay unbuilt and are reported (core_engine.lessons_not_wired), never built over no people.
    ...(process.env.DEVELOPER_SIGNIN_TABLE_NAME === undefined || process.env.DEVELOPER_SIGNIN_TABLE_NAME === "" ? {} : {
      lessonsPeople: createHostedLessonsPeople({ documentClient, stateTableName: requiredEnvironment("STATE_TABLE_NAME"), signInTableName: process.env.DEVELOPER_SIGNIN_TABLE_NAME, now: Date.now }),
    }),
    // L4-HW2: the lessons' learning calls (the reflector, the curator's judge, the outcome judge) go through the model gateway's learning route on the COMPANY's own provider account and learning cap
    // (core-host/hosted-learning.ts); asked only for a company the lessons switch names. No gateway settings or no task-token key: no port, so learning calls refuse and nothing is spent.
    // DEC 254zzz58: on its OWN model (ROVARA_CORE_LEARNING_MODEL, else claude-haiku-5-5; a company's own choice wins, read per call from its store by the root), never the agent model.
    lessonsLearning: hostedLessonsLearning(process.env, () => taskTokensFromEnvironment(process.env, new KMSClient(awsClientConfiguration))),
    // L4-HW8: the lessons' Slack source reads a task's own thread through the signed `thread_messages` command of the deployment's Slack adapter (aws/hosted-slack-thread.ts); no adapter env, no source.
    ...((slack) => (slack === undefined ? {} : { lessonsSlack: slack }))(hostedLessonsSlack({ env: process.env, secretsManager, workspaces: slackCompany?.workspaces, legacyTeamId: process.env.SLACK_TEAM_ID || process.env.SLACK_ADAPTER_TEAM_ID })),
    // L4-HW3d: the project's stored CI mode (real_check) and the company's rules lock decide merge tracking's CI mode, as on the settings page; cached per company and project, unreadable refuses.
    // Same table and same rules service as the per-task limit reader (no new IAM, store or outside call). The dispatcher roots wire none (they track no merges).
    hostedPolicySource: (hook) => hostedPolicySource({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), now: Date.now }, hook),
    policyHookInstall: () => policyHookInstallFromEnvironment(process.env, new KMSClient(awsClientConfiguration)), taskTokens: () => taskTokensFromEnvironment(process.env, new KMSClient(awsClientConfiguration)),
    origin: () => process.env.DEVELOPER_TOKEN_ISSUER ?? "",
    log: (entry) => { process.stderr.write(`${JSON.stringify({ component: "core-engine", ...entry })}\n`); },
    // L2-4: the tracker intake and ticket write-back over the company's own Linear connection, where Linear is wired.
    ...(linear === undefined ? {} : { linearIntake: { connections: linear.connections } }),
    // L4-U5b: where Slack runs in company mode, a core task started from a Slack thread is told its milestones there, through its own company's workspace token only.
    ...(slackCompany === undefined ? {} : { chatThreads: hostedSlackThreads({ workspaces: slackCompany.workspaces, log: brokerLogLine, ...(slackCompany.companies === undefined ? {} : { person: createSlackPersonResolver({ workspaces: slackCompany.workspaces, store: slackCompany.workspaces.store, companies: slackCompany.companies }) }) }) }),
  });
  builtCoreRoot = coreRoot;
  // Lane L12: where a core is wired, the core's /v1/app/* routes too (coreApp); without one, neither is set and the developer configuration is as before.
  const developer = linkingOnly || signIn === undefined ? undefined : withCoreRoutes(signIn, coreRoot);
  return createAwsBrokerHandler({
    core: coreRoot,
    ...brokerSlackAndCoreHeaderWiring(),
    documentClient,
    s3,
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
    issuer: requiredEnvironment("OIDC_ISSUER"),
    adminClaim: process.env.ADMIN_CLAIM ?? "cognito:groups",
    adminValues: JSON.parse(process.env.ADMIN_VALUES ?? "[\"agentx-admin\"]") as string[],
    callbackSigningKey,
    repositoryGrants,
    githubPullRequests: githubCredentials,
    // Spec 065b: where the foundation's worker settings are given, a sign-in client may create projects.
    githubBindingInstallations: { get: id => githubCredentials.bindingInstallation(id), page: page => githubCredentials.bindingInstallations(page) },
    ...(process.env.EC2_WORKER_SUBNETS && process.env.EC2_WORKER_LAUNCH_TEMPLATE_ID ? { clientProjects: {
      credentialRef: githubCredentials.credentialRef,
      repositoryDefaults: (url: string) => githubCredentials.repositoryDefaults(url),
      repositories: () => githubCredentials.installedRepositories(),
      repositoryInstallation: (url: string) => githubCredentials.repositoryInstallation(url),
      // gh-bindings (batch 20): the client project routes filter and check repositories by the company's own bindings (withClientGithubBindings); the rest of the broker is unchanged.
      bindings: new GithubInstallationBindings(documentClient, requiredEnvironment("STATE_TABLE_NAME")),
      workerBinding: async () => workerBindingFromPairs(process.env.EC2_WORKER_SUBNETS!, process.env.EC2_WORKER_LAUNCH_TEMPLATE_ID!),
    } } : {}),
    projectSetupSource: { capture: ({ repositoryUrl, ref }) => githubCredentials.captureE2ESourceSnapshot(repositoryUrl, ref) },
    ...brokerOptionalFeatureWiring(developer),
    async deleteEc2Session(workspaceId) {
      await ec2Sessions.deleteSession(workspaceId);
    },
    ...brokerSlackWiring(),
  });
}

type BrokerHandler = ReturnType<typeof createAwsBrokerHandler>;
let brokerHandler: Promise<BrokerHandler> | undefined;
export const handler: BrokerHandler = async (event, context) => {
  brokerHandler ??= loadCallbackSigningKey(process.env, secretsManager).then(buildBrokerHandler).catch((error: unknown) => {
    // Not kept: the next request reads the secret again. Nothing is served meanwhile, so a missing key never signs.
    brokerHandler = undefined;
    throw error;
  });
  return (await brokerHandler)(event, context);
};

/** One broker log line writer; company-scoped events wrap it with companyLog so the helper owns companyId. */
function brokerLogLine(entry: Record<string, unknown>): void { console.log(JSON.stringify({ component: "broker", ...entry })); }

/**
 * Q2: a project grant names a project by NAME only (its rows carry no company). On an install with company sign-in (a membership reader), the grant counts for a task only when the
 * administrator's live membership is the task's own company, read from the stored task (an old task without a company is the install's fixed company, as everywhere: `recordInCompany`).
 * No membership, or one that can't be read, counts as another company's: the caller then gets the missing grant's answer. Without company sign-in there is one company and nothing changes.
 */
async function administratorOfTaskCompany(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, task: DeveloperTaskRecord): Promise<boolean> {
  // The deployment wires the reader on the developer sign-in (COMPANY_SIGNIN=enabled), as the other admin routes read it; the top-level reader is the same reader where a host sets it.
  const companies = dependencies.developer?.companies ?? dependencies.companies;
  if (companies === undefined) return true;
  let companyId: string | undefined;
  try { companyId = await companies.companyOf(identity.ownerKey); } catch (error) { rethrowMembershipReadFailure(error); return false; }
  return companyId !== undefined && recordInCompany(task, companyId);
}

/** R2-F1 review M3: the admin change plan's handlers (its revision check reads the registering company's key), for tests. */
export function adminChangeHandlersForTests(input: AwsBrokerInput): AdminChangeHandlers {
  const brokerInput: Omit<AwsBrokerInput, "core"> = { ...input };
  delete (brokerInput as AwsBrokerInput).core;
  return adminChangeHandlers(brokerDependencies(brokerInput));
}

/** R2-F1 review M3: registerProject itself, so tests drive a named company's registration (second revision, duplicate, pending candidate) directly. */
export function registerProjectForTests(input: AwsBrokerInput, identity: AuthenticatedIdentity, value: unknown, companyId: string | undefined): ReturnType<typeof registerProject> {
  const brokerInput: Omit<AwsBrokerInput, "core"> = { ...input };
  delete (brokerInput as AwsBrokerInput).core;
  return registerProject(brokerDependencies(brokerInput), identity, value, { githubCompany: { companyId, budget: boundedCompanyReads(input.documentClient) } });
}

/** Guided onboarding L2-1: the client create's dependencies, so tests can call it with per-company naming before any route does (PR 19 wires the route). */
export function clientProjectDependenciesForTests(input: AwsBrokerInput): ReturnType<typeof clientProjectRouteDependencies> {
  const brokerInput: Omit<AwsBrokerInput, "core"> = { ...input };
  delete (brokerInput as AwsBrokerInput).core;
  return clientProjectRouteDependencies(brokerDependencies(brokerInput));
}

/**
 * gh-bindings (batch 20): the client project routes (repository list, picker, single, multi and bulk creates) with the company GitHub bindings the deployed broker
 * gives them in `clientProjects.bindings`, and the live membership reader the sign-in configuration already holds (top-level `companies` is unset on hosted).
 * With them, the list and picker show only the caller's company's bound installations, a create checks every repository against that company's bindings, and a
 * live company owner or admin may create (`companyProjectCreatorOf`). Only these routes: the broker-wide `githubBindings` (webhooks, their recovery partitions,
 * mints, the administrator's own registration) stays as the host set it. Without a membership reader (no company layer) nothing changes.
 */
function withClientGithubBindings(dependencies: AwsBrokerDependencies): AwsBrokerDependencies {
  const bindings = dependencies.clientProjects?.bindings;
  const companies = dependencies.companies ?? (dependencies.developer ?? dependencies.linking)?.companies;
  if (bindings === undefined || dependencies.githubBindings !== undefined || companies === undefined) return dependencies;
  return { ...dependencies, githubBindings: bindings, companies };
}

/** The two dedicated read contracts have no transport request ID in their domain body. */
function serverReadJson(value: unknown, statusCode = 200) {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "private, no-store" }, body: JSON.stringify(value) };
}

/** Keep the dedicated read contracts' domain bodies and failures at the transport boundary. */
async function developerRouteResponse(request: AdaptedHttpRequest, url: URL, work: () => Promise<unknown>) {
  const selectedRead = isServerReadRequest(request.method, url.pathname);
  try {
    const value = await work();
    return selectedRead ? serverReadJson(value) : json(value, request.requestId);
  } catch (error) {
    if (!selectedRead) throw error;
    if (error instanceof AgentXError) return serverReadJson({ error: { code: error.code, message: stripCode(error.message, error.code) } }, error.statusCode);
    return serverReadJson({ error: { code: "RUNTIME_UNAVAILABLE", message: request.method === "GET" ? "Start status is unavailable." : "GitHub disconnect preview is unavailable." } }, 503);
  }
}