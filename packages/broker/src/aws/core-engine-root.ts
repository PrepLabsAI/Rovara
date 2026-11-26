import { readingMembership } from "../core/membership-read.js";
import { hostedAutofixDayBudgetHasRoom } from "../core-host/autofix-day-budget.js";
import type { E2ESourceSnapshot } from "@agentx/contracts";
import { hostedAuthorityStore } from "./core-e2e-authority-store.js";
import { wireHostedApplicationE2E } from "./core-application-e2e.js";
import { composeHostedPrFeedbackRoutes } from "../core-host/pr-feedback-routes.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { developerTaskPolicy } from "@agentx/contracts";
import { prepareCoreShare } from "./core-task-sharing.js";
import { runPriceReader } from "../core-host/run-price-http.js";
import { withFeedbackMergeReads } from "../core/pr-feedback/service.js";
import { accessRetryRoute } from "./core-access-retry.js";
import { sweepCoreIdleSlack } from "./core-idle-slack.js";
import { withTaskEndReconcile } from "./task-end-reconcile.js";
import { taskEndedSender } from "../core-host/task-ended-http.js";
import { isContextSourceStage } from "@agentx/contracts";
import { createHostedDesignReview } from "../core-host/hosted-design-review.js";
import { DESIGN_REVIEW_PACKET_PATH, storedBindingOf } from "../core/design-review/packet-route.js";
import { readTaskTokenRecords } from "../core/model-gateway/records.js";
import { withinTaskTokenDeadline } from "../core/model-gateway/deadline.js";
import { coreContextWorkerRouteOf } from "./dev-route-scopes.js";
import { previewRateReaderFromEnvironment } from "../core-host/start-estimates-rate-read.js";
import { gatewayRateQuoteReaderFromEnvironment } from "../core-host/gateway-quote-http.js";
import { startEstimates } from "../core/cost/start-estimates.js";
import { hostedPreviewContext } from "../core-host/start-estimates.js";
import { recordClosedRunUsage } from "../core/cost/run-usage.js";
// Engine host (migration plan v3.2 lane E2, step 6): the core engine's composition root on the deployed BROKER. The dispatcher's half is aws/worker-machines/dispatcher-core.ts.
//
// One object per function container, built at module load, over the core host app (core-host/app.ts). The core engine has no switch (#1275). It wires:
//   - the registry: Code's AWS modules (core-host/code-modules.ts), the step 5 security modules (core-host/hosted-modules.ts) and whatever else the deployment adds, with the policy hook
//     put in front of admission and approvers last before the seal (hosted wiring (c)): ROVARA_POLICY_HOOK holds the install's hook settings; absent, nothing changes; settings without the
//     install's question key refuse the registry.
//   - each company's runtime: the deployed task access (membership plus the project grant the broker already keeps, `hostedTaskAccess`), the callback signing key, the repository grants
//     the broker's exchange verifies, and the services: lessons (`createCoreLessons`, where ROVARA_CORE_LESSONS covers the company and the deployment gives its people) plus the
//     deployment's own.
//   - the developer task routes' core entry (`coreTasks`): the core host's dev routes over the caller mapping (the broker's signed-in developer -> the principal the core knows, company
//     from MEMBERSHIP, never a claim; the verified token's sign-in method rides along), with the session cap (hosted wiring (f)) and every audit event of a script token naming the caller it came
//     through (hosted wiring (d)).
//     Lane L11 adds, per company: the session levels (live membership role, the broker's project grant), the decision cards (the task's own person's waiting documents; an act goes
//     through the approval gate with the approvers point's own signed one-act proof, lane L2a) and how we work (the code host, with the deployment's `codeSettings`). Each part the
//     deployment does not give answers "not on the core yet".
//   - `handleEvent`: a schedule's `agentx.core-job` event runs its job (with the function's time left), and a State table stream batch relays the outbox of the companies whose outbox rows
//     it inserted. Anything else is not the core's (`undefined`).
//
// What the registry still lacks (model keys, the broker's worker machines) and the job services no lane has built for AWS yet (merge tracking, the session sweep, notices)
// refuse the switch by name at the first use: the registry is never half-wired, and a refused build is retried on the next use. The admission's hold sweep is the root's own (lane L8),
// and the company's callback layer books its workers' usage reports into the cost ledger (core-host/usage-booking.ts).
import { profileDisplayName } from "../developer/github-profile.js";
import { projectTaskCapReader, type ProjectSettingsHook } from "./project-settings.js";
import { enginePolicyHook, policyHookSettingsFromEnvironment } from "./engine-policy-hook.js";
import { outboxCompaniesOf, relayCoreOutboxStream } from "./core-outbox-stream.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  HostedSavedEnvRegistryAuthSchema,
  DEFAULT_CODE_SETTINGS,
  CORE_DISPATCH_QUEUE_URL_VARIABLE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE, CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE, LESSONS_REFLECT_QUEUE, IMPLICIT_COMPANY_ID, evalStandInsOn, codeRepositoriesOf, OrgRoleSchema, AgentXError, agentXError, WIKI_BUILD_WORDS,
  when, isSystemOwnerId, type PolicySource, type AdapterRegistry, type HostedPolicyHookSettings, type ProjectRole, type DocumentStore, type OrgId, type OrgRole, type Principal,
} from "@agentx/contracts";
import { wakeMergeTrackingForPerson } from "../services/merge-tracking.js";
import { hostedMergeDependencies } from "./hosted-merge-deps.js";
import { createCoreHostApp, type CoreHostApp } from "../core-host/app.js";
import { CORE_DISPATCH_QUEUE, codeAdapterModules, type CodeModuleDeps } from "../core-host/code-modules.js";
import { resolveTaskPeopleAccess, type TaskPeopleDependencies, type CheckTaskPerson } from "../developer/task-people.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskOwnerKey } from "../developer/task-records.js";
import { listedStepVerdict } from "./hosted-step-owner.js";
import { isWholeLimit, MAX_PER_PERSON, MAX_PER_ORGANIZATION, readWorkspaceLimits } from "../developer/limits.js";
import { costUsdOf } from "../core/cost/ledger.js";
import { estimatePathOf, recordRunCost, runCostInputOf } from "../core/cost/estimate.js";
import { withSharedMergeRecovery, policyCiReporting } from "./core-job-services.js";
import type { CoreServiceWiring, CoreRuntimeOptions, CoreService, CoreServiceName } from "../core-host/core-runtime.js";
import type { CiReporting } from "../core-host/core-wiring-guard.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../core-host/dev-routes.js";
import { SETUP_RUN_NOT_ALLOWED, type SetupRunStanding } from "../core-host/setup-run-routes.js";
import { createHostedSetupApproval } from "../core-host/setup-approval.js";
import { readyProfilesFor, sandboxAvailableFor } from "../core/setup-agent/browser-testing-sandbox.js";
import { headOf } from "../core/setup-agent/snapshot.js";
import { createHostedTestEnvironmentApproval } from "../core-host/test-environment-approval.js";
import { createCompanyTaskSpend } from "../core-host/company-task-spend.js";
import { createUnreportedRunSettler } from "../core-host/unreported-run-settle.js";
import { gatewayRunChargesReaderFromEnvironment } from "../core-host/gateway-run-charges-http.js";
import { createSetupRegistryMirror } from "./setup-registry-mirror.js";
import { hostedStandingInstructions } from "../core-host/standing-instructions.js";
import { lifecycleAccess } from "./project-lifecycle-routes.js";
import { codeHostForRecord } from "../plugins/routing.js";
import { deployedDevWiringParts, deployedSessionMembers, hostedChatApproval, hostedDecisionService, approvalDecisionProofs, type DeployedPeople } from "../core-host/deployed-decisions.js";
import { decideFromChat } from "../core-host/chat-decision.js";
import { createEvalPlanSources } from "../core/setup-agent/eval-plan-source.js";
import { createEvalStandInDescriptorSource } from "../core/setup-agent/eval-stand-in-descriptor.js";
import { setupAgentKey } from "../core/setup-agent/keys.js";
import { boundEvalMonthlyCap, boundEvalProviderConnected } from "../core/setup-agent/eval-reservation.js";
import { createEvalWrapperTargets } from "../core/setup-agent/eval-wrapper-targets.js";
import { createEvalEnvironmentSource, evalSavedEnvDepsOf, repositoryPathsOf, type EvalEnvironmentSource } from "../core/setup-agent/eval-environment-source.js";
import type { EvalPlanSources } from "../core/proof/eval-plan-delivery.js";
import { approvalProofKeyOf } from "../core-host/hosted-approvers.js";
import type { CodeSettingsReader } from "../core/merge/seams.js";
import {
  HOSTED_IDENTITY_PROVIDER, createHostedHoldSweep, createHostedLedger, createHostedMoneyStop, hostedSecurityModules, hostedTaskCapUsd, readHostedAdmissionSettings, runSpendState, runStopWiredFrom, taskCapOf, type HostedAdmissionSettings, type HostedIdentityOptions, type ProjectTaskCap,
} from "../core-host/hosted-modules.js";
import { USAGE_EVENT_TYPE, createUsageBooking } from "../core-host/usage-booking.js";
import { wireHostedTierReview } from "../core-host/hosted-tier-review.js";
import { createLessonsApi, type LessonsApi } from "../core-host/lessons-api.js";
import { createLessonsSlackSwitchApi, type LessonsSlackSwitchApi } from "../core-host/lessons-slack-switch-api.js";
import { createKnowledgeSwitchApi, type KnowledgeSwitchApi } from "../core-host/knowledge-switch-api.js";
import { createHostedSystemRuns, effectiveSystemRunsGateOf, hostedSystemRunsFor, hostedUpkeepOn, readSystemRunsSwitch, upkeepAvailableFor } from "../core-host/system-runs.js";
import { createHostedAutomationStop, createHostedWikiRefresh } from "../core-host/wiki-refresh.js";
import { createHostedSetupRepair } from "../core-host/setup-repair.js";
import { createUpkeepAdministers, createUpkeepRecipients } from "../core-host/upkeep-recipients.js";
import { queueSetupBroken } from "../core/notify/attention.js";
import type { ChatThreads } from "../core-host/chat-threads.js";
import { projectPageUrl } from "../core/decisions/open-path.js";
import { createCoreTaskRuleRoutes } from "./core-task-rule-routes.js";
import type { DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import { recordChatThread } from "../core-host/chat-thread-record.js";
import { taskActionChatOf } from "../core-host/task-action-routes.js";
import { hostedChannelView, hostedThreadHandler, hostedThreadNotification, hostedWorkflowThreadRefresh } from "../core-host/thread-notification.js";
import { addChatThreadInput } from "../core-host/chat-thread-input.js";
import { readSetupBrokenNotice } from "../core/setup-agent/repair-view.js";
import { admissionEnforcesCost } from "../core/automation/run-seam.js";
import { upkeepPauseHooks } from "../core/upkeep/wiring.js";
import { upkeepIsOn } from "../core/upkeep/settings.js";
import { readUpkeepCap, upkeepRoomCentsOf, type UpkeepCapReader } from "../core/upkeep/cap.js";
import { upkeepCapReaderFromEnvironment } from "../core-host/upkeep-cap-http.js";
import { CompanySignInStore } from "../developer/company-membership.js";
import { listProjectMembers } from "./admin-actions.js";
import { createKnowledgeApi, scriptTokenAuthenticator, type KnowledgeApi } from "../core-host/knowledge-api.js";
import { developerIdOf } from "../core/sessions/create.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, type CoreLessons, type CoreLessonsOptions } from "../core-host/lessons.js";
import type { CoreAdapterModule } from "../core-host/registry.js";
import type { TaskAccess, TaskFlowDeps } from "../core/task-flow/deps.js";
import { WORKSPACE_NOT_FOUND, stopWorkspaceAsAdministrator } from "../core/task-flow/stop-request.js";
import type { RegistryTaskFlowOptions, TaskFlow } from "../core/task-flow/flow.js";
import { workspaceKeys } from "../core/task-flow/workspace-location.js";
import { createCompanyArtifactReader } from "../core-host/company-artifact-reader.js";
import { hostedKeepEvidence } from "../core-host/hosted-evidence.js";
import { hostedPlanEvidence } from "../core-host/hosted-plan-evidence.js";
import { sessionBindingsOf } from "../core/sessions/bindings.js";
import { createLocalAfterMerge } from "../core-host/app/after-merge.js";
import { hostedAutonomy, reviewerRoomUsd } from "../core-host/reviewer-authority.js";
import { createHostedReviewers } from "../core-host/hosted-reviewers.js";
import type { PolicyHookInstall } from "../core/policy-hook/index.js";
import { applyHostedPolicyHook } from "../core/policy-hook/hosted.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import type { HostedAnswersWiring } from "../core-host/answer-routes.js";
import type { LessonsHost } from "../lessons/host-glue.js";
import { wikiToolsGate } from "../lessons/local-tools.js";
import { DocumentLocalToolsSettings } from "../lessons/document-settings.js";
import { mayUseProject } from "../developer/task-project-access.js";
import { SYSTEM_OWNER_NOT_ALLOWED, isSystemPrincipal, systemStartVerdict, systemStepVerdict, type SetupRepairMark, type WikiRefreshMark } from "../core/system-runs/access.js";
import { readWikiBuildPointer } from "../core/wiki-build/run.js";
import { Membership, membershipKey, ownPartitionRow } from "./company-check.js";
import { grantKeyFor, namedCompany } from "./company-layout.js";
import { coreTaskEntryFrom, taskActionMethodsOf, type CoreEntryCaller, type CoreTaskEntry } from "./engine-boundary.js";
import { coreAppEntryFrom, type CoreAppEntry } from "./core-app-routes.js";
import { auditSinkForDeployedCaller, hostedSessionCapSeconds } from "./hosted-wiring.js"; import { attentionEmailFromEnvironment, attentionEmailModule } from "./attention-email.js"; import { LambdaClient } from "@aws-sdk/client-lambda";
import { hostedServiceCatalog, hostedWorkersRunTestServices } from "./hosted-test-services.js";
import { createTaskTestEnvironment } from "../core/test-env/seam.js";
import { savedEnvEnabled } from "../core/test-env/saved-env-switch.js";
import { fixtureObjectPortOf } from "../core/test-env/fixture-store-aws.js";
import { hostedSavedEnvDeps } from "./hosted-saved-env.js";
import { savedEnvRoleSessionsFromEnvironment, type SavedEnvRoleSessions } from "./saved-env-role-sessions.js";
import { companySecretsFromEnvironment } from "./company-secrets-sessions.js";
import { savedEnvImageModules } from "./ecr-image-registry.js";
import { baseFlakyTests } from "../core/test-env/base-flaky.js";
import { flakyFactsPort } from "../lessons/knowledge-facts.js";
import { isCoreJobEvent } from "../core-host/jobs.js";
import { attachCoreTeamRecord, hostedEraseLearning, type CoreTeamRecord } from "../core-host/team-record.js";
import { hostedEraseWiki } from "../core-host/wiki-routes.js";
import { proposeLessonFromNote, type WikiNoteLessonInput, type WikiNoteLessonResult } from "../core/wiki/note-lesson.js";
import type { HostedWikiMapWiring } from "../core-host/wiki-map-routes.js";
import { ciDefinitionReaderOf } from "../core/ci-evidence/eval-check-card.js";
import { createWikiBuildStarter } from "../core/wiki-build/starter.js";
import { hostedWikiResnapshot } from "./wiki-resnapshot.js";
import { projectCitationReader, wikiBuildCallbackWiring, wikiBuildEndedHook } from "../core/wiki-build/wiring.js";
import { createPersonEraseRoute, type PersonEraseCaller } from "../core-host/person-erase-route.js";
import { resumePersonErases, type PersonEraseDeps, type PersonEraseObjects } from "../core/people/erase.js";
import { createCallbackService, type CallbackServiceOptions } from "../services/index.js";
import { createTaskTokenDescriber } from "../core/model-gateway/describer.js";
import { evalHealthRunDeps, evalHealthRunsAvailable, kickEvalHealth } from "../core-host/eval-health-wiring.js";
import { MODEL_ACCESS_PATH } from "../core/model-gateway/route.js";
import { CallbackCapabilities } from "../callbacks.js";
import type { TokenSigner } from "../developer/tokens.js";
import { coreModelGatewayWiring, gatewayModelAccessFromEnvironment, gatewayModelKeysModules, taskTokensFromEnvironment } from "../core-host/gateway-model-access.js";
import { hostedAnswersModel } from "../core-host/gateway-answers.js";
import type { HostedLearningContext } from "../core-host/hosted-learning.js";
import { hostedStartRoute } from "../core/answers/model-start-router.js";
import { CORE_AGENT_MODEL_CHOICE_VARIABLE, adminOfferedModelsFromEnvironment, offeredModelsReaderFromEnvironment } from "../core-host/offered-models-http.js";
import { companyEngineModelRoute, companyEngineModelStartCheck, type EngineModelOfferedReader } from "../core-host/company-engine-model.js";
import { evalReservationModules } from "../core-host/eval-authority-http.js";
import { companyInstructionsModules } from "../core-host/company-instructions-http.js";
import { createCompanyModelChoices, type OfferedModelsReader } from "../core-host/gateway-model-selection.js";
import { RepositoryGrantService } from "../repository-access.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { isCoreWorkspace } from "./engine-boundary.js";
import { workspaceCompanyReader } from "./worker-machines/workspace-company.js";
import { digestPilotOf, switchCovers } from "../core-host/flags.js";

import { handleCoreContextTools } from "../core-host/context-tools.js";
import { createTaskLogHooks } from "../core/task-log/hooks.js";
import { hostedPlanSummaryOf } from "../core-host/plan-summary.js";
import { companyMilestones, withMilestoneSweep } from "./milestone-home.js";
import type { DocumentMilestones } from "../core/milestones/milestones.js";
import { createHostedIntake, hostedTicketUpdates, hostedTrackerFor, intakeFenceKeyOf, ticketSessionStartExtras, type HostedIntake } from "./hosted-intake.js";
import { linearCommentAuthorResolver } from "./linear-account-links.js";
import type { LinearConnections } from "./linear-connections.js";
import { createWikiOnEvents, readWikiTaskUse } from "../core/wiki/agent-context.js";

type DynamoSender = { send(command: unknown): Promise<unknown> };

// The policy hook's settings and the engine's hook live in engine-policy-hook.ts (the dispatcher reads them too, without this root); re-exported for the root's existing importers.
export { CORE_POLICY_HOOK_VARIABLE, enginePolicyHook, policyHookSettingsFromEnvironment } from "./engine-policy-hook.js";

/** What the root gives `codeModules`. */
export interface BrokerCoreModuleContext {
  /** The registry's store, once the registry is built (a call before then waits for it). */
  storage: () => Promise<DocumentStore>;
}

export interface BrokerCoreRootInputs {
  env: NodeJS.ProcessEnv;
  checkTaskPerson?: CheckTaskPerson;
  /**
   * Core task web routes (Cloud #188 item 3): for one signed-in person and their live company, exactly the dependencies the developer routes build for the old task routes (`developerTaskRouteDependencies`), so a core
   * task's People, readers, events and plan comments are answered with the old routes' own rules (aws/core-task-rule-routes.ts). Absent: those routes are not the core's here.
   */
  taskRules?: (person: { developerId: string; name: string }, companyId: OrgId) => DeveloperTaskRouteDependencies;
  /** The State table and the sign-in table, as the broker's document client reads them (membership, project grants, the person's name). */
  documentClient: DynamoSender;
  stateTableName: string;
  signInTableName: string | undefined;
  /** Existing trusted source capture for application planning at the prepared commit. */
  applicationSource?: (repositoryUrl: string, commit: string) => Promise<E2ESourceSnapshot>;
  callbackSigningKey: string;
  /** The key the broker's repository grant exchange verifies with (aws/broker.ts derives it from the callback signing key). */
  repositoryGrantKey: Buffer;
  /** Resolves a worker's repository credential (the GitHub App). */
  repositoryCredential: CoreRuntimeOptions["repositoryCredential"];
  /**
   * Code's AWS adapter inputs, asked for only when the registry is first built. `core.storage` is the built registry's store, for an input that reads the core's own records at call time
   * (the code host's company project catalog, lane L1b); it must not be awaited while the registry is being built.
   */
  codeModules: (core: BrokerCoreModuleContext) => CodeModuleDeps;
  /** More modules after Code's and the step 5 ones (model keys when lane L2b lands). */
  extraModules?: () => readonly CoreAdapterModule[];
  /** Test injection; hosted installs build the real session seam from their bindings. */
  savedEnvSessions?: SavedEnvRoleSessions;
  /** The policy hook's asker (`policyHookInstallFromEnvironment`). Absent: an install with hook settings refuses its registry. */
  policyHookInstall?: () => PolicyHookInstall | undefined;
  /** CORE-ROOT-HOOK-WIRING-TEST-20261117: how the root reaches the company rules service (its keys and its answers), for the engine's per-task limit and the hook in front of admission.
   * Absent: the global fetch (the deployed broker). */
  policyHookFetch?: typeof fetch;
  /**
   * The people lessons ask (per company; `createHostedLessonsPeople`). `context.store` is the company's own core store (the person erase receipts live there), asked for only when an erase is read.
   * Absent: lessons are not built even where ROVARA_CORE_LESSONS covers a company (reported once).
   */
  lessonsPeople?: (companyId: OrgId, context: { store: () => Promise<DocumentStore> }) => HostedLessonPeople;
  /** The pilot companies, whose projects have the weekly lessons summary ON until a project chooses otherwise. Absent: the companies ROVARA_CORE_LESSONS names (`on:<ids>`). One list for the sender and the API. */
  lessonsDigestPilot?: (companyId: OrgId) => boolean;
  /**
   * The learning model port for one company's lessons (`hostedLessonsLearning`: the gateway's learning route, on the company's own provider account and inside its learning cap). Asked only for a company
   * the lessons switch names. Absent, or undefined for a company (or a throw): learning calls refuse and nothing is spent.
   */
  lessonsLearning?: (companyId: OrgId, context?: HostedLearningContext) => CoreLessonsOptions["learning"];
  /**
   * The lessons' Slack source for one company (`hostedLessonsSlack`, aws/hosted-slack-thread.ts, L4-HW8): which company a Slack workspace is (the reader never takes "every tenant is yours" on an install of many
   * companies) and the one signed `thread_messages` command to the deployment's Slack adapter. Absent: no Slack source, as before.
   */
  lessonsSlack?: (companyId: OrgId) => { companyOf: NonNullable<CoreLessonsOptions["channelCompanyOf"]>; command: NonNullable<CoreLessonsOptions["slackThreadCommand"]> };
  /**
   * Optional explicit CI reader. Otherwise the root adapts policySource (D1 today when no source was supplied).
   * The runtime validates this reader and passes the same checked function to merge tracking.
   */
  ciReporting?: CiReporting;
  /** Lane L11: the company's code settings (how a project merges and approves), for how we work. Absent: how we work answers "not on the core yet" (never the laptop's fixed settings). */
  codeSettings?: CodeSettingsReader;
  /** D1 policy resolved per company/project. Absent: D1 today (their_ci_fix); never default on a failed read. */
  policySource?: PolicySource;
  /**
   * L4-HW3d: builds the deployed policy source over the root's own company rules service (the same one the per-task limit reader asks; `hostedPolicySource`, core-policy-source.ts), once
   * per root. Used only when no `policySource` was given. Absent as well: D1 today.
   */
  hostedPolicySource?: (hook: () => ProjectSettingsHook | undefined) => PolicySource;
  /** The job services the deployment builds for a company (merge tracking, the session sweep, notices, the admission hold sweep). */
  services?: (companyId: OrgId, flow: TaskFlow, registry: AdapterRegistry, wiring: CoreServiceWiring) => Partial<Record<CoreServiceName, CoreService>>;
  /**
   * Lane L2b (DEC 236): the task-token signer (the KMS task key, TASK_TOKEN_KEY_ARN) and the token issuer (the install's sign-in issuer, whose JWKS the gateway
   * pins). Asked for only where the model gateway is configured (ROVARA_CORE_MODEL_GATEWAY_URL): a worker's model-access request is then answered with a task token
   * for the gateway. Configured without these: the core callback layer refuses to build (never a worker that cannot reach its model, silently).
   */
  taskTokens?: () => { signer: TokenSigner; issuer: string } | undefined;
  /**
   * DEC 243c: what the model gateway offers one company's agents (the contract is `OfferedAgentModels`; the gateway serves it, docs/architecture/agent-model-choice.md). With it (or, from the environment, ROVARA_CORE_AGENT_MODEL_CHOICE=on and the model
   * gateway configured) each company chooses its agents' models on the web page from that list; without it every core step runs on ROVARA_CORE_AGENT_MODEL, exactly as before.
   */
  offeredModels?: OfferedModelsReader;
  /**
   * L4-SR1: the gateway's own answer about one company's projects' nightly upkeep caps (core/upkeep/cap.ts; the contract is `UpkeepCapReadSchema`, a service read on the gateway). Absent, it is built from the environment
   * where the gateway's origin and the task-token signer are configured, and where that gateway does not answer the read nothing that spends AI starts by itself. L4-SR2b: the automatic repair draft's room check is
   * read from this same reader (`upkeepRoomCentsOf`, core/upkeep/cap.ts), fresh each time: there is no second source of the project's remaining room.
   */
  upkeepCap?: (companyId: OrgId) => UpkeepCapReader | undefined;
  /**
   * L4-HW1: whether a workflow task starts on workflow 1.1.0 (Understand first, the plan check, the Rovara Code program), as on a laptop (local/app/app.ts). Default: true. Only a test or a
   * deliberate rollback gives false; a task keeps the version it started on either way (the version is stored with its workflow, and nothing reads this input after the start).
   */
  understandFirst?: boolean;
  /** The API's own address (a session's link). */
  origin: () => string;
  log: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  wrapStorage?: (store: DocumentStore) => DocumentStore;
  /**
   * L2-4: the Linear OAuth connections (aws/linear-wiring.ts), where Linear is wired. With them, where the core is wired: the tracker intake per company (`intake`), Linear account links
   * read under the company, and the ticket write-back through the company's own connection on its milestones. Absent: no intake (the Linear app webhook logs `linear.intake_not_wired`).
   */
  linearIntake?: { connections: Pick<LinearConnections, "connection" | "accessToken">; fetch?: typeof fetch };
  /**
   * L4-U5b: the company-scoped chat seam (core-host/chat-threads.ts). With it, a core task started from a chat thread has that thread recorded (`CoreTaskEntry.recordThread`), and its milestones (a pause at Build for a broken
   * setup, the pull request, the end) are told in that thread through the company's own adapter, riding on the company's milestones like the ticket write-back. Absent: no thread is recorded and none is told.
   */
  chatThreads?: ChatThreads;
}

export interface BrokerCoreRoot {
  readonly app: CoreHostApp;
  /** The developer task routes' core entry. Undefined only where the install has no core wired (a test or a self-hosted layout without it): the routes then never reach the core. */
  readonly coreTasks: CoreTaskEntry | undefined;
  /**
   * Lane L12: the core's own /v1/app/* routes for the broker's HTTP API (sessions, decision cards, how we work, script tokens and person erase), over the same caller mapping as
   * `coreTasks` (company and role from membership). Undefined only where the install has no core wired: the developer API then answers every /v1/app/* path "route not found" and reads nothing.
   */
  readonly coreApp: CoreAppEntry | undefined;
  /**
   * Lane LM8: the Code lessons API for the developer routes (`deps.lessons`). Undefined where no core is wired, while ROVARA_CORE_LESSONS is off, or without the deployment's
   * people port: every lessons route then answers "Lessons are off." and reads nothing.
   */
  readonly lessons: LessonsApi | undefined;
  /**
   * L4-AK1H: the team knowledge reads for tools outside Rovara (`deps.knowledge`, `core-host/knowledge-api.ts`), behind the same lessons switch and people port as `lessons`. Undefined in the same cases: a person is then
   * given the fixed "off" answer, a script token is refused, and nothing is read.
   */
  readonly knowledge: KnowledgeApi | undefined;
  /** L4-AK1H: whether a person may be told an admin notice now (they are one of the company's admins, read live). Handed to the notice delivery (`notification.adminNotice`). Undefined with `knowledge`. */
  readonly adminNotice: ((orgId: string, developerId: string) => Promise<boolean>) | undefined;
  /** L4-SRC-SL: the person's own "Don't learn from my Slack messages" switch (`core-host/lessons-slack-switch-api.ts`), whenever the core serves. */
  readonly lessonsSlackSwitch?: LessonsSlackSwitchApi | undefined;
  /** L4-JA7: the company's "Knowledge stays in Rovara" and a project's "local coding tools can fetch lessons" (`core-host/knowledge-switch-api.ts`), whenever the core serves; it does not depend on the lessons switch. */
  readonly knowledgeSwitch?: KnowledgeSwitchApi | undefined;
  readonly policyHook?: ProjectSettingsHook;
  /** L2-4: the tracker intake per company (aws/hosted-intake.ts). Undefined where no core is wired, its settings are unreadable, or Linear is not wired. */
  readonly intake: HostedIntake | undefined;
  /**
   * Guided onboarding PR 16: whether archiving a project of this company takes effect, i.e. the company's tasks run on the core engine (the only engine that reads the
   * archived state). Present wherever the core is wired (it holds for every company: D1); absent: the archive route refuses an archive.
   */
  readonly projectArchiveTakesEffect?: (companyId: string) => boolean;
  /**
   * Person erase (row 13.1, #687) on the deployed API: `POST /v1/app/people/<id>/erase`, with the learning step erasing the person's lessons AND Team record rows. Answers `undefined` where
   * no core is wired or for any other path. The broker's HTTP API reaches it through `coreApp` (lane L12).
   */
  personErase(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined>;
  /** Finishes one company's owed person erases (the learning step first, then the evidence walk). For the scheduled job when it lands. Rejects where no core is wired. */
  resumePersonErases(companyId: string, budgetMs: number): Promise<{ finished: number; owed: number }>;
  /** A schedule's core job event, or a State table stream batch. `undefined`: not the core's. */
  handleEvent(event: unknown, options?: { remainingMs?: number | undefined }): Promise<unknown>;
  /**
   * A worker's callback (`/v1/internal/workspaces/<id>/operations/<id>/<action>`) for a workspace a CORE task holds: served by that company's core callback layer (its capability, its
   * repository grant exchange, the lessons' load report), or a signed context/packet request verified before reads. `undefined`: not a core workspace, or no core is wired.
   */
  callback(request: BrokerRequest): Promise<BrokerResponse | undefined>;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A worker callback's path. The action is lower-case letters, digits and hyphens: `e2e-admission` and `e2e-evidence` have a digit, and a route that refused it sent those callbacks to the old routes. */
export const CORE_CALLBACK = /^\/v1\/internal\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/operations\/[0-9a-f-]{36}\/[a-z0-9-]+$/u;
const callbackAnswer = (statusCode: number, code: string, message: string): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code, message } }) });
const CORE_SETTINGS_REFUSAL_WORDS = "The core engine settings are not readable.";

