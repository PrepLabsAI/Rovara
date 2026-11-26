// Engine host (lane E2): the core, built for one company over the sealed registry of a deployed install.
//
// The task flow comes straight from the core (`createTaskFlowFromRegistry`): start, the stage machine, dispatch, the recovery sweep and the outbox relay. Its build steps are the core's default
// (`createBuildSteps`, set by `createTaskFlow`). Every core task gets its core mark in the start's own transaction (core-task-mark.ts).
//
// The other core services (merge tracking, the session sweep, notices) are joined on a laptop by the local root (`local/app/app.ts`), which carries laptop rules (fixed code settings, a sole
// owner). A deployed install needs the same joins with its own settings and people; each is a `CoreService` the deployment supplies, and `coreWiringGaps` (core-wiring-guard.ts) names the required
// ones that are missing so a runtime is never handed out half wired.
import type { AdapterRegistry, DocumentStore, OrgId } from "@agentx/contracts";
import { RepositoryGrantService } from "../repository-access.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { createTaskFlowFromRegistry, type RegistryTaskFlowOptions, type TaskFlow } from "../core/task-flow/flow.js";
import type { StartExtras, StartExtrasInput, TaskAccess } from "../core/task-flow/deps.js";
import { withStepFenceRetry } from "./step-fence.js";
import { startFenceItems } from "../core/task-flow/start-fence.js";
import { reportStartItems } from "../core/report/task-row.js";
import { coreTaskMarkFor, coreTaskMarkItem, ensureCoreInUse } from "./core-task-mark.js";
import type { HumanEditSink } from "../core/merge/seams.js";
import { CI_MODE_UNREADABLE_WORDS, checkedCiReporting, type CheckedCiReporting, type CiReporting } from "./core-wiring-guard.js"; import type { REQUIRED_CORE_SERVICES } from "./core-wiring-guard.js"; import type { AttentionDeliveryDependencies } from "../core/notify/attention.js"; import type { SessionChange } from "../core/sessions/summary.js";

/** A core service a scheduled job runs, per company. */
export interface CoreService {
  /** One pass (a sweep); returns a small report for the log. */
  pass(options: { budgetMs: number }): Promise<Record<string, unknown>>;
}

/** The required services (`REQUIRED_CORE_SERVICES`, core-wiring-guard.ts) and the optional ones: a runtime without an optional one skips its job (`service_not_wired`), and is never refused for it. */
export type CoreServiceName = (typeof REQUIRED_CORE_SERVICES)[number] | "automation-stop" | "lessons" | "person-erase-resume" | "after-merge" | "upkeep";

export interface CoreRuntime {
  companyId: OrgId;
  flow: TaskFlow;
  services: Partial<Record<CoreServiceName, CoreService>>;
  /** The deployment's CI reporting, validated (core-wiring-guard.ts). Undefined when none, or an invalid one, was given: the root then refuses the runtime (`honest-ci`). */
  ciReporting?: CheckedCiReporting | undefined;
}

/** What the services builder is handed besides the flow: the validated CI mode reader, so merge tracking reads the same mode the task readers do. Undefined when not wired. */
export interface CoreServiceWiring {
  ciMode?: CheckedCiReporting["ciMode"] | undefined; /** The attention email's own seams (hosted core, switch on): the person's address and per-person links. Absent: as before. */ notification?: (Partial<Pick<AttentionDeliveryDependencies, "address" | "emailLinks" | "registry" | "companyOf" | "link" | "thread" | "planCarded" | "setupPausedTold" | "doneToldInThread">> & { remember?: (change: SessionChange) => Promise<void> }) | undefined;
  /** L4-P2: the notice service's live "does this person still administer the project" read for the admins' upkeep notice (`createUpkeepAdministers`). Absent: no upkeep row is delivered. */
  upkeep?: {
    administers(orgId: OrgId, developerId: string, project: string): Promise<boolean>;
    /** L4-U5: the project's open repair card now, for the admins' "Setup needs repair" notice (dropped when the setup is no longer broken). Absent: no setup row is delivered. */
    setupRead?(orgId: OrgId, project: string): Promise<{ key: string; failedStep: string; fixReady: boolean } | undefined>;
    /** HW5: the project's page address (a plain https link) for the admins' "Setup needs repair" notice. Absent: the notice has no link. */
    setupLink?(project: string): string | undefined;
  } | undefined;
  /** L4-LM1c: the company's lessons' notice of a person's push to a Rovara pull request, for merge tracking to tell. Undefined when lessons are not built for the company. */
  humanEdit?: HumanEditSink | undefined;
  /** HW5: write the chat thread's moments (the plan waits for review, the task was closed) when a session that follows a thread changes. Needs the company's milestones; absent: none are written. */
  threadMoments?: boolean | undefined;
  /** R1 + L1 6.2: write a ticket's own plan-ready and closed moments (the ticket write-back is wired for the company). Needs the company's milestones; absent: none are written. */
  ticketMoments?: boolean | undefined;
  threadRefresh?: ((orgId: OrgId, sessionId: string, store: DocumentStore) => Promise<void>) | undefined;
}

