// Worker-internal discovery foundation. See packages.md for the future consumer contract.
import { posix } from "node:path";
import { boundedReader, ENV_DETECT_MAX_PATHS, runDetectors } from "./index.js";
import { runWorkspacePackagesGuarded, type GuardOptions } from "./guarded.js";
import { discoverWorkspaceRoots } from "./workspace-roots.js";
import type { Detection, RepositoryReader } from "./types.js";

export interface PackageDetection {
  root: string;
  detection: Detection;
  omittedPaths: number;
  /** Virtual lock paths in this unit map to these repository-relative files. */
  inheritedFiles?: Array<{ path: string; repositoryPath: string }>;
}
export type WorkspaceDetection = { kind: "single" | "workspace"; units: PackageDetection[] } | { kind: "unavailable"; units: []; reason: string };

export const ENV_DETECT_MAX_PACKAGES = 64;
const unavailable = (reason: string): WorkspaceDetection => ({ kind: "unavailable", units: [], reason });

/** One inventory, cache, byte budget and clock for discovery and every unit. */
export async function detectWorkspacePackages(paths: readonly string[], load: (path: string) => Promise<string | undefined>, cwd: string, options: Pick<GuardOptions, "timeoutMs" | "entry" | "only"> = {}): Promise<WorkspaceDetection> {
  if (paths.length > ENV_DETECT_MAX_PATHS) return unavailable("Workspace inventory exceeds 5000 files.");
  const bounded = boundedReader(paths, (path) => bounded.reader.budgetExhausted?.() === true ? Promise.resolve(undefined) : load(path));
  if (bounded.reader.paths.length !== paths.length) return unavailable("Workspace inventory contains unsupported paths.");
  return runWorkspacePackagesGuarded(bounded.reader, cwd, options);
}

/** Thread-only implementation: the parent owns the shared bounded reader and the wall clock. */
export async function detectWorkspacePackagesInThread(reader: RepositoryReader, cwd: string, options: Parameters<typeof runDetectors>[2] = {}): Promise<WorkspaceDetection> {
  const paths = reader.paths;
  const load = (path: string) => reader.read(path);
  let roots: string[] | undefined;
  try { roots = await discoverWorkspaceRoots(paths, load); } catch (error) {
    const unreadable = error instanceof Error && error.message === "Workspace definitions could not be read.";
    return { kind: "unavailable", units: [], reason: unreadable ? "Workspace definitions could not be read." : "Workspace definitions are unsupported or unresolved." };
  }
  if (roots === undefined) {
    return { kind: "single", units: [{ root: ".", detection: await runDetectors(reader, cwd, options), omittedPaths: 0 }] };
  }
  const units: PackageDetection[] = [];
  // Keep a remainder unit: metadata and undeclared module files must never disappear.
  if (!roots.includes(".")) roots.unshift(".");
  if (roots.length > ENV_DETECT_MAX_PACKAGES) return unavailable("Workspace exceeds 64 packages.");
  const owned = new Map(roots.map((root) => [root, [] as string[]]));
  for (const path of paths) {
    let owner = posix.dirname(path);
    while (owner !== "." && !owned.has(owner)) owner = posix.dirname(owner);
    owned.get(owner)!.push(owner === "." ? path : path.slice(owner.length + 1));
  }
  for (const root of roots) {
    const prefix = root === "." ? "" : `${root}/`;
    const local = owned.get(root)!;
    // The package manager owns a workspace-wide lock. Reuse it for manager selection,
    // but keep its install command at the repository root where that lock actually lives.
    const inheritedFiles = root !== "." && local.includes("package.json") && !["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some((path) => local.includes(path))
      ? ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter((path) => paths.includes(path) && !local.includes(path)).map((path) => ({ path, repositoryPath: path }))
      : [];
    const filePaths = [...inheritedFiles.map((file) => file.path), ...local];
    const allowed = new Set(filePaths);
    const localReader: RepositoryReader = {
      paths: filePaths,
      budgetExhausted: () => reader.budgetExhausted?.() === true,
      read: (path) => allowed.has(path) ? load(inheritedFiles.find((file) => file.path === path)?.repositoryPath ?? `${prefix}${path}`) : Promise.resolve(undefined),
    };
    const detection = await runDetectors(localReader, root === "." ? cwd : `${cwd}/${root}`, options);
    if (reader.budgetExhausted?.() === true) return unavailable("Workspace read budget ran out.");
    for (const setup of detection.setupCommands) {
      const source = setup.source;
      if (typeof source !== "string" && inheritedFiles.some((file) => file.path === source.path)) setup.value = { ...setup.value, cwd };
    }
    units.push({ root, detection, omittedPaths: Math.max(0, filePaths.length - ENV_DETECT_MAX_PATHS), inheritedFiles });
  }
  return { kind: "workspace", units };
}
