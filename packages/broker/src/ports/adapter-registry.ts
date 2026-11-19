// Port lane W0, port 4: the plug-in registry and its config loader.
//
// One registry for every plug-in point (decisions 40, 45.5, 51). It replaces "nothing is loaded from outside" (the old build-time
// registry) with "load the adapters the config file names", and it drops the edition gate: there is no Enterprise-only plug-in
// in Code. Pratik's channel adapters (spec 062 phase 3) are its `channel` point. An adapter an administrator registers over HTTP is
// meant to be registered here under its channel id when it is created and unregistered when it is deleted; that wiring (a record-backed
// source, because the records live in the state table and this registry is per process) is not done yet. See docs/ports.md.
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { connectionProblems } from "../plugins/code-host/connections.js";
import {
  IMPLICIT_COMPANY_ID,
  PLUGIN_POINT_CARDINALITY,
  PluginConfigSchema,
  PluginRegistryError,
  type AdapterOf,
  type AdapterRegistration,
  type AdapterRegistry,
  type PluginConfig,
  type PluginContext,
  type PluginModule,
  type PluginPoint,
  type RegistryView,
} from "@agentx/contracts";

/** The points whose adapters carry a `kind` that is also their registry name (a code host called `github` has kind `github`; a model provider's kind is its provider id). */
const KIND_NAMED_POINTS: ReadonlySet<PluginPoint> = new Set<PluginPoint>(["code-host", "tracker", "check-runner", "model-provider"]);

interface Entry {
  adapter: unknown;
  isDefault: boolean;
}

export function createAdapterRegistry(): AdapterRegistry {
  const points = new Map<PluginPoint, Map<string, Entry>>();
  let sealed = false;
  const mayChange = (point: PluginPoint): void => {
    if (sealed && point !== "channel") throw new PluginRegistryError("already_registered", `the registry is sealed; only channel adapters can change (${point})`);
  };
  const entriesOf = (point: PluginPoint): Map<string, Entry> => {
    let entries = points.get(point);
    if (entries === undefined) {
      entries = new Map();
      points.set(point, entries);
    }
    return entries;
  };

  return {
    register(point, name, adapter, registration: AdapterRegistration = {}) {
      mayChange(point);
      // A caller never branches on an adapter's name, and a lookup by name must find the adapter that calls itself that.
      if (KIND_NAMED_POINTS.has(point) && (adapter as { kind?: unknown } | null)?.kind !== name) throw new PluginRegistryError("bad_module", `a ${point} adapter's kind must be the name it is registered under (${name})`);
      const entries = entriesOf(point);
      const isDefault = registration.isDefault === true;
      const existing = entries.get(name);
      // A configured adapter may take the place of a default of the same name; nothing else may share a name.
      if (existing !== undefined && !(existing.isDefault && !isDefault)) throw new PluginRegistryError("already_registered", `${point} already has an adapter named ${name}`);
      if (PLUGIN_POINT_CARDINALITY[point] === "one") {
        const others = [...entries].filter(([otherName]) => otherName !== name);
        if (isDefault) {
          // A default never displaces a configured adapter, and two defaults are a mistake.
          if (others.some(([, other]) => !other.isDefault)) return;
          if (others.length > 0) throw new PluginRegistryError("already_registered", `${point} takes one adapter and a default is registered`);
        } else {
          for (const [otherName, other] of others) {
            if (!other.isDefault) throw new PluginRegistryError("already_registered", `${point} takes one adapter and ${otherName} is registered`);
            entries.delete(otherName);
          }
        }
      }
      entries.set(name, { adapter, isDefault });
    },
    seal() {
      sealed = true;
    },
    unregister(point, name) {
      mayChange(point);
      return entriesOf(point).delete(name);
    },
    get<P extends PluginPoint>(point: P, name: string): AdapterOf<P> | undefined {
      return entriesOf(point).get(name)?.adapter as AdapterOf<P> | undefined;
    },
    require<P extends PluginPoint>(point: P, name?: string): AdapterOf<P> {
      const entries = entriesOf(point);
      if (name !== undefined) {
        const entry = entries.get(name);
        if (entry === undefined) throw new PluginRegistryError("not_registered", `${point} has no adapter named ${name}`);
        return entry.adapter as AdapterOf<P>;
      }
      if (entries.size === 0) throw new PluginRegistryError("not_registered", `${point} has no adapter`);
      if (entries.size > 1) throw new PluginRegistryError("ambiguous", `${point} has several adapters; name one`);
      return [...entries.values()][0]!.adapter as AdapterOf<P>;
    },
    names(point) {
      return [...entriesOf(point).keys()].sort();
    },
  };
}

