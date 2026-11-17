// Engine host (migration plan v3.2 lane E2, step 6): the core engine's composition root on the deployed BROKER. The dispatcher's half is aws/worker-machines/dispatcher-core.ts.
//
// One object per function container, built at module load. It reads the switch (ROVARA_CORE_ENGINE) once through the core host app (core-host/app.ts): while the switch is OFF (the default)
// it builds nothing, reads nothing and answers nothing, so the broker behaves exactly as before. `coreTasks` is then undefined, and the developer routes never reach the core.
//
// While the switch serves, it wires:
//   - the registry: Code's AWS modules (core-host/code-modules.ts), the step 5 security modules (core-host/hosted-modules.ts) and whatever else the deployment adds, with the policy hook
//     put in front of admission and approvers last before the seal (hosted wiring (c)): ROVARA_POLICY_HOOK holds the install's hook settings; absent, nothing changes; settings without the
//     install's question key refuse the registry.
//   - each company's runtime: the deployed task access (membership plus the project grant the broker already keeps, `hostedTaskAccess`), the callback signing key, the repository grants
//     the broker's exchange verifies, and the services: lessons (`createCoreLessons`, where ROVARA_CORE_LESSONS covers the company and the deployment gives its people) plus the
//     deployment's own.
//   - the developer task routes' core entry (`coreTasks`): the core host's dev routes over the caller mapping (the broker's signed-in developer -> the principal the core knows, company
//     from MEMBERSHIP, never a claim; the verified token's step-up rides along), with the session cap (hosted wiring (f)) and every audit event of a script token naming the caller it came
//     through (hosted wiring (d)).
//     Lane L11 adds, per company: the session levels (live membership role, the broker's project grant), the decision cards (the task's own person's waiting documents; an act goes
//     through the approval gate with the approvers point's own signed step-up proof, lane L2a) and how we work (the code host, with the deployment's `codeSettings`). Each part the
//     deployment does not give answers "not on the core yet".
//   - `handleEvent`: a schedule's `agentx.core-job` event runs its job (with the function's time left), and a State table stream batch relays the outbox of the companies whose outbox rows
//     it inserted. Anything else is not the core's (`undefined`).
//
// What the registry still lacks (model keys, the broker's worker machines) and the job services no lane has built for AWS yet (merge tracking, the session sweep, notices)
// refuse the switch by name at the first use: the registry is never half-wired, and a refused build is retried on the next use. The admission's hold sweep is the root's own (lane L8),
// and the company's callback layer books its workers' usage reports into the cost ledger (core-host/usage-booking.ts).
import type { ProjectSettingsHook } from "./project-settings.js";
import { outboxCompaniesOf, relayCoreOutboxStream } from "./core-outbox-stream.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CORE_DISPATCH_QUEUE_URL_VARIABLE, CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, IMPLICIT_COMPANY_ID, OrgRoleSchema, HostedPolicyHookSettingsSchema, isContextSourceStage,
  when, type PolicySource, type AdapterRegistry, type HostedPolicyHookSettings, type ProjectRole, type DocumentStore, type OrgId, type OrgRole, type Principal,
} from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../core-host/app.js";
import { CORE_DISPATCH_QUEUE, codeAdapterModules, type CodeModuleDeps } from "../core-host/code-modules.js";
import { resolveTaskPeopleAccess, type TaskPeopleDependencies, type CheckTaskPerson } from "../developer/task-people.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskOwnerKey } from "../developer/task-records.js";
import { isWholeLimit, MAX_PER_PERSON, MAX_PER_ORGANIZATION, readWorkspaceLimits } from "../developer/limits.js";
import { costUsdOf } from "../core/cost/ledger.js";
import { withSharedMergeRecovery, policyCiReporting } from "./core-job-services.js";
import type { CoreServiceWiring, CoreRuntimeOptions, CoreService, CoreServiceName } from "../core-host/core-runtime.js";
import type { CiReporting } from "../core-host/switch-blockers.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../core-host/dev-routes.js";
import { SETUP_RUN_NOT_ALLOWED, type SetupRunStanding } from "../core-host/setup-run-routes.js";
import { lifecycleAccess } from "./project-lifecycle-routes.js";
import { codeHostForRecord } from "../plugins/routing.js";
import { deployedDevWiringParts, deployedSessionMembers, stepUpDecisionProofs, type DeployedPeople } from "../core-host/deployed-decisions.js";
import { createEvalPlanSources } from "../core/setup-agent/eval-plan-source.js";
import type { EvalPlanSources } from "../core/proof/eval-plan-delivery.js";
import { stepUpApprovalKeyOf } from "../core-host/hosted-approvers.js";
import type { CodeSettingsReader } from "../core/merge/seams.js";
import {
  HOSTED_IDENTITY_PROVIDER, createHostedHoldSweep, createHostedLedger, createHostedMoneyStop, hostedSecurityModules, readHostedAdmissionSettings, runSpendState, runStopWiredFrom, type HostedAdmissionSettings, type HostedIdentityOptions,
} from "../core-host/hosted-modules.js";
import { USAGE_EVENT_TYPE, createUsageBooking } from "../core-host/usage-booking.js";
import { createLessonsApi, type LessonsApi } from "../core-host/lessons-api.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, type CoreLessons, type CoreLessonsOptions } from "../core-host/lessons.js";
import type { CoreAdapterModule } from "../core-host/registry.js";
import type { TaskAccess } from "../core/task-flow/deps.js";
import type { RegistryTaskFlowOptions, TaskFlow } from "../core/task-flow/flow.js";
import { workspaceKeys } from "../core/task-flow/workspace-location.js";
import type { PolicyHookInstall } from "../core/policy-hook/index.js";
import { applyHostedPolicyHook } from "../core/policy-hook/hosted.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { mayUseProject } from "../developer/task-project-access.js";
import { Membership, membershipKey } from "./company-check.js";
import { coreTaskEntryFrom, type CoreEntryCaller, type CoreTaskEntry } from "./engine-boundary.js";
import { coreAppEntryFrom, type CoreAppEntry } from "./core-app-routes.js";
import { auditSinkForDeployedCaller, hostedSessionCapSeconds } from "./hosted-wiring.js"; import { attentionEmailFromEnvironment, attentionEmailModule } from "./attention-email.js"; import { LambdaClient } from "@aws-sdk/client-lambda";
import { isCoreJobEvent } from "../core-host/jobs.js";
import { attachCoreTeamRecord, hostedEraseLearning, type CoreTeamRecord } from "../core-host/team-record.js";
import { createPersonEraseRoute, type PersonEraseCaller } from "../core-host/person-erase-route.js";
import { resumePersonErases, type PersonEraseDeps, type PersonEraseObjects } from "../core/people/erase.js";
import { createCallbackService, type CallbackServiceOptions } from "../services/index.js";
import { createTaskTokenDescriber } from "../core/model-gateway/describer.js";
import { MODEL_ACCESS_PATH } from "../core/model-gateway/route.js";
import { CallbackCapabilities } from "../callbacks.js";
import type { TokenSigner } from "../developer/tokens.js";
import { coreModelGatewayWiring, gatewayModelKeysModules, taskTokensFromEnvironment } from "../core-host/gateway-model-access.js";
import { CORE_AGENT_MODEL_CHOICE_VARIABLE, adminOfferedModelsFromEnvironment, offeredModelsReaderFromEnvironment } from "../core-host/offered-models-http.js";
import { companyEngineModelRoute, companyEngineModelStartCheck, type EngineModelOfferedReader } from "../core-host/company-engine-model.js";
import { evalReservationModules } from "../core-host/eval-authority-http.js";
import { createCompanyModelChoices, type OfferedModelsReader } from "../core-host/gateway-model-selection.js";
import { RepositoryGrantService } from "../repository-access.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { ownerOfWorkspace } from "./engine-boundary.js";
import { workspaceCompanyReader } from "./worker-machines/workspace-company.js";
import { CORE_ENGINE_VARIABLE, parseCoreSwitch, switchCovers } from "../core-host/flags.js";

