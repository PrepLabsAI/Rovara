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
//   - `handleEvent`: a schedule's `agentx.core-job` event runs its job (with the function's time left), and a State table stream batch relays the outbox of the companies whose outbox rows
//     it inserted. Anything else is not the core's (`undefined`).
//
// What the registry still lacks (approvers, model keys, the broker's worker machines) and the job services no lane has built for AWS yet (merge tracking, the session sweep, notices,
// the admission hold sweep) refuse the switch by name at the first use: the registry is never half-wired, and a refused build is retried on the next use.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  IMPLICIT_COMPANY_ID, OrgRoleSchema, PolicyHookSettingsSchema, companyOfKey,
  type AdapterRegistry, type PolicyHookSettings, type DocumentStore, type OrgId, type OrgRole, type Principal,
} from "@agentx/contracts";
import { createCoreHostApp, type CoreHostApp } from "../core-host/app.js";
import { codeAdapterModules, type CodeModuleDeps } from "../core-host/code-modules.js";
import type { CoreRuntimeOptions, CoreService, CoreServiceName } from "../core-host/core-runtime.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../core-host/dev-routes.js";
import { HOSTED_IDENTITY_PROVIDER, hostedSecurityModules, type HostedIdentityOptions } from "../core-host/hosted-modules.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, type CoreLessons, type CoreLessonsOptions } from "../core-host/lessons.js";
import type { CoreAdapterModule } from "../core-host/registry.js";
import type { TaskAccess } from "../core/task-flow/deps.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { applyPolicyHook, type PolicyHookInstall } from "../core/policy-hook/index.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { mayUseProject } from "../developer/task-project-access.js";
import { Membership, membershipKey } from "./company-check.js";
import { coreTaskEntryFrom, type CoreEntryCaller, type CoreTaskEntry } from "./engine-boundary.js";
import { auditSinkForDeployedCaller, hostedSessionCapSeconds } from "./hosted-wiring.js";
import { isCoreJobEvent } from "../core-host/jobs.js";
import { createCallbackService } from "../services/index.js";
import { RepositoryGrantService } from "../repository-access.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { ownerOfWorkspace } from "./engine-boundary.js";
import { workspaceCompanyReader } from "./worker-machines/workspace-company.js";

type DynamoSender = { send(command: unknown): Promise<unknown> };

/** The variable that holds the install's policy hook settings (JSON: `{ address, keys }`). Absent or empty: no hook. */
export const CORE_POLICY_HOOK_VARIABLE = "ROVARA_POLICY_HOOK";

export interface BrokerCoreRootInputs {
  env: NodeJS.ProcessEnv;
  /** The State table and the sign-in table, as the broker's document client reads them (membership, project grants, the person's name). */
  documentClient: DynamoSender;
  stateTableName: string;
  signInTableName: string | undefined;
  callbackSigningKey: string;
  /** The key the broker's repository grant exchange verifies with (aws/broker.ts derives it from the callback signing key). */
  repositoryGrantKey: Buffer;
  /** Resolves a worker's repository credential (the GitHub App). */
  repositoryCredential: CoreRuntimeOptions["repositoryCredential"];
  /** Code's AWS adapter inputs, asked for only when the registry is first built. */
  codeModules: () => CodeModuleDeps;
  /** More modules after Code's and the step 5 ones (approvers and model keys when their lanes land). */
  extraModules?: () => readonly CoreAdapterModule[];
  /** The policy hook's asker (`policyHookInstallFromEnvironment`). Absent: an install with hook settings refuses its registry. */
  policyHookInstall?: () => PolicyHookInstall | undefined;
  /** The people lessons ask (per company). Absent: lessons are not built even where ROVARA_CORE_LESSONS covers a company (reported once). */
  lessonsPeople?: (companyId: OrgId) => HostedLessonPeople;
  /** The learning model port for lessons (the gateway, with its learning cap). Absent: learning calls refuse and nothing is spent. */
  lessonsLearning?: CoreLessonsOptions["learning"];
  /** The job services the deployment builds for a company (merge tracking, the session sweep, notices, the admission hold sweep). */
  services?: (companyId: OrgId, flow: TaskFlow, registry: AdapterRegistry) => Partial<Record<CoreServiceName, CoreService>>;
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
  /** A schedule's core job event, or a State table stream batch. `undefined`: not the core's. */
  handleEvent(event: unknown, options?: { remainingMs?: number | undefined }): Promise<unknown>;
  /**
   * A worker's callback (`/v1/internal/workspaces/<id>/operations/<id>/<action>`) for a workspace a CORE task holds: served by that company's core callback layer (its capability, its
   * repository grant exchange, the lessons' load report). `undefined`: not a core workspace (the old routes answer it), or the switch is off.
   */
  callback(request: BrokerRequest): Promise<BrokerResponse | undefined>;
}

