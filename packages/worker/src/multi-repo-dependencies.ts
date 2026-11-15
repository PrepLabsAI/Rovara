// MR1-LIVE: the installed dependency folders (git-ignored, so not in the candidate tree) mirrored into MR1's disposable check root.
//
// What is mirrored: `node_modules` beside every tracked package.json (workspaces included), and a Python virtual environment (`.venv` or `venv` holding a
// `pyvenv.cfg`) at the repository root or beside a tracked Python manifest; the same three names at the workspace root. Go and Maven keep their caches in the
// user's home (GOMODCACHE, ~/.m2), outside the workspace, where the host runner already reads them: nothing of theirs is in the workspace to mirror.
//
// How: every file is a copy-on-write clone where the file system can (APFS clonefile, Linux FICLONE), else a plain copy (COPYFILE_FICLONE falls back by
// itself). Hard links are never used: a check writing a cache file into a hard-linked package would write the workspace's own copy. The source folders are only
// read, through held directories (no symlink followed on Linux; checked with lstat and realpath elsewhere, as candidate-fs does).
//
// Link safety: a link in a mirrored folder that points into a repository (or into another mirrored folder) is re-pointed at the copy. After mirroring, every
// mirrored link must resolve inside the check root. The one exception is a virtual environment's interpreter link (`<venv>/bin/python`, `python3`,
// `python3.N`), which must resolve to a regular file OUTSIDE the workspace (the base interpreter); it is recreated to that exact file and checked again.
// Anything else (a link out of the root, into the live workspace, or dangling) refuses the whole mirror.
//
// Limits: one shared cap per round across every repository, separate from the candidate tree's 50,000 files / 512 MiB: 200,000 entries, 2 GiB, depth 64.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, open, opendir, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openDirectory, readFileIn, type HeldDirectory } from "./candidate-fs.js";

export const DEPENDENCY_MIRROR_LIMITS = { entries: 200_000, bytes: 2 * 1024 * 1024 * 1024, depth: 64 } as const;

/** Fixed refusal words: these become the fallback reasons in evidence, so no path or cause is ever in them. */
export const DEPENDENCY_REFUSAL = {
  limits: "multi-repository installed dependencies exceed the copy limits",
  link: "multi-repository installed dependency link leaves the check root",
  layout: "multi-repository installed dependencies use an unsupported layout",
} as const;

export class DependencyMirrorRefusal extends Error {
  constructor(message: (typeof DEPENDENCY_REFUSAL)[keyof typeof DEPENDENCY_REFUSAL]) {
    super(message);
    this.name = "DependencyMirrorRefusal";
  }
}

const NODE_FOLDER = "node_modules";
const VENV_FOLDERS = [".venv", "venv"];
const PYTHON_MANIFEST = /^(?:pyproject\.toml|setup\.py|setup\.cfg|requirements(?:[-_.][A-Za-z0-9_.-]+)?\.(?:txt|in))$/u;
const INTERPRETER = /^python(?:3(?:\.[0-9]+)?)?$/u;
// Folder paths go into the copy's .git/info/exclude as literal anchored patterns: only characters that need no escaping there.
const PLAIN_PATH = /^[A-Za-z0-9@+_.-]+(?:\/[A-Za-z0-9@+_.-]+)*$/u;
const REWRITE_MAX_BYTES = 1024 * 1024;

export interface DependencyFolder { kind: "node" | "python"; /** Relative to the repository (or workspace) root, "/"-separated. */ path: string }

/**
 * The candidate dependency folders of one repository, from its tracked file list. A folder the tree itself tracks (committed node_modules) is already in the
 * copy and is not mirrored. Yarn Plug'n'Play state is refused: it lives outside node_modules and is not mirrored.
 */
