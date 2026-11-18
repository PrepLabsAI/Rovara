import { slackRecordScope } from "./slack-workspace-tokens.js";
import { listSlackWorkspaceScopes, SlackWorkspaceRefused, type SlackWorkspaceBindings } from "./slack-workspace-binding.js";
import { SlackWorkspaceScopeSchema, type SlackWorkspaceScope } from "@agentx/contracts";
import { CompanySelfServeNameSchema, COMPANY_INVITE_CODE_MAX, COMPANY_SELF_CREATE_TEXT, CompanyInviteCodeHashSchema, CompanyInviteCodeIdSchema, CompanyInviteListSchema, CompanySelfCreateBodySchema, companyInviteCodeHash, newCompanyInviteLink, type CompanyInviteList, type CompanyPreapprovalCreated, type CompanySelfCreateResponse } from "@agentx/contracts";
import { projectSettingsComplianceRoute, projectSettingsRoute, type ProjectSettingsHook } from "./project-settings.js";
import { Membership, membershipKey, boundedCompanyReads, companyReadActions, recordInCompany, resolveCompany, strictLiveMembership, type CompanyMembershipReader } from "./company-check.js";
import type { CallerStepUp } from "./step-up-check.js"; import type { TaskMergeWiring } from "./task-merge.js"; import { putCodeSettings, readCodeSettings } from "./project-code-settings.js"; import { putEvalNone, putSkip, readProjectSetupStatus } from "./project-setup-status.js"; import { LIFECYCLE_NOT_FOUND, routeProjectLifecycle, type LifecycleAction } from "./project-lifecycle-routes.js";
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
import { isLinearConnectPath, routeLinearConnect, type LinearConnectWiring } from "./linear-connect-routes.js";
import { routeHostedIntake } from "./hosted-intake-routes.js";
import type { HostedIntake } from "./hosted-intake.js";
import { LESSONS_OFF, type LessonsApi } from "../core-host/lessons-api.js"; import { knowledgeSwitchedOff, type KnowledgeApi } from "../core-host/knowledge-api.js"; import { isScriptTokenHeader } from "../core/script-tokens/token-format.js";
import type { LessonsRepeatsApi } from "../core-host/lessons-repeats-api.js";
import { isCompanyMemberPath, routeCompanyMembers, type CompanyMemberActions } from "./company-member-routes.js";
import { isSlackInstallPath, routeSlackInstall, type SlackInstallWiring } from "./slack-company-install.js";
import { isSlackChannelLinkPath, routeSlackChannelLink, type SlackChannelWiring } from "./slack-channel-link.js";
import { isCompanyEngineModelPath, routeCompanyEngineModel, type CompanyEngineModelWiring } from "./company-engine-model-routes.js";
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
  TaskPersonProofResponseSchema,
  TaskChannelPeopleResponseSchema,
  TaskPeopleDisplayReadResponseSchema,
  agentXError,
  developerTaskPolicy,
  workspaceRecordFields,
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
  type SlackAuthCheckRequest,
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
  SignInClientViewSchema,
  AccessCheckRequestSchema,
  AccessCheckResponseSchema,
  SignInClientIdSchema,
  SignInClientRecordSchema,
  signInClientKey,
  type AccessCheckResponse,
  type ListSignInClientsRequest,
  type PutSignInClientRequest,
  type RemoveSignInClientRequest,
  type SignInClientRecord,
  type SignInClientView,
} from "@agentx/contracts";
import { createChannelLinkWeb } from "./channel-link-web.js";
import { listDeveloperLinks, previewLinkCode, redeemLinkCode, removeLink, type ChannelLinkDependencies } from "./channel-links.js";
import { accessDeniedMessage, resolveDeveloperAccess } from "../developer/access.js";
import { stepUpOf } from "../developer/verify-token.js";
import { routeCompanyReads, type CompanyReadsConfiguration } from "../developer/company-reads.js";
import { evaluateProjectAuthority, mayUseProject } from "../developer/task-project-access.js";
import { renameTaskOwner } from "../developer/task-owner-name.js";
import { checkTaskPersonIdentity, listTaskWebCandidates, registerTaskChannelPeople, registerTaskWebPerson, resolveTaskPickerPersonWithId, type ProjectAccessSubject, type TaskPersonIdentityDependencies } from "../developer/task-person-identity.js";
import { taskPeopleDisplayAdmission, type TaskPeopleDisplayAdmission } from "../developer/task-people-display-budget.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeJwt } from "jose";
import { applyAccessRules, type AccessCheckContext, type AccessCheckRule } from "../developer/access-rules.js";
import { CompanyIssuerRecord, companyIssuerKey } from "../developer/company-issuer.js";
import { CompanyRecord, companyKey } from "../developer/company-membership.js";
import { INSTALL_COMPANY_PROJECTS_MAX, InstallCompanyRefused, installCompanyCatalog, installCompanyGrants, installCompanyLatestDefinition, installCompanyOf, installUsesCompanyLayout, mergeSurvivor } from "./install-company.js";
import { installCompanyBindings } from "./slack-install-company.js";
import { META, endedByAdmin, methodSince, startedBeforeMethodOn, type DeveloperRecord, type SessionRecord } from "../developer/store.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { DeveloperTaskActions } from "./developer-task-actions.js"; import type { ClientProjectNaming } from "./company-project-names.js";
import { MACHINE_SIZE_ROWS, MACHINE_STORED_ONLY_LINE } from "@agentx/contracts";
import { freshStepUp } from "../core-host/step-up.js";
import { machineSizeEnabled, machineCard, setMachineChoice } from "../core/test-env/machine-size.js";
import { testEnvironmentView } from "../core/test-env/local-view.js";
import { DynamoDocumentStore } from "@rovara/aws-adapters";
import {
  createPageComment, decideOnPage, deletePageComment, editPageComment, getTaskDocumentView, getTaskFreshness, getTaskPageState, listPageComments, pageFeatureChoices, retryApplicationRoundOnPage, setPageFeature, setPageSuggestion,
  confirmTaskPeopleProposal, getTaskPeople, getTaskPeopleCapabilities, getTaskPeopleProposal, getTaskPeopleProposalMetadata, getTaskPersonPresentationName,
  proposeTaskOwnershipForPage, proposeTaskPeopleRoleForPage, getTaskPeopleCandidatesForPage, addTaskWebPersonForPage,
  getWorkflowFeedbackReview, routeDeveloperTaskRequest, submitWorkflowFeedbackDecision, type DeveloperTaskRouteDependencies } from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { createFeedbackReviewWeb } from "./feedback-review-web.js";
import { TASK_PAGE, TASK_PEOPLE_CONFIRMATION, TASK_STATUS, createTaskWeb } from "./task-web.js";
import { TASK_PAGE_API_PREFIX, createTaskWebApi } from "./task-web-api.js";
import { getTaskE2EArtifact } from "./task-e2e-artifact.js";
import type { CoreTaskEntry } from "./engine-boundary.js";
import type { CoreAppEntry } from "./core-app-routes.js";
import type { BrokerResponse } from "../handler.js"; import { profileDisplayName } from "../developer/github-profile.js";
import type { CompanyImportRegistry } from "./company-import-forwarding.js"; import { routeSignInFactors, routeSignInLinks, type SignInLinkForward } from "./sign-in-link-routes.js";

