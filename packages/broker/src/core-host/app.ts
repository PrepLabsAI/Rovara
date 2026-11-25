// Engine host (migration plan v3.2 lane E2): the composition root of the core on a deployed install (`core-host/`, the counterpart of the laptop's `local/app/`).
//
// One object per function container. It builds the registry (once) and a core runtime per company (once), when first asked. Every new task starts on the core (#1275: there is no switch).
//
// Entry points:
//   - `engineForNewTask(company)`: where a new task starts (always `core`). The start route asks this; `core` sends the start to the company's runtime.
//   - Whether an EXISTING task is the core's is its mark (aws/engine-boundary.ts `isCoreTask`), not asked of this object (D1-2c).
//   - `handleScheduledJob(event)`: a schedule's event (`agentx.core-job`) runs one row of the jobs table, per company, isolated.
//   - `relayOutbox(companies)`: the stream reader's hook on outbox inserts.
import type { AdapterRegistry, DocumentStore, OrgId } from "@agentx/contracts";
import { createCoreRuntime, serviceGaps, type CoreRuntime, type CoreRuntimeOptions } from "./core-runtime.js";
import { engineForNewTask, listCoreInUse, type Engine } from "./engine-stamp.js";
import { CORE_AREAS, CORE_ENGINE_ON, coreAreaOn, type CoreArea, type CoreEngineFlags, type CoreSwitch } from "./flags.js";
import { CORE_JOBS, isCoreJobEvent, runPerCompany, type CompanyRunReport, type CoreJob } from "./jobs.js";
import { buildCoreRegistry, type CoreAdapterContext, type CoreAdapterModule } from "./registry.js";
import { CoreSwitchBlockedError, switchBlockers } from "./switch-blockers.js";

export interface CoreHostAppOptions {
  /** The adapters (the deployment's modules in production; fakes in tests). A function is called when the registry is first built, so a deployment's inputs are asked for only then. */
  modules: readonly CoreAdapterModule[] | (() => readonly CoreAdapterModule[]);
  /** The companies that hold core tasks. The jobs run for these as well as the install's own company. Default: every company with an in-use mark in the registry's store. */
  servedCompanies?: () => Promise<readonly string[]>;
  /** Builds the adapter context (clients) on first use. */
  context: () => CoreAdapterContext;
  /** The per-company runtime's own wiring (signing key, access, credentials, services). */
  runtime: (registry: AdapterRegistry, companyId: OrgId, flags: CoreEngineFlags) => Omit<CoreRuntimeOptions, "registry" | "companyId" | "flags">;
  /** Wraps the registry's store (a deployment's retention rule). */
  wrapStorage?: (store: DocumentStore) => DocumentStore;
  /** Called on the complete registry just before its seal (the deployment's policy hook). */
  beforeSeal?: (registry: AdapterRegistry) => void;
  /**
   * Other switches (the lessons switch, the system-runs flag) whose NAMED companies (`on:<id>[:<id>]`) the scheduled jobs run for too (B5). The jobs otherwise list only the install's
   * own company and the companies holding an in-use mark, and the mark is written at a company's first core task: a company a flag names has work waiting before that (the lessons pass, the upkeep night, notice delivery,
   * the sweeps of its first task). A flag that says `on` (every company) or `off` names nobody and adds nothing. Default: none.
   */
  alsoNamedBy?: readonly CoreSwitch[];
  /** The jobs this root runs. Default: CORE_JOBS. */
  jobs?: readonly CoreJob[];
  /** The time budget of one scheduled run. Default 50 s. Never more than the function's own time left (`handleScheduledJob`'s `remainingMs`) less `JOB_EXIT_MARGIN_MS`. */
  jobBudgetMs?: number;
  nowMs?: () => number;
  /**
   * A root that only dispatches (the dispatcher Lambda, aws/worker-machines/dispatcher-core.ts): it runs no scheduled job and relays no outbox, so a company's runtime is not refused for
   * the job services it lacks (those run on the broker), and `handleScheduledJob` / `relayOutbox` do nothing here. Default false.
   */
  dispatchOnly?: boolean;
}

export interface CoreHostApp {
  readonly flags: CoreEngineFlags;
  engineForNewTask(companyId: string): Engine;
  /** The sealed registry (built once). */
  registry(): Promise<AdapterRegistry>;
  /** The core for one company (built once). */
  runtimeFor(companyId: string): Promise<CoreRuntime>;
  /** A schedule's event: `undefined` when it is not a core job's. `remainingMs`: the function's time left, which caps the budget. */
  handleScheduledJob(event: unknown, options?: { remainingMs?: number | undefined }): Promise<undefined | { skipped: "unknown_job" | "dispatch_only" } | { job: string; companies: CompanyRunReport[] }>;
  /** The stream reader's hook: relay the outbox of these companies. */
  relayOutbox(companies: readonly string[]): Promise<CompanyRunReport[]>;
}

/** What a scheduled run leaves of its function's time for the run's own end (logging, the answer): its budget is the time left less this. */
export const JOB_EXIT_MARGIN_MS = 20_000;

/** Fixed refusal: a dispatch-only root cannot run merge tracking without the merge switch blockers. */
export const DISPATCH_ONLY_MERGE_TRACKING_REFUSED = "the dispatch-only core runtime cannot include merge tracking";

