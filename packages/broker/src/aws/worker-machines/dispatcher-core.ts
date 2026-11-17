// Engine host (migration plan v3.2 lane E2, step 4): the dispatcher's half of the core engine.
//
// The dispatcher Lambda reads two queues: the spec 056 DispatchQueue (today's path, unchanged) and, in named environments, the core's dispatch queue through an event source mapping of its own
// that is ENABLED only while the switch is not off (infra/lib/core-engine.ts `connectDispatcher`). `withCoreDispatch` splits a batch by the queue each record came from:
//   - a record of the core queue never reaches today's dispatch code. While the switch serves (on, on:<ids>, drain) it goes to the core's dispatch host (core-dispatch-host.ts); while the
//     switch is off, or the host cannot be built, it is reported as a batch item failure, so it comes back and waits (never deleted, never today's path);
//   - every other record goes to today's handler exactly as before.
// Where the core queue is not configured (the legacy template: no CORE_DISPATCH_QUEUE_ARN), the router is not installed at all: the handler is today's handler, the same function.
//
// `createDispatcherCoreHost` builds the core on the dispatcher (the deployed composition root, core-host/app.ts) from the dispatcher's own clients, ONLY when the first core batch arrives
// while the switch serves: an off dispatcher builds nothing. What the dispatcher does not have is not faked; each refuses in fixed words:
//   - the people points: a dispatch decides nothing for a person, so the task access rule refuses every question (the dispatch consumer never asks it);
//   - a repository: the dispatcher holds no GitHub App, so its code host and check runner refuse every call, and its repository grants are issue-only (the broker exchanges them);
//   - secrets: the dispatcher reads none, so its secrets client refuses every call;
//   - the flow inputs every worker job carries (standing instructions, model route, lessons) must be declared by the deployment (`flow`), each as an input or an explicit none: until
//     then every company's runtime is refused (DISPATCHER_FLOW_NOT_DECLARED) and its records come back.
// A core workspace's worker is placed on the install's own workers (EC2_WORKER_SUBNETS, EC2_WORKER_LAUNCH_TEMPLATE_ID), never on a binding a company writes.
// The registry still needs the security-list points (admission, metering, identity, approvers, audit-sink) and model keys, which no Code module fills yet: until they land the registry
// refuses by name and every core record comes back (the intended fail-closed state; the named switch is wired through CORE_ENGINE_BROKER_WIRED).
import { createHmac } from "node:crypto";
import {
  CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE, CORE_DISPATCH_QUEUE_ARN_VARIABLE, CORE_DISPATCH_QUEUE_URL_VARIABLE, IMPLICIT_COMPANY_ID, agentXError, type AdapterRegistry, type DocumentStore, type OrgId,
} from "@agentx/contracts";
import type { TaskAccess } from "../../core/task-flow/deps.js";
import type { GitHubCodeHostProvider } from "../../plugins/code-host/github/index.js";
import type { GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import { createCoreHostApp, type CoreHostApp } from "../../core-host/app.js";
import { CORE_DISPATCH_QUEUE, codeAdapterModules, type CodeModuleDeps } from "../../core-host/code-modules.js";
import { coreEngineServes, readCoreEngineFlags, switchCovers } from "../../core-host/flags.js";
import { readCoreLessonsSwitch } from "../../core-host/lessons.js";
import type { CoreAdapterModule } from "../../core-host/registry.js";
import type { SessionManager } from "../sessions.js";
import { createCoreDispatchHost, type CoreDispatchHost, type CoreDispatchRecord } from "./core-dispatch-host.js";
import type { SessionWorkerMachinesDependencies } from "./session-worker-machines.js";
import { workspaceCompanyReader } from "./workspace-company.js";
import { workerBindingFromPairs } from "../worker-binding.js";
import type { RegistryTaskFlowOptions } from "../../core/task-flow/flow.js";
import type { MoneyStop } from "../../core/task-flow/money-stop.js";
import { gatewayModelAccessFromEnvironment, gatewayModelRoute } from "../../core-host/gateway-model-access.js";
import { companyEngineModelRoute } from "../../core-host/company-engine-model.js";
import { dispatcherStoredAgentModelChoice } from "../../core-host/stored-agent-model-choice.js";
import { createWikiForStep } from "../../core/wiki/agent-context.js";
import { createDispatcherLearned, type DispatcherLessonsOptions } from "./dispatcher-lessons.js";

/** A record of the dispatcher's SQS batch, as far as the router reads it. */
export interface DispatcherRecord extends CoreDispatchRecord {
  eventSourceARN?: string;
}

export interface DispatcherEvent<R extends DispatcherRecord = DispatcherRecord> {
  Records?: R[];
}

type BatchAnswer = { batchItemFailures: Array<{ itemIdentifier: string }> };
type DispatcherHandler<E, C> = (event: E, context?: C) => Promise<BatchAnswer>;

export interface CoreDispatchRouting {
  /** The core dispatch queue's ARN (CORE_DISPATCH_QUEUE_ARN). Absent or empty: no router, today's handler alone. */
  coreQueueArn: string | undefined;
  /** The switch, read per batch: true while it serves (on, on:<ids>, drain). */
  serves: () => boolean;
  /** The core's dispatch host, built on first use. A rejection leaves the batch's core records to come back. */
  host: () => Promise<CoreDispatchHost>;
  log?: (entry: Record<string, unknown>) => void;
}

/** Today's dispatcher handler with the core queue's records taken out and served by the core (see the file comment). */
export function withCoreDispatch<R extends DispatcherRecord, E extends DispatcherEvent<R>, C>(inner: DispatcherHandler<E, C>, routing: CoreDispatchRouting): DispatcherHandler<E, C> {
  const coreQueueArn = routing.coreQueueArn?.trim();
  if (coreQueueArn === undefined || coreQueueArn === "") return inner;
  const log = routing.log ?? ((entry: Record<string, unknown>) => { process.stderr.write(`${JSON.stringify({ component: "dispatcher", ...entry })}\n`); });
  return async (event, context) => {
    const records = event.Records ?? [];
    const core = records.filter((record) => record.eventSourceARN === coreQueueArn);
    if (core.length === 0) return await inner(event, context);
    const rest = records.filter((record) => record.eventSourceARN !== coreQueueArn);
    const failures: string[] = [];
    if (rest.length > 0) failures.push(...(await inner({ ...event, Records: rest }, context)).batchItemFailures.map((failure) => failure.itemIdentifier));
    // Never rejects: any fault leaves every core record to come back, and today's records keep the answer today's handler gave.
    failures.push(...(await serveCore(core, routing, log).catch(() => core.map((record) => record.messageId))));
    return { batchItemFailures: failures.map((itemIdentifier) => ({ itemIdentifier })) };
  };
}

/** The core queue's records: the ones the core did not acknowledge come back. */
async function serveCore(records: readonly DispatcherRecord[], routing: CoreDispatchRouting, log: (entry: Record<string, unknown>) => void): Promise<string[]> {
  const all = records.map((record) => record.messageId);
  if (!routing.serves()) {
    log({ event: "dispatch.core_off", records: records.length });
    return all;
  }
  let host: CoreDispatchHost;
  try {
    host = await routing.host();
  } catch (error) {
    // Fixed fields only: the error's name, never its message (it may name a resource or a value).
    log({ event: "dispatch.core_unavailable", error: error instanceof Error ? error.name : "unknown" });
    return all;
  }
  const taken = host.take(records);
  // A record on the core queue that is not the core's message is nobody's here: it comes back, and the queue's redrive policy sets it aside.
  const untaken = records.filter((record) => !taken.has(record.messageId)).map((record) => record.messageId);
  if (untaken.length > 0) log({ event: "dispatch.core_not_core_message", records: untaken.length });
  let handled: string[];
  try {
    handled = (await host.handle(records, taken)).failures;
  } catch (error) {
    log({ event: "dispatch.core_fault", error: error instanceof Error ? error.name : "unknown" });
    handled = [...taken];
  }
  return [...new Set([...untaken, ...handled])];
}

/** The words the dispatcher logs (as an error name) when it cannot serve the core: no core queue URLs, no State table, no callback signing key, no artifacts bucket or no worker placement. */
export const DISPATCHER_CORE_NOT_CONFIGURED = "the dispatcher cannot serve the core engine here: it needs the core dispatch queue's URLs, the State table, the callback signing key, the artifacts bucket and the workers' subnets and launch template";
/**
 * The flow inputs a worker's job is built from on the dispatcher (core/task-flow/dispatch.ts reads each, and treats an absent one as "none": no standing instructions, no model route, no
 * lessons). The dispatcher builds every worker job, so each must be DECLARED by the deployment, as the input or as `null` for an explicit "none": a root that forgot one would send jobs
 * without the company's rules, silently.
 */
export const DISPATCHER_FLOW_DECLARATIONS = ["standingInstructions", "modelAccess", "learned"] as const;
export type DispatcherFlowWiring = { [K in (typeof DISPATCHER_FLOW_DECLARATIONS)[number]]: RegistryTaskFlowOptions[K] | null };
/** The words a company's runtime on the dispatcher refuses with while a flow input is not declared. Fixed. */
export const DISPATCHER_FLOW_NOT_DECLARED = "the dispatcher's flow inputs are not declared (standing instructions, model route, lessons): no worker job is built without them";
/**
 * The flow inputs the deployment declares on the dispatcher: no standing instructions (no company rules seam on AWS yet), the model gateway route where it is configured, and lessons
 * only through the reader L6 supplies (createDispatcherLearned) for this company's runtime while ROVARA_CORE_LESSONS covers it; a missing reader still refuses declaration.
 */
export function hostedDispatcherFlow(env: NodeJS.ProcessEnv, learned?: RegistryTaskFlowOptions["learned"] | Omit<DispatcherLessonsOptions, "lessonsSwitch">): DispatcherFlowWiring | undefined {
  // L2b (DEC 236): where the model gateway is configured, every core step goes to the gateway's agent model with a task token (the model-access capability).
  // A broken gateway setting declares nothing (every core record comes back) rather than a job without its model.
  let gateway: ReturnType<typeof gatewayModelAccessFromEnvironment>;
  try { gateway = gatewayModelAccessFromEnvironment(env); } catch { return undefined; }
  const modelAccess = gateway === undefined ? null : gatewayModelRoute(gateway);
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  if (lessonsSwitch.mode !== "off") {
    const options = typeof learned === "object" && learned !== null && "companyId" in learned ? learned : undefined;
    // A narrowed lessons switch must not attach a reader to another company's runtime.
    if (options !== undefined && !switchCovers(lessonsSwitch, options.companyId)) return { standingInstructions: null, modelAccess, learned: null };
    const reader = options === undefined ? learned : createDispatcherLearned({ ...options, lessonsSwitch });
    return typeof reader !== "function" ? undefined : { standingInstructions: null, modelAccess, learned: reader };
  }
  return { standingInstructions: null, modelAccess, learned: null };
}

/** The words a code host call says on the dispatcher. */
export const NO_CODE_HOST_HERE = "the code host is not reached from the dispatcher";
/** The words a repository credential exchange says on the dispatcher. */
export const NO_REPOSITORY_CREDENTIALS_HERE = "repository credentials are exchanged by the broker, not on the dispatcher";
/** The words a secret read says on the dispatcher. */
export const NO_SECRETS_HERE = "secrets are not read on the dispatcher";
/** The words the access rule says on the dispatcher. */
export const NO_PEOPLE_HERE = "people are decided by the broker, not on the dispatcher";
/** The credential reference of the dispatcher's refusing code host (it resolves nothing). */
const NO_CREDENTIAL_REF = "none-on-dispatcher";

/** The repository grant key a callback signing key gives (the broker's own derivation in aws/broker.ts): a grant the dispatcher issues is one the broker's exchange verifies. */
export function repositoryGrantKeyOf(callbackSigningKey: string): Buffer {
  return createHmac("sha256", callbackSigningKey).update("agentx:repository-grants:v3").digest();
}

/** A code host (and GitHub Actions) provider that refuses every call in fixed words: the dispatcher holds no GitHub App and reads no repository. */
export function refusingCodeHost(): GitHubCodeHostProvider & GitHubActionsProvider {
  return new Proxy({} as GitHubCodeHostProvider & GitHubActionsProvider, {
    get: (_target, key) => (key === "then" ? undefined : async () => { throw agentXError("RUNTIME_UNAVAILABLE", NO_CODE_HOST_HERE); }),
  });
}

/** The access rule on the dispatcher: nobody is decided for here. */
export function refusingTaskAccess(): TaskAccess {
  return {
    async checkStart() { return { allowed: false, code: "RUNTIME_UNAVAILABLE", message: NO_PEOPLE_HERE }; },
    async canAct() { return false; },
    async checkStep() { return { allowed: false, message: NO_PEOPLE_HERE }; },
  };
}

/**
 * What the dispatcher may do with a workspace's EC2 machine: start the provisioner, start the deleter, sign with the invoke key, and post to and ping a worker. Ending an instance at once is
 * not among them (no ec2:TerminateInstances on the dispatcher): a claimed STOPPING session is ended by the idle reaper's next tick, so `stopInstance` answers `gone: false`
 * (`dispatcherStopInstance`). The dispatch consumer never stops a machine; only a cancel does, on the broker.
 */
export interface DispatcherMachineOps {
  sessions: Pick<SessionManager, "get" | "ensureSession" | "deleteSession" | "claimStop" | "markStopped">;
  stopInstance: SessionWorkerMachinesDependencies["stopInstance"];
  sign: SessionWorkerMachinesDependencies["sign"];
  post: SessionWorkerMachinesDependencies["post"];
  ping: SessionWorkerMachinesDependencies["ping"];
}

export interface DispatcherCoreInputs {
  env: NodeJS.ProcessEnv;
  /** The State table, as the dispatcher's document client reads it (whose a workspace is, its binding). */
  documentClient: Parameters<typeof workspaceCompanyReader>[0];
  /** The AWS clients the core's adapters speak (made by the dispatcher only when the core is first needed). */
  clients: { dynamo: NonNullable<CodeModuleDeps["dynamo"]>; sqs: NonNullable<CodeModuleDeps["queue"]["client"]> & { send(command: unknown): Promise<unknown> }; s3: CodeModuleDeps["objects"]["client"] };
  machines: DispatcherMachineOps;
  /** SQS ChangeMessageVisibility on the core dispatch queue. */
  changeVisibility: (receiptHandle: string, seconds: number) => Promise<void>;
  /** The flow inputs every worker job carries, each declared (see DISPATCHER_FLOW_DECLARATIONS). Absent, or any key missing: every company's runtime is refused and its records come back. */
  flow?: DispatcherFlowWiring | ((registry: AdapterRegistry, companyId: OrgId) => DispatcherFlowWiring | undefined);
  /** The points Code's AWS modules do not fill (admission, metering, identity, approvers, audit-sink, model keys: lane E2 step 5), added after them. Absent: the registry refuses by name. */
  extraModules?: readonly CoreAdapterModule[];
  /** Wraps the registry's store (the deployment's retention rule, core-host/retention.ts, is applied by the storage module itself). */
  wrapStorage?: (store: DocumentStore) => DocumentStore;
  /**
   * The per-run dollar stop's dispatch side (core/task-flow/money-stop.ts): each model run is admitted (`run.start`) before it is handed over, goes only to a worker that reports its usage
   * while it runs, and is told to. Built over the registry's store. Absent: dispatch as before.
   */
  moneyStop?: (registry: AdapterRegistry, companyId: OrgId) => MoneyStop;
  log: (entry: Record<string, unknown>) => void;
  now?: () => Date;
}

const required = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);

