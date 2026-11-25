import { feedbackOwner } from "../core/pr-feedback/decide.js";
import { isPrFeedbackPath, type createPrFeedbackRoutes } from "./pr-feedback-routes.js";
import { committedResponse } from "../core/task-flow/committed-response.js";
import type { WorkflowDecisionRequest } from "@agentx/contracts";
import { parityTaskRoute, routeParityTask } from "./parity-task-routes.js";
import { PullRequestResultSchema } from "@agentx/contracts";
import type { OperationRecord } from "../core/task-flow/records.js";
import { startManualPublication } from "../core/task-flow/manual-publication.js";
import { shareTask } from "../core/task-flow/share.js";
import { parsePreviewRequestV2, restrictPreviewV2 } from "@agentx/contracts";
import { startEstimates, type PreviewContext } from "../core/cost/start-estimates.js";
import { readTaskMoney } from "../core/cost/task-money.js";
import type { TaskMoneyV1 } from "@agentx/contracts";
// Engine host (lane E2): the core's own handlers, mounted on the deployed developer API (every new task of a member company starts on the core: #1275).
//
// The controller decided that, once the host is deployed, these answers come from the core itself, not from adapters on the old broker:
//   - sessions (`/v1/app/sessions...`): a session's read (the task view with its evidence), the understanding answers (`POST .../answers`), stop, retry, follow;
//   - a task's read (`GET /v1/dev/tasks/<id>`), whose view carries the evidence kept for its checked code;
//   - a task's proof index (`GET /v1/dev/tasks/<id>/evidence`, Cloud's Proof tab): the task read's own rule, then the items the proof page shows for the current code and its failing tests (at most ten);
//   - a task's START (`POST /v1/dev/tasks`), for a member of a company (`engineForNewTask`, always the core). A person with no member company
//     gets `undefined`: the old broker starts the task exactly as before (lane E2 step 6; until the spec 056 workflow is removed, #1274). A membership read that fails refuses (the sign-in refusal), never falls back;
//   - decision cards (`/v1/app/decisions`): the list, through the deployment's sources (each checks the caller's live authority). Acting on a card (approve, reject, request changes,
//     evidence-opened) needs the signed-in person's live authority, checked by the performer (DEC 254zzz73: there is no step-up);
//   - the owner's moves on a task already running (DECISIONS 198): `POST /v1/dev/tasks/<id>/workflow/send-back`, `.../workflow/review-findings` and `.../continue`, with the
//     old workflow routes' request and answer (`{ task }`), so Cloud's Send back and Accept findings work for a task of either engine. Served only when the deployment wires the money
//     cap per round (`taskActions.roundCap`) AND the company's owner rule (`TaskAccess.ownerActing` on the runtime's access): without that seam the flow would use Code's laptop rule
//     (the install's owner role), which a hosted company never uses for who owns a task;
//   - the company's agent directory (`GET /v1/app/agents`, lead 4 L4-MF3): read only, for a LIVE company owner or administrator only (agent-directory-routes.ts);
//   - how we work (`GET /v1/app/projects/<p>/how-we-work`, `.../playbook`): read only, for a person the company lets read that project, or a live company owner or admin for a project of their company (L4-PB, DEC 254zzj);
//   - the project's test environment (`GET /v1/app/projects/<p>/test-environment`, DEC 254z-amend3): read only, the laptop's own state answer (`testEnvironmentView`, as local/app/test-environment.ts serves it)
//     from the company's records, with whether test services are on and, when the host cannot run them, why ("Test services not available here: ..."), and the catalog they would use. Same rule as how we work:
//     for a person the company lets read that project, or a live company owner or admin for a project of their company (L4-B3c); proposing and approving are not on the core here (no hosted approval path for a test environment yet);
//   - approving that environment (`POST /v1/app/projects/<p>/test-environment/approve`, L4-B3b): the person's right to read the project, then the risk-based approver rule (a company owner or admin, or
//     the project's maintainer for low and medium risk; high risk a company owner or admin only), read live again inside the decision, with the approvers point's own proof; served only where the deployment wires it;
//   - the project's saved environment image (`GET /v1/app/projects/<p>/environment-image`, L4-MF1): read only, the Environment panel's own view (`savedEnvPanel`, fixed words, counts and times) from the company's
//     saved-environment row for that project, for a person the company lets read that project (any project role; `canReset` is always false here). Saved environments are off on a hosted install until the
//     install switch is on: then it answers a plain 404 "Saved environments are off for this install", never made-up data. Reset and the setting are not on the core here;
//   - the setup run (`/v1/app/projects/<p>/setup-agent...`, guided onboarding L2-3): start, re-run, stop, the journal, confirm and discard, for a live company owner or admin or the
//     project's administrator (a project user reads it), and deciding a setup candidate (L4-D) with the risk-based approver rule; the rules are setup-run-routes.ts's;
//   - a project's ticket-sharing settings (`/v1/app/projects/<p>/intake/updates`, audit gap 11b): the laptop's GET and PUT, any project role reads, a live company owner or admin or the project's administrator changes (ticket-updates-routes.ts);
//   - script tokens (`/v1/app/script-tokens...`): list and revoke; MAKING one needs a live company owner/admin role and the Rovara website's own client (DEC 254zzz73: no step-up; DEC 254zzz91: website only). A token's own requests are not accepted
//     here either (the broker's sign-in decides that).
//
// Rules:
//   - Off (the default) is byte-identical: `route` answers `undefined` for every request without reading anything, and the old broker answers as before.
//   - A path this module does not own is `undefined` too; `/v1/local/*` (the laptop's page routes) is never served.
//   - The caller's company comes from MEMBERSHIP (`companyOf`, R4's reader), never from a header, a query, a body or a token claim. A reader that throws or answers nothing refuses the
//     call with the sign-in refusal; there is no fallback to the install's company.
//   - A handler the deployment has not wired answers a fixed "not on the core yet" (never a laptop default: the session levels, decision authority and the playbook's code host are the
//     deployment's).
import { AgentXError, ON_THE_WEBSITE_MESSAGE, type TaskPeopleView, OrgRoleSchema, type DeveloperSignInMethod, SavedEnvPanelSchema, agentXError, orgProjectCatalogKey, type AnswerResponse, type AuditSink, type DocumentStore, type ObjectStorage, type OrgId, type OrgRole, type Principal } from "@agentx/contracts";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import { loadOwnedTask, readTask, taskViewOf } from "../core/task-flow/reads.js";
import { decideTaskRead, maySeeTaskMoney as roleMaySeeTaskMoney, type TaskRead, type TaskReadDecision, type TaskReadSeams } from "../core/task-flow/read-rule.js";
import { coreTaskRuleOf } from "./task-rule-paths.js";
import { routeTaskScreen, taskScreenRoute } from "./task-screen-routes.js";
import { involvedListOptions, listInvolvedTasks, wantsInvolved } from "../core/task-flow/involved.js";
import type { TaskActionsOptions } from "../core/task-flow/owner-round.js";
import { createTaskActions, type TaskActions } from "../core/task-flow/task-actions.js";
import type { TaskStanding } from "../core/task-view/index.js";
import { stopTaskOnRequest } from "../core/task-flow/stop-request.js";
import { SECURITY_ACCEPT_ON_THE_PAGE } from "../core/task-flow/security-accept.js";
import { routeDecisionCards, type DecisionCaller, type DecisionRouteDependencies } from "../core/decisions/routes.js";
import type { SessionMembers } from "../core/sessions/access.js";
import { answerTaskOnRequest } from "../core/task-flow/answer-request.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { PlaybookService } from "../core/playbook/service.js";
import { createScriptToken, listScriptTokens, readScriptToken, scriptTokenStatus, revokeScriptToken, scriptTokensEnabled, type ScriptTokenCaller } from "../core/script-tokens/index.js";
import { SCRIPT_TOKEN_CREATE_ADMIN_ONLY } from "../core/script-tokens/store.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { createSessionRoutes } from "../local/app/session-routes.js"; import { INBOX_PATH, createInboxRoutes, inboxAnswer, inboxOwns } from "./inbox-routes.js";
import { createLocalPlaybook } from "../local/app/playbook.js";
import { isKnownFailingPath, routeKnownFailing } from "./known-failing-routes.js";
import { hostedTestingView, observeHostedBlockedTask } from "./known-failing.js";
import { developerTaskView } from "../local/app/task-view.js";
import { proofIndexOf } from "../local/app/proof-index.js";
import { loadEvidencePack } from "../core/proof/evidence-keep.js";
import { hostedEvidenceBlobs } from "./hosted-evidence.js";
import type { CoreHostApp } from "./app.js";
import type { TestEnvDeps } from "../core/test-env/deps.js";
import type { ServiceCatalogSource } from "../core/test-env/dependency-plan.js";
import { testEnvironmentView } from "../core/test-env/local-view.js";
import { readProposal } from "../core/test-env/environment.js";
import { testServicesSwitchedOn } from "../core/test-env/test-services-switch.js";
import { savedEnvPanel } from "../core/test-env/saved-env-panel.js";
import { documentSavedEnvStore } from "../core/test-env/saved-env-store.js";
import type { CoreRuntime } from "./core-runtime.js";
import { AGENT_MODELS_PATH, agentModelRoute } from "./agent-model-routes.js";
import type { AgentModelChoice } from "./gateway-model-selection.js";
import { isSetupCheckPath, isSetupRunPath, routeHostedSetupCheck, routeHostedSetupRun, type HostedSetupRunWiring } from "./setup-run-routes.js";
import { isWikiMapPath, routeHostedWikiMap, type HostedWikiMapWiring } from "./wiki-map-routes.js";
import { scriptTokenRoute } from "../core/script-tokens/authenticate.js";
import { isWikiPath, routeHostedWiki, type HostedWikiWiring } from "./wiki-routes.js";
import { isWikiCorrectionPath, routeHostedWikiCorrections, type HostedWikiCorrectionsWiring } from "./wiki-corrections-routes.js";
import type { HostedTestEnvironmentDecider } from "./hosted-test-environment-decision.js";
import { z } from "zod";
import { isReportPath, routeHostedReport, type HostedReportWiring } from "./report-routes.js";
import { isWikiBuildPath, routeHostedWikiBuild, type HostedWikiBuildWiring } from "./wiki-build-routes.js";
import { hostedAnswerService, isAnswersPath, routeHostedAnswers, type HostedAnswersWiring } from "./answer-routes.js";
import { isStartSuggestPath, routeHostedStartSuggest, type HostedStartSuggestWiring } from "./start-suggest-routes.js";
import { isUpkeepPath, routeHostedUpkeep, type HostedUpkeepWiring } from "./upkeep-routes.js";
import { isEvalCheckPath, routeHostedEvalCheck, type HostedEvalCheckWiring } from "./eval-check-routes.js";
import { isBrowserTestingPath, routeHostedBrowserTesting, type HostedBrowserTestingWiring } from "./browser-testing-routes.js";
import { isAgentDirectoryPath, routeHostedAgentDirectory } from "./agent-directory-routes.js";
import { isSystemRunsPath, routeHostedSystemRuns } from "./system-runs-routes.js";
import { isPackageRegistriesPath, routeHostedPackageRegistries, type HostedPackageRegistriesWiring } from "./package-registries-routes.js";
import { isHostedMergePath, routeHostedMerge, type HostedMergeWiring } from "./hosted-merge-routes.js";
import { createTaskActionRoutes, type TaskActionChat } from "./task-action-routes.js";
import { isTicketUpdatesPath, routeHostedTicketUpdates, type HostedTicketUpdatesWiring } from "./ticket-updates-routes.js";
import { isIntakePath, routeHostedIntake, type HostedIntakeAppWiring } from "./intake-routes.js";

