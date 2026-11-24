// Lane E, "Node 24 per repo" (use): which Node a command in the task sandbox starts with. The image's default is Node 22 (/usr/local/bin/node); a repository whose own files ask for Node 24 gets
// /opt/rovara/node/24/bin first on PATH, for its commands only. The files are read where the command runs (the workspace, or a sealed round's copy of the recorded commit) by the same rule the setup
// detector uses (env-detect/node-version.ts). The nearest directory from the command's cwd up to the workspace root that has a Node hint (a package in a monorepo may have its own) decides.
// Reads are small and bounded and never follow a link: a file the task wrote can only choose between the two Nodes the image carries, and nothing here runs or downloads anything.
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_NODE_MAJOR, detectNodeMajor } from "./env-detect/node-version.js";

/** Where the image keeps Node 24 (environments/base/Dockerfile). */
export const NODE_24_BIN = "/opt/rovara/node/24/bin";
const HINT_FILES = [".nvmrc", ".node-version", ".tool-versions", "package.json"] as const;
const HINT_MAX_BYTES = 256 * 1_024;
/** The most directories walked up from a command's cwd. */
const WALK_MAX = 64;

/** A regular file's text (never through a link), or undefined. */
async function readRegular(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > HINT_MAX_BYTES) return undefined;
    const handle = await open(path, "r");
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch { return undefined; }
}

/** The hint files in one directory (regular files only), by name. */
async function hintFilesIn(directory: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of HINT_FILES) {
    try { if ((await lstat(join(directory, name))).isFile()) present.push(name); } catch { /* absent */ }
  }
  return present;
}

/** The PATH prefix this directory's own hints ask for: `[bin]` for Node 24, `[]` for the default, undefined when it has no Node hint (the walk goes on up). */
async function directoryPrefix(directory: string, bin: string): Promise<readonly string[] | undefined> {
  const present = await hintFilesIn(directory);
  if (present.length === 0) return undefined;
  const choice = await detectNodeMajor({ paths: present, read: (path) => readRegular(join(directory, path)) });
  if (!choice.hinted) return undefined;
  return choice.major === DEFAULT_NODE_MAJOR ? [] : [bin];
}

/** The PATH folders to put FIRST for a command run in `cwd` (absolute, under `rootPath`): `[bin]` (the image's /opt/rovara/node/24/bin; a test gives its own) for a repository that needs Node 24, else nothing. Never throws. */
export async function nodePathPrefixFor(rootPath: string, cwd: string, bin: string = NODE_24_BIN): Promise<readonly string[]> {
  try {
    // Both through realpath: the sealed round hands the canonical root, the working sandbox the path as configured.
    const root = await realpath(resolve(rootPath));
    let directory = await realpath(resolve(cwd));
    const from = relative(root, directory);
    if (isAbsolute(from) || from === ".." || from.startsWith(`..${sep}`)) return [];
    for (let step = 0; step < WALK_MAX; step += 1) {
      const prefix = await directoryPrefix(directory, bin);
      if (prefix !== undefined) return prefix;
      if (directory === root) return [];
      directory = dirname(directory);
    }
  } catch { /* a command is never held up by this */ }
  return [];
}