/** Parses the config file's content. Throws a `PluginRegistryError` (`bad_config`) that lists what is wrong, without echoing values. */
export function parsePluginConfig(value: unknown): PluginConfig {
  const parsed = PluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new PluginRegistryError("bad_config", `the plug-in config is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Reads a JSON config file. (A YAML reader is a small addition for the lane that wants one.) */
export async function readPluginConfigFile(path: string): Promise<PluginConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new PluginRegistryError("bad_config", "the plug-in config file could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PluginRegistryError("bad_config", "the plug-in config file is not valid JSON");
  }
  return parsePluginConfig(value);
}

/** Loads a module by the specifier the config gave. Injectable, so tests and other loaders need no files. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * The default importer: a package name through Node's resolution, a `./` path against the config file's folder. The path is resolved
 * to its real location (links followed) and must lie inside that folder, so a link cannot lead out of it.
 */
export function createModuleImporter(configDirectory: string): ModuleImporter {
  return async (specifier) => {
    if (!specifier.startsWith("./")) return (await import(specifier)) as unknown;
    const root = await realpath(resolve(configDirectory));
    const target = await realpath(resolve(root, specifier));
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).some((part) => part.startsWith("."))) {
      throw new Error("a plug-in module must lie inside the config folder");
    }
    return (await import(pathToFileURL(target).href)) as unknown;
  };
}

function pluginOf(loaded: unknown): PluginModule | undefined {
  const holder = loaded as { plugin?: unknown; default?: unknown } | null | undefined;
  const candidate = holder?.plugin ?? holder?.default;
  const module = candidate as Partial<PluginModule> | null | undefined;
  return module !== null && typeof module === "object" && typeof module.point === "string" && typeof module.name === "string" && typeof module.create === "function" ? (module as PluginModule) : undefined;
}

export interface LoadAdaptersOptions {
  registry: AdapterRegistry;
  importModule: ModuleImporter;
  now?: () => Date;
  /** The install's own folder, handed to every plug-in as `PluginContext.stateDirectory`. */
  stateDirectory?: string;
}

/**
 * Creates and registers every enabled adapter the config names, in order. A module must export `plugin` (or a default export)
 * whose `point` and `name` match its config entry, so a config cannot make one adapter pose as another. A failure names the entry
 * and stops the load; adapters created before it stay registered, so a caller that cannot continue should discard the registry.
 */
export async function loadAdapters(config: PluginConfig, options: LoadAdaptersOptions): Promise<void> {
  const defaultCompanyId = config.companyId ?? IMPLICIT_COMPANY_ID;
  for (const entry of config.plugins) {
    if (!entry.enabled) continue;
    const label = `${entry.point}/${entry.name}`;
    let loaded: unknown;
    try {
      loaded = await options.importModule(entry.module);
    } catch {
      throw new PluginRegistryError("bad_module", `the module for ${label} could not be loaded`);
    }
    const module = pluginOf(loaded);
    if (module === undefined) throw new PluginRegistryError("bad_module", `the module for ${label} does not export a plug-in`);
    if (module.point !== entry.point || module.name !== entry.name) throw new PluginRegistryError("bad_module", `the module for ${label} is a plug-in for a different point or name`);
    const view: RegistryView = { get: (point, name) => options.registry.get(point, name), require: (point, name) => options.registry.require(point, name), names: (point) => options.registry.names(point) };
    const context: PluginContext = { defaultCompanyId, settings: entry.settings, registry: view, now: options.now ?? (() => new Date()), ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }) };
    let adapter: unknown;
    try {
      adapter = await module.create(context);
    } catch (error) {
      if (error instanceof PluginRegistryError) throw error;
      // The adapter's own message may quote its settings; the operator gets the error's class only.
      throw new PluginRegistryError("create_failed", `${label} could not be created (${error instanceof Error ? error.name : "unknown error"})`);
    }
    options.registry.register(entry.point, entry.name, adapter as never);
  }
  // Item C2: several connections of one provider need exactly one default; a config that does not is refused when it loads, not when a repository first uses it.
  const problems = connectionProblems(options.registry);
  if (problems.length > 0) throw new PluginRegistryError("bad_config", `the code host connections are not valid: ${problems.join("; ")}`);
}

/** Convenience for a process start-up: register the defaults first, call this, then `registry.seal()`. */
export async function loadAdaptersFromFile(path: string, options: Omit<LoadAdaptersOptions, "importModule"> & { importModule?: ModuleImporter }): Promise<PluginConfig> {
  const config = await readPluginConfigFile(path);
  await loadAdapters(config, { ...options, importModule: options.importModule ?? createModuleImporter(dirname(resolve(path))) });
  return config;
}
