import { prepareTaskPeopleStart } from "../developer/task-people-start.js";
import { companyMembershipFromDynamo } from "./company-check.js";
import type { TaskPeopleDependencies } from "../developer/task-people.js";
import { serverReadContext, type AbortableReadSender, type ServerKeyRead } from "./server-read-context.js";
import { taskStartRequestRoute } from "./task-start-request-routes.js";
import { connectionImpactRoute } from "./connection-impact.js";
import { taskOwnerView } from "../developer/task-owner-view.js";
import { slackRecordScope } from "./slack-workspace-tokens.js";
import { listSlackWorkspaceScopes, SlackWorkspaceRefused, type SlackWorkspaceBindings } from "./slack-workspace-binding.js";
import { SlackWorkspaceScopeSchema, type SlackWorkspaceScope } from "@agentx/contracts";
import { CompanySelfServeNameSchema, COMPANY_INVITE_CODE_MAX, COMPANY_SELF_CREATE_TEXT, CompanyInviteCodeHashSchema, CompanyInviteCodeIdSchema, CompanyInviteListSchema, CompanySelfCreateBodySchema, companyInviteCodeHash, newCompanyInviteLink, type CompanyInviteList, type CompanyPreapprovalCreated, type CompanySelfCreateResponse } from "@agentx/contracts";
import { projectSettingsComplianceRoute, projectSettingsRoute, type ProjectSettingsHook } from "./project-settings.js";
import { Membership, membershipKey, boundedCompanyReads, companyReadActions, ownPartitionRow, recordInCompany, resolveCompany, strictLiveMembership, type CompanyMembershipReader } from "./company-check.js";
import { grantsPkFor, namedCompany, namedCompanyLatestRevisionRow, namedCompanyProjectArchived } from "./company-layout.js";
import { isProjectUnreadable, logProjectLeftOut } from "../core/project-left-out.js";
import { slackChannelBindingPkFor } from "./slack-company-layout.js";
 import { putCodeSettings, readCodeSettings } from "./project-code-settings.js"; import { putEvalNone, putSkip, readProjectSetupStatus } from "./project-setup-status.js"; import { LIFECYCLE_NOT_FOUND, routeProjectLifecycle, type LifecycleAction } from "./project-lifecycle-routes.js";
// Spec 025 FR-009, FR-013, FR-014 and FR-016: GET projects, and the project access check the task
// routes use. /v1/dev/* has no API Gateway authorizer (D17): the broker verifies the developer
// access token itself, then checks the environment, the method and the sign-in session on every
// request (R12, R13), so a revoked session stops at once.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { grantProjectAccess, listProjectMembers, projectGrant, projectMemberKey, resolveDeveloper, revokeProjectAccess } from "./admin-actions.js";
import { appRouteOf, devRouteOf, type DevRoute } from "./dev-route-scopes.js";
import { isGithubConnectPath, routeGithubConnect, type GithubConnectWiring } from "./github-connect-routes.js";
import { isGithubLinkPath, routeGithubLink, type GithubLinkWiring } from "./github-account-link-routes.js";
import { isLinearAccountLinkPath, routeLinearAccountLink, type LinearLinkWiring } from "./linear-account-link-routes.js";
import { isLinearConnectPath, routeLinearConnect, type LinearConnectWiring } from "./linear-connect-routes.js";
import type { HostedIntake } from "./hosted-intake.js";
import { LESSONS_OFF, type LessonsApi } from "../core-host/lessons-api.js"; import { knowledgeSwitchedOff, type KnowledgeApi } from "../core-host/knowledge-api.js"; import { isScriptTokenHeader } from "../core/script-tokens/token-format.js";
import type { LessonsRepeatsApi } from "../core-host/lessons-repeats-api.js";
import type { LessonsSlackSwitchApi } from "../core-host/lessons-slack-switch-api.js";
import type { KnowledgeSwitchApi } from "../core-host/knowledge-switch-api.js";
import { isCompanyMemberPath, routeCompanyMembers, type CompanyMemberActions, type CompanyMemberRouteContext } from "./company-member-routes.js";
import { isSlackInstallPath, routeSlackInstall, type SlackInstallWiring } from "./slack-company-install.js";
import { isSlackChannelLinkPath, routeSlackChannelLink, type SlackChannelWiring } from "./slack-channel-link.js";
import { isCompanyEngineModelPath, routeCompanyEngineModel, type CompanyEngineModelWiring } from "./company-engine-model-routes.js"; import { isCompanyLearningModelPath, routeCompanyLearningModel, type CompanyLearningModelWiring } from "./company-learning-model-routes.js"; import { isCompanyEgressPath, routeCompanyEgress, type CompanyEgressWiring } from "./company-egress-routes.js";
import {
  AgentXNameSchema, AgentXError,
  IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, type OrgRole,
  scopesOf,
  AGENTX_CLI_CLIENT_ID,
  CLIENT_SCOPES,
  CreateClientProjectRequestSchema,
  CreateClientProjectsRequestSchema,
  BulkCreateClientProjectsRequestSchema,
  RepositoryChoicesQuerySchema,
  type CreateClientProjectsRequest,
  type BulkCreateClientProjectsRequest,
  type BulkCreateClientProjectsResponse,
  type ClientRepositoryChoicesResponse,
  type CreateClientProjectRequest,
  type ClientRepositoriesResponse,
  type ClientProjectMemberChangeResponse,
  type ClientProjectMembersResponse,
  type ClientProjectResponse,
  type ClientScope,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  DEVELOPER_TOKEN_AUDIENCE,
  DEVELOPER_WORKSPACES_PER_PROJECT,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  agentXError,
  developerTaskPolicy,
  workspaceProjectIndexValue,
  workspaceRecordFields,
  type OrgId,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperSignInMethod,
  type DeveloperTaskPolicy,
  type DeveloperWorkspace,
  type DeveloperWorkspacesResponse,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  SetMyNameBodySchema,
  type SetDisplayNameRequest,
  type SetDisplayNameResponse,
  type SetMyNameResponse,
  type SlackAuthCheckResponse,
  type SlackChannelBinding,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
  SLACK_CHANNEL, channelBindingPartition, channelBindingSortPrefix,
  ActorRefSchema, COMPANY_AUDIT_RECORDS_PATH, COMPANY_EVENTS_PATH,
  AccessCheckRequestSchema,
  AccessCheckResponseSchema,
  SignInClientIdSchema,
  SignInClientRecordSchema,
  signInClientKey,
  type AccessCheckResponse,
  type SignInClientRecord,
} from "@agentx/contracts";
import { createChannelLinkWeb } from "./channel-link-web.js";
import { listDeveloperLinks, previewLinkCode, redeemLinkCode, removeLink, type ChannelLinkDependencies } from "./channel-links.js";
import { accessDeniedMessage, resolveDeveloperAccess } from "../developer/access.js";
import { routeCompanyReads, type CompanyReadsConfiguration } from "../developer/company-reads.js";
import { evaluateProjectAuthority, mayUseProject } from "../developer/task-project-access.js";
import { renameTaskOwner } from "../developer/task-owner-name.js";
import { taskCompanyId, isHostedTaskProvider, checkTaskPersonIdentity, listTaskWebCandidates, registerTaskChannelPeople, registerTaskWebPerson, resolveTaskPickerPersonWithId, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../developer/task-person-identity.js";
import { taskPeopleDisplayAdmission, type TaskPeopleDisplayAdmission } from "../developer/task-people-display-budget.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeJwt } from "jose";
import { applyAccessRules, type AccessCheckContext, type AccessCheckRule } from "../developer/access-rules.js";
import { CompanyIssuerRecord, companyIssuerKey } from "../developer/company-issuer.js";
import { CompanyRecord, companyKey } from "../developer/company-membership.js";
import { INSTALL_COMPANY_PROJECTS_MAX, InstallCompanyRefused, installCompanyCatalog, installCompanyGrants, installCompanyLatestDefinition, installCompanyOf, installUsesCompanyLayout, mergeSurvivor } from "./install-company.js";
import { installCompanyBindings } from "./slack-install-company.js";
import { slackWorkspaceHint } from "../developer/providers.js";
import { META, developerRecordKeyedBy, endedByAdmin, methodSince, startedBeforeMethodOn, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js"; import type { ClientProjectNaming } from "./company-project-names.js";
import { MACHINE_SIZE_ROWS, MACHINE_STORED_ONLY_LINE } from "@agentx/contracts";
import { machineSizeEnabled, machineCard, setMachineChoice } from "../core/test-env/machine-size.js";
import { testEnvironmentView } from "../core/test-env/local-view.js";
import { DynamoDocumentStore } from "@rovara/aws-adapters";
import { confirmTaskPeopleProposal, getTaskPeopleProposal, getTaskPeopleProposalMetadata, routeDeveloperTaskRequest, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";




import { coreAnswerValue, isCoreTaskThatExists, type CoreTaskEntry } from "./engine-boundary.js";
import type { CoreAppEntry } from "./core-app-routes.js";
import type { BrokerResponse } from "../handler.js"; import { profileDisplayName } from "../developer/github-profile.js";
import type { CompanyImportRegistry } from "./company-import-forwarding.js"; import { routeSignInLinks, type SignInLinkForward } from "./sign-in-link-routes.js";
import {
  createChannelByNameForwarder,
  createChannelInfoForwarder,
  createChannelMembersForwarder,
  createDeveloperKeysForwarder,
  createEndDeveloperSessionsForwarder,
  createSetDisplayNameForwarder,
  createSignInClientsForwarder,
  createSlackAuthCheckForwarder,
  createSlackUserByEmailForwarder,
  createTaskChannelPeopleForwarder,
  createTaskPeopleDisplayReadForwarder,
  createTaskPersonProofForwarder,
  invokeIdentityLambda,
  SLACK_UNAVAILABLE,
  type ChannelMembersInvokeResult,
  type SignInClientRegistry,
} from "./slack-identity-lambda.js";
import { PEOPLE_CONFIRM_PAGE } from "./people-confirm-web.js";
import { PEOPLE_CONFIRM_API } from "./people-confirm-web.js";
import { createPeopleConfirmWeb } from "./people-confirm-web.js";
export type { ChannelMembersInvokeResult, SignInClientRegistry };

export interface DeveloperApiConfiguration {
  /** Host-owned company rules configuration; absence preserves today's policy. */
  policyHook?: ProjectSettingsHook;
  /** `github` (DEC 254h): GitHub sign-in is on; only ever with Code's company layer. Absent: off. */
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean; github?: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: Partial<Record<DeveloperSignInMethod, number>>;
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** Lane E2: the core's own handlers for a task stamped `core` (engine-boundary.ts), as the deployment composes them. Absent: a core task reads exactly like a missing one. */
  coreTasks?: CoreTaskEntry;
  /** Lane L12: the core's own /v1/app/* routes (aws/core-app-routes.ts), set only where a core is wired. Absent: every /v1/app/* path answers "route not found", reading nothing. */
  coreApp?: CoreAppEntry;
  /** Guided onboarding PR 16: whether archiving this company's project takes effect (its new tasks start on the core engine, which reads the archived state). Absent: an archive is refused. */
  projectArchiveTakesEffect?: (companyId: string) => boolean;
  /** C0: optional until the compatible identity function is deployed; callers must fail closed when absent. */
  taskPersonProof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>;
  taskChannelPeople?: (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse>;
  /** E: one request-scoped, metered proof/list transport. Absence makes the complete People view unavailable. */
  taskPeopleDisplayRead?: (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse>;
  /** D: exact opt-in for role changes; an existing PEOPLE sidecar remains enforced while false. */
  taskPeopleConfiguration?: { peopleChangesEnabled: boolean };
  /** Spec 059: absent is the safe default; production factories intentionally leave graph starts disabled. */
  workflowDependenciesEnabled?: boolean;
  /** C: optional distinct claim-bound invitation endpoint; production leaves it absent until separately configured. */
  inviteTaskPerson?: DeveloperTaskRouteDependencies["inviteTaskPerson"];
  /** R10: bound channels' names and privacy, read by DeveloperIdentity. Optional: without it channels are listed by ID. */
  channelInfo?: (request: ChannelInfoRequest) => Promise<ChannelInfoResponse>;
  /** How long one request waits for channel names in all; the rest stay unnamed. Default 5 seconds. */
  channelInfoDeadlineMs?: number;
  /** Spec 025 A12: FR-012's email lookup, for an admin's Slack link. */
  slackUserByEmail?: (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse>;
  /** Spec 025 A13: the health route's Slack token check. */
  slackAuthCheck?: (workspace?: SlackWorkspaceScope) => Promise<SlackAuthCheckResponse>;
  /** Spec 025 E9: an admin ends a developer's sign-in sessions, through DeveloperIdentity (the broker only reads the sign-in table). */
  endDeveloperSessions?: (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse>;
  /** #634: a person sets their own name, through DeveloperIdentity (the broker only reads the sign-in table). */
  setDisplayName?: (request: SetDisplayNameRequest) => Promise<SetDisplayNameResponse>; /** DEC 254w: connected sign-ins, through DeveloperIdentity. Absent: those routes answer not set up. */ signInLinks?: SignInLinkForward;
  /** Spec 063: the sign-in clients' registry, which the sign-in Lambda owns. */
  signInClients?: SignInClientRegistry;
  companies?: CompanyMembershipReader;
  /** False: refused or unreachable. A pre-approval's answer carries its expiry (epoch seconds), which is its invite link's (DEC 254h). */
  companyPreapprovals?: (request: CompanyPreapprovalRequest) => Promise<false | { expiresAt?: number }>;
  /** DEC 253z: `POST /v1/dev/company`'s forward to the sign-in Lambda (companySelfCreateThroughLambda). Absent: that route is unknown. */
  companySelfCreate?: (request: CompanySelfCreateRequest) => Promise<CompanySelfCreateAnswer>;
  /** DEC 254a: the install's invite codes and self-serve switch, through the sign-in Lambda (companyInvitesThroughLambda), for an install administrator's changes and list. */
  companyInvites?: CompanyInviteRegistry;
  /** DEC 254b (b): an install administrator's import of the install's old company layout, and its undo, through the sign-in Lambda (companyImportThroughLambda). With the company layer on or off. */
  companyImport?: CompanyImportRegistry;
  /** Lane W part 4: T3b's member helper (companyMemberActionsThroughLambda), the only way the admin routes list, remove or change a member. Absent: those routes are unknown. */
  companyMembers?: CompanyMemberActions;
  /** Guided onboarding PR 1: the GitHub connect routes (github-connect-routes.ts). Absent (or no company layer): those routes are unknown. */
  githubConnect?: GithubConnectWiring;
  /** L4-GH: a person links their own GitHub account (github-account-link-routes.ts). Absent (or no company layer): those routes are unknown. */
  githubLink?: GithubLinkWiring;
  /** Guided onboarding PR 4: Add to Slack (slack-company-install.ts). Absent (or no company layer): those routes are unknown. */
  slackInstall?: SlackInstallWiring;
  /** Guided onboarding PR 5: a project's Slack channel (slack-channel-link.ts). Absent (or no company layer): those routes are unknown. */
  slackChannels?: SlackChannelWiring;
  /** Guided onboarding PR 7: the Linear connect routes (linear-connect-routes.ts). Absent (or no company layer): those routes are unknown. */
  linearConnect?: LinearConnectWiring;
  /** R1 + L1: a member links their own Linear account, and the company's admin lists and removes links (linear-account-link-routes.ts). Absent (or no company layer): those routes are unknown. */
  linearLink?: LinearLinkWiring;
  /** L2-4: the company's hosted intake (the first team pick seeds the ticket updates); its waiting-ticket routes are the core's (core-host/intake-routes.ts). Set only where a core is wired and Linear is wired. */
  coreIntake?: HostedIntake;
  /** Guided onboarding PR 14 (DEC 254n item 1): the company engine model route (company-engine-model-routes.ts). Absent (no model gateway, or no company layer): the route is unknown. */
  companyEngineModel?: CompanyEngineModelWiring; companyLearningModel?: CompanyLearningModelWiring; companyEgress?: CompanyEgressWiring; // L4-EGR (company-egress-routes.ts): Rovara's outbound addresses; absent (or no company layer): the route is unknown. Kept on this line so the forwarding sites below do not move.
  /*
   * DEC 254zzz81: spec 065's `clientRoutes` switch was here. It is gone: the `/v1/dev/client/*` routes are always on, and each one checks the client's token, its route scope and the
   * person's live company and role (routeClientRequest). Five lines, as the switch's were, so the line-keyed company inventory sites below do not move.
   */

  /** Spec 025 E12: a public channel by its name, through DeveloperIdentity. */
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined, audience?: string, read?: ServerKeyRead): Promise<Record<string, unknown>>;
  /**
   * Owner decision 132: a host's stricter rules on the access check (spec 063 FR-004), such as a fresh sign-in or an approval it keeps. They can only refuse
   * or narrow Rovara's own answer (`developer/access-rules.ts`); none means Rovara's answer as is.
   */
  accessRules?: readonly AccessCheckRule[];
  /** Spec 061 slice 2: the Slack service's request queue, set only with SLACK_REQUEST_QUEUE_URL; "Ask AgentX to reply to this comment" needs it. */
  slackRequestQueue?: SlackRequestQueue;
}
export interface DeveloperRouteDependencies {
  serverReadSender?: AbortableReadSender;
  serverReadBudget?: ReturnType<typeof boundedCompanyReads>;
  workspaces?: Pick<SlackWorkspaceBindings, "requireCompany"> & { getProject?(name: string, companyId?: string): Promise<unknown> };
  workspace?: SlackWorkspaceScope;
  channelLinkCodes?: { preview(personId: string, code: string): Promise<{ channel: string; maskedUserId: string } | undefined>; redeem(personId: string, code: string): ReturnType<typeof redeemLinkCode> };
  policyHook?: ProjectSettingsHook;
  companies?: CompanyMembershipReader;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  developer: DeveloperApiConfiguration;
  now: () => number;
  /** The developer task routes' broker actions; without them /v1/dev/tasks* answers NOT_FOUND. */
  tasks?: DeveloperTaskActions;
  /** Lane LM8: the Code lessons API (`core-host/lessons-api.ts`), behind the lessons switch. Absent (the default, until the deployment wires it): every lessons route answers "Lessons are off." and reads nothing. */
  lessons?: Pick<LessonsApi, "answer">; /** L4-AK1H: the hosted team knowledge reads for tools outside Rovara (`core-host/knowledge-api.ts`), behind the same lessons switch. Absent: a person gets the fixed "off" answer, a script token is refused, and nothing is read. */ knowledge?: Pick<KnowledgeApi, "answer">;
  /** The Home number "Corrections you had to repeat" (`core-host/lessons-repeats-api.ts`), behind the same switch. Absent: its routes answer "Lessons are off." and read nothing. */
  lessonRepeats?: Pick<LessonsRepeatsApi, "answer">;
  /** L4-SRC-SL: the person's own "Don't learn from my Slack messages" switch (`core-host/lessons-slack-switch-api.ts`). It does not depend on the lessons switch. Absent: its route is not found. */
  lessonsSlackSwitch?: Pick<LessonsSlackSwitchApi, "answer">;
  /** L4-JA7: the company's "Knowledge stays in Rovara" and a project's "local coding tools can fetch lessons" (`core-host/knowledge-switch-api.ts`). It does not depend on the lessons switch. Absent: its routes are not found. */
  knowledgeSwitch?: Pick<KnowledgeSwitchApi, "answer">;
  /** Spec 065b: a project from one GitHub repository, as a sign-in client's signed-in Rovara administrator. */
  createClientProject?: (developerId: string, input: CreateClientProjectRequest, naming?: ClientProjectNaming) => Promise<{ name: string; latestRevision: number; companyId?: string }>;
  /** Spec 065b: the repositories the GitHub App can reach, to choose one for a new project. */
  clientRepositories?: (developerId?: string) => Promise<ClientRepositoriesResponse["installations"]>;
  /** Guided onboarding PR 6: one project from several repositories (all on the caller's company's installations, or nothing is created). */
  createClientProjects?: (developerId: string, input: CreateClientProjectsRequest, naming?: ClientProjectNaming) => Promise<{ name: string; latestRevision: number; companyId?: string }>;
  /** Guided onboarding PR 6: one project per repository, with one result row each. */
  createClientProjectsBulk?: (developerId: string, input: BulkCreateClientProjectsRequest, naming?: ClientProjectNaming) => Promise<BulkCreateClientProjectsResponse>;
  /** Guided onboarding PR 6: the repository picker: the company's connected repositories, each marked with the company's projects that hold it. */
  clientRepositoryChoices?: (developerId: string, query: { q?: string | undefined; limit?: number | undefined; after?: string | undefined }) => Promise<ClientRepositoryChoicesResponse>;
  /** Reconciles all already-linked PRs using GitHub's current API state before owner decisions. */
  refreshTaskFeedback?(taskId: string): Promise<void>;
  /** Builds E2E projections only from the task's current server-owned admission and evidence references. */
  workflowE2EPresentation?: DeveloperTaskRouteDependencies["workflowE2EPresentation"];
  workflowE2EPublicationChecks?: DeveloperTaskRouteDependencies["workflowE2EPublicationChecks"];
  workflowE2EScenarioResults?: DeveloperTaskRouteDependencies["workflowE2EScenarioResults"];
  workflowE2EArtifact?: DeveloperTaskRouteDependencies["workflowE2EArtifact"];
  startWorkflowE2EBaseline?: DeveloperTaskRouteDependencies["startWorkflowE2EBaseline"];
  /** Checks a plan's application E2E intent when the owner approves it. */
  validateWorkflowE2EApplicationPlan?: DeveloperTaskRouteDependencies["validateWorkflowE2EApplicationPlan"];
  registeredRepositoryIdentity?: DeveloperTaskRouteDependencies["registeredRepositoryIdentity"];
  /** Sign in with ChatGPT (#338): each developer's connection; without it /v1/dev/chatgpt/* answers NOT_FOUND. */
  chatgpt?: ChatGptConnections;
  /** Spec 062: channel account links; without them /review/link/* and /v1/dev/channel-links answer NOT_FOUND. */
  channelLinks?: ChannelLinkDependencies;
  /** Lanes AU and EV: the company audit and event reads for a company administrator; without them those two routes answer NOT_FOUND. */
  companyReads?: CompanyReadsConfiguration;
}
/** `clientId`: the registered sign-in client whose token made the call (plan v3.2 lane ID); absent for the Rovara CLI. */
export interface DeveloperCaller {
  developerId: string; sessionId: string; amr: DeveloperSignInMethod; name: string; slackUserId?: string; email?: string; clientId?: string;
  /** DEC 236h: set only for the Rovara web app's own sign-in client (registered with full access AND marked `webApp` by the operator), from its registration; never for the Rovara CLI's token, a scoped client's, or another full-access client's. */
  webApp?: true;
}

/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
function logDeveloperEvent(entry: Record<string, string | number>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return createChannelMembersForwarder(invoke, logDeveloperEvent);
}
/** C0: one fresh proof through DeveloperIdentity. Any old or malformed reply fails closed. */
export function taskPersonProofThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return createTaskPersonProofForwarder(invoke, logDeveloperEvent);
}
/** E: complete fresh channel identities through DeveloperIdentity. Partial or malformed replies fail closed. */
export function taskChannelPeopleThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return createTaskChannelPeopleForwarder(invoke, logDeveloperEvent);
}
/** E: strict metered display transport. Any missing or malformed usage seals the caller's admission. */
export function taskPeopleDisplayReadThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return createTaskPeopleDisplayReadForwarder(invoke, logDeveloperEvent);
}
/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return createChannelInfoForwarder(invoke, logDeveloperEvent);
}
/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return createSlackUserByEmailForwarder(invoke, logDeveloperEvent);
}
/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (workspace?: SlackWorkspaceScope) => Promise<SlackAuthCheckResponse> {
  return createSlackAuthCheckForwarder(invoke, logDeveloperEvent);
}
/** E9: ends a developer's sessions through DeveloperIdentity. */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return createEndDeveloperSessionsForwarder(invoke, logDeveloperEvent);
}
/** #634: a person's chosen name, through DeveloperIdentity. */
export function setDisplayNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SetDisplayNameRequest) => Promise<SetDisplayNameResponse> {
  return createSetDisplayNameForwarder(invoke, logDeveloperEvent);
}