export interface DeveloperApiConfiguration {
  /** Host-owned company rules configuration; absence preserves today's policy. */
  policyHook?: ProjectSettingsHook;
  /**
   * Host-owned: the company's step-up window in seconds (the policy hook's answer). It may only SHORTEN the ten-minute default; an answer that is not a whole number from 0 to 86400,
   * or a throw, refuses the press (`freshStepUp`). Absent: the default.
   */
  stepUpWindowSeconds?: (companyId: string) => Promise<unknown>;
  /** `github` (DEC 254h): GitHub sign-in is on; only ever with Code's company layer. Absent: off. */
  issuer: string; env: string; methods: { slack: boolean; oidc: boolean; github?: boolean }; slackTeamId?: string;
  /** Each method's enabled-since cutoff, epoch seconds (FR-045): a session started before it was ended by a disable. */
  since?: Partial<Record<DeveloperSignInMethod, number>>;
  signInTableName: string;
  channelMembers(request: ChannelMembersRequest): Promise<ChannelMembersResponse>;
  /** Lane E2: the core's own handlers for a task stamped `core` (engine-boundary.ts), as the deployment composes them. Absent: a core task reads exactly like a missing one. */
  coreTasks?: CoreTaskEntry;
  /** Lane L12: the core's own /v1/app/* routes (aws/core-app-routes.ts), set only while the core switch serves. Absent: every /v1/app/* path answers "route not found", reading nothing. */
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
  /** Guided onboarding PR 4: Add to Slack (slack-company-install.ts). Absent (or no company layer): those routes are unknown. */
  slackInstall?: SlackInstallWiring;
  /** Guided onboarding PR 5: a project's Slack channel (slack-channel-link.ts). Absent (or no company layer): those routes are unknown. */
  slackChannels?: SlackChannelWiring;
  /** Guided onboarding PR 7: the Linear connect routes (linear-connect-routes.ts). Absent (or no company layer): those routes are unknown. */
  linearConnect?: LinearConnectWiring;
  /** L2-4: a project's waiting tickets on the core (hosted-intake-routes.ts), set only while the core switch serves and Linear is wired. Absent (or no company layer): those routes are unknown. */
  coreIntake?: HostedIntake;
  /** Guided onboarding PR 14 (DEC 254n item 1): the company engine model route (company-engine-model-routes.ts). Absent (no model gateway, or no company layer): the route is unknown. */
  companyEngineModel?: CompanyEngineModelWiring;
  /**
   * Spec 065: a registered service's `/v1/dev/client/*` routes (project read, members, create). OFF unless the host sets it: they lack
   * step-up, and project creation registers with preflight off and keys the project by name without its company (DEFERRED-CHECKS).
   */
  clientRoutes?: true;
  /** Spec 025 E12: a public channel by its name, through DeveloperIdentity. */
  channelByName?: (request: ChannelByNameRequest) => Promise<ChannelByNameResponse>;
  /** Verifies the Authorization header's developer access token (D17; verify-token.ts) and returns its claims. */
  verifyAccessToken(authorization: string | undefined, audience?: string): Promise<Record<string, unknown>>;
  /**
   * Owner decision 132: a host's stricter rules on the access check (spec 063 FR-004), such as a fresh sign-in or an approval it keeps. They can only refuse
   * or narrow Rovara's own answer (`developer/access-rules.ts`); none means Rovara's answer as is.
   */
  accessRules?: readonly AccessCheckRule[];
  /** Spec 061 slice 2: the Slack service's request queue, set only with SLACK_REQUEST_QUEUE_URL; "Ask AgentX to reply to this comment" needs it. */
  slackRequestQueue?: SlackRequestQueue;
}
export interface DeveloperRouteDependencies {
  workspaces?: Pick<SlackWorkspaceBindings, "requireCompany"> & { getProject?(name: string): Promise<unknown> };
  workspace?: SlackWorkspaceScope;
  channelLinkCodes?: { preview(personId: string, code: string): Promise<{ channel: string; maskedUserId: string } | undefined>; redeem(personId: string, code: string): ReturnType<typeof redeemLinkCode> };
  policyHook?: ProjectSettingsHook;
  companies?: CompanyMembershipReader;
  /** Lane W: the merge core wired for this deployment's tasks (task-merge.ts). Absent: `POST /v1/dev/tasks/{id}/merge` answers a fixed "not set up". */
  taskMerge?: TaskMergeWiring;
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
  /** Spec 065b: a project from one GitHub repository, as a sign-in client's signed-in Rovara administrator. */
  createClientProject?: (developerId: string, input: CreateClientProjectRequest, naming?: ClientProjectNaming) => Promise<{ name: string; latestRevision: number }>;
  /** Spec 065b: the repositories the GitHub App can reach, to choose one for a new project. */
  clientRepositories?: (developerId?: string) => Promise<ClientRepositoriesResponse["installations"]>;
  /** Guided onboarding PR 6: one project from several repositories (all on the caller's company's installations, or nothing is created). */
  createClientProjects?: (developerId: string, input: CreateClientProjectsRequest, naming?: ClientProjectNaming) => Promise<{ name: string; latestRevision: number }>;
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
  /** DEC 236h: the person's last step-up as the VERIFIED access token states it (`stepUpOf`), for the acts that need a fresh sign-in; its age is checked where it is used. Never from a header, a query or a body. */
  stepUp?: { at: string; method: string };
}

/** What the broker needs from a Lambda invoke; `@aws-sdk/client-lambda`'s InvokeCommand output fits. */
export interface ChannelMembersInvokeResult { FunctionError?: string | undefined; Payload?: Uint8Array | undefined }

/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
function logDeveloperEvent(entry: Record<string, string | number>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}
const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
async function identityInvoke<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest
    | PutSignInClientRequest | RemoveSignInClientRequest | ListSignInClientsRequest | SetDisplayNameRequest | CompanyPreapprovalRequest | CompanySelfCreateRequest | CompanyInviteRequest,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return failed({ reason: "invoke_error", error: errorName(error) });
  }
  if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
  if (response.Payload === undefined) return failed({ reason: "empty_reply" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  } catch {
    return failed({ reason: "unreadable_reply" });
  }
  const reply = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    logDeveloperEvent({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  // Only a code-shaped reply error (such as token_revoked) is logged; never free text.
  return failed({ reason: "reply_error", error: reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) ? reply.error : "malformed_reply" });
}

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members");
}

/** C0: one fresh proof through DeveloperIdentity. Any old or malformed reply fails closed. */
export function taskPersonProofThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskPersonProofResponse | undefined => {
    const parsed = TaskPersonProofResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "ineligible" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    const memberOf = parsed.data.memberOf;
    if (parsed.data.user.id !== request.slackUserId || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return undefined;
    return parsed.data;
  }, "developer.task_person_proof");
}

/** E: complete fresh channel identities through DeveloperIdentity. Partial or malformed replies fail closed. */
export function taskChannelPeopleThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskChannelPeopleResponse | undefined => {
    const parsed = TaskChannelPeopleResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "capacity_exceeded" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    if (new Set(parsed.data.users.map((user) => user.id)).size !== parsed.data.users.length
      || parsed.data.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((channelId) => !requested.has(channelId)))) return undefined;
    return parsed.data;
  }, "developer.task_channel_people");
}

/** E: strict metered display transport. Any missing or malformed usage seals the caller's admission. */
export function taskPeopleDisplayReadThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return async (request) => {
    const failed = (reason: string): never => {
      logDeveloperEvent({ event: "developer.task_people_display_read_failed", reason });
      throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
    };
    let response: ChannelMembersInvokeResult;
    try { response = await invoke(Buffer.from(JSON.stringify(request))); }
    catch (error) { return failed(`invoke_${errorName(error)}`); }
    if (response.FunctionError !== undefined) return failed("function_error");
    if (response.Payload === undefined) return failed("empty_reply");
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8")); }
    catch { return failed("unreadable_reply"); }
    const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.operation !== request.operation
      || parsed.data.admission.slackCallsUsed > request.admission.slackCallsLimit) return failed("malformed_reply");
    if (parsed.data.operation === "proof") {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "proof" ? request.request.channelIds : []);
        if (request.operation !== "proof" || result.user.id !== request.request.slackUserId
          || new Set(result.memberOf).size !== result.memberOf.length || result.memberOf.some((id) => !requested.has(id))) return failed("malformed_reply");
      }
    } else {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "directory" ? request.request.channelIds : []);
        if (request.operation !== "directory" || new Set(result.users.map((user) => user.id)).size !== result.users.length
          || result.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((id) => !requested.has(id)))) return failed("malformed_reply");
      }
    }
    return parsed.data;
  };
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.channelId === "string" && typeof candidate.name === "string" && typeof candidate.isPrivate === "boolean";
};

/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info");
}

/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (workspace?: SlackWorkspaceScope) => Promise<SlackAuthCheckResponse> {
  return async (workspace) => {
    if (workspace !== undefined && !SlackWorkspaceScopeSchema.safeParse(workspace).success) return { ok: false, error: "slack_unavailable" };
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check", ...(workspace === undefined ? {} : { workspace }) }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}

/**
 * E9: ends a developer's sessions through DeveloperIdentity. A not_found reply is an answer (the
 * developer never signed in), not a failure, so it is neither logged as one nor turned into
 * unavailable (C15). Every other failure is unavailable.
 */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** #634: a person's chosen name, through DeveloperIdentity. not_found and invalid_request are answers; every other failure is unavailable. */
export function setDisplayNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SetDisplayNameRequest) => Promise<SetDisplayNameResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): SetDisplayNameResponse | undefined => {
      if (reply.ok === true && typeof reply.name === "string") return { ok: true, name: reply.name };
      if (reply.ok === false && (reply.error === "not_found" || reply.error === "invalid_request")) return { ok: false, error: reply.error };
      return undefined;
    }, "developer.set_display_name");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
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
  | { kind: "company-preapproval-withdraw"; companyId: string; emailHash: string; createdBy: string };