/** The core on the dispatcher (the deployed root) and the dispatch host over it. Throws `DISPATCHER_CORE_NOT_CONFIGURED` (as the error) when the function lacks what the core needs. */
export function createDispatcherCoreHost(inputs: DispatcherCoreInputs): { app: CoreHostApp; host: CoreDispatchHost } {
  const { env } = inputs;
  const queueUrl = required(env[CORE_DISPATCH_QUEUE_URL_VARIABLE]);
  const deadLetterUrl = required(env[CORE_DISPATCH_DEAD_LETTER_URL_VARIABLE]);
  const tableName = required(env.STATE_TABLE_NAME);
  const callbackSigningKey = required(env.CALLBACK_SIGNING_KEY);
  const bucket = required(env.ARTIFACT_BUCKET_NAME);
  const subnets = required(env.EC2_WORKER_SUBNETS);
  const launchTemplateId = required(env.EC2_WORKER_LAUNCH_TEMPLATE_ID);
  if (queueUrl === undefined || deadLetterUrl === undefined || tableName === undefined || callbackSigningKey === undefined || bucket === undefined || subnets === undefined || launchTemplateId === undefined) {
    throw Object.assign(new Error(DISPATCHER_CORE_NOT_CONFIGURED), { name: "DispatcherCoreNotConfigured" });
  }
  const now = inputs.now ?? (() => new Date());
  // Where a core workspace's worker runs: the install's own workers (the foundation's subnets and launch template, as the broker places a sign-in client's project, spec 065b), never a
  // binding a company could write. Built once; a malformed value refuses here, before anything runs.
  let placement: ReturnType<typeof workerBindingFromPairs>;
  try {
    placement = workerBindingFromPairs(subnets, launchTemplateId);
  } catch {
    throw Object.assign(new Error(DISPATCHER_CORE_NOT_CONFIGURED), { name: "DispatcherCoreNotConfigured" });
  }
  const companyOfWorkspace = workspaceCompanyReader(inputs.documentClient, tableName);
  const refusing = refusingCodeHost();
  const deps: CodeModuleDeps = {
    tableName, dynamo: inputs.clients.dynamo, ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
    queue: { settings: { ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }), queues: { [CORE_DISPATCH_QUEUE]: { url: queueUrl, deadLetterUrl } } }, client: inputs.clients.sqs },
    objects: { client: inputs.clients.s3, bucket },
    secrets: { namePrefix: "", clientFor: () => ({ send: async () => { throw agentXError("RUNTIME_UNAVAILABLE", NO_SECRETS_HERE); } }) },
    codeHost: { provider: refusing, options: { credentialRef: NO_CREDENTIAL_REF } },
    checkRunner: { githubActions: refusing },
    workerMachines: {
      // The adapter asks for a binding only for a workspace of the company it is bound to (it checks the record first).
      sessions: inputs.machines.sessions, companyOfWorkspace, binding: async () => placement,
      stopInstance: inputs.machines.stopInstance, sign: inputs.machines.sign, post: inputs.machines.post, ping: inputs.machines.ping, now: () => now().getTime(),
    },
  };
  const grantKey = repositoryGrantKeyOf(callbackSigningKey);
  const app = createCoreHostApp({
    env,
    modules: () => [...codeAdapterModules(deps), ...(inputs.extraModules ?? [])],
    context: () => ({ installCompanyId: IMPLICIT_COMPANY_ID, now, env, clients: {}, log: inputs.log }),
    log: inputs.log,
    // The dispatcher runs no scheduled job and relays no outbox (the broker does): its runtimes are built for the dispatch consumer alone.
    dispatchOnly: true,
    ...(inputs.wrapStorage === undefined ? {} : { wrapStorage: inputs.wrapStorage }),
    runtime: (registry, companyId) => {
      const flow = typeof inputs.flow === "function" ? inputs.flow(registry, companyId) : inputs.flow;
      // Declared means present AND `null` (an explicit none) or a value: a key that is there with `undefined` in it is not a declaration.
      if (flow === undefined || flow === null || DISPATCHER_FLOW_DECLARATIONS.some((name) => !Object.hasOwn(flow, name) || flow[name] === undefined)) throw Object.assign(new Error(DISPATCHER_FLOW_NOT_DECLARED), { name: "DispatcherFlowNotDeclared" });
      const { standingInstructions, learned } = flow;
      // DEC 254n (1): each step's route is the company's own engine model when it set one, else the install's (the same answer as before); an unreadable setting dispatches nothing.
      const modelAccess = flow.modelAccess === null || flow.modelAccess === undefined ? flow.modelAccess : companyEngineModelRoute({ store: registry.require("storage"), companyId, install: flow.modelAccess });
      const flowOptions: Partial<RegistryTaskFlowOptions> = {
        ...(standingInstructions === null || standingInstructions === undefined ? {} : { standingInstructions }),
        ...(modelAccess === null || modelAccess === undefined ? {} : { modelAccess }),
        // The broker's switch controls whether it writes fresh validation rows. The dispatcher always uses a fresh row when present and otherwise its configured default.
        stepModels: dispatcherStoredAgentModelChoice({ store: registry.require("storage"), companyId, now: () => now().getTime(), defaultRoute: async () => modelAccess?.route(), log: inputs.log }),
        ...(learned === null || learned === undefined ? {} : { learned }),
        // Lead 4 A1: the project wiki, for this company only (its own store, its own id); it gives nothing unless the project's "Give the wiki to agents" switch is on.
        wiki: createWikiForStep({ store: registry.require("storage"), companyId, now: () => now().getTime() }),
        ...(inputs.moneyStop === undefined ? {} : { moneyStop: inputs.moneyStop(registry, companyId) }),
      };
      return {
      callbackSigningKey,
      flowOptions,
      access: refusingTaskAccess(),
      repositoryCredential: async () => { throw agentXError("RUNTIME_UNAVAILABLE", NO_REPOSITORY_CREDENTIALS_HERE); },
      repositoryGrantKey: grantKey,
      now,
      log: inputs.log,
      };
    },
  });
  const host = createCoreDispatchHost({
    // Read per batch: `on` and `drain` take the core's records (a draining core still dispatches its running tasks' steps); `off` takes nothing.
    enabled: () => coreEngineServes(readCoreEngineFlags(env)),
    companyOfWorkspace,
    depsFor: async (companyId: OrgId, queues) => ({ ...(await app.runtimeFor(companyId)).flow.deps, queues }),
    dispatchQueue: CORE_DISPATCH_QUEUE,
    changeVisibility: inputs.changeVisibility,
    log: inputs.log,
  });
  return { app, host };
}

/** The dispatcher's `stopInstance`: it holds no ec2:TerminateInstances, so the session it claimed STOPPING is finished by the idle reaper. */
export const dispatcherStopInstance: SessionWorkerMachinesDependencies["stopInstance"] = async () => ({ gone: false });

/** The core queue's ARN from the dispatcher's environment (absent in the legacy template). */
export function coreDispatchQueueArn(env: NodeJS.ProcessEnv): string | undefined {
  return required(env[CORE_DISPATCH_QUEUE_ARN_VARIABLE]);
}