/**
 * #634 (ported from an earlier private release): `PUT /v1/dev/me/name`, the signed-in person sets their own name. The person is the
 * verified caller, never anything the body carries; the body is the name alone (`SetMyNameBodySchema`). A sign-in then leaves the name alone.
 */
async function setMyName(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<SetMyNameResponse> {
  const body = SetMyNameBodySchema.safeParse(jsonBody(request));
  if (!body.success) throw agentXError("CONFIG_INVALID", `name: ${body.error.issues[0]?.message ?? "give a name of 1 to 80 characters"}`);
  const set = deps.developer.setDisplayName;
  if (set === undefined) throw agentXError("NOT_FOUND", "choosing your own name is not set up in this deployment");
  const answer = await set({ kind: "set-display-name", developerId: caller.developerId, name: body.data.name });
  if (answer.ok) {
    // This path has no company in scope (the caller is a person), so it uses the file's one company-less logger, already in the inventory, rather than a new console call.
    logDeveloperEvent({ event: "developer.display_name_chosen", developerId: caller.developerId });
    // #661: the person's tasks take the new name. Best effort: the name is already theirs, so a failure here is logged, not answered.
    try {
      const renamed = await renameTaskOwner(deps.documentClient, deps.tableName, caller.developerId, answer.name);
      logDeveloperEvent({ event: "developer.tasks_renamed", developerId: caller.developerId, ...renamed });
    } catch (error) {
      logDeveloperEvent({ event: "developer.tasks_rename_failed", developerId: caller.developerId, error: errorName(error) });
    }
    return { name: answer.name, nameChosen: true };
  }
  if (answer.error === "not_found") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (answer.error === "invalid_request") throw agentXError("CONFIG_INVALID", "name: give a name of 1 to 80 characters, with no email address");
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
}

/** Spec 063: the sign-in clients' registry, through the sign-in Lambda that owns it. Throws when it cannot be reached. */
// Only these two company-admin operations can be built by broker code.
// DEC 254h: a pre-approval always carries the SHA-256 of the invite link secret the route made for it; the secret never leaves the broker.
type CompanyPreapprovalRequest =
  | { kind: "company-preapprove"; companyId: string; email: string; role: "member"; expiresInHours: number; createdBy: string; inviteHash: string }
  | { kind: "company-preapproval-resend"; companyId: string; emailHash: string; expiresInHours: number; createdBy: string; inviteHash: string }
  | { kind: "company-preapproval-withdraw"; companyId: string; emailHash: string; createdBy: string };
const CompanyPreapprovalInvoke = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-preapprove"), companyId: OrgIdSchema, email: z.string().trim().min(3).max(320).email(), role: z.literal("member"), expiresInHours: z.number().int().min(1).max(720), createdBy: z.string().regex(/^[a-f0-9]{64}$/), inviteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("company-preapproval-resend"), companyId: OrgIdSchema, emailHash: z.string().regex(/^[a-f0-9]{64}$/), expiresInHours: z.number().int().min(1).max(720), createdBy: z.string().regex(/^[a-f0-9]{64}$/), inviteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("company-preapproval-withdraw"), companyId: OrgIdSchema, emailHash: z.string().regex(/^[a-f0-9]{64}$/), createdBy: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const PreapprovalExpiry = z.number().int().positive();
export function companyPreapprovalsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: CompanyPreapprovalRequest) => Promise<false | { expiresAt?: number }> {
  return async (request) => {
    const parsed = CompanyPreapprovalInvoke.safeParse(request);
    if (!parsed.success) return false;
    const answer = await invokeIdentityLambda(invoke, parsed.data, (reply) => reply.ok !== true ? (reply.ok === false ? false : undefined)
      : reply.expiresAt === undefined ? {} : PreapprovalExpiry.safeParse(reply.expiresAt).success ? { expiresAt: reply.expiresAt as number } : undefined, "developer.company_preapproval", logDeveloperEvent);
    return typeof answer === "object" && answer !== null && !("ok" in answer) ? answer : false;
  };
}

/** DEC 253z: the only self-serve event broker code builds. The person is the verified caller; the code travels only as its hash. */
type CompanySelfCreateRequest = { kind: "company-self-create"; personId: string; name: string; codeHash: string };
export type CompanySelfCreateAnswer = { ok: true; companyId: string; companyName: string } | { ok: false; error: "refused" | "already_member" | "rate_limited" | "unavailable" };
const CompanySelfCreateInvoke = z.object({ kind: z.literal("company-self-create"), personId: z.string().regex(/^[a-f0-9]{64}$/), name: CompanySelfServeNameSchema, codeHash: CompanyInviteCodeHashSchema }).strict();
const CompanySelfCreateReply = z.union([
  z.object({ ok: z.literal(true), companyId: OrgIdSchema, companyName: z.string().min(1).max(80) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["refused", "already_member", "rate_limited", "unavailable"]) }).strict(),
]);
export function companySelfCreateThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: CompanySelfCreateRequest) => Promise<CompanySelfCreateAnswer> {
  return async (request) => {
    const parsed = CompanySelfCreateInvoke.safeParse(request);
    if (!parsed.success) return { ok: false, error: "unavailable" };
    const answer = await invokeIdentityLambda(invoke, parsed.data, (reply) => { const read = CompanySelfCreateReply.safeParse(reply); return read.success ? read.data : undefined; }, "developer.company_self_create", logDeveloperEvent);
    const read = CompanySelfCreateReply.safeParse(answer);
    return read.success ? read.data : { ok: false, error: "unavailable" };
  };
}

/** DEC 254a: what an install administrator's changes and list ask of the sign-in Lambda, which owns the codes. */
type CompanyInviteRequest =
  | { kind: "company-invite-create"; codeHash: string; expiresInHours: number; createdBy: string }
  | { kind: "company-invite-list" }
  | { kind: "company-invite-revoke"; codeId: string; createdBy: string }
  | { kind: "company-self-serve-set"; open: boolean; createdBy: string };
export interface CompanyInviteRegistry {
  create(codeHash: string, expiresInHours: number, createdBy: string): Promise<string>;
  list(): Promise<CompanyInviteList>;
  /** False: no live code has that id. */
  revoke(codeId: string, createdBy: string): Promise<boolean>;
  setSelfServe(open: boolean, createdBy: string): Promise<void>;
}
const Person = z.string().regex(/^[a-f0-9]{64}$/);
const CompanyInviteInvoke = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-invite-create"), codeHash: CompanyInviteCodeHashSchema, expiresInHours: z.number().int().min(1).max(720), createdBy: Person }).strict(),
  z.object({ kind: z.literal("company-invite-list") }).strict(),
  z.object({ kind: z.literal("company-invite-revoke"), codeId: CompanyInviteCodeIdSchema, createdBy: Person }).strict(),
  z.object({ kind: z.literal("company-self-serve-set"), open: z.boolean(), createdBy: Person }).strict(),
]);
export function companyInvitesThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): CompanyInviteRegistry {
  const unreachable = () => agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
  const ask = async <T>(request: CompanyInviteRequest, read: (reply: Record<string, unknown>) => T | undefined, notFound?: T): Promise<T> => {
    const parsed = CompanyInviteInvoke.safeParse(request);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "that invite code change is not one AgentX can make");
    const answer = await invokeIdentityLambda(invoke, parsed.data, (reply) => reply.ok === true ? read(reply) : reply.ok === false && reply.error === "not_found" && notFound !== undefined ? notFound : undefined, "developer.company_invites", logDeveloperEvent);
    if (typeof answer === "object" && answer !== null && "ok" in answer && (answer as { ok: unknown }).ok === false) throw unreachable();
    return answer as T;
  };
  return {
    create: (codeHash, expiresInHours, createdBy) => ask({ kind: "company-invite-create", codeHash, expiresInHours, createdBy }, (reply) => CompanyInviteCodeIdSchema.safeParse(reply.codeId).success ? reply.codeId as string : undefined),
    list: () => ask({ kind: "company-invite-list" }, (reply) => {
      const { ok: _ok, ...rest } = reply; void _ok;
      const parsed = CompanyInviteListSchema.safeParse(rest);
      return parsed.success ? parsed.data : undefined;
    }),
    revoke: (codeId, createdBy) => ask<boolean>({ kind: "company-invite-revoke", codeId, createdBy }, () => true, false),
    setSelfServe: async (open, createdBy) => { await ask({ kind: "company-self-serve-set", open, createdBy }, () => true); },
  };
}

export function signInClientsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): SignInClientRegistry {
  return createSignInClientsForwarder(invoke, logDeveloperEvent);
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return createChannelByNameForwarder(invoke, logDeveloperEvent);
}

/** The broker's copy of each method's enabled-since cutoff (FR-045), from its environment. */
export function developerSinceFromEnvironment(env: NodeJS.ProcessEnv): { slack?: number; oidc?: number; github?: number } {
  const slack = methodSince(env.DEVELOPER_SIGNIN_SLACK_SINCE);
  const oidc = methodSince(env.DEVELOPER_OIDC_SINCE);
  const github = methodSince(env.DEVELOPER_GITHUB_SINCE);
  return { ...(slack === undefined ? {} : { slack }), ...(oidc === undefined ? {} : { oidc }), ...(github === undefined ? {} : { github }) };
}
/** DEC 254h: GitHub sign-in counts as on only with Code's company layer on as well (the sign-in server never offers it otherwise). */
export const githubSignInFromEnvironment = (env: NodeJS.ProcessEnv): boolean => env.DEVELOPER_SIGNIN_GITHUB === "enabled" && env.COMPANY_SIGNIN === "enabled";
const methodName = (amr: DeveloperSignInMethod) => (amr === "slack" ? "Slack" : amr === "github" ? "GitHub" : "Company");

/** The sign-in server's public keys, read by invoking DeveloperIdentity's JWKS route (D17). */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array, options?: { abortSignal: AbortSignal }) => Promise<ChannelMembersInvokeResult>): (read?: ServerKeyRead) => Promise<unknown[]> {
  return createDeveloperKeysForwarder(invoke, logDeveloperEvent);
}

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): { developerId: string; sessionId: string; amr: DeveloperSignInMethod } {
  if (claims === undefined || claims.iss !== config.issuer || claims.aud !== DEVELOPER_TOKEN_AUDIENCE || claims.env !== config.env) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc" && amr !== "github") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (config.methods[amr] !== true) {
    throw agentXError("AUTH_REQUIRED", `${methodName(amr)} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  return { developerId: claims.sub, sessionId: claims.sid, amr };
}

async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

/** The stored sign-in identity must still seat the person this session was issued to. */
async function requireSessionSurvivor(deps: DeveloperRouteDependencies, session: SessionRecord, refused: () => Error): Promise<void> {
  if (session.signedInId === undefined) return;
  try {
    const walk = await mergeSurvivor((id) => getSignIn(deps, `DEVELOPER#${id}`), session.signedInId);
    if (walk.survivorId !== session.developerId) throw refused();
  } catch { throw refused(); }
}

/** Reuse consistent sign-in identity reads within one verifier/request, never across requests. */
function withSignInReads(deps: DeveloperRouteDependencies): DeveloperRouteDependencies {
  const client = deps.documentClient;
  const signInTable = deps.developer.signInTableName;
  const people = new Map<string, Promise<unknown>>();
  return { ...deps, documentClient: { send(command: unknown): Promise<unknown> {
    if (!(command instanceof GetCommand) || command.input.TableName !== signInTable || command.input.ConsistentRead !== true
      || command.input.Key?.sk !== META || typeof command.input.Key.pk !== "string" || !command.input.Key.pk.startsWith("DEVELOPER#")) return client.send(command);
    const id = command.input.Key.pk;
    const prior = people.get(id);
    if (prior !== undefined) return prior;
    const read = client.send(command);
    people.set(id, read);
    return read;
  } } };
}

function usesCompanySignIn(session: SessionRecord): boolean {
  return session.amr === "oidc" || session.amr === "github" || (session.amr === "slack" && session.installMethod !== undefined);
}

async function sessionCompanyId(deps: DeveloperRouteDependencies, session: SessionRecord, scope: ReturnType<typeof boundedCompanyReads>, resolvedCompany?: string): Promise<string | undefined> {
  return resolvedCompany ?? await (deps.serverReadBudget === undefined ? scope.read(() => resolveCompany(deps.companies, session.developerId)) : resolveCompany(deps.companies, session.developerId));
}

/** Company policy is selected only from live membership and the stored session (OIDC, and since DEC 254e Slack too).
 * Fixed-size reads share one budget and the host's existing SDK timeout; no cache or token company.
 * Undefined: the session is held to the install's own method (the built-in company, a shared-method session of a company with no issuer, or a
 * Slack session of a company whose install workspace is bound to it). */
async function companyOidcSession(deps: DeveloperRouteDependencies, session: SessionRecord, resolvedCompany?: string): Promise<DeveloperRecord | undefined> {
  // DEC 254e: a Slack session is checked here when it carries the shared-method mark (the sign-in server rechecks every Slack session at refresh,
  // as before); an OIDC session always.
  // DEC 254h/254n: a GitHub session always, marked or not, as OIDC (an unmarked one is held to the built-in company; GitHub is only the shared method).
  if (deps.companies === undefined || !usesCompanySignIn(session)) return undefined;
  try {
    const scope = deps.serverReadBudget ?? boundedCompanyReads(deps.documentClient, deps.now);
    const companyId = await sessionCompanyId(deps, session, scope, resolvedCompany);
    if ((session.companyId ?? IMPLICIT_COMPANY_ID) !== companyId) throw new Error("session company");
    if (companyId === IMPLICIT_COMPANY_ID) {
      if (session.installMethod !== undefined) throw new Error("session method");
      return undefined;
    }
    const parsed = z.object({
      sessionId: z.string().uuid(), developerId: z.string().regex(/^[a-f0-9]{64}$/), amr: z.enum(["oidc", "slack", "github"]),
      companyId: OrgIdSchema, startedAt: z.iso.datetime(), endsAt: z.number().finite(),
      reviewExpiresAt: z.number().finite().optional(), installMethod: z.literal(true).optional(),
    }).safeParse(deps.serverReadBudget === undefined ? await scope.read(async () => session) : session);
    if (!parsed.success) throw new Error("session record");
    const key = companyIssuerKey(companyId);
    const response = await scope.client.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    // DEC 254b (a): a company with no issuer row signs in only through the install's own OIDC (the shared method), and only a session the sign-in
    // server marked so; the install's switch and since time then hold, as for the built-in company. A company with any issuer row never takes it.
    if (response.Item === undefined) {
      if (parsed.data.installMethod !== true || deps.developer.methods[parsed.data.amr] !== true) throw new Error("shared method");
      scope.check();
      return undefined;
    }
    if (parsed.data.installMethod !== undefined) throw new Error("shared method");
    const issuer = CompanyIssuerRecord.extend({ pk: z.literal(key.pk), sk: z.literal("OIDC") }).safeParse(response.Item);
    if (!issuer.success || !issuer.data.enabled || (issuer.data.requiredValues.length > 0 && issuer.data.requiredClaim === undefined)
      || startedBeforeMethodOn(session.startedAt, Math.max(issuer.data.enabledSince, issuer.data.since ?? 0))) throw new Error("issuer policy");
    const developer = await getSignIn<DeveloperRecord>({ ...deps, documentClient: scope.client }, `DEVELOPER#${session.developerId}`);
    if (developer === undefined || developer.provider !== "oidc"
      || developer.issuer !== issuer.data.issuer.replace(/\/+$/, "") || developer.revoked !== false) throw new Error("issuer identity");
    scope.check();
    return developer;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  // Delay only OIDC's install-wide switch until the authenticated session can select its policy.
  const config = deps.companies === undefined ? deps.developer : { ...deps.developer, methods: { ...deps.developer.methods, oidc: true } };
  const token = developerClaims(claims, config);
  try {
    return await authenticateSession(deps, token, undefined, true);
  }
  catch (error) {
    if (deps.companies !== undefined && token.amr === "oidc" && !(error instanceof AgentXError)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    throw error;
  }
}

async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod }, storedSession?: SessionRecord, checkInstallEnabled = false): Promise<DeveloperCaller> {
  deps = withSignInReads(deps);
  const session = storedSession ?? await getSignIn<SessionRecord>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  // Spec 063 FR-003: a registered client's session never acts on Rovara, whatever token names it.
  if (session.clientId !== undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // Only the server-side signed-in identity may keep the person this session was issued to.
  await requireSessionSurvivor(deps, session, () => agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN));
  const companyDeveloper = await companyOidcSession(deps, session);
  if (checkInstallEnabled && deps.companies !== undefined && token.amr === "oidc" && companyDeveloper === undefined && !deps.developer.methods.oidc) {
    throw agentXError("AUTH_REQUIRED", "Company sign-in is turned off in this environment; sign in another way with agentx login <url>");
  }
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (companyDeveloper === undefined && startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : token.amr === "github" ? "GitHub" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  const developer = companyDeveloper ?? await getSignIn<Pick<DeveloperRecord, "displayName" | "provider" | "subject" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt">>(deps, `DEVELOPER#${token.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
  return {
    ...token,
    name: profileDisplayName(developer) ?? developer.displayName, // DEC 254p (a): a GitHub name is clean text (github-profile.ts); anyone else's is as stored
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

/** Rechecks an opaque browser-cookie session against DeveloperIdentity on every page/API request. */
export async function authenticateDeveloperSessionId(deps: DeveloperRouteDependencies, sessionId: string): Promise<DeveloperCaller> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  try {
    const session = await getSignIn<SessionRecord>(deps, `SESSION#${sessionId}`);
    if (session === undefined || (session.amr !== "slack" && session.amr !== "oidc")
      || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= Math.floor(deps.now() / 1000)) {
      throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    }
    return await authenticateSession(deps, { developerId: session.developerId, sessionId, amr: session.amr }, session);
  } catch (error) {
    if (deps.companies !== undefined && !(error instanceof AgentXError)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    throw error;
  }
}

/** C4: the most grant rows one person's web proof reads (one row per project they hold). More than this is unreadable, so a refusal. */
export const WEB_PROOF_GRANT_ROWS_MAX = 500;

/** Every item under `pk` with the sort key prefix, following LastEvaluatedKey through each page. */
async function queryAll<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string, maxItems?: number): Promise<T[]> {
  const items: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ConsistentRead: true,
    })) as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    if (maxItems !== undefined && items.length > maxItems) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    start = response.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** Channel names are for display only: they never hold the projects list near a timeout. */