import { handleCoreContextTools } from "../core-host/context-tools.js";

type DynamoSender = { send(command: unknown): Promise<unknown> };

/** The variable that holds the install's policy hook settings (JSON: `{ address, jwks, thumbprints }`). Absent or empty: no hook. */
export const CORE_POLICY_HOOK_VARIABLE = "ROVARA_POLICY_HOOK";

/** What the root gives `codeModules`. */
export interface BrokerCoreModuleContext {
  /** The registry's store, once the registry is built (a call before then waits for it). */
  storage: () => Promise<DocumentStore>;
}

export interface BrokerCoreRootInputs {
  env: NodeJS.ProcessEnv;
  checkTaskPerson?: CheckTaskPerson;
  /** The State table and the sign-in table, as the broker's document client reads them (membership, project grants, the person's name). */
  documentClient: DynamoSender;
  stateTableName: string;
  signInTableName: string | undefined;
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
  /** The policy hook's asker (`policyHookInstallFromEnvironment`). Absent: an install with hook settings refuses its registry. */
  policyHookInstall?: () => PolicyHookInstall | undefined;
  /** The people lessons ask (per company). Absent: lessons are not built even where ROVARA_CORE_LESSONS covers a company (reported once). */
  lessonsPeople?: (companyId: OrgId) => HostedLessonPeople;
  /** The learning model port for lessons (the gateway, with its learning cap). Absent: learning calls refuse and nothing is spent. */
  lessonsLearning?: CoreLessonsOptions["learning"];
  /**
   * Optional explicit CI reader. Otherwise the root adapts policySource (D1 today when no source was supplied).
   * The runtime validates this reader and passes the same checked function to merge tracking.
   */
  ciReporting?: CiReporting;
  /** Lane L11: the company's code settings (how a project merges and approves), for how we work. Absent: how we work answers "not on the core yet" (never the laptop's fixed settings). */
  codeSettings?: CodeSettingsReader;
  /** D1 policy resolved per company/project. Absent: D1 today (their_ci_fix); never default on a failed read. */
  policySource?: PolicySource;
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
  /** The API's own address (a session's link). */
  origin: () => string;
  log: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  wrapStorage?: (store: DocumentStore) => DocumentStore;
}