export interface CoreRuntimeOptions {
  registry: AdapterRegistry;
  companyId: OrgId;
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
  /** The services beyond the flow, built for this company. Merge tracking takes its CI mode from `wiring.ciMode`, never a default. */
  services?: (flow: TaskFlow, wiring: CoreServiceWiring) => Partial<Record<CoreServiceName, CoreService>>;
  /** The project's own CI mode reader (wiring check `honest-ci`). Required; checked at run time. */
  ciReporting?: CiReporting;
}

/**
 * Runs a core start (and anything it awaits) with these checks added to the start's own transaction (`startExtras`): what the host read about the company before it started the task. A start
 * that finds one changed commits nothing. The context belongs to this call and its awaits, so concurrent starts never see each other's. (The shared fence of core/task-flow/start-fence.ts.)
 */
export { withStartFence } from "../core/task-flow/start-fence.js";

/** A `worker-machines` adapter that serves every company only through a per-company adapter (aws/worker-machines/session-worker-machines.ts `SessionWorkerFleet`). */
interface CompanyBoundMachines {
  forCompany(companyId: string): unknown;
}

const bindsCompanies = (value: unknown): value is CompanyBoundMachines => typeof value === "object" && value !== null && typeof (value as { forCompany?: unknown }).forCompany === "function";

/**
 * The registry as one company's runtime sees it: a `worker-machines` adapter that serves companies only through `forCompany` is handed out bound to this company, so every machine call
 * of this runtime is held to this company's workspaces. Any other adapter (the laptop's, which reads the company from each spec) and every other point is the registry's own.
 */
export function withCompanyMachines<R extends { require(point: never, name?: never): unknown }>(registry: R, companyId: OrgId): R {
  return new Proxy(registry, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "require" || property === "get") return (point: string, name?: string) => {
        const found = (value as (point: string, name?: string) => unknown).call(target, point, name);
        return point === "worker-machines" && bindsCompanies(found) ? found.forCompany(companyId) : found;
      };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function createCoreRuntime(options: CoreRuntimeOptions): CoreRuntime {
  const { registry, companyId } = options;
  // Checked at run time, not only by the type: the core's own default is the laptop's sole-owner rule, which a deployed install must never get by omission.
  if ((options as { access?: unknown }).access == null) throw new Error("the core runtime needs an access rule");
  const store = registry.require("storage");
  const given = options.flowOptions?.startExtras;
  // Every core start writes the core mark with the task (the mark is how a task is told to be the core's). Joined with any start extras the deployment gives.
  const startExtras = (input: StartExtrasInput): StartExtras => {
    const marked = coreTaskMarkFor(options.now());
    const own = given?.(input);
    // The cost report's row for this task (lead 4, A2), in the start's own transaction: the task and its row exist together or not at all. It never throws.
    const reported = reportStartItems({ companyId, taskId: input.taskId, project: input.project, title: input.title, origin: input.origin, purpose: input.purpose, ticket: input.ticket, receivedAt: input.receivedAt });
    return { ...(own ?? {}), items: [...(own?.items ?? []), ...startFenceItems(input), coreTaskMarkItem(companyId, input.taskId, marked), ...reported] };
  };
  const flow: TaskFlow = createTaskFlowFromRegistry(withStepFenceRetry(withCompanyMachines(registry, companyId)), {
    ...options.flowOptions,
    companyId,
    projects: options.flowOptions?.projects ?? createStoreProjectSource(store, companyId),
    access: options.access,
    repositoryGrants: options.flowOptions?.repositoryGrants ?? new RepositoryGrantService(options.repositoryGrantKey, options.repositoryCredential),
    callbackSigningKey: options.callbackSigningKey,
    now: options.now,
    log: options.log,
    startExtras,
    // Shared by flow.start and hosted setup/wiki starts over flow.deps. The
    // signed-price check must finish before even the company's in-use write.
    startModelCheck: async () => {
      const refusal = await options.flowOptions?.startModelCheck?.();
      if (refusal !== undefined) return refusal;
      await ensureCoreInUse(store, companyId);
      return undefined;
    },
    // The work events of the cost report's wait split and send-backs (slice A4, `core/work-events/flow-events.ts`): on for every core runtime unless the deployment turns them off.
    workEvents: options.flowOptions?.workEvents !== false,
  });
  // The start's model check writes the in-use mark before its transaction, so
  // the root's jobs find every company that holds core tasks.
  // Validated here, refused by the root (`coreWiringGaps`): an invalid wiring is the same as none, so the runtime is refused by id rather than failing here with the given value.
  const ciReporting = checkedCiReporting((options as { ciReporting?: unknown }).ciReporting);
  // An invalid wiring never reaches the services as "no reader" (which merge tracking would read as its default mode): they get a reader that always refuses.
  const services = options.services?.(flow, { ciMode: ciReporting?.ciMode ?? refusingCiMode }) ?? {};
  return { companyId, flow, services, ...(ciReporting === undefined ? {} : { ciReporting }) };
}

/** The CI mode reader a runtime without a valid `ciReporting` hands its services: every read is refused with the fixed words, never the default mode. */
const refusingCiMode = (): Promise<never> => Promise.reject(new Error(CI_MODE_UNREADABLE_WORDS));