const CHANNEL_NAMES_DEADLINE_MS = 5_000;
const REVISION_READS_AT_ONCE = 8;

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The latest revision's number and task policy: the only fields read, so only they are fetched. */
async function latestDefinition(deps: DeveloperRouteDependencies, project: string, companyId?: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  // DEC 254zzz80: a named company's projects live only in its own partition.
  const named = namedCompany(companyId);
  if (named !== undefined) return namedCompanyDefinition(deps, named, project);
  // T4a's project provider owns company identity; the legacy policy projection may be unstamped.
  let storageCompanyId = companyId;
  if (companyId !== undefined && deps.workspaces?.getProject !== undefined) {
    try {
      if (!recordInCompany(await deps.workspaces.getProject(project), companyId)) return undefined;
      storageCompanyId = undefined;
    } catch { throw new SlackWorkspaceRefused(); }
  }
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":prefix": "REV#" },
    ProjectionExpression: "#definition.#revision, #definition.#developerTasks" + (storageCompanyId === undefined ? "" : ", #companyId"),
    ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks", ...(storageCompanyId === undefined ? {} : { "#companyId": "companyId" }) },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  const row = response.Items?.[0];
  return recordInCompany(row, storageCompanyId) ? row?.definition : undefined;
}

/**
 * DEC 254zzz80: a named company's project's latest revision (the core's order, company-layout.ts) and its task policy. An archived project (its META row) stays listed but takes no
 * new work, as the core engine refuses it: its policy is a stored null, which developerTaskPolicy reads as tasks and channel access off (fail closed).
 */
async function namedCompanyDefinition(deps: DeveloperRouteDependencies, company: OrgId, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const [row, archived] = await Promise.all([
    // This feeds LISTS of projects (`projectsWithPolicy`): one project whose current revision cannot be read (arch rule 9 refuses it wherever that project itself is read) is left out, never read from an older revision, and never fails the whole list.
    namedCompanyLatestRevisionRow(deps.documentClient, deps.tableName, company, project).catch((error: unknown) => { if (!isProjectUnreadable(error)) throw error; logProjectLeftOut(company, project); return undefined; }),
    namedCompanyProjectArchived(deps.documentClient, deps.tableName, company, project),
  ]);
  if (row === undefined) return undefined;
  const definition = row.definition as { revision: number; developerTasks?: unknown };
  return { revision: definition.revision, developerTasks: archived ? null : definition.developerTasks };
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, names: readonly string[], companyId?: string): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const unique = [...new Set(names)].sort();
  const definitions = await mapLimit(unique, REVISION_READS_AT_ONCE, (name) => latestDefinition(deps, name, companyId));
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  unique.forEach((name, index) => {
    const definition = definitions[index];
    // developerTaskPolicy fails closed: a policy that no longer parses turns tasks and channel access off.
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  });
  return found;
}

function companySlackMode(deps: DeveloperRouteDependencies): boolean {
  return deps.workspaces !== undefined || deps.companies !== undefined || deps.developer.companies !== undefined;
}

/** The channel-members check, failing closed (and logged by error name) when it throws. */
function safeChannelMembers(deps: DeveloperRouteDependencies): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return async (request) => {
    try {
      // Without the workspace service only the install's own team is ever asked about (bindingsOf gives it to the implicit company alone), as before company mode.
      if (companySlackMode(deps) && deps.workspaces !== undefined) {
        const scope = SlackWorkspaceScopeSchema.safeParse(request.workspace);
        if (!scope.success || deps.workspaces === undefined || await deps.workspaces.requireCompany(scope.data.teamId) !== scope.data.companyId) return SLACK_UNAVAILABLE;
      }
      return await deps.developer.channelMembers(request);
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
      return SLACK_UNAVAILABLE;
    }
  };
}

/**
 * Channel names and privacy, best effort: without them the channels are listed by ID (R10).
 * Privacy comes from DeveloperIdentity's 10-minute cache. The whole lookup has one deadline.
 */
async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[], workspace?: SlackWorkspaceScope): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  if (companySlackMode(deps) && (workspace === undefined || deps.workspaces === undefined || await deps.workspaces.requireCompany(workspace.teamId) !== workspace.companyId)) throw new SlackWorkspaceRefused();
  const channelInfo = deps.developer.channelInfo;
  if (channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deps.developer.channelInfoDeadlineMs ?? CHANNEL_NAMES_DEADLINE_MS);
  });
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      let answer: ChannelInfoResponse | "deadline";
      try {
        answer = await Promise.race([channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS), ...(workspace === undefined ? {} : { workspace }) }), expired]);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
        return workspace === undefined ? names : new Map();
      }
      if (answer === "deadline") {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "deadline" });
        return workspace === undefined ? names : new Map();
      }
      if (!answer.ok) return workspace === undefined ? names : new Map();
      for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/** A private channel is flagged by ID only: its name never leaves the control plane (R10). */
const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

/**
 * FR-013.1: `developer` and `administrator` rows are grants. A developer ID is built like an admin
 * owner key, so an admin's `administrator` rows sit under the same key when both sign in through one
 * IdP, and that person may use the projects they administer (#630).
 */
async function grantsOf(deps: DeveloperRouteDependencies, caller: ProjectAccessSubject, companyId?: string): Promise<string[]> {
  return (await grantRowsOf(deps, caller.developerId, companyId))
    .filter((membership) => mayUseProject(membership.role))
    .map((membership) => membership.projectName);
}

/**
 * DEC 254zzz80: a person's grant rows for the company named by their LIVE membership. A named company's are read from its own partition only (`ORG#<company>#MEMBER#<person>`,
 * company-layout.ts), and a row there whose keys disagree with its project name, or that names another company, is never this company's grant. The built-in company and no
 * company read the legacy rows exactly as before.
 */
async function grantRowsOf<T extends { pk?: unknown; sk?: unknown; projectName: string; role?: string }>(deps: DeveloperRouteDependencies, personId: string, companyId: string | undefined, maxItems?: number): Promise<T[]> {
  const pk = grantsPkFor(companyId, personId);
  const rows = await queryAll<T>(deps, pk, "PROJECT#", maxItems);
  const company = namedCompany(companyId);
  if (company === undefined) return rows;
  return rows.filter((row) => row.pk === pk && typeof row.projectName === "string" && row.sk === `PROJECT#${row.projectName}` && ownPartitionRow(row as Record<string, unknown>, company));
}

/** DEC 254zzz80: the NAMED company of a person's LIVE membership (where their grants live), read now; undefined: no company layer, or the built-in company (the legacy keys). */
async function liveNamedCompany(deps: DeveloperRouteDependencies, personId: string): Promise<string | undefined> {
  const reader = deps.companies ?? deps.developer.companies;
  return reader === undefined ? undefined : namedCompany(await resolveCompany(reader, personId));
}

async function bindingsOf(deps: DeveloperRouteDependencies, workspace?: SlackWorkspaceScope, companyId?: string): Promise<SlackChannelBinding[]> {
  // The install's own Slack team (the deployment's SlackTeamId) belongs to the implicit company until the workspace backfill binds it: the implicit company keeps
  // seeing its channel projects exactly as before company mode (the company-check goldens), and no other company ever does.
  const legacyTeam = deps.developer.slackTeamId;
  if (deps.workspaces === undefined) {
    const legacyApplies = legacyTeam !== undefined && (!companySlackMode(deps) || (workspace === undefined && companyId === IMPLICIT_COMPANY_ID));
    return legacyApplies ? queryAll<SlackChannelBinding>(deps, channelBindingPartition(SLACK_CHANNEL, legacyTeam), channelBindingSortPrefix(SLACK_CHANNEL)) : [];
  }
  if (workspace === undefined && companyId === undefined) throw new SlackWorkspaceRefused();
  const budget = boundedCompanyReads(deps.documentClient, deps.now);
  const scopes = workspace === undefined ? await listSlackWorkspaceScopes({ client: budget.client, tableName: deps.tableName }, companyId!) : [workspace];
  if (workspace === undefined && companyId === IMPLICIT_COMPANY_ID && legacyTeam !== undefined && !scopes.some((scope) => scope.teamId === legacyTeam)) {
    let legacyCompany: string | undefined;
    try { legacyCompany = await deps.workspaces.requireCompany(legacyTeam); } catch { legacyCompany = undefined; }
    if (legacyCompany === IMPLICIT_COMPANY_ID) scopes.push({ companyId: IMPLICIT_COMPANY_ID, teamId: legacyTeam });
  }
  const bindings: SlackChannelBinding[] = [];
  for (const scope of scopes) {
    if (!SlackWorkspaceScopeSchema.safeParse(scope).success || await deps.workspaces.requireCompany(scope.teamId) !== scope.companyId) throw new SlackWorkspaceRefused();
    // DEC 254zzz98 (review M1): a NAMED company's channel bindings live only in its own partition (`ORG#<company>#SLACK_BINDING#<team>`, slackChannelBindingPkFor), as the Slack
    // ingress, the dispatcher and the channel-link writer read and write them; a legacy row on its team is never this company's. A row there naming another company is dropped.
    // The built-in company keeps the legacy partition, byte for byte.
    const named = namedCompany(scope.companyId);
    const rows = await queryAll<SlackChannelBinding>({ ...deps, documentClient: budget.client }, slackChannelBindingPkFor(scope.companyId, scope.teamId), channelBindingSortPrefix(SLACK_CHANNEL));
    if (rows.some((row) => row.teamId !== scope.teamId)) throw new SlackWorkspaceRefused();
    bindings.push(...(named === undefined ? rows : rows.filter((row) => ownPartitionRow(row as unknown as Record<string, unknown>, named))));
  }
  return bindings;
}

async function callerWorkspace(deps: DeveloperRouteDependencies, caller: ProjectAccessSubject, record: unknown, teamId: unknown): Promise<SlackWorkspaceScope | undefined> {
  if (!companySlackMode(deps)) return undefined;
  try {
    // Without the workspace service only the install's own team exists, and it is the implicit company's: the legacy path answers (no scope), any other team or company is refused.
    if (deps.workspaces === undefined) {
      if (teamId === deps.developer.slackTeamId && await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) === IMPLICIT_COMPANY_ID) return undefined;
      throw new SlackWorkspaceRefused();
    }
    const scope = slackRecordScope(record, teamId);
    const company = await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId);
    if (company !== scope.companyId || await deps.workspaces.requireCompany(scope.teamId) !== company) throw new SlackWorkspaceRefused();
    return scope;
  } catch { throw new SlackWorkspaceRefused(); }
}

/** One answer for every refusal at the access check, so it tells a caller nothing about why. */
const ACCESS_REFUSED = "this access check needs a signed-in person's token for this service, or a confidential service's own credentials";

/** A registered sign-in client, read from the sign-in table; undefined for an unknown ID or an unreadable row. */
async function signInClientOf(deps: DeveloperRouteDependencies, clientId: unknown): Promise<SignInClientRecord | undefined> {
  if (!SignInClientIdSchema.safeParse(clientId).success) return undefined;
  let response: { Item?: Record<string, unknown> };
  try { response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: signInClientKey(clientId as string), ConsistentRead: true })) as typeof response; }
  catch (error) { if (deps.companies !== undefined) return undefined; throw error; }
  if (response.Item === undefined) return undefined;
  if (deps.companies !== undefined && (response.Item.entityType !== "SIGN_IN_CLIENT" || response.Item.sk !== `CLIENT#${String(clientId)}` || response.Item.pk !== "SIGNIN_CLIENTS")) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = response.Item;
  const parsed = SignInClientRecordSchema.safeParse(rest);
  return parsed.success && (deps.companies === undefined || parsed.data.clientId === clientId) ? parsed.data : undefined;
}

/** Every access refusal has the same bytes, including unreadable membership. */
async function clientCompany(deps: DeveloperRouteDependencies, client: SignInClientRecord, personId: string): Promise<string | undefined> {
  if (deps.companies === undefined) return undefined;
  try {
    const companyId = await resolveCompany(deps.companies, personId);
    if (client.installLevel !== true && (client.companyId ?? IMPLICIT_COMPANY_ID) !== companyId) throw new Error("client unavailable");
    return companyId;
  } catch { throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED); }
}