const CompanyPreapprovalInvoke = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company-preapprove"), companyId: OrgIdSchema, email: z.string().trim().min(3).max(320).email(), role: z.literal("member"), expiresInHours: z.number().int().min(1).max(720), createdBy: z.string().regex(/^[a-f0-9]{64}$/), inviteHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("company-preapproval-withdraw"), companyId: OrgIdSchema, emailHash: z.string().regex(/^[a-f0-9]{64}$/), createdBy: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const PreapprovalExpiry = z.number().int().positive();
export function companyPreapprovalsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: CompanyPreapprovalRequest) => Promise<false | { expiresAt?: number }> {
  return async (request) => {
    const parsed = CompanyPreapprovalInvoke.safeParse(request);
    if (!parsed.success) return false;
    const answer = await identityInvoke(invoke, parsed.data, (reply) => reply.ok !== true ? (reply.ok === false ? false : undefined)
      : reply.expiresAt === undefined ? {} : PreapprovalExpiry.safeParse(reply.expiresAt).success ? { expiresAt: reply.expiresAt as number } : undefined, "developer.company_preapproval");
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
    const answer = await identityInvoke(invoke, parsed.data, (reply) => { const read = CompanySelfCreateReply.safeParse(reply); return read.success ? read.data : undefined; }, "developer.company_self_create");
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
    const answer = await identityInvoke(invoke, parsed.data, (reply) => reply.ok === true ? read(reply) : reply.ok === false && reply.error === "not_found" && notFound !== undefined ? notFound : undefined, "developer.company_invites");
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

export interface SignInClientRegistry {
  /** `keepSecret`: keep the stored client's secret, which only the sign-in server can read. */
  put(client: SignInClientRecord, options?: { keepSecret?: true; companyId?: string }): Promise<void>;
  remove(clientId: string, companyId?: string): Promise<boolean>;
  list(companyId?: string): Promise<SignInClientView[]>;
}

export function signInClientsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): SignInClientRegistry {
  const ask = async <T>(request: PutSignInClientRequest | RemoveSignInClientRequest | ListSignInClientsRequest, read: (reply: Record<string, unknown>) => T | undefined): Promise<T> => {
    const answer = await identityInvoke(invoke, request, (reply) => (reply.ok === true ? read(reply) : undefined), "developer.sign_in_clients");
    if (typeof answer === "object" && answer !== null && "ok" in answer && (answer as { ok: unknown }).ok === false) {
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX could not reach its sign-in service; try again");
    }
    return answer as T;
  };
  return {
    async put(client, options) { await ask({ kind: "put-sign-in-client", client, ...(options?.companyId === undefined ? {} : { companyId: options.companyId }), ...(options?.keepSecret === true ? { keepSecret: true as const } : {}) }, () => true); },
    remove: (clientId, companyId) => ask({ kind: "remove-sign-in-client", clientId, ...(companyId === undefined ? {} : { companyId }) }, (reply) => reply.removed === true),
    list: (companyId) => ask({ kind: "list-sign-in-clients", ...(companyId === undefined ? {} : { companyId }) }, (reply) => {
      const parsed = z.array(SignInClientViewSchema).safeParse(reply.clients);
      return parsed.success ? parsed.data : undefined;
    }),
  };
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name");
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

/**
 * The sign-in server's public keys, read by invoking the DeveloperIdentity function with its own
 * JWKS route (D17): the broker may not call kms:GetPublicKey, which the key policy keeps to
 * DeveloperIdentity. Any failure throws, and the verifier answers 503 for it.
 */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    logDeveloperEvent({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async () => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      throw failed("invoke_error", { error: errorName(error) });
    }
    if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
    if (response.Payload === undefined) throw failed("empty_reply");
    let keys: unknown;
    try {
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
      if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
      keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
    } catch {
      throw failed("unreadable_reply");
    }
    if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
    return keys as unknown[];
  };
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

/** Company policy is selected only from live membership and the stored session (OIDC, and since DEC 254e Slack too).
 * Fixed-size reads share one budget and the host's existing SDK timeout; no cache or token company.
 * Undefined: the session is held to the install's own method (the built-in company, a shared-method session of a company with no issuer, or a
 * Slack session of a company whose install workspace is bound to it). */
async function companyOidcSession(deps: DeveloperRouteDependencies, session: SessionRecord, resolvedCompany?: string): Promise<DeveloperRecord | undefined> {
  // DEC 254e: a Slack session is checked here when it carries the shared-method mark (the sign-in server rechecks every Slack session at refresh,
  // as before); an OIDC session always.
  // DEC 254h/254n: a GitHub session always, marked or not, as OIDC (an unmarked one is held to the built-in company; GitHub is only the shared method).
  if (deps.companies === undefined || !(session.amr === "oidc" || session.amr === "github" || (session.amr === "slack" && session.installMethod !== undefined))) return undefined;
  try {
    const scope = boundedCompanyReads(deps.documentClient, deps.now);
    const companyId = resolvedCompany ?? await scope.read(() => resolveCompany(deps.companies, session.developerId));
    if ((session.companyId ?? IMPLICIT_COMPANY_ID) !== companyId) throw new Error("session company");
    if (companyId === IMPLICIT_COMPANY_ID) {
      if (session.installMethod !== undefined) throw new Error("session method");
      return undefined;
    }
    const parsed = z.object({
      sessionId: z.string().uuid(), developerId: z.string().regex(/^[a-f0-9]{64}$/), amr: z.enum(["oidc", "slack", "github"]),
      companyId: OrgIdSchema, startedAt: z.iso.datetime(), endsAt: z.number().finite(),
      reviewExpiresAt: z.number().finite().optional(), installMethod: z.literal(true).optional(),
    }).safeParse(await scope.read(async () => session));
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
  const stepUp = claims === undefined ? undefined : stepUpOf(claims);
  try {
    const caller = await authenticateSession(deps, token, undefined, true);
    return stepUp === undefined ? caller : { ...caller, stepUp };
  }
  catch (error) {
    if (deps.companies !== undefined && token.amr === "oidc" && !(error instanceof AgentXError)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    throw error;
  }
}

async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod }, storedSession?: SessionRecord, checkInstallEnabled = false): Promise<DeveloperCaller> {
  const session = storedSession ?? await getSignIn<SessionRecord>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  // Spec 063 FR-003: a registered client's session never acts on Rovara, whatever token names it.
  if (session.clientId !== undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
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
async function grantsOf(deps: DeveloperRouteDependencies, caller: ProjectAccessSubject): Promise<string[]> {
  return (await queryAll<{ projectName: string; role?: string }>(deps, `MEMBER#${caller.developerId}`, "PROJECT#"))
    .filter((membership) => mayUseProject(membership.role))
    .map((membership) => membership.projectName);
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
    const rows = await queryAll<SlackChannelBinding>({ ...deps, documentClient: budget.client }, channelBindingPartition(SLACK_CHANNEL, scope.teamId), channelBindingSortPrefix(SLACK_CHANNEL));
    if (rows.some((row) => row.teamId !== scope.teamId)) throw new SlackWorkspaceRefused();
    bindings.push(...rows);
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
  const authorization = request.headers.authorization;
  const basic = basicClientCredentials(authorization);
  const nowSeconds = Math.floor(deps.now() / 1000);
  let developerId: string;
  let administrator = false;
  let clientId: string;
  let companyId: string | undefined;
  let sessionFacts: AccessCheckContext["session"];
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
    ({ developerId, administrator } = authenticated);
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
  const answer: AccessCheckResponse = { developerId, displayName: access.displayName, nameChosen: access.nameChosen, administrator, projects: access.projects, notices: access.notices, ...company };
  const context: AccessCheckContext = { clientId, via: basic === undefined ? "token" : "client_secret", developerId, ...(sessionFacts === undefined ? {} : { session: sessionFacts }), now: deps.now() };
  const ruled = await applyAccessRules(deps.developer.accessRules, context, answer);
  if (ruled === undefined) throw refused();
  // What leaves is exactly the answer's shape, whatever a rule did.
  const checked = AccessCheckResponseSchema.safeParse(ruled);
  if (!checked.success) throw refused();
  return checked.data;
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
  const administered = (await queryAll<{ projectName?: unknown; role?: unknown }>(deps, `MEMBER#${developerId}`, "PROJECT#"))
    .filter((membership) => membership.role === "administrator" && typeof membership.projectName === "string")
    .map((membership) => membership.projectName as string);
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
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: Array<{ definition?: { revision?: unknown; repositories?: unknown } }> };
  const row = response.Items?.[0];
  if (!recordInCompany(row, companyId)) throw agentXError("NOT_FOUND", "project not found");
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
 * no-company sign-in wrote (never a legacy person's). Read live, on the sign-in table; any doubt is no.
 */
async function companylessSession(deps: DeveloperRouteDependencies, client: SignInClientRecord, session: SessionRecord): Promise<boolean> {
  if (deps.companies === undefined || client.installLevel !== true || client.fullAccess !== true || client.webApp !== true || (session.amr !== "oidc" && session.amr !== "slack" && session.amr !== "github") || session.companyId !== undefined) return false;
  try {
    const membership = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: membershipKey(session.developerId), ConsistentRead: true })) as { Item?: unknown };
    if (membership.Item !== undefined) return false;
    const developer = await getSignIn<{ revoked?: unknown; companyless?: unknown }>(deps, `DEVELOPER#${session.developerId}`);
    return developer?.revoked === false && developer.companyless === true;
  } catch { return false; }
}

/**
 * Spec 063 FR-004, spec 065 FR-003: a registered sign-in client's token, for a live session of its own. The unverified azp
 * only picks which client's audience the token must then verify against. Every refusal is the same 401.
 */
async function authenticateClientToken(deps: DeveloperRouteDependencies, authorization: string | undefined, nowSeconds: number, options: { companyless?: true } = {}): Promise<{ client: SignInClientRecord; companyId?: string; companyless?: true; developerId: string; administrator: boolean; scopes: ClientScope[]; sessionId: string; amr: DeveloperSignInMethod; startedAt: string; stepUp?: CallerStepUp; joinedByInvite?: true }> {
  const refused = () => agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  let azp: unknown;
  try {
    azp = decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "").azp;
  } catch {
    throw refused();
  }
  const client = await signInClientOf(deps, azp);
  if (client === undefined) throw refused();
  let claims: Record<string, unknown>;
  try {
    claims = await deps.developer.verifyAccessToken(authorization, client.audience);
  } catch (error) {
    if ((error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE") throw error;
    throw refused();
  }
  if (claims.azp !== client.clientId || claims.env !== deps.developer.env || typeof claims.sub !== "string" || typeof claims.sid !== "string") throw refused();
  const amr = claims.amr;
  if ((amr !== "slack" && amr !== "oidc" && amr !== "github") || (deps.developer.methods[amr] !== true && !(deps.companies !== undefined && amr === "oidc"))) throw refused();
  try {
    const session = await getSignIn<SessionRecord>(deps, `SESSION#${claims.sid}`);
    if (session === undefined || session.clientId !== client.clientId || session.developerId !== claims.sub || session.amr !== amr
      || session.revokedAt !== undefined || session.endsAt <= nowSeconds || Date.parse(session.startedAt) < Date.parse(client.createdAt)) throw refused();
    let companyId: string | undefined;
    let companyless = false;
    try { companyId = await clientCompany(deps, client, session.developerId); }
    catch (error) {
      // DEC 253z: only a caller that asked for it (the access check, company create) takes a session with no company, and only as `companylessSession` reads it now.
      if (options.companyless !== true || !await companylessSession(deps, client, session)) throw error;
      companyless = true;
    }
    const companyDeveloper = companyless ? undefined : await companyOidcSession(deps, session, companyId);
    if (companyDeveloper === undefined && (deps.developer.methods[amr] !== true || startedBeforeMethodOn(session.startedAt, deps.developer.since?.[amr]))) throw refused();
    const developer = companyDeveloper ?? await getSignIn<Pick<DeveloperRecord, "sessionsEndedAt">>(deps, `DEVELOPER#${session.developerId}`);
    if (endedByAdmin(session.startedAt, developer?.sessionsEndedAt)) throw refused();
    // Spec 065 FR-002: only the scopes on the token that the registration still allows. Spec 066: a client with full
    // access has the person's rights, so every scope.
    const scopes = client.fullAccess === true ? [...CLIENT_SCOPES] : scopesOf(claims.scope).filter((scope) => client.scopes?.includes(scope) === true);
    // Lane ID part 2 for a sign-in client (switch-on L11): the step-up the VERIFIED token states (`stepUpOf`; the sign-in server writes it only into the token of a session that began with a
    // step-up on Code's own page, `acr_values=step-up`), never anything else the request sends. The route checks its age.
    const stepUp = stepUpOf(claims);
    return {
      client, ...(companyId === undefined ? {} : { companyId }), ...(companyless ? { companyless: true as const } : {}), developerId: session.developerId, sessionId: claims.sid, amr,
      administrator: amr === "oidc" && session.administrator === true && !companyless, scopes, startedAt: session.startedAt,
      ...(stepUp === undefined ? {} : { stepUp }),
      // DEC 254b (f): what the sign-in server recorded on THIS session at mint, for the company the session is bound to (checked against live membership above).
      ...(session.joinedByInvite === true && !companyless && companyId !== undefined && (session.companyId ?? IMPLICIT_COMPANY_ID) === companyId ? { joinedByInvite: true as const } : {}),
    };
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
export async function authenticateCaller(deps: DeveloperRouteDependencies, authorization: string | undefined, route: DevRoute): Promise<DeveloperCaller> {
  return (await authenticateCallerWithStepUp(deps, authorization, route)).caller;
}

/** As `authenticateCaller`, with the step-up the VERIFIED token carries (lane W; its age is checked by the route that needs it). */
async function authenticateCallerWithStepUp(deps: DeveloperRouteDependencies, authorization: string | undefined, route: DevRoute, options: { companyless?: true } = {}): Promise<{ caller: DeveloperCaller; stepUp?: CallerStepUp }> {
  let azp: unknown;
  try {
    azp = decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? "").azp;
  } catch {
    azp = undefined;
  }
  // A client with neither a scope nor full access is refused as before: its tokens are never Rovara's (401).
  const client = typeof azp !== "string" || azp === AGENTX_CLI_CLIENT_ID ? undefined : await signInClientOf(deps, azp);
  if (client === undefined || (client.fullAccess !== true && (client.scopes ?? []).length === 0)) {
    // The Rovara CLI's token (or a tool holding it) never carries a step-up here: a merge or a loosened rule is a web client's press (plan 7.2 change 5).
    return { caller: await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(authorization)) };
  }
  const person = await authenticateClientToken(deps, authorization, Math.floor(deps.now() / 1000), options);
  const developer = await getSignIn<Pick<DeveloperRecord, "displayName" | "provider" | "subject" | "slackUserId" | "email" | "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  requireRouteScope(route, person);
  const caller: DeveloperCaller = {
    developerId: person.developerId, sessionId: person.sessionId, amr: person.amr, name: profileDisplayName(developer) ?? developer.displayName, clientId: person.client.clientId,
    ...(person.stepUp === undefined ? {} : { stepUp: person.stepUp }),
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
    ...(person.client.fullAccess === true && person.client.webApp === true ? { webApp: true as const, ...(person.stepUp === undefined ? {} : { stepUp: person.stepUp }) } : {}),
  };
  return person.stepUp === undefined ? { caller } : { caller, stepUp: person.stepUp };
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

/** Spec 067: a registered, not removed person, with their name and whether they hold a grant on `project`. */
async function taskReaderPerson(deps: DeveloperRouteDependencies, developerId: string, project: string): Promise<{ name: string; projectMember: boolean } | undefined> {
  const person = await getSignIn<Pick<DeveloperRecord, "revoked" | "displayName">>(deps, `DEVELOPER#${developerId}`);
  if (person === undefined || person.revoked === true) return undefined;
  return { name: person.displayName ?? "Unknown", projectMember: await projectGrant(memberActions(deps), project, developerId) !== undefined };
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
  const own = await projectGrant(memberActions(deps), project, person.developerId);
  const membership = companyId === undefined ? undefined : await deps.companies?.membershipOf?.(person.developerId);
  const companyAdmin = companyId === undefined ? person.administrator : membership?.companyId === companyId && (membership.role === "admin" || membership.role === "owner");
  return putCodeSettings({ ...store, now: deps.now, // The file's one company-less logger (already in the log-site inventory), with the company added when there is one.
    log: (entry) => logDeveloperEvent({ ...entry, ...(companyId === undefined ? {} : { companyId }) }) }, {
    companyId, project, personId: person.developerId, clientId: person.client.clientId, mayChange: own?.role === "administrator" || companyAdmin, stepUp: person.stepUp, body: jsonBody(request),
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
async function routeClientSetupStatus(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, rawProject: string, change: "/skips" | "/eval-none" | undefined, route: DevRoute): Promise<unknown> {
  const person = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, person);
  const profile = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${person.developerId}`);
  if (profile === undefined || profile.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", "project not found"); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  const scope = boundedCompanyReads(deps.documentClient, deps.now);
  const companyId = await resolveCompany(deps.companies, person.developerId);
  const latest = await scope.client.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: Array<{ definition?: { revision?: unknown; repositories?: unknown } }> };
  const row = latest.Items?.[0];
  const definition = row?.definition;
  if (!recordInCompany(row, companyId) || definition === undefined || typeof definition.revision !== "number") throw agentXError("NOT_FOUND", "project not found");
  // With no company layer there is no company to belong to: the person must be one who may use the project.
  if (companyId === undefined) {
    const access = await projectsAPersonUses({ ...deps, documentClient: scope.client }, person.developerId, undefined);
    if (access === undefined) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
    if (!access.projects.some((entry) => entry.name === project)) throw agentXError("NOT_FOUND", "project not found");
  }
  const membership = companyId === undefined ? undefined : await deps.companies?.membershipOf?.(person.developerId);
  const role = membership !== undefined && membership.companyId === companyId ? membership.role : undefined;
  const own = await projectGrant({ ...memberActions(deps), documentClient: scope.client }, project, person.developerId);
  const projectAdmin = own?.role === "administrator";
  const companyAdmin = companyId === undefined ? person.administrator : role === "admin" || role === "owner";
  const effectiveCompany = companyId ?? IMPLICIT_COMPANY_ID;
  if (change === "/eval-none") {
    if (request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    const changed = await putEvalNone({ documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project, revision: definition.revision, personId: person.developerId, mayChange: projectAdmin || companyAdmin, body: () => jsonBody(request) });
    scope.check();
    logDeveloperEvent({ event: "client.project_setup_eval_none_changed", clientId: person.client.clientId, by: person.developerId, project, noEvals: changed.noEvals ? "true" : "false", ...(companyId === undefined ? {} : { companyId }) });
    return changed;
  }
  if (change === "/skips") {
    if (request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
    const changed = await putSkip({ documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project, personId: person.developerId, mayChange: projectAdmin || companyAdmin, body: () => jsonBody(request) });
    scope.check();
    logDeveloperEvent({ event: "client.project_setup_skip_changed", clientId: person.client.clientId, by: person.developerId, project, row: changed.row, skipped: changed.skipped ? "true" : "false", ...(companyId === undefined ? {} : { companyId }) });
    return changed;
  }
  if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
  const status = await readProjectSetupStatus({
    documentClient: scope.client, tableName: deps.tableName, now: deps.now, companyId: effectiveCompany, project, definition: { revision: definition.revision, repositories: definition.repositories },
    viewer: { companyRole: role ?? null, projectAdmin },
    readers: { channels: () => projectChannelLinks({ ...deps, documentClient: scope.client }, project, companyId) },
  });
  scope.check();
  return status;
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
    grantRole: async (personId, project) => (await projectGrant(memberActions(deps), project, personId))?.role,
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

/**
 * Spec 065: a sign-in client acting as the signed-in person, within its scopes and the person's own rights. 065a: a
 * project's members, which only the project's administrators or a Rovara administrator may see and change.
 */
export async function routeClientRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (deps.developer.clientRoutes !== true) throw agentXError("NOT_FOUND", "route not found");
  // Plan v3.2 lane ID: only a route in the table, and only with its scope.
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
  // Lanes AU and EV: the company's audit records and events, read as the company administrator of the caller's own company.
  if (url.pathname === COMPANY_AUDIT_RECORDS_PATH || url.pathname === COMPANY_EVENTS_PATH) {
    const reader = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
    requireRouteScope(route, reader);
    if (deps.companyReads === undefined) throw agentXError("NOT_FOUND", "route not found");
    const person = await getSignIn<Pick<DeveloperRecord, "revoked">>(deps, `DEVELOPER#${reader.developerId}`);
    if (person === undefined || person.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
    // A person's name: the host's lookup, else the sign-in table's display name, shown only for a person of the caller's own company.
    const resolveCompany = deps.companyReads.companyOf;
    const personName = deps.companyReads.personName ?? (async (developerId: string, companyId: string) => {
      if (resolveCompany !== undefined && (await resolveCompany(developerId)) !== companyId) return undefined;
      return (await getSignIn<Pick<DeveloperRecord, "displayName">>(deps, `DEVELOPER#${developerId}`))?.displayName;
    });
    return routeCompanyReads({ ...deps.companyReads, personName }, { developerId: reader.developerId, administrator: reader.administrator }, url, deps.now());
  }
  // Spec 065b: create a project (projects:create), as a Rovara administrator, from a repository the GitHub App can reach.
  const creating = url.pathname === "/v1/dev/client/projects" && request.method === "POST";
  // Guided onboarding PR 6: one project per repository, and the repository picker; the same scope and the same role as creating one.
  const bulk = url.pathname === CLIENT_PROJECTS_BULK && request.method === "POST";
  const choosing = url.pathname === CLIENT_REPOSITORY_CHOICES && request.method === "GET";
  if (creating || bulk || choosing || (url.pathname === "/v1/dev/client/repositories" && request.method === "GET")) {
    const creator = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
    requireRouteScope(route, creator);
    // Guided onboarding PR 19: or a live owner or admin of the caller's own company; the Rovara administrator's path is unchanged and reads nothing more.
    if (!creator.administrator && !await companyMayCreateProjects(deps, creator)) throw agentXError("FORBIDDEN", "only a Rovara administrator can create a project"); const naming: [] | [ClientProjectNaming] = creator.administrator ? [] : [{ perCompany: true }]; // L2-1: a company's creates use its own names; the administrator's calls are unchanged
    if (choosing) {
      if (deps.clientRepositoryChoices === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
      const query = RepositoryChoicesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success || new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw agentXError("CONFIG_INVALID", "invalid repository search: use q, limit (1 to 100) and after, once each");
      return await deps.clientRepositoryChoices(creator.developerId, query.data) satisfies ClientRepositoryChoicesResponse;
    }
    if (bulk) {
      if (deps.createClientProjectsBulk === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
      const parsed = BulkCreateClientProjectsRequestSchema.safeParse(jsonBody(request));
      if (!parsed.success) throw agentXError("CONFIG_INVALID", `invalid projects: ${parsed.error.issues[0]?.path.join(".") || "request"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      const answer = await deps.createClientProjectsBulk(creator.developerId, parsed.data, ...naming);
      logDeveloperEvent({ event: "client.projects_bulk_created", clientId: creator.client.clientId, by: creator.developerId,
        ...(creator.companyId === undefined ? {} : { companyId: creator.companyId }), asked: parsed.data.repositories.length,
        created: answer.results.filter((row) => row.outcome === "created").length });
      return answer satisfies BulkCreateClientProjectsResponse;
    }
    if (!creating) {
      if (deps.clientRepositories === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
      return { installations: await deps.clientRepositories(creator.developerId) } satisfies ClientRepositoriesResponse;
    }
    const body = jsonBody(request);
    // Guided onboarding PR 6: a body naming `repositories` makes one project of them all; any other body is the single-repository create, as before.
    if (body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "repositories")) {
      if (deps.createClientProjects === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
      const many = CreateClientProjectsRequestSchema.safeParse(body);
      if (!many.success) throw agentXError("CONFIG_INVALID", `invalid project: ${many.error.issues[0]?.path.join(".") || "request"}: ${many.error.issues[0]?.message ?? "invalid"}`);
      const created = await deps.createClientProjects(creator.developerId, many.data, ...naming);
      logDeveloperEvent({ event: "client.project_created", clientId: creator.client.clientId, by: creator.developerId, project: created.name, repositories: many.data.repositories.length,
        ...(creator.companyId === undefined ? {} : { companyId: creator.companyId }) });
      return readClientProject(deps, creator.developerId, created.name, creator.companyId);
    }
    if (deps.createClientProject === undefined) throw agentXError("NOT_FOUND", "creating projects is not set up in this deployment");
    const parsed = CreateClientProjectRequestSchema.safeParse(body);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `invalid project: ${parsed.error.issues[0]?.path.join(".") || "request"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const created = await deps.createClientProject(creator.developerId, parsed.data, ...naming);
    console.log(JSON.stringify({ component: "broker", event: "client.project_created", clientId: creator.client.clientId, by: creator.developerId, project: created.name }));
    return readClientProject(deps, creator.developerId, created.name, creator.companyId);
  }
  // Guided onboarding PR 16 (DEC 254n item 3): a project's archive and restore, preview first (project-lifecycle-routes.ts).
  const lifecycle = CLIENT_LIFECYCLE.exec(url.pathname);
  if (lifecycle !== null) return routeClientLifecycle(deps, request, lifecycle[1]!, lifecycle[2] as LifecycleAction, route);
  // Lane W: a project's merge rules (contract v0 client.projects.codeSettings), in Code's own CodeSettings shape.
  const settings = CLIENT_CODE_SETTINGS.exec(url.pathname);
  if (settings !== null && (request.method === "GET" || request.method === "PUT")) return routeClientCodeSettings(deps, request, settings[1]!, route);
  // Guided onboarding PR 8: a project's setup status, and the skipped optional rows.
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
  const caller = await authenticateClientToken(deps, request.headers.authorization, Math.floor(deps.now() / 1000));
  requireRouteScope(route, caller);
  const person = await getSignIn<Pick<DeveloperRecord, "revoked" | "displayName">>(deps, `DEVELOPER#${caller.developerId}`);
  if (person === undefined || person.revoked === true) throw agentXError("AUTH_REQUIRED", ACCESS_REFUSED);
  const project = decodeURIComponent(members[1]!);
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", "project not found");
  const actions = memberActions(deps);
  // FR-004: as the person: they administer the project, or they are a Rovara administrator.
  const own = await projectGrant(actions, project, caller.developerId);
  if (!caller.administrator && own?.role !== "administrator") throw agentXError("FORBIDDEN", `you don't administer ${project}; ask one of its administrators`);
  const registered = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, Limit: 1, ScanIndexForward: false,
  })) as { Items?: unknown[] };
  if ((registered.Items ?? []).length === 0) throw agentXError("NOT_FOUND", `project ${project} is not registered`);
  const by = { issuer: `sign-in-client:${caller.client.clientId}`, subject: caller.developerId };
  if (request.method === "GET" && members[2] === undefined) {
    const listed = await listProjectMembers(actions, project);
    const named = await Promise.all(listed.map(async (member) => ({ ...member, name: profileDisplayName((await getSignIn<Pick<DeveloperRecord, "displayName" | "provider" | "subject">>(deps, `DEVELOPER#${member.developerId}`)) ?? {}) ?? "Unknown" })));
    return { project, members: named } satisfies ClientProjectMembersResponse;
  }
  if (members[2] === undefined || (request.method !== "PUT" && request.method !== "DELETE")) throw agentXError("NOT_FOUND", "route not found");
  const target = await resolveDeveloper(actions, decodeURIComponent(members[2]), caller.companyId);
  if (request.method === "PUT") {
    const granted = await grantProjectAccess(actions, by, project, target.developerId);
    console.log(JSON.stringify({ component: "broker", event: "client.project_member_granted", clientId: caller.client.clientId, by: caller.developerId, developerId: target.developerId, project, already: granted.already }));
    return { project, developerId: target.developerId, outcome: granted.already ? "already_member" : "granted" } satisfies ClientProjectMemberChangeResponse;
  }
  const revoked = await revokeProjectAccess(actions, project, target.developerId);
  console.log(JSON.stringify({ component: "broker", event: "client.project_member_revoked", clientId: caller.client.clientId, by: caller.developerId, developerId: target.developerId, project, revoked: revoked.revoked }));
  return { project, developerId: target.developerId, outcome: revoked.revoked ? "revoked" : "not_member" } satisfies ClientProjectMemberChangeResponse;
}

async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller, companyId?: string): Promise<DeveloperProjectsResponse> {
  // Company mode, with or without the workspace service: the caller's company filters every project the list shows (the install's own team is the implicit company's).
  companyId ??= companySlackMode(deps) ? await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) : undefined;
  const grants = await grantsOf(deps, caller);
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
): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[] }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const companyId = companySlackMode(deps) ? await resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId) : undefined;
  const known = (await projectsWithPolicy(deps, [project], companyId)).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  const grants = (await grantsOf(deps, caller)).filter((name) => name === project);
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
  return { revision: result.revision, policy: result.policy, access: result.access, channelIds: result.channelIds };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, project: string): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": project },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []).filter((item) => item.entityType !== "WORKSPACE_COMPANY_POINTER"));
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
  const listing = await listProjects(deps, caller);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, project.name));
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
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
    return response.Item;
  };
  const definitionReads = new Map<string, ReturnType<typeof latestDefinition>>();
  const webProof: Pick<TaskPersonIdentityDependencies, "companyMembership" | "projectGrant" | "projectMemberIds"> = {
    // C4: one bounded page of the project's side of its grants (admin-actions.ts projectMemberKey rows); each id is proved live before use.
    projectMemberIds: async (project, limit) => {
      const response = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :developer)",
        ExpressionAttributeValues: { ":pk": projectMemberKey(project, "").pk, ":developer": "DEVELOPER#" }, ConsistentRead: true, Limit: limit,
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
      const memberships = await queryAll<{ pk?: string; sk?: string; projectName: string; role?: string }>(deps, `MEMBER#${targetDeveloperId}`, "PROJECT#", WEB_PROOF_GRANT_ROWS_MAX);
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
    const workspace = await taskWorkspace(task);
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
          queryAll<{ projectName: string; role?: string }>(deps, `MEMBER#${subject.developerId}`, "PROJECT#"),
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
        if (result.kind === "allowed") return;
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
    taskReaderPerson: (developerId, project) => taskReaderPerson(deps, developerId, project),
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
 * DEC 254h: `POST` also makes the invite link's single-use secret, bound to this company and this pre-approval, and answers it ONCE with the
 * pre-approval's expiry; only its SHA-256 travels to the sign-in Lambda and is stored. `DELETE` withdraws the pre-approval, which ends its secret.
 */
async function companyPreapprovalRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<CompanyPreapprovalCreated | { ok: true }> {
  const notFound = () => agentXError("NOT_FOUND", "not found");
  if (deps.companies === undefined) throw agentXError("NOT_FOUND", "route not found");
  const isPost = request.method === "POST" && url.pathname === "/v1/dev/company/preapprovals";
  const hash = /^\/v1\/dev\/company\/preapprovals\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  if (!isPost && !(request.method === "DELETE" && hash !== undefined)) throw notFound();
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
  let forwarded: CompanyPreapprovalRequest;
  let link: { secret: string; secretHash: string } | undefined;
  if (isPost) {
    const parsed = CompanyInviteInput.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "a member invitation needs an email and an expiry from 1 to 720 hours");
    link = newCompanyInviteLink();
    forwarded = { kind: "company-preapprove", companyId: member.companyId, ...parsed.data, createdBy: caller.developerId, inviteHash: link.secretHash };
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
  const { caller } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route, { companyless: true });
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
export const LESSONS_API_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons(?:\/(mode|mode\/trial-offer|weekly-summary|retire-requests|decisions|measure)|\/([^/]+)\/(approve|reject|retire|retire-request))?|tasks\/([^/]+)\/lessons(?:\/([^/]+)\/(not-helpful))?)$/u;