// ---- the eval plan source of the deployed callback layer (EVAL-PLAN-CORE-WIRING, DEC 253c/253j(1))

/**
 * The trusted eval plan source a deployed company's callback layer answers the `eval-plan` callback from: the company's own stored EVAL_PLAN bound to an approved eval spend item, the
 * approval through the install's bound `eval-reservation` adapter only, and the company's base-score cache. The approver's CURRENT role is the hosted members reader
 * (`deployedSessionMembers`: live `COMPANY_MEMBER#` membership in THIS company, the broker's project grant), never the role stored at approval or a role the gateway names.
 */
export function coreEvalPlanSources(registry: Pick<AdapterRegistry, "names" | "get" | "require">, companyId: OrgId, people: DeployedPeople, log?: (entry: { event: string }) => void, environment?: EvalEnvironmentSource, env: Readonly<Record<string, string | undefined>> = {}): EvalPlanSources {
  // L4-EINT: the stand-in descriptor, only where the operator's switch AGENTX_EVAL_STAND_INS is "1" (default off: today's answer).
  const standIns = evalStandInsOn(env) ? createEvalStandInDescriptorSource({ store: registry.require("storage"), companyId, objects: fixtureObjectPortOf(registry.require("object-storage")) }, env) : undefined;
  return createEvalPlanSources({
    store: registry.require("storage"), companyId, registry, members: deployedSessionMembers(companyId, people), ...(environment === undefined ? {} : { environment }), ...(standIns === undefined ? {} : { standIns }),
    ...(log === undefined ? {} : { log: (event) => { log({ event: `core_engine.${event}` }); } }),
  });
}

// ---- membership and project grants (the broker's own records)