/** RFC 6749 2.3.1 HTTP Basic client credentials, or undefined. */
function basicClientCredentials(authorization: string | undefined): { clientId: string; secret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec((authorization ?? "").trim());
  if (match === null) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return undefined;
  try {
    const formDecode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
    return { clientId: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

function clientSecretMatches(secret: string, secretHash: string | undefined): boolean {
  if (secretHash === undefined || secret === "") return false;
  const given = createHash("sha256").update(secret).digest();
  const kept = Buffer.from(secretHash, "hex");
  return kept.length === given.length && timingSafeEqual(given, kept);
}

/**
 * Spec 063 FR-004: who a registered service's signed-in person is, and what they can use now. Asked with the person's
 * own token for that service (Bearer), or by developer ID with a confidential service's credentials (HTTP Basic). It
 * reads the live session, developer and grants each time, so an ended sign-in or a revoked developer answers 401 at
 * once. Administrator comes only from the person's own company sign-in (FR-005), so the developer-ID form never has it.
 */
export async function checkSignInAccess(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest): Promise<AccessCheckResponse> {
  const refused = () => agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const parsed = AccessCheckRequestSchema.safeParse(jsonBody(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the access check takes an optional developerId (64 hex characters) and nothing else");
  // Authentication and the Slack hint share this request's live identity reads.
  deps = withSignInReads(deps);
  const authorization = request.headers.authorization;
  const basic = basicClientCredentials(authorization);
  const nowSeconds = Math.floor(deps.now() / 1000);
  let developerId: string;
  let administrator = false;
  let clientId: string;
  let companyId: string | undefined;
  let sessionFacts: AccessCheckContext["session"];
  let signedInId: string | undefined;
  let companyless = false;
  let joinedByInvite = false;
  if (basic !== undefined) {
    const client = await signInClientOf(deps, basic.clientId);
    if (client === undefined || !clientSecretMatches(basic.secret, client.secretHash) || parsed.data.developerId === undefined) throw refused();
    developerId = parsed.data.developerId;
    clientId = client.clientId;
    companyId = await clientCompany(deps, client, developerId);
  } else {
    if (parsed.data.developerId !== undefined) throw refused();
    // DEC 253z: the person's own token is the one form that may answer for a person with no company yet (the web app's "create your company").
    const authenticated = await authenticateClientToken(deps, authorization, nowSeconds, { companyless: true });
    ({ developerId, administrator, signedInId } = authenticated);
    clientId = authenticated.client.clientId;
    companyId = authenticated.companyId;
    companyless = authenticated.companyless === true;
    joinedByInvite = authenticated.joinedByInvite === true;
    sessionFacts = { sessionId: authenticated.sessionId, amr: authenticated.amr, startedAt: authenticated.startedAt, administrator };
  }
  const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
  let access: Awaited<ReturnType<typeof projectsAPersonUses>>;
  let company: Pick<AccessCheckResponse, "companyId" | "companyRole" | "companyName" | "joinedByInvite"> = {};
  if (deps.companies === undefined) {
    // DEC 254: with Code's company layer off, the install's own company records (and a merged sign-in's survivor) decide; none: exactly the legacy read.
    const install = await installCompanyAccess(deps, developerId);
    if (install === "refused") throw refused();
    access = install === undefined ? await projectsAPersonUses(deps, developerId) : install.access;
    if (install?.company !== undefined) company = install.company;
  } else if (companyless) {
    // DEC 253z: no company yet: who they are, no company fields, no projects. Nothing company-scoped is read.
    const person = await getSignIn<Pick<DeveloperRecord, "displayName" | "displayNameChosen" | "revoked">>({ ...deps, documentClient: scope!.client }, `DEVELOPER#${developerId}`);
    access = person === undefined || person.revoked !== false || typeof person.displayName !== "string" ? undefined
      : { displayName: person.displayName, nameChosen: person.displayNameChosen === true, projects: [], notices: [] };
  } else {
    access = await projectsAPersonUses({ ...deps, documentClient: scope!.client }, developerId, companyId);
    // DEC 253z: the company, its role and its name, from live membership read on this call.
    if (companyId === undefined) throw refused();
    company = await codeCompanyOf(deps, scope!.client, developerId, companyId);
    // DEC 254b (f): only the person's own token, only Code's company layer, only for the company this answer names.
    if (joinedByInvite && company.companyId === companyId) company = { ...company, joinedByInvite: true };
  }
  scope?.check();
  if (access === undefined) throw refused();
  // L4-SIGNIN: a Slack session of the person's own token also names its workspace (a convenience for the browser; best effort: unreadable is left out).
  const slackTeamId = basic === undefined && sessionFacts?.amr === "slack" ? await slackWorkspaceOf(deps, developerId, signedInId) : undefined;
  const answer: AccessCheckResponse = { developerId, displayName: access.displayName, nameChosen: access.nameChosen, administrator, projects: access.projects, notices: access.notices, ...company, ...(slackTeamId === undefined ? {} : { slackTeamId }) };
  const context: AccessCheckContext = { clientId, via: basic === undefined ? "token" : "client_secret", developerId, ...(sessionFacts === undefined ? {} : { session: sessionFacts }), now: deps.now() };
  const ruled = await applyAccessRules(deps.developer.accessRules, context, answer);
  if (ruled === undefined) throw refused();
  // What leaves is exactly the answer's shape, whatever a rule did.
  const checked = AccessCheckResponseSchema.safeParse(ruled);
  if (!checked.success) throw refused();
  return checked.data;
}

/** L4-SIGNIN: the Slack workspace id on the person's own stored profile, only when it is a workspace id. Any failure is no workspace: it is a convenience, never a gate. */
async function slackWorkspaceOf(deps: DeveloperRouteDependencies, developerId: string, signedInId?: string): Promise<string | undefined> {
  try {
    if (signedInId !== undefined) {
      const walk = await mergeSurvivor((id) => getSignIn(deps, `DEVELOPER#${id}`), signedInId);
      // The identity recorded by this session must still belong to its person; never use another person's workspace or fall back to the survivor's.
      if (walk.survivorId !== developerId) return undefined;
      return slackWorkspaceHint(walk.signedIn.slackTeamId);
    }
    return slackWorkspaceHint((await getSignIn<Pick<DeveloperRecord, "slackTeamId">>(deps, `DEVELOPER#${developerId}`))?.slackTeamId);
  } catch {
    return undefined;
  }
}

/** DEC 253z: the person's company from Code's own company layer: live membership (with its role) and the company's stored profile. Any doubt refuses. */
async function codeCompanyOf(deps: DeveloperRouteDependencies, client: { send(command: unknown): Promise<unknown> }, developerId: string, companyId: string): Promise<Pick<AccessCheckResponse, "companyId" | "companyRole" | "companyName">> {
  const refused = () => agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  let membership: { companyId: string; role: OrgRole } | undefined;
  try { membership = await deps.companies?.membershipOf?.(developerId); } catch { throw refused(); }
  if (membership === undefined || membership.companyId !== companyId || !OrgRoleSchema.safeParse(membership.role).success) throw refused();
  const key = companyKey(companyId);
  const stored = (await client.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  // The name is display only: no stored profile (the built-in company until an operator writes one) answers no name. A stored profile that does not
  // read, is not active, or names another company refuses.
  if (stored === undefined) return { companyId, companyRole: membership.role };
  const record = CompanyRecord.safeParse(stored);
  if (!record.success || record.data.companyId !== companyId || stored.pk !== key.pk || stored.sk !== key.sk) throw refused();
  return { companyId, companyRole: membership.role, companyName: record.data.name };
}

/**
 * DEC 254: the access answer from the install's company-scoped records (install-company.ts), for a Code whose own company layer is off. The signed-in id is
 * followed through account merges to its survivor first. Undefined: the person has no company there and was never merged, so the caller reads exactly the
 * legacy keys as before. "refused": the one fixed refusal (a merge loop, a removed or banned member, an unreadable record, a read limit).
 */
async function installCompanyAccess(deps: DeveloperRouteDependencies, developerId: string): Promise<undefined | "refused" | { access: Awaited<ReturnType<typeof projectsAPersonUses>>; company?: Pick<AccessCheckResponse, "companyId" | "companyRole" | "companyName"> }> {
  const budget = boundedCompanyReads(deps.documentClient, deps.now);
  const scoped: DeveloperRouteDependencies = { ...deps, documentClient: budget.client };
  try {
    const walk = await mergeSurvivor((id) => getSignIn(scoped, `DEVELOPER#${id}`), developerId);
    const company = await installCompanyOf(budget.client, deps.tableName, walk.survivorId);
    if (company === undefined) {
      // A company-layout install: no pointer means removed or never joined, never "read the legacy keys".
      if (await installUsesCompanyLayout(budget.client, deps.tableName, deps.developer.slackTeamId)) return "refused";
      if (walk.survivorId === developerId) return undefined;
      // A merged sign-in on a legacy install: the survivor's legacy grants.
      const access = await projectsAPersonUses(scoped, walk.survivorId);
      budget.check();
      return access === undefined ? "refused" : { access };
    }
    if (typeof walk.survivor.displayName !== "string") return "refused";
    const { companyId, role } = company;
    const grants = await installCompanyGrants(budget.client, deps.tableName, companyId, walk.survivorId, mayUseProject);
    const catalog = role === "owner" || role === "admin" ? await installCompanyCatalog(budget.client, deps.tableName, companyId) : [];
    const teamId = deps.developer.slackTeamId;
    const bindings = teamId === undefined ? [] : await installCompanyBindings(budget.client, deps.tableName, companyId, teamId);
    const names = [...new Set([...grants, ...catalog, ...bindings.map((binding) => binding.projectName)])].sort();
    if (names.length > INSTALL_COMPANY_PROJECTS_MAX) return "refused";
    const definitions = await mapLimit(names, REVISION_READS_AT_ONCE, (name) => installCompanyLatestDefinition(budget.client, deps.tableName, companyId, name));
    const policies = new Map<string, DeveloperTaskPolicy>();
    names.forEach((name, index) => { const definition = definitions[index]; if (definition !== undefined) policies.set(name, developerTaskPolicy(definition)); });
    const slackUserId = walk.survivor.slackUserId ?? walk.signedIn.slackUserId;
    const resolved = await resolveDeveloperAccess({
      grants: [...grants, ...catalog].filter((name) => policies.has(name)),
      bindings: bindings.filter((binding) => policies.has(binding.projectName)),
      ...(slackUserId === undefined ? {} : { slackUserId }),
      channelMembersMayUse: (project) => policies.get(project)?.channelMembersMayUse === true,
      channelMembers: safeChannelMembers(deps),
    });
    budget.check();
    return {
      access: {
        displayName: walk.survivor.displayName, nameChosen: walk.survivor.displayNameChosen === true,
        projects: [...resolved.projects].filter(([name]) => policies.has(name)).map(([name, entry]) => ({ name, access: entry.access })),
        notices: resolved.slackUnavailable ? ["slack_unavailable"] : [],
      },
      company: { companyId, companyRole: role, ...(company.name === undefined ? {} : { companyName: company.name }) },
    };
  } catch (error) {
    if (error instanceof InstallCompanyRefused || error instanceof AgentXError || error instanceof z.ZodError) return "refused";
    throw error;
  }
}

/**
 * The projects a person may use now, as the access check answers them: task access (developer grants and channels),
 * then (spec 065) the registered projects they administer. Undefined for an unknown or revoked developer.
 */
async function projectsAPersonUses(deps: DeveloperRouteDependencies, developerId: string, companyId?: string): Promise<{ displayName: string; nameChosen: boolean; projects: AccessCheckResponse["projects"]; notices: string[] } | undefined> {
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "displayNameChosen" | "slackUserId" | "email" | "revoked" | "provider">>(deps, `DEVELOPER#${developerId}`);
  if (developer === undefined || developer.revoked) return undefined;
  const listed = await listProjects(deps, {
    developerId, sessionId: "", amr: developer.provider, name: developer.displayName,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
  }, companyId);
  // An administrator row also gives task access (#630), but this answer keeps naming it `administrator`, after the rest.
  const administered = (await grantRowsOf<{ projectName: string; role?: string }>(deps, developerId, companyId))
    .filter((membership) => membership.role === "administrator" && typeof membership.projectName === "string")
    .map((membership) => membership.projectName);
  const registered = await projectsWithPolicy(deps, administered, companyId);
  return {
    displayName: developer.displayName,
    nameChosen: developer.displayNameChosen === true,
    projects: [
      ...listed.projects.filter((project) => !administered.includes(project.name)).map((project) => ({ name: project.name, access: project.access })),
      ...administered.filter((name) => registered.has(name)).sort().map((name) => ({ name, access: "administrator" as const })),
    ],
    notices: listed.notices,
  };
}

/** A repository's `owner/name` on GitHub, or undefined for another host. */
function githubFullName(url: string): string | undefined {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

/** Spec 065: `GET /v1/dev/client/projects/{project}`, for a person who may use it (no scope: it shows only what they may use). */
async function readClientProject(deps: DeveloperRouteDependencies, developerId: string, project: string, companyId?: string): Promise<ClientProjectResponse> {
  const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
  if (scope !== undefined) deps = { ...deps, documentClient: scope.client };
  const access = await projectsAPersonUses(deps, developerId, companyId);
  if (access === undefined) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const mine = access.projects.find((entry) => entry.name === project);
  if (mine === undefined) throw agentXError("NOT_FOUND", "project not found");
  // DEC 254zzz80: a named company's revision from its own partition (company-layout.ts checks the partition); the legacy row keeps its stored-company check.
  const named = namedCompany(companyId);
  const row = named !== undefined ? await namedCompanyLatestRevisionRow(deps.documentClient, deps.tableName, named, project) as { definition?: { revision?: unknown; repositories?: unknown } } | undefined
    : (await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
    })) as { Items?: Array<{ definition?: { revision?: unknown; repositories?: unknown } }> }).Items?.[0];
  if (named === undefined ? !recordInCompany(row, companyId) : row === undefined) throw agentXError("NOT_FOUND", "project not found");
  scope?.check();
  const definition = row?.definition;
  if (definition === undefined || typeof definition.revision !== "number") throw agentXError("NOT_FOUND", "project not found");
  const repositories = (Array.isArray(definition.repositories) ? definition.repositories : []).flatMap((entry: unknown) => {
    const repository = entry as { name?: unknown; url?: unknown; defaultBranch?: unknown };
    if (typeof repository.name !== "string" || typeof repository.url !== "string" || typeof repository.defaultBranch !== "string") return [];
    const fullName = githubFullName(repository.url);
    return [{ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, ...(fullName === undefined ? {} : { fullName }) }];
  });
  return { name: project, latestRevision: definition.revision, access: mine.access, repositories };
}

/**
 * DEC 253z: is this live session one with no company? Only the install-level web app with full access, the install's own OIDC sign-in, a session
 * that names no company, NO membership row for the person at all (a removed member's row stays, so they stay refused), and a sign-in record the
 * no-company sign-in wrote (never a legacy person's) that points at no person (`mergedInto`). Read live, on the sign-in table; any doubt is no.
 */
async function companylessSession(deps: DeveloperRouteDependencies, client: SignInClientRecord, session: SessionRecord): Promise<boolean> {
  if (deps.companies === undefined || client.installLevel !== true || client.fullAccess !== true || client.webApp !== true || (session.amr !== "oidc" && session.amr !== "slack" && session.amr !== "github") || session.companyId !== undefined) return false;
  try {
    const membership = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: membershipKey(session.developerId), ConsistentRead: true })) as { Item?: unknown };
    if (membership.Item !== undefined) return false;
    const developer = await getSignIn<{ revoked?: unknown; companyless?: unknown; mergedInto?: unknown }>(deps, `DEVELOPER#${session.developerId}`);
    return developer?.revoked === false && developer.companyless === true && developer.mergedInto === undefined; // SLACK-LINK-L2: a record that points at a person is never one with no company
  } catch { return false; }
}

/** Only the token scopes still allowed by the registration, or all scopes for a full-access client. */
function clientTokenScopes(client: SignInClientRecord, scope: unknown): ClientScope[] {
  return client.fullAccess === true ? [...CLIENT_SCOPES] : scopesOf(scope).filter((entry) => client.scopes?.includes(entry) === true);
}

async function verifyClientSessionAndCompany(
  deps: DeveloperRouteDependencies,
  client: SignInClientRecord,
  claims: Record<string, unknown>,
  amr: "slack" | "oidc" | "github",
  nowSeconds: number,
  options: { companyless?: true },
  refused: () => Error,
) {
  const session = await getSignIn<SessionRecord>(deps, `SESSION#${claims.sid as string}`);
  if (session === undefined || session.clientId !== client.clientId || session.developerId !== claims.sub || session.amr !== amr
    || session.revokedAt !== undefined || session.endsAt <= nowSeconds || Date.parse(session.startedAt) < Date.parse(client.createdAt)) throw refused();
  await requireSessionSurvivor(deps, session, refused);
  let companyId: string | undefined;
  let companyless = false;
  try { companyId = await clientCompany(deps, client, session.developerId); }
  catch (error) {
    if (options.companyless !== true || !await companylessSession(deps, client, session)) throw error;
    companyless = true;
  }
  const companyDeveloper = companyless ? undefined : await companyOidcSession(deps, session, companyId);
  if (companyDeveloper === undefined && (deps.developer.methods[amr] !== true || startedBeforeMethodOn(session.startedAt, deps.developer.since?.[amr]))) throw refused();
  const developer = companyDeveloper ?? await getSignIn<Pick<DeveloperRecord, "sessionsEndedAt">>(deps, `DEVELOPER#${session.developerId}`);
  if (endedByAdmin(session.startedAt, developer?.sessionsEndedAt)) throw refused();
  const joinedByInvite = session.joinedByInvite === true && !companyless && companyId !== undefined && (session.companyId ?? IMPLICIT_COMPANY_ID) === companyId;
  return {
    client,
    ...(session.signedInId === undefined ? {} : { signedInId: session.signedInId }),
    ...(companyId === undefined ? {} : { companyId }),
    ...(companyless ? { companyless: true as const } : {}),
    developerId: session.developerId,
    sessionId: claims.sid as string,
    amr,
    administrator: amr === "oidc" && session.administrator === true && !companyless,
    scopes: clientTokenScopes(client, claims.scope),
    startedAt: session.startedAt,
    ...(joinedByInvite ? { joinedByInvite: true as const } : {}),
  };
}

/**
 * Spec 063 FR-004, spec 065 FR-003: a registered sign-in client's token, for a live session of its own. The unverified azp
 * only picks which client's audience the token must then verify against. Every refusal is the same 401.
 */
async function authenticateClientToken(deps: DeveloperRouteDependencies, authorization: string | undefined, nowSeconds: number, options: { companyless?: true } = {}): Promise<{ signedInId?: string; client: SignInClientRecord; companyId?: string; companyless?: true; developerId: string; administrator: boolean; scopes: ClientScope[]; sessionId: string; amr: DeveloperSignInMethod; startedAt: string; joinedByInvite?: true }> {
  deps = withSignInReads(deps);
  const refused = () => agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  let azp: unknown;
  try { azp = decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "").azp; } catch { throw refused(); }
  const client = await signInClientOf(deps, azp);
  if (client === undefined) throw refused();
  let claims: Record<string, unknown>;
  try { claims = await deps.developer.verifyAccessToken(authorization, client.audience); }
  catch (error) {
    if ((error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE") throw error;
    throw refused();
  }
  if (claims.azp !== client.clientId || claims.env !== deps.developer.env || typeof claims.sub !== "string" || typeof claims.sid !== "string") throw refused();
  const amr = claims.amr;
  if ((amr !== "slack" && amr !== "oidc" && amr !== "github") || (deps.developer.methods[amr] !== true && !(deps.companies !== undefined && amr === "oidc"))) throw refused();
  try {
    return await verifyClientSessionAndCompany(deps, client, claims, amr, nowSeconds, options, refused);
  } catch (error) {
    if (deps.companies !== undefined && amr === "oidc") throw refused();
    throw error;
  }
}

/**
 * Plan v3.2 lane ID: a sign-in client's token reaches a route only with the route's named scope, or with full access
 * (spec 066) for a `full` route. The refusal names what is missing, never anything the request carried.
 */
function requireRouteScope(route: DevRoute, caller: { client: SignInClientRecord; scopes: readonly ClientScope[] }): void {
  if (route.requires === "none") return;
  if (route.requires === "full" ? caller.client.fullAccess === true : caller.scopes.includes(route.requires)) return;
  // No company in scope here (the caller is a sign-in client acting as a person), so this uses the file's one company-less logger, already in the log-site inventory, rather than a new console call.
  logDeveloperEvent({ event: "client.scope_refused", clientId: caller.client.clientId, method: route.method, route: route.path, requires: route.requires });
  throw agentXError("FORBIDDEN", route.requires === "full"
    ? `${caller.client.name} needs full access for ${route.method} ${route.path}, which is off for it; an administrator can turn it on`
    : `${caller.client.name} needs the ${route.requires} scope for ${route.method} ${route.path}; an administrator can allow it with that scope`);
}

/**
 * A developer API caller: the Rovara CLI's token, with all the person's rights; or a registered sign-in client's, as its
 * signed-in person, within the route's scope (plan v3.2 lane ID) or, for a `full` route, only with full access (spec
 * 066). A client registered with no scope and no full access is refused with 401, as before. The unverified azp only
 * picks the path; each then verifies the token in full. The client's registration is read at every request, so
 * removing a scope or full access takes effect at once.
 */
/** The caller of a developer route: the Rovara CLI's token, or a sign-in client's with the route's scope (or full access). Exported for its tests. */
export async function authenticateCaller(deps: DeveloperRouteDependencies, authorization: string | undefined, route: DevRoute, options: { companyless?: true } = {}): Promise<DeveloperCaller> {
  let azp: unknown;
  try {
    azp = decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "").azp;
  } catch {
    azp = undefined;
  }
  // A client with neither a scope nor full access is refused as before: its tokens are never Rovara's (401).
  const client = typeof azp !== "string" || azp === AGENTX_CLI_CLIENT_ID ? undefined : await signInClientOf(deps, azp);
  if (client === undefined || (client.fullAccess !== true && (client.scopes ?? []).length === 0)) {
    return await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(authorization));
  }
  const person = await authenticateClientToken(deps, authorization, Math.floor(deps.now() / 1000), options);
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "provider" | "subject" | "slackUserId" | "email" | "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  requireRouteScope(route, person);
  const caller: DeveloperCaller = {
    developerId: person.developerId, sessionId: person.sessionId, amr: person.amr, name: profileDisplayName(developer) ?? developer.displayName, clientId: person.client.clientId,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
    ...(person.client.fullAccess === true && person.client.webApp === true ? { webApp: true as const } : {}),
  };
  return caller;
}

/** What the project member reads and changes (spec 065) need. */
function memberActions(deps: DeveloperRouteDependencies) {
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName,
    ...(deps.companies === undefined ? {} : { companies: deps.companies }),
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    limitDefaults: { member: 0, organization: 0 }, now: deps.now,
  };
}

/**
 * Spec 067: a registered, not removed person, with their name and whether they hold a grant on `project`. With `ownTask` (the task's own person asking whether they still hold their task) it also
 * answers `mayStart`: the SAME live test the task start meets, `checkProjectAccess`: the grant, or fresh bound-channel membership while the project lets channel members use it and the person is
 * Slack-linked, for an OLD-engine task only (no engine stamp; a core task's own person needs the grant). Read now, nothing kept; a read that fails (Slack unreachable, a refusal, the stamp) is "no", as at the start. A reader never gets it (a reader needs the grant itself).
 */
export async function taskReaderPerson(deps: DeveloperRouteDependencies, developerId: string, project: string, taskCompany?: string, options?: { ownTask?: true; taskId?: string }): Promise<{ name: string; projectMember: boolean; companyMember: boolean; mayStart?: boolean } | undefined> {
  const person = await getSignIn<Pick<DeveloperRecord, "revoked" | "displayName" | "slackUserId">>(deps, `DEVELOPER#${developerId}`);
  if (person === undefined || person.revoked === true) return undefined;
  const name = person.displayName ?? "Unknown";
  // `companyMember`: a LIVE member of the TASK's company (READ-RULE-SHARE-B). Every answer below is given only after that was proved, except the "not a member" returns, which say false, and the no-company-layer branch, which says the grant.
  const answer = async (held: boolean, companyMember = true) => {
    if (options?.ownTask !== true) return { name, projectMember: held, companyMember };
    if (held) return { name, projectMember: held, companyMember, mayStart: true };
    try {
      // Channel access holds an OLD-engine task only: the one the engine stamp (`TASK_ENGINE#<id>`, written by the core's own start) is missing for. A core task's own person needs the grant, as its start
      // and every step do (core-engine-root.ts); no task id, a stamp that is there, or a stamp that cannot be read: grant only.
      if (options.taskId === undefined || await isCoreTaskThatExists(deps, options.taskId)) return { name, projectMember: held, companyMember: true, mayStart: false };
      await checkProjectAccess(deps, { developerId, ...(person.slackUserId === undefined ? {} : { slackUserId: person.slackUserId }) }, project);
      return { name, projectMember: held, companyMember: true, mayStart: true };
    } catch { return { name, projectMember: held, companyMember: true, mayStart: false }; }
  };
  // DEC 254zzz80 / 254zzz98 (review L2): a reader of a task must be a LIVE member of the TASK's company, and their grant is read where that company keeps it (beside its
  // revision): never in the reader's own other company, so a share never says whether a person of another company holds a grant there. No live company: no grant.
  // With no company layer at all, nothing here is company-scoped: the legacy grant, byte for byte as before.
  // No company layer (COMPANY_SIGNIN is not "enabled"; the stack default is disabled) means no live company to prove, so a share FAILS CLOSED to the old rule: only a person who holds the project grant is a company member here (READ-RULE-SHARE-B, rule 1).
  // A core task can still run on such an install (the core reads company membership from the sign-in table itself), and its sign-ins may belong to more than one company, so "registered" is never enough.
  if ((deps.companies ?? deps.developer.companies) === undefined) { const held = await projectGrant(memberActions(deps), project, developerId, undefined) !== undefined; return answer(held, held); }
  let company: string | undefined;
  try { company = await liveNamedCompany(deps, developerId); } catch { return { name, projectMember: false, companyMember: false }; }
  const owning = taskCompany === undefined ? company : namedCompany(taskCompany);
  if (owning !== company) return { name, projectMember: false, companyMember: false };
  return answer(await projectGrant(memberActions(deps), project, developerId, owning) !== undefined);
}

const CLIENT_PROJECT = /^\/v1\/dev\/client\/projects\/([^/]+)$/;
/** Guided onboarding PR 6: one project per repository, and the repository picker. */
const CLIENT_PROJECTS_BULK = "/v1/dev/client/projects/bulk";
const CLIENT_REPOSITORY_CHOICES = "/v1/dev/client/repositories/available";
const CLIENT_CODE_SETTINGS = /^\/v1\/dev\/client\/projects\/([^/]+)\/code-settings$/;

/**
 * Lane W: `GET|PUT /v1/dev/client/projects/{project}/code-settings`. Read by a person who may use the project (in their company, from membership); changed by its administrator or a
 * company administrator (or, with no company layer, a Rovara administrator). Another company's project, one they may not use and a missing one all answer "project not found".
 */