export interface BrokerCoreRoot {
  readonly app: CoreHostApp;
  /** The developer task routes' core entry. Undefined while the switch is off: the routes never reach the core. */
  readonly coreTasks: CoreTaskEntry | undefined;
  /**
   * Lane L12: the core's own /v1/app/* routes for the broker's HTTP API (sessions, decision cards, how we work, script tokens and person erase), over the same caller mapping as
   * `coreTasks` (company and role from membership). Undefined while the switch is off: the developer API then answers every /v1/app/* path "route not found" and reads nothing.
   */
  readonly coreApp: CoreAppEntry | undefined;
  /**
   * Lane LM8: the Code lessons API for the developer routes (`deps.lessons`). Undefined while the engine switch is off, while ROVARA_CORE_LESSONS is off, or without the deployment's
   * people port: every lessons route then answers "Lessons are off." and reads nothing.
   */
  readonly lessons: LessonsApi | undefined;
  readonly policyHook?: ProjectSettingsHook;
  /**
   * Guided onboarding PR 16: whether archiving a project of this company takes effect, i.e. the switch sends the company's new tasks to the core engine (the only engine that reads the
   * archived state). Absent while the switch is off: the archive route then refuses an archive.
   */
  readonly projectArchiveTakesEffect?: (companyId: string) => boolean;
  /**
   * Person erase (row 13.1, #687) on the deployed API: `POST /v1/app/people/<id>/erase`, with the learning step erasing the person's lessons AND Team record rows. Answers `undefined` while the
   * switch is off or for any other path. The broker's HTTP API reaches it through `coreApp` (lane L12).
   */
  personErase(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined>;
  /** Finishes one company's owed person erases (the learning step first, then the evidence walk). For the scheduled job when it lands. Rejects while the switch is off. */
  resumePersonErases(companyId: string, budgetMs: number): Promise<{ finished: number; owed: number }>;
  /** A schedule's core job event, or a State table stream batch. `undefined`: not the core's. */
  handleEvent(event: unknown, options?: { remainingMs?: number | undefined }): Promise<unknown>;
  /**
   * A worker's callback (`/v1/internal/workspaces/<id>/operations/<id>/<action>`) for a workspace a CORE task holds: served by that company's core callback layer (its capability, its
   * repository grant exchange, the lessons' load report), or a gateway-stamped context-tools request verified before reads. `undefined`: not a core workspace, or the switch is off.
   */
  callback(request: BrokerRequest): Promise<BrokerResponse | undefined>;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CORE_CALLBACK = /^\/v1\/internal\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/operations\/[0-9a-f-]{36}\/[a-z-]+$/u;
const callbackAnswer = (statusCode: number, code: string, message: string): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code, message } }) });
const CORE_SETTINGS_REFUSAL_WORDS = "The core engine settings are not readable.";

/**
 * The hosted install's policy hook settings (ROVARA_POLICY_HOOK, JSON `{ address, jwks, thumbprints }`).
 * Absent or empty gives undefined. Unreadable settings throw in fixed words, so an install meant to ask always has a hook.
 * Developer-API composition (#717) uses the same resolved setting and hosted client.
 */
export function policyHookSettingsFromEnvironment(env: NodeJS.ProcessEnv): HostedPolicyHookSettings | undefined {
  const raw = env[CORE_POLICY_HOOK_VARIABLE]?.trim() ?? "";
  if (raw === "") return undefined;
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { throw new Error("the policy hook settings are not JSON"); }
  const parsed = HostedPolicyHookSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error("the policy hook settings are not readable");
  return parsed.data;
}

// ---- the eval plan source of the deployed callback layer (EVAL-PLAN-CORE-WIRING, DEC 253c/253j(1))

/**
 * The trusted eval plan source a deployed company's callback layer answers the `eval-plan` callback from: the company's own stored EVAL_PLAN bound to an approved eval spend item, the
 * approval through the install's bound `eval-reservation` adapter only, and the company's base-score cache. The approver's CURRENT role is the hosted members reader
 * (`deployedSessionMembers`: live `COMPANY_MEMBER#` membership in THIS company, the broker's project grant), never the role stored at approval or a role the gateway names.
 */
export function coreEvalPlanSources(registry: Pick<AdapterRegistry, "names" | "get" | "require">, companyId: OrgId, people: DeployedPeople, log?: (entry: { event: string }) => void): EvalPlanSources {
  return createEvalPlanSources({
    store: registry.require("storage"), companyId, registry, members: deployedSessionMembers(companyId, people),
    ...(log === undefined ? {} : { log: (event) => { log({ event: `core_engine.${event}` }); } }),
  });
}

// ---- membership and project grants (the broker's own records)