const CORE_CALLBACK = /^\/v1\/internal\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/operations\/[0-9a-f-]{36}\/[a-z-]+$/u;
const callbackAnswer = (statusCode: number, code: string, message: string): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code, message } }) });

/**
 * The install's policy hook settings (ROVARA_POLICY_HOOK, JSON `{ address, keys }`), read the same way for the core engine (here) and for the developer API's company bounds on project
 * settings (#717: `DeveloperApiConfiguration.policyHook = { settings, install }`). Absent or empty: undefined (no hook; today's behaviour). Anything that is not readable settings throws in
 * fixed words, so an install meant to ask never runs without asking.
 */
export function policyHookSettingsFromEnvironment(env: NodeJS.ProcessEnv): PolicyHookSettings | undefined {
  const raw = env[CORE_POLICY_HOOK_VARIABLE]?.trim() ?? "";
  if (raw === "") return undefined;
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { throw new Error("the policy hook settings are not JSON"); }
  const parsed = PolicyHookSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error("the policy hook settings are not readable");
  return parsed.data;
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

/** Whether the person holds a project grant that lets them use the project (`MEMBER#<person>` / `PROJECT#<name>`, role developer or administrator: the broker's own rule, FR-013.1). */
export function projectGrantFromDynamo(client: DynamoSender, tableName: string): (personId: string, project: string) => Promise<boolean> {
  return async (personId, project) => {
    if (typeof personId !== "string" || personId === "" || /[#\s]/u.test(personId) || typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(project)) return false;
    const response = await client.send(new GetCommand({ TableName: tableName, Key: { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}` }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    return row !== undefined && row["pk"] === `MEMBER#${personId}` && row["sk"] === `PROJECT#${project}` && row["projectName"] === project && mayUseProject(row["role"]);
  };
}

export const NOT_A_MEMBER_HERE = "You are not a member of this company.";
export const NO_PROJECT_GRANT = "You do not have access to this project.";

/**
 * Who may start work and act on a core task on a deployed install. Every answer re-reads the person's LIVE membership (never the principal's word): the person must be a member of the
 * principal's company now. A start needs the project grant the broker already keeps (no weakening of today's rule). A task may be read and driven only by its own person, as on the
 * broker today (a company role gives no reach into another person's task); anyone else gets "not found" from the flow. A step the system starts on its own needs its person to be a
 * member still, with the grant.
 */
export function hostedTaskAccess(inputs: { membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>; projectGrant: (personId: string, project: string) => Promise<boolean>; companyId: OrgId }): TaskAccess {
  const liveMember = async (personId: string) => {
    const membership = await inputs.membershipOf(personId);
    return membership !== undefined && membership.companyId === inputs.companyId ? membership : undefined;
  };
  return {
    async checkStart(principal, project) {
      if (principal.companyId !== inputs.companyId || (await liveMember(principal.personId)) === undefined) return { allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE };
      return (await inputs.projectGrant(principal.personId, project)) ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT };
    },
    async canAct(principal, task) {
      if (principal.companyId !== inputs.companyId) return false;
      if (principal.personId !== task.developerId) return false;
      return (await liveMember(principal.personId)) !== undefined;
    },
    async checkStep(task) {
      if ((await liveMember(task.developerId)) === undefined) return { allowed: false, message: NOT_A_MEMBER_HERE };
      return (await inputs.projectGrant(task.developerId, task.project)) ? { allowed: true } : { allowed: false, message: NO_PROJECT_GRANT };
    },
  };
}

// ---- the stream hook

/** The companies whose outbox a State table stream batch inserted rows into (an INSERT whose new image has `outboxState` and a company-scoped key). Others are not the core's. */
export function outboxCompaniesOf(event: unknown): string[] | undefined {
  const records = (event as { Records?: unknown } | null)?.Records;
  if (!Array.isArray(records) || records.length === 0 || !records.every((record) => (record as { eventSource?: unknown })?.eventSource === "aws:dynamodb")) return undefined;
  const companies = new Set<string>();
  for (const record of records as Array<{ eventName?: unknown; dynamodb?: { NewImage?: Record<string, { S?: unknown }> } }>) {
    if (record.eventName !== "INSERT") continue;
    const image = record.dynamodb?.NewImage;
    if (image?.["outboxState"] === undefined || typeof image["pk"]?.S !== "string") continue;
    const company = companyOfKey(image["pk"].S);
    if (company !== undefined) companies.add(company);
  }
  return [...companies];
}

// ---- the root

export function createBrokerCoreRoot(inputs: BrokerCoreRootInputs): BrokerCoreRoot {
  const { env, log } = inputs;
  const now = inputs.now ?? (() => new Date());
  const membershipOf = inputs.signInTableName === undefined || inputs.signInTableName === ""
    ? async () => undefined
    : membershipWithRoleFromDynamo(inputs.documentClient, inputs.signInTableName);
  const projectGrant = projectGrantFromDynamo(inputs.documentClient, inputs.stateTableName);
  const displayNameOf = async (personId: string): Promise<string | undefined> => {
    if (inputs.signInTableName === undefined || inputs.signInTableName === "" || /[#\s]/u.test(personId) || personId === "") return undefined;
    const response = await inputs.documentClient.send(new GetCommand({ TableName: inputs.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response?.Item;
    return row === undefined || row["revoked"] === true || typeof row["displayName"] !== "string" ? undefined : row["displayName"];
  };
  const identity: HostedIdentityOptions = { membershipOf, displayNameOf };
  const lessonsSwitch = readCoreLessonsSwitch(env);
  const lessonsByCompany = new Map<string, CoreLessons>();

  const app = createCoreHostApp({
    env,
    log,
    modules: () => [...codeAdapterModules(inputs.codeModules()), ...hostedSecurityModules({ env, identity }), ...(inputs.extraModules?.() ?? [])],
    context: () => ({ installCompanyId: IMPLICIT_COMPANY_ID, now, env, clients: {}, log }),
    ...(inputs.wrapStorage === undefined ? {} : { wrapStorage: inputs.wrapStorage }),
    beforeSeal: (registry) => {
      const settings = policyHookSettingsFromEnvironment(env);
      if (settings === undefined) return;
      applyPolicyHook(registry, settings, inputs.policyHookInstall?.(), { audit: registry.require("audit-sink"), now: () => now().getTime(), log });
    },
    runtime: (registry, companyId) => ({
      callbackSigningKey: inputs.callbackSigningKey,
      access: hostedTaskAccess({ membershipOf, projectGrant, companyId }),
      repositoryCredential: inputs.repositoryCredential,
      repositoryGrantKey: inputs.repositoryGrantKey,
      now,
      log,
      services: (flow) => {
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
          }
        }
        return { ...(inputs.services?.(companyId, flow, registry) ?? {}), ...(lessons === undefined ? {} : { lessons: lessons.service }) };
      },
    }),
  });
  if (lessonsSwitch.problem !== undefined) log({ event: "core_engine.lessons_switch_unreadable", problem: lessonsSwitch.problem });

  // Off: nothing below is built, and the developer routes never get a core entry.
  let coreTasks: CoreTaskEntry | undefined;
  if (app.serving) {
    // The library's install-wide learning gate follows the lessons switch.
    setCoreLessonsGate(env);
    const companyOf = async (caller: DeployedCaller): Promise<CompanyMembership | undefined> => membershipOf(caller.principal.personId);
    const routes = createCoreDevRoutes({
      app, companyOf, log,
      wiring: () => ({
        origin: inputs.origin,
        sessionCapSeconds: hostedSessionCapSeconds(),
        scriptTokens: {},
        canReadProject: (personId, project) => projectGrant(personId, project),
        auditFor: (caller, sink) => auditSinkForDeployedCaller(sink, { client: caller.client }),
        // Not wired yet (each answers "not on the core yet"): the session levels and the decision cards (lanes ID and T, #662), how we work (the company's code host).
      }),
    });
    const deployedCallerOf = async (caller: CoreEntryCaller): Promise<DeployedCaller | undefined> => {
      const membership = await membershipOf(caller.developerId);
      if (membership === undefined) return undefined;
      const principal: Principal = { companyId: membership.companyId, personId: caller.developerId, displayName: caller.name, roles: [membership.role], provider: HOSTED_IDENTITY_PROVIDER };
      return { principal, ...(caller.clientId === undefined ? {} : { client: caller.clientId }), ...(caller.stepUp === undefined ? {} : { stepUp: caller.stepUp }) };
    };
    coreTasks = coreTaskEntryFrom(routes, deployedCallerOf);
  }

  const table = { documentClient: inputs.documentClient, tableName: inputs.stateTableName };
  const companyOfWorkspace = workspaceCompanyReader(inputs.documentClient, inputs.stateTableName);
  const callbackHandlers = new Map<string, Promise<(request: BrokerRequest) => Promise<BrokerResponse>>>();
  const callbackHandlerFor = (companyId: OrgId): Promise<(request: BrokerRequest) => Promise<BrokerResponse>> => {
    let found = callbackHandlers.get(companyId);
    if (found === undefined) {
      found = (async () => {
        const runtime = await app.runtimeFor(companyId);
        const registry = await app.registry();
        const lessons = lessonsByCompany.get(companyId);
        return createCallbackService({
          flow: runtime.flow.deps,
          blobs: registry.require("object-storage"),
          // The grants the dispatcher issued for this company's workers (the same key derivation), exchanged here for a credential.
          grants: new RepositoryGrantService(inputs.repositoryGrantKey, inputs.repositoryCredential),
          ...(lessons === undefined ? {} : { onEvents: (operation, events) => lessons.host.onEvents(operation, events) }),
        });
      })();
      found.catch(() => callbackHandlers.delete(companyId));
      callbackHandlers.set(companyId, found);
    }
    return found;
  };

  return {
    app,
    coreTasks,
    async callback(request) {
      if (coreTasks === undefined) return undefined;
      const match = CORE_CALLBACK.exec(request.path.split("?")[0] ?? "");
      if (match === null || await ownerOfWorkspace(table, match[1]!) !== "core") return undefined;
      // A core workspace is never the old routes' (engine-boundary.ts): any refusal here is the core's, in fixed words.
      const companyId = await companyOfWorkspace(match[1]!);
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
      if (isCoreJobEvent(event)) return await app.handleScheduledJob(event, options);
      const companies = outboxCompaniesOf(event);
      if (companies !== undefined) return { relayed: await app.relayOutbox(companies) };
      return undefined;
    },
  };
}

/** What the broker's own adapter inputs still lack (each is an infrastructure or adapter lane), so the registry refuses by these words. Fixed. */
export const BROKER_CORE_NOT_CONFIGURED = "the broker cannot build the core engine's adapters yet: it needs the core dispatch queue's URLs in its environment, a code host provider for the core (the GitHub App behind the scoped provider interface) and its side of the workers' operations";

/**
 * Code's AWS adapter inputs on the broker. Not given yet (see BROKER_CORE_NOT_CONFIGURED): it refuses, so a serving switch never builds a half-wired registry here. The dispatcher's
 * inputs are complete (aws/worker-machines/dispatcher-core.ts); the broker's land with the infrastructure step that passes the queue URLs and the code host bridge.
 */
export function brokerCoreModuleDeps(env: NodeJS.ProcessEnv): CodeModuleDeps {
  void env;
  throw Object.assign(new Error(BROKER_CORE_NOT_CONFIGURED), { name: "BrokerCoreNotConfigured" });
}