export class DispatchOnlyMergeTrackingError extends Error {
  constructor() {
    super(DISPATCH_ONLY_MERGE_TRACKING_REFUSED);
    this.name = "DispatchOnlyMergeTrackingError";
  }
}

export function createCoreHostApp(options: CoreHostAppOptions): CoreHostApp {
  const flags = CORE_ENGINE_ON;
  const jobs = options.jobs ?? CORE_JOBS;
  const nowMs = options.nowMs ?? Date.now;
  let context: CoreAdapterContext | undefined;
  let registryPromise: Promise<AdapterRegistry> | undefined;
  const runtimes = new Map<string, Promise<CoreRuntime>>();
  let rotation = 0;

  const contextOnce = (): CoreAdapterContext => (context ??= options.context());
  const modulesOf = (): readonly CoreAdapterModule[] => (typeof options.modules === "function" ? options.modules() : options.modules);
  const servedCompanies = async (): Promise<readonly string[]> => (options.servedCompanies === undefined ? await listCoreInUse((await registry()).require("storage")) : await options.servedCompanies());

  const registry = (): Promise<AdapterRegistry> => {
    // Every area's points: a half-wired registry is refused.
    registryPromise ??= Promise.resolve().then(() => modulesOf()).then((modules) => buildCoreRegistry({ modules, context: contextOnce(), areas: [...CORE_AREAS], ...(options.wrapStorage === undefined ? {} : { wrapStorage: options.wrapStorage }), ...(options.beforeSeal === undefined ? {} : { beforeSeal: options.beforeSeal }) })).catch((error: unknown) => {
      // A failed build is not cached: the next container use tries again (a transient client error), and the switch stays effectively off meanwhile.
      registryPromise = undefined;
      throw error;
    });
    return registryPromise;
  };

  const runtimeFor = (companyId: string): Promise<CoreRuntime> => {
    let found = runtimes.get(companyId);
    if (found === undefined) {
      found = (async () => {
        const built = await registry();
        const runtime = createCoreRuntime({ ...options.runtime(built, companyId, flags), registry: built, companyId, flags });
        if (options.dispatchOnly === true && runtime.services["merge-tracking"] !== undefined) throw new DispatchOnlyMergeTrackingError();
        // Every area is on for every company, so each must have its services.
        const areas = CORE_AREAS.filter((area) => coreAreaOn(flags, area, companyId));
        const gaps = options.dispatchOnly === true ? [] : serviceGaps(runtime.services, areas);
        if (gaps.length > 0) throw new Error(`the core runtime lacks services for the areas switched on: ${gaps.join(", ")}`);
        // The switch blockers (switch-blockers.ts): required checks, by id. Honest CI is asked where the merge area is on or merge tracking runs at all. A dispatch-only root runs no merge job;
        // the guard above makes that assumption explicit so future merge-tracking wiring cannot turn this skipped check into a bypass.
        const blockers = options.dispatchOnly === true ? [] : switchBlockers(runtime, areas);
        if (blockers.length > 0) throw new CoreSwitchBlockedError(blockers);
        return runtime;
      })();
      found.catch(() => runtimes.delete(companyId));
      runtimes.set(companyId, found);
    }
    return found;
  };

  const companiesFor = async (area: CoreArea): Promise<string[]> => {
    // A company a lessons/system-runs flag names counts as in use for the jobs.
    const named = (options.alsoNamedBy ?? []).flatMap((value) => (value.mode === "on-for" ? value.companies : [])).filter((companyId) => coreAreaOn(flags, area, companyId));
    return [...new Set([contextOnce().installCompanyId, ...named, ...(await servedCompanies())])];
  };

  return {
    flags,
    engineForNewTask: (companyId) => engineForNewTask(flags, companyId),
    registry,
    runtimeFor,
    async handleScheduledJob(event, run) {
      if (!isCoreJobEvent(event)) return undefined;
      if (options.dispatchOnly === true) return { skipped: "dispatch_only" };
      const job = jobs.find((entry) => entry.name === event.job);
      if (job === undefined) return { skipped: "unknown_job" };
      const configured = options.jobBudgetMs ?? 50_000;
      const budgetMs = Math.max(0, run?.remainingMs === undefined ? configured : Math.min(configured, run.remainingMs - (job.exitMarginMs ?? JOB_EXIT_MARGIN_MS)));
      // Each company's job is given what is left of the run's budget when its turn comes.
      const companies = await runPerCompany(await companiesFor(job.area), async (companyId, leftMs) => {
        const asked = nowMs();
        const runtime = await runtimeFor(companyId);
        return await job.run(runtime, Math.max(0, leftMs - (nowMs() - asked)));
      }, { rotation: rotation++, budgetMs, nowMs });
      return { job: job.name, companies };
    },
    async relayOutbox(companies) {
      if (options.dispatchOnly === true) return [];
      const relay = jobs.find((entry) => entry.trigger.kind === "stream");
      if (relay === undefined) return [];
      const served = [...new Set(companies)];
      const budgetMs = options.jobBudgetMs ?? 50_000;
      return await runPerCompany(served, async (companyId) => await relay.run(await runtimeFor(companyId), budgetMs), { rotation: rotation++, budgetMs, nowMs });
    },
  };
}