export function dependencyFolders(trackedPaths: readonly string[]): { folders: DependencyFolder[]; pnp: string[] } {
  const tracked = new Set(trackedPaths);
  const prefixes = new Set<string>();
  for (const path of trackedPaths) { const parts = path.split("/"); for (let index = 1; index < parts.length; index++) prefixes.add(parts.slice(0, index).join("/")); }
  const folders = new Map<string, DependencyFolder>();
  const pnp: string[] = [];
  const add = (kind: DependencyFolder["kind"], directory: string, name: string) => {
    const path = directory === "" ? name : `${directory}/${name}`;
    if (!tracked.has(path) && !prefixes.has(path)) folders.set(path, { kind, path });
  };
  for (const name of VENV_FOLDERS) add("python", "", name);
  for (const path of trackedPaths) {
    const parts = path.split("/");
    if (parts.some((part) => part === NODE_FOLDER || VENV_FOLDERS.includes(part))) continue;
    const name = parts.pop()!;
    const directory = parts.join("/");
    if (name === "package.json") {
      add("node", directory, NODE_FOLDER);
      for (const state of [".pnp.cjs", ".pnp.js"]) { const file = directory === "" ? state : `${directory}/${state}`; if (!tracked.has(file)) pnp.push(file); }
    } else if (PYTHON_MANIFEST.test(name)) for (const venv of VENV_FOLDERS) add("python", directory, venv);
  }
  return { folders: [...folders.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), pnp };
}

/** The shared per-round state of one mirror: limits, the source-to-copy map links are re-pointed through, and what was made. */
export interface DependencyMirror {
  /** Canonical workspace root: interpreter links must leave it, every other link must stay in the check root. */
  readonly workspace: string;
  readonly checkRoot: string;
  /** Source directory -> copy directory (repositories, then each mirrored folder as it is made). Longest source first wins. */
  readonly map: Map<string, string>;
  /** Mirrored folders in the copy (absolute): MR1's link remap skips them, they are validated here. */
  readonly mirrored: Set<string>;
  readonly links: string[];
  readonly interpreters: Map<string, string>;
  entries: number;
  bytes: number;
  readonly checkTime: () => void;
}

export function createDependencyMirror(input: { workspace: string; checkRoot: string; copies: ReadonlyMap<string, string>; checkTime: () => void }): DependencyMirror {
  return { workspace: input.workspace, checkRoot: input.checkRoot, map: new Map(input.copies), mirrored: new Set(), links: [], interpreters: new Map(), entries: 0, bytes: 0, checkTime: input.checkTime };
}

const within = (parent: string, path: string) => path === parent || path.startsWith(`${parent}${sep}`);

function mapped(mirror: DependencyMirror, target: string): string {
  let best: [string, string] | undefined;
  for (const entry of mirror.map) if (within(entry[0], target) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  return best === undefined ? target : join(best[1], relative(best[0], target));
}

/**
 * Mirrors the given folders of `sourceRoot` (a repository, or the workspace root) into `destinationRoot`. An absent folder, and a venv-named folder without a
 * pyvenv.cfg, is skipped; a folder that is a link or not a directory is refused. Returns the folders mirrored (relative paths).
 */
export async function mirrorDependencyFolders(mirror: DependencyMirror, sourceRoot: string, destinationRoot: string, folders: readonly DependencyFolder[]): Promise<string[]> {
  const done: string[] = [];
  for (const folder of folders) {
    mirror.checkTime();
    if (!PLAIN_PATH.test(folder.path)) {
      if (await lstat(join(sourceRoot, folder.path)).then(() => true, () => false)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
      continue;
    }
    const source = join(sourceRoot, ...folder.path.split("/"));
    const found = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined; throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout); });
    if (found === undefined) continue;
    if (!found.isDirectory()) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    let held: HeldDirectory | undefined;
    try { held = await openDirectory(source); } catch { throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout); }
    try {
      // A folder named like a virtual environment is one only when it holds its pyvenv.cfg; anything else of that name is left alone.
      if (folder.kind === "python" && (await readFileIn(held, "pyvenv.cfg", 64 * 1024).catch(() => undefined)) === undefined) continue;
      const destination = join(destinationRoot, ...folder.path.split("/"));
      const parent = await openCreating(mirror.checkRoot, dirname(destination));
      let target: HeldDirectory | undefined;
      try {
        if (await lstat(parent.entry(basename(destination))).then(() => true, () => false)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
        target = (await parent.subdirectory(basename(destination), true))!;
      } finally { await parent.close(); }
      mirror.map.set(source, destination);
      mirror.mirrored.add(destination);
      try {
        await copyTree(mirror, { held, path: source }, { held: target, path: destination }, 0, folder.kind === "python" ? source : undefined);
        await chmod(destination, found.mode & 0o7777);
      } finally { await target.close(); }
      if (folder.kind === "python") await relocateVenv(mirror, destination);
      done.push(folder.path);
    } finally { await held.close(); }
  }
  return done;
}