async function applicationReadProjection(runtime: CoreRuntime, record: TaskRecord, personId: string) {
  if (record.workflow === undefined) return {};
  const e2e = await runtime.flow.deps.applicationE2E?.results.read({ ...record, workflow: record.workflow }, personId === record.developerId ? "owner" : "viewer");
  return e2e === undefined ? {} : { e2ePresentation: e2e.presentation };
}

/** The paths this module owns. Anything else is the old broker's. */
const SESSIONS = /^\/v1\/app\/sessions(?:\/|$)/u;
const TASK_READ = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})$/u;
/** A core task's proof index (Cloud's `tasks.evidence.list`): the task read's own rule, then what the proof page reads (proof-index.ts). */
const TASK_EVIDENCE = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/evidence$/u;
/** The owner's moves on a task already running (DECISIONS 198), on the old workflow routes' paths. */
const TASK_ACTION = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/(workflow\/send-back|workflow\/review-findings|workflow\/review|pull-requests|share|continue)$/u;
/**
 * DEC 254zzz39 (6): the task owner's "Accept findings" on Rovara's web page (`{ requestId, expectedRevision, candidateDigest, resolutions }` in, as the workflow route; `{ task }` out). The one route that accepts a
 * SECURITY finding on a core task: only the web app's own sign-in client (`webApp`), only for the task's owner (or a People co-owner); the move is then made as the page's (`via: "page"`).
 */
const TASK_PAGE_FINDINGS = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/review-findings$/u;
/** A person's Stop on a core task, on the old cancel route's path (`{ requestId }` in, `{ task }` out), so Cloud's Stop and the AI tools' cancel stop a task of either engine. */
const TASK_CANCEL = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/cancel$/u;
const TASK_START = "/v1/dev/tasks";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DECISIONS = /^\/v1\/app\/decisions(?:\/|$)/u;
/** The owner's answers to Understand's questions on a core task (D5: owners only), so Cloud's answer form reaches a hosted core task, which has no session record. `{ task }` out. */
const TASK_ANSWERS = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/answers$/u;
const PLAYBOOK = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/(?:how-we-work|playbook)$/u;
const SCRIPT_TOKENS = /^\/v1\/app\/script-tokens(?:\/([^/]+)\/revoke)?$/u;
const START_ESTIMATES = /^\/v1\/dev\/projects\/([a-z][a-z0-9-]{0,62})\/start-estimates$/u;
const SAVED_ENV_IMAGE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/environment-image$/u;
const TEST_ENVIRONMENT = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/test-environment$/u;
/** L4-B3b: approving the proposal that waits (a POST). */
const TEST_ENVIRONMENT_APPROVE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/test-environment\/approve$/u;
/** What the person saw, as the approve route's body (strict: nothing else is read from the client). */
const ApproveTestEnvironmentBodySchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  revision: z.number().int().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const SAVED_ENV_OFF = "Saved environments are off for this install";
export const NOT_ON_THE_CORE_YET = "That is not on the core engine on this install yet.";
export const SIGN_IN_AGAIN = "Sign in again.";
export const NOT_FOR_SCRIPT_TOKENS = "A script token cannot do that.";
export const SESSION_CAP_UNREADABLE = "This install's session limit could not be read, so no token was made. Try again later, or ask whoever runs the install.";
const PROJECT_NOT_FOUND = "project not found";
export const INVOLVED_UNAVAILABLE = "Your involved tasks could not be listed right now. Try again in a moment.";

/** The deployed caller, as the broker's sign-in vouches for it. */
export interface DeployedCaller {
  /** Trusted linked Slack account, never supplied by the request. */
  slackUserId?: string | undefined;
  principal: Principal;
  client?: string | undefined;
  /** Set by the broker's sign-in when the request carries a script token (never from a body). Such a caller reaches task reads and explicitly scoped wiki reads here. */
  scriptToken?: { tokenId: string } | undefined;
  /** How the person signed in (the verified token's `amr`), set by the broker's sign-in and never from a header, a query or a body. Kept on a script token's record. Absent: not known. */
  amr?: DeveloperSignInMethod | undefined;
  /**
   * Set only by the broker's sign-in, from the verified client's registration, for the Rovara web app's own sign-in client (DEC 236h; never the CLI's token, a tool's or another client's). Everything else that reads the wiki
   * is a tool outside Rovara and is held to the company's "Knowledge stays in Rovara" switch (`wiki-routes.ts`). DEC 254zzz39 (6): the client must be registered with full access AND marked `webApp`
   * by the operator; never from a header, a query or a body. The web page's own routes also read it (accepting a security finding).
   */
  webApp?: true | undefined;
}

/** A decision card's caller on the deployed API: who acts, as the broker's sign-in vouched for them. */
export interface DeployedDecisionCaller extends DecisionCaller {
  principal: Principal;
  /** Authenticated Rovara website client, carried from sign-in for KF writes only. */
  webApp?: true | undefined;
}

/** What membership says about the caller: the company and the live role in it (never a token claim). */
export interface CompanyMembership {
  companyId: string;
  role: OrgRole;
}