async function routeClientCodeSettings(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, rawProject: string, route: DevRoute): Promise<unknown> {
  const person = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, person);
  const profile = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (profile === undefined || profile.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", "project not found"); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  // As readClientProject: one bounded read budget for the company-checked listing.
  const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
  const companyId = await resolveCompany(deps.companies, person.developerId);
  const access = await projectsAPersonUses(scope === undefined ? deps : { ...deps, documentClient: scope.client }, person.developerId, companyId);
  scope?.check();
  if (access === undefined) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  if (!access.projects.some((entry) => entry.name === project)) throw agentXError("NOT_FOUND", "project not found");
  const store = { documentClient: deps.documentClient, tableName: deps.tableName };
  if (request.method === "GET") return { settings: await readCodeSettings(store, companyId ?? IMPLICIT_COMPANY_ID, project) };
  const own = await projectGrant(memberActions(deps), project, person.developerId, namedCompany(companyId));
  const membership = companyId === undefined ? undefined : await deps.companies?.membershipOf?.(person.developerId);
  const companyAdmin = companyId === undefined ? person.administrator : membership?.companyId === companyId && (membership.role === "admin" || membership.role === "owner");
  return putCodeSettings({ ...store, now: deps.now, // The file's one company-less logger (already in the log-site inventory), with the company added when there is one.
    log: (entry) => logDeveloperEvent({ ...entry, ...(companyId === undefined ? {} : { companyId }) }) }, {
    companyId, project, personId: person.developerId, clientId: person.client.clientId, mayChange: own?.role === "administrator" || companyAdmin, webApp: person.client.fullAccess === true && person.client.webApp === true, body: jsonBody(request),
  });
}
const CLIENT_SETUP_STATUS = /^\/v1\/dev\/client\/projects\/([^/]+)\/setup-status(\/skips|\/eval-none)?$/;

/** The project's Slack channel links from the existing binding rows (ids; names only where the company's workspace can be asked, as the access check does). */
async function projectChannelLinks(deps: DeveloperRouteDependencies, project: string, companyId: string | undefined): Promise<Array<{ channelId: string; name?: string; isPrivate?: boolean }>> {
  const bindings = (await bindingsOf(deps, undefined, companyId)).filter((binding) => binding.projectName === project);
  const ids = [...new Set(bindings.map((binding) => binding.channelId))].sort();
  if (ids.length === 0) return [];
  const teams = [...new Set(bindings.map((binding) => binding.teamId))];
  let names = new Map<string, { name: string; isPrivate: boolean }>();
  if (deps.workspaces !== undefined && companyId !== undefined && teams.length === 1) {
    try { names = await channelNames(deps, ids, { companyId, teamId: teams[0]! }); } catch { names = new Map(); }
  }
  return ids.map((channelId) => describeChannel(channelId, names));
}

/**
 * Guided onboarding PR 8: `GET /v1/dev/client/projects/{project}/setup-status` (any member of the project's company) and `PUT .../setup-status/skips` (a company owner or admin, or the project's
 * administrator). The company is the caller's live membership; another company's project, an unknown one and an unreadable name all answer "project not found". See project-setup-status.ts.
 */
async function loadClientSetupStatusProject(
  deps: DeveloperRouteDependencies,
  scopeClient: DeveloperRouteDependencies["documentClient"],
  personId: string,
  rawProject: string,
  companyId: string | undefined,
): Promise<{ project: string; revision: number; definition: { revision: number; repositories?: unknown; readiness?: unknown }; noAutomatedTests?: unknown }> {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", "project not found"); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  const named = namedCompany(companyId);
  const row = named !== undefined
    ? await namedCompanyLatestRevisionRow(scopeClient, deps.tableName, named, project) as { definition?: { revision?: unknown; repositories?: unknown; readiness?: unknown }; noAutomatedTests?: unknown } | undefined
    : (await scopeClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
    })) as { Items?: Array<{ definition?: { revision?: unknown; repositories?: unknown; readiness?: unknown }; noAutomatedTests?: unknown }> }).Items?.[0];
  const definition = row?.definition;
  if ((named === undefined ? !recordInCompany(row, companyId) : row === undefined) || definition === undefined || typeof definition.revision !== "number") {
    throw agentXError("NOT_FOUND", "project not found");
  }
  if (companyId === undefined) {
    const access = await projectsAPersonUses({ ...deps, documentClient: scopeClient }, personId, undefined);
    if (access === undefined) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
    if (!access.projects.some((entry) => entry.name === project)) throw agentXError("NOT_FOUND", "project not found");
  }
  return { project, revision: definition.revision, definition: { revision: definition.revision, repositories: definition.repositories, readiness: definition.readiness }, noAutomatedTests: row?.noAutomatedTests };
}