/** L4-AK1H: the team knowledge reads' paths (`core-host/knowledge-api.ts` parses the same paths; a test holds the two equal). Both are POSTs (a repository's address stays out of addresses and access logs). */
export const KNOWLEDGE_API_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons|knowledge\/areas)$/u;

/** The Home number's paths (`core-host/lessons-repeats-api.ts` parses the same paths; a test holds the two equal). */
export const LESSONS_REPEATS_ROUTES = /^\/v1\/dev\/(?:projects\/([^/]+)\/)?lessons\/repeats$/u;

/** Lane W part 4: the company administrator's routes (company-member-routes.ts). Unknown, before anyone is authenticated, when the deployment has no company layer or no member helper. */
async function companyAdminRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const members = deps.developer.companyMembers;
  if (deps.companies === undefined || members === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Full access only (DEC ANSWER-4): the route table's `full` row is applied while authenticating, before any membership is read.
  const { caller, stepUp } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The member helper's caller is the signed-in person only (its schema is strict and pinned): the step-up travels beside it, and the web-app mark (DEC 236h) is not the helper's.
  const { stepUp: _callerStepUp, webApp: _webApp, ...person } = caller;
  void _callerStepUp; void _webApp;
  return routeCompanyMembers({
    documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, members,
    projectsInCompany: async (names, company) => new Set((await projectsWithPolicy(deps, names, company)).keys()),
  }, { caller: person, stepUp, companyId }, request, url);
}

