// Port lane W0, port 4: the plug-in registry and its config loader.
//
// One registry for every plug-in point (decisions 40, 45.5, 51). It replaces "nothing is loaded from outside" (the old build-time
// registry) with "load the adapters the config file names", and it drops the edition gate: there is no Enterprise-only plug-in
// in Code. Pratik's channel adapters (spec 062 phase 3) are its `channel` point; an adapter an administrator registers over HTTP
// is registered here under its channel id when it is created, and unregistered when it is deleted.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
} from "@agentx/contracts";

interface Entry {
  adapter: unknown;
  isDefault: boolean;
}

export function createAdapterRegistry(): AdapterRegistry {
  const points = new Map<PluginPoint, Map<string, Entry>>();
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
    unregister(point, name) {
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

/** The default importer: a package name through Node's resolution, a relative path against the config file's folder. */
export function createModuleImporter(configDirectory: string): ModuleImporter {
  return (specifier) => import(specifier.startsWith(".") ? pathToFileURL(resolve(configDirectory, specifier)).href : specifier);
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
}

/**
 * Creates and registers every enabled adapter the config names, in order. A module must export `plugin` (or a default export)
 * whose `point` and `name` match its config entry, so a config cannot make one adapter pose as another. A failure names the entry
 * and stops the load; adapters created before it stay registered, so a caller that cannot continue should discard the registry.
 */
export async function loadAdapters(config: PluginConfig, options: LoadAdaptersOptions): Promise<void> {
  const companyId = config.companyId ?? IMPLICIT_COMPANY_ID;
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
    const context: PluginContext = { companyId, settings: entry.settings, registry: options.registry, now: options.now ?? (() => new Date()) };
    let adapter: unknown;
    try {
      adapter = await module.create(context);
    } catch (error) {
      if (error instanceof PluginRegistryError) throw error;
      throw new PluginRegistryError("create_failed", `${label} could not be created`);
    }
    options.registry.register(entry.point, entry.name, adapter as never);
  }
}

/** Convenience for a process start-up: defaults first, then the file's adapters on top. */
export async function loadAdaptersFromFile(path: string, options: Omit<LoadAdaptersOptions, "importModule"> & { importModule?: ModuleImporter }): Promise<PluginConfig> {
  const config = await readPluginConfigFile(path);
  await loadAdapters(config, { ...options, importModule: options.importModule ?? createModuleImporter(dirname(resolve(path))) });
  return config;
}
