// Worker-internal discovery foundation. See packages.md for the future consumer contract.
import { posix } from "node:path";
import { boundedReader, ENV_DETECT_MAX_PATHS, runDetectors } from "./index.js";
import { discoverWorkspaceRoots } from "./workspace-roots.js";
import type { Detection } from "./types.js";

export interface PackageDetection {
  root: string;
  detection: Detection;
  omittedPaths: number;
  /** Virtual lock paths in this unit map to these repository-relative files. */
  inheritedFiles?: Array<{ path: string; repositoryPath: string }>;
}
export type WorkspaceDetection = { kind: "single" | "workspace"; units: PackageDetection[] } | { kind: "unavailable"; units: []; reason: string };

export async function detectWorkspacePackages(paths: readonly string[], load: (path: string) => Promise<string | undefined>, cwd: string, options: Parameters<typeof runDetectors>[2] = {}): Promise<WorkspaceDetection> {
  let roots: string[] | undefined;
  try { roots = await discoverWorkspaceRoots(paths, load); } catch (error) {
    const unreadable = error instanceof Error && error.message === "Workspace definitions could not be read.";
    return { kind: "unavailable", units: [], reason: unreadable ? "Workspace definitions could not be read." : "Workspace definitions are unsupported or unresolved." };
  }
  if (roots === undefined) {
    const bounded = boundedReader(paths, load);
    return { kind: "single", units: [{ root: ".", detection: await runDetectors(bounded.reader, cwd, options), omittedPaths: Math.max(0, paths.length - ENV_DETECT_MAX_PATHS) }] };
  }
  const units: PackageDetection[] = [];
  const owned = new Map(roots.map((root) => [root, [] as string[]]));
  for (const path of paths) {
    let owner = posix.dirname(path);
    while (owner !== "." && !owned.has(owner)) owner = posix.dirname(owner);
    owned.get(owner)?.push(owner === "." ? path : path.slice(owner.length + 1));
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
    const bounded = boundedReader(filePaths, (path) => load(inheritedFiles.find((file) => file.path === path)?.repositoryPath ?? `${prefix}${path}`));
    const detection = await runDetectors(bounded.reader, root === "." ? cwd : `${cwd}/${root}`, options);
    for (const setup of detection.setupCommands) {
      const source = setup.source;
      if (typeof source !== "string" && inheritedFiles.some((file) => file.path === source.path)) setup.value = { ...setup.value, cwd };
    }
    units.push({ root, detection, omittedPaths: Math.max(0, filePaths.length - ENV_DETECT_MAX_PATHS), inheritedFiles });
  }
  return { kind: "workspace", units };
}