/** Guided onboarding PR 1: the GitHub connect routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function githubConnectRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.githubConnect;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // Guided onboarding PR 3: the step-up the verified token carries travels beside the caller, for disconnect (its age is checked there).
  const { caller, stepUp } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeGithubConnect({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url, stepUp);
}

/** Guided onboarding PR 4: the Add to Slack routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function slackInstallRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.slackInstall;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const { caller, stepUp } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeSlackInstall({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, stepUp, companyId, request, url);
}

/** Guided onboarding PR 5: a project's Slack channel. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function slackChannelLinkRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.slackChannels;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const { caller } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeSlackChannelLink({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, wiring }, caller, companyId, request, url);
}

/** Guided onboarding PR 7: the Linear connect routes. Unknown, before anyone is authenticated, without the company layer or the wiring. */
async function linearConnectRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const wiring = deps.developer.linearConnect;
  if (deps.companies === undefined || wiring === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  // The step-up the verified token carries travels beside the caller, for disconnect (its age is checked there).
  const { caller, stepUp } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeLinearConnect({
    documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, now: deps.now, wiring,
    projectInCompany: async (project, company) => (await projectsWithPolicy(deps, [project], company)).has(project),
    projectRole: async (project, personId, company) => (await projectGrant(memberActions(deps), project, personId, company))?.role,
    // A project's first tracker team: where the new-hosted-project ticket-updates default is saved (once, only if none is saved), for a company whose tasks start on the core.
    ...(deps.developer.coreIntake === undefined ? {} : { onFirstTeam: async (company: string, project: string, personId: string) => { await deps.developer.coreIntake!.seedTicketUpdates(OrgIdSchema.parse(company), project, personId); } }),
  }, caller, companyId, request, url, stepUp);
}

