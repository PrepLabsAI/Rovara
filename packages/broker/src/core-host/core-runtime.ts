// Engine host (lane E2): the core, built for one company over the sealed registry of a deployed install.
//
// The task flow comes straight from the core (`createTaskFlowFromRegistry`): start, the stage machine, dispatch, the recovery sweep and the outbox relay. Its build steps are the core's default
// (`createBuildSteps`, set by `createTaskFlow`). Every core task gets its engine stamp in the start's own transaction.
//
// The other core services (merge tracking, the session sweep, notices) are joined on a laptop by the local root (`local/app/app.ts`), which carries laptop rules (fixed code settings, a sole
// owner). A deployed install needs the same joins with its own settings and people; each is a `CoreService` the deployment supplies, and `serviceGaps` names the ones missing so the switch cannot
// be turned on for an area whose service is not wired (an area that is off is not asked: its missing service costs only its own jobs).
import { AsyncLocalStorage } from "node:async_hooks";
import { agentXError, type AdapterRegistry, type OrgId, type TransactItem } from "@agentx/contracts";
import { RepositoryGrantService } from "../repository-access.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { createTaskFlowFromRegistry, type RegistryTaskFlowOptions, type TaskFlow } from "../core/task-flow/flow.js";
import type { StartExtras, StartExtrasInput, TaskAccess } from "../core/task-flow/deps.js";
import { withStepFenceRetry } from "./step-fence.js";
import { engineForNewTask, ensureCoreInUse, stampForNewTask, stampItem } from "./engine-stamp.js";
import type { CoreArea, CoreEngineFlags } from "./flags.js";

/** A core service a scheduled job runs, per company. */
export interface CoreService {
  /** One pass (a sweep); returns a small report for the log. */
  pass(options: { budgetMs: number }): Promise<Record<string, unknown>>;
}

/** The required services beyond the task flow, by name, and the area each belongs to. */
export const CORE_SERVICES = {
  "merge-tracking": "merge",
  "session-sweep": "flow",
  "notify-deliver": "flow",
  "admission-hold-sweep": "flow",
} as const satisfies Record<string, CoreArea>;
/** The required services (above) and the optional ones: a runtime without an optional one skips its job (`service_not_wired`), and the switch is never refused for it. */
export type CoreServiceName = keyof typeof CORE_SERVICES | "automation-stop";

export interface CoreRuntime {
  companyId: OrgId;
  flow: TaskFlow;
  services: Partial<Record<CoreServiceName, CoreService>>;
}

export interface CoreRuntimeOptions {
  registry: AdapterRegistry;
  companyId: OrgId;
  flags: CoreEngineFlags;
  callbackSigningKey: string | Buffer;
  /** Who may start work and act on a task. Required: a deployed install never falls back to the laptop's sole-owner rule. */
  access: TaskAccess;
  /** Issues a worker's repository grant (the GitHub App credential provider). */
  repositoryCredential: ConstructorParameters<typeof RepositoryGrantService>[1];
  repositoryGrantKey: Buffer;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
  /** Extra flow options (limits, prompts, the design review, ...): whatever the deployment wires. */
  flowOptions?: Partial<RegistryTaskFlowOptions>;
  /** The services beyond the flow, built for this company. */
  services?: (flow: TaskFlow) => Partial<Record<CoreServiceName, CoreService>>;
}

const startFences = new AsyncLocalStorage<readonly TransactItem[]>();

/**
 * Runs a core start (and anything it awaits) with these checks added to the start's own transaction (`startExtras`): what the host read about the company before it started the task. A start
 * that finds one changed commits nothing. The context belongs to this call and its awaits, so concurrent starts never see each other's.
 */
export function withStartFence<T>(items: readonly TransactItem[], run: () => Promise<T>): Promise<T> {
  return startFences.run(items, run);
}

/** What a start on a runtime that serves a company only for the tasks it already holds (drain, or a narrowed switch) answers. Fixed words. */
export const CORE_START_REFUSED_WORDS = "the core engine starts no new task for this company";

export function createCoreRuntime(options: CoreRuntimeOptions): CoreRuntime {
  const { registry, companyId } = options;
  // Checked at run time, not only by the type: the core's own default is the laptop's sole-owner rule, which a deployed install must never get by omission.
  if ((options as { access?: unknown }).access === undefined) throw new Error("the core runtime needs an access rule");
  const store = registry.require("storage");
  const given = options.flowOptions?.startExtras;
  // Every core start writes the engine stamp with the task (a task keeps its engine). Joined with any start extras the deployment gives. A start the switch does not send to the core
  // (drain, or a company served only for the tasks it holds) is refused here too, so its transaction never commits: no task can exist on the core with a workflow stamp.
  const startExtras = (input: StartExtrasInput): StartExtras => {
    const stamped = stampForNewTask(options.flags, companyId, options.now());
    if (stamped.engine !== "core") throw agentXError("RUNTIME_UNAVAILABLE", CORE_START_REFUSED_WORDS);
    const own = given?.(input);
    return { ...(own ?? {}), items: [...(own?.items ?? []), ...(startFences.getStore() ?? []), stampItem(companyId, input.taskId, stamped)] };
  };
  const base = createTaskFlowFromRegistry(withStepFenceRetry(registry), {
    ...options.flowOptions,
    companyId,
    projects: options.flowOptions?.projects ?? createStoreProjectSource(store, companyId),
    access: options.access,
    repositoryGrants: options.flowOptions?.repositoryGrants ?? new RepositoryGrantService(options.repositoryGrantKey, options.repositoryCredential),
    callbackSigningKey: options.callbackSigningKey,
    now: options.now,
    log: options.log,
    startExtras,
  });
  // The company's in-use mark is written before its first core start (off the start's transaction), so the root's jobs always find every company that holds core tasks.
  const flow: TaskFlow = {
    ...base,
    async start(caller, request) {
      if (engineForNewTask(options.flags, companyId) !== "core") throw agentXError("RUNTIME_UNAVAILABLE", CORE_START_REFUSED_WORDS);
      await ensureCoreInUse(store, companyId);
      return await base.start(caller, request);
    },
  };
  return { companyId, flow, services: options.services?.(flow) ?? {} };
}

/** The services an area needs that this runtime lacks. */
export function serviceGaps(services: Partial<Record<CoreServiceName, CoreService>>, areas: readonly CoreArea[]): CoreServiceName[] {
  return (Object.entries(CORE_SERVICES) as [CoreServiceName, CoreArea][]).filter(([name, area]) => areas.includes(area) && services[name] === undefined).map(([name]) => name);
}