/** Opens (making as needed) `directory`, which must be inside the check root, one held component at a time. */
async function openCreating(checkRoot: string, directory: string): Promise<HeldDirectory> {
  if (!within(checkRoot, directory)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
  let current = await openDirectory(checkRoot);
  try {
    for (const name of relative(checkRoot, directory).split(sep).filter(Boolean)) {
      const next = (await current.subdirectory(name, true))!;
      await current.close(); current = next;
    }
    return current;
  } catch (error) { await current.close().catch(() => undefined); throw error instanceof DependencyMirrorRefusal ? error : new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout); }
}

interface Side { held: HeldDirectory; path: string }

async function copyTree(mirror: DependencyMirror, from: Side, to: Side, depth: number, venv: string | undefined): Promise<void> {
  if (depth > DEPENDENCY_MIRROR_LIMITS.depth) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
  const stream = await opendir(from.held.descriptorPath ?? from.held.path);
  for await (const entry of stream) {
    if (++mirror.entries > DEPENDENCY_MIRROR_LIMITS.entries) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
    if ((mirror.entries & 255) === 0) mirror.checkTime();
    const name = entry.name;
    const info = await lstat(from.held.entry(name));
    if (info.isDirectory()) {
      const child = await from.held.subdirectory(name, false).catch(() => undefined);
      if (child === undefined) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
      try {
        if (await lstat(to.held.entry(name)).then(() => true, () => false)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
        const made = (await to.held.subdirectory(name, true))!;
        try { await copyTree(mirror, { held: child, path: join(from.path, name) }, { held: made, path: join(to.path, name) }, depth + 1, venv); } finally { await made.close(); }
        await chmod(to.held.entry(name), info.mode & 0o7777);
      } finally { await child.close(); }
    } else if (info.isFile()) await copyRegular(mirror, from.held, to.held, name);
    else if (info.isSymbolicLink()) await copyLink(mirror, from, to, name, venv);
    else throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
  }
}

async function copyRegular(mirror: DependencyMirror, from: HeldDirectory, to: HeldDirectory, name: string): Promise<void> {
  let handle;
  try { handle = await open(from.entry(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    mirror.bytes += info.size;
    if (mirror.bytes > DEPENDENCY_MIRROR_LIMITS.bytes) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
    // Linux: copy the very file that was opened (no link can be swapped in). Elsewhere the path is copied and checked to still be that file afterwards.
    const linux = process.platform === "linux";
    await copyFile(linux ? `/proc/self/fd/${handle.fd}` : from.entry(name), to.entry(name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    if (!linux) {
      const again = await lstat(from.entry(name)).catch(() => undefined);
      if (again === undefined || !again.isFile() || again.ino !== info.ino || again.dev !== info.dev) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    }
    await chmod(to.entry(name), info.mode & 0o7777);
  } finally { await handle.close(); }
}

async function copyLink(mirror: DependencyMirror, from: Side, to: Side, name: string, venv: string | undefined): Promise<void> {
  const literal = await readlink(from.held.entry(name));
  const logical = isAbsolute(literal) ? resolve(literal) : resolve(from.path, literal);
  const path = join(to.path, name);
  const target = mapped(mirror, logical);
  if (within(mirror.checkRoot, target)) {
    await symlink(relative(to.path, target), to.held.entry(name));
    mirror.links.push(path);
    return;
  }
  // A virtual environment's base interpreter: outside the workspace, a regular file, recreated to that exact file.
  if (venv !== undefined && from.path === join(venv, "bin") && INTERPRETER.test(name)) {
    const actual = await realpath(join(from.path, name)).catch(() => undefined);
    const info = actual === undefined ? undefined : await stat(actual).catch(() => undefined);
    if (actual !== undefined && info?.isFile() === true && !within(mirror.workspace, actual) && !within(mirror.checkRoot, actual)) {
      await symlink(actual, to.held.entry(name));
      mirror.interpreters.set(path, actual);
      return;
    }
  }
  throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.link);
}

/** Every mirrored link resolves inside the check root (or, for an interpreter, to exactly the file it was made for). Run once all folders exist. */
export async function verifyMirroredLinks(mirror: DependencyMirror): Promise<void> {
  for (const [index, link] of mirror.links.entries()) {
    if ((index & 255) === 0) mirror.checkTime();
    const actual = await realpath(link).catch(() => undefined);
    if (actual !== undefined && within(mirror.checkRoot, actual)) continue;
    // A venv's `python3 -> python` resolves through its interpreter link: allowed only when the link chain itself reaches a recorded interpreter link.
    if (actual === undefined || !(await reachesInterpreter(mirror, link, actual))) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.link);
  }
  for (const [link, expected] of mirror.interpreters) {
    if ((await realpath(link).catch(() => undefined)) !== expected) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.link);
  }
}

async function reachesInterpreter(mirror: DependencyMirror, link: string, actual: string): Promise<boolean> {
  let current = link;
  for (let hop = 0; hop < 8; hop++) {
    if (mirror.interpreters.get(current) === actual) return true;
    const literal = await readlink(current).catch(() => undefined);
    if (literal === undefined || isAbsolute(literal)) return false;
    current = resolve(dirname(current), literal);
    if (!within(mirror.checkRoot, current)) return false;
  }
  return false;
}

/**
 * A virtual environment names its own absolute location in its scripts' shebangs, and editable installs name repository folders in `.pth` and
 * `__editable__*` files. In the copy (a clone, so the workspace's files are untouched) those are re-pointed at the copy, so a check runs the copy's
 * interpreter and imports the copy's code, also on the original code.
 */
async function relocateVenv(mirror: DependencyMirror, destination: string): Promise<void> {
  const replacements = [...mirror.map].sort((left, right) => right[0].length - left[0].length);
  const rewrite = (text: string) => {
    let result = text;
    for (const [from, to] of replacements) result = result.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[/"'\\s]|$)`, "gmu"), to);
    return result;
  };
  const files = async (directory: string, accept: (name: string) => boolean) => {
    const listing = await opendir(directory).catch(() => undefined);
    if (listing === undefined) return [];
    const found: string[] = [];
    for await (const entry of listing) if (entry.isFile() && accept(entry.name)) found.push(join(directory, entry.name));
    return found;
  };
  const update = async (path: string, change: (text: string) => string) => {
    mirror.checkTime();
    const info = await lstat(path);
    if (!info.isFile() || info.size > REWRITE_MAX_BYTES) return;
    const text = await readFile(path, "utf8");
    const next = change(text);
    if (next !== text) { await writeFile(path, next); await chmod(path, info.mode & 0o7777); }
  };
  for (const path of await files(join(destination, "bin"), () => true)) {
    await update(path, (text) => {
      if (!text.startsWith("#!")) return text;
      const lines = text.split("\n");
      const header = lines.slice(0, 3).map(rewrite);
      // A shebang longer than the kernel reads becomes the launcher form pip itself writes for long paths.
      if (header[0]!.length > 255 && header[0] !== lines[0]) {
        const interpreter = header[0]!.slice(2).trim();
        return [`#!/bin/sh`, `'''exec' '${interpreter.replaceAll("'", "'\\''")}' "$0" "$@"`, `' '''`, ...lines.slice(1)].join("\n");
      }
      return [...header, ...lines.slice(3)].join("\n");
    });
  }
  const lib = await opendir(join(destination, "lib")).catch(() => undefined);
  if (lib !== undefined) for await (const entry of lib) {
    if (!entry.isDirectory() || !/^python[0-9.]+t?$/u.test(entry.name)) continue;
    for (const path of await files(join(destination, "lib", entry.name, "site-packages"), (name) => name.endsWith(".pth") || /^__editable__.*\.py$/u.test(name))) await update(path, rewrite);
  }
}

/** Appends literal anchored excludes for the mirrored folders to the copy's own `.git/info/exclude`, so MR1's tree snapshots never take them in. */
export async function excludeMirroredFolders(copy: string, folders: readonly string[]): Promise<void> {
  if (folders.length === 0) return;
  const repository = await openDirectory(copy);
  try {
    const git = await repository.subdirectory(".git", false);
    if (git === undefined) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    try {
      const info = (await git.subdirectory("info", true))!;
      try {
        const existing = (await readFileIn(info, "exclude", 1024 * 1024))?.toString("utf8") ?? "";
        await writeFile(info.entry("exclude"), `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${folders.map((folder) => `/${folder}/\n`).join("")}`, { mode: 0o600 });
      } finally { await info.close(); }
    } finally { await git.close(); }
  } finally { await repository.close(); }
}