/** A person's live company membership with its role (R4's record, `COMPANY_MEMBER#<person>` in the sign-in table). Undefined: none, or revoked. A read that fails throws. */
export function membershipWithRoleFromDynamo(client: DynamoSender, tableName: string): (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined> {
  return async (personId) => {
    if (typeof personId !== "string" || personId.length === 0 || personId.length > 256 || /[#\s]/u.test(personId)) return undefined;
    const response = await client.send(new GetCommand({ TableName: tableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
    const parsed = Membership.safeParse(response?.Item);
    if (!parsed.success || parsed.data.personId !== personId || parsed.data.revokedAt !== undefined || !OrgRoleSchema.safeParse(parsed.data.role).success) return undefined;
    return { companyId: parsed.data.companyId, role: parsed.data.role };
  };
}

/** The person's project grant role (`MEMBER#<person>` / `PROJECT#<name>`, the broker's own rows, FR-013.1): `developer` or `administrator`, else undefined. */
export function projectGrantRoleFromDynamo(client: DynamoSender, tableName: string): (personId: string, project: string) => Promise<"developer" | "administrator" | undefined> {
  return async (personId, project) => {
    if (typeof personId !== "string" || personId === "" || /[#\s]/u.test(personId) || typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(project)) return undefined;
    const response = await client.send(new GetCommand({ TableName: tableName, Key: { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    if (row === undefined || row["pk"] !== `MEMBER#${personId}` || row["sk"] !== `PROJECT#${project}` || row["projectName"] !== project) return undefined;
    return mayUseProject(row["role"]) ? row["role"] : undefined;
  };
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

/** The project role the lessons API reads, from the broker's grant: a project administrator is a `maintainer`, a developer a `contributor`; anything else none. */
export function projectRoleOf(grant: "developer" | "administrator" | undefined): ProjectRole | undefined {
  return grant === "administrator" ? "maintainer" : grant === "developer" ? "contributor" : undefined;
}

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
export function setupRunStandingFrom(people: { membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>; projectGrantRole: (personId: string, project: string) => Promise<"developer" | "administrator" | undefined> }): (personId: string, companyId: OrgId, project: string) => Promise<SetupRunStanding> {
  return async (personId, companyId, project) => {
    const membership = await people.membershipOf(personId);
    if (membership === undefined || membership.companyId !== companyId) return { access: "none" };
    const access = lifecycleAccess(membership.role, await people.projectGrantRole(personId, project));
    if (access !== "manage") return { access };
    return { access, basis: membership.role === "owner" ? "company-owner" : membership.role === "admin" ? "company-admin" : "project-admin" };
  };
}

export function hostedTaskAccess(inputs: {
  membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>; projectGrant: (personId: string, project: string) => Promise<boolean>; companyId: OrgId; storage?: () => Promise<DocumentStore>; people?: TaskPeopleDependencies;
  /** Guided onboarding L2-3: the setup run's own rule. With it (and `storage`), a step of a setup-run task is allowed only while the person it runs for still manages the project's setup (DEC 254n 3); any other task's step keeps the project-grant rule. */
  setupRunStanding?: (personId: string, companyId: OrgId, project: string) => Promise<SetupRunStanding>;
}): TaskAccess {
  const liveMember = async (personId: string) => {
    const membership = await inputs.membershipOf(personId);
    return membership !== undefined && membership.companyId === inputs.companyId ? membership : undefined;
  };
  const owner = async (principal: Principal, task: { developerId: string; project: string; taskId?: string }) => {
    if (principal.companyId !== inputs.companyId || await liveMember(principal.personId) === undefined) return undefined;
    if (task.taskId === undefined || inputs.storage === undefined) return principal.personId === task.developerId ? { revision: undefined, ownerIds: [] as readonly string[] } : undefined;
    const store = await inputs.storage();
    const stored = await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
    if (stored?.["companyId"] !== inputs.companyId || stored["developerId"] !== task.developerId || stored["project"] !== task.project) return undefined;
    // Reuse the broker's existing co-owner proof, including fresh identity/channel eligibility and PEOPLE reconciliation. Missing proof refuses; never trust a role alone.
    const people = inputs.people === undefined ? undefined : await resolveTaskPeopleAccess(inputs.people, stored as unknown as DeveloperTaskRecord, principal.personId);
    if (people === undefined) {
      if (await store.get({ pk: `DEVTASK#${task.taskId}`, sk: "PEOPLE" }) !== undefined) return undefined;
      return principal.personId === task.developerId ? { revision: undefined, ownerIds: [] as readonly string[] } : undefined;
    }
    if (people.orphaned || people.role !== "owner" || !await inputs.projectGrant(principal.personId, task.project)) return undefined;
    return { revision: people.peopleRevision, ownerIds: people.ownerActorIds };
  };
  return {
    async checkStart(principal, project) {
      if (principal.companyId !== inputs.companyId || (await liveMember(principal.personId)) === undefined) return { allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE };
      return (await inputs.projectGrant(principal.personId, project)) ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT };
    },
    async canAct(principal, task) {
      return await owner(principal, task) !== undefined;
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
    async checkStep(task) {
      if ((await liveMember(task.developerId)) === undefined) return { allowed: false, message: NOT_A_MEMBER_HERE };
      // A setup run (the stored task says so) runs on the setup run's rule: an owner or admin of the company, or the project's administrator, read now. Any other task: the grant.
      if (inputs.setupRunStanding !== undefined && inputs.storage !== undefined) {
        const stored = await (await inputs.storage()).get({ pk: `DEVTASK#${task.taskId}`, sk: "META" });
        if (stored?.["purpose"] === "setup_agent") {
          if (stored["companyId"] !== inputs.companyId) return { allowed: false, message: NOT_A_MEMBER_HERE };
          return (await inputs.setupRunStanding(task.developerId, inputs.companyId, task.project)).access === "manage" ? { allowed: true } : { allowed: false, message: SETUP_RUN_NOT_ALLOWED };
        }
      }
      return (await inputs.projectGrant(task.developerId, task.project)) ? { allowed: true } : { allowed: false, message: NO_PROJECT_GRANT };
    },
  };
}

/**
 * The deployment's caller mapping (lane ID): the broker's signed-in developer -> the principal the core knows. The company and role come from the person's LIVE membership, read on every
 * call (never a token claim); the step-up and the client ride along only as the broker's sign-in set them from the verified token. No membership: undefined (the sign-in refusal).
 */
export function deployedCallerFromMembership(membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>): (caller: CoreEntryCaller) => Promise<DeployedCaller | undefined> {
  return async (caller) => {
    const membership = await membershipOf(caller.developerId);
    if (membership === undefined) return undefined;
    const principal: Principal = { companyId: membership.companyId, personId: caller.developerId, displayName: caller.name, roles: [membership.role], provider: HOSTED_IDENTITY_PROVIDER };
    return { principal, ...(caller.clientId === undefined ? {} : { client: caller.clientId }), ...(caller.stepUp === undefined ? {} : { stepUp: caller.stepUp }) };
  };
}

// ---- the stream hook (shared with the notifier's existing reader)
export { outboxCompaniesOf };

// ---- money (lane L8)

/**
 * One company's money wiring over the sealed registry: the callback layer's usage booking (the usage the company's workers report is booked into the task's cost ledger before the batch
 * is acknowledged, core-host/usage-booking.ts) and the admission's own hold sweep. The company is the runtime's own, never the operation's word (the callback layer has checked they agree).
 */
export function coreMoneyWiring(registry: Pick<AdapterRegistry, "require">, companyId: OrgId, now: () => Date, settings?: HostedAdmissionSettings): { bookUsage: NonNullable<CallbackServiceOptions["bookUsage"]>; holdSweep: CoreService } {
  const store = registry.require("storage");
  const metering = registry.require("metering");
  const booking = createUsageBooking({ store, metering, now });
  const ledger = createHostedLedger({ store, metering, now });
  return {
    // The per-run stop (core-money-stop): after a batch's usage is booked, the run's task and the company's day are read against the caps; a run past one is answered with the stop's code,
    // and the callback layer asks its worker to stop (core/task-flow/money-stop.ts `requestSpendStop`). Without the caps (`settings`) nothing is read.
    bookUsage: async (operation, events) => {
      if (operation.companyId !== companyId) throw new Error("operation belongs to another company");
      const booked = await booking.bookOperationEvents({ id: operation.id, workspaceId: operation.workspaceId, companyId }, events);
      if (settings === undefined || !events.some((event) => event.type === USAGE_EVENT_TYPE)) return booked;
      const taskId = (await store.get((await workspaceKeys({ store, companyId: operation.companyId }, operation.workspaceId)).taskPointerKey()))?.["taskId"];
      const state = typeof taskId === "string" && taskId !== "" ? await runSpendState({ store, ledger, settings, now }, companyId, taskId) : "spend_unknown";
      return state === "within" ? booked : { ...booked, spendStop: state };
    },
    holdSweep: createHostedHoldSweep({ store, companyId, now }),
  };
}

// ---- the root

export function createBrokerCoreRoot(inputs: BrokerCoreRootInputs): BrokerCoreRoot {
  const { env, log } = inputs;
  let settingsBlocked = false;
  let hookSettings: HostedPolicyHookSettings | undefined;
  let hookProblem = false;
  if (parseCoreSwitch(env[CORE_ENGINE_VARIABLE]).value.mode !== "off") {
    try {
      const admission = readHostedAdmissionSettings(env);
      if ("problem" in admission || readCoreLessonsSwitch(env).problem !== undefined) settingsBlocked = true;
      try { hookSettings = policyHookSettingsFromEnvironment(env); } catch { hookProblem = true; throw new Error("the policy hook settings are not readable"); }
    } catch {
      settingsBlocked = true;
    }
  }
  if (settingsBlocked) log({ event: "core_engine.settings_blocked" });
  const now = inputs.now ?? (() => new Date());
  const membershipOf = inputs.signInTableName === undefined || inputs.signInTableName === ""
    ? async () => undefined
    : membershipWithRoleFromDynamo(inputs.documentClient, inputs.signInTableName);
  const projectGrantRole = projectGrantRoleFromDynamo(inputs.documentClient, inputs.stateTableName);
  const projectGrant = async (personId: string, project: string): Promise<boolean> => mayUseProject(await projectGrantRole(personId, project));
  // Guided onboarding L2-3: who may manage a project's setup run (PR 16's rule over live membership and the grant), for the routes and every step of a run.
  const setupRunStanding = setupRunStandingFrom({ membershipOf, projectGrantRole });
  const displayNameOf = async (personId: string): Promise<string | undefined> => {
    if (inputs.signInTableName === undefined || inputs.signInTableName === "" || /[#\s]/u.test(personId) || personId === "") return undefined;
    const response = await inputs.documentClient.send(new GetCommand({ TableName: inputs.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    return row === undefined || row["revoked"] === true || typeof row["displayName"] !== "string" ? undefined : row["displayName"];
  };
  const identity: HostedIdentityOptions = { membershipOf, displayNameOf };
  const coreSwitch = parseCoreSwitch(env[CORE_ENGINE_VARIABLE]);
  const coreActive = coreSwitch.value.mode !== "off" || coreSwitch.drain === true; 
  // Web task channel C8 (option b): the attention email, OFF unless ROVARA_ATTENTION_EMAIL is `on` (attention-email.ts). One attempt per invoke: a send whose answer was lost is never sent again.
  const attention = coreActive ? attentionEmailFromEnvironment({ env, lambda: () => new LambdaClient({ maxAttempts: 1 }), documentClient: inputs.documentClient, signInTableName: inputs.signInTableName, callbackSigningKey: inputs.callbackSigningKey, now: () => now().getTime(), membershipOf, log }) : undefined;
  // L2b: read when first needed (a serving switch only); a broken setting throws in fixed words and refuses the runtime.
  const modelGateway = () => coreModelGatewayWiring(env, inputs.taskTokens);
  // DEC 243c: with the gateway's offered-models reader, the company's per-step model rule chooses each step's model from that list (one rule per company, kept for its page's routes).
  // One reader for every company: the deployment's own (the gateway's route, signed with the task key) unless the root was given one.
  const modelChoices = createCompanyModelChoices({ reader: coreActive && env[CORE_AGENT_MODEL_CHOICE_VARIABLE] === "on" ? inputs.offeredModels ?? offeredModelsReaderFromEnvironment(env, inputs.taskTokens) : undefined, now: () => now().getTime() });
  // DEC 254n (1): the company's own engine model (when it set one) replaces the install's for its tasks; its start is refused unless the gateway offers it THAT company now. The list is read
  // through the same reader as the model choice where the root was given one, else the gateway's own route signed with the task key (only the gateway's origin is needed).
  const engineOffered: EngineModelOfferedReader | undefined = !coreActive ? undefined
    : inputs.offeredModels !== undefined ? (companyId) => inputs.offeredModels!.offered(companyId) : adminOfferedModelsFromEnvironment(env, inputs.taskTokens ?? (() => undefined));
  const modelFlowOptions = (registry: AdapterRegistry, companyId: OrgId): Partial<RegistryTaskFlowOptions> => {
    const gateway = modelGateway()!.flowOptions;
    const store = registry.require("storage");
    const modelAccess = companyEngineModelRoute({ store, companyId, install: gateway.modelAccess });
    return { ...modelChoices.flowOptionsFor(registry, companyId, { ...gateway, modelAccess }), startModelCheck: companyEngineModelStartCheck({ store, companyId, offered: engineOffered }) };
  };
  // Switch off (and not draining): the core settings are never read, so an install without the core reads exactly what it read before (CORE_ENGINE_BROKER_WIRED).
  const lessonsSwitch: ReturnType<typeof readCoreLessonsSwitch> = coreActive ? readCoreLessonsSwitch(env) : { value: { mode: "off" } };
  // The caps the per-run stop reads (the admission module refuses to build without them, so the registry is refused then too).
  const readSettings = coreActive ? readHostedAdmissionSettings(env) : undefined;
  const admissionSettings = readSettings !== undefined && "settings" in readSettings ? readSettings.settings : undefined;
  const lessonsByCompany = new Map<string, CoreLessons>();
  const teamRecords = new Map<string, CoreTeamRecord>();

  const app = createCoreHostApp({
    env,
    log,
    modules: () => [...codeAdapterModules(inputs.codeModules({ storage: async () => (await app.registry()).require("storage") })), ...hostedSecurityModules({ env, identity, callbackSigningKey: inputs.callbackSigningKey, runStopWired: runStopWiredFrom(env) }), ...gatewayModelKeysModules(env), ...(attention === undefined ? [] : [attentionEmailModule(attention.sender)]), ...evalReservationModules(env, inputs.taskTokens), ...(inputs.extraModules?.() ?? [])],
    context: () => ({ installCompanyId: IMPLICIT_COMPANY_ID, now, env, clients: {}, log }),
    ...(inputs.wrapStorage === undefined ? {} : { wrapStorage: inputs.wrapStorage }),
    beforeSeal: (registry) => {
      const settings = hookSettings;
      if (settings === undefined) return;
      applyHostedPolicyHook(registry, settings, inputs.policyHookInstall?.(), { audit: registry.require("audit-sink"), now: () => now().getTime(), log });
    },
    runtime: (registry, companyId) => ({
      callbackSigningKey: inputs.callbackSigningKey,
      // The per-run stop and the usage flush on Stop and close (core-money-stop): a stopped run whose usage did not arrive keeps its task's whole hold, marked estimated.
      // L2b: every core step on the gateway's agent model (the token's description reads the same route).
      // Configured without the task-token signer: refused here, so no task starts. The money stop is wired in every case.
      flowOptions: { limits: async () => {
        const fallback = { member: Number(env.SLACK_MEMBER_WORKSPACE_LIMIT ?? "3"), organization: Number(env.SLACK_ORGANIZATION_WORKSPACE_LIMIT ?? "20") };
        if (!isWholeLimit(fallback.member, MAX_PER_PERSON) || !isWholeLimit(fallback.organization, MAX_PER_ORGANIZATION) || fallback.member > fallback.organization) throw new Error("the workspace limits are not readable");
        return await readWorkspaceLimits(inputs.documentClient, inputs.stateTableName, fallback, log);
      }, ...(modelGateway() === undefined ? {} : modelFlowOptions(registry, companyId)), moneyStop: createHostedMoneyStop({ store: registry.require("storage"), companyId, settings: admissionSettings, now }) },
      access: hostedTaskAccess({ membershipOf, projectGrant, companyId, storage: async () => registry.require("storage"), setupRunStanding, people: {
        documentClient: inputs.documentClient, tableName: inputs.stateTableName, now: () => now().getTime(),
        ...(inputs.checkTaskPerson === undefined ? {} : { checkTaskPerson: inputs.checkTaskPerson }),
      } }),
      repositoryCredential: inputs.repositoryCredential,
      repositoryGrantKey: inputs.repositoryGrantKey,
      now,
      log,
      ciReporting: inputs.ciReporting === undefined ? policyCiReporting(inputs.policySource) : inputs.ciReporting,
      services: (flow, wiring) => {
        const choice = modelChoices.choiceFor(companyId);
        if (choice !== undefined) {
          // Validate immediately before broker-side dispatch handoff, including start, callbacks and scheduled relays.
          const outbox = flow.deps.outbox;
          flow.deps.outbox = { stage: (message) => outbox.stage(message), relay: async (options) => {
            await choice.service().state();
            return await outbox.relay(options);
          } };
        }
        let lessons: CoreLessons | undefined;
        if (inputs.lessonsPeople === undefined) {
          if (lessonsSwitch.value.mode !== "off") log({ event: "core_engine.lessons_not_wired", companyId });
        } else {
          lessons = createCoreLessons({
            flow, registry, companyId, lessonsSwitch: lessonsSwitch.value, people: inputs.lessonsPeople(companyId), now: () => now().getTime(), log,
            ...(inputs.lessonsLearning === undefined ? {} : { learning: inputs.lessonsLearning }),
            hostFor: async (other) => {
              if (other === companyId) return lessonsByCompany.get(other)?.host;
              try { await app.runtimeFor(other); } catch { return undefined; }
              return lessonsByCompany.get(other)?.host;
            },
          });
          if (lessons !== undefined) {
            lessons.attach();
            lessonsByCompany.set(companyId, lessons);
            // The Team record rides on the company's lessons (LM7): a merged or closed task of the company adds its people's decisions and review feedback. Its search is for the
            // context sources' `teamSearch`; only this company's eligible stages advertise it.
            teamRecords.set(companyId, attachCoreTeamRecord(lessons, { store: registry.require("storage"), now: () => now().getTime(), log }));
            flow.deps.contextSources = { stageHasSources: async (_task, mode) => isContextSourceStage(mode) && teamRecords.has(companyId) };
          }
        }
        // The admission's own hold sweep (lane L8) is always this one: a deployment's services never replace the sweep of the holds this admission takes.
        return {
          ...(inputs.services?.(companyId, flow, registry, attention === undefined ? wiring : { ...wiring, notification: { address: attention.addressFor(flow.deps.store), emailLinks: attention.links, remember: attention.rememberFor(flow.deps.store) } }) ?? {}), ...(lessons === undefined ? {} : { lessons: lessons.service }),
          "person-erase-resume": { pass: async ({ budgetMs }) => await resumeErases(companyId, budgetMs) },
          "admission-hold-sweep": coreMoneyWiring(registry, companyId, now).holdSweep,
        };
      },
    }),
  });
  if (lessonsSwitch.problem !== undefined) log({ event: "core_engine.lessons_switch_unreadable", problem: lessonsSwitch.problem });

  // Off: nothing below is built. Invalid active settings leave only the fixed core refusal entry.
  let coreTasks: CoreTaskEntry | undefined;
  let coreApp: CoreAppEntry | undefined;
  let lessons: LessonsApi | undefined;
  if (settingsBlocked) {
    const blockedSwitch = parseCoreSwitch(env[CORE_ENGINE_VARIABLE]).value;
    coreTasks = {
      route: async (_request, caller) => {
        let membership: CompanyMembership | undefined;
        try {
          membership = await membershipOf(caller.developerId);
        } catch {
          return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
        }
        if (membership === undefined || !switchCovers(blockedSwitch, membership.companyId)) return undefined;
        return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      },
    };
  } else if (app.serving) {
    // The library's install-wide learning gate follows the lessons switch.
    setCoreLessonsGate(env);
    const companyOf = async (caller: DeployedCaller): Promise<CompanyMembership | undefined> => membershipOf(caller.principal.personId);
    // Lane L11: an act on a decision card carries the approvers point's own proof (lane L2a), signed with the key the point verifies with.
    const decisionProofs = stepUpDecisionProofs(stepUpApprovalKeyOf(inputs.callbackSigningKey), () => now().getTime());
    const routes = createCoreDevRoutes({
      app, companyOf, log,
      wiring: async (runtime) => {
        // Lane L11: the session levels, the decision cards and how we work, from the company's own records (membership and the broker's project grants).
        const registry = await app.registry();
        return {
          origin: inputs.origin,
          sessionCapSeconds: hostedSessionCapSeconds(),
          scriptTokens: {}, ...(attention === undefined ? {} : { unsubscribeKey: attention.unsubscribeKey }),
          ...(modelChoices.choiceFor(runtime.companyId) === undefined ? {} : { modelChoice: modelChoices.choiceFor(runtime.companyId)! }),
          taskActions: { roundCap: async (task) => {
            if (admissionSettings === undefined || task.companyId !== runtime.companyId) throw new Error("the task cap is unavailable");
            const ledger = createHostedLedger({ store: registry.require("storage"), metering: registry.require("metering"), now });
            return { limitUsd: admissionSettings.taskCapMicros / 1_000_000, spentUsd: costUsdOf(await ledger.taskCost(runtime.companyId, task.taskId)) };
          } },
          canReadProject: (personId, project) => projectGrant(personId, project),
          // Guided onboarding L2-3: the hosted setup run. Its model use is the gateway's (configured: the run is metered); citations are re-read from the company's own code host.
          setupRun: {
            standing: setupRunStanding,
            modelAccessConfigured: () => { try { return modelGateway() !== undefined; } catch { return false; } },
            readFile: (repository, path, commit, readOptions) => codeHostForRecord(registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } })
              .fileAtRevision({ url: repository.url }, path, commit, { orgId: runtime.companyId }, { ...(readOptions.untilLine === undefined ? {} : { untilLine: readOptions.untilLine }), timeoutMs: readOptions.timeoutMs, maxBytes: 262_144 }),
            displayName: displayNameOf,
          },
          auditFor: (caller, sink) => auditSinkForDeployedCaller(sink, { client: caller.client }),
          ...deployedDevWiringParts({ runtime, registry, people: { membershipOf, projectGrantRole }, decisionProofs, codeSettings: inputs.codeSettings, log }),
        };
      },
    });
    const deployedCallerOf = deployedCallerFromMembership(membershipOf);
    coreTasks = coreTaskEntryFrom(routes, deployedCallerOf);
    // Lane L12: the same routes and caller mapping on /v1/app/*, with the person erase (below) next to them.
    coreApp = coreAppEntryFrom({ routes, personErase: { route: async (request, caller) => await personErase(request, caller) }, deployedCallerOf, log });
    // Lane LM8: the lessons API, where the lessons switch is on and the deployment gives its people. The company and role come from membership; a company's lessons are its own
    // runtime's (built once); the person's project role is the broker's own project grant (administrator: maintainer, developer: contributor).
    const lessonsPeople = inputs.lessonsPeople;
    if (lessonsSwitch.value.mode !== "off" && lessonsPeople !== undefined) {
      lessons = createLessonsApi({
        lessonsSwitch: lessonsSwitch.value,
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
        projectRole: async (companyId, project, personId) => ((await membershipOf(personId))?.companyId !== companyId ? undefined : projectRoleOf(await projectGrantRole(personId, project))),
        now: () => now().getTime(),
        log,
      });
    }
  }

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
  const companyOfWorkspace = workspaceCompanyReader(inputs.documentClient, inputs.stateTableName);
  const callbackHandlers = new Map<string, Promise<(request: BrokerRequest) => Promise<BrokerResponse>>>();
  const callbackHandlerFor = (companyId: OrgId): Promise<(request: BrokerRequest) => Promise<BrokerResponse>> => {
    let found = callbackHandlers.get(companyId);
    if (found === undefined) {
      found = (async () => {
        const runtime = await app.runtimeFor(companyId);
        const registry = await app.registry();
        const lessons = lessonsByCompany.get(companyId);
        const money = coreMoneyWiring(registry, companyId, now, admissionSettings);
        // L2b: a worker's model-access request gets a task token for the gateway (its own operation, company, task and model only).
        const wiring = modelGateway();
        const gateway = wiring?.callbackGateway(createTaskTokenDescriber(runtime.flow.deps));
        return createCallbackService({
          ...(gateway === undefined ? {} : { modelGateway: gateway }),
          flow: runtime.flow.deps,
          blobs: registry.require("object-storage"),
          // The grants the dispatcher issued for this company's workers (the same key derivation), exchanged here for a credential.
          grants: new RepositoryGrantService(inputs.repositoryGrantKey, inputs.repositoryCredential),
          ...(lessons === undefined ? {} : { onEvents: (operation, events) => lessons.host.onEvents(operation, events) }),
          bookUsage: money.bookUsage,
          // DEC 253c/253j(1): the trusted eval plan, approval and baseline cache for this company's CHECKS runs, with the approver's live role from the hosted members reader.
          evalPlan: coreEvalPlanSources(registry, companyId, { membershipOf, projectGrantRole }, log),
          // Guided onboarding L2-3: a hosted setup run's callback (its journal, website asks, polls and eval report). No person types a command into a hosted run (the command route is
          // the laptop page's only), so nothing is ever handed over.
          setupAgent: { mayStillRun: async () => false },
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
    return { store, audit, objects: objects as PersonEraseObjects, eraseLearning: hostedEraseLearning({ store, audit, now: () => now().getTime(), log }), now: () => now().getTime(), log };
  };
  const resumeErases = async (companyId: string, budgetMs: number): Promise<{ finished: number; owed: number }> => {
    const registry = await app.registry();
    return await resumePersonErases(eraseDepsOver(registry, companyId), companyId, budgetMs);
  };
  const standingOf = personStandingFromDynamo(inputs.documentClient, inputs.signInTableName);

  async function personErase(request: BrokerRequest, caller: PersonEraseCaller): Promise<BrokerResponse | undefined> {
    if (!app.serving || !(request.path.split("?")[0] ?? "").startsWith("/v1/app/people/")) return undefined;
    const registry = await app.registry();
    return await createPersonEraseRoute({
      app, log, standing: standingOf,
      companyOf: async (who) => await membershipOf(who.principal.personId),
      eraseDeps: (companyId) => eraseDepsOver(registry, companyId),
    }).route(request, caller);
  }

  return {
    app,
    coreTasks,
    coreApp,
    lessons,
    ...(coreApp === undefined ? {} : { projectArchiveTakesEffect: (companyId: string) => app.engineForNewTask(companyId) === "core" }),
    ...(hookSettings === undefined && !hookProblem ? {} : { policyHook: {
      get settings() {
        if (hookSettings === undefined) throw new Error("the policy hook settings are not readable");
        return hookSettings;
      },
      get install() {
        const install = inputs.policyHookInstall?.();
        if (install === undefined) throw new Error("the policy hook install is unavailable");
        return install;
      },
    } }),
    async personErase(request, caller) {
      if (settingsBlocked && app.serving && (request.path.split("?")[0] ?? "").startsWith("/v1/app/people/")) return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      return await personErase(request, caller);
    },
    async resumePersonErases(companyId, budgetMs) {
      if (settingsBlocked) throw new Error(CORE_SETTINGS_REFUSAL_WORDS);
      return await resumeErases(companyId, budgetMs);
    },
    async callback(request) {
      if (coreTasks === undefined) return undefined;
      // L5: settings that cannot be read refuse the core's context tools too.
      if (settingsBlocked && (request.path.split("?")[0] ?? "") === "/v1/internal/context-tools") return callbackAnswer(503, "CORE_SWITCH_BLOCKED", CORE_SETTINGS_REFUSAL_WORDS);
      const context = await handleCoreContextTools(request, {
        capabilities: { verify: (token, action) => new CallbackCapabilities(Buffer.from(inputs.callbackSigningKey)).verify(token, action) },
        ownerOfWorkspace: (workspaceId) => ownerOfWorkspace(table, workspaceId),
        companyOfWorkspace,
        runtimeFor: async (companyId) => ({ flow: (await app.runtimeFor(companyId)).flow.deps, teamSearch: teamRecords.get(companyId)?.search }),
      });
      if (context !== undefined) return context;
      // L2b: a worker's model-access request names its workspace only inside its signed capability (checked here before any read; the handler checks it again).
      const workspaceId = modelAccessWorkspaceOf(request) ?? CORE_CALLBACK.exec(request.path.split("?")[0] ?? "")?.[1];
      if (workspaceId === undefined || await ownerOfWorkspace(table, workspaceId) !== "core") return undefined;
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
    },
    async handleEvent(event, options) {
      if (settingsBlocked && (isCoreJobEvent(event) || outboxCompaniesOf(event) !== undefined)) throw new Error(CORE_SETTINGS_REFUSAL_WORDS);
      if (isCoreJobEvent(event)) return await withSharedMergeRecovery(() => app.handleScheduledJob(event, options));
      return await relayCoreOutboxStream(event, (companies) => app.relayOutbox(companies));
    },
  };
}

/**
 * The developer API's configuration with the core's entries (lane E2 step 6, lane L12): while the switch serves, the task routes' core entry and the /v1/app/* routes; off (neither is
 * built), the configuration exactly as given, so the developer API is byte-identical.
 */
export function withCoreRoutes<T extends object>(config: T, root: Pick<BrokerCoreRoot, "coreTasks" | "coreApp" | "policyHook" | "projectArchiveTakesEffect">): T | (T & { coreTasks: CoreTaskEntry; coreApp?: CoreAppEntry; projectArchiveTakesEffect?: (companyId: string) => boolean }) {
  if (root.coreTasks === undefined) return config;
  return { ...config, ...(root.policyHook === undefined ? {} : { policyHook: root.policyHook }), coreTasks: root.coreTasks, ...(root.coreApp === undefined ? {} : { coreApp: root.coreApp }),
    ...(root.projectArchiveTakesEffect === undefined ? {} : { projectArchiveTakesEffect: root.projectArchiveTakesEffect }) };
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
  return { settings: { ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }), queues: { [CORE_DISPATCH_QUEUE]: { url, deadLetterUrl } } } };
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