/** What the deployment wires for one company. Each part is optional; a missing one answers `NOT_ON_THE_CORE_YET`. */
export interface CoreDevWiring {
  prFeedback?: ReturnType<typeof createPrFeedbackRoutes> | undefined;
  startEstimates?: (project: string) => Promise<PreviewContext>;
  /** The session levels from the company's own records (lanes ID and T). Without it the session routes are not served (the laptop's default is the sole owner). */
  members?: SessionMembers;
  /** The decision cards' sources and performer (each checks the caller's live authority). */
  decisions?: DecisionRouteDependencies<DeployedDecisionCaller>;
  /** The existing hosted approval gate, on the developer workflow-decision wire shape. */
  workflowDecision?: (caller: DeployedDecisionCaller, taskId: string, request: WorkflowDecisionRequest) => Promise<void>;
  /**
   * The owner's moves on a task already running (send back, review findings, continue; DECISIONS 198). `roundCap` is the money cap each round is held to (the task's limit and what it has
   * spent; a throw, or an unreadable spend, refuses the round). It is required so the deployment says what it holds; `async () => undefined` holds none. Served only when the runtime's
   * `TaskAccess.ownerActing` (the company's owner and co-owner rule) is wired too; otherwise these routes are not the core's yet here.
   */
  taskActions?: { roundCap: NonNullable<TaskActionsOptions["roundCap"]> };
  /** How we work, read through the company's code host. Served only with `canReadProject`. */
  playbook?: PlaybookService;
  /** Whether this person may read this project (their project grant from the company's own records). A project they may not read answers exactly like a missing one. */
  canReadProject?: (personId: string, project: string, companyId?: string) => Promise<boolean>;
  /**
   * DEC 254z-amend3: the project's test environment, read only. `env` is the install's switches (the function's environment, with the host's test services marker); `serviceCatalog` is the catalog the install would
   * pin dependencies from (hosted: the owner starter list, `hostedServiceCatalog`), `catalogName` how the answer names it. Served only with `canReadProject`.
   */
  testEnvironment?: { env: NodeJS.ProcessEnv; serviceCatalog?: ServiceCatalogSource | undefined; catalogName: "owner-starter-list" };
  /**
   * L4-B3b (DEC 254zm item 4): approving the project's test environment (`POST /v1/app/projects/<p>/test-environment/approve`): the risk-based approver rule read live, the approvers
   * point's own proof, the approval gate (test-environment-approval.ts). Absent: that path says "not on the core yet". Served only with `canReadProject`.
   */
  testEnvironmentApproval?: HostedTestEnvironmentDecider;
  /**
   * L4-MF1: the project's saved environment image, read only (`GET /v1/app/projects/<p>/environment-image`). `enabled` is the install's saved-environments switch (`savedEnvEnabled(env)`); off, the read answers
   * `SAVED_ENV_OFF` (404), never invented data. Served only with `canReadProject`. Absent: "not on the core yet".
   */
  savedEnv?: { enabled: boolean };
  /** Script tokens' list and revoke (the token store is the core's; the audit sink is the registry's). */
  scriptTokens?: { enabled?: () => boolean };
  /**
   * The install's session cap in seconds, where it caps every session: a script token made here lives no longer than a session would. Absent: no cap (the days
   * asked for). Anything but a positive whole number makes no token (fixed words), never one without the cap.
   */
  sessionCapSeconds?: number;
  /** The company's agent model choice over the gateway's offered models (`createAgentModelChoice`). Absent: `/v1/app/agent-models` says "not on the core yet". */
  modelChoice?: AgentModelChoice;
  /** The URL clients reach the API at (a session's `link`). */
  origin: () => string; unsubscribeKey?: Buffer;
  /** Hosted wiring (d): the audit sink for one request, naming the caller it came through (`auditSinkForDeployedCaller`). Absent: the registry's sink as it is. */
  auditFor?: (caller: DeployedCaller, sink: AuditSink) => AuditSink;
  /** Guided onboarding L2-3: the hosted setup run (`/v1/app/projects/<p>/setup-agent...`, setup-run-routes.ts). Absent: those paths say "not on the core yet". */
  setupRun?: HostedSetupRunWiring;
  /** Wiki W0: the free file map (`/v1/app/projects/<p>/wiki-map`, wiki-map-routes.ts). Absent: that path says "not on the core yet". */
  wikiMap?: HostedWikiMapWiring;
  /** Lead 4 W2: the project wiki's reads (`/v1/app/projects/<p>/wiki...`, wiki-routes.ts). Absent: those paths say "not on the core yet". */
  wiki?: HostedWikiWiring;
  /** Lead 4 C1: the project wiki's corrections (`.../wiki/pages/<p>/notes|flags|corrections`, `.../wiki/disputed`, wiki-corrections-routes.ts). Absent: those paths say "not on the core yet". */
  wikiCorrections?: HostedWikiCorrectionsWiring;
  /** Lead 4 A1/A2: the cost and time report (`/v1/app/org/report/...` and `POST /v1/app/tasks/<id>/feature`, report-routes.ts). Absent: those paths say "not on the core yet". */
  report?: HostedReportWiring;
  /** Lead 4 W4: the wiki build controls (`/v1/app/projects/<p>/wiki-build...`, wiki-build-routes.ts). Absent: those paths say "not on the core yet". */
  wikiBuild?: HostedWikiBuildWiring;
  /** Lead 4 J3: the web start box's path suggestion (`POST /v1/app/projects/<p>/code/suggest`, start-suggest-routes.ts). Absent: that path says "not on the core yet". */
  startSuggest?: HostedStartSuggestWiring;
  /** Lead 4 J1: the smart Just answer route (`POST /v1/app/projects/<p>/answers`, answer-routes.ts). Absent: that path says "not on the core yet". */
  answers?: HostedAnswersWiring;
  /** Lead 4 N1: the nightly upkeep switch (`/v1/app/projects/<p>/upkeep`, upkeep-routes.ts). Absent: that path says "not on the core yet". */
  upkeep?: HostedUpkeepWiring;
  /**
   * Core task web routes (Cloud #188 item 3): the old task routes a core task had no answer for (People and take-over, readers, the events timeline, plan comments), with the old routes' own access rules
   * (aws/core-task-rule-routes.ts). The task is read here from the caller's own company first; anyone else reads no such task. Absent: those routes are not the core's here (the engine boundary then says so to
   * someone who may read the task, and gives anyone else the missing task's answer).
   */
  taskRules?: {
    route(input: { request: BrokerRequest; path: string; person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown>; store: Pick<DocumentStore, "query">; authorize(read: TaskRead, seams?: TaskReadSeams): Promise<TaskReadDecision> }): Promise<BrokerResponse>;
    /** S1: the People moves the registry's first cut offers, in process (the same People functions the routes above call): the view, and taking over a task nobody owns (propose, then confirm, each re-read). */
    people?: {
      view(input: { person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown> }): Promise<TaskPeopleView>;
      takeOwnership(input: { person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown>; requestId: string; expectedPeopleRevision: number }): Promise<void>;
    };
    /** The task's own person's live hold on their task (the hotfix's one test: the grant, or the access that let them start it): the read rule's live-grant seam asks it for the task's own person. Absent: the grant reader answers for them. */
    holdsOwnTask?(input: { person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown> }): Promise<boolean>;
    /** DEC 254zzz44 (a): the person's stored share (spec 067) on this task: its role as stored, while they are still a member of its project, read live. The read rule (core/task-flow/read-rule.ts) decides what it shows. */
    sharedReader(input: { person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown> }): Promise<{ role: string } | undefined>;
  };
  /** L4-U5b: what the inbox's project notices (`GET /v1/app/inbox/project-notices`) are checked against, live: whether the person still administers the project, and the project's open repair card. Absent: that route lists nothing. */
  projectNotices?: { administers(orgId: string, developerId: string, project: string): Promise<boolean>; setupRead?(orgId: string, project: string): Promise<{ key: string; failedStep: string; fixReady: boolean } | undefined> } | undefined;
  /** L4-EVCI2: the setup card's eval check from the customer's CI (`/v1/app/projects/<p>/ci-eval-check`, eval-check-routes.ts). Absent: that path says "not on the core yet". */
  evalCheck?: HostedEvalCheckWiring;
  /** Browser testing in a project's setup (`/v1/app/projects/<p>/browser-testing...`, browser-testing-routes.ts). Absent: those paths say "not on the core yet". */
  browserTesting?: HostedBrowserTestingWiring;
  /** DEC 254zzz94: the Merge button on a finished task (`/v1/app/tasks/<id>/merge`, hosted-merge-routes.ts). Absent: those paths say merging from Rovara is not set up. */
  merge?: HostedMergeWiring;
  /** Audit gap 11b: a project's ticket-sharing settings (`/v1/app/projects/<p>/intake/updates`, ticket-updates-routes.ts). Absent: that path says "not on the core yet". */
  ticketUpdates?: HostedTicketUpdatesWiring;
  /** R1 + L1 6.2b: a project's waiting tickets at the one `/v1/app/projects/{project}/intake` address (core-host/intake-routes.ts). Absent: those paths are not on the core. */
  intake?: HostedIntakeAppWiring;
  /** PRIVATE-PACKAGES P1b: the company's package tokens (`/v1/app/company/package-registries`, package-registries-routes.ts). Absent: that path says "not on the core yet". */
  packageRegistries?: HostedPackageRegistriesWiring;
}

export interface CoreDevRoutesOptions {
  app: CoreHostApp;
  /** The caller's company and live role from membership, never a claim. Undefined: not a member (refused). */
  companyOf(caller: DeployedCaller): Promise<CompanyMembership | undefined>;
  /** The company's wiring, built once per company (a build that fails is tried again on the next request, as the runtime is). */
  wiring(runtime: CoreRuntime): CoreDevWiring | Promise<CoreDevWiring>;
  log?: (entry: Record<string, unknown>) => void;
  /** S1: the chat the registry's presses come from (the chat seam, the install's proof key, the company's approval gate). Absent: the registry takes no chat press. */
  chat?: TaskActionChat | undefined;
}

/**
 * Lead 4 J2: what the Slack door asks of the core, in process. Everything here was verified by the caller (the Slack workspace's company, the company-linked person, the project the thread's channel is bound to,
 * the thread's own id): the body of a Slack message names none of them.
 */
export interface SlackThreadAnswerInput {
  companyId: string;
  personId: string;
  project: string;
  /** The verified Slack thread (`slackAnswerThreadId`). */
  threadId: string;
  requestId: string;
  question: string;
}
export interface SlackThreadAnswer {
  answer: AnswerResponse;
  /** The answer as untrusted data for the task a person starts from it; present only when the answer carries its one button and the asker may still attach it. */
  attach?: string | undefined;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const ORG_ID = /^org_[0-9a-z]{20}$/u;
/** A token id from the path; a malformed escape is a token that does not exist. */
function tokenIdOf(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw agentXError("NOT_FOUND", "route not found"); }
}

/** Only the methods the core's handlers serve: anything else under these paths stays the old broker's (a playbook PUT is its editor's). */
function owns(path: string, method: string, query: string): boolean {
  // The ordinary list (`GET /v1/dev/tasks`) is the old broker's; only `?involved=1` (exactly) is the core's: the tasks the caller was added to.
  if (path === TASK_START) return method === "POST" || (method === "GET" && wantsInvolved(new URLSearchParams(query)));
  if (START_ESTIMATES.test(path)) return method === "POST";
  if (TASK_ANSWERS.test(path)) return method === "POST";
  if (TASK_READ.test(path) || TASK_EVIDENCE.test(path) || PLAYBOOK.test(path) || TEST_ENVIRONMENT.test(path) || SAVED_ENV_IMAGE.test(path)) return method === "GET";
  if (TEST_ENVIRONMENT_APPROVE.test(path)) return method === "POST";
  if (TASK_ACTION.test(path) || TASK_CANCEL.test(path) || TASK_PAGE_FINDINGS.test(path)) return method === "POST";
  if (isHostedMergePath(path, method)) return true;
  if (coreTaskRuleOf(path, method) !== undefined) return true;
  if (INBOX_PATH.test(path)) return inboxOwns(path, method);
  if (path === AGENT_MODELS_PATH) return method === "GET" || method === "POST";
  if (isSetupRunPath(path, method) || isSetupCheckPath(path, method) || isWikiMapPath(path, method) || isReportPath(path, method)) return true;
  if (isKnownFailingPath(path, method) || isWikiPath(path, method) || isWikiCorrectionPath(path, method) || isWikiBuildPath(path, method) || isAnswersPath(path, method) || isStartSuggestPath(path, method) || isUpkeepPath(path, method) || isEvalCheckPath(path, method) || isBrowserTestingPath(path, method) || isAgentDirectoryPath(path, method) || isSystemRunsPath(path, method) || isPackageRegistriesPath(path, method) || isTicketUpdatesPath(path, method) || isIntakePath(path, method)) return true;
  return SESSIONS.test(path) || DECISIONS.test(path) || SCRIPT_TOKENS.test(path) || parityTaskRoute(path, method) !== undefined || isPrFeedbackPath(path, method) || taskScreenRoute(path, method) !== undefined;
}
/** Neither decisions surface relies on sign-in time or methods (DEC 254zzz73). */
function decisionCallerOf(caller: DeployedCaller, companyId: string): DeployedDecisionCaller {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop legacy sign-in claims
  const { authTime: _ignored, methods: _alsoIgnored, ...principal } = caller.principal;
  return { orgId: companyId, developerId: developerIdOf(caller.principal), principal, ...(caller.webApp === true ? { webApp: true } : {}) };
}

const unauthenticated = (): BrokerResponse => json(401, { error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });

/** A request body as JSON, whatever its shape (the caller's schema judges it); text that is not JSON is a fixed refusal. */
function jsonBodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** A request body as one JSON object; anything else is a fixed refusal (no echo of what was sent). */
function bodyOf(request: BrokerRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === "") return {};
  let value: unknown;
  try { value = JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw agentXError("CONFIG_INVALID", "the request body must be an object");
  return value as Record<string, unknown>;
}

/** Dispatch a mounted session request after checking hosted close readiness. */
async function sessionAnswer(target: Mounted, request: BrokerRequest, caller: TaskCaller, path: string): Promise<BrokerResponse> {
  if (target.sessions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
  // Readiness follows the production retention provider, never an install switch.
  if (request.method === "POST" && path.endsWith("/close") && target.runtime.flow.deps.closeInspection === undefined) {
    const body = bodyOf(request);
    if (["expectedPreviewDigest", "discard_unpublished", "discardUnpublished"].some((field) => Object.hasOwn(body, field))) throw agentXError("RUNTIME_UNAVAILABLE", "Guarded close and discarding unpublished work are not available yet.");
  }
  return (await target.sessions(request, caller)) ?? errorAnswer(agentXError("NOT_FOUND", "route not found"));
}


/**
 * What the answers read may know of a task, for this asker: the task the one read rule shows them, and (option B, pending the owner's Q1) none of its plan, design or requirements text when the person was only shared the
 * task's summary. The set lives for one request.
 */
function answerTasks(target: Mounted, caller: DeployedCaller, role: OrgRole): NonNullable<Parameters<typeof routeHostedAnswers>[0]["tasks"]> {
  const withheld = new Set<string>();
  return {
    artifacts: target.runtime.flow.deps.artifacts,
    read: async (_personId, taskId) => {
      const decision = await decideRead(target, caller, role, { read: "answers", taskId });
      if (decision.sharedRole !== undefined) withheld.add(decision.task.taskId);
      return decision.task;
    },
    documentsWithheld: (taskId) => withheld.has(taskId),
  };
}

/**
 * The person's live standing, one implementation each: the task's OWN person holds their task by the hotfix's test (the grant, or the access that let them start it, `holdsOwnTask`), read where the task's rules
 * are wired; everyone else by the project grant in the task's company (a People entry, a reader). A way that is not wired answers "no".
 */
export function liveGrantSeamOf(input: { companyId: OrgId; holdsOwnTask?: ((input: { person: { developerId: string; name: string }; companyId: OrgId; task: Record<string, unknown> }) => Promise<boolean>) | undefined; grant?: ((personId: string, project: string, companyId?: string) => Promise<boolean>) | undefined }): TaskReadSeams["liveGrant"] | undefined {
  const { holdsOwnTask, grant, companyId } = input;
  if (holdsOwnTask === undefined && grant === undefined) return undefined;
  return async (person, task) => {
    if (task.developerId === person.personId && holdsOwnTask !== undefined) return holdsOwnTask({ person: { developerId: person.personId, name: "" }, companyId, task });
    return grant === undefined ? false : grant(person.personId, task.project, companyId);
  };
}

function liveGrantOf(target: Mounted): TaskReadSeams["liveGrant"] | undefined {
  const rules = target.wiring.taskRules;
  return liveGrantSeamOf({ companyId: target.runtime.companyId, holdsOwnTask: rules?.holdsOwnTask === undefined ? undefined : (input) => rules.holdsOwnTask!(input), grant: target.wiring.canReadProject });
}

const liveGrantSeam = (target: Mounted): Pick<TaskReadSeams, "liveGrant"> => { const liveGrant = liveGrantOf(target); return liveGrant === undefined ? {} : { liveGrant }; };

/**
 * The one read rule (core/task-flow/read-rule.ts) for one request: the company's flow, this caller and the caller's live company role, with the stored share bound as its seam (DEC 254zzz44 (a): only where the deployment wires the
 * old rules, and only for a task of the caller's own company: the rule checks the company first). Nothing else in this host decides who may read a task.
 */
function decideRead(target: Mounted, caller: DeployedCaller, role: OrgRole | undefined, input: { read: TaskRead; seams?: TaskReadSeams } & ({ taskId: string } | { task: TaskRecord })): Promise<TaskReadDecision> {
  const rules = target.wiring.taskRules;
  const seams: TaskReadSeams = {
    ...(rules === undefined ? {} : { sharedReader: (person, task) => rules.sharedReader({ person, companyId: target.runtime.companyId, task }) }),
    // The person's current project grant IN THE TASK'S COMPANY (the company the mount checked their live membership of), re-read for every way in: a person moved to another company between two reads never has that
    // company's same-named grant counted.
    ...liveGrantSeam(target),
    ...input.seams,
  };
  return decideTaskRead(target.runtime.flow.deps, { ...input, caller: taskCallerOf(caller), role, scriptToken: caller.scriptToken !== undefined, seams });
}

const nowOf = (target: Mounted): number => (target.runtime.flow.deps.now?.() ?? new Date()).getTime();

/** Whether the project has a catalog row in THIS company (the company is the membership's, never the request's). A read that fails is "no". */
async function projectExistsIn(target: Mounted, companyId: string, project: string): Promise<boolean> {
  try {
    return (await target.runtime.flow.deps.store.get(orgProjectCatalogKey(companyId, project)))?.["entityType"] === "PROJECT_CATALOG";
  } catch {
    return false;
  }
}

/**
 * Whether the caller may READ a project's how-we-work or test environment state: a live company owner or admin (the role is the membership's, read for this request) of a project that exists in THEIR company, or
 * a person the company lets read that project (the grant). A grant read that fails is "no". Reads only: nothing that writes, decides or makes a credential uses this.
 */
async function mayReadProject(target: Mounted, caller: DeployedCaller, membership: CompanyMembership, project: string): Promise<boolean> {
  if ((membership.role === "owner" || membership.role === "admin") && await projectExistsIn(target, membership.companyId, project)) return true;
  try {
    return await target.wiring.canReadProject!(caller.principal.personId, project);
  } catch {
    return false;
  }
}

/**
 * The state answer of a project's test environment on the deployed API: the laptop's view (the same core reader, over the company's own records: every row is under the company's project key) plus the catalog
 * the install would pin from, while test services are switched on. The company is the membership's (the runtime's), never the request's.
 */
async function testEnvironmentAnswer(target: Mounted, wired: NonNullable<CoreDevWiring["testEnvironment"]>, project: string): Promise<Record<string, unknown>> {
  const deps: TestEnvDeps = {
    store: target.runtime.flow.deps.store, now: () => nowOf(target), env: wired.env, audit: target.runtime.flow.deps.audit,
    ...(wired.serviceCatalog === undefined ? {} : { serviceCatalog: wired.serviceCatalog }),
  };
  const read = await testEnvironmentView(deps, target.runtime.companyId, project);
  // Cloud #187/#188 item 4: the proposal that waits carries its whole proposed body (`environment`), read again by the digest the view names and checked against it, so the web app can show what approving
  // makes and forward Approve with the digest and revision the person saw. A body that cannot be read back for exactly that digest leaves the proposal as the view has it (no body), never another body.
  const body = read.proposal === undefined ? undefined : await readProposal(deps, target.runtime.companyId, project, read.proposal.digest).catch(() => undefined);
  // (`readProposal` refuses a stored body whose digest is not the one asked for, another company's or project's row, and an expired one.)
  const view = read.proposal === undefined || body === undefined ? read : { ...read, proposal: { ...read.proposal, environment: body } };
  if (!testServicesSwitchedOn(wired.env)) return { ...view };
  const catalog = await wired.serviceCatalog?.().catch(() => undefined);
  return { ...view, serviceCatalog: catalog === undefined ? { name: wired.catalogName, entries: [] } : { name: wired.catalogName, entries: catalog.entries.map((entry) => ({ id: entry.id, family: entry.family, version: entry.version })) } };
}

interface Mounted {
  runtime: CoreRuntime;
  blobs: ObjectStorage;
  wiring: CoreDevWiring;
  sessions?: ReturnType<typeof createSessionRoutes>; inbox?: ReturnType<typeof createInboxRoutes>;
  playbook?: ReturnType<typeof createLocalPlaybook>;
  actions?: TaskActions;
  /** F2-B: where a task stands for this person (`taskStandingFor`), for a deployment that serves the owner's moves; `undefined` where it does not or the person has no standing. */
  standing?: (membership: CompanyMembership, caller: DeployedCaller, task: TaskRecord) => Promise<TaskStanding | undefined>;
}

/** The audit sink of one request: the deployment's own (it names the caller), else the runtime's. */
function auditOf(target: Mounted, caller: DeployedCaller): AuditSink {
  return target.wiring.auditFor === undefined ? target.runtime.flow.deps.audit : target.wiring.auditFor(caller, target.runtime.flow.deps.audit);
}

/** Figures belong to the stored task owner or a live company admin. A co-owner's
 * right to act does not disclose another person's money (a live co-owner of THIS task reads that task's own `money` alone: `isLiveCoOwner`, `taskViewFor`; ruling (a) of 2026-11-23, DEC 254zzz398). Scope budgets stay private. */
function maySeeTaskMoney(target: Mounted, task: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): boolean {
  return roleMaySeeTaskMoney({ companyId: target.runtime.companyId, membershipCompanyId: membership.companyId, principal: caller.principal, scriptToken: caller.scriptToken !== undefined, role: membership.role, task });
}
/** The company's live owner rule for THIS task and this person (the owner moves' own rule: the person it runs for, or a People co-owner read now): their own owner key, or none. A throw (People unreadable) is none. */
async function liveOwnerKey(target: Mounted, task: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<string | undefined> {
  const access = target.runtime.flow.deps.access;
  if (access.ownerActing === undefined || caller.scriptToken !== undefined || caller.principal.companyId !== target.runtime.companyId || membership.companyId !== target.runtime.companyId || task.companyId !== target.runtime.companyId) return undefined;
  try {
    return (await access.ownerActing(caller.principal, { taskId: task.taskId, developerId: task.developerId, project: task.project, ownerKey: task.workflow?.ownerId ?? task.ownerKey }))?.actorId;
  } catch {
    return undefined;
  }
}
async function isLiveCoOwner(target: Mounted, task: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<boolean> {
  return await liveOwnerKey(target, task, caller, membership) !== undefined;
}
/** DEC 254zzz398 (b): each served feedback decision says whether THE READER made it (`decidedByYou`), computed here as the decision's actor === the reader's own owner key; the key is never added to a view. A reader with no owner key (a script token, no live owner rule) did not decide. */
async function withDecidedByYou(view: Record<string, unknown>, target: Mounted, task: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<Record<string, unknown>> {
  const workflow = view["workflow"] as { feedbackDecisions?: Array<Record<string, unknown>> } | undefined;
  if (workflow?.feedbackDecisions === undefined || workflow.feedbackDecisions.length === 0) return view;
  const mine = await liveOwnerKey(target, task, caller, membership);
  return { ...view, workflow: { ...workflow, feedbackDecisions: workflow.feedbackDecisions.map(decision => ({ ...decision, decidedByYou: mine !== undefined && decision["actorId"] === mine })) } };
}
/** Who reads this task's spend, limit and payer (`TaskMoneyV1`): whoever sees the task's money, or a live co-owner of THIS task. Nobody else, and never another task's or the company's. */
async function maySeeTaskSpend(target: Mounted, task: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<boolean> {
  return maySeeTaskMoney(target, task, caller, membership) || await isLiveCoOwner(target, task, caller, membership);
}
async function moneyOf(target: Mounted, task: TaskRecord, knownCap?: { limitUsd: number }): Promise<TaskMoneyV1> {
  const cap = knownCap ?? await target.wiring.taskActions?.roundCap?.(task).catch(() => undefined);
  const maximum = cap === undefined ? undefined : Math.round(cap.limitUsd * 1_000_000);
  return readTaskMoney({ store: target.runtime.flow.deps.store, companyId: target.runtime.companyId, task, hosted: true, revealPayer: true, ...(maximum === undefined ? {} : { taskMaximumMicros: maximum }) });
}
/** The developer task view with the caller's share of its figures: the owner's (money, run estimate, design review money), a live co-owner's (the task's `money` alone) or none. */
async function taskViewFor(target: Mounted, record: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<Record<string, unknown>> {
  const view = await taskViewOf(target.runtime.flow.deps, record);
  const shown = maySeeTaskMoney(target, record, caller, membership)
    ? await withDecidedByYou(await developerTaskView(record, view, target.blobs, undefined, await moneyOf(target, record), true), target, record, caller, membership)
    : await (async () => {
      const base = await developerTaskView(record, view, target.blobs, undefined, undefined, false);
      return withDecidedByYou(await isLiveCoOwner(target, record, caller, membership) ? { ...base, money: await moneyOf(target, record) } : base, target, record, caller, membership);
    })();
  return { ...shown, ...await standingMembers(target, record, caller, membership) };
}

/**
 * F2-B: the task's standing for THIS reader and the person-free status line, from the ONE rule (`taskStandingFor`), added to every task answer (the read and each press's answer: a page redraws from the answer it gets). Both are additive
 * members older readers drop (`standing`) or already know (`statusView`, the strict status of the stored summary, now filled). Not served where the deployment does not serve the owner's moves or the reader has no standing; a standing that
 * cannot be read leaves the answer as it was (the page says the status is unavailable), it never fails the read.
 */
async function standingMembers(target: Mounted, record: TaskRecord, caller: DeployedCaller, membership: CompanyMembership): Promise<Record<string, unknown>> {
  try {
    const served = await target.standing?.(membership, caller, record);
    return served === undefined ? {} : { statusView: served.statusView, standing: served.standing };
  } catch {
    return {};
  }
}

export interface CoreDevRoutes {
  route(request: BrokerRequest, caller: DeployedCaller): Promise<BrokerResponse | undefined>;
  /**
   * Lead 4 J2: the smart Just answer for a Slack thread, in process (the thread is one every participant reads, so its memory is shared; the HTTP route never says so). `undefined`: the core does not serve
   * answers for this company (no answers wiring). Throws the answer service's own refusals (`NOT_FOUND` for no role or no project, `TOO_MANY_REQUESTS`, `RUNTIME_UNAVAILABLE`).
   */
  answerForSlackThread(input: SlackThreadAnswerInput): Promise<SlackThreadAnswer | undefined>;
  /**
   * Core task web routes (Cloud #188 item 5): what one of the caller's own core tasks has cost and the limit it is held to, for the task list's detail (`GET /v1/dev/tasks?detail=1`), in process. The company is the caller's
   * live membership's, the task must be one this caller may act on (the owner moves' rule), and the money is the owner round's own read (`taskActions.roundCap`). `undefined` for anything else (no member
   * company, another company's task, not theirs, no money wiring, a read that fails): the row then carries no money, never a guess.
   */
  taskMoney(caller: DeployedCaller, taskId: string): Promise<{ costUsd?: number; runLimitUsd: number; money?: TaskMoneyV1 } | undefined>;
  /**
   * Understand's round on the task list (`GET /v1/dev/tasks?detail=1`, `round`), in process: whether the core's own task read (`GET /v1/dev/tasks/{id}`: the owner, a co-owner, or a reader of its People list) would show this
   * caller the task. The company is the caller's live membership's; the task must be one of that company's. `false` for anything else (no member company, another company's task, a script token, a malformed or
   * missing id, a read that fails): the row then carries no round. Nothing is returned from the task here, so the list builds the round from the task record it already read.
   */
  taskReadable(caller: DeployedCaller, taskId: string): Promise<boolean>;
  /** S1: what one task offers this person now (the task action registry), in process; `undefined` where the deployment does not serve the owner's moves for the person's company. */
  taskActions: ReturnType<typeof createTaskActionRoutes>["taskActions"];
  /** F2-B: where one task stands for this person now, from the one rule (pill, step, the person-free status line, the offers), in process, for the surfaces that are not the web read (Slack's cards, notices). `undefined` as `taskActions`. */
  taskStanding: ReturnType<typeof createTaskActionRoutes>["taskStanding"];
  /** S1: a chat press of a task action, or the describe of one, judged again by the registry as the person the chat account is linked to. */
  taskAction: ReturnType<typeof createTaskActionRoutes>["taskAction"];
}

function taskCallerOf(caller: DeployedCaller): TaskCaller {
  return { principal: caller.principal, ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }), ...(caller.client === undefined ? {} : { client: caller.client }) };
}

function publicationAnswer(operation: OperationRecord | undefined) {
  if (operation === undefined) return {};
  const result = operation.result as { outcome?: { result?: unknown } } | undefined;
  const published = PullRequestResultSchema.safeParse(result?.outcome?.result ?? operation.result);
  return { operationId: operation.id, operationStatus: operation.status, ...(operation.status === "SUCCEEDED" && published.success ? { pullRequest: { repository: published.data.repository, number: published.data.number, url: published.data.url, state: "open" } } : {}) };
}

async function performTaskAction(target: Mounted, caller: TaskCaller, taskId: string, action: string, body: unknown) {
  if (action === "pull-requests") return startManualPublication(target.runtime.flow.deps, caller, taskId, body);
  if (action === "share") { await shareTask(target.runtime.flow.deps, caller, taskId, body); return undefined; }
  const handlers = { "workflow/send-back": target.actions!.sendBack, "workflow/review-findings": (who: TaskCaller, id: string, value: unknown) => target.actions!.resolveFindings(who, id, value, "api-token"), "workflow/review": target.actions!.review, continue: target.actions!.continue };
  await handlers[action as keyof typeof handlers](caller, taskId, body);
  return undefined;
}

function feedbackOrParity(path: string, method: string): boolean {
  return isPrFeedbackPath(path, method) || parityTaskRoute(path, method) !== undefined;
}
function mutationView(target: Mounted, caller: DeployedCaller, membership: CompanyMembership) {
  return async (record: TaskRecord) => taskViewFor(target, record, caller, membership);
}
async function feedbackAnswer(target: Mounted, request: BrokerRequest, taskCaller: TaskCaller, caller: DeployedCaller, membership: CompanyMembership) {
  if (target.wiring.prFeedback === undefined) return undefined;
  if (request.method === "POST") await feedbackOwner(target.runtime.flow.deps, taskCaller, request.path.split("/")[4]!);
  // A decision, Keep or retry made with a tool's token (the CLI or an AI tool: any client that is not the Rovara web app) is audited "made via tool" (DEC 254zzz334, 375), as a plan approval from a tool is.
  return await target.wiring.prFeedback(request, taskCaller, async (_who, taskId) => {
    const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
    return mutationView(target, caller, membership)(record);
  }, caller.webApp === true ? undefined : "tool");
}

function taskSurfaceAnswer(target: Mounted, request: BrokerRequest, taskCaller: TaskCaller, caller: DeployedCaller, membership: CompanyMembership): Promise<BrokerResponse | undefined> | undefined {
  const path = request.path.split("?")[0]!;
  if (isPrFeedbackPath(path, request.method)) return feedbackAnswer(target, request, taskCaller, caller, membership);
  // RD-2.0: the task page's new reads (spec, checks, changes, timeline), one mount; each answers ROUTE_NOT_SERVED until its lane fills its handler (task-screen-routes.ts).
  const screen = taskScreenRoute(path, request.method);
  if (screen !== undefined) return routeTaskScreen({ flow: target.runtime.flow, blobs: target.blobs, caller: taskCaller, request, ...(target.wiring.taskRules === undefined ? {} : { taskRules: target.wiring.taskRules }), authorize: (read, task, seams) => decideRead(target, caller, membership.role, { read, task, ...(seams === undefined ? {} : { seams }) }), decide: (read) => decideRead(target, caller, membership.role, { read, taskId: screen.taskId }) }, screen);
  const parity = parityTaskRoute(path, request.method);
  if (parity === undefined) return undefined;
  return routeParityTask({
    flow: target.runtime.flow, blobs: target.blobs, wiring: target.wiring, caller: taskCaller,
    decisionCaller: decisionCallerOf(caller, membership.companyId),
    view: mutationView(target, caller, membership),
    decide: (read) => decideRead(target, caller, membership.role, { read, taskId: parity.taskId }),
  }, parity, request);
}

export function createCoreDevRoutes(options: CoreDevRoutesOptions): CoreDevRoutes {
  const mounted = new Map<string, Promise<Mounted>>();
  const mount = (companyId: string): Promise<Mounted> => {
    let found = mounted.get(companyId);
    if (found === undefined) {
      found = options.app.runtimeFor(companyId).then(async (runtime) => {
        const wiring = await options.wiring(runtime);
        const blobs = (await options.app.registry()).require("object-storage");
        return {
          runtime, wiring, blobs,
          ...(wiring.members === undefined ? {} : { sessions: createSessionRoutes({ flow: runtime.flow, blobs, companyId: runtime.companyId, origin: wiring.origin, members: wiring.members }), inbox: createInboxRoutes({ store: runtime.flow.deps.store, companyId: runtime.companyId, origin: wiring.origin, members: wiring.members, ...(wiring.unsubscribeKey === undefined ? {} : { unsubscribeKey: wiring.unsubscribeKey }), projectNotices: wiring.projectNotices }) }),
          ...(wiring.playbook === undefined ? {} : { playbook: createLocalPlaybook({ playbook: wiring.playbook, store: runtime.flow.deps.store, companyId: runtime.companyId }) }),
          // The owner's moves need both the money cap and the company's owner rule; with either missing they are not served (never Code's laptop owner rule on a hosted company).
          ...(wiring.taskActions === undefined || runtime.flow.deps.access.ownerActing === undefined ? {} : { actions: createTaskActions(runtime.flow.deps, { roundCap: wiring.taskActions.roundCap }) }),
          standing: (membership, deployed, task) => taskActionRoutes.standingFor({ runtime, wiring }, membership, deployed, task),
        };
      });
      found.catch(() => mounted.delete(companyId));
      mounted.set(companyId, found);
    }
    return found;
  };

  const taskActionRoutes = createTaskActionRoutes({
    companyOf: (caller) => options.companyOf(caller), chat: options.chat, now: () => Date.now(), ...(options.log === undefined ? {} : { log: options.log }),
    mount: async (companyId) => { const target = await mount(companyId); return { runtime: target.runtime, wiring: target.wiring }; },
  });
  return {
    taskActions: (caller, taskId) => taskActionRoutes.taskActions(caller, taskId),
    taskAction: (caller, input) => taskActionRoutes.taskAction(caller, input),
    taskStanding: (caller, taskId) => taskActionRoutes.taskStanding(caller, taskId),
    async answerForSlackThread(input) {
      if (!ORG_ID.test(input.companyId)) return undefined;
      const target = await mount(input.companyId);
      // Mounted by the company asked for; a runtime of another company would never be asked.
      if (target.runtime.companyId !== input.companyId || target.wiring.answers === undefined) return undefined;
      const service = hostedAnswerService({ companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.answers, now: () => nowOf(target), log: options.log });
      const answer = await service.ask({
        personId: input.personId, project: input.project, sharedThread: true,
        body: { requestId: input.requestId, question: input.question, threadId: input.threadId, channel: "slack" },
      });
      if (answer.answerId === undefined || answer.action === undefined) return { answer };
      // Attached only for the person who asked, with a role on the project now (the answer service checks both); anything else leaves the answer without its button.
      const context = await service.taskContext({ personId: input.personId, project: input.project, answerId: answer.answerId }).catch(() => undefined);
      return { answer, ...(context === undefined ? {} : { attach: context.text }) };
    },
    async taskMoney(caller, taskId) {
      if (!TASK_ID.test(taskId)) return undefined;
      try {
        const membership = await options.companyOf(caller);
        if (membership === undefined || membership === null || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || caller.scriptToken !== undefined) return undefined;
        // The company's own runtime (membership's); the owned read below checks the principal's company and the task's against it.
        const target = await mount(membership.companyId);
        const roundCap = target.wiring.taskActions?.roundCap;
        if (roundCap === undefined) return undefined;
        const taskCaller = taskCallerOf(caller);
        const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
        if (!await maySeeTaskSpend(target, record, caller, membership)) return undefined;
        const cap = await roundCap(record);
        if (cap === undefined || typeof cap.limitUsd !== "number" || !Number.isFinite(cap.limitUsd) || cap.limitUsd < 0) return undefined;
        const spent = cap.spentUsd;
        const money = await moneyOf(target, record, cap);
        return { money, runLimitUsd: cap.limitUsd, ...(typeof spent === "number" && Number.isFinite(spent) && spent >= 0 ? { costUsd: spent } : {}) };
      } catch {
        return undefined;
      }
    },
    async taskReadable(caller, taskId) {
      if (!TASK_ID.test(taskId)) return false;
      try {
        const membership = await options.companyOf(caller);
        if (membership === undefined || membership === null || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || caller.scriptToken !== undefined) return false;
        const target = await mount(membership.companyId);
        // The one read rule's "readable" read (the company, then the company's read access): the same refusal as a missing task for anyone it does not show the task to.
        await decideRead(target, caller, membership.role, { read: "readable", taskId });
        return true;
      } catch {
        return false;
      }
    },
    async route(request, caller) {
      const path = request.path.split("?")[0] ?? request.path;
      if (!owns(path, request.method, request.path.split("?")[1] ?? "")) return undefined;
      const starting = path === TASK_START && request.method === "POST";
      let membership: CompanyMembership | undefined;
      let unreadable = false;
      try {
        membership = await options.companyOf(caller);
      } catch {
        membership = undefined;
        unreadable = true;
      }
      // A start by a person with no member company is no core company's: the old broker starts it, as before. (Every other route refuses below.)
      if (starting && !unreadable && (membership === undefined || membership === null)) return undefined;
      // The involved list says "nothing" only when it is sure: a membership that could not be read is a fixed outage answer, never an empty list.
      if (unreadable && path === TASK_START && request.method === "GET") return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", INVOLVED_UNAVAILABLE));
      // Fail closed: no member company, a malformed one or an unknown role is a sign-in refusal, never the install's company.
      if (membership === undefined || membership === null || typeof membership !== "object" || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || !OrgRoleSchema.safeParse(membership.role).success) return unauthenticated();
      const companyId = membership.companyId;
      // The principal the identity point vouched for must be of the member company (checked before anything is built for it); the task flow checks it again on every task read.
      if (caller.principal.companyId !== companyId) return unauthenticated();
      // A start goes to the core where the setting sends this company's NEW tasks there (every member company since #1275).
      if (starting && options.app.engineForNewTask(companyId) !== "core") return undefined;
      // Answering the agent is never a script token's either, and reads like a missing task for the same reason.
      if (caller.scriptToken !== undefined && TASK_ANSWERS.test(path)) return errorAnswer(agentXError("NOT_FOUND", "route not found"));
      // A script token reaches task reads or the two scoped wiki reads; never sessions, decisions, playbooks or token management.
      // An owner's move on a task is never a script token's, and its answer must not tell a token which task ids exist: it reads like a missing task (the boundary's own answer).
      if (caller.scriptToken !== undefined && (feedbackOrParity(path, request.method) || TASK_ACTION.test(path) || TASK_CANCEL.test(path) || TASK_PAGE_FINDINGS.test(path) || isHostedMergePath(path, request.method) || coreTaskRuleOf(path, request.method) !== undefined)) return errorAnswer(agentXError("NOT_FOUND", "route not found"));
      // A task's proof index is refused to a script token too, but only AFTER the task is looked up (below): refusing it here, by path alone, told another company's token that the id is a real task (403) where an
      // id with no task reads as a missing task (404). Every other path left here names no task id.
      if (caller.scriptToken !== undefined && !TASK_READ.test(path) && !TASK_EVIDENCE.test(path) && scriptTokenRoute(request.method, path)?.permission !== "wiki") return errorAnswer(agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS));
      const target: Mounted = await mount(companyId);
      const taskCaller = taskCallerOf(caller);
      try {
        if (INBOX_PATH.test(path)) return await inboxAnswer(target.inbox, request, taskCaller);
        if (SESSIONS.test(path)) return await sessionAnswer(target, request, taskCaller, path);
        if (path === TASK_START && request.method === "GET") {
          // The involved list: the caller's own rows in this company, each re-checked against the live task access (the core's task read rule). Another company's task is never listed.
          return json(200, await listInvolvedTasks(target.runtime.flow.deps, taskCaller, involvedListOptions(new URLSearchParams(request.path.split("?")[1] ?? ""))));
        }
        if (starting) {
          // The core's own start (it parses the request, checks the person may start on the project, holds the admission and writes the engine stamp in one transaction). A retry with the
          // same request id answers the first task. The answer is the developer task view, as the old start's.
          const started = await target.runtime.flow.start({ ...taskCaller, origin: caller.client === undefined ? "cli" : "app" }, bodyOf(request));
          const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, started.task.taskId);
          return json(200, { task: await taskViewFor(target, record, caller, membership) });
        }
        const task = TASK_READ.exec(path);
        if (task !== null) {
          if (request.method !== "GET") return undefined;
          // Another company's task, or none, answers the same "not found" (the rule checks the company first). A person's own read also lets the People list's commenters and viewers read it (C6, the same
          // live rule) and someone the owner shared the task with (spec 067); a script token reads exactly as before (its own closed list), never through People.
          const { task: record } = await decideRead(target, caller, membership.role, { read: "task", taskId: task[1]! });
          await observeHostedBlockedTask(target.runtime.flow.deps, record, target.wiring.testEnvironment?.env);
          const testing = await hostedTestingView(target.runtime.flow.deps, target.blobs, record, target.wiring.testEnvironment?.env);
          const view = await taskViewFor(target, record, caller, membership);
          return json(200, { task: { ...view, ...(testing === undefined ? {} : { testing }), ...await applicationReadProjection(target.runtime, record, caller.principal.personId) } });
        }
        const taskSurface = taskSurfaceAnswer(target, request, taskCaller, caller, membership);
        if (taskSurface !== undefined) return await taskSurface;
        const evidence = TASK_EVIDENCE.exec(path);
        if (evidence !== null) {
          // Exactly the task read's rule (the flow's owned read: the company, then the company's access rule; another company's task, or none, answers the same "not found"), then the pack kept for
          // exactly the task's current code, as the proof page reads it. A pack that is missing or cannot be read leaves only what Rovara recorded itself.
          const { task: record } = await decideRead(target, caller, membership.role, { read: "evidence", taskId: evidence[1]! });
          // Only now: someone who may not read the task has been told it is missing; the task's own owner's script token is told what a script token cannot do.
          if (caller.scriptToken !== undefined && scriptTokenRoute(request.method, path)?.permission !== "wiki") throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
          // The pack is read through the company-bound store (the key must name a workspace of this company and its owner), not the shared bucket as it is.
          const pack = await loadEvidencePack(hostedEvidenceBlobs({ blobs: target.blobs, store: target.runtime.flow.deps.store, companyId: target.runtime.companyId }), { ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId: record.taskId }, record.workflow?.candidate?.digest);
          return json(200, proofIndexOf(record.taskId, record.workflow, pack));
        }
        const cancel = TASK_CANCEL.exec(path);
        if (cancel !== null) {
          // Served only with the company's owner rule (never Code's laptop rule on a hosted company); without it the engine boundary says "not on the core yet" to a reader, and a missing task to anyone else.
          if (target.runtime.flow.deps.access.ownerActing === undefined) return undefined;
          // The task's owner, or a live owner or admin of the task's company (the role is membership's, read for this request; the task's company is checked against it). Anyone who may not
          // read the task gets the missing task's answer whatever they sent; a reader who may not stop gets fixed words. One request id is one stop.
          const stopped = await stopTaskOnRequest(target.runtime.flow.deps, { ...taskCaller, companyRole: membership.role }, cancel[1]!, () => jsonBodyOf(request));
          return json(200, { task: await taskViewFor(target, stopped.task, caller, membership) });
        }
        const action = TASK_ACTION.exec(path);
        if (action !== null) {
          // Not wired here: the caller of these routes (the engine boundary) tells a person who may read the task that it is not on the core yet, and anyone else that there is no such task.
          if (target.actions === undefined) return undefined;
          const taskId = action[1]!;
          // The task is read first, so someone who may not see it reads "no such task" whatever they sent (a body the move refuses would otherwise tell them the task exists).
          await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
          // The body as JSON, judged by the move's own schema (its words name the field), as the old workflow routes do.
          const body = jsonBodyOf(request);
          // Each move re-checks who acts (owner or co-owner, else "no such task"), the revision they saw, and the round's money, and writes nothing on a refusal.
          const publication = await performTaskAction(target, taskCaller, taskId, action[2]!, body);
          return await committedResponse(async () => {
            const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
            return json(200, { ...publicationAnswer(publication), task: await taskViewFor(target, record, caller, membership) });
          });
        }
        const rule = coreTaskRuleOf(path, request.method);
        if (rule !== undefined) {
          // Not wired here: the engine boundary tells a person who may read the task that it is not on the core yet, and anyone else that there is no such task.
          if (target.wiring.taskRules === undefined) return undefined;
          // The task, from the caller's OWN company (membership's): another company's task, or none, reads "no such task" before any rule is asked.
          const record = await readTask(target.runtime.flow.deps, rule.taskId);
          if (record === undefined || record.companyId !== companyId) throw agentXError("TASK_NOT_FOUND", `no task ${rule.taskId} of yours`);
          return await target.wiring.taskRules.route({
            request, path, person: { developerId: caller.principal.personId, name: caller.principal.displayName }, companyId: target.runtime.companyId,
            task: record, store: target.runtime.flow.deps.store,
            authorize: (read, seams) => decideRead(target, caller, membership.role, { read, task: record, ...(seams === undefined ? {} : { seams }) }),
          });
        }
        const pageFindings = TASK_PAGE_FINDINGS.exec(path);
        if (pageFindings !== null) {
          // The web page's own act: anyone else (the CLI's token, an AI tool's, another full-access client) is refused before anything is read, whatever they sent.
          if (caller.webApp !== true) throw agentXError("FORBIDDEN", SECURITY_ACCEPT_ON_THE_PAGE);
          // Served only with the owner moves' own wiring (the money cap and the company's owner rule); otherwise fixed words, the same for every task id.
          if (target.actions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const taskId = pageFindings[1]!;
          // The task's owner (or a People co-owner) only: anyone else, another company's task, or none, reads "no such task" whatever they sent.
          await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
          const body = jsonBodyOf(request);
          // The move re-checks the owner, the revision and digest they saw, and the round's money, then the security-accept rule (the web app's client, `via: "page"`); a refusal writes nothing.
          await target.actions.resolveFindings({ ...taskCaller, webApp: true }, taskId, body, "page");
          return await committedResponse(async () => {
            const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, taskId);
            return json(200, { task: await taskViewFor(target, record, caller, membership) });
          });
        }
        if (isHostedMergePath(path, request.method)) {
          // DEC 254zzz94: the Merge button (hosted-merge-routes.ts holds every rule: the website only for a press, who may merge, Rovara's checks and GitHub's mergeable state, one merge at a time, audit).
          const audit = auditOf(target, caller);
          return await routeHostedMerge({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, role: membership.role, flow: target.runtime.flow.deps, wiring: target.wiring.merge, audit,
            now: () => nowOf(target), webApp: caller.webApp === true, ...(options.log === undefined ? {} : { log: options.log }),
          });
        }
        const answers = TASK_ANSWERS.exec(path);
        if (answers !== null) {
          // Served only with the company's owner rule (never Code's laptop rule on a hosted company); without it the engine boundary says "not on the core yet" to a reader, and a missing task to anyone else.
          if (target.runtime.flow.deps.access.ownerActing === undefined) return undefined;
          // Only the task's owner (People owners count; a company admin who is not one does not). Anyone who may not read the task gets the missing task's answer whatever they sent; a
          // reader who is not its owner gets fixed words. One request id is one answer, and the round asked is checked.
          const answered = await answerTaskOnRequest(target.runtime.flow.deps, taskCaller, answers[1]!, () => jsonBodyOf(request));
          return json(200, { task: await taskViewFor(target, answered.task, caller, membership) });
        }
        if (DECISIONS.test(path)) {
          if (target.wiring.decisions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const body = request.method === "GET" ? {} : bodyOf(request);
          const url = new URL(request.path, "http://core");
          const decisionCaller = decisionCallerOf(caller, companyId);
          const reply = await routeDecisionCards(target.wiring.decisions, decisionCaller, { method: request.method, pathname: path, searchParams: url.searchParams, body });
          if (reply === undefined) throw agentXError("NOT_FOUND", "route not found");
          return json(reply.statusCode, reply.body);
        }
        if (path === AGENT_MODELS_PATH) {
          if (target.wiring.modelChoice === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await agentModelRoute({
            method: request.method, body: request.body, principal: caller.principal, role: membership.role, choice: target.wiring.modelChoice,
            audit: target.wiring.auditFor === undefined ? undefined : target.wiring.auditFor(caller, target.runtime.flow.deps.audit),
          });
        }
        if (isSetupRunPath(path, request.method) || isSetupCheckPath(path, request.method)) {
          // Guided onboarding L2-3: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.setupRun === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await (isSetupCheckPath(path, request.method) ? routeHostedSetupCheck : routeHostedSetupRun)({
            request, path, principal: caller.principal, client: caller.client, webApp: caller.webApp === true, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.setupRun,
            audit: auditOf(target, caller),
            startsNewTasks: options.app.engineForNewTask(companyId) === "core", now: () => nowOf(target),
          });
        }
        if (isWikiMapPath(path, request.method)) {
          // Wiki W0: the company's own runtime, the caller's live standing on the project (read inside), the company's code host.
          if (target.wiring.wikiMap === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWikiMap({ request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.wikiMap, now: () => nowOf(target), log: options.log });
        }
        if (isWikiPath(path, request.method)) {
          // Lead 4 W2: the member company's own store; the caller's live standing on the project is read inside (any project role reads).
          if (caller.scriptToken !== undefined) {
            // Re-read scope in the live member company's store: a verified token id alone grants no wiki access.
            const route = scriptTokenRoute(request.method, path);
            const token = await readScriptToken({ store: target.runtime.flow.deps.store }, companyId, caller.scriptToken.tokenId);
            if (target.wiring.scriptTokens === undefined || !(target.wiring.scriptTokens.enabled ?? scriptTokensEnabled)()
              || route?.permission !== "wiki" || route.project !== "path"
              || token === undefined || scriptTokenStatus(token, nowOf(target)) !== "active"
              || (token.personId !== undefined && token.personId !== caller.principal.personId) || token.developerId !== developerIdOf(caller.principal)
              || token.createdRole !== membership.role || !token.permissions.includes("wiki") || !token.projects.includes(route.name)) {
              throw agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS);
            }
          }
          if (target.wiring.wiki === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWiki({ request, path, personId: caller.principal.personId, companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.wiki, now: () => nowOf(target), webApp: caller.webApp === true });
        }
        if (isWikiCorrectionPath(path, request.method)) {
          // Lead 4 C1: the same member company's own store; the caller's role on the project is read live inside (never from the request).
          if (target.wiring.wikiCorrections === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWikiCorrections({ request, path, personId: caller.principal.personId, companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.wikiCorrections, now: () => nowOf(target) });
        }
        if (isReportPath(path, request.method)) {
          // Lead 4 A1/A2: the company's own runtime, the caller's live role from membership, the request's audit sink naming the caller.
          if (target.wiring.report === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedReport({
            request, path, principal: caller.principal, role: membership.role, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.report,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isUpkeepPath(path, request.method)) {
          // Lead 4 N1: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.upkeep === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedUpkeep({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.upkeep, webApp: caller.webApp === true,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isEvalCheckPath(path, request.method)) {
          // L4-EVCI2: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.evalCheck === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedEvalCheck({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.evalCheck,
            audit: auditOf(target, caller), now: () => nowOf(target), log: options.log,
          });
        }
        if (isBrowserTestingPath(path, request.method)) {
          // Browser testing: the company's own runtime, the caller's LIVE standing on the project (read inside; only a company owner or admin changes anything), the request's audit sink naming the caller.
          if (target.wiring.browserTesting === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedBrowserTesting({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.browserTesting,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isKnownFailingPath(path, request.method)) return await routeKnownFailing({ flow: target.runtime.flow.deps, principal: caller.principal, companyId: target.runtime.companyId, members: target.wiring.members, webApp: caller.webApp === true, path, request, ...(target.wiring.testEnvironment === undefined ? {} : { env: target.wiring.testEnvironment.env }) });
        if (isIntakePath(path, request.method)) {
          // R1 + L1 6.2b: the company's own runtime, the caller's live standing on the project (read inside); the company's intake is built by the root, so an install without it is "not on the core".
          const intake = target.wiring.intake?.intake();
          if (target.wiring.intake === undefined || intake === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedIntake({ request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.intake, intake });
        }
        if (isTicketUpdatesPath(path, request.method)) {
          // Audit gap 11b: the company's own runtime and store, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.ticketUpdates === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedTicketUpdates({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.ticketUpdates,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isPackageRegistriesPath(path, request.method)) {
          // PRIVATE-PACKAGES P1b: the company's own runtime and store; the role is membership's, read for this request; the request's audit sink names the caller. No route answers a stored token.
          if (target.wiring.packageRegistries === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedPackageRegistries({
            request, path, principal: caller.principal, role: membership.role, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.packageRegistries,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isSystemRunsPath(path, request.method)) {
          // L4-P3: the company's one control over Rovara's automatic runs. The role is membership's, read for this request; the ceiling is the upkeep wiring's.
          if (target.wiring.upkeep === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedSystemRuns({
            request, path, principal: caller.principal, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, role: membership.role, available: target.wiring.upkeep.available, webApp: caller.webApp === true,
            audit: auditOf(target, caller), now: () => nowOf(target),
          });
        }
        if (isWikiBuildPath(path, request.method)) {
          // Lead 4 W4: the company's own runtime, the caller's live standing on the project (read inside), the request's audit sink naming the caller.
          if (target.wiring.wikiBuild === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedWikiBuild({
            request, path, principal: caller.principal, client: caller.client, companyId: target.runtime.companyId, flow: target.runtime.flow.deps, wiring: target.wiring.wikiBuild,
            audit: auditOf(target, caller),
            startsNewTasks: options.app.engineForNewTask(companyId) === "core", now: () => nowOf(target), log: options.log,
          });
        }
        if (isStartSuggestPath(path, request.method)) {
          // Lead 4 J3: the member company's own role read live inside; nothing is started; only the hourly counter row (ids and a count) is stored.
          if (target.wiring.startSuggest === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedStartSuggest({ request, path, personId: caller.principal.personId, companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.startSuggest, now: () => nowOf(target), log: options.log });
        }
        if (isAnswersPath(path, request.method)) {
          // Lead 4 J1: the member company's own store and code; the caller's live standing on the project is read inside (any project role asks).
          if (target.wiring.answers === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return await routeHostedAnswers({ request, path, personId: caller.principal.personId, companyId: target.runtime.companyId, store: target.runtime.flow.deps.store, wiring: target.wiring.answers, now: () => nowOf(target), log: options.log,
            tasks: answerTasks(target, caller, membership.role),
          });
        }
        if (isAgentDirectoryPath(path, request.method)) {
          // Lead 4 L4-MF3: the company-wide agent directory. The live role from membership (read for this request) decides inside: only a company owner or administrator reads it.
          return await routeHostedAgentDirectory({
            request, path, companyId: target.runtime.companyId, role: membership.role, developerId: developerIdOf(caller.principal),
            store: target.runtime.flow.deps.store, audit: target.runtime.flow.deps.audit, now: () => nowOf(target),
          });
        }
        const preview = START_ESTIMATES.exec(path);
        if (preview !== null) {
          if (target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const project = preview[1]!;
          if (!(await mayReadProject(target, caller, membership, project))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          const parsed = parsePreviewRequestV2(jsonBodyOf(request));
          if (parsed === undefined) throw agentXError("CONFIG_INVALID", "invalid start estimate request");
          const context = await target.wiring.startEstimates?.(project) ?? { policyRevision: "unavailable", stages: {}, limits: [] };
          const quote = await startEstimates({ store: target.runtime.flow.deps.store }, { orgId: companyId, project, request: parsed, asOf: new Date(nowOf(target)).toISOString(), context });
          return json(200, membership.role === "owner" || membership.role === "admin" ? quote : restrictPreviewV2(quote));
        }
        const playbook = PLAYBOOK.exec(path);
        if (playbook !== null) {
          if (target.playbook === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          // A project the person may not read, and one that does not exist, answer the same words. A live company owner or admin needs no grant on a project of THEIR company (GET only: a write is the old broker's).
          if (!(await mayReadProject(target, caller, membership, playbook[1]!))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          const answer = (await target.playbook.routes(request)) ?? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND));
          return answer.statusCode === 404 ? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND)) : answer;
        }
        const approveEnvironment = TEST_ENVIRONMENT_APPROVE.exec(path);
        if (approveEnvironment !== null) {
          const approval = target.wiring.testEnvironmentApproval;
          if (approval === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const project = approveEnvironment[1]!;
          // A live company owner or admin (the risk rule's top approvers, who need no grant on the project), or a person the company lets read the project; anyone else gets the words of a missing project
          // and nothing is decided for them. A project that does not exist is the decision's own "not found" for an owner or admin.
          if (membership.role !== "owner" && membership.role !== "admin" && !(await target.wiring.canReadProject(caller.principal.personId, project).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          const parsedBody = ApproveTestEnvironmentBodySchema.safeParse(jsonBodyOf(request));
          if (!parsedBody.success) throw agentXError("CONFIG_INVALID", `${parsedBody.error.issues[0]?.path.join(".") || "body"}: invalid`);
          const result = await approval.approve({ personId: caller.principal.personId, project, approval: parsedBody.data });
          if (result.ok) return json(200, { project, message: result.message });
          // The decision's own words (fixed, never an echo); the status by reason.
          throw agentXError(result.reason === "off" ? "NOT_AVAILABLE_HERE" : result.reason === "stale" ? "CHANGE_STALE" : result.reason === "not_found" || result.reason === "not_wired" ? "NOT_FOUND" : "FORBIDDEN", result.message);
        }
        const testEnvironment = TEST_ENVIRONMENT.exec(path);
        if (testEnvironment !== null) {
          const wired = target.wiring.testEnvironment;
          if (wired === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const project = testEnvironment[1]!;
          // A project the person may not read, and one that does not exist, answer the same words; nothing is read for it. A live company owner or admin (the role is membership's, read for this request)
          // needs no grant on a project of THEIR company (the same reach as approving; the project must exist in that company); anyone else needs the grant.
          if (!(await mayReadProject(target, caller, membership, project))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          return json(200, await testEnvironmentAnswer(target, wired, project));
        }
        const savedEnvImage = SAVED_ENV_IMAGE.exec(path);
        if (savedEnvImage !== null) {
          const wired = target.wiring.savedEnv;
          if (wired === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          const project = savedEnvImage[1]!;
          // A project the person may not read, and one that does not exist, answer the same words; nothing is read for it.
          if (!(await target.wiring.canReadProject(caller.principal.personId, project).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          // The company is the membership's (the runtime's), never the request's. Role "viewer": a reader never gets Reset or the setting control, whatever their grant (the writes are not on the core here).
          const deps = { store: documentSavedEnvStore({ store: target.runtime.flow.deps.store, audit: target.runtime.flow.deps.audit }), session: { config: { enabled: wired.enabled === true } }, now: () => nowOf(target) };
          const panel = await savedEnvPanel(deps, { orgId: target.runtime.companyId, projectId: project }, { projectRole: "viewer" });
          if (!panel.ok) throw agentXError("NOT_FOUND", SAVED_ENV_OFF);
          return json(200, SavedEnvPanelSchema.parse(panel.panel));
        }
        const tokens = SCRIPT_TOKENS.exec(path);
        if (tokens !== null) {
          const enabled = target.wiring.scriptTokens?.enabled ?? (() => scriptTokensEnabled());
          if (target.wiring.scriptTokens === undefined || !enabled()) throw agentXError("NOT_FOUND", "route not found");
          const audit = auditOf(target, caller);
          const deps = { store: target.runtime.flow.deps.store, audit, now: () => nowOf(target) };
          // Read live for this request: the role controls creation and whether list/revoke reach every company token or only the caller's own.
          const scriptCaller: ScriptTokenCaller = { developerId: developerIdOf(caller.principal), personId: caller.principal.personId, orgId: companyId, orgRole: membership.role };
          if (tokens[1] === undefined && request.method === "POST") {
            // Refuse the role before reading the body; core creation enforces it too.
            if (scriptCaller.orgRole !== "owner" && scriptCaller.orgRole !== "admin") throw agentXError("FORBIDDEN", SCRIPT_TOKEN_CREATE_ADMIN_ONLY);
            // Owner DEC 254zzz91: a long-lived credential is made only from the Rovara website's own client, never by a CLI or AI-tool token.
            if (caller.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
            const canRead = target.wiring.canReadProject;
            if (canRead === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
            const cap = target.wiring.sessionCapSeconds;
            if (cap !== undefined && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)) throw agentXError("RUNTIME_UNAVAILABLE", SESSION_CAP_UNREADABLE);
            // A token is made only for projects this person may read now; one they may not read answers exactly like a missing one.
            // The record keeps how the maker signed in (the verified token's amr, when known), and the token never outlives the install's session cap.
            const made = await createScriptToken(deps, scriptCaller, bodyOf(request), async (project) => {
              if (!(await canRead(caller.principal.personId, project).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
            }, { ...(cap === undefined ? {} : { lifetimeCapSeconds: cap }), ...(caller.amr === undefined ? {} : { signIn: { amr: caller.amr } }) });
            return json(201, made);
          }
          if (tokens[1] === undefined && request.method === "GET") return json(200, { canCreate: scriptCaller.orgRole === "owner" || scriptCaller.orgRole === "admin", tokens: await listScriptTokens(deps, scriptCaller, async (developerId) => (developerId === scriptCaller.developerId ? caller.principal.displayName : undefined)) });
          if (tokens[1] !== undefined && request.method === "POST") return json(200, { token: await revokeScriptToken(deps, scriptCaller, tokenIdOf(tokens[1])) });
          throw agentXError("NOT_FOUND", "route not found");
        }
        return undefined;
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
  };
}
