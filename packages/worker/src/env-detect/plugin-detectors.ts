// Port lane P6 (item B1): detectors that a `build-system` plug-in supplies. The worker's built-in detectors (`index.ts` `DETECTORS`) are a fixed list; a build-system profile names a module, installed in
// the worker's image, that exports more. The worker runs them AFTER the built-in ones, in the same thread and under the same limits (the bounded reader, the wall clock of `guarded.ts`).
//
// The module exports `detectors` (or a default export of the same shape): `[{ name, run }]`, where `run` is a `Detector` (`types.ts`). A name is lower-case words with hyphens, unique, and never one of
// the built-in names (a plug-in adds findings; it cannot take the place of the python or node detector). The module comes from the OPERATOR's profile (`ROVARA_BUILD_SYSTEMS`), never from a job or a
// repository: `vetDetectorModules` also refuses an absolute path that lies inside the workspace, where repositories are checked out.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Detector } from "./types.js";

export interface PluginDetector { name: string; run: Detector }

export const PLUGIN_DETECTOR_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
/** The most detectors one module may add, and in all. */
export const PLUGIN_DETECTORS_PER_MODULE = 16;
export const PLUGIN_DETECTORS_MAX = 32;

export interface LoadedPluginDetectors {
  detectors: PluginDetector[];
  /** Plain statements for the maintainer, in fixed words: a module that could not be used. They never carry the module's own text. */
  notes: string[];
}

const NOT_LOADED_NOTE = "A build-system detector could not be loaded, so its findings are missing.";

/** True when `path` is `parent` or lies inside it. */
const within = (parent: string, path: string): boolean => {
  const difference = relative(parent, path);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference) && !difference.startsWith(`..${sep}`));
};

/**
 * Keeps the modules that may be loaded: a package name is kept; an absolute path is kept only if it is a plain file whose real path is outside the workspace. Dropped ones are named in `notes` (fixed words).
 * `workspaceRoot` absent: only the file check applies.
 */
export async function vetDetectorModules(modules: readonly string[], workspaceRoot?: string): Promise<{ modules: string[]; notes: string[] }> {
  const kept: string[] = [];
  const notes: string[] = [];
  const root = workspaceRoot === undefined ? undefined : await realpath(resolve(workspaceRoot)).catch(() => resolve(workspaceRoot));
  for (const specifier of modules) {
    if (!isAbsolute(specifier)) {
      kept.push(specifier);
      continue;
    }
    try {
      const real = await realpath(specifier);
      if (!(await stat(real)).isFile() || (root !== undefined && within(root, real))) throw new Error("not usable");
      kept.push(real);
    } catch {
      notes.push(NOT_LOADED_NOTE);
    }
  }
  return { modules: kept, notes: [...new Set(notes)] };
}

function detectorsOf(imported: unknown): unknown {
  if (typeof imported !== "object" || imported === null) return undefined;
  const named = (imported as { detectors?: unknown }).detectors;
  if (named !== undefined) return named;
  const fallback = (imported as { default?: unknown }).default;
  return typeof fallback === "object" && fallback !== null ? (fallback as { detectors?: unknown }).detectors ?? fallback : undefined;
}

/**
 * Imports the (vetted) modules and checks what they export. A module that cannot be imported, or whose export has the wrong shape, adds nothing and a note; so does a detector whose name is taken. Never throws.
 * `importModule` is for tests; by default the module is imported by package name or file URL.
 */
export async function loadPluginDetectors(
  modules: readonly string[],
  builtInNames: ReadonlySet<string>,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier),
): Promise<LoadedPluginDetectors> {
  const detectors: PluginDetector[] = [];
  const notes: string[] = [];
  const taken = new Set(builtInNames);
  for (const specifier of modules) {
    let list: unknown;
    try {
      list = detectorsOf(await importModule(specifier));
    } catch {
      notes.push(NOT_LOADED_NOTE);
      continue;
    }
    if (!Array.isArray(list) || list.length > PLUGIN_DETECTORS_PER_MODULE) {
      notes.push(NOT_LOADED_NOTE);
      continue;
    }
    const fromModule: PluginDetector[] = [];
    let valid = true;
    for (const item of list as unknown[]) {
      const candidate = item as { name?: unknown; run?: unknown } | null;
      if (typeof candidate?.name !== "string" || !PLUGIN_DETECTOR_NAME.test(candidate.name) || typeof candidate.run !== "function" || taken.has(candidate.name) || fromModule.some((existing) => existing.name === candidate.name)) {
        valid = false;
        break;
      }
      fromModule.push({ name: candidate.name, run: candidate.run as Detector });
    }
    if (!valid || detectors.length + fromModule.length > PLUGIN_DETECTORS_MAX) {
      notes.push(NOT_LOADED_NOTE);
      continue;
    }
    for (const detector of fromModule) {
      taken.add(detector.name);
      detectors.push(detector);
    }
  }
  return { detectors, notes: [...new Set(notes)] };
}
