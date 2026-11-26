// Engine host (lane E2): the adapter registry a deployed install runs the core on (the laptop's counterpart is `local/runtime.ts`).
//
// Each adapter is a `CoreAdapterModule`: the point it fills, its name, and a `create` that builds it from the context (clients, the table name, the clock). This file only joins them. Modules are
// a list, so a new point or a second adapter is one more entry, and a test can build the same registry over fakes.
//
// Rules held here:
//  - Build once per function container (cold start), never per request, and only when the root first needs it (app.ts).
//  - Every point each area needs must be filled, or the registry is refused with the list of what is missing (never a half-wired core).
//  - Points that decide money, authority and audit never take Code's laptop default on a deployed install (`NEVER_DEFAULT`): the registry is refused instead, so a deployed core cannot run with
//    the laptop's allow-all admission or sole-owner people by accident.
//  - An optional `storage` wrapper is applied before anything else sees the store (a deployment's retention rule, if it keeps one).
//  - The registry is sealed before it is handed out: after that only channel adapters may change (Code's rule).
import type { AdapterOf, AdapterRegistry, DocumentStore, PluginPoint } from "@agentx/contracts";
import { createAdapterRegistry } from "../ports/adapter-registry.js";
import type { CoreArea } from "./flags.js";

/** What every adapter module may use to build itself. Production fills it from the function's environment; tests from fakes. */
export interface CoreAdapterContext {
  /** The install's company; adapters still take the company from each call. */
  installCompanyId: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  /** Named clients or fakes (a DynamoDB client, an SQS client, ...). Each module reads only the ones it names. */
  clients: Readonly<Record<string, unknown>>;
  log: (entry: Record<string, unknown>) => void;
}

export interface CoreAdapterModule<P extends PluginPoint = PluginPoint> {
  readonly point: P;
  readonly name: string;
  /** Who owns the adapter (shown when a point is missing). */
  readonly owner: string;
  /** Code's laptop default for the point, replaced by a configured adapter of the same point. */
  readonly isDefault?: boolean;
  create(context: CoreAdapterContext, registry: Pick<AdapterRegistry, "get" | "require" | "names">): AdapterOf<P> | Promise<AdapterOf<P>>;
}

export function coreAdapter<P extends PluginPoint>(module: CoreAdapterModule<P>): CoreAdapterModule<P> {
  return module;
}

/** The points each area needs filled (the core's own `createTaskFlowFromRegistry`, build step and merge tracking read these). */
export const POINTS_BY_AREA: Readonly<Record<CoreArea, readonly PluginPoint[]>> = {
  flow: ["storage", "queue", "worker-machines", "admission", "audit-sink", "approvers", "identity", "metering"],
  build: ["storage", "queue", "worker-machines", "object-storage", "code-host", "check-runner", "model-keys", "secrets"],
  merge: ["storage", "code-host", "approvers", "audit-sink"],
};

/** Points that must hold a deployed adapter, never Code's laptop default (money, authority, audit, durable state). A default there is refused. */
export const NEVER_DEFAULT: ReadonlySet<PluginPoint> = new Set<PluginPoint>(["admission", "approvers", "identity", "audit-sink", "metering", "storage", "queue"]);

export class CoreRegistryError extends Error {
  constructor(readonly missing: readonly { point: PluginPoint; areas: readonly CoreArea[] }[], readonly defaulted: readonly PluginPoint[]) {
    super(`the core registry is not complete: ${[...missing.map((entry) => `${entry.point} (needed by ${entry.areas.join(", ")})`), ...defaulted.map((point) => `${point} is Code's laptop default`)].join("; ")}`);
    this.name = "CoreRegistryError";
  }
}

export interface BuildRegistryOptions {
  modules: readonly CoreAdapterModule[];
  context: CoreAdapterContext;
  /** The areas this install serves (every area): their points must be filled. */
  areas: readonly CoreArea[];
  /** Wraps the `storage` adapter before anything else sees it (a deployment's retention rule). Absent: the store as built. */
  wrapStorage?: (store: DocumentStore) => DocumentStore;
  /** Called last, after the registry is found complete and before it is sealed (the policy hook goes in front of admission and approvers here). A throw refuses the registry. */
  beforeSeal?: (registry: AdapterRegistry) => void;
}

/** What is missing for these areas, as a report (an empty report means the registry can serve them). */
export function registryGaps(registry: Pick<AdapterRegistry, "names">, defaults: ReadonlySet<PluginPoint>, areas: readonly CoreArea[]): { missing: { point: PluginPoint; areas: CoreArea[] }[]; defaulted: PluginPoint[] } {
  const needed = new Map<PluginPoint, CoreArea[]>();
  for (const area of areas) for (const point of POINTS_BY_AREA[area]) needed.set(point, [...(needed.get(point) ?? []), area]);
  const missing = [...needed].filter(([point]) => registry.names(point).length === 0).map(([point, by]) => ({ point, areas: by }));
  const defaulted = [...needed.keys()].filter((point) => NEVER_DEFAULT.has(point) && defaults.has(point));
  return { missing, defaulted };
}

/**
 * Builds and seals the registry. Modules are created in order, so a module may read an adapter an earlier one registered (the queue reads the store).
 * Throws `CoreRegistryError` when a needed point is empty or holds only Code's laptop default where a deployed adapter is required.
 */
export async function buildCoreRegistry(options: BuildRegistryOptions): Promise<AdapterRegistry> {
  const registry = createAdapterRegistry();
  const defaults = new Set<PluginPoint>();
  for (const module of options.modules) {
    let adapter: unknown = await module.create(options.context, registry);
    if (module.point === "storage" && options.wrapStorage !== undefined) adapter = options.wrapStorage(adapter as DocumentStore);
    registry.register(module.point, module.name, adapter as never, module.isDefault === true ? { isDefault: true } : {});
    // A configured adapter replaces a default of the point; the point then no longer counts as defaulted.
    if (module.isDefault === true) { if (!registry.names(module.point).some((name) => name !== module.name)) defaults.add(module.point); } else defaults.delete(module.point);
  }
  const gaps = registryGaps(registry, defaults, options.areas);
  if (gaps.missing.length > 0 || gaps.defaulted.length > 0) throw new CoreRegistryError(gaps.missing, gaps.defaulted);
  options.beforeSeal?.(registry);
  registry.seal();
  return registry;
}