/** L2-4: a project's waiting tickets (hosted-intake-routes.ts parses what this matched). */
export const HOSTED_INTAKE_ROUTES = /^\/v1\/dev\/projects\/([^/]+)\/intake(?:\/([^/]+)\/(start|dismiss))?$/u;

/** L2-4: the waiting-ticket routes. Unknown, before anyone is authenticated, without the company layer or the core's intake. */
async function hostedIntakeRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, match: RegExpExecArray): Promise<unknown> {
  const intake = deps.developer.coreIntake;
  if (deps.companies === undefined || intake === undefined) throw agentXError("NOT_FOUND", "route not found");
  const route = devRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "not found");
  const { caller } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return routeHostedIntake({
    documentClient: deps.documentClient, signInTableName: deps.developer.signInTableName, intake,
    projectInCompany: async (project, company) => (await projectsWithPolicy(deps, [project], company)).has(project),
    projectRole: async (project, personId, company) => (await projectGrant(memberActions(deps), project, personId, company))?.role,
  }, caller, companyId, request, { project: match[1]!, itemId: match[2], act: match[3] });
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
  const { caller } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  if (deps.knowledge === undefined) return knowledgeSwitchedOff(wire, deps.now());
  return deps.knowledge.answer(wire, { kind: "person", personId: caller.developerId });
}