async function routeClientSetupStatus(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, rawProject: string, change: "/skips" | "/eval-none" | undefined, route: DevRoute): Promise<unknown> {
  const person = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, person);
  const profile = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (profile === undefined || profile.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const scope = boundedCompanyReads(deps.documentClient, deps.now);
  const companyId = await resolveCompany(deps.companies, person.developerId);
  const loaded = await loadClientSetupStatusProject(deps, scope.client, person.developerId, rawProject, companyId);
  const membership = companyId === undefined ? undefined : await deps.companies?.membershipOf?.(person.developerId);
  const role = membership !== undefined && membership.companyId === companyId ? membership.role : undefined;
  const own = await projectGrant({ ...memberActions(deps), documentClient: scope.client }, loaded.project, person.developerId, namedCompany(companyId));
  const projectAdmin = own?.role === "administrator";
  const mayChange = projectAdmin || (companyId === undefined ? person.administrator : role === "admin" || role === "owner");
  const effectiveCompany = companyId ?? IMPLICIT_COMPANY_ID;
  if (change === "/eval-none") {
    if (request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    const changed = await putEvalNone({ documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project: loaded.project, revision: loaded.revision, personId: person.developerId, mayChange, body: () => jsonBody(request) });
    scope.check();
    logDeveloperEvent({ event: "client.project_setup_eval_none_changed", clientId: person.client.clientId, by: person.developerId, project: loaded.project, noEvals: changed.noEvals ? "true" : "false", ...(companyId === undefined ? {} : { companyId }) });
    return changed;
  }
  if (change === "/skips") {
    if (request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    const changed = await putSkip({ documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project: loaded.project, personId: person.developerId, mayChange, body: () => jsonBody(request) });
    scope.check();
    logDeveloperEvent({ event: "client.project_setup_skip_changed", clientId: person.client.clientId, by: person.developerId, project: loaded.project, row: changed.row, skipped: changed.skipped ? "true" : "false", ...(companyId === undefined ? {} : { companyId }) });
    return changed;
  }
  if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
  const status = await readProjectSetupStatus({
    documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project: loaded.project, definition: loaded.definition, noAutomatedTests: loaded.noAutomatedTests,
    viewer: { companyRole: role ?? null, projectAdmin },
    readers: { channels: () => projectChannelLinks({ ...deps, documentClient: scope.client }, loaded.project, companyId), ...linearTeamReader(deps, companyId, loaded.project) },
  });
  scope.check();
  return status;
}

/**
 * Audit gap 11c: the checklist's Linear row reads the project's picked Linear team (linear-connect-routes.ts's `teamPick`, the company's own pick row) where the install wires Linear and has a company
 * layer, while the company's Linear connection is connected; elsewhere the row stays optional, as before. A pick is shown by its id and name only (the contract's bounds); a read that fails is the checklist's fixed unreadable answer.
 */
function linearTeamReader(deps: DeveloperRouteDependencies, companyId: string | undefined, project: string): { linearTeam?: () => Promise<{ id: string; name?: string } | undefined> } {
  const connections = deps.developer.linearConnect?.connections;
  if (connections === undefined || companyId === undefined) return {};
  return { linearTeam: async () => {
    // A pick counts only while the company's Linear connection is live: a disconnected or needs-reconnect workspace leaves the row not done (its pick may outlive the connection).
    const [connection, pick] = await Promise.all([connections.connection(companyId), connections.teamPick(companyId, project)]);
    if (pick === undefined || connection?.status !== "connected") return undefined;
    const name = pick.teamName.trim().slice(0, 200);
    return { id: pick.teamId, ...(name === "" ? {} : { name }) };
  } };
}

const CLIENT_LIFECYCLE = /^\/v1\/dev\/client\/projects\/([^/]+)\/(archive-preview|archive|restore-preview|restore)$/;

/**
 * Guided onboarding PR 16: `GET .../archive-preview`, `POST .../archive`, `GET .../restore-preview`, `POST .../restore` on `/v1/dev/client/projects/{project}`. The token and its route row
 * first (like every row); then only with the company layer (the live membership names the company and the role). The rule and the writes are project-lifecycle-routes.ts's.
 */
async function routeClientLifecycle(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, rawProject: string, action: LifecycleAction, route: DevRoute): Promise<unknown> {
  const person = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, person);
  // Without the company layer there is no company role to judge by: every project looks missing.
  const reader = deps.companies;
  if (reader?.membershipOf === undefined) throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  const profile = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (profile === undefined || profile.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  return routeProjectLifecycle({
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now,
    membershipOf: async (personId) => await reader.membershipOf!(personId),
    grantRole: async (personId, project) => (await projectGrant(memberActions(deps), project, personId, await liveNamedCompany(deps, personId)))?.role,
    archiveTakesEffect: (companyId) => deps.developer.projectArchiveTakesEffect?.(companyId) === true,
    linkedSlackChannels: async (companyId, project) => (await bindingsOf(deps, undefined, companyId)).filter((binding) => binding.projectName === project).length,
  }, { personId: person.developerId, project: rawProject, action, body: request.body });
}
// Guided onboarding PR 19 (declared here, merged into the interface above, so the line-keyed company inventory rows above stay where they are).
export interface DeveloperRouteDependencies {
  /**
   * Design section 4, DEC 254l: the company this person is a live owner or admin of, read now by the same membership reader the create's repository
   * isolation uses; undefined for anyone else. Absent where repositories are not checked against the company's GitHub bindings, so there only a Rovara
   * administrator creates projects.
   */
  companyProjectCreator?: (developerId: string) => Promise<string | undefined>;
}

/**
 * Guided onboarding PR 19: a signed-in person who is not a Rovara administrator may create projects (and read the repository pickers) only as a live owner or
 * admin of the company their sign-in resolved, by the isolation's own reader, and only while their sign-in record is not revoked. Never from the request.
 */
async function companyMayCreateProjects(deps: DeveloperRouteDependencies, creator: { developerId: string; companyId?: string }): Promise<boolean> {
  if (deps.companyProjectCreator === undefined || creator.companyId === undefined) return false;
  if (await deps.companyProjectCreator(creator.developerId) !== creator.companyId) return false;
  const person = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${creator.developerId}`);
  return person !== undefined && person.revoked !== true;
}
const CLIENT_MEMBERS = /^\/v1\/dev\/client\/projects\/([^/]+)\/members(?:\/([^/]+))?$/;
/** Who may see and change a project's members; fixed words (no project name echoed), so the refusal never reads like a missing project. */
export const CLIENT_MEMBERS_NOT_ALLOWED = "Only a company owner or admin, or the project's admin, can see and change its members.";

/**
 * Audit gap 12c (DEC 254n item 3, `lifecycleAccess` in project-lifecycle-routes.ts: "owners, admins and the project's administrators manage"): whether the caller is a LIVE owner or admin of the
 * company this project belongs to. The role and company are membership's, read now (never a claim or the request); the sign-in's company, when the install resolved one, must be the same; the
 * project's company is its latest revision's (a legacy row with none is the implicit company's, never the caller's). No company layer, no role reader, or no project: false.
 */
async function companyManagesProject(deps: DeveloperRouteDependencies, caller: { developerId: string; companyId?: string | undefined }, project: string): Promise<boolean> {
  const reader = deps.companies ?? deps.developer.companies;
  if (reader?.membershipOf === undefined) return false;
  const membership = await reader.membershipOf(caller.developerId);
  if (membership === undefined || (membership.role !== "owner" && membership.role !== "admin")) return false;
  if (caller.companyId !== undefined && caller.companyId !== membership.companyId) return false;
  // DEC 254zzz80: a named company's project is one with a revision in its own partition.
  const named = namedCompany(membership.companyId);
  if (named !== undefined) return await namedCompanyLatestRevisionRow(deps.documentClient, deps.tableName, named, project) !== undefined;
  const latest = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: unknown[] };
  const row = latest.Items?.[0];
  return row !== undefined && recordInCompany(row, membership.companyId);
}

async function routeClientCompanyAudit(
  deps: DeveloperRouteDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  route: DevRoute,
): Promise<unknown> {
  const reader = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, reader);
  if (deps.companyReads === undefined) throw agentXError("NOT_FOUND", "route not found");
  const person = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${reader.developerId}`);
  if (person === undefined || person.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const resolveCompanyFn = deps.companyReads.companyOf;
  const personName = deps.companyReads.personName ?? (async (developerId: string, companyId: string) => {
    if (resolveCompanyFn !== undefined && (await resolveCompanyFn(developerId)) !== companyId) return undefined;
    return (await getSignIn<Pick<DeveloperRecord, "displayName">>(deps, `DEVELOPER#${developerId}`))?.displayName;
  });
  return routeCompanyReads({ ...deps.companyReads, personName }, { developerId: reader.developerId, administrator: reader.administrator, companyId: reader.companyId }, url, deps.now());
}

async function routeClientProjectCreation(
  deps: DeveloperRouteDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  route: DevRoute,
): Promise<unknown> {
  const creator = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, creator);
  if (!creator.administrator && !await companyMayCreateProjects(deps, creator)) throw agentXError("FORBIDDEN", "only a Rovara administrator can create a project");
  const naming: [] | [ClientProjectNaming] = creator.administrator ? [] : [{ perCompany: true }];
  if (url.pathname === CLIENT_REPOSITORY_CHOICES && request.method === "GET") {
    if (deps.clientRepositoryChoices === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
    const query = RepositoryChoicesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success || new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) {
      throw agentXError("CONFIG_INVALID", "invalid repository search: use q, limit (1 to 100) and after, once each");
    }
    return await deps.clientRepositoryChoices(creator.developerId, query.data) satisfies ClientRepositoryChoicesResponse;
  }
  if (url.pathname === CLIENT_PROJECTS_BULK && request.method === "POST") {
    if (deps.createClientProjectsBulk === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
    const parsed = BulkCreateClientProjectsRequestSchema.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `invalid projects: ${parsed.error.issues[0]?.path.join(".") || "request"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const answer = await deps.createClientProjectsBulk(creator.developerId, parsed.data, ...naming);
    logDeveloperEvent({
      event: "client.projects_bulk_created", clientId: creator.client.clientId, by: creator.developerId,
      ...(creator.companyId === undefined ? {} : { companyId: creator.companyId }), asked: parsed.data.repositories.length,
      created: answer.results.filter((row) => row.outcome === "created").length,
    });
    return answer satisfies BulkCreateClientProjectsResponse;
  }
  if (!(url.pathname === "/v1/dev/client/projects" && request.method === "POST")) {
    if (deps.clientRepositories === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
    return { installations: await deps.clientRepositories(creator.developerId) } satisfies ClientRepositoriesResponse;
  }
  return routeClientCreateProjectBody(deps, request, creator, naming);
}

async function routeClientCreateProjectBody(
  deps: DeveloperRouteDependencies,
  request: AdaptedHttpRequest,
  creator: Awaited<ReturnType<typeof authenticateClientToken>>,
  naming: [] | [ClientProjectNaming],
): Promise<unknown> {
  const body = jsonBody(request);
  if (body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "repositories")) {
    if (deps.createClientProjects === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
    const many = CreateClientProjectsRequestSchema.safeParse(body);
    if (!many.success) throw agentXError("CONFIG_INVALID", `invalid project: ${many.error.issues[0]?.path.join(".") || "request"}: ${many.error.issues[0]?.message ?? "invalid"}`);
    const created = await deps.createClientProjects(creator.developerId, many.data, ...naming);
    logDeveloperEvent({
      event: "client.project_created", clientId: creator.client.clientId, by: creator.developerId, project: created.name, repositories: many.data.repositories.length,
      ...(creator.companyId === undefined ? {} : { companyId: creator.companyId }),
    });
    return readClientProject(deps, creator.developerId, created.name, namedCompany(created.companyId) ?? creator.companyId);
  }
  if (deps.createClientProject === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
  const parsed = CreateClientProjectRequestSchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `invalid project: ${parsed.error.issues[0]?.path.join(".") || "request"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const created = await deps.createClientProject(creator.developerId, parsed.data, ...naming);
  console.log(JSON.stringify({ component: "broker", event: "client.project_created", clientId: creator.client.clientId, by: creator.developerId, project: created.name }));
  return readClientProject(deps, creator.developerId, created.name, namedCompany(created.companyId) ?? creator.companyId);
}

async function routeClientProjectMembers(
  deps: DeveloperRouteDependencies,
  request: AdaptedHttpRequest,
  rawProject: string,
  rawTarget: string | undefined,
  route: DevRoute,
): Promise<unknown> {
  const caller = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, caller);
  const person = await getSignIn<Pick<DeveloperRecord, "revoked" | "displayName">>(deps, `DEVELOPER#${caller.developerId}`);
  if (person === undefined || person.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const project = decodeURIComponent(rawProject);
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  const actions = memberActions(deps);
  const grantCompany = await liveNamedCompany(deps, caller.developerId);
  const namedCaller = namedCompany(caller.companyId);
  const latest = namedCaller !== undefined
    ? await namedCompanyLatestRevisionRow(deps.documentClient, deps.tableName, namedCaller, project)
    : ((await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, Limit: 1, ScanIndexForward: false, ConsistentRead: true,
    }))) as { Items?: unknown[] }).Items?.[0];
  if (caller.companyId !== undefined && (latest === undefined || (namedCaller === undefined && !recordInCompany(latest, caller.companyId)))) throw agentXError("NOT_FOUND", "project not found");
  const own = await projectGrant(actions, project, caller.developerId, grantCompany);
  if (!caller.administrator && own?.role !== "administrator" && !await companyManagesProject(deps, caller, project)) throw agentXError("FORBIDDEN", CLIENT_MEMBERS_NOT_ALLOWED);
  if (latest === undefined) throw agentXError("NOT_FOUND", `project ${project} is not registered`);
  return executeClientProjectMembersChange(deps, actions, caller, project, grantCompany, request.method, rawTarget);
}

async function executeClientProjectMembersChange(
  deps: DeveloperRouteDependencies,
  actions: ReturnType<typeof memberActions>,
  caller: Awaited<ReturnType<typeof authenticateClientToken>>,
  project: string,
  grantCompany: string | undefined,
  method: string,
  rawTarget: string | undefined,
): Promise<unknown> {
  const by = { issuer: `sign-in-client:${caller.client.clientId}`, subject: caller.developerId };
  if (method === "GET" && rawTarget === undefined) {
    const listed = await listProjectMembers(actions, project, grantCompany);
    const named = await Promise.all(listed.map(async (member) => ({
      ...member,
      name: profileDisplayName((await getSignIn<Pick<DeveloperRecord, "displayName" | "provider" | "subject">>(deps, `DEVELOPER#${member.developerId}`)) ?? {}) ?? "Unknown",
    })));
    return { project, members: named } satisfies ClientProjectMembersResponse;
  }
  if (rawTarget === undefined || (method !== "PUT" && method !== "DELETE")) throw agentXError("NOT_FOUND", "route not found");
  const target = await resolveDeveloper(actions, decodeURIComponent(rawTarget), grantCompany ?? caller.companyId);
  if (method === "PUT") {
    const granted = await grantProjectAccess(actions, by, project, target.developerId, grantCompany);
    console.log(JSON.stringify({ component: "broker", event: "client.project_member_granted", clientId: caller.client.clientId, by: caller.developerId, developerId: target.developerId, project, already: granted.already }));
    return { project, developerId: target.developerId, outcome: granted.already ? "already_member" : "granted" } satisfies ClientProjectMemberChangeResponse;
  }
  const revoked = await revokeProjectAccess(actions, project, target.developerId, grantCompany);
  console.log(JSON.stringify({ component: "broker", event: "client.project_member_revoked", clientId: caller.client.clientId, by: caller.developerId, developerId: target.developerId, project, revoked: revoked.revoked }));
  return { project, developerId: target.developerId, outcome: revoked.revoked ? "revoked" : "not_member" } satisfies ClientProjectMemberChangeResponse;
}

/**
 * Spec 065: a sign-in client acting as the signed-in person, within its scopes and the person's own rights. 065a: a
 * project's members, which only the project's administrators or a Rovara administrator may see and change.
 */
export async function routeClientRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  if (url.pathname === COMPANY_AUDIT_RECORDS_PATH || url.pathname === COMPANY_EVENTS_PATH) return routeClientCompanyAudit(deps, request, url, route);
  const isProjectCreation = (url.pathname === "/v1/dev/client/projects" && request.method === "POST")
    || (url.pathname === CLIENT_PROJECTS_BULK && request.method === "POST")
    || (url.pathname === CLIENT_REPOSITORY_CHOICES && request.method === "GET")
    || (url.pathname === "/v1/dev/client/repositories" && request.method === "GET");
  if (isProjectCreation) return routeClientProjectCreation(deps, request, url, route);
  const lifecycle = CLIENT_LIFECYCLE.exec(url.pathname);
  if (lifecycle !== null) return routeClientLifecycle(deps, request, lifecycle[1]!, lifecycle[2] as LifecycleAction, route);
  const settings = CLIENT_CODE_SETTINGS.exec(url.pathname);
  if (settings !== null && (request.method === "GET" || request.method === "PUT")) return routeClientCodeSettings(deps, request, settings[1]!, route);
  const setupStatus = CLIENT_SETUP_STATUS.exec(url.pathname);
  if (setupStatus !== null && (request.method === "GET" || request.method === "PUT")) return routeClientSetupStatus(deps, request, setupStatus[1]!, setupStatus[2] as "/skips" | "/eval-none" | undefined, route);
  const read = CLIENT_PROJECT.exec(url.pathname);
  if (read !== null && request.method === "GET") {
    const reader = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
    requireRouteScope(route, reader);
    const project = decodeURIComponent(read[1]!);
    if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
    return readClientProject(deps, reader.developerId, project, reader.companyId);
  }
  const members = CLIENT_MEMBERS.exec(url.pathname);
  if (members === null) throw agentXError("NOT_FOUND", "route not found");
  return routeClientProjectMembers(deps, request, members[1]!, members[2], route);
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller, companyId?: string): Promise<DeveloperProjectsResponse> {
  // Company mode, with or without the workspace service: the caller's company filters every project the list shows (the install's own team is the implicit company's).
  companyId ??= companySlackMode(deps) ? await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) : undefined;
  const grants = await grantsOf(deps, caller, companyId);
  const bindings = await bindingsOf(deps, undefined, companyId);
  const policies = await projectsWithPolicy(deps, [...grants, ...bindings.map((binding) => binding.projectName)], companyId);
  const access = await resolveDeveloperAccess({
    ...(deps.workspaces === undefined || companyId === undefined ? {} : { companyId }),
    grants: companyId === undefined ? grants : grants.filter((name) => policies.has(name)),
    bindings: companyId === undefined ? bindings : bindings.filter((binding) => policies.has(binding.projectName)),
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const listed = [...access.projects].filter(([name]) => policies.has(name));
  // Like checkProjectAccess: a caller with no Slack link is never shown channel names.
  const names = caller.slackUserId === undefined || companySlackMode(deps) ? new Map<string, { name: string; isPrivate: boolean }>() : await channelNames(deps, listed.flatMap(([, entry]) => entry.channels));
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of listed) {
    const known = policies.get(name)!;
    if (deps.workspaces !== undefined && caller.slackUserId !== undefined) {
      names.clear();
      const teams = [...new Set(bindings.filter((row) => row.projectName === name).map((row) => row.teamId))];
      if (teams.length === 1 && companyId !== undefined) for (const [id, label] of await channelNames(deps, entry.channels, { companyId, teamId: teams[0]! })) names.set(id, label);
    }
    projects.push({ name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

/**
 * FR-018's first three checks, in order, for one project; the start route calls it (Task 8), and
 * every route must call it before a DeveloperTaskActions member that trusts its caller.
 * PROJECT_NOT_FOUND, then PROJECT_ACCESS_DENIED (naming only public bound channels, R10), or
 * SLACK_UNAVAILABLE when only a channel could have given access and Slack is down, then
 * PROJECT_TASKS_DISABLED.
 */
export async function checkProjectAccess(
  deps: DeveloperRouteDependencies,
  caller: ProjectAccessSubject,
  project: string,
  membership?: { freshMemberOf: readonly string[] },
): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; companyId?: string }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const companyId = companySlackMode(deps) ? await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) : undefined;
  const known = (await projectsWithPolicy(deps, [project], companyId)).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  const grants = (await grantsOf(deps, caller, companyId)).filter((name) => name === project);
  const requestedWorkspace = deps.workspace === undefined ? undefined : await callerWorkspace(deps, caller, { companyId: deps.workspace.companyId }, deps.workspace.teamId);
  const bindings = (await bindingsOf(deps, requestedWorkspace, companyId)).filter((binding) => binding.projectName === project);
  const teams = [...new Set(bindings.map((binding) => binding.teamId))];
  if (deps.workspaces !== undefined && teams.length > 1) throw new SlackWorkspaceRefused();
  const workspace = deps.workspaces === undefined || teams.length === 0 ? undefined : await callerWorkspace(deps, caller, { companyId }, teams[0]);
  const projectMemberships = grants.map((projectName) => ({ projectName, role: "developer" }));
  const evaluate = (freshMemberOf?: readonly string[]) => evaluateProjectAuthority({
    project,
    revision: { revision: known.revision, definition: { developerTasks: known.policy } },
    memberships: projectMemberships,
    bindings,
    ...(freshMemberOf === undefined ? {} : { freshMemberOf }),
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  });
  let result = evaluate(membership?.freshMemberOf);
  if (result.kind === "needs-membership") {
    const memberOf = new Set<string>();
    for (let start = 0; start < result.channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const response = await safeChannelMembers(deps)({
        kind: "channel-members", slackUserId: caller.slackUserId!, channelIds: result.channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS), ...(workspace === undefined ? {} : { workspace }),
      });
      if (!response.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
      for (const channelId of response.memberOf) memberOf.add(channelId);
    }
    result = evaluate([...memberOf]);
  }
  if (result.kind === "unavailable") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  if (result.kind === "needs-membership") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "denied") {
    if (result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
    // Only a channel that would give access is worth naming, and only a public one (R10).
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, result.visibleChannelIds, workspace)).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  // DEC 254zzz98 (re-review H): the caller's company as resolved here, so the start can check the project row it actually loads (developer-tasks.ts startTask).
  return { revision: result.revision, policy: result.policy, access: result.access, channelIds: result.channelIds, ...(companyId === undefined ? {} : { companyId }) };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, project: string, company?: OrgId): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  // DEC 254zzz80: a named company's workspaces are listed from its own index partition (`workspaceProjectIndexValue`), never the bare name another company's project may share;
  // an item there must name this company (`orgId` or `companyId`) and no other: one that names another company, or none, is drift and left out.
  const ownCompany = (item: Record<string, unknown>) => company === undefined
    || ((item.orgId === company || item.companyId === company) && ownPartitionRow(item, company) && item[WORKSPACE_PROJECT_INDEX.partitionKey] === workspaceProjectIndexValue(company, project));
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": company === undefined ? project : workspaceProjectIndexValue(company, project) },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []).filter((item) => item.entityType !== "WORKSPACE_COMPANY_POINTER" && ownCompany(item)));
    start = items.length >= DEVELOPER_WORKSPACES_PER_PROJECT ? undefined : response.LastEvaluatedKey;
  } while (start !== undefined);

  const workspaces: DeveloperWorkspace[] = [];
  for (const item of items.slice(0, DEVELOPER_WORKSPACES_PER_PROJECT)) {
    const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
    // A record this release cannot read is left out rather than failing the whole listing.
    if (!parsed.success) {
      logDeveloperEvent({ event: "developer.workspace_unreadable", project, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    const workspace = parsed.data;
    workspaces.push({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      status: workspace.status,
      busy: workspace.activeOperationId !== null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
  return workspaces;
}

/**
 * FR-001: the projects the caller may use, with the workspaces in each of them. The projects come
 * from listProjects itself, so this route applies exactly the same access rules (grants, and channel
 * membership only where the project's developerTasks policy allows it, failing closed).
 */
async function listWorkspaces(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperWorkspacesResponse> {
  // DEC 254zzz80: the caller's company as listProjects resolves it (live membership); a named company's listing and workspaces are read under one bounded company budget.
  const companyId = companySlackMode(deps) ? await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) : undefined;
  const company = namedCompany(companyId);
  const scope = company === undefined ? undefined : boundedCompanyReads(deps.documentClient, deps.now);
  if (scope !== undefined) deps = { ...deps, documentClient: scope.client };
  const listing = await listProjects(deps, caller, companyId);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, project.name, company));
  scope?.check();
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
}

function isTaskCommentPost(request: AdaptedHttpRequest, url: URL): boolean {
  return request.method === "POST" && /^\/v1\/dev\/tasks\/[^/]+\/comments$/.test(url.pathname);
}

/**
 * The task-local name of a person the People confirmation page shows, from the immutable PERSON row and its matching PERSON_SUBJECT row (the rows the old presentation reader used), never from the
 * live People view: that view needs the display reads, which a Slack-shared task in a deployment without them refuses, and a confirmation that cannot say whom it changes would be unusable. The page
 * calls this only after the proposal itself was read for this caller (the proposer's own pending request), so no name is given to anyone else.
 */
export async function taskPersonStoredName(deps: DeveloperRouteDependencies, taskId: string, personId: string): Promise<string | undefined> {
  const read = async (sk: string) => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk }, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const person = (await read(`PERSON#${personId}`)).Item;
  if (person === undefined || person["personId"] !== personId || typeof person["developerId"] !== "string" || typeof person["name"] !== "string") return undefined;
  const subject = (await read(`PERSON_SUBJECT#${person["developerId"]}`)).Item;
  return subject !== undefined && subject["personId"] === personId && subject["developerId"] === person["developerId"] ? person["name"] : undefined;
}

export function developerTaskRouteDependencies(
  deps: DeveloperRouteDependencies,
  caller: DeveloperCaller,
  initialSlackThread?: { teamId: string; channelId: string; threadTs: string },
  trustedCaller: DeveloperCaller | null = caller,
): DeveloperTaskRouteDependencies {
  const taskWorkspace = (task: DeveloperTaskRecord) => callerWorkspace(deps, caller, task, task.share?.teamId);
  const workspaceForProject = async (project: string): Promise<SlackWorkspaceScope | undefined> => {
    if (!companySlackMode(deps)) return undefined;
    if (deps.workspaces === undefined) throw new SlackWorkspaceRefused();
    const companyId = await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId);
    if (companyId === undefined || await latestDefinition(deps, project, companyId) === undefined) throw new SlackWorkspaceRefused();
    if (initialSlackThread !== undefined) {
      const candidate = await callerWorkspace(deps, caller, { companyId }, initialSlackThread.teamId);
      const binding = (await bindingsOf(deps, candidate)).find((row) => row.projectName === project && row.channelId === initialSlackThread.channelId);
      if (binding === undefined) throw new SlackWorkspaceRefused();
      return callerWorkspace(deps, caller, { companyId }, binding.teamId);
    }
    const teams = [...new Set((await bindingsOf(deps, undefined, companyId)).filter((row) => row.projectName === project).map((row) => row.teamId))];
    if (teams.length !== 1) throw new SlackWorkspaceRefused();
    return callerWorkspace(deps, caller, { companyId }, teams[0]);
  };
  const projectChannelIds = async (project: string, workspace?: SlackWorkspaceScope) => (await bindingsOf(deps, workspace ?? await workspaceForProject(project)))
    .filter((binding) => binding.projectName === project)
    .map((binding) => binding.channelId)
    .sort();
  // C2 (plan 4.1, decisions D1, D3): the web proof's reads, none of them Slack's. The developer record and the membership are the sign-in table's
  // own rows (the reviewed reader every sign-in uses); the grant is the project's in the TASK'S company, by grant only (no channel list, no Slack id).
  const developerRecord = async (targetDeveloperId: string): Promise<DeveloperRecord | undefined> => {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk: `DEVELOPER#${targetDeveloperId}`, sk: META }, ConsistentRead: true })) as { Item?: DeveloperRecord };
    return developerRecordKeyedBy(response.Item, targetDeveloperId); // the id lives only in the row's key (real rows have no `developerId` attribute); a disagreeing attribute refuses
  };
  const definitionReads = new Map<string, ReturnType<typeof latestDefinition>>();
  const webProof: Pick<TaskPersonIdentityDependencies, "companyMembership" | "projectGrant" | "projectMemberIds"> = {
    // C4: one bounded page of the project's side of its grants (admin-actions.ts projectMemberKey rows); each id is proved live before use.
    // DEC 254zzz80: in the TASK'S company's own partition for a named company (company-layout.ts); the legacy rows otherwise.
    projectMemberIds: async (project, limit, companyId) => {
      const response = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :developer)",
        ExpressionAttributeValues: { ":pk": projectMemberKey(project, "", companyId).pk, ":developer": "DEVELOPER#" }, ConsistentRead: true, Limit: limit,
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      const ids = (response.Items ?? []).map((item) => typeof item.sk === "string" && item.sk.startsWith("DEVELOPER#") ? item.sk.slice("DEVELOPER#".length) : "");
      return { ids, complete: response.LastEvaluatedKey === undefined };
    },
    companyMembership: async (targetDeveloperId) => {
      // Only an install with the company layer has live memberships; without it there is no web proof (unavailable, a refusal).
      if ((deps.companies ?? deps.developer.companies) === undefined) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
      const key = membershipKey(targetDeveloperId);
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (response.Item !== undefined && (response.Item.pk !== key.pk || response.Item.sk !== key.sk)) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
      return strictLiveMembership(response.Item, targetDeveloperId);
    },
    projectGrant: async (targetDeveloperId, project, companyId) => {
      // C4 read budget: one project definition read per request however many people are proved (the candidates list proves up to 200), and one
      // person's own grant rows are read up to a cap; a person with more is unreadable (a refusal), never read without bound.
      const definitionKey = `${companyId}\u0000${project}`;
      let pending = definitionReads.get(definitionKey);
      if (pending === undefined) {
        pending = latestDefinition(deps, project, companyId);
        definitionReads.set(definitionKey, pending);
        pending.catch(() => definitionReads.delete(definitionKey));
      }
      const revision = await pending;
      if (revision === undefined) throw agentXError("PROJECT_NOT_FOUND", "task person project was not found");
      const memberships = await grantRowsOf<{ pk?: string; sk?: string; projectName: string; role?: string }>(deps, targetDeveloperId, companyId, WEB_PROOF_GRANT_ROWS_MAX);
      const result = evaluateProjectAuthority({ project, revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } }, memberships, bindings: [] });
      if (result.kind === "allowed") return result.access === "granted";
      if (result.kind === "denied" && result.reason === "project-access") return false;
      throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    },
  };
  /**
   * When the Slack parts cannot be built (no Slack on this install, or no workspace for the task), only a `web` identity can still be proven:
   * a `slack` identity's check throws the very error the build threw (as before C2), and every Slack port refuses.
   */
  const webOnlyIdentityDependencies = (cause: unknown): TaskPersonIdentityDependencies => {
    const slackUnavailable = cause instanceof Error ? cause : agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    const noSlack = async (): Promise<never> => { throw slackUnavailable; };
    return {
      documentClient: deps.documentClient, tableName: deps.tableName, slackTeamId: "", now: deps.now, uuid: randomUUID, slackUnavailable,
      taskPersonProof: noSlack, developerRecord, projectChannelIds: noSlack, targetProjectAccess: noSlack, ...webProof,
      ...(trustedCaller === null ? {} : { trustedCaller }),
    };
  };
  /** A `slack` identity still refuses with the Slack build's own error; a `web` identity needs no Slack (C2). */
  const identityDependenciesOrWebOnly = async (task: DeveloperTaskRecord, admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonIdentityDependencies> => {
    try {
      return await identityDependencies(task, admission);
    } catch (error) {
      return webOnlyIdentityDependencies(error);
    }
  };
  const identityDependencies = async (task: DeveloperTaskRecord, admission?: TaskPeopleDisplayAdmission): Promise<TaskPersonIdentityDependencies> => {
    const workspace = isHostedTaskProvider(task.provider) && task.share === undefined
      ? await workspaceForProject(task.project) : await taskWorkspace(task);
    const slackTeamId = workspace?.teamId ?? deps.developer.slackTeamId;
    const taskPersonProof = admission?.proof.bind(admission) ?? deps.developer.taskPersonProof;
    if (slackTeamId === undefined || taskPersonProof === undefined) throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
    return {
      documentClient: deps.documentClient, tableName: deps.tableName, slackTeamId, now: deps.now, uuid: randomUUID, taskPersonProof,
      ...(workspace === undefined ? {} : { workspace }),
      developerRecord,
      ...webProof,
      projectChannelIds: (project) => projectChannelIds(project, workspace),
      targetProjectAccess: async (subject, project, freshMemberOf) => {
        const revision = await latestDefinition(deps, project, workspace?.companyId);
        if (revision === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        const [memberships, allBindings] = await Promise.all([
          grantRowsOf<{ projectName: string; role?: string }>(deps, subject.developerId, workspace?.companyId),
          bindingsOf(deps, workspace),
        ]);
        const result = evaluateProjectAuthority({
          project,
          revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } },
          memberships,
          bindings: allBindings,
          freshMemberOf,
          ...(subject.slackUserId === undefined ? {} : { slackUserId: subject.slackUserId }),
        });
        if (result.kind === "allowed") return result.access;
        if (result.kind === "unavailable" || result.kind === "needs-membership") {
          throw agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
        }
        if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
        if (result.kind === "denied" && result.reason === "tasks-disabled") {
          throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
        }
        // System qualification has no channel-name lookup or human-facing error decoration.
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      },
      ...(trustedCaller === null ? {} : { trustedCaller }),
    };
  };
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    taskMoneyVisible: async (task) => {
      const own = taskOwnerView(task)?.developerId === caller.developerId;
      const reader = deps.companies ?? deps.developer.companies;
      if (reader === undefined) return own;
      const membership = await reader.membershipOf?.(caller.developerId);
      if (membership === undefined) return own && await reader.companyOf(caller.developerId) === taskCompanyId(task);
      return membership.companyId === taskCompanyId(task)
        && (own || membership.role === "owner" || membership.role === "admin");
    },
    ...(deps.developer.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    issuer: deps.developer.issuer,
    ...(deps.developer.coreTasks === undefined ? {} : { coreTasks: deps.developer.coreTasks }),
    actions: deps.tasks!,
    ...(deps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: deps.workflowE2EPresentation }),
    ...(deps.workflowE2EPublicationChecks === undefined ? {} : { workflowE2EPublicationChecks: deps.workflowE2EPublicationChecks }),
    ...(deps.workflowE2EScenarioResults === undefined ? {} : { workflowE2EScenarioResults: deps.workflowE2EScenarioResults }),
    ...(deps.workflowE2EArtifact === undefined ? {} : { workflowE2EArtifact: deps.workflowE2EArtifact }),
    ...(deps.startWorkflowE2EBaseline === undefined ? {} : { startWorkflowE2EBaseline: deps.startWorkflowE2EBaseline }),
    ...(deps.validateWorkflowE2EApplicationPlan === undefined ? {} : { validateWorkflowE2EApplicationPlan: deps.validateWorkflowE2EApplicationPlan }),
    ...(deps.registeredRepositoryIdentity === undefined ? {} : { registeredRepositoryIdentity: deps.registeredRepositoryIdentity }),
    ...(deps.developer.taskPeopleConfiguration === undefined ? {} : { taskPeopleConfiguration: deps.developer.taskPeopleConfiguration }),
    ...(deps.developer.workflowDependenciesEnabled === undefined ? {} : { workflowDependenciesEnabled: deps.developer.workflowDependenciesEnabled }),
    taskPeopleStart: async task => prepareTaskPeopleStart(await identityDependenciesOrWebOnly(task), task),
    checkTaskPerson: async (task, developerId, admission) => checkTaskPersonIdentity(await identityDependenciesOrWebOnly(task, admission), task, developerId),
    // C4 (plan 4.2 "Add a person from the web"): the web proof's own reads, which need no Slack.
    registerTaskWebPerson: async (task, developerId) => registerTaskWebPerson(await identityDependenciesOrWebOnly(task), task, developerId),
    listTaskWebCandidates: async (task, limit) => listTaskWebCandidates(await identityDependenciesOrWebOnly(task), task, caller.developerId, limit),
    resolveTaskPickerPerson: async (taskId, slackUserId) => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      if (response.Item === undefined) throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      const task = response.Item;
      const dependencies = await identityDependencies(task);
      const resolved = await resolveTaskPickerPersonWithId(dependencies, task, slackUserId);
      const proof = await checkTaskPersonIdentity(dependencies, task, resolved.identity.developerId);
      const resolvedSlackUserId = resolved.identity.slackUserId;
      if (!proof.eligible || proof.identity.developerId !== resolved.identity.developerId || resolvedSlackUserId === undefined || proof.identity.slackUserId !== resolvedSlackUserId) {
        throw agentXError("PROJECT_ACCESS_DENIED", "task person identity could not be verified");
      }
      return { personId: resolved.personId, developerId: resolved.identity.developerId, slackUserId: resolvedSlackUserId, channelMember: proof.channelMember };
    },
    taskPeopleChannel: async (taskId) => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
      const share = response.Item?.share;
      if (share === undefined || typeof share.teamId !== "string" || typeof share.channelId !== "string" || typeof share.threadTs !== "string") {
        throw agentXError("PROJECT_ACCESS_DENIED", "task channel could not be verified");
      }
      return { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
    },
    ...(deps.developer.inviteTaskPerson === undefined ? {} : { inviteTaskPerson: deps.developer.inviteTaskPerson }),
    ...(deps.developer.taskPeopleDisplayRead === undefined ? {} : {
      createTaskPeopleDisplayAdmission: () => taskPeopleDisplayAdmission({ now: deps.now, read: deps.developer.taskPeopleDisplayRead! }),
      listTaskPeople: async (task: DeveloperTaskRecord, admission: TaskPeopleDisplayAdmission) => {
      const identity = await identityDependencies(task, admission);
      const workspace = identity.workspace;
      const channels = [...new Set([...(await projectChannelIds(task.project, workspace)), ...(task.share === undefined ? [] : [task.share.channelId])])].sort();
      admission.assertOpen();
      const answer = await admission.directory({ kind: "task-channel-people", channelIds: channels, ...(workspace === undefined ? {} : { workspace }) });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
      admission.assertOpen();
      const identities = await registerTaskChannelPeople(identity, task, answer.users, () => admission.assertOpen());
      admission.assertOpen();
      const bySlack = new Map(answer.users.map((user) => [user.id, user]));
      return identities.map((identity) => {
        const slackUserId = identity.slackUserId;
        const user = slackUserId === undefined ? undefined : bySlack.get(slackUserId);
        if (slackUserId === undefined || user === undefined) throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
        return { subject: { developerId: identity.developerId, slackUserId }, identity, eligible: true,
          channelMember: task.share === undefined || user.memberOf.includes(task.share.channelId) };
      });
      },
    }),
    ...(deps.refreshTaskFeedback === undefined ? {} : { refreshTaskFeedback: deps.refreshTaskFeedback.bind(deps) }),
    ...(initialSlackThread === undefined ? {} : { initialSlackThread }),
    checkAccess: async (project) => {
      try {
        const workspace = await workspaceForProject(project);
        return await checkProjectAccess(workspace === undefined ? deps : { ...deps, workspace }, caller, project);
      } catch (error) {
        // startTask audits AgentXError refusals; never expose a directory cause as an unaudited 500.
        if (error instanceof SlackWorkspaceRefused) throw agentXError("SLACK_UNAVAILABLE", "This Slack workspace is not available.");
        throw error;
      }
    },
    taskReaderPerson: (developerId, project, taskCompany, options) => taskReaderPerson(deps, developerId, project, taskCompany, options),
    ...(!companySlackMode(deps) ? {} : { workspaceForTask: taskWorkspace, workspaceForProject }),
    channelMember: async (slackUserId, channelId, workspace) => {
      if (companySlackMode(deps) && (workspace === undefined || await callerWorkspace(deps, caller, { companyId: workspace.companyId }, workspace.teamId) === undefined)) throw new SlackWorkspaceRefused();
      const answer = await safeChannelMembers(deps)({ kind: "channel-members", slackUserId, channelIds: [channelId], ...(workspace === undefined ? {} : { workspace }) });
      if (!answer.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your membership of that channel; try again shortly");
      return answer.memberOf.includes(channelId);
    },
    projectChannelIds,
    ...(deps.developer.slackRequestQueue === undefined ? {} : { slackRequestQueue: deps.developer.slackRequestQueue }),
    ...(deps.developer.channelInfo === undefined ? {} : {
      boundChannels: async (channelIds: readonly string[], workspace?: SlackWorkspaceScope) => {
        const known = await channelNames(deps, channelIds, workspace);
        return channelIds.map((channelId) => {
          const channel = known.get(channelId);
          return channel === undefined ? { channelId } : { channelId, name: channel.name, isPrivate: channel.isPrivate };
        });
      },
    }),
    now: deps.now,
  };
}