/** A person's live company membership with its role (R4's record, `COMPANY_MEMBER#<person>` in the sign-in table). Undefined: none, or revoked. A read that fails throws. */
export function membershipWithRoleFromDynamo(client: DynamoSender, tableName: string): (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined> {
  return async (personId) => {
    if (typeof personId !== "string" || personId.length === 0 || personId.length > 256 || /[#\s]/u.test(personId)) return undefined;
    // A read that throws is "the read failed" (a retryable 503, membership-read.ts), never "no membership".
    const response = await readingMembership(() => client.send(new GetCommand({ TableName: tableName, Key: membershipKey(personId), ConsistentRead: true }))) as { Item?: unknown };
    const parsed = Membership.safeParse(response?.Item);
    if (!parsed.success || parsed.data.personId !== personId || parsed.data.revokedAt !== undefined || !OrgRoleSchema.safeParse(parsed.data.role).success) return undefined;
    return { companyId: parsed.data.companyId, role: parsed.data.role };
  };
}

/**
 * The person's project grant role (the broker's own rows, FR-013.1): `developer` or `administrator`, else undefined. DEC 254zzz80: `companyId` is the company the grant is read
 * in (the caller's LIVE membership, or the runtime's company): a NAMED company's grant is `ORG#<company>#MEMBER#<person>` / `PROJECT#<name>` only (company-layout.ts), and a row
 * there that names another company is none; the built-in company and no company read the legacy `MEMBER#<person>` / `PROJECT#<name>` row exactly as before.
 */
export function projectGrantRoleFromDynamo(client: DynamoSender, tableName: string): (personId: string, project: string, companyId?: string) => Promise<"developer" | "administrator" | undefined> {
  return async (personId, project, companyId) => {
    if (typeof personId !== "string" || personId === "" || /[#\s]/u.test(personId) || typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(project)) return undefined;
    const key = grantKeyFor(companyId, personId, project);
    // A grant read that throws is "the read failed" (a retryable 503, membership-read.ts), never "no grant".
    const response = await readingMembership(() => client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || row["projectName"] !== project) return undefined;
    const company = namedCompany(companyId);
    if (company !== undefined && !ownPartitionRow(row, company)) return undefined;
    return mayUseProject(row["role"]) ? row["role"] : undefined;
  };
}

/**
 * DEC 254zzz80: a grant reader that reads each person's grant in the company of their LIVE membership (none: the legacy row, as before). A membership read that fails throws.
 * Review L3: a caller that has just checked the person's live membership passes that company (`checkedCompany`), so the grant is read in the company it checked and membership is
 * not read a second time (a person moved between two reads can never have another company's same-named grant counted).
 */
export function liveCompanyGrantRole(
  membershipOf: (personId: string) => Promise<{ companyId: OrgId } | undefined>,
  role: (personId: string, project: string, companyId?: string) => Promise<"developer" | "administrator" | undefined>,
): (personId: string, project: string, checkedCompany?: string) => Promise<"developer" | "administrator" | undefined> {
  return async (personId, project, checkedCompany) => role(personId, project, checkedCompany ?? (await membershipOf(personId))?.companyId);
}

/**
 * What the company's own records say about a person, for person erase (row 13.1): a current `member` of THIS company, a `former` one (removed), or `unknown` (never one of its people, or
 * another company's). No sign-in table, or a read that fails, throws (the route then refuses and erases nothing).
 */
export function personStandingFromDynamo(client: DynamoSender, tableName: string | undefined): (companyId: string, personId: string) => Promise<"member" | "former" | "unknown"> {
  return async (companyId, personId) => {
    if (tableName === undefined || tableName === "") throw new Error("no sign-in table");
    const response = await client.send(new GetCommand({ TableName: tableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
    const parsed = Membership.safeParse(response?.Item);
    if (!parsed.success || parsed.data.personId !== personId || parsed.data.companyId !== companyId) return "unknown";
    return parsed.data.revokedAt === undefined ? "member" : "former";
  };
}

/** Whether the person holds a project grant that lets them use the project (developer or administrator: the broker's own rule). */
export function projectGrantFromDynamo(client: DynamoSender, tableName: string): (personId: string, project: string) => Promise<boolean> {
  const role = projectGrantRoleFromDynamo(client, tableName);
  return async (personId, project) => (await role(personId, project)) !== undefined;
}

/**
 * Lead 4 L4-AK2g: the hosted answers' team knowledge briefing. A company's answer is briefed by THAT company's own lessons host, and only on the runtime that is that company's (the engine builds one runtime per
 * company); another company's id, or a company the lessons switch does not cover, has none and the answer is made as before. The seam is asked only after the answer service checked the person's role.
 */
export function answersBriefingOf(runtimeCompanyId: OrgId, hostOf: (companyId: OrgId) => Pick<LessonsHost, "answerBriefing"> | undefined): NonNullable<HostedAnswersWiring["briefing"]> {
  return (companyId) => { const host = companyId === runtimeCompanyId ? hostOf(companyId) : undefined; return host === undefined ? undefined : (input) => host.answerBriefing(input); };
}

/** The project role the lessons API reads, from the broker's grant: a project administrator is a `maintainer`, a developer a `contributor`; anything else none. */
export function projectRoleOf(grant: "developer" | "administrator" | undefined): ProjectRole | undefined {
  return grant === "administrator" ? "maintainer" : grant === "developer" ? "contributor" : undefined;
}

/** Audit gap 11b: the trackers a hosted company's tickets are written back to (Linear only, over the company's own OAuth connection; hosted-intake.ts). */
export const HOSTED_TICKET_TRACKERS: readonly string[] = ["linear"];
export const NOT_A_MEMBER_HERE = "You are not a member of this company.";
export const NO_PROJECT_GRANT = "You do not have access to this project.";

/**
 * Who may start work and act on a core task on a deployed install. Every answer re-reads the person's LIVE membership (never the principal's word): the person must be a member of the
 * principal's company now. A start needs the project grant the broker already keeps. Without PEOPLE, the task remains its own person's; PEOPLE owners need the existing fresh proof
 * and project grant, with a revision fence on acts. A company role grants no reach into another person's task. A step the system starts on its own needs its person to be a
 * member still, with the grant.
 */
/**
 * Guided onboarding L2-3: a person's standing on a project's setup run in this company, read live: PR 16's rule (`lifecycleAccess`) over the person's membership and project grant.
 * A person who is not a live member of THIS company is `none`, whatever grant they hold.
 */
export function setupRunStandingFrom(people: { membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>; projectGrantRole: (personId: string, project: string, checkedCompany?: string) => Promise<"developer" | "administrator" | undefined> }): (personId: string, companyId: OrgId, project: string) => Promise<SetupRunStanding> {
  return async (personId, companyId, project) => {
    const membership = await people.membershipOf(personId);
    if (membership === undefined || membership.companyId !== companyId) return { access: "none" };
    const access = lifecycleAccess(membership.role, await people.projectGrantRole(personId, project, membership.companyId));
    if (access !== "manage") return { access };
    return { access, basis: membership.role === "owner" ? "company-owner" : membership.role === "admin" ? "company-admin" : "project-admin" };
  };
}

/**
 * Lead 4 C1: a person's role on a project for the wiki's corrections, read live. Only a live member of THIS company has one: a company owner or admin is a `maintainer` of every project (as
 * `app-projects.ts` says); otherwise the project grant gives `maintainer` or `contributor`; no grant, no role. (A role the install knows only as `viewer` would read but not correct.)
 */
export function wikiProjectRoleFrom(people: { membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>; projectGrantRole: (personId: string, project: string, checkedCompany?: string) => Promise<"developer" | "administrator" | undefined> }): (personId: string, companyId: OrgId, project: string) => Promise<ProjectRole | undefined> {
  return async (personId, companyId, project) => {
    const membership = await people.membershipOf(personId);
    if (membership === undefined || membership.companyId !== companyId) return undefined;
    if (membership.role === "owner" || membership.role === "admin") return "maintainer";
    return projectRoleOf(await people.projectGrantRole(personId, project, membership.companyId));
  };
}

// L4-P1/L4-P2: the gate every hosted runtime carries (core-host/system-runs.ts). Re-exported: tests/unit/system-runs-hosted-gate.test.ts holds the function and the call on the broker AND on the dispatcher.
export { hostedSystemRunsFor };

/** Both read and action callers must see a People proof denial as a missing task. */
async function taskAccessOrHidden<T>(resolve: () => Promise<T>): Promise<T | undefined> {
  try { return await resolve(); } catch (error) {
    if (error instanceof AgentXError && error.code === "TASK_ACCESS_DENIED") return undefined;
    throw error;
  }
}

export function hostedTaskAccess(inputs: {
  membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>;
  /** The person's grant; `checkedCompany` is the company whose live membership the caller just checked (review L3: the grant is read there, membership is not read again). */
  projectGrant: (personId: string, project: string, checkedCompany?: string) => Promise<boolean>; companyId: OrgId; storage?: () => Promise<DocumentStore>; people?: TaskPeopleDependencies;
  /** Guided onboarding L2-3: the setup run's own rule. With it (and `storage`), a step of a setup-run task is allowed only while the person it runs for still manages the project's setup (DEC 254n 3); any other task's step keeps the project-grant rule. */
  setupRunStanding?: (personId: string, companyId: OrgId, project: string) => Promise<SetupRunStanding>;
  /** L4-P1 (owner DEC 254zzl): whether this company's SystemRuns flag is on, read now. With it, a project's SYSTEM OWNER is accepted for the closed list of system purposes (core/system-runs/access.ts) and for nothing else; members' rules are unchanged. Absent: never. */
  systemRunsOn?: () => boolean | Promise<boolean>;
  /** L4-SR2: whether a project's own upkeep switch is on, read now (a repair draft is accepted only while it is). Absent: off. */
  upkeepOn?: (project: string) => boolean | Promise<boolean>;
}): TaskAccess {
  // The gate may read the company's consent (async): it is settled once per decision, and anything but an explicit true is off (a gate that throws is off).
  const settledOn = async (gate: (() => boolean | Promise<boolean>) | undefined): Promise<(() => boolean) | undefined> => {
    if (gate === undefined) return undefined;
    let on = false;
    try { on = (await gate()) === true; } catch { on = false; }
    return () => on;
  };
  // The project's upkeep switch, settled once per decision; anything but an explicit true (a throw included) is off.
  const settledUpkeep = async (project: string): Promise<(() => boolean) | undefined> => {
    if (inputs.upkeepOn === undefined) return undefined;
    let on = false;
    try { on = (await inputs.upkeepOn(project)) === true; } catch { on = false; }
    return () => on;
  };
  const liveMember = async (personId: string) => {
    const membership = await inputs.membershipOf(personId);
    return membership !== undefined && membership.companyId === inputs.companyId ? membership : undefined;
  };
  // The task's own stored person (a task with no People list) passes only while they STILL hold the project grant, read now: the very test a People entry meets below. A person removed from the project keeps
  // their old task as nothing: no read, no act (a project owner or admin takes it over through People, never through this path).
  const storedPerson = async (principal: Principal, task: { developerId: string; project: string }) => principal.personId === task.developerId && await inputs.projectGrant(principal.personId, task.project, inputs.companyId) ? { revision: undefined, ownerIds: [] as readonly string[] } : undefined;
  const resolveStoredTaskAccess = async (
    principal: Principal,
    task: { developerId: string; project: string; taskId: string },
    roles: readonly string[],
    storage: () => Promise<DocumentStore>,
  ) => {
    const store = await storage();
    const stored = await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    if (stored?.["companyId"] !== inputs.companyId || stored["developerId"] !== task.developerId || stored["project"] !== task.project) return undefined;
    // Reuse the broker's existing co-owner proof, including fresh identity/channel eligibility and PEOPLE reconciliation. Missing proof refuses; never trust a role alone.
    const people = inputs.people === undefined ? undefined : await resolveTaskPeopleAccess(inputs.people, stored as unknown as DeveloperTaskRecord, principal.personId);
    if (people === undefined) {
      if (await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }) !== undefined) return undefined;
      return storedPerson(principal, task);
    }
    if (people.orphaned || !roles.includes(people.role) || !await inputs.projectGrant(principal.personId, task.project, inputs.companyId)) return undefined;
    return { revision: people.peopleRevision, ownerIds: people.ownerActorIds };
  };
  /** The caller's live access to the task, for the roles asked (owners only for every act; owners, commenters and viewers for a read). Undefined: none. Every check re-reads the live proof. */
  const resolve = (principal: Principal, task: { developerId: string; project: string; taskId?: string }, roles: readonly string[]) => taskAccessOrHidden(async () => {
    if (principal.companyId !== inputs.companyId || await liveMember(principal.personId) === undefined) return undefined;
    if (task.taskId === undefined || inputs.storage === undefined) return storedPerson(principal, task);
    return resolveStoredTaskAccess(principal, { ...task, taskId: task.taskId }, roles, inputs.storage);
  });
  const owner = (principal: Principal, task: { developerId: string; project: string; taskId?: string }) => resolve(principal, task, ["owner"]);
  const readWikiRefreshMark = async (store: DocumentStore, project: string): Promise<WikiRefreshMark | undefined> => {
    const pointer = await readWikiBuildPointer(store, inputs.companyId, project).catch(() => undefined);
    return pointer === undefined ? undefined : { taskId: pointer.taskId, unattended: pointer.unattended === true, requestedBy: pointer.requestedBy };
  };
  const readSetupRepairMark = async (store: DocumentStore, project: string): Promise<SetupRepairMark | undefined> => {
    const pointer = await store.get(setupAgentKey(inputs.companyId, project)).catch(() => undefined);
    const valid = pointer?.["entityType"] === "SETUP_AGENT" && pointer["orgId"] === inputs.companyId && pointer["project"] === project
      && typeof pointer["taskId"] === "string" && typeof pointer["requestedBy"] === "string";
    return valid ? { taskId: pointer["taskId"] as string, requestedBy: pointer["requestedBy"] as string } : undefined;
  };
  const checkSystemOwnerStep = async (task: { taskId: string; developerId: string; project: string }): Promise<{ allowed: true } | { allowed: false; message: string }> => {
    const store = inputs.storage === undefined ? undefined : await inputs.storage();
    const stored = store === undefined ? undefined : await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    // A wiki refresh's mark: the project's build pointer, read only for a wiki purpose (never for the free kinds), and only this company's (`readWikiBuildPointer` checks company and project).
    const wikiRefreshMark = store !== undefined && stored?.["purpose"] === "wiki_build" ? await readWikiRefreshMark(store, task.project) : undefined;
    // A repair draft's mark: the project's setup pointer (read only for a setup purpose; `readSetupAgentPointer` checks company and project), and the project's upkeep switch, read now.
    const setupRepairMark = store !== undefined && stored?.["purpose"] === "setup_agent" ? await readSetupRepairMark(store, task.project) : undefined;
    const upkeepOn = stored?.["purpose"] === "setup_agent" ? await settledUpkeep(task.project) : undefined;
    return systemStepVerdict({ companyId: inputs.companyId, systemRunsOn: await settledOn(inputs.systemRunsOn), wikiRefreshMark, setupRepairMark, upkeepOn }, task, stored).allowed ? { allowed: true } : { allowed: false, message: SYSTEM_OWNER_NOT_ALLOWED };
  };
  const checkManagedPurposeStep = async (task: { taskId: string; developerId: string; project: string }): Promise<{ allowed: true } | { allowed: false; message: string } | undefined> => {
    if (inputs.setupRunStanding === undefined || inputs.storage === undefined) return undefined;
    const stored = await (await inputs.storage()).get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    if (stored?.["purpose"] !== "setup_agent" && stored?.["purpose"] !== "wiki_build") return undefined;
    if (stored["companyId"] !== inputs.companyId) return { allowed: false, message: NOT_A_MEMBER_HERE };
    // A wiki build (W3b) runs on the same rule: the person it runs for must still manage the project (company owner or admin, or the project's administrator), read now.
    const denied = stored["purpose"] === "wiki_build" ? WIKI_BUILD_WORDS.notAllowed : SETUP_RUN_NOT_ALLOWED;
    return (await inputs.setupRunStanding(task.developerId, inputs.companyId, task.project)).access === "manage" ? { allowed: true } : { allowed: false, message: denied };
  };
  return {
    // The hotfix's re-check (the stored person holds a task only while the grant is held, as a People entry does) makes `resolve` prove it for every admission: canAct, canRead and ownerActing.
    provesProjectGrant: true,
    async checkStart(principal, project, purpose, origin) {
      // A system owner (by its id shape or its provider) is decided by the system rule alone: it is never a member and never falls through to the member rules.
      if (isSystemPrincipal(principal)) return systemStartVerdict({ companyId: inputs.companyId, systemRunsOn: await settledOn(inputs.systemRunsOn), upkeepOn: purpose === "setup_agent" ? await settledUpkeep(project) : undefined }, principal, project, purpose, origin).allowed ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: SYSTEM_OWNER_NOT_ALLOWED };
      if (principal.companyId !== inputs.companyId || (await liveMember(principal.personId)) === undefined) return { allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE };
      return (await inputs.projectGrant(principal.personId, project, inputs.companyId)) ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT };
    },
    async canAct(principal, task) {
      return await owner(principal, task) !== undefined;
    },
    async canRead(principal, task) {
      return await resolve(principal, task, ["owner", "commenter", "viewer"]) !== undefined;
    },
    async ownerActing(principal, task) {
      const allowed = await owner(principal, task);
      if (allowed === undefined) return undefined;
      const actorId = taskOwnerKey(principal.personId, task.taskId);
      return {
        actorId: allowed.revision === undefined ? task.ownerKey : actorId,
        ...(allowed.revision === undefined ? {} : { authority: { actorId, ownerIds: allowed.ownerIds } }),
        items: [{ kind: "check", key: { pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }, condition: allowed.revision === undefined ? when.absent() : when.eq("revision", allowed.revision) }],
      };
    },
    async checkStep(task, by) {
      // A task whose developer is a system owner takes the system rule (the task's own stored row, read now), never the member rules.
      if (isSystemOwnerId(task.developerId)) return checkSystemOwnerStep(task);
      // A task with a People list runs for its CURRENT owner, never for its starter (hosted-step-owner.ts): the starter's own standing is not asked at all. A setup run or wiki build keeps the starter's own rule below.
      const store = inputs.storage === undefined ? undefined : await inputs.storage();
      const stored = store === undefined ? undefined : await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
      const listed = await listedStepVerdict({ store, companyId: inputs.companyId, people: inputs.people, liveMember, projectGrant: inputs.projectGrant }, task, stored, by);
      if (listed !== undefined) return listed;
      if ((await liveMember(task.developerId)) === undefined) return { allowed: false, message: NOT_A_MEMBER_HERE };
      // A setup run (the stored task says so) runs on the setup run's rule: an owner or admin of the company, or the project's administrator, read now. Any other task: the grant.
      const managed = await checkManagedPurposeStep(task);
      if (managed !== undefined) return managed;
      return (await inputs.projectGrant(task.developerId, task.project, inputs.companyId)) ? { allowed: true } : { allowed: false, message: NO_PROJECT_GRANT };
    },
  };
}

/**
 * Who may decide a core task's document as its owner, for the approvers point's own re-check (web task channel C6, D5): the same live rule as the owner moves (`hostedTaskAccess.canAct`: live membership, the
 * task's own person or a People owner under the live proof, the project grant), over the company's own store. A read that fails throws (the point refuses).
 */
export function hostedTaskOwner(inputs: { membershipOf: Parameters<typeof hostedTaskAccess>[0]["membershipOf"]; projectGrant: Parameters<typeof hostedTaskAccess>[0]["projectGrant"]; people: TaskPeopleDependencies }): NonNullable<Parameters<typeof hostedSecurityModules>[0]["taskOwner"]> {
  return ({ companyId, store, principal, task }) => hostedTaskAccess({ membershipOf: inputs.membershipOf, projectGrant: inputs.projectGrant, companyId, storage: async () => store, people: inputs.people }).canAct(principal, task);
}

/**
 * The deployment's caller mapping (lane ID): the broker's signed-in developer -> the principal the core knows. The company and role come from the person's LIVE membership, read on every
 * call (never a token claim); the sign-in method and the client ride along only as the broker's sign-in set them from the verified token. No membership: undefined (the sign-in refusal).
 */
export function deployedCallerFromMembership(membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>): (caller: CoreEntryCaller) => Promise<DeployedCaller | undefined> {
  return async (caller) => {
    const membership = await membershipOf(caller.developerId);
    if (membership === undefined) return undefined;
    const principal: Principal = { companyId: membership.companyId, personId: caller.developerId, displayName: caller.name, roles: [membership.role], provider: HOSTED_IDENTITY_PROVIDER };
    return { principal, ...(caller.clientId === undefined ? {} : { client: caller.clientId }), ...(caller.amr === undefined ? {} : { amr: caller.amr }), ...(caller.webApp === true ? { webApp: true as const } : {}), ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }) };
  };
}

// ---- the stream hook (shared with the notifier's existing reader)
export { outboxCompaniesOf };

// ---- money (lane L8)

/**
 * One company's money wiring over the sealed registry: the callback layer's usage booking (the usage the company's workers report is booked into the task's cost ledger before the batch
 * is acknowledged, core-host/usage-booking.ts) and the admission's own hold sweep. The company is the runtime's own, never the operation's word (the callback layer has checked they agree).
 */
export function coreMoneyWiring(registry: Pick<AdapterRegistry, "require">, companyId: OrgId, now: () => Date, settings?: HostedAdmissionSettings, projectTaskCap?: ProjectTaskCap): { bookUsage: NonNullable<CallbackServiceOptions["bookUsage"]>; holdSweep: CoreService } {
  const store = registry.require("storage");
  const metering = registry.require("metering");
  const booking = createUsageBooking({ store, metering, now });
  const ledger = createHostedLedger({ store, metering, now });
  return {
    // The per-run stop (core-money-stop): after a batch's usage is booked, the run's task and the company's day are read against the caps; a run past one is answered with the stop's code,
    // and the callback layer asks its worker to stop (core/task-flow/money-stop.ts `requestSpendStop`). Without the caps (`settings`) nothing is read.
    bookUsage: async (operation, events) => {
      if (operation.companyId !== companyId) throw new Error("operation belongs to another company");
      // Worker usage is aggregate telemetry only; it cannot authenticate receipts or revise gateway charges.
      const booked = await booking.bookOperationEvents({ id: operation.id, workspaceId: operation.workspaceId, companyId }, events);
      if (settings === undefined || !events.some((event) => event.type === USAGE_EVENT_TYPE)) return booked;
      const taskId = (await store.get((await workspaceKeys({ store, companyId: operation.companyId }, operation.workspaceId)).taskPointerKey()))?.["taskId"];
      const state = typeof taskId === "string" && taskId !== "" ? await runSpendState({ store, ledger, settings, now, projectTaskCap }, companyId, taskId) : "spend_unknown";
      return state === "within" ? booked : { ...booked, spendStop: state };
    },
    holdSweep: createHostedHoldSweep({ store, companyId, now }),
  };
}

/**
 * The owner's round's money check (TaskActionsOptions.roundCap) on a deployed install: the task's cap and what it has spent. L2-5 (b): the cap is the one that applies (the project's own
 * per-task limit when lower). No caps, a task of another company, or a limit that cannot be read: throws (the round is refused, never let through).
 */
export async function hostedRoundCap(registry: Pick<AdapterRegistry, "require">, companyId: OrgId, now: () => Date, settings: HostedAdmissionSettings | undefined, projectTaskCap: ProjectTaskCap | undefined,
  task: { companyId: string; taskId: string; project: string }, readSpend?: (taskId: string) => Promise<number | undefined>): Promise<{ limitUsd: number; spentUsd: number | undefined }> {
  if (settings === undefined || task.companyId !== companyId) throw new Error("the task cap is unavailable");
  const store = registry.require("storage");
  const ledger = createHostedLedger({ store, metering: registry.require("metering"), now });
  const cap = await taskCapOf({ store, settings, projectTaskCap }, companyId, task.taskId, task.project);
  // LOST-RUN-ACTUAL-SPEND: with the flow's own spend reader, a round reads the SAME figure the plan Approve does (settled runs, runs still owed their figure refused); without one, the ledger total as before.
  return { limitUsd: cap.micros / 1_000_000, spentUsd: readSpend !== undefined ? await readSpend(task.taskId) : costUsdOf(await ledger.taskCost(companyId, task.taskId)) };
}

/** The most admins one notice names (a company with more is told through its first ones, by the port's sorted list). */
export const ADMIN_NOTICE_PEOPLE_MAX = 20;

/**
 * Who is told an admin notice (L4-MCPA): the company's owners AND admins, read live. The people port is asked company-wide (no project), whose `eligibleIds` are the live owners and admins and never a project's
 * maintainers (`ownerIds` alone would leave out every non-owner admin). They are given as the ids notices are addressed by (`developerIdOf`); a person the identity no longer names is left out. A list the port could
 * not complete tells nobody. Queueing and delivery both ask this one function, so a person removed or demoted since a notice was queued is not told.
 */
export async function adminNoticeIdsOf(
  people: Pick<HostedLessonPeople, "approvers">, identity: { getPrincipal(companyId: string, personId: string): Promise<Pick<Principal, "provider" | "personId"> | undefined> }, companyId: OrgId,
): Promise<string[]> {
  const listed = await people.approvers(companyId, undefined);
  if (!listed.complete) return [];
  const ids: string[] = [];
  for (const personId of listed.eligibleIds.slice(0, ADMIN_NOTICE_PEOPLE_MAX)) {
    const principal = await identity.getPrincipal(companyId, personId);
    if (principal !== undefined) ids.push(developerIdOf(principal));
  }
  return ids;
}

/**
 * The deployed identity's display name for a person: read live from their sign-in record, never for a revoked or unknown person. The name goes through the one display helper
 * (`profileDisplayName`, DEC 254p (a)): a GitHub person's is clean, cut text with no markup, address or placeholder shape; any other person's is exactly as stored.
 */
export function hostedDisplayNameOf(documentClient: DynamoSender, signInTableName: string | undefined): (personId: string) => Promise<string | undefined> {
  return async (personId) => {
    if (signInTableName === undefined || signInTableName === "" || /[#\s]/u.test(personId) || personId === "") return undefined;
    const response = await documentClient.send(new GetCommand({ TableName: signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    return row === undefined || row["revoked"] === true ? undefined : profileDisplayName(row);
  };
}

// ---- the root

function readCoreRootSettings(env: NodeJS.ProcessEnv, log: BrokerCoreRootInputs["log"]): { settingsBlocked: boolean; hookSettings: HostedPolicyHookSettings | undefined; hookProblem: boolean } {
  let settingsBlocked = false;
  let hookSettings: HostedPolicyHookSettings | undefined;
  let hookProblem = false;
  try {
    const admission = readHostedAdmissionSettings(env);
    if ("problem" in admission || readCoreLessonsSwitch(env).problem !== undefined) settingsBlocked = true;
    try { hookSettings = policyHookSettingsFromEnvironment(env); } catch { hookProblem = true; throw new Error("the policy hook settings are not readable"); }
  } catch {
    settingsBlocked = true;
  }
  if (settingsBlocked) log({ event: "core_engine.settings_blocked" });
  return { settingsBlocked, hookSettings, hookProblem };
}

function buildBlockedCoreTasksEntry(membershipOf: (personId: string) => Promise<CompanyMembership | undefined>): CoreTaskEntry {
  return {
    route: async (_request, caller) => {
      let membership: CompanyMembership | undefined;
      try {
        membership = await membershipOf(caller.developerId);
      } catch {
        return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      }
      if (membership === undefined) return undefined;
      return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
    },
  };
}

function buildPolicyHookAccessor(
  hookSettings: HostedPolicyHookSettings | undefined,
  hookProblem: boolean,
  policyHookInstall: BrokerCoreRootInputs["policyHookInstall"],
): Pick<BrokerCoreRoot, "policyHook"> {
  if (hookSettings === undefined && !hookProblem) return {};
  return {
    policyHook: {
      get settings() {
        if (hookSettings === undefined) throw new Error("the policy hook settings are not readable");
        return hookSettings;
      },
      get install() {
        const install = policyHookInstall?.();
        if (install === undefined) throw new Error("the policy hook install is unavailable");
        return install;
      },
    },
  };
}

export function createBrokerCoreRoot(inputs: BrokerCoreRootInputs): BrokerCoreRoot {
  const { env, log } = inputs;
  const { settingsBlocked, hookSettings, hookProblem } = readCoreRootSettings(env, log);
  const now = inputs.now ?? (() => new Date());
  /** HW5: the web app's own origin for an address in a chat message (a plain https origin, else none: the message then carries no link). A throwing origin reads as none. */
  const originOf = (): string | undefined => { try { return inputs.origin(); } catch { return undefined; } };
  const membershipOf = inputs.signInTableName === undefined || inputs.signInTableName === ""
    ? async () => undefined
    : membershipWithRoleFromDynamo(inputs.documentClient, inputs.signInTableName);
  const projectGrantRole = liveCompanyGrantRole(membershipOf, projectGrantRoleFromDynamo(inputs.documentClient, inputs.stateTableName));
  // L2-5 (b): each task's cap is lowered to its project's own per-task limit (model_budget_usd) when one is set.
  // The company's rules service, when the install has one, as the settings page reads it (read each time: unreadable settings or no install signer refuse).
  const engineHook = () => enginePolicyHook(hookSettings, hookProblem, inputs.policyHookInstall, inputs.policyHookFetch);
  const projectTaskCap: ProjectTaskCap = projectTaskCapReader({ documentClient: inputs.documentClient, tableName: inputs.stateTableName, now: () => now().getTime() }, engineHook);
  // L4-HW3d: one cached, company-scoped source for every company's CI mode (its cache is per company and project).
  const policySource = inputs.policySource ?? inputs.hostedPolicySource?.(engineHook);
  const projectGrant = async (personId: string, project: string, checkedCompany?: string): Promise<boolean> => mayUseProject(await projectGrantRole(personId, project, checkedCompany));
  // Guided onboarding L2-3: who may manage a project's setup run (PR 16's rule over live membership and the grant), for the routes and every step of a run.
  const setupRunStanding = setupRunStandingFrom({ membershipOf, projectGrantRole });
  const wikiProjectRole = wikiProjectRoleFrom({ membershipOf, projectGrantRole });
  const displayNameOf = hostedDisplayNameOf(inputs.documentClient, inputs.signInTableName);
  const identity: HostedIdentityOptions = { membershipOf, displayNameOf };
  // HW5b: where the deployment serves ONE chat that can name a person (`ChatThreads.personOf`), a press in it may approve a low or medium risk plan (`hosted-approvers.ts` `chat`).
  /** S1: what this install can serve of the task action registry on a thread card: the plan decision (the approval gate), the merge (always wired) and the People moves (where the task rules are). */
  const taskActionCapabilities = { plan: true, merge: true, people: inputs.taskRules !== undefined } as const;
  const resolveApprovalProofKey = () => (inputs.callbackSigningKey === undefined ? undefined : approvalProofKeyOf(inputs.callbackSigningKey));
  const chatApproval = hostedChatApproval(inputs.chatThreads, { membershipOf, projectGrantRole }, resolveApprovalProofKey());
  // Web task channel C8 (option b): the attention email, OFF unless ROVARA_ATTENTION_EMAIL is `on` (attention-email.ts). One attempt per invoke: a send whose answer was lost is never sent again.
  const attention = attentionEmailFromEnvironment({ env, lambda: () => new LambdaClient({ maxAttempts: 1 }), documentClient: inputs.documentClient, signInTableName: inputs.signInTableName, callbackSigningKey: inputs.callbackSigningKey, now: () => now().getTime(), membershipOf, log });
  // L2b: read when first needed (a serving switch only); a broken setting throws in fixed words and refuses the runtime.
  const modelGateway = () => coreModelGatewayWiring(env, inputs.taskTokens);
  // L4-AG: the hosted answers model for each company (one gateway adapter for the deployment, made when first needed, never for an install without the gateway).
  // Only a built model is kept: a first attempt that found no signer yet is tried again on the next runtime build.
  let answersModelFor: ReturnType<typeof hostedAnswersModel>;
  const answersModel = () => (answersModelFor ??= hostedAnswersModel(env, inputs.taskTokens));
  // DEC 243c: with the gateway's offered-models reader, the company's per-step model rule chooses each step's model from that list (one rule per company, kept for its page's routes).
  // One reader for every company: the deployment's own (the gateway's route, signed with the task key) unless the root was given one.
  const previewRates = previewRateReaderFromEnvironment(env, inputs.taskTokens);
  // Task cost truth: ONE quote reader (its cache is shared) for the model-access answer (the worker prices from it) and the usage booking (its floor is priced from it).
  const quoteReader = gatewayRateQuoteReaderFromEnvironment(env, inputs.taskTokens);
  // LOST-RUN-ACTUAL-SPEND: the gateway's own record of a run's calls, the actual figure of a run whose usage never arrived (none where the gateway or the task key is not set up: the settler then counts without it).
  const runCharges = gatewayRunChargesReaderFromEnvironment(env, inputs.taskTokens);
  const resolveModelChoiceReader = () => (env[CORE_AGENT_MODEL_CHOICE_VARIABLE] === "on" ? inputs.offeredModels ?? offeredModelsReaderFromEnvironment(env, inputs.taskTokens) : undefined);
  const modelChoices = createCompanyModelChoices({ reader: resolveModelChoiceReader(), now: () => now().getTime() });
  // DEC 254n (1): the company's own engine model (when it set one) replaces the install's for its tasks; its start is refused unless the gateway offers it THAT company now. The list is read
  // through the same reader as the model choice where the root was given one, else the gateway's own route signed with the task key (only the gateway's origin is needed).
  const resolveEngineOffered = (): EngineModelOfferedReader | undefined => (inputs.offeredModels !== undefined ? (companyId) => inputs.offeredModels!.offered(companyId) : adminOfferedModelsFromEnvironment(env, inputs.taskTokens ?? (() => undefined)));
  const engineOffered: EngineModelOfferedReader | undefined = resolveEngineOffered();
  const modelFlowOptions = (registry: AdapterRegistry, companyId: OrgId): Partial<RegistryTaskFlowOptions> => {
    const gateway = modelGateway()!.flowOptions;
    const gatewayUrl = gatewayModelAccessFromEnvironment(env)!.gatewayUrl;
    const store = registry.require("storage");
    const modelAccess = companyEngineModelRoute({ store, companyId, offered: engineOffered, install: gateway.modelAccess });
    const modelCheck = companyEngineModelStartCheck({ store, companyId, offered: engineOffered });
    // A task's end reaches the gateway, which then refuses (and cuts) the task's calls: sent at once and sent again by the notify-deliver pass (`withTaskEndReconcile`) when it did not get through.
    const taskEnded = taskEndedSender({ gatewayUrl, tokens: () => inputs.taskTokens?.(), now: () => now().getTime(), log: (entry) => log({ ...entry, companyId }) });
    return { ...modelChoices.flowOptionsFor(registry, companyId, { ...gateway, modelAccess }), taskEnded, startModelCheck: async () => {
      // Read THIS company's effective model and signed price on every start. A
      // readiness fault throws before the start can mark in-use or audit a refusal.
      try {
        const route = await modelAccess.route();
        const tokens = inputs.taskTokens?.();
        const price = route === undefined || tokens === undefined ? undefined : await runPriceReader({ gatewayUrl, ...tokens, now: () => now().getTime() })(companyId, route.alias);
        if (price === undefined) throw new Error("unavailable");
      } catch {
        throw agentXError("RUNTIME_UNAVAILABLE", "The signed-price model gateway is not ready. Restore the gateway's signed run prices for this company's engine model, then retry.");
      }
      return modelCheck();
    } };
  };
  // PRIVATE-PACKAGES P1b: the company secret store (one session per company, company-tagged), or none where the install has no company-secrets role.
  const companySecrets = companySecretsFromEnvironment(env);
  const lessonsSwitch: ReturnType<typeof readCoreLessonsSwitch> = readCoreLessonsSwitch(env);
  // The weekly lessons summary's pilot list, resolved ONCE so the sender (createCoreLessons) and the settings API (createLessonsApi) can never disagree about which companies default to on.
  const lessonsDigestPilot = digestPilotOf({ lessonsSwitch: lessonsSwitch.value, ...(inputs.lessonsDigestPilot === undefined ? {} : { digestPilot: inputs.lessonsDigestPilot }) });
  // The caps the per-run stop reads (the admission module refuses to build without them, so the registry is refused then too).
  const readSettings = readHostedAdmissionSettings(env);
  const admissionSettings = "settings" in readSettings ? readSettings.settings : undefined;
  // L4-P1 (owner DEC 254zzl): the per-company flag of system-started runs, default off. A value that cannot be read is off (reported once).
  const systemRunsFlag: ReturnType<typeof readSystemRunsSwitch> = readSystemRunsSwitch(env);
  // L4-P2: what one company's system runs need beyond the flag: the effective gate (ceiling AND consent), the admins' recipients and live "administers" read, and the pause hooks (the notice of a paused night).
  // Stateless, so the services builder and the worker callback each build their own over the same stores.
  const upkeepPartsFor = (registry: AdapterRegistry, companyId: OrgId) => {
    const store = registry.require("storage");
    const gate = effectiveSystemRunsGateOf(systemRunsFlag.value, companyId, store);
    const memberStore = inputs.signInTableName === undefined || inputs.signInTableName === "" ? undefined : new CompanySignInStore({ documentClient: inputs.documentClient, tableName: inputs.signInTableName, now: () => now().getTime() });
    const sources = {
      membershipOf, projectGrantRole,
      // Owners and admins of THIS company: the install's member list, bounded (20 pages of 100); a list that cannot be read throws.
      companyAdmins: async (company: OrgId): Promise<string[]> => {
        if (memberStore === undefined) throw new Error("no sign-in table");
        const found: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const answer = await memberStore.listMembers(company, cursor, 100);
          for (const member of answer.members) if (member.revokedAt === undefined && (member.role === "owner" || member.role === "admin")) found.push(member.personId);
          if (!answer.more) return found;
          cursor = answer.cursor;
        }
        return found;
      },
      projectAdmins: async (project: string): Promise<string[]> =>
        (await listProjectMembers({ documentClient: inputs.documentClient, tableName: inputs.stateTableName, limitDefaults: { member: 1, organization: 1 }, now: () => now().getTime() }, project, companyId)).filter((member) => member.role === "administrator").map((member) => member.developerId),
    };
    const recipients = createUpkeepRecipients(companyId, sources);
    const administers = createUpkeepAdministers(companyId, sources);
    const pauses = upkeepPauseHooks({ store, companyId, now: () => now().getTime(), recipients, realtime: registry.get("realtime", registry.names("realtime")[0] ?? ""), log: (entry) => log({ event: "core_engine.upkeep", ...entry }) });
    // L4-U5: the admins' one "Setup needs repair" notice (queued once per re-check), over the same recipients and attention queue as the pause notice.
    const setupBroken = (input: { project: string; recheckKey: string }): Promise<unknown> => queueSetupBroken({ store, now: () => now(), recipients, realtime: registry.get("realtime", registry.names("realtime")[0] ?? ""), log: (entry) => log({ event: "core_engine.setup_broken", ...entry }) }, { orgId: companyId, project: input.project, recheckKey: input.recheckKey });
    return { gate, administers, pauses, setupBroken };
  };
  // L4-SR1: the gateway's cap read for one company (an injected reader wins; else the environment's, only where the gateway's origin and the task-token signer exist). One reader per company: it never reads another's.
  const upkeepCapFor = (companyId: OrgId): UpkeepCapReader | undefined => inputs.upkeepCap !== undefined ? inputs.upkeepCap(companyId) : upkeepCapReaderFromEnvironment(env, inputs.taskTokens, companyId);
  const lessonsByCompany = new Map<string, CoreLessons>();
  // R1 + L1 6.2: each company's milestones host, built outside lessons (`aws/milestone-home.ts`).
  const milestonesByCompany = new Map<string, DocumentMilestones>();
  // L4-EVW4 (DEC 254zzz43, folded in from #1025): the project's repositories as the eval wrapper card reads and (on a person's click) writes them. One per company, over that company's own flow, registry view and scope:
  // the pinned address, the host that serves it and `{ orgId: company }`. The setup run's callback gets NO wrapper wiring: nothing but a person's POST opens a pull request.
  const wrapperTargetsByCompany = new Map<string, ReturnType<typeof createEvalWrapperTargets>>();
  const wrapperTargetsOf = (companyId: OrgId, flow: Parameters<typeof createEvalWrapperTargets>[0]["flow"], registry: Parameters<typeof createEvalWrapperTargets>[0]["registry"]): ReturnType<typeof createEvalWrapperTargets> => {
    let found = wrapperTargetsByCompany.get(companyId);
    if (found === undefined) { found = createEvalWrapperTargets({ flow, registry, companyId, now: () => now().getTime() }); wrapperTargetsByCompany.set(companyId, found); }
    return found;
  };
  // L4-HW2: the company's learning port, asked for only where the lessons switch names the company (nothing is made, no token minted, for any other), and never allowed to break the runtime: a throw is "no port".
  // DEC 254zzz63: the port reads the company's own learning model from the company's own core store (its settings row), per call.
  const learningOf = (companyId: OrgId, settings: NonNullable<HostedLearningContext["settings"]>): CoreLessonsOptions["learning"] => {
    if (inputs.lessonsLearning === undefined || !switchCovers(lessonsSwitch.value, companyId)) return undefined;
    try {
      const port = inputs.lessonsLearning(companyId, { settings });
      // Said once per company build: a covered company with no port (no gateway settings, no task-token key, a SET learning model that is not Claude; DEC 254zzz58: never the agent model) learns nothing, and that is never silent.
      if (port === undefined) log({ event: "core_engine.lessons_learning_not_set_up", companyId });
      return port;
    } catch { log({ event: "core_engine.lessons_learning_unavailable", companyId }); return undefined; }
  };
  const teamRecords = new Map<string, CoreTeamRecord>();

  // One People rule for every core act on a task: the owner moves, the reads and the decision cards (the approvers point's own re-check uses it too, through `taskOwner`).
  const taskPeople: TaskPeopleDependencies = {
    documentClient: inputs.documentClient, tableName: inputs.stateTableName, now: () => now().getTime(),
    ...(inputs.checkTaskPerson === undefined ? {} : { checkTaskPerson: inputs.checkTaskPerson }),
  };
  const taskOwner = hostedTaskOwner({ membershipOf, projectGrant, people: taskPeople });

  const app = createCoreHostApp({
    // B5: a company the lessons switch or the system-runs flag names has its scheduled jobs before its first core task writes an in-use mark.
    alsoNamedBy: [lessonsSwitch.value, systemRunsFlag.value],
    modules: () => [...codeAdapterModules(inputs.codeModules({ storage: async () => (await app.registry()).require("storage") })), ...hostedSecurityModules({ env, identity, callbackSigningKey: inputs.callbackSigningKey, runStopWired: runStopWiredFrom(env), projectTaskCap, taskOwner, ...(quoteReader === undefined ? {} : { rateQuote: quoteReader }), ...(chatApproval === undefined ? {} : { chat: chatApproval }) }), ...gatewayModelKeysModules(env), ...(attention === undefined ? [] : [attentionEmailModule(attention.sender)]), ...evalReservationModules(env, inputs.taskTokens), ...companyInstructionsModules(env, inputs.taskTokens), ...savedEnvImageModules(env, inputs.savedEnvSessions ?? savedEnvRoleSessionsFromEnvironment(env)), ...(inputs.extraModules?.() ?? [])],
    context: () => ({ installCompanyId: IMPLICIT_COMPANY_ID, now, env, clients: {}, log }),
    wrapStorage: (store) => hostedAuthorityStore(inputs.wrapStorage?.(store) ?? store, inputs),
    beforeSeal: (registry) => {
      const settings = hookSettings;
      if (settings === undefined) return;
      applyHostedPolicyHook(registry, settings, inputs.policyHookInstall?.(), { audit: registry.require("audit-sink"), now: () => now().getTime(), log, ...(inputs.policyHookFetch === undefined ? {} : { fetch: inputs.policyHookFetch }) });
    },
    runtime: (registry, companyId) => ({
      callbackSigningKey: inputs.callbackSigningKey,
      // The per-run stop and the usage flush on Stop and close (core-money-stop): a stopped run whose usage did not arrive is marked unflushed and books nothing; its actual figure is the gateway's record, settled on the next spend read.
      // L2b: every core step on the gateway's agent model (the token's description reads the same route).
      // Configured without the task-token signer: refused here, so no task starts. The money stop is wired in every case.
      flowOptions: { ...(inputs.taskRules === undefined ? {} : { taskSharing: { prepare: async (caller, project, wanted) => {
        const latest = await createStoreProjectSource(registry.require("storage"), companyId).latest(project);
        if (latest === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; ask an admin");
        if (!wanted.shareToChannel && developerTaskPolicy(latest.definition).share !== "required") return undefined;
        const person = { developerId: caller.principal.personId, name: caller.principal.displayName };
        return prepareCoreShare(inputs.taskRules!(person, companyId), { ...person, sessionId: "core", amr: "oidc", ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }) }, project, developerTaskPolicy(latest.definition), wanted);
      } } }), captureStartComparison: async ({ project, inputText }) => {
        const store = registry.require("storage");
        const context = await hostedPreviewContext({ store, companyId, project, now, rateQuote: previewRates, workflowVersion: inputs.understandFirst === false ? "1.0.0" : "1.1.0", settings: admissionSettings, projectTaskCap, defaultRoute: async () => { const gateway = modelGateway(); return gateway === undefined ? undefined : companyEngineModelRoute({ store, companyId, offered: engineOffered, install: gateway.flowOptions.modelAccess }).route(); } });
        return startEstimates({ store }, { orgId: companyId, project, request: { quoteVersion: 2, ...(inputText.length <= 4000 ? { inputText } : {}) }, asOf: now().toISOString(), context });
      }, understandFirst: inputs.understandFirst ?? true, limits: async () => {
        const fallback = { member: Number(env.SLACK_MEMBER_WORKSPACE_LIMIT ?? "3"), organization: Number(env.SLACK_ORGANIZATION_WORKSPACE_LIMIT ?? "20") };
        if (!isWholeLimit(fallback.member, MAX_PER_PERSON) || !isWholeLimit(fallback.organization, MAX_PER_ORGANIZATION) || fallback.member > fallback.organization) throw new Error("the workspace limits are not readable");
        return await readWorkspaceLimits(inputs.documentClient, inputs.stateTableName, fallback, log);
      }, ...(modelGateway() === undefined ? {} : modelFlowOptions(registry, companyId)),
      // L4-TSU: what a task has cost, for automatic fixing's per-task dollar cap: the settled figure in THIS company's cost ledger, read fresh each time; anything not known to be complete throws (an ask, never "nothing spent").
      taskSpendUsd: createCompanyTaskSpend({ store: registry.require("storage"), companyId, refused: (reason) => log({ event: "core_engine.task_spend_refused", companyId, reason }),
        // SPEND-UNREPORTED-RUN: an ended run that sent no usage report is settled on this read (the gateway's record, a provable no-call, or an estimate), so the spend is never unreadable for good.
        settle: async (taskId) => { await createUnreportedRunSettler({ store: registry.require("storage"), companyId, moneyStop: createHostedMoneyStop({ store: registry.require("storage"), companyId, settings: admissionSettings, projectTaskCap, now }), now, log, ...(runCharges === undefined ? {} : { gatewayCharges: runCharges }) })(taskId); } }),
      // L4-TA6: and the cap it is held to: the task's LIVE cap, the value Admission and the run stop enforce (the install's cap lowered to the project's own limit), never autofix's larger default; unknown throws and asks.
      autofixDayBudgetHasRoom: hostedAutofixDayBudgetHasRoom({ store: registry.require("storage"), companyId, settings: admissionSettings, now }),
      taskCapUsd: hostedTaskCapUsd({ store: registry.require("storage"), companyId, settings: admissionSettings, projectTaskCap }),
      // L2-4 + core-task-web-routes (#1045): every person's start (web, Slack, API, intake) gets its session in its own start transaction, as on a laptop, so Retry, Close and the log reach it;
      // a task started from a ticket also gets the ticket binding there. A system owner's start gets nothing added.
      startExtras: ticketSessionStartExtras(companyId, { chatThreads: inputs.chatThreads !== undefined }),
      // People is initialized lazily by its owner view. Starting work must not require the optional person-proof runtime.
      moneyStop: createHostedMoneyStop({ store: registry.require("storage"), companyId, settings: admissionSettings, projectTaskCap, now }),
      // L6a: a finished task teaches this company's estimate from the same company-scoped usage ledger as hosted spend.
      onTaskClosed: async (task, closedAt) => {
        const store = registry.require("storage");
        const ledger = createHostedLedger({ store, metering: registry.require("metering"), now });
        const outcome = await recordRunCost({ store }, {
          orgId: companyId, project: task.project, taskId: task.taskId, path: estimatePathOf(task), endedAt: closedAt,
          ...runCostInputOf(await ledger.taskCost(companyId, task.taskId)),
        });
        log({ component: "cost", event: "cost.run_recorded", outcome });
        try { await recordClosedRunUsage({ store }, task, closedAt); }
        catch (error) { log({ component: "cost", event: "cost.run_usage_not_recorded", error: error instanceof Error ? error.name : "unknown" }); throw error; }
      },
      // L6a: a task started from Linear keeps the session binding available to merge tracking, within this company's store partition.
      sessionBindings: { read: (_orgId, sessionId) => sessionBindingsOf(registry.require("storage"), companyId, sessionId) },
      // L4-ART: the flow's reader of the documents workers and the engine saved (the approved plan, a diff, the eval rounds): the registry's object storage held to THIS company's own workspaces (an
      // outside key, another company's workspace or another owner's key reads as "not there"). Without it each reader of the flow gives its "no reader" answer (core/proof/eval-round-reader.ts: no eval request).
      feedbackArtifacts: registry.require("object-storage"),
      artifacts: createCompanyArtifactReader({ blobs: registry.require("object-storage"), store: registry.require("storage"), companyId, refused: (reason) => log({ event: "core_engine.artifact_read_refused", companyId, reason }) }),
      // L4-HW3: a starting task copies the project's How we work and the company's rules onto its workspace (the broker has the code host and the company-instructions point; the dispatcher has neither and
      // builds every step's block from that copy).
      standingInstructions: hostedStandingInstructions({ registry, companyId, now }),
      // L4-HW4 (the laptop's `evidence.keepAfterChecks`): when a run's checks are recorded for a candidate, the evidence of that run (per-check output, the failing tests with the change that most likely broke each, the baseline words) is
      // kept for the Proof route, in the company-bound object store (only this company's own workspaces; the same data guard and caps as the laptop). A rerun of the checks also asks the worker to save the raw parts (`evidenceCapture`).
      keepEvidence: hostedKeepEvidence({ blobs: registry.require("object-storage"), store: registry.require("storage"), companyId, env, now: () => now().getTime(), log, refused: (reason) => log({ event: "core_engine.evidence_refused", companyId, reason }) }),
      autonomy: hostedAutonomy({ store: registry.require("storage"), companyId }),
      // DEC 254zm: a starting task pins the project's newest usable approved test environment (the company's own records), as on a laptop.
      testEnvironment: createTaskTestEnvironment({ store: registry.require("storage"), now: () => now().getTime(), env, audit: registry.require("audit-sink"), serviceCatalog: hostedServiceCatalog(env) }, { orgId: companyId }),
        // Lead 4 W4: told when a wiki build's task ended, so the wiki's build record says how it ended.
        wikiBuildEnded: wikiBuildEndedHook({ store: registry.require("storage"), companyId, now: () => now().getTime() }) },
      access: hostedTaskAccess({ membershipOf, projectGrant, companyId, storage: async () => registry.require("storage"), setupRunStanding, systemRunsOn: () => effectiveSystemRunsGateOf(systemRunsFlag.value, companyId, registry.require("storage")).enabled(),
        // L4-SR2: a repair draft is accepted only while the project's own upkeep switch is on (read now, at the start and at every step).
        upkeepOn: (project) => upkeepIsOn({ store: registry.require("storage"), companyId }, project), people: taskPeople }),
      repositoryCredential: inputs.repositoryCredential,
      repositoryGrantKey: inputs.repositoryGrantKey,
      now,
      log,
      ciReporting: inputs.ciReporting === undefined ? policyCiReporting(policySource) : inputs.ciReporting,
      services: (flow, wiring) => {
        const wireModelChoiceOutbox = () => {
          const choice = modelChoices.choiceFor(companyId);
          if (choice === undefined) return;
          // Validate immediately before broker-side dispatch handoff, including start, callbacks and scheduled relays.
          const outbox = flow.deps.outbox;
          flow.deps.outbox = { stage: (message) => outbox.stage(message), relay: async (options) => {
            await choice.service().state();
            return await outbox.relay(options);
          } };
        };
        const buildCompanyLessons = (milestones: DocumentMilestones | undefined): CoreLessons | undefined => {
          if (inputs.lessonsPeople === undefined) {
            if (lessonsSwitch.value.mode !== "off") log({ event: "core_engine.lessons_not_wired", companyId });
            return undefined;
          }
          return createCoreLessons({
            // B6: the weekly summary's chats are the company's own chat seam (the same view and `companyOf` the thread notices read), not the raw core registry, which has no `channel` point here.
            ...(inputs.chatThreads === undefined ? {} : { digestChannels: { registry: hostedChannelView(inputs.chatThreads, registry, companyId), companyOf: inputs.chatThreads.companyOf } }),
            flow, registry, companyId, milestones, lessonsSwitch: lessonsSwitch.value, digestPilot: lessonsDigestPilot, people: inputs.lessonsPeople(companyId, { store: async () => registry.require("storage") }), now: () => now().getTime(), log,
            // Lead 4 L4-AK2b: the knowledge briefing's measured facts on a deployed install: the base's known-flaky tests from THIS company's own nightly baseline rows (the same read the laptop makes).
            knowledge: { facts: flakyFactsPort((flakyTask) => baseFlakyTests({ store: registry.require("storage"), now: () => now().getTime() }, flakyTask)) },
            ...((learning) => (learning === undefined ? {} : { learning }))(learningOf(companyId, { get: async (key) => await registry.require("storage").get(key) })),
            // L4-SRC-TK: ticket comments as a (weak) lessons source, through the company's own Linear connection and its own account links only.
            ...(inputs.linearIntake === undefined ? {} : {
              tickets: {
                trackerFor: hostedTrackerFor(companyId, inputs.linearIntake.connections, inputs.linearIntake.fetch),
                resolveAccount: linearCommentAuthorResolver({ store: registry.require("storage"), connections: inputs.linearIntake.connections, principalOf: (org, personId) => registry.require("identity").getPrincipal(org, personId) }),
              },
            }),
            ...((slack) => (slack === undefined ? {} : { channelCompanyOf: slack.companyOf, slackThreadCommand: slack.command }))(inputs.lessonsSlack?.(companyId)),
            hostFor: async (other) => {
              if (other === companyId) return lessonsByCompany.get(other)?.host;
              try { await app.runtimeFor(other); } catch { return undefined; }
              return lessonsByCompany.get(other)?.host;
            },
          });
        };
        const registerMilestoneHandlers = (milestones: DocumentMilestones | undefined) => {
          if (milestones === undefined) return;
          // L2-4: the ticket write-back rides on the company's milestones, through the company's own Linear connection only. R1 + L1 6.2: on the company's milestones host, whether or not lessons are on.
          // The task log rides with it: the flow tells the hook once an answer, a question or a decision is committed (the entries are written in that change's own transaction), and the plan's summary is read
          // through the company's own decision gate. A company with no Linear write-back gets neither (the hook is never set, so the flow is byte-identical to before).
          if (inputs.linearIntake !== undefined) {
            const taskLog = createTaskLogHooks((event, fields) => { log({ component: "task_log", companyId, event, ...fields }); });
            flow.deps.taskLog = taskLog;
            for (const handler of hostedTicketUpdates({
              companyId, store: registry.require("storage"), connections: inputs.linearIntake.connections, fetch: inputs.linearIntake.fetch, now: () => now().getTime(), log,
              planSummaryOf: hostedPlanSummaryOf({ flow: flow.deps, registry, companyId, now }), taskLog,
              members: deployedSessionMembers(companyId, { membershipOf, projectGrantRole }),
            })) milestones.register(handler);
          }
          // L4-U5b: the chat thread a task was started from is told its milestones, through this company's own chat adapter only. The person who started the task must still be this company's member.
          if (inputs.chatThreads !== undefined) {
            const threads = inputs.chatThreads;
            milestones.register(hostedThreadHandler({
              threads, registry, companyId, deps: flow.deps, now: () => now().getTime(), clock: now, origin: originOf,
              isMember: async (orgId, personId) => (await membershipOf(personId))?.companyId === orgId,
              taskActions: taskActionCapabilities,
              log: (event, fields) => log({ component: "channel_thread", event, companyId, ...fields }),
            }));
          }
          // The flow's milestone slot, filled once every handler is registered (a milestone written with no handler is marked told).
          flow.deps.milestones = milestones;
          milestonesByCompany.set(companyId, milestones);
        };
        const buildSetupRepair = (upkeep: ReturnType<typeof upkeepPartsFor>, modelConfigured: () => boolean, upkeepRoom: (project: string) => Promise<number | undefined>) => {
          const repair = switchCovers(systemRunsFlag.value, companyId)
            ? createHostedSetupRepair({
              flow: flow.deps, companyId, now: () => now().getTime(), gate: upkeep.gate, admission: flow.deps.admission, modelAccessConfigured: modelConfigured,
              readFile: (repository, path, commit, readOptions) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } })
                .fileAtRevision({ url: repository.url }, path, commit, { orgId: companyId }, { ...(readOptions.untilLine === undefined ? {} : { untilLine: readOptions.untilLine }), timeoutMs: readOptions.timeoutMs, maxBytes: 262_144 }),
              room: upkeepRoom,
              onUpkeepPaused: (scope, reason) => upkeep.pauses.onRunPaused(scope, reason), log,
            })
            : undefined;
          if (repair !== undefined) {
            flow.deps.afterSetupBroken = repair.hook;
            flow.deps.upkeepRoomCents = upkeepRoom;
          }
          return repair;
        };
        const buildProvidedServiceWiring = (milestones: DocumentMilestones | undefined, lessons: CoreLessons | undefined, upkeep: ReturnType<typeof upkeepPartsFor>): Parameters<NonNullable<BrokerCoreRootInputs["services"]>>[3] => ({
          ...wiring,
          ...(attention === undefined && inputs.chatThreads === undefined ? {} : { notification: {
            // HW5: the chat thread's notices (the company's chats, the thread, the task link, the already-told reads), and the attention email's seams beside them.
            ...(inputs.chatThreads === undefined ? {} : hostedThreadNotification({ threads: inputs.chatThreads, registry, companyId, store: registry.require("storage"), now: () => now().getTime(), origin: originOf, threadsTold: milestones !== undefined })),
            ...(attention === undefined ? {} : { address: attention.addressFor(flow.deps.store), emailLinks: attention.links, remember: attention.rememberFor(flow.deps.store) }),
          } }),
          ...(inputs.chatThreads === undefined ? {} : { threadMoments: milestones !== undefined, threadRefresh: hostedWorkflowThreadRefresh({ threads: inputs.chatThreads, registry, companyId, deps: flow.deps, now: () => now().getTime(), clock: now, origin: originOf,
            isMember: async (orgId, personId) => (await membershipOf(personId))?.companyId === orgId, taskActions: taskActionCapabilities, log: (event, fields) => log({ component: "channel_thread", event, companyId, ...fields }) }) }),
          // R1 + L1 6.2: a ticket's own plan-ready and closed moments are written only where the ticket write-back is wired (the company has the Linear connection).
          ticketMoments: inputs.linearIntake !== undefined && milestones !== undefined,
          ...(lessons === undefined ? {} : { humanEdit: lessons.host.noteHumanEdit }),
          upkeep: { administers: upkeep.administers, setupRead: (orgId, project) => (orgId === companyId ? readSetupBrokenNotice({ flow: flow.deps, store: flow.deps.store, companyId, now: () => now().getTime() }, project) : Promise.resolve(undefined)), setupLink: (project) => projectPageUrl(originOf(), project) },
        });
        wireHostedApplicationE2E({ ...inputs, flow: flow.deps, companyId, objects: registry.require("object-storage"), runtimeCatalogId: env["AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID"] ?? "", capture: inputs.applicationSource });
        composeHostedPrFeedbackRoutes(flow.deps);
        flow.deps.afterPlanStored = hostedPlanEvidence(flow.deps, registry.require("object-storage"));
        const runWatch = flow.sweepRunsOnce.bind(flow);
        const idleScan = { cursor: undefined as string | undefined };
        flow.sweepRunsOnce = async (options) => {
          const report = await runWatch(options);
          const idle = await sweepCoreIdleSlack({ flow: flow.deps, documentClient: inputs.documentClient, threadsTableName: env.SLACK_THREADS_TABLE_NAME,
            scan: idleScan, companyOf: async (where) => inputs.chatThreads?.companyOf(where),
            postNote: async (conversation, text, operationId) => {
              const adapter = inputs.chatThreads?.adapterFor(companyId, conversation.channel);
              if (adapter === undefined) throw new Error("thread transport unavailable");
              await adapter.deliver({ version: 1, id: `idle-cancel-${operationId}`, channel: conversation.channel, conversation, createdAt: now().toISOString(), type: "progress", data: { text } });
            } });
          report.failed += idle.failed;
          return report;
        };
        // TIER-GROWTH-MERGE: the code and security reviews a change that grew must pass on its current head, over the gateway's agent route as the task's own paid call (the meter is the task's cap and the admission).
        wireHostedTierReview({ env, taskTokens: inputs.taskTokens, flow: flow.deps, companyId, now, booking: createUsageBooking({ store: registry.require("storage"), metering: registry.require("metering"), now }),
          taskRoomUsd: (task) => reviewerRoomUsd({ store: registry.require("storage"), metering: registry.require("metering"), companyId, settings: admissionSettings, now, projectTaskCap }, task) });
        flow.deps.secondReview = createHostedReviewers({ flow: flow.deps, registry, companyId, offered: engineOffered, taskRoomUsd: (task) => reviewerRoomUsd({ store: registry.require("storage"), metering: registry.require("metering"), companyId, settings: admissionSettings, now, projectTaskCap }, task) }).secondReview;
        createHostedDesignReview({ flow: flow.deps, registry, companyId, offered: engineOffered,
          taskRoomUsd: (task) => reviewerRoomUsd({ store: registry.require("storage"), metering: registry.require("metering"), companyId, settings: admissionSettings, now, projectTaskCap }, task),
          env, blobs: registry.require("object-storage") });
        wireModelChoiceOutbox();
        // R1 + L1 6.2: the company's milestones host, for every company that has a handler to register (Linear write-back, chat threads, lessons), whether or not lessons are on.
        const milestones = companyMilestones({ flow, companyId, now: () => now().getTime(), log, anyHandler: (inputs.lessonsPeople !== undefined && switchCovers(lessonsSwitch.value, companyId)) || inputs.linearIntake !== undefined || inputs.chatThreads !== undefined });
        const lessons = buildCompanyLessons(milestones);
        registerMilestoneHandlers(milestones);
        if (lessons !== undefined) {
          lessons.attach();
          lessonsByCompany.set(companyId, lessons);
          // The Team record rides on the company's lessons (LM7): a merged or closed task of the company adds its people's decisions and review feedback. Its search is for the
          // context sources' `teamSearch`; only this company's eligible stages advertise it.
          teamRecords.set(companyId, attachCoreTeamRecord(lessons, { store: registry.require("storage"), now: () => now().getTime(), log }));
          flow.deps.contextSources = { stageHasSources: async (_task, mode) => isContextSourceStage(mode) && teamRecords.has(companyId) };
        }
        // L4-P1: the company's SystemRuns flag, on the flow itself (the free re-check at task start stands behind it), and the system starter and the upkeep night where the flag covers the company (nothing is built otherwise).
        hostedSystemRunsFor(flow.deps, companyId, systemRunsFlag.value);
        const upkeep = upkeepPartsFor(registry, companyId);
        // L4-U5: a re-check that settles as broken tells the project's admins once (the notice writes its own marker); the same flow's repair card is what the delivery re-reads before every send.
        flow.deps.setupBroken = async (input) => { await upkeep.setupBroken(input); };
        // L4-P2: the AI step of the night (the wiki refresh) over the SAME flow and its own Admission; it starts only where a dollar cap is really enforced and both locks are open. The file map is the night's own.
        const wikiMapForNight: HostedWikiMapWiring = { standing: setupRunStanding, hostFor: (repository) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }) };
        const modelConfigured = (): boolean => { try { return modelGateway() !== undefined; } catch { return false; } };
        // A wiki build whose pinned commit is gone from the default branch (a rewrite) is started again ONCE over a new snapshot, with no person asked (the broker has the code host; the dispatcher wires nothing).
        flow.deps.wikiBuildResnapshot = hostedWikiResnapshot({ flow: flow.deps, companyId, now: () => now().getTime(), map: wikiMapForNight, standing: setupRunStanding, modelAccessConfigured: modelConfigured });
        // L4-SR2: the automatic repair draft, only where the ceiling covers the company (nothing is built otherwise). Its start is behind the effective gate, the project's upkeep switch, an enforced cap with room and the access rule's marks.
        // L4-SR2b: the project's remaining room is the gateway's own answer (the SAME reader as the night's cap signal), read fresh at the draft's start and at every model token's mint; any doubt is no room.
        const upkeepRoom = (project: string): Promise<number | undefined> => upkeepRoomCentsOf(upkeepCapFor(companyId), project, now().getTime(), companyId);
        const repair = buildSetupRepair(upkeep, modelConfigured, upkeepRoom);
        const systemRuns = createHostedSystemRuns({
          flow, companyId, flag: systemRunsFlag.value, now: () => now().getTime(), log,
          enforcesDollars: admissionEnforcesCost(flow.deps.admission), paused: (input) => upkeep.pauses.paused(input), cap: upkeepCapFor(companyId),
          refresh: createHostedWikiRefresh({ flow: flow.deps, companyId, now: () => now().getTime(), gate: upkeep.gate, admission: flow.deps.admission, modelAccessConfigured: modelConfigured(), map: wikiMapForNight, cap: upkeepCapFor(companyId), log }),
        });
        const afterMerge = createLocalAfterMerge({ flow: flow.deps, registry, companyId, now: () => now().getTime(), log });
        const provided = inputs.services?.(companyId, flow, registry, buildProvidedServiceWiring(milestones, lessons, upkeep)) ?? {};
        // R1 + L1 6.2: the milestone sweep (and, with Linear, the one-time flip of the seeded status default) runs from the always-wired `notify-deliver` pass, not from lessons' (`aws/milestone-home.ts`).
        const withSweep = withTaskEndReconcile(withMilestoneSweep(provided, { milestones, companyId, linear: inputs.linearIntake !== undefined, store: registry.require("storage"), now: () => now().getTime(), audit: registry.require("audit-sink"), log }),
          { flow, companyId, now: () => now().getTime(), log });
        return {
          ...withSweep, ...(lessons === undefined ? {} : { lessons: lessons.service }),
          // L6a: the project setting is off by default; the service is bound to this runtime's company.
          "after-merge": afterMerge,
          // L4-P2: where the ceiling covers the company: the night, and the sweep that settles an unattended run's reservation and stops one that outlived its minutes.
          ...(systemRuns === undefined ? {} : { upkeep: systemRuns.service, "automation-stop": createHostedAutomationStop({ flow: flow.deps, companyId, admission: flow.deps.admission, now: () => now().getTime(), log, repairs: repair }) }),
          "person-erase-resume": { pass: async ({ budgetMs }) => await resumeErases(companyId, budgetMs) },
          // The admission's own hold sweep (lane L8) is always this one: a deployment's services never replace the sweep of the holds this admission takes.
          "admission-hold-sweep": coreMoneyWiring(registry, companyId, now).holdSweep,
        };
      },
    }),
  });
  if (lessonsSwitch.problem !== undefined) log({ event: "core_engine.lessons_switch_unreadable", problem: lessonsSwitch.problem });
  if (systemRunsFlag.problem !== undefined) log({ event: "core_engine.system_runs_switch_unreadable", problem: systemRunsFlag.problem });

  // Off: nothing below is built. Invalid active settings leave only the fixed core refusal entry.
  const buildServingCoreSurfaces = () => {
    // The library's install-wide learning gate follows the lessons switch.
    setCoreLessonsGate(env);
    const companyOf = async (caller: DeployedCaller): Promise<CompanyMembership | undefined> => membershipOf(caller.principal.personId);
    // Lane L11: an act on a decision card carries the approvers point's own proof (lane L2a), signed with the key the point verifies with.
    const decisionProofs = approvalDecisionProofs(approvalProofKeyOf(inputs.callbackSigningKey), () => now().getTime());
    const routes = createCoreDevRoutes({
      app, companyOf, log,
      // S1: the task action registry's chat presses (the chat seam, the install's proof key, the company's approval gate: the same one the web's cards and the chat decision use).
      chat: taskActionChatOf(chatApproval, inputs.chatThreads, approvalProofKeyOf(inputs.callbackSigningKey), async (runtime, companyId) => hostedDecisionService({ deps: runtime.flow.deps, registry: await app.registry(), companyId, now }).gate),
      wiring: async (runtime) => {
        const companyLessons = lessonsByCompany.get(runtime.companyId);
        // Lane L11: the session levels, the decision cards and how we work, from the company's own records (membership and the broker's project grants).
        const registry = await app.registry();
        // Wiki W0 and W4 share ONE file map wiring (and so one kept map): the free map and the build that plans from it.
        const wikiMapWiring: HostedWikiMapWiring = {
          standing: setupRunStanding,
          hostFor: (repository) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }),
        };
        // L4-D (DEC 254z b): "Use this setup" with the risk-based approval, over the company's approvers point and its people's live membership and grants (also the live members the eval health run reads).
        const setupApproval = createHostedSetupApproval({
          flow: runtime.flow.deps, store: runtime.flow.deps.store, approvers: registry.require("approvers"), audit: runtime.flow.deps.audit, identity: registry.require("identity"),
          people: { membershipOf, projectGrantRole }, proofKey: approvalProofKeyOf(inputs.callbackSigningKey), now,
          // L4-SF (c): an approval keeps the old broker's project registry in step with the core's, in the same decision.
          registryMirror: createSetupRegistryMirror({ store: runtime.flow.deps.store, companyId: runtime.companyId }),
          // Browser testing: a browser testing candidate is approved only here, by a live company owner or admin, with its stored proposal read again from the company's own object storage.
          objects: registry.require("object-storage"),
        });
        // L4-EVH (DEC 254zzz20 D5): the opt-in eval health run is offered only where a run can really happen (the model gateway, a bound reservation adapter and its cap source), and a person's yes starts it.
        const modelGatewayConfigured = (() => { try { return modelGateway() !== undefined; } catch { return false; } })();
        const healthRuns = evalHealthRunsAvailable({ registry, modelGatewayConfigured });
        const healthDeps = healthRuns ? evalHealthRunDeps({ registry, environment: env, companyId: runtime.companyId, now: () => now().getTime(), members: setupApproval.evalMembers, flow: runtime.flow.deps, modelGatewayConfigured }) : undefined;
        return {
          origin: inputs.origin,
          startEstimates: (project) => hostedPreviewContext({ store: runtime.flow.deps.store, companyId: runtime.companyId, project, now, rateQuote: previewRates, workflowVersion: inputs.understandFirst === false ? "1.0.0" : "1.1.0", settings: admissionSettings, projectTaskCap, defaultRoute: async () => { const gateway = modelGateway(); return gateway === undefined ? undefined : companyEngineModelRoute({ store: runtime.flow.deps.store, companyId: runtime.companyId, offered: engineOffered, install: gateway.flowOptions.modelAccess }).route(); } }),
          sessionCapSeconds: hostedSessionCapSeconds(),
          scriptTokens: {}, ...(attention === undefined ? {} : { unsubscribeKey: attention.unsubscribeKey }),
          ...(modelChoices.choiceFor(runtime.companyId) === undefined ? {} : { modelChoice: modelChoices.choiceFor(runtime.companyId)! }),
          taskActions: { roundCap: async (task) => hostedRoundCap(registry, runtime.companyId, now, admissionSettings, projectTaskCap, task, runtime.flow.deps.taskSpendUsd) },
          // Cloud #188 item 3: a core task's People, readers, events and plan comments, with the old task routes' own rules.
          ...(inputs.taskRules === undefined ? {} : { taskRules: createCoreTaskRuleRoutes(inputs.taskRules, runtime.flow.deps.artifacts) }),
          canReadProject: (personId, project, companyId) => projectGrant(personId, project, companyId),
          // DEC 254zzz94: the Merge button, over the root's own grant reader, the project's pinned repositories on the registry's code host, and the project's merge method (Code's default: squash).
          merge: {
            projectGrantRole: (personId, project, companyId) => projectGrantRole(personId, project, companyId),
            merge: (audit) => withFeedbackMergeReads(hostedMergeDependencies({ runtime, registry, audit, settings: inputs.codeSettings, defaults: DEFAULT_CODE_SETTINGS, now: () => now().getTime(), policyHook: hookSettings !== undefined || hookProblem, taskPeople }), runtime.flow.deps, registry),
            afterMerge: (taskId) => wakeMergeTrackingForPerson(runtime.flow.deps.store, taskId, now().getTime()),
          },
          // DEC 254z-amend3: the project's test environment state, with the install's switches (and the host's "not available here" marker, broker-environment-init.ts) and the owner starter list as the catalog.
          testEnvironment: { env, serviceCatalog: hostedServiceCatalog(env), catalogName: "owner-starter-list" },
          // L4-B3b (DEC 254zm item 4): approving that environment, with the risk-based approver rule read live (company role and project grant) and the approvers point's own proof.
          testEnvironmentApproval: createHostedTestEnvironmentApproval({
            companyId: runtime.companyId,
            deps: { store: registry.require("storage"), now: () => now().getTime(), env, audit: registry.require("audit-sink"), serviceCatalog: hostedServiceCatalog(env) },
            store: registry.require("storage"), approvers: registry.require("approvers"), audit: runtime.flow.deps.audit, identity: registry.require("identity"),
            people: { membershipOf, projectGrantRole }, proofKey: approvalProofKeyOf(inputs.callbackSigningKey), now,
          }),
          // L4-MF1: the project's saved environment image panel, read only. Hosted has no image registry wired, so it stays off (404) until the install switch is on.
          savedEnv: { enabled: savedEnvEnabled(env) },
          // Guided onboarding L2-3: the hosted setup run. Its model use is the gateway's (configured: the run is metered); citations are re-read from the company's own code host.
          setupRun: {
            standing: setupRunStanding,
            modelAccessConfigured: () => { try { return modelGateway() !== undefined; } catch { return false; } },
            readFile: (repository, path, commit, readOptions) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } })
              .fileAtRevision({ url: repository.url }, path, commit, { orgId: runtime.companyId }, { ...(readOptions.untilLine === undefined ? {} : { untilLine: readOptions.untilLine }), timeoutMs: readOptions.timeoutMs, maxBytes: 262_144 }),
            displayName: displayNameOf,
            // L4-EVC (DEC 254zzz20): the eval card. The monthly cap comes only from the install's bound `eval-reservation` adapter (no adapter: no eval is confirmed); the broker hashes the confirmed files from the company's own code host.
            eval: {
              ...(boundEvalMonthlyCap(registry) === undefined ? {} : { monthlyCap: boundEvalMonthlyCap(registry)! }),
              ...(boundEvalProviderConnected(registry) === undefined ? {} : { providerConnected: boundEvalProviderConnected(registry)! }),
              readFile: (repository, path, commit, readOptions) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } })
                .fileAtRevision({ url: repository.url }, path, commit, { orgId: runtime.companyId }, { timeoutMs: readOptions.timeoutMs, maxBytes: readOptions.maxBytes }),
              wrapperTargets: (project) => wrapperTargetsOf(runtime.companyId, runtime.flow.deps, registry)(project),
              ...(healthDeps === undefined ? {} : { healthRuns: true, healthRun: (project: string) => kickEvalHealth(healthDeps, project) }),
              // L4-E12: hosted test services run only where the operator set TestServiceImages=mirrored (and the switch is on): otherwise the dry run's words say they are off on this install.
              testServicesOff: () => !hostedWorkersRunTestServices(env),
            },
            // L4-D (DEC 254z b): "Use this setup" with the risk-based approval, over the company's approvers point and its people's live membership and grants.
            approval: setupApproval,
          },
          // Wiki W0: the free file map reads the company's own code host (company-bound, listings only) and uses the setup run's live standing; no model key is involved.
          wikiMap: wikiMapWiring,
          // Lead 4 W4: the wiki build controls. The same live standing, the same code host and the SAME file map wiring (one kept map), the install's model gateway for the run, and the task
          // flow's wiki build starter (W3b).
          wikiBuild: {
            standing: setupRunStanding,
            starter: createWikiBuildStarter,
            modelAccessConfigured: () => { try { return modelGateway() !== undefined; } catch { return false; } },
            map: wikiMapWiring,
            displayName: displayNameOf,
          },
          // Lead 4 N1 + L4-P1: the nightly upkeep switch. The same live standing as the wiki controls. `available` follows the company's SystemRuns flag (default off): the system starter and the hourly `upkeep-night` job exist exactly there, so with the flag off the page hides the switch and a change is refused. (The per-project schedule is not used: one hourly job starts every due project.)
          upkeep: { standing: setupRunStanding, available: upkeepAvailableFor(systemRunsFlag.value),
            // L4-SR1: the project's monthly cap as the gateway says now (the page's "of $Y"); null where the gateway does not answer.
            cap: async (company, project) => { const read = await readUpkeepCap(upkeepCapFor(company), project, now().getTime(), company); return read.state === "enforced" ? read.limitUsd : null; } },
          // L4-U5b: the project notices in the person's own inbox are checked against the same live reads the notice delivery uses (does the person still administer the project, is the setup still broken).
          projectNotices: {
            administers: upkeepPartsFor(registry, runtime.companyId).administers,
            setupRead: (orgId, project) => (orgId === runtime.companyId ? readSetupBrokenNotice({ flow: runtime.flow.deps, store: runtime.flow.deps.store, companyId: runtime.companyId, now: () => now().getTime() }, project) : Promise.resolve(undefined)),
            },
          // L4-EVCI2: the setup card's eval check from the customer's CI. The same live standing; the workflow files are read through the company's own code host (company-bound, listings and one file at a time).
          evalCheck: {
            standing: setupRunStanding,
            readerFor: async (companyId, repository) => companyId !== runtime.companyId ? undefined : ciDefinitionReaderOf(codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }), repository, { orgId: companyId }),
          },
          // Browser testing in a project's setup (owner decisions 417, 420, 421): the same live standing (only a company owner or admin changes anything), the ONE approval gate, the company's own code host and object
          // storage, and the project's own runtime binding for the sandbox.
          browserTesting: {
            standing: setupRunStanding, approval: setupApproval, objects: registry.require("object-storage"),
            capture: async (companyId, repository) => {
              if (companyId !== runtime.companyId || inputs.applicationSource === undefined) throw new Error("source capture is not available here");
              const commit = await headOf(codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }), repository, { orgId: companyId });
              return inputs.applicationSource(repository.url, commit);
            },
            readyProfiles: async (companyId, project) => (companyId !== runtime.companyId ? [] : readyProfilesFor({ store: runtime.flow.deps.store, companyId, project, runtimeCatalogId: env["AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID"] ?? "", now: now().getTime() },
              (await runtime.flow.deps.projects.latest(project))?.definition.revision ?? 0)),
            sandboxAvailable: async (companyId, project) => (companyId !== runtime.companyId ? false : sandboxAvailableFor({ store: runtime.flow.deps.store, companyId, project, runtimeCatalogId: env["AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID"] ?? "", now: now().getTime() },
              (await runtime.flow.deps.projects.latest(project))?.definition.revision ?? 0)),
          },
          // Audit gap 11b: the project's ticket-sharing settings. The same live standing; the trackers a hosted company's tickets are written back to (Linear, over its own connection: hosted-intake.ts).
          ticketUpdates: { standing: setupRunStanding, trackers: HOSTED_TICKET_TRACKERS },
          // R1 + L1 6.2b: the waiting tickets at the one /v1/app address; the intake itself is built below (read when a request comes).
          intake: { standing: setupRunStanding, intake: () => intake },
          // PRIVATE-PACKAGES P1b: the company's package tokens (write only: the status line is read, no route answers a value). Through the company-tagged session of the CompanySecrets role; an install
          // without that role has no wiring and the path says "not on the core yet". Nothing here hands a token to a run: the exchange's company store is a later step (P2).
          ...(companySecrets === undefined ? {} : { packageRegistries: { env: companySecrets.env, secrets: companySecrets.secrets } }),
          // Lead 4 W2: the project wiki's reads. Any live role on the project reads (the setup run's standing); the project must be in the company's catalog.
          wiki: {
            standing: setupRunStanding,
            projectRepositories: async (companyId, project) => (companyId !== runtime.companyId ? undefined : (await runtime.flow.deps.projects.latest(project))?.definition.repositories.map((repository) => repository.name)),
            displayName: displayNameOf,
            // Lead 4 L4-LP3W: "Team lessons for this area" reads this company's own lessons library, and no other company's.
            lessonsOf: (companyId) => (companyId === runtime.companyId ? lessonsByCompany.get(companyId)?.runtime.load : undefined),
            // L4-WKS: the company's "Knowledge stays in Rovara" for the MCP wiki tools (any caller but the web app). The company's own switch is read from its own store even where lessons are not on for it (no lessons runtime);
            // the Regulated preset needs the lessons settings, so it applies where they exist.
            toolGate: async (companyId: OrgId, project: string) => {
              if (companyId !== runtime.companyId) throw new Error("wiki gate: another company");
              return await wikiToolsGate(companyLessons === undefined ? { localTools: new DocumentLocalToolsSettings(registry.require("storage")) } : { localTools: companyLessons.runtime.localTools, settings: companyLessons.runtime.settings }, { workspaceId: runtime.companyId, project });
            },
          },
          // Lead 4 C1: the wiki's corrections. The role is read live from membership; "Suggest as a lesson" exists only where lessons are on for the company (it writes one PENDING lesson, never approves).
          wikiCorrections: {
            projectRole: wikiProjectRole,
            projectRepositories: async (companyId, project) => (companyId !== runtime.companyId ? undefined : (await runtime.flow.deps.projects.latest(project))?.definition.repositories.map((repository) => repository.name)),
            displayName: displayNameOf,
            // The company's lessons are built with its runtime (lessonsByCompany); absent where the lessons switch does not cover the company.
            ...(companyLessons === undefined ? {} : { suggestLesson: async (note: WikiNoteLessonInput): Promise<WikiNoteLessonResult> => (note.companyId !== runtime.companyId ? { state: "refused" as const } : await proposeLessonFromNote({ store: companyLessons.runtime.store, settings: companyLessons.runtime.settings, audit: companyLessons.runtime.audit, now: () => now().getTime() }, note)) }),
          },
          // Lead 4 A1/A2: the cost and time report. A task is filed or moved by its starter or a project maintainer: the standing is the setup run's own live read.
          report: { standing: setupRunStanding },
          // Lead 4 J3 + L4-HC: the web start box's path suggestion. Any live role on the project asks (the setup run's standing). The classifier is ONE small call through the same answers gateway path as the
          // answers (same purpose, same company binding, the company's own key): `answersModel()` is undefined without the gateway (or an answering model that is not a Claude engine name: ROVARA_CORE_ANSWERS_MODEL, else the agent model; or no task-token key), and then every suggestion says
          // the classifier is unavailable (small talk is still answered, free). The hourly counter is stored per company, project and person.
          startSuggest: {
            standing: setupRunStanding,
            route: hostedStartRoute(answersModel),
          },
          // Lead 4 J1: the smart Just answer. Any live role on the project asks (the setup run's standing); the code is the project's own repositories on the company's code host. The model is the gateway's
          // "answers" purpose (Cloud lane L4-E; L4-AG): the company's own key, its own monthly limit, a fresh answers token per call. No gateway configured (or an answering model that is not a Claude engine name, or no task-token key):
          // every answer is the fixed "answers are not set up here yet" outcome.
          answers: {
            model: answersModel(),
            // Lead 4 L4-AK2g: this company's own lessons host answers its briefing (never another company's); absent where the lessons switch does not cover it.
            briefing: answersBriefingOf(runtime.companyId, (id) => lessonsByCompany.get(id)?.host),
            standing: setupRunStanding,
            repositories: async (companyId, project) => {
              if (companyId !== runtime.companyId) return undefined;
              const latest = await runtime.flow.deps.projects.latest(project);
              // A repository whose code host cannot be resolved throws here: the answer is then unavailable, never answered over a shorter list (that list also decides what left the project).
              return latest === undefined ? undefined : {
                names: latest.definition.repositories.map((repository) => repository.name),
                handles: codeRepositoriesOf(latest.definition).map((repository) => ({
                  name: repository.name, defaultBranch: repository.defaultBranch, repository: { url: repository.url }, scope: { orgId: runtime.companyId },
                  host: codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }),
                })),
              };
            },
          },
          auditFor: (caller, sink) => auditSinkForDeployedCaller(sink, { client: caller.client }),
          ...deployedDevWiringParts({ runtime, registry, people: { membershipOf, projectGrantRole }, decisionProofs, codeSettings: inputs.codeSettings, log, env }),
        };
      },
    });
    const deployedCallerOf = deployedCallerFromMembership(membershipOf);
    const chatThreads = inputs.chatThreads;
    const coreTasks = coreTaskEntryFrom(routes, deployedCallerOf, chatThreads === undefined ? undefined : (deployed, input) => recordChatThread({ chatThreads, runtimeFor: (companyId) => app.runtimeFor(companyId), now: () => now().getTime() }, deployed, input),
      // L4-U5d: a later message in that thread is input for the task (one line here; the rule and the routing are core-host/chat-thread-input.ts).
      chatThreads === undefined ? undefined : (deployed, input) => addChatThreadInput({ chatThreads, runtimeFor: (companyId) => app.runtimeFor(companyId), now: () => now().getTime() }, deployed, input),
      // HW5b: a press of Approve, or the words for Request changes, on the plan card (one line here; the rule is core-host/chat-decision.ts and the approvers' `chat-<channel>` method).
      chatApproval === undefined || chatThreads?.personOf === undefined ? undefined : (deployed, press) => decideFromChat({
        chatThreads, proofKey: approvalProofKeyOf(inputs.callbackSigningKey), now: () => now().getTime(), log: (entry) => log({ ...entry, companyId: deployed.principal.companyId }),
        companyFor: async (companyId) => {
          const runtime = await app.runtimeFor(companyId);
          const registry = await app.registry();
          // The same gate as the web's decision cards (the company's approvers point, with the policy hook's wrapper); it is rebuilt per press, as the card routes' is per company.
          return { store: runtime.flow.deps.store, gate: hostedDecisionService({ deps: runtime.flow.deps, registry, companyId, now }).gate };
        },
      }, deployed, press));
    // Lane L12: the same routes and caller mapping on /v1/app/*, with the person erase (below) next to them.
    const coreApp = coreAppEntryFrom({ routes, personErase: { route: async (request, caller) => await personErase(request, caller) }, deployedCallerOf, log });
    // Lane LM8: the lessons API, where the lessons switch is on and the deployment gives its people. The company and role come from membership; a company's lessons are its own
    // runtime's (built once); the person's project role is the broker's own project grant (administrator: maintainer, developer: contributor).
    const lessonsPeopleOf = inputs.lessonsPeople;
    const lessonsPeople = lessonsPeopleOf === undefined ? undefined : (companyId: OrgId) => lessonsPeopleOf(companyId, { store: async () => (await app.registry()).require("storage") });
    let lessons: LessonsApi | undefined;
    let knowledge: KnowledgeApi | undefined;
    let adminNotice: BrokerCoreRoot["adminNotice"];
    if (lessonsSwitch.value.mode !== "off" && lessonsPeople !== undefined) {
      lessons = createLessonsApi({
        lessonsSwitch: lessonsSwitch.value,
        digestPilot: lessonsDigestPilot,
        companyOf: async (caller) => await membershipOf(caller.personId),
        lessonsOf: async (companyId) => {
          try { await app.runtimeFor(companyId); } catch { return undefined; }
          return lessonsByCompany.get(companyId);
        },
        people: {
          onProjectRoster: (companyId, project, personId) => lessonsPeople(companyId).onProjectRoster(companyId, project, personId),
          displayName: (companyId, personId) => lessonsPeople(companyId).displayName(companyId, personId),
          isErased: (companyId, personId) => lessonsPeople(companyId).isErased(companyId, personId),
        },
        projectRole: async (companyId, project, personId) => ((await membershipOf(personId))?.companyId !== companyId ? undefined : projectRoleOf(await projectGrantRole(personId, project, companyId))),
        wikiTaskUse: async (companyId, project, taskId) => {
          try {
            const registry = await app.registry();
            return await readWikiTaskUse({ store: registry.require("storage"), companyId, now: () => now().getTime() }, { project, taskId });
          } catch { return undefined; }
        },
        now: () => now().getTime(),
        log,
      });
      // L4-AK1H: the same company, people and lessons, for the reads a tool outside Rovara makes. A script token is checked against its own company's token store and identity (never the caller's word), and only for a company the
      // lessons switch covers; its creator is read live (a removed member, or one whose role changed, is nobody).
      const switchValue = lessonsSwitch.value;
      // Who is told about an unusual amount of reading: the company's owners and admins now (`adminNoticeIdsOf`; a list that cannot be completed tells nobody, the audit record still says it).
      const adminsOf = async (companyId: OrgId): Promise<string[]> => await adminNoticeIdsOf(lessonsPeople(companyId), (await app.registry()).require("identity"), companyId);
      // Delivery's own check, read now: a queued admin notice is told only to a person who is one of the company's admins at that moment (fail closed on any fault).
      adminNotice = async (orgId, developerId) => (await adminsOf(orgId)).includes(developerId);
      knowledge = createKnowledgeApi({
        lessonsSwitch: switchValue,
        companyOf: async (caller) => await membershipOf(caller.personId),
        lessonsOf: async (companyId) => {
          try { await app.runtimeFor(companyId); } catch { return undefined; }
          return lessonsByCompany.get(companyId);
        },
        people: {
          onProjectRoster: (companyId, project, personId) => lessonsPeople(companyId).onProjectRoster(companyId, project, personId),
          approvers: (companyId, project) => lessonsPeople(companyId).approvers(companyId, project),
          projectMembers: async (companyId, project) => (await lessonsPeople(companyId).projectMembers?.(companyId, project)) ?? { complete: true, ids: [] },
        },
        authenticateToken: scriptTokenAuthenticator({
          lessonsSwitch: switchValue, now: () => now().getTime(),
          // The token is checked against the SHARED registry's store (every key is company-scoped) BEFORE any company runtime is built: a made-up company id in an unverified header builds nothing.
          companyOf: async (tokenCompany) => { const registry = await app.registry(); return { store: registry.require("storage"), audit: registry.require("audit-sink"), identity: registry.require("identity"),
            // The creator's project, read live at every use of the token (this company's grant, or an owner's or admin's role): a project they lost stops working for the token.
            projectGrant: async (personId, project, role) => role === "owner" || role === "admin" || await projectGrant(personId, project, tokenCompany) }; },
        }),
        // Who is told about an unusual amount of reading: the company's owners now (the people port's ownerIds; company admins who are not owners are not told until the port lists them), by the id notices are addressed by. A list that cannot be completed tells nobody (the audit record still says it).
        adminsOf,
        now: () => now().getTime(),
        log,
      });
    }
    return { coreTasks, coreApp, lessons, knowledge, adminNotice };
  };
  const surfaces = settingsBlocked
    ? { coreTasks: buildBlockedCoreTasksEntry(membershipOf), coreApp: undefined, lessons: undefined, knowledge: undefined, adminNotice: undefined }
    : buildServingCoreSurfaces();
  let coreTasks: CoreTaskEntry | undefined = surfaces.coreTasks;
  const { coreApp, lessons, knowledge, adminNotice } = surfaces;

  // L2-4: the tracker intake, from each company's own runtime (only a company whose new tasks start on the core).
  const linearIntake = inputs.linearIntake;
  const intake = settingsBlocked || linearIntake === undefined ? undefined : createHostedIntake({
    connections: linearIntake.connections, fenceKey: intakeFenceKeyOf(inputs.callbackSigningKey), now: () => now().getTime(), log,
    companyFor: async (companyId) => {
      const runtime = await app.runtimeFor(companyId);
      const registry = await app.registry();
      const milestones = milestonesByCompany.get(companyId);
      return {
        store: registry.require("storage"), access: runtime.flow.deps.access, flow: runtime.flow, identity: registry.require("identity"), audit: registry.require("audit-sink"),
        ...(milestones === undefined ? {} : { milestones }),
      };
    },
  });

  const table = { documentClient: inputs.documentClient, tableName: inputs.stateTableName };
  let capabilities: CallbackCapabilities | undefined;
  /** The workspace of a GET /v1/internal/model-access whose capability verifies (signature, expiry, the `model-access` action); undefined for anything else. */
  const modelAccessWorkspaceOf = (request: BrokerRequest): string | undefined => {
    if (request.method !== "GET" || (request.path.split("?")[0] ?? "") !== MODEL_ACCESS_PATH) return undefined;
    const token = request.headers["x-agentx-callback-capability"];
    if (typeof token !== "string" || token === "" || token.length > 4096) return undefined;
    try {
      capabilities ??= new CallbackCapabilities(Buffer.from(inputs.callbackSigningKey));
      const workspaceId = capabilities.verify(token, "model-access").workspaceId;
      return typeof workspaceId === "string" && WORKSPACE_ID.test(workspaceId) ? workspaceId : undefined;
    } catch { return undefined; }
  };
  const designReviewPacketWorkspaceOf = (request: BrokerRequest): string | undefined => {
    if (request.method !== "GET" || request.path.split("?")[0] !== DESIGN_REVIEW_PACKET_PATH) return undefined;
    const token = request.headers["x-agentx-callback-capability"];
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) return undefined;
    try {
      capabilities ??= new CallbackCapabilities(Buffer.from(inputs.callbackSigningKey));
      const claims = capabilities.verify(token, "design-review-packet");
      if (!WORKSPACE_ID.test(claims.workspaceId) || !WORKSPACE_ID.test(claims.operationId) || !Number.isSafeInteger(claims.fence) || claims.fence < 1
        || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
      return claims.workspaceId;
    } catch { return undefined; }
  };
  const companyOfWorkspace = workspaceCompanyReader(inputs.documentClient, inputs.stateTableName);
  // S2: the install administrator's cancel of a core task's workspace, in the workspace's own company's runtime (its discovery pointer and scoped record name the company; a company the
  // core does not serve, or a workspace with no company, answers like a missing workspace).
  const wrapCoreTasksForServing = (entry: CoreTaskEntry): CoreTaskEntry => {
    const stopWorkspaceForAdmin: NonNullable<CoreTaskEntry["stopWorkspaceForAdmin"]> = async (workspaceId, administrator, authorize) => {
      const companyId = await companyOfWorkspace(workspaceId);
      if (companyId === undefined) throw agentXError("NOT_FOUND", WORKSPACE_NOT_FOUND);
      const flow: TaskFlowDeps = (await app.runtimeFor(companyId)).flow.deps;
      // Q2: the administrator's company is their live membership in the sign-in table (the reader every core caller is judged by); the core binds the grant to the task's company with it.
      return await stopWorkspaceAsAdministrator(flow, workspaceId, { id: administrator.id, companyOf: async () => (await membershipOf(administrator.id))?.companyId }, authorize);
    };
    const coreTasks = {
      route: accessRetryRoute(entry, { caller: deployedCallerFromMembership(membershipOf), flowFor: async (companyId) => (await app.runtimeFor(companyId)).flow.deps }),
      // L4-U5d: the chat thread's own methods are the entry's (this wrapper once dropped them, so a hosted start never remembered its thread and a later message had nowhere to go).
      ...(entry.recordThread === undefined ? {} : { recordThread: (caller: CoreEntryCaller, input: Parameters<NonNullable<CoreTaskEntry["recordThread"]>>[1]) => entry.recordThread!(caller, input) }),
      ...(entry.threadInput === undefined ? {} : { threadInput: (caller: CoreEntryCaller, input: Parameters<NonNullable<CoreTaskEntry["threadInput"]>>[1]) => entry.threadInput!(caller, input) }),
      // Cloud #188 item 5: the task list's money read for a core task (the caller's own, in their live company).
      ...(entry.taskMoney === undefined ? {} : { taskMoney: entry.taskMoney.bind(entry) }),
      // The same list's Understand round: whether the core's task read would show the caller the task.
      ...(entry.taskReadable === undefined ? {} : { taskReadable: entry.taskReadable.bind(entry) }),
      ...(entry.chatDecision === undefined ? {} : { chatDecision: (caller: CoreEntryCaller, press: Parameters<NonNullable<CoreTaskEntry["chatDecision"]>>[1]) => entry.chatDecision!(caller, press) }),
      // S1: the task action registry's two methods (a method left out here is dropped silently: tests/unit/task-actions-surfaces.test.ts fails when the three places disagree).
      ...taskActionMethodsOf(entry),
      stopWorkspaceForAdmin,
    };
    return coreTasks;
  };
  if (coreTasks !== undefined && !settingsBlocked) coreTasks = wrapCoreTasksForServing(coreTasks);
  const callbackHandlers = new Map<string, Promise<(request: BrokerRequest) => Promise<BrokerResponse>>>();
  const callbackHandlerFor = (companyId: OrgId): Promise<(request: BrokerRequest) => Promise<BrokerResponse>> => {
    let found = callbackHandlers.get(companyId);
    if (found === undefined) {
      found = (async () => {
        const runtime = await app.runtimeFor(companyId);
        const registry = await app.registry();
        const lessons = lessonsByCompany.get(companyId);
        const money = coreMoneyWiring(registry, companyId, now, admissionSettings, projectTaskCap);
        const wikiOnEvents = createWikiOnEvents({ store: registry.require("storage"), companyId, now: () => now().getTime() });
        // L2b: a worker's model-access request gets a task token for the gateway (its own operation, company, task and model only).
        const wiring = modelGateway();
        const gateway = wiring?.callbackGateway(createTaskTokenDescriber(runtime.flow.deps, createHostedReviewers({ flow: runtime.flow.deps, registry, companyId, offered: engineOffered, taskRoomUsd: (task) => reviewerRoomUsd({ store: registry.require("storage"), metering: registry.require("metering"), companyId, settings: admissionSettings, now, projectTaskCap }, task) }).grants));
        const saved = hostedSavedEnvDeps({ registry, flow: runtime.flow.deps, companyId, env, now: () => now().getTime() });
        const grants = new RepositoryGrantService(inputs.repositoryGrantKey, inputs.repositoryCredential);
        return createCallbackService({
          ...(saved === undefined || !saved.session.config.enabled ? {} : { savedEnv: { deps: saved, inspectGrant: (grant: string) => grants.inspect(grant), registryAuthSchema: HostedSavedEnvRegistryAuthSchema } }),
          ...(gateway === undefined ? {} : { modelGateway: { ...gateway, runPrice: async (model: string) => {
            const tokens = inputs.taskTokens?.();
            return tokens === undefined ? undefined : runPriceReader({ gatewayUrl: gateway.gatewayUrl, ...tokens, now: () => now().getTime() })(companyId, model);
          }, ...(quoteReader === undefined ? {} : { rateQuote: quoteReader }) } }),
          authorizeDesignReviewPacket: async (claims) => withinTaskTokenDeadline(async (deadline) => {
            const { task, operation, workspace } = await readTaskTokenRecords(runtime.flow.deps, claims, deadline);
            if ((workspace.orgId !== undefined && workspace.orgId !== companyId) || typeof task.developerId !== "string" || task.developerId === ""
              || !["ACCEPTED", "DISPATCHING", "RUNNING"].includes(operation.status)) throw agentXError("CALLBACK_FORBIDDEN", "this operation cannot read that packet");
            storedBindingOf(operation);
            if (!(await runtime.flow.deps.access.checkStep(task)).allowed) throw agentXError("CALLBACK_FORBIDDEN", "this operation cannot read that packet");
            deadline.check();
          }),
          flow: runtime.flow.deps,
          ...(runtime.flow.deps.applicationE2E === undefined ? {} : { e2e: { records: runtime.flow.deps.applicationE2E.rounds.records } }),
          blobs: registry.require("object-storage"),
          // The grants the dispatcher issued for this company's workers (the same key derivation), exchanged here for a credential.
          grants: new RepositoryGrantService(inputs.repositoryGrantKey, inputs.repositoryCredential),
          // A step's events go to the lessons (when the company has them) and to the wiki's report filing (lead 4 A1: "Wiki pages this task read"); each is information only and never throws.
          onEvents: async (operation, events) => { await Promise.all([lessons?.host.onEvents(operation, events), wikiOnEvents(operation, events)]); },
          bookUsage: money.bookUsage,
          // DEC 253c/253j(1): the trusted eval plan, approval and baseline cache for this company's CHECKS runs, with the approver's live role from the hosted members reader.
          // L4-EVS2: and the environment the sealed eval runs in, for this company's project only: its saved image (a cloud registry's login only; none without an image registry that can serve a pull), else its approved
          // install steps, else none.
          evalPlan: coreEvalPlanSources(registry, companyId, { membershipOf, projectGrantRole }, log, createEvalEnvironmentSource({
            store: registry.require("storage"), companyId, now: () => now().getTime(), env, repositoryPaths: repositoryPathsOf(runtime.flow.deps.projects),
            savedEnv: () => evalSavedEnvDepsOf({ store: registry.require("storage"), registry: () => registry.require("image-registry"), envName: env["AGENTX_ENV"] ?? "", now: () => now().getTime(), env, hosted: true }),
            log: (event) => { log({ event: `core_engine.${event}` }); },
          }), env),
          // L4-EVH: the opt-in eval health run's own preparation asks for its plan and posts its one result here (only where a run can really happen).
          ...(evalHealthRunsAvailable({ registry, modelGatewayConfigured: wiring !== undefined }) ? { evalHealth: evalHealthRunDeps({ registry, environment: env, companyId, now: () => now().getTime(), members: deployedSessionMembers(companyId, { membershipOf, projectGrantRole }), modelGatewayConfigured: true }) } : {}),
          // Guided onboarding L2-3: a hosted setup run's callback (its journal, website asks, polls and eval report). No person types a command into a hosted run (the command route is
          // the laptop page's only), so nothing is ever handed over.
          // L4-E7: and the stand-in writer's sample data goes to this install's object storage (the broker's own bucket access; keys are `private/<company>/standins/<project>/<digest>`).
          setupAgent: { mayStillRun: async () => false, standInObjects: fixtureObjectPortOf(registry.require("object-storage")) },
          // Lead 4 W4: a hosted wiki build's callback: the requester's live standing, the project's own code host read for the citation re-read, and THIS company's wiki store as the page sink.
          wikiBuild: wikiBuildCallbackWiring({
            store: registry.require("storage"), companyId, now: () => now().getTime(),
            // L4-P2: a nightly refresh has no person: each page asks whether system runs are still on for the company (ceiling AND consent) and the project's upkeep is still ON, and ends `access_lost` when not; a pause
            // by the gateway tells the project's admins once (company-bound hooks, recipients read live).
            upkeepOn: hostedUpkeepOn({ gate: upkeepPartsFor(registry, companyId).gate, store: registry.require("storage"), companyId }),
            onUpkeepPaused: (scope, reason) => upkeepPartsFor(registry, companyId).pauses.onRunPaused({ orgId: scope.orgId, project: scope.project }, reason),
            standing: async (personId, project) => {
              const standing = await setupRunStanding(personId, companyId, project);
              return standing?.access === "manage" ? { access: "manage" } : standing?.access === "view" ? { access: "view" } : { access: "none" };
            },
            readFor: (project) => projectCitationReader({
              projects: runtime.flow.deps.projects,
              fileAt: (repository, path, commit, read) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }).fileAtRevision({ url: repository.url }, path, commit, { orgId: companyId }, read),
            }, project),
          }),
        });
      })();
      found.catch(() => callbackHandlers.delete(companyId));
      callbackHandlers.set(companyId, found);
    }
    return found;
  };

  // Person erase: the engine's erase with the deployed learning step (lessons and Team record), the evidence bucket's version delete, and the company's audit sink.
  const eraseDepsOver = (registry: AdapterRegistry, companyId: string): PersonEraseDeps => {
    const store = registry.require("storage");
    const audit = registry.require("audit-sink");
    const objects = registry.require("object-storage") as unknown as Partial<PersonEraseObjects>;
    if (typeof objects.deleteEveryVersion !== "function") throw new Error("the object storage cannot delete every version");
    void companyId;
    return { store, audit, objects: objects as PersonEraseObjects, eraseLearning: hostedEraseLearning({ store, audit, now: () => now().getTime(), log }), eraseWiki: hostedEraseWiki({ store, now: () => now().getTime() }), now: () => now().getTime(), log };
  };
  const resumeErases = async (companyId: string, budgetMs: number): Promise<{ finished: number; owed: number }> => {
    const registry = await app.registry();
    return await resumePersonErases(eraseDepsOver(registry, companyId), companyId, budgetMs);
  };
  const standingOf = personStandingFromDynamo(inputs.documentClient, inputs.signInTableName);

  async function personErase(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined> {
    if (!(request.path.split("?")[0] ?? "").startsWith("/v1/app/people/")) return undefined;
    const registry = await app.registry();
    return await createPersonEraseRoute({
      log, standing: standingOf,
      companyOf: async (who) => await membershipOf(who.principal.personId),
      eraseDeps: (companyId) => eraseDepsOver(registry, companyId),
    }).route(request, caller);
  }

  const buildSwitchApis = () => (settingsBlocked ? {} : {
    // The person's own switch: company from live membership, rows in the company's partition of the registry's store. Only where the core serves (no company's data is read otherwise).
    lessonsSlackSwitch: createLessonsSlackSwitchApi({
      companyOf: async (caller) => await membershipOf(caller.personId),
      store: async () => (await app.registry()).require("storage"),
      now: () => now().getTime(),
    }),
    // L4-JA7: the two "knowledge stays in Rovara" switches (company; project). The rows are the ones the knowledge reads and the wiki tools gate read (`DocumentLocalToolsSettings` over the registry's storage); the company comes only from
    // live membership, the project's role from the broker's own grant (administrator: maintainer), and the project must be in that company's own catalog. It does not need the lessons switch.
    knowledgeSwitch: createKnowledgeSwitchApi({
      companyOf: async (caller) => await membershipOf(caller.personId),
      store: async () => (await app.registry()).require("storage"),
      audit: async () => (await app.registry()).require("audit-sink"),
      projectExists: async (companyId, project) => (await (await app.runtimeFor(companyId)).flow.deps.projects.latest(project)) !== undefined,
      projectRole: async (companyId, project, personId) => ((await membershipOf(personId))?.companyId !== companyId ? undefined : projectRoleOf(await projectGrantRole(personId, project))),
      now: () => now().getTime(),
      log,
    }),
  });

  const dispatchCoreWorkspaceCallback = async (request: BrokerRequest, workspaceId: string): Promise<BrokerResponse> => {
    if (settingsBlocked) return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
    // A core workspace is never the old routes' (engine-boundary.ts): any refusal here is the core's, in fixed words.
    const companyId = await companyOfWorkspace(workspaceId);
    if (companyId === undefined) return callbackAnswer(404, "NOT_FOUND", "workspace not found");
    let handler: (request: BrokerRequest) => Promise<BrokerResponse>;
    try {
      handler = await callbackHandlerFor(companyId);
    } catch (error) {
      log({ event: "core_engine.callback_unavailable", error: error instanceof Error ? error.name : "unknown" });
      return callbackAnswer(503, "RUNTIME_UNAVAILABLE", "The core engine is not available on this install just now; try again shortly.");
    }
    return await handler(request);
  };

  return {
    app,
    coreTasks,
    coreApp,
    lessons,
    knowledge,
    adminNotice,
    ...buildSwitchApis(),
    intake,
    ...(coreApp === undefined ? {} : { projectArchiveTakesEffect: () => true }),
    ...buildPolicyHookAccessor(hookSettings, hookProblem, inputs.policyHookInstall),
    async personErase(request, caller) {
      if (settingsBlocked && (request.path.split("?")[0] ?? "").startsWith("/v1/app/people/")) return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      return await personErase(request, caller);
    },
    async resumePersonErases(companyId, budgetMs) {
      if (settingsBlocked) throw new Error(CORE_SETTINGS_REFUSAL_WORDS);
      return await resumeErases(companyId, budgetMs);
    },
    async callback(request) {
      if (coreTasks === undefined) return undefined;
      // L5: settings that cannot be read refuse the core's context tools too.
      if (settingsBlocked && coreContextWorkerRouteOf(request.method, request.path.split("?")[0] ?? "") !== undefined) return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      const context = await handleCoreContextTools(request, {
        capabilities: { verify: (token, action) => new CallbackCapabilities(Buffer.from(inputs.callbackSigningKey)).verify(token, action) },
        isCoreWorkspace: (workspaceId) => isCoreWorkspace(table, workspaceId),
        companyOfWorkspace,
        runtimeFor: async (companyId) => ({ flow: (await app.runtimeFor(companyId)).flow.deps, teamSearch: teamRecords.get(companyId)?.search }),
      });
      if (context !== undefined) return context;
      // L2b: a worker's model-access request names its workspace only inside its signed capability (checked here before any read; the handler checks it again).
      const packetRequest = request.path.split("?")[0] === DESIGN_REVIEW_PACKET_PATH;
      const packetWorkspace = designReviewPacketWorkspaceOf(request);
      if (packetRequest && packetWorkspace === undefined) return callbackAnswer(403, "CALLBACK_FORBIDDEN", "this operation cannot read that packet");
      const workspaceId = packetWorkspace ?? modelAccessWorkspaceOf(request) ?? CORE_CALLBACK.exec(request.path.split("?")[0] ?? "")?.[1];
      if (workspaceId === undefined) return undefined;
      if (!await isCoreWorkspace(table, workspaceId)) return packetRequest ? callbackAnswer(403, "CALLBACK_FORBIDDEN", "this operation cannot read that packet") : undefined;
      return await dispatchCoreWorkspaceCallback(request, workspaceId);
    },
    async handleEvent(event, options) {
      if (settingsBlocked && (isCoreJobEvent(event) || outboxCompaniesOf(event) !== undefined)) throw new Error(CORE_SETTINGS_REFUSAL_WORDS);
      if (isCoreJobEvent(event)) return await withSharedMergeRecovery(() => app.handleScheduledJob(event, options));
      return await relayCoreOutboxStream(event, (companies) => app.relayOutbox(companies));
    },
  };
}

/**
 * The developer API's configuration with the core's entries (lane E2 step 6, lane L12): where a core is wired, the task routes' core entry and the /v1/app/* routes; without one (neither is
 * built), the configuration exactly as given, so the developer API is byte-identical.
 */
export function withCoreRoutes<T extends object>(config: T, root: Pick<BrokerCoreRoot, "coreTasks" | "coreApp" | "policyHook" | "projectArchiveTakesEffect"> & { intake?: HostedIntake | undefined }): T | (T & { coreTasks: CoreTaskEntry; coreApp?: CoreAppEntry; projectArchiveTakesEffect?: (companyId: string) => boolean; coreIntake?: HostedIntake }) {
  if (root.coreTasks === undefined) return config;
  return {
    ...config, ...(root.policyHook === undefined ? {} : { policyHook: root.policyHook }), coreTasks: root.coreTasks, ...(root.coreApp === undefined ? {} : { coreApp: root.coreApp }),
    ...(root.projectArchiveTakesEffect === undefined ? {} : { projectArchiveTakesEffect: root.projectArchiveTakesEffect }),
    ...(root.intake === undefined ? {} : { coreIntake: root.intake }),
  };
}

/** The path of a worker's model-access request (core/model-gateway/route.ts), for the broker's routing. */
export const CORE_MODEL_ACCESS_PATH = MODEL_ACCESS_PATH;

/** L1a's queue piece, called by L6 only when composing a serving broker's complete dependencies. Makes no client or queue. */
export function brokerCoreDispatchQueue(env: NodeJS.ProcessEnv): CodeModuleDeps["queue"] {
  const url = env[CORE_DISPATCH_QUEUE_URL_VARIABLE];
  const deadLetterUrl = env[CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE];
  // Same URL shape and queue-kind rule as the SQS adapter; validate here before a registry can be built, with fixed refusal words.
  const queueUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/[^\s/]+\/(?:[^\s/]+\/)*[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/u.test(value);
  if (!queueUrl(url) || !queueUrl(deadLetterUrl) || url.endsWith(".fifo") !== deadLetterUrl.endsWith(".fifo")) {
    throw Object.assign(new Error("the broker needs valid core dispatch queue URLs"), { name: "BrokerCoreQueueNotConfigured" });
  }
  // L4-SQS (journey audit B3c): the lessons reflection queue, declared wherever the install gives its URLs (a named environment derives both from AGENTX_ENV; the legacy install gives neither, and
  // the queue stays undeclared as before). One without the other, or a URL that is not a queue of the same kind, is a refusal by the same words.
  const reflectUrl = env[CORE_LESSONS_REFLECT_QUEUE_URL_VARIABLE];
  const reflectDeadLetterUrl = env[CORE_LESSONS_REFLECT_DEAD_LETTER_URL_VARIABLE];
  const reflectGiven = reflectUrl !== undefined || reflectDeadLetterUrl !== undefined;
  if (reflectGiven && (!queueUrl(reflectUrl) || !queueUrl(reflectDeadLetterUrl) || reflectUrl.endsWith(".fifo") !== reflectDeadLetterUrl.endsWith(".fifo"))) {
    throw Object.assign(new Error("the broker needs valid core dispatch queue URLs"), { name: "BrokerCoreQueueNotConfigured" });
  }
  return {
    settings: {
      ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
      queues: { [CORE_DISPATCH_QUEUE]: { url, deadLetterUrl }, ...(reflectGiven ? { [LESSONS_REFLECT_QUEUE]: { url: reflectUrl as string, deadLetterUrl: reflectDeadLetterUrl as string } } : {}) },
    },
  };
}

export { taskTokensFromEnvironment };

/** What the broker's own adapter inputs still lack (each is an infrastructure or adapter lane), so the registry refuses by these words. Fixed. */
export const BROKER_CORE_NOT_CONFIGURED = "the broker cannot build the core engine's adapters yet";
/** Each input the broker still owes, in fixed words (the refusal names those not yet given). */
export const BROKER_CORE_OWED = {
  queue: "the core dispatch queue's URLs in its environment",
  codeHost: "a code host provider for the core (the GitHub App behind the scoped provider interface)",
  workerMachines: "its side of the workers' operations",
} as const;

/** The broker's own parts of Code's AWS adapter inputs, each from its switch-on lane. */
export interface BrokerCoreModuleParts {
  /** Lane L1b: the company-scoped GitHub App code host and check runner (aws/core-code-host.ts, `brokerCoreCodeHost`). Built only when every other input is there. */
  codeHost?: () => Pick<CodeModuleDeps, "codeHost" | "checkRunner">;
  workerMachines?: () => NonNullable<CodeModuleDeps["workerMachines"]>;
  dynamo?: CodeModuleDeps["dynamo"];
  objects?: CodeModuleDeps["objects"];
  secrets?: CodeModuleDeps["secrets"];
}

/**
 * Code's AWS adapter inputs on the broker. While any input is still owed (see BROKER_CORE_OWED) it refuses, naming those, so a serving switch never builds a half-wired registry here. The
 * dispatcher's inputs live in aws/worker-machines/dispatcher-core.ts. L6 composes the queue (L1a), code host (L1b), and unchanged worker-machines builder output (L1c) here.
 */
export function brokerCoreModuleDeps(env: NodeJS.ProcessEnv, parts: BrokerCoreModuleParts = {}): CodeModuleDeps {
  const owed: string[] = [];
  if (parts.codeHost === undefined) owed.push(BROKER_CORE_OWED.codeHost);
  if (parts.workerMachines === undefined) owed.push(BROKER_CORE_OWED.workerMachines);
  if (owed.length > 0) throw Object.assign(new Error(`${BROKER_CORE_NOT_CONFIGURED}: it needs ${owed.join(", ")}`), { name: "BrokerCoreNotConfigured" });
  const queue = brokerCoreDispatchQueue(env);
  const tableName = env.STATE_TABLE_NAME;
  const bucket = env.ARTIFACT_BUCKET_NAME;
  if (!tableName || !bucket || parts.objects === undefined || parts.secrets === undefined) throw new Error(BROKER_CORE_NOT_CONFIGURED);
  return {
    tableName, queue, ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
    ...(parts.dynamo === undefined ? {} : { dynamo: parts.dynamo }),
    objects: parts.objects, secrets: parts.secrets,
    ...parts.codeHost!(), workerMachines: parts.workerMachines!(),
  };
}