const MACHINE_SIZE_ON_THE_PAGE = "Changing the machine size needs the Rovara web page with a fresh sign-in";
const MACHINE_SIZE_ROLE_REQUIRED = "Only a company owner or admin, or this project's administrator, may choose a machine size";
export async function requireMachineSizePage(caller: DeveloperCaller, nowMs: number, windowSeconds?: () => Promise<unknown>): Promise<void> {
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", MACHINE_SIZE_ON_THE_PAGE);
  await freshStepUp(caller, windowSeconds, nowMs, MACHINE_SIZE_ON_THE_PAGE);
}
export function requireMachineSizeRole(companyAdmin: boolean, projectAdmin: boolean): void {
  if (!companyAdmin && !projectAdmin) throw agentXError("FORBIDDEN", MACHINE_SIZE_ROLE_REQUIRED);
}

/** Hosted TE-C5 read and page-only stored choice. A selection is a project setting; it never changes a worker launch or task estimate. */
async function checkedMachineSize(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, rawProject: string): Promise<unknown> {
  if (!machineSizeEnabled()) throw agentXError("NOT_AVAILABLE_HERE", "Machine size suggestions are not set up here.");
  const companyId = await resolveCompany(deps.companies, caller.developerId);
  if (request.method === "POST") {
    const window = deps.developer.stepUpWindowSeconds;
    await requireMachineSizePage(caller, deps.now(), window === undefined || companyId === undefined ? undefined : () => window(companyId));
  }
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

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (isCompanyMemberPath(url.pathname)) return companyAdminRoute(deps, request, url);
  if (isGithubConnectPath(url.pathname)) return githubConnectRoute(deps, request, url);
  if (isSlackChannelLinkPath(url.pathname)) return slackChannelLinkRoute(deps, request, url);
  if (isSlackInstallPath(url.pathname)) return slackInstallRoute(deps, request, url);
  if (isLinearConnectPath(url.pathname)) return linearConnectRoute(deps, request, url);
  const intakeMatch = HOSTED_INTAKE_ROUTES.exec(url.pathname);
  if (intakeMatch !== null) return hostedIntakeRoute(deps, request, url, intakeMatch);
  if (isCompanyEngineModelPath(url.pathname)) return companyEngineModelRoute(deps, request, url);
  if (url.pathname === "/v1/dev/company/preapprovals" || url.pathname.startsWith("/v1/dev/company/preapprovals/")) return companyPreapprovalRoute(deps, request, url);
  if (url.pathname === "/v1/dev/company") return companySelfCreateRoute(deps, request, url);
  // Spec 062 FR-031: the page a link_required event links to. Signed in like the task page, but needs no tasks.
  if (url.pathname.startsWith("/review/link/")) {
    const links = deps.channelLinks;
    if (links === undefined && deps.channelLinkCodes === undefined) throw agentXError("NOT_FOUND", "channel adapters are not enabled in this deployment");
    return createChannelLinkWeb({
      origin: deps.developer.issuer,
      authenticateSession: async (sessionId) => {
        try { return await authenticateDeveloperSessionId(deps, sessionId); }
        catch { return undefined; }
      },
      preview: (code, personId) => deps.channelLinkCodes === undefined ? previewLinkCode(links!, code) : deps.channelLinkCodes.preview(personId, code),
      redeem: (developerId, code) => deps.channelLinkCodes === undefined ? redeemLinkCode(links!, developerId, code) : deps.channelLinkCodes.redeem(developerId, code),
    })(request, url);
  }
  if (url.pathname.startsWith("/review/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    const authenticateSession = async (sessionId: string) => {
      try { return await authenticateDeveloperSessionId(deps, sessionId); }
      catch { return undefined; }
    };
    // Task 18: the read-only task page and its "moved on" check; every other /review/ path is the PR-feedback review.
    // Spec 061 slice 2: the page's JSON API is matched here too, so the PR-feedback page never sees its paths.
    if (TASK_PAGE.test(url.pathname) || TASK_PEOPLE_CONFIRMATION.test(url.pathname) || TASK_STATUS.test(url.pathname) || TASK_PAGE_API_PREFIX.test(url.pathname)) {
      const routeDeps = (caller: DeveloperCaller) => developerTaskRouteDependencies(deps, caller);
      return createTaskWeb({
        authenticateSession,
        getTaskDocumentView: (caller, taskId) => getTaskDocumentView(routeDeps(caller), caller, taskId),
        getTaskFreshness: (caller, taskId) => getTaskFreshness(routeDeps(caller), caller, taskId),
        getTaskPeople: (caller, taskId) => getTaskPeople(routeDeps(caller), caller, taskId),
        getTaskPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        getTaskPeopleProposalMetadata: (caller, taskId, requestId) => getTaskPeopleProposalMetadata(routeDeps(caller), caller, taskId, requestId),
        getTaskPersonName: (caller, taskId, personId) => getTaskPersonPresentationName(routeDeps(caller), taskId, personId),
        getTaskPeopleCapabilities: (caller, taskId) => getTaskPeopleCapabilities(routeDeps(caller), caller, taskId),
        api: createTaskWebApi({
          origin: deps.developer.issuer,
          authenticateSession,
          taskState: (caller, taskId) => getTaskPageState(routeDeps(caller), caller, taskId),
          listComments: (caller, taskId) => listPageComments(routeDeps(caller), caller, taskId),
          createComment: (caller, taskId, input) => createPageComment(routeDeps(caller), caller, taskId, input),
          editComment: (caller, taskId, input) => editPageComment(routeDeps(caller), caller, taskId, input),
          deleteComment: (caller, taskId, input) => deletePageComment(routeDeps(caller), caller, taskId, input),
          setSuggestion: (caller, taskId, input) => setPageSuggestion(routeDeps(caller), caller, taskId, input),
          decide: (caller, taskId, input) => decideOnPage(routeDeps(caller), caller, taskId, input),
          retryApplicationRound: (caller, taskId, input) => retryApplicationRoundOnPage(routeDeps(caller), caller, taskId, input),
          featureChoices: (caller, taskId) => pageFeatureChoices(routeDeps(caller), caller, taskId),
          setFeature: (caller, taskId, input) => setPageFeature(routeDeps(caller), caller, taskId, input),
          readE2EArtifact: (caller, taskId, sha256) => getTaskE2EArtifact(routeDeps(caller), caller, taskId, sha256),
          getPeople: (caller, taskId) => getTaskPeople(routeDeps(caller), caller, taskId),
          proposePeopleRole: (caller, taskId, input) => proposeTaskPeopleRoleForPage(routeDeps(caller), caller, taskId, input),
          proposeOwnership: (caller, taskId, input) => proposeTaskOwnershipForPage(routeDeps(caller), caller, taskId, input),
          getPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
          confirmPeopleRequest: (caller, taskId, requestId) => confirmTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
          getPeopleCandidates: (caller, taskId) => getTaskPeopleCandidatesForPage(routeDeps(caller), caller, taskId),
          addPeople: (caller, taskId, input) => addTaskWebPersonForPage(routeDeps(caller), caller, taskId, input),
        }),
      })(request, url);
    }
    const web = createFeedbackReviewWeb({
      origin: new URL(deps.developer.issuer).origin,
      authenticateSession,
      getWorkflowFeedbackReview: (caller, taskId) => getWorkflowFeedbackReview(developerTaskRouteDependencies(deps, caller), caller, taskId),
      submitWorkflowFeedbackDecision: (caller, taskId, input) => submitWorkflowFeedbackDecision(developerTaskRouteDependencies(deps, caller), caller, taskId, input),
      now: deps.now,
    });
    return web(request, url);
  }
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
  const { caller, stepUp } = await authenticateCallerWithStepUp(deps, request.headers.authorization, route);
  const machineSize = /^\/v1\/dev\/projects\/([^/]+)\/machine-size$/u.exec(url.pathname);
  if (machineSize !== null && (request.method === "GET" || request.method === "POST")) return routeMachineSize(deps, caller, request, machineSize[1]!);
  const settings = /^\/v1\/dev\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (settings !== null) return projectSettingsRoute(deps, caller, request, settings[1]!);
  if (url.pathname === "/v1/dev/company/settings-compliance") return projectSettingsComplianceRoute(deps, caller, url);
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") {
    const scope = deps.companies === undefined ? undefined : boundedCompanyReads(deps.documentClient);
    const companyId = await resolveCompany(deps.companies, caller.developerId);
    const result = await listProjects(scope === undefined ? deps : { ...deps, documentClient: scope.client }, caller, companyId);
    scope?.check();
    return result;
  }
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (request.method === "PUT" && url.pathname === "/v1/dev/me/name") return setMyName(deps, caller, request);
  if (url.pathname === "/v1/dev/me/sign-in-factors") return routeSignInFactors(deps.developer.signInLinks, caller, request, url); // L4-MF4: the caller's own confirmation email (masked) and passkeys (sign-in-link-routes.ts).
  if (/^\/v1\/dev\/(?:me\/sign-ins(?:\/link|\/link\/finish|\/[^/]+)?|company\/members\/[^/]+\/sign-ins(?:\/[^/]+)?)$/.test(url.pathname)) return routeSignInLinks(deps.developer.signInLinks, caller, request, url); // DEC 254w: connected sign-ins (sign-in-link-routes.ts).
  // Lane LM8: the lessons API answers as the signed-in person; the company comes from their membership, inside it.
  if (LESSONS_API_ROUTES.test(url.pathname)) {
    if (deps.lessons === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    return deps.lessons.answer({ method: request.method, path: url.pathname, query: url.searchParams, ...(request.body === undefined ? {} : { body: request.body }) }, { personId: caller.developerId });
  }
  if (LESSONS_REPEATS_ROUTES.test(url.pathname)) {
    if (deps.lessonRepeats === undefined) throw agentXError("LESSONS_SWITCHED_OFF", LESSONS_OFF);
    return deps.lessonRepeats.answer({ method: request.method, path: url.pathname, query: url.searchParams }, { personId: caller.developerId });
  }
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    const checked = request.method === "GET" && (url.pathname === "/v1/dev/tasks" || /^\/v1\/dev\/tasks\/[^/]+(?:\/(messages|diff|comments|events|readers))?$/.test(url.pathname));
    const scope = checked && deps.companies !== undefined ? boundedCompanyReads(deps.documentClient) : undefined;
    // Lane W: a merge press is company-checked too (membership, never a claim), and only it carries the caller's step-up.
    const merging = request.method === "POST" && /^\/v1\/dev\/tasks\/[^/]+\/merge$/.test(url.pathname);
    const companyId = checked || merging ? await resolveCompany(deps.companies, caller.developerId) : undefined;
    const taskDeps = developerTaskRouteDependencies(scope === undefined ? deps : { ...deps, documentClient: scope.client }, caller);
    const checkedDeps = scope === undefined ? taskDeps : { ...taskDeps, actions: companyReadActions(taskDeps.actions, scope),
      ...(taskDeps.workflowE2EPresentation === undefined ? {} : { workflowE2EPresentation: (input: Parameters<NonNullable<DeveloperTaskRouteDependencies["workflowE2EPresentation"]>>[0]) => scope.read(() => taskDeps.workflowE2EPresentation!(input)) }) };
    const result = await routeDeveloperTaskRequest({
      ...checkedDeps, ...(companyId === undefined ? {} : { companyId }),
      ...(merging && deps.taskMerge !== undefined ? { taskMerge: deps.taskMerge } : {}), ...(merging && stepUp !== undefined ? { stepUp } : {}),
    }, caller, request, url);
    // Only a completed list page with an explicit continuation may consume an item-bound signal.
    scope?.check(url.pathname === "/v1/dev/tasks" && result !== null && typeof result === "object" && "nextCursor" in result);
    return result;
  }
  if (url.pathname === CHATGPT_CONNECTION_PATH || url.pathname === `${CHATGPT_CONNECTION_PATH}/finish`) {
    return routeChatGptConnection(deps, caller, request, url);
  }
  if (url.pathname === "/v1/dev/channel-links" || url.pathname.startsWith("/v1/dev/channel-links/")) {
    return routeOwnChannelLinks(deps, caller, request, url);
  }
  throw agentXError("NOT_FOUND", "route not found");
}

/**
 * Lane L12: the core engine's own /v1/app/* routes. Like /v1/dev/*, no API Gateway authorizer runs on them: a method and path with no row in the route table (APP_ROUTES), or any
 * /v1/app/* path while the core switch is off (no `coreApp`), is refused before anyone is authenticated; otherwise the broker verifies the developer token, checks the row's scope and
 * hands the signed-in caller (with the verified step-up) to the core, which takes the company from live membership. The core's answer is returned as it is (its status and body), never cached.
 */
export async function routeAppRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL): Promise<BrokerResponse> {
  const core = deps.developer.coreApp;
  if (core === undefined) throw agentXError("NOT_FOUND", "route not found");
  // The core matches the raw path; a path the URL parser would read differently (a backslash, say) is refused rather than matched two ways.
  if ((request.path.split("?")[0] ?? "") !== url.pathname) throw agentXError("NOT_FOUND", "route not found");
  const route = appRouteOf(request.method, url.pathname);
  if (route === undefined) throw agentXError("NOT_FOUND", "route not found");
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