const CompanyInviteInput = z.object({ email: z.string().trim().min(3).max(320).email(), role: z.literal("member"), expiresInHours: z.number().int().min(1).max(720) }).strict();
/**
 * DEC 254h / 254zzz184: `POST` makes a single-use link; `POST .../{inviteId}/resend` atomically replaces it for a live pending invite. `DELETE`
 * withdraws the pre-approval. The secret is answered once and only its SHA-256 travels to the sign-in Lambda and is stored.
 */
async function companyPreapprovalRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<CompanyPreapprovalCreated | { ok: true }> {
  const notFound = () => agentXError("NOT_FOUND", "not found");
  if (deps.companies === undefined) throw agentXError("NOT_FOUND", "route not found");
  const isPost = request.method === "POST" && url.pathname === "/v1/dev/company/preapprovals";
  const hash = /^\/v1\/dev\/company\/preapprovals\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  const resendHash = /^\/v1\/dev\/company\/preapprovals\/([a-f0-9]{64})\/resend$/.exec(url.pathname)?.[1];
  const isResend = request.method === "POST" && resendHash !== undefined;
  if (!isPost && !isResend && !(request.method === "DELETE" && hash !== undefined)) throw notFound();
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw notFound();
  // Named scopes never authorize invitations; full access is checked before the live membership role.
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  let member: z.infer<typeof Membership>;
  try {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined) throw new Error("membership unavailable");
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
  if (member.role !== "admin" && member.role !== "owner") throw notFound();
  if (isResend && caller.webApp !== true) throw agentXError("FORBIDDEN", "resending an invite is done in the Rovara web app");
  let forwarded: CompanyPreapprovalRequest;
  let link: { secret: string; secretHash: string } | undefined;
  if (isPost) {
    const parsed = CompanyInviteInput.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "a member invitation needs an email and an expiry from 1 to 720 hours");
    link = newCompanyInviteLink();
    forwarded = { kind: "company-preapprove", companyId: member.companyId, ...parsed.data, createdBy: caller.developerId, inviteHash: link.secretHash };
  } else if (isResend) {
    const parsed = z.object({ expiresInHours: z.number().int().min(1).max(720) }).strict().safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "an invite resend needs an expiry from 1 to 720 hours");
    link = newCompanyInviteLink();
    forwarded = { kind: "company-preapproval-resend", companyId: member.companyId, emailHash: resendHash, ...parsed.data, createdBy: caller.developerId, inviteHash: link.secretHash };
  } else forwarded = { kind: "company-preapproval-withdraw", companyId: member.companyId, emailHash: hash!, createdBy: caller.developerId };
  let answer: false | { expiresAt?: number } | undefined;
  try { answer = await deps.developer.companyPreapprovals?.(forwarded); }
  catch { throw notFound(); }
  if (answer === undefined || answer === false) throw notFound();
  if (link === undefined) return { ok: true };
  // A stored pre-approval whose expiry did not come back (a broken reply): the secret is never shown; the inviter withdraws that invitation and invites again.
  if (answer.expiresAt === undefined) throw notFound();
  return { ok: true, invite: { secret: link.secret, expiresAt: new Date(answer.expiresAt * 1000).toISOString() } };
}

/**
 * DEC 253z, 254a: `POST /v1/dev/company`. A signed-in person with no company makes their own, with an operator's invite code, from the web app only.
 * The code is hashed here and only the hash travels; the sign-in Lambda counts the try, then checks the code, the switch and membership in one
 * transaction. Every code problem and a closed switch get one answer. The session still names no company afterwards: the web app signs the person
 * in again (a switch of company is a new sign-in).
 */
async function companySelfCreateRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<CompanySelfCreateResponse> {
  if (deps.companies === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  // The route table's `full` row is applied while authenticating, before anything else is read.
  const caller = await authenticateCaller(deps, request.headers.authorization, route, { companyless: true });
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", "creating a company is done in the Rovara web app");
  const create = deps.developer.companySelfCreate;
  if (create === undefined) throw agentXError("NOT_FOUND", "route not found");
  const body = CompanySelfCreateBodySchema.safeParse(jsonBody(request));
  if (!body.success) throw agentXError("CONFIG_INVALID", COMPANY_SELF_CREATE_TEXT.badName);
  // A missing, non-text or overlong code is hashed as the empty code: the same reads and the same answer as any unknown code.
  const code = typeof body.data.inviteCode === "string" && body.data.inviteCode.length <= COMPANY_INVITE_CODE_MAX ? body.data.inviteCode : "";
  const answer = await create({ kind: "company-self-create", personId: caller.developerId, name: body.data.name, codeHash: companyInviteCodeHash(code) });
  if (answer.ok) return { companyId: answer.companyId, companyName: answer.companyName, companyRole: "owner" };
  if (answer.error === "refused") throw agentXError("FORBIDDEN", COMPANY_SELF_CREATE_TEXT.refused);
  if (answer.error === "already_member") throw agentXError("ALREADY_IN_ORG", COMPANY_SELF_CREATE_TEXT.alreadyMember);
  if (answer.error === "rate_limited") throw agentXError("TOO_MANY_REQUESTS", COMPANY_SELF_CREATE_TEXT.rateLimited);
  throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
}

/** Lane LM8: the lessons API's paths (`core-host/lessons-api.ts` parses the same paths; a test holds the two equal). */
export const LESSONS_API_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons(?:\/(mode|mode\/trial-offer|weekly|weekly-summary|retire-requests|decisions|measure|tuning|replay|areas|learning-sources)|\/([^/]+)\/(approve|reject|retire|retire-request|skill|keep))?|tasks\/([^/]+)\/lessons(?:\/([^/]+)\/(not-helpful))?|lessons\/learning-sources\/([a-z0-9_]{1,40})|skills(?:\/([a-z0-9][a-z0-9-]{0,63})(?:\/(approve|retire))?)?)$/u;

/** L4-AK1H: the team knowledge reads' paths (`core-host/knowledge-api.ts` parses the same paths; a test holds the two equal). Both are POSTs (a repository's address stays out of addresses and access logs). */
export const KNOWLEDGE_API_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons|knowledge\/(?:areas|propose))$/u;

/** Lessons phase 4: the weekly cards and what a person does with them (`core-host/lessons-graduation.ts` parses the same paths, with strict ids; a test holds the two equal where they are valid). Answered by the same lessons API. */
export const LESSONS_GRADUATION_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/lessons\/(?:(graduation)|tidy\/(retire-chosen|later)|check-drafts\/([^/]+)\/(started|dismiss)|rules\/([^/]+)\/(retire)|([^/]+)\/(graduate|graduate-later|both-places))$/u;

/** The Home number's paths (`core-host/lessons-repeats-api.ts` parses the same paths; a test holds the two equal). */
export const LESSONS_REPEATS_ROUTES = /^\/v1\/dev\/(?:projects\/([^/]+)\/)?lessons\/repeats$/u;

/** Lane W part 4: the company administrator's routes (company-member-routes.ts). Unknown, before anyone is authenticated, when the deployment has no company layer or no member helper. */
async function companyAdminRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const members = deps.developer.companyMembers;
  if (deps.companies === undefined || members === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Full access only (DEC ANSWER-4): the route table's `full` row is applied while authenticating, before any membership is read.
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The member helper's caller is the signed-in person only (its schema is strict and pinned): the web-app mark (DEC 236h) is not the helper's.
  const { webApp: _webApp, ...person } = caller;
  return routeCompanyMembers({
    documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, members,
    projectsInCompany: async (names, company) => new Set((await projectsWithPolicy(deps, names, company)).keys()),
    ...(deps.developer.githubLink === undefined ? {} : { githubLinks: { store: deps.developer.githubLink.store, log: deps.developer.githubLink.log } }),
    ...(deps.developer.linearLink === undefined ? {} : { accountLinks: { store: deps.developer.linearLink.links, log: deps.developer.linearLink.log } }),
    ...(deps.developer.endDeveloperSessions === undefined ? {} : { sessions: { end: deps.developer.endDeveloperSessions, log: (entry) => logDeveloperEvent(Object.fromEntries(Object.entries(entry).filter((field): field is [string, string | number] => typeof field[1] === "string" || typeof field[1] === "number"))) } }),
    ...(taskHandOverOf(deps, person) ?? {}),
  }, { caller: person, companyId, webApp: _webApp === true }, request, url);
}

/**
 * DEC 254zzz84 (5): the task People parts a removal's hand-over needs (the successor's live proof on each task, and their registration on it), built the way the
 * task routes build them. Absent when this deployment has no developer tasks: no task is handed over then.
 */
function taskHandOverOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): { taskHandOver: NonNullable<CompanyMemberRouteContext["taskHandOver"]> } | undefined {
  if (deps.tasks === undefined) return undefined;
  const route = developerTaskRouteDependencies(deps, caller);
  const { checkTaskPerson, registerTaskWebPerson: register } = route;
  if (checkTaskPerson === undefined || register === undefined) return undefined;
  return { taskHandOver: {
    deps: { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, checkTaskPerson,
      ...(route.taskPeopleConfiguration === undefined ? {} : { taskPeopleConfiguration: route.taskPeopleConfiguration }) },
    register: (task, developerId) => register(task, developerId),
  } };
}

/** Guided onboarding PR 1: the GitHub connect routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function githubConnectRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.githubConnect;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeGithubConnect({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** L4-GH: the person's own GitHub link routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function githubLinkRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.githubLink;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeGithubLink({ documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** Guided onboarding PR 4: the Add to Slack routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function slackInstallRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.slackInstall;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeSlackInstall({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** Guided onboarding PR 5: a project's Slack channel. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function slackChannelLinkRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.slackChannels;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeSlackChannelLink({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** Guided onboarding PR 7: the Linear connect routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function linearConnectRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (isLinearAccountLinkPath(url.pathname)) return linearAccountLinkRoute(deps, request, url);
  const wiring = deps.developer.linearConnect;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeLinearConnect({
    documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, now: deps.now, wiring,
    projectInCompany: async (project, company) => (await projectsWithPolicy(deps, [project], company)).has(project),
    projectRole: async (project, personId, company) => (await projectGrant(memberActions(deps), project, personId, company))?.role,
    // A project's first tracker team: where the new-hosted-project ticket-updates default is saved (once, only if none is saved), for a company whose tasks start on the core.
    ...(deps.developer.coreIntake === undefined ? {} : { onFirstTeam: async (company: string, project: string, personId: string) => { await deps.developer.coreIntake!.seedTicketUpdates(OrgIdSchema.parse(company), project, personId); } }),
  }, caller, companyId, request, url);
}

/** R1 + L1: the member's own Linear link routes and the admin's list of links. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function linearAccountLinkRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.linearLink;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeLinearAccountLink({ documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** Guided onboarding PR 14: the company engine model route. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function companyEngineModelRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.companyEngineModel;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Full access only (the route table's row), checked while authenticating, before any membership is read.
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeCompanyEngineModel({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request);
}

const MACHINE_SIZE_ON_THE_PAGE = "Changing the machine size needs the Rovara web page";
const MACHINE_SIZE_ROLE_REQUIRED = "Only a company owner or admin, or this project's administrator, may choose a machine size";
export function requireMachineSizePage(caller: DeveloperCaller): void {
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", MACHINE_SIZE_ON_THE_PAGE);
}
export function requireMachineSizeRole(companyAdmin: boolean, projectAdmin: boolean): void {
  if (!companyAdmin && !projectAdmin) throw agentXError("FORBIDDEN", MACHINE_SIZE_ROLE_REQUIRED);
}

/** Hosted TE-C5 read and page-only stored choice. A selection is a project setting; it never changes a worker launch or task estimate. */
async function checkedMachineSize(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, rawProject: string): Promise<unknown> {
  if (!machineSizeEnabled()) throw agentXError("NOT_AVAILABLE_HERE", "Machine size suggestions are not set up here.");
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (request.method === "POST") requireMachineSizePage(caller);
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", "project not found"); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  const projects = await listProjects(deps, caller, companyId);
  if (!projects.projects.some((entry) => entry.name === project)) throw agentXError("NOT_FOUND", "project not found");
  const orgId = companyId ?? IMPLICIT_COMPANY_ID;
  const store = new DynamoDocumentStore({ client: deps.documentClient, tableName: deps.tableName });
  const testEnvDeps = { store, now: deps.now };
  if (request.method === "POST") {
    const membership = await deps.companies?.membershipOf?.(caller.developerId);
    const companyAdmin = membership !== undefined && membership.companyId === companyId && (membership.role === "owner" || membership.role === "admin");
    const own = await projectGrant(memberActions(deps), project, caller.developerId, companyId);
    requireMachineSizeRole(companyAdmin, own?.role === "administrator");
    const body = jsonBody(request);
    const rowId = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["rowId"] : undefined;
    if (typeof rowId !== "string" || !MACHINE_SIZE_ROWS.some((row) => row.id === rowId)) throw agentXError("CONFIG_INVALID", "Choose one of the listed machine sizes");
    await setMachineChoice(testEnvDeps, { orgId, project, rowId });
    logDeveloperEvent({ event: "project.machine_size_chosen", companyId: orgId, by: caller.developerId, project, rowId });
  }
  const view = await testEnvironmentView(testEnvDeps, orgId, project);
  const card = await machineCard(testEnvDeps, orgId, project, view.proposal?.digest ?? view.approved?.digest);
  return { measuredPeakMemoryMiB: card?.measuredPeakMemoryMiB ?? null, testTimeMs: card?.testTimeMs ?? null,
    suggestedSize: card?.suggestedRowId ?? null, currentSize: card?.chosenRowId ?? null, storedOnlyLine: MACHINE_STORED_ONLY_LINE, choices: card?.choices ?? [] };
}

/** No SDK or parser causes leave the hosted route. */
async function routeMachineSize(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, rawProject: string): Promise<unknown> {
  try { return await checkedMachineSize(deps, caller, request, rawProject); }
  catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "Machine size settings are unavailable. Try again in a moment.");
  }
}

/** L4-EGR: the company's view of Rovara's outbound addresses. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function companyEgressRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.companyEgress;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Full access only (the route table's row), checked while authenticating, before any membership is read.
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeCompanyEgress({ documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, wiring }, caller, companyId, request);
}

/**
 * L4-AK1H: `POST /v1/dev/projects/{project}/lessons` and `POST .../knowledge/areas` on a hosted install. A script token (`Bearer rvst_...`) is checked by the knowledge API itself (it reaches only these two reads, and only with the
 * `lessons` permission naming the project); anything else is a person's sign-in, verified like every other developer route (the row's scope applies). The company is never read from the request.
 */
async function knowledgeRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, route: DevRoute): Promise<unknown> {
  const wire = { method: request.method, path: url.pathname, authorization: request.headers.authorization, ...(request.body === undefined ? {} : { body: request.body }) };
  if (isScriptTokenHeader(request.headers.authorization)) {
    if (deps.knowledge === undefined) throw agentXError("AUTH_REQUIRED", "Script tokens are turned off here.");
    return deps.knowledge.answer(wire, { kind: "token" });
  }
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  if (deps.knowledge === undefined) return knowledgeSwitchedOff(wire, deps.now());
  return deps.knowledge.answer(wire, { kind: "person", personId: caller.developerId });
}

function makeSessionAuthenticator(deps: DeveloperRouteDependencies): (sessionId: string) => Promise<DeveloperCaller | undefined> {
  return async (sessionId) => {
    try { return await authenticateDeveloperSessionId(deps, sessionId); }
    catch { return undefined; }
  };
}

function routeReviewLinkPage(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const links = deps.channelLinks;
  if (links === undefined && deps.channelLinkCodes === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
  return createChannelLinkWeb({
    origin: deps.developer.issuer,
    authenticateSession: makeSessionAuthenticator(deps),
    preview: (code, personId) => deps.channelLinkCodes === undefined ? previewLinkCode(links!, code) : deps.channelLinkCodes.preview(personId, code),
    redeem: (developerId, code) => deps.channelLinkCodes === undefined ? redeemLinkCode(links!, developerId, code) : deps.channelLinkCodes.redeem(developerId, code),
  })(request, url);
}

function routeReviewRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // D1 (owner DEC 254zzz511): Code's own HTML task page and the old PR-feedback review page are deleted (they served only the old workflow engine's tasks: a core task was always "no task" there).
  // The one page that stays is the People confirmation (people-confirm-web.ts): an AI tool or script proposes a role or ownership change and hands a person this link, and confirming it is a
  // human-in-the-loop security step. Every other /review/ path (besides the channel link page) is a path nobody serves.
  if (deps.tasks === undefined || !(PEOPLE_CONFIRM_PAGE.test(url.pathname) || PEOPLE_CONFIRM_API.test(url.pathname))) throw agentXError("NOT_FOUND", "route not found");
  const routeDeps = (caller: DeveloperCaller) => developerTaskRouteDependencies(deps, caller);
  return createPeopleConfirmWeb({
    origin: deps.developer.issuer,
    authenticateSession: makeSessionAuthenticator(deps),
    getRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
    getMetadata: (caller, taskId, requestId) => getTaskPeopleProposalMetadata(routeDeps(caller), caller, taskId, requestId),
    getPersonName: (_caller, taskId, personId) => taskPersonStoredName(deps, taskId, personId),
    confirm: (caller, taskId, requestId) => confirmTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
  })(request, url);
}

function routePreAuthDeveloperPath(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> | undefined {
  if (isServerReadRequest(request.method, url.pathname)) return routeServerRead(deps, request, url);
  if (isCompanyMemberPath(url.pathname)) return companyAdminRoute(deps, request, url);
  if (isGithubConnectPath(url.pathname)) return githubConnectRoute(deps, request, url);
  if (isGithubLinkPath(url.pathname)) return githubLinkRoute(deps, request, url);
  if (isSlackChannelLinkPath(url.pathname)) return slackChannelLinkRoute(deps, request, url);
  if (isSlackInstallPath(url.pathname)) return slackInstallRoute(deps, request, url);
  if (isLinearConnectPath(url.pathname)) return linearConnectRoute(deps, request, url);
  if (isCompanyEngineModelPath(url.pathname)) return companyEngineModelRoute(deps, request, url);
  if (isCompanyLearningModelPath(url.pathname)) return companyLearningModelRoute(deps, request, url);
  if (isCompanyEgressPath(url.pathname)) return companyEgressRoute(deps, request, url);
  if (url.pathname === "/v1/dev/company/preapprovals" || url.pathname.startsWith("/v1/dev/company/preapprovals/")) return companyPreapprovalRoute(deps, request, url);
  if (url.pathname === "/v1/dev/company") return companySelfCreateRoute(deps, request, url);
  // Spec 062 FR-031: the page a link_required event links to. Signed in like the task page, but needs no tasks.
  if (url.pathname.startsWith("/review/link/")) return routeReviewLinkPage(deps, request, url);
  if (url.pathname.startsWith("/review/")) return routeReviewRequest(deps, request, url);
  return undefined;
}

async function routeStartEstimates(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<unknown> {
  const core = deps.developer.coreTasks;
  if (core === undefined) throw agentXError("NOT_FOUND", "Start estimates are not available on this install.");
  const answer = await core.route({ method: request.method, path: request.path, headers: {}, ...(request.body === undefined ? {} : { body: request.body }), requestId: request.requestId }, caller);
  if (answer === undefined) throw agentXError("NOT_FOUND", "Start estimates are not available on this install.");
  return coreAnswerValue(answer);
}

async function routeDeveloperProjectsList(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<unknown> {
  const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  const result = await listProjects(scope === undefined ? deps : { ...deps, documentClient: scope.client }, caller, companyId);
  scope?.check();
  return result;
}

function routeDeveloperLessonsRequest(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> | undefined {
  // Lane LM8: the lessons API answers as the signed-in person; the company comes from their membership, inside it.
  if (LESSONS_API_ROUTES.test(url.pathname) || LESSONS_GRADUATION_ROUTES.test(url.pathname)) {
    if (deps.lessons === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    return deps.lessons.answer({ method: request.method, path: url.pathname, query: url.searchParams, ...(request.body === undefined ? {} : { body: request.body }) }, { personId: caller.developerId });
  }
  if (url.pathname === "/v1/dev/company/lessons/local-tools" || /^\/v1\/dev\/projects\/[^/]+\/lessons\/local-tools$/u.test(url.pathname)) { // L4-JA7 (core-host/knowledge-switch-api.ts parses the same paths; a test holds the two equal)
    // Where the core does not serve (no switch API), the routes are there but not served: a fixed answer that is not "route not found" (named-scopes: a route row is never an unknown route).
    if (deps.knowledgeSwitch === undefined) throw agentXError("NOT_FOUND", "These settings are not available on this install.");
    return deps.knowledgeSwitch.answer({ method: request.method, path: url.pathname, ...(request.body === undefined ? {} : { body: request.body }) }, { personId: caller.developerId, webApp: caller.webApp === true });
  }
  if (url.pathname === "/v1/dev/me/lessons-slack") { // L4-SRC-SL (core-host/lessons-slack-switch-api.ts parses the same path; a test holds the two equal)
    if (deps.lessonsSlackSwitch === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    return deps.lessonsSlackSwitch.answer({ method: request.method, path: url.pathname, ...(request.body === undefined ? {} : { body: request.body }) }, { personId: caller.developerId });
  }
  if (LESSONS_REPEATS_ROUTES.test(url.pathname)) {
    if (deps.lessonRepeats === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    return deps.lessonRepeats.answer({ method: request.method, path: url.pathname, query: url.searchParams }, { personId: caller.developerId });
  }
  return undefined;
}

function isCheckedTaskRead(request: AdaptedHttpRequest, url: URL): boolean {
  return request.method === "GET" && (url.pathname === "/v1/dev/tasks" || /^\/v1\/dev\/tasks\/[^/]+(?:\/(messages|diff|comments|events|readers))?$/.test(url.pathname));
}

function wrapTaskDepsForCompanyReads(taskDeps: DeveloperTaskRouteDependencies, scope: ReturnType<typeof boundedCompanyReads> | undefined): DeveloperTaskRouteDependencies {
  if (scope === undefined) return taskDeps;
  return {
    ...taskDeps,
    actions: companyReadActions(taskDeps.actions, scope),
    ...(taskDeps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: (input: Parameters<NonNullable<DeveloperTaskRouteDependencies["workflowE2EPresentation"]>>[0]) => scope.read(() => taskDeps.workflowE2EPresentation!(input)) }),
  };
}

async function routeDeveloperTasksRequest(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
  const checked = isCheckedTaskRead(request, url);
  const scope = checked && deps.companies !== undefined ? boundedCompanyReads(deps.documentClient) : undefined;
  const commenting = isTaskCommentPost(request, url);
  // Reuse this route's live membership for money visibility; never read it again per task.
  let membership: Awaited<ReturnType<NonNullable<CompanyMembershipReader["membershipOf"]>>>;
  const companies = deps.companies;
  const checkedCompanies = companies?.membershipOf === undefined ? companies : {
    companyOf: async (personId: string) => {
      membership = await companies.membershipOf!(personId);
      return membership?.companyId;
    },
  };
  const companyId = checked || commenting ? await resolveCompany(checkedCompanies, caller.developerId) : undefined;
  const taskDeps = developerTaskRouteDependencies(scope === undefined ? deps : { ...deps, documentClient: scope.client }, caller);
  if (checked && companies !== undefined) {
    taskDeps.taskMoneyVisible = async (task) => recordInCompany(task, companyId)
      && (taskOwnerView(task)?.developerId === caller.developerId || membership?.role === "owner" || membership?.role === "admin");
  }
  const checkedDeps = wrapTaskDepsForCompanyReads(taskDeps, scope);
  const result = await routeDeveloperTaskRequest({
    ...checkedDeps, ...(companyId === undefined ? {} : { companyId }),
  }, caller, request, url);
  // Only a completed list page with an explicit continuation may consume an item-bound signal.
  scope?.check(url.pathname === "/v1/dev/tasks" && result !== null && typeof result === "object" && "nextCursor" in result);
  return result;
}

function routeAuthenticatedDeveloperRequest(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // The preview is read-only; the core resolves live company membership and project access.
  if (/^\/v1\/dev\/projects\/([^/]+)\/start-estimates$/u.test(url.pathname)) return routeStartEstimates(deps, caller, request);
  const machineSize = /^\/v1\/dev\/projects\/([^/]+)\/machine-size$/u.exec(url.pathname);
  if (machineSize !== null && (request.method === "GET" || request.method === "POST")) return routeMachineSize(deps, caller, request, machineSize[1]!);
  const settings = /^\/v1\/dev\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (settings !== null) return projectSettingsRoute(deps, caller, request, settings[1]!);
  if (url.pathname === "/v1/dev/company/settings-compliance") return projectSettingsComplianceRoute(deps, caller, url);
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return routeDeveloperProjectsList(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (request.method === "PUT" && url.pathname === "/v1/dev/me/name") return setMyName(deps, caller, request);
  if (/^\/v1\/dev\/(?:me\/sign-ins(?:\/link|\/link\/finish|\/[^/]+)?|company\/members\/[^/]+\/sign-ins(?:\/[^/]+)?)$/.test(url.pathname)) return routeSignInLinks(deps.developer.signInLinks, caller, request, url); // DEC 254w: connected sign-ins (sign-in-link-routes.ts).
  const lessonsResponse = routeDeveloperLessonsRequest(deps, caller, request, url);
  if (lessonsResponse !== undefined) return lessonsResponse;
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) return routeDeveloperTasksRequest(deps, caller, request, url);
  if (url.pathname === CHATGPT_CONNECTION_PATH || url.pathname === `${CHATGPT_CONNECTION_PATH}/finish`) return routeChatGptConnection(deps, caller, request, url);
  if (url.pathname === "/v1/dev/channel-links" || url.pathname.startsWith("/v1/dev/channel-links/")) return routeOwnChannelLinks(deps, caller, request, url);
  throw agentXError("NOT_FOUND", "route not found");
}

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const preAuth = routePreAuthDeveloperPath(deps, request, url);
  if (preAuth !== undefined) return preAuth;
  // Plan v3.2 lane ID: a method and path with no row in the route table is refused before anyone is authenticated.
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  // Spec 063 FR-004: a registered service's own route, authenticated as such, never as a Rovara caller.
  if (request.method === "POST" && url.pathname === "/v1/dev/access") return checkSignInAccess(deps, request);
  // Spec 065: a registered service acting as its signed-in person, within its scopes.
  if (url.pathname.startsWith("/v1/dev/client/")) return routeClientRequest(deps, request, url);
  // L4-AK1H: team knowledge for a tool outside Rovara: a signed-in person, or a script token with the Team knowledge permission. It is answered before the person sign-in below because a script token is not a JWT.
  if (request.method === "POST" && KNOWLEDGE_API_ROUTES.test(url.pathname)) return knowledgeRoute(deps, request, url, route);
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  return routeAuthenticatedDeveloperRequest(deps, caller, request, url);
}

/**
 * Lane L12: the core engine's own /v1/app/* routes. Like /v1/dev/*, no API Gateway authorizer runs on them: a method and path with no row in the route table (APP_ROUTES), or any
 * /v1/app/* path where no core is wired (no `coreApp`), is refused before anyone is authenticated; otherwise the broker verifies the developer token, checks the row's scope and
 * hands the signed-in caller (with its verified sign-in method) to the core, which takes the company from live membership. The core's answer is returned as it is (its status and body), never cached.
 */
export async function routeAppRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<BrokerResponse> {
  const core = deps.developer.coreApp;
  if (core === undefined) throw agentXError("NOT_FOUND", "route not found");
  // The core matches the raw path; a path the URL parser would read differently (a backslash, say) is refused rather than matched two ways.
  if ((request.path.split("?")[0] ?? "") !== url.pathname) throw agentXError("NOT_FOUND", "route not found");
  const route = appRouteOf(request.method, url.pathname);
  if (route === undefined) {
    // #1175: a path the core may serve but the route table does not list is refused here, before auth; say so once, bounded (method and the first
    // three path segments only: never a project, task or person id).
    logDeveloperEvent({ event: "developer.app_route_unlisted", method: request.method.slice(0, 10), path: url.pathname.split("/").slice(0, 4).join("/").slice(0, 80) });
    throw agentXError("NOT_FOUND", "route not found");
  }
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  // The core gets the request without its credentials: the caller is already the verified one.
  const { authorization: _credential, ...headers } = request.headers;
  void _credential;
  const answer = await core.route({ method: request.method, path: request.path, headers, ...(request.body === undefined ? {} : { body: request.body }), requestId: request.requestId }, caller);
  if (answer === undefined) throw agentXError("NOT_FOUND", "route not found");
  // Never cached: a made script token is in its body.
  return { ...answer, headers: { ...answer.headers, "cache-control": "no-store" } };
}

/**
 * Spec 064: the legacy deployment's developer API: the link page, a registered service's access check, a person's own
 * links, and (spec 066) their projects and workspaces. Tasks and ChatGPT sign-in are not there: the legacy deployment
 * runs no task workflow.
 */
export async function routeLinkingRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname.startsWith("/review/link/")) return routeDeveloperRequest(deps, request, url);
  // Plan v3.2 lane ID: as routeDeveloperRequest, only a route in the table.
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  if (request.method === "POST" && url.pathname === "/v1/dev/access") return checkSignInAccess(deps, request);
  if (url.pathname.startsWith("/v1/dev/client/")) return routeClientRequest(deps, request, url);
  const projects = request.method === "GET" && url.pathname === "/v1/dev/projects";
  const workspaces = request.method === "GET" && url.pathname === "/v1/dev/workspaces";
  const links = url.pathname === "/v1/dev/channel-links" || url.pathname.startsWith("/v1/dev/channel-links/");
  const name = request.method === "PUT" && url.pathname === "/v1/dev/me/name";
  if (!projects && !workspaces && !links && !name) throw agentXError("NOT_FOUND", "route not found");
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  if (projects) {
    const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
    const companyId = await resolveCompany(deps.companies, caller.developerId);
    const result = await listProjects(scope === undefined ? deps : { ...deps, documentClient: scope.client }, caller, companyId);
    scope?.check();
    return result;
  }
  if (name) return setMyName(deps, caller, request);
  if (workspaces) return listWorkspaces(deps, caller);
  return routeOwnChannelLinks(deps, caller, request, url);
}

/** Spec 062 FR-031: a developer lists and removes their own channel links, and only theirs. */
async function routeOwnChannelLinks(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const links = deps.channelLinks;
  if (links === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
  if (url.pathname === "/v1/dev/channel-links" && request.method === "GET") return { links: await listDeveloperLinks(links, caller.developerId) };
  const one = /^\/v1\/dev\/channel-links\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (one !== null && request.method === "DELETE") {
    const actor = ActorRefSchema.safeParse({ channel: decodeURIComponent(one[1]!), tenant: decodeURIComponent(one[2]!), userId: decodeURIComponent(one[3]!) });
    if (!actor.success || actor.data.channel === "slack") throw agentXError("NOT_FOUND", "link not found");
    return removeLink(links, actor.data, caller.developerId);
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/** Sign in with ChatGPT (#338): the caller's own connection, and only theirs. No route answers a token. */
export const CHATGPT_CONNECTION_PATH = "/v1/dev/chatgpt/connection";

async function routeChatGptConnection(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.chatgpt === undefined) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
  const finish = url.pathname.endsWith("/finish");
  if (finish && request.method === "POST") return deps.chatgpt.finish(caller.developerId, jsonBody(request));
  if (!finish && request.method === "GET") return deps.chatgpt.view(caller.developerId);
  if (!finish && request.method === "POST") return deps.chatgpt.start(caller.developerId);
  if (!finish && request.method === "DELETE") return deps.chatgpt.disconnect(caller.developerId);
  throw agentXError("NOT_FOUND", "route not found");
}

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/** DEC 254zzz63: the company learning model route. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function companyLearningModelRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.companyLearningModel;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Full access only (the route table's row), checked while authenticating, before any membership is read.
  const caller = await authenticateCaller(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeCompanyLearningModel({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request);
}

const START_REQUEST_READ_PATH = "/v1/dev/tasks/start-requests/{requestId}";
const START_REQUEST_READ_PREFIX = START_REQUEST_READ_PATH.slice(0, -"{requestId}".length);

/** Exact methods only. Malformed start selectors remain owned by the dedicated validator. */
export function isServerReadRequest(method: string, path: string): boolean {
  return (method === "GET" && (path === START_REQUEST_READ_PREFIX.slice(0, -1) || path.startsWith(START_REQUEST_READ_PREFIX)))
    || (method === "POST" && path === "/v1/dev/company/connections/impact");
}

async function routeServerRead(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const start = request.method === "GET";
  // Invalid selectors cannot fall through as a generic task ID. Registration still fails closed.
  const route = devRouteOf(request.method, start ? `${START_REQUEST_READ_PREFIX}invalid` : url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", start ? "Start status is unavailable." : "GitHub disconnect preview is unavailable.");
  if (deps.serverReadSender === undefined || deps.companies === undefined) throw unavailable();
  const context = serverReadContext(deps.serverReadSender, deps.now);
  const companies = companyMembershipFromDynamo(context.client, deps.developer.signInTableName);
  const scoped: DeveloperRouteDependencies = { ...deps, documentClient: context.client, companies, serverReadBudget: context.budget,
    developer: { ...deps.developer, companies, verifyAccessToken: (authorization, audience) => deps.developer.verifyAccessToken(authorization, audience, context) } };
  let authenticated = false;
  try {
    const caller = await authenticateCaller(scoped, request.headers.authorization, route);
    context.check(); authenticated = true;
    const standing = async () => {
      const fresh = await authenticateCaller(scoped, request.headers.authorization, route);
      const member = await companies.membershipOf!(fresh.developerId);
      if (fresh.developerId !== caller.developerId || fresh.sessionId !== caller.sessionId || member === undefined) throw unavailable();
      context.check(); return { caller: fresh, companyId: member.companyId, role: member.role };
    };
    let startCompany: string | undefined;
    const startCompanyOf = async () => {
      const key = membershipKey(caller.developerId);
      const response = await context.client.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (response.Item !== undefined && (response.Item.pk !== key.pk || response.Item.sk !== key.sk)) throw unavailable();
      const live = strictLiveMembership(response.Item, caller.developerId);
      if (live === undefined || (startCompany !== undefined && live.companyId !== startCompany)) throw agentXError("TASK_NOT_FOUND", "That task is unavailable.");
      const fresh = await standing();
      if (fresh.companyId !== live.companyId) throw agentXError("TASK_NOT_FOUND", "That task is unavailable.");
      startCompany = live.companyId;
      return live.companyId;
    };
    const result = start
      ? await taskStartRequestRoute(scoped, request, url, caller, context, startCompanyOf, webOnlyTaskPersonReader(scoped))
      : await connectionImpactRoute(scoped, request, url, caller, context, standing);
    context.check(); return result;
  } catch (error) {
    // Aggregate invalidation wins even when an inner reader masked a transport exception.
    try { context.check(); } catch { throw unavailable(); }
    if (!authenticated && context.readFailed()) throw unavailable();
    if (error instanceof AgentXError && (!authenticated || ["CONFIG_INVALID", "TASK_NOT_FOUND", "NOT_FOUND", "FORBIDDEN"].includes(error.code))) throw error;
    throw unavailable();
  } finally { await context.close(); }
}

/** Selected web-only local proof; never constructs the Slack adapter or memoizes project authority. */
export function webOnlyTaskPersonReader(deps: DeveloperRouteDependencies): NonNullable<TaskPeopleDependencies["checkTaskPerson"]> {
  const local = { ...deps };
  delete local.workspaces; // Every selected proof read must use the counted local client.
  const noSlack = async (): Promise<never> => { throw agentXError("RUNTIME_UNAVAILABLE", "Start status is unavailable."); };
  return (task, personId) => checkTaskPersonIdentity({
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, uuid: randomUUID, slackTeamId: "",
    slackUnavailable: agentXError("RUNTIME_UNAVAILABLE", "Start status is unavailable."), taskPersonProof: noSlack, projectChannelIds: noSlack, targetProjectAccess: noSlack,
    developerRecord: async id => {
      const key = { pk: `DEVELOPER#${id}`, sk: META };
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: DeveloperRecord & { pk?: unknown; sk?: unknown } };
      if (response.Item !== undefined && (response.Item.pk !== key.pk || response.Item.sk !== key.sk)) return noSlack();
      return developerRecordKeyedBy(response.Item, id);
    },
    companyMembership: async id => {
      const key = membershipKey(id);
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (response.Item !== undefined && (response.Item.pk !== key.pk || response.Item.sk !== key.sk)) return noSlack();
      return strictLiveMembership(response.Item, id);
    },
    projectGrant: async (id, project, companyId) => {
      const revision = await latestDefinition(local, project, companyId);
      if (revision === undefined) return noSlack();
      const memberships = await grantRowsOf<{ pk?: string; sk?: string; projectName: string; role?: string }>(deps, id, companyId, WEB_PROOF_GRANT_ROWS_MAX);
      const result = evaluateProjectAuthority({ project, revision: { revision: revision.revision, definition: { developerTasks: revision.developerTasks } }, memberships, bindings: [] });
      if (result.kind === "allowed") return result.access === "granted";
      if (result.kind === "denied" && result.reason === "project-access") return false;
      return noSlack();
    },
  }, task, personId);
}