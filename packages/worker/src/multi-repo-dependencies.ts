// MR1-LIVE: what the candidate tree leaves out, mirrored into MR1's disposable check root, so a check there sees what it sees in the workspace.
//
// What is mirrored: every git-ignored entry of each repository (installed dependencies such as node_modules and virtual environments, and also build output
// such as dist/, generated code, in-place built extensions and env files), listed by Git itself against the candidate snapshot's own index
// (`ls-files --others --ignored --exclude-standard --directory`); and every entry at the workspace root that is neither a repository, nor holds one, nor is
// worker state. Go and Maven keep their caches in the user's home (GOMODCACHE, ~/.m2), outside the workspace, where the host runner already reads them.
//
// How: every file is a copy-on-write clone where the file system can (APFS clonefile, Linux FICLONE), else a plain copy (COPYFILE_FICLONE falls back by
// itself). Hard links are never used: a check writing a cache file into a hard-linked package would write the workspace's own copy. The sources are only
// read, through held directories (no symlink followed on Linux; checked with lstat and realpath elsewhere, as candidate-fs does).
//
// Link safety: a mirrored link that points into a repository or another mirrored entry is re-pointed at the copy. Once everything is mirrored, every mirrored
// link must resolve inside the check root. The one exception is a virtual environment's interpreter link (`<venv>/bin/python`, `python3`, `python3.N`),
// which must resolve to an executable regular file OUTSIDE the workspace (the base interpreter); it is recreated to that exact file and checked again.
// Anything else (a link out of the root, into the live workspace, or dangling) refuses the whole mirror. Only after that check are a venv's own files
// rewritten (shebangs, editable installs), never through a link.
//
// Limits: one shared cap per round across every repository, separate from the candidate tree's 50,000 files / 512 MiB: 200,000 entries, 2 GiB, depth 64.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, open, opendir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const INTERPRETER = /^python(?:3(?:\.[0-9]+)?)?$/u;
const REWRITE_MAX_BYTES = 1024 * 1024;
/** Worker state is never mirrored: it is not the project's, and the check root's own name is one of these. */
const WORKER_STATE = /^(?:\.agentx|\.rovara|\.git$)/iu;

/** The `git ls-files -z --others --ignored --exclude-standard --directory` listing as relative entry paths (a directory's trailing slash dropped). */
export function ignoredEntries(listing: string): string[] {
  const entries: string[] = [];
  for (const raw of listing.split("\0")) {
    if (raw === "") continue;
    const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\n"))) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    if (parts.some((part) => WORKER_STATE.test(part))) continue;
    entries.push(path);
  }
  if (entries.length > DEPENDENCY_MIRROR_LIMITS.entries) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
  return entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** Workspace-root entries to mirror: not a repository, not holding one, not worker state. */
export async function workspaceRootEntries(workspace: HeldDirectory, repositoryPaths: readonly string[]): Promise<string[]> {
  const taken = new Set(repositoryPaths.map((path) => path.split(/[\\/]/u)[0]!));
  const entries: string[] = [];
  for await (const entry of await opendir(workspace.descriptorPath ?? workspace.path)) {
    if (entries.length >= 4_096) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
    if (taken.has(entry.name) || WORKER_STATE.test(entry.name) || entry.name.includes("\n")) continue;
    entries.push(entry.name);
  }
  return entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** The shared per-round state of one mirror: limits, the source-to-copy map links are re-pointed through, and what was made. */
export interface DependencyMirror {
  /** Canonical workspace root: interpreter links must leave it, every other link must stay in the check root. */
  readonly workspace: string;
  readonly checkRoot: string;
  /** Source path -> copy path (repositories, then each mirrored entry as it is made). The longest matching source wins. */
  readonly map: Map<string, string>;
  /** Mirrored entries in the copy (absolute): MR1's link remap skips them, they are validated here. */
  readonly mirrored: Set<string>;
  readonly links: string[];
  readonly interpreters: Map<string, string>;
  /** Virtual environments mirrored (copy paths): their own files are re-pointed once every link is verified. */
  readonly venvs: string[];
  entries: number;
  bytes: number;
  readonly checkTime: () => void;
}

export function createDependencyMirror(input: { workspace: string; checkRoot: string; copies: ReadonlyMap<string, string>; checkTime: () => void }): DependencyMirror {
  return { workspace: input.workspace, checkRoot: input.checkRoot, map: new Map(input.copies), mirrored: new Set(), links: [], interpreters: new Map(), venvs: [], entries: 0, bytes: 0, checkTime: input.checkTime };
}

const within = (parent: string, path: string) => path === parent || path.startsWith(`${parent}${sep}`);

function mapped(mirror: DependencyMirror, target: string): string {
  let best: [string, string] | undefined;
  for (const entry of mirror.map) if (within(entry[0], target) && (best === undefined || entry[0].length > best[0].length)) best = entry;
  return best === undefined ? target : join(best[1], relative(best[0], target));
}

/**
 * Mirrors the given entries (relative "/"-separated paths) of `sourceRoot` (a repository, or the workspace root) into `destinationRoot`. An entry that is
 * gone is skipped; one under a link, or of an unsupported kind, is refused. Returns the entries mirrored.
 */
export async function mirrorEntries(mirror: DependencyMirror, sourceRoot: string, destinationRoot: string, entries: readonly string[]): Promise<string[]> {
  const done: string[] = [];
  for (const entry of entries) {
    mirror.checkTime();
    const parts = entry.split("/");
    const name = parts.pop()!;
    const sourceParent = join(sourceRoot, ...parts);
    const destinationParent = join(destinationRoot, ...parts);
    let from: HeldDirectory;
    try { from = await openDirectory(sourceParent); } catch { throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout); }
    try {
      if (await lstat(from.entry(name)).then(() => false, () => true)) continue;
      const to = await openCreating(mirror.checkRoot, destinationParent);
      try {
        if (await lstat(to.entry(name)).then(() => true, () => false)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
        mirror.map.set(join(sourceParent, name), join(destinationParent, name));
        mirror.mirrored.add(join(destinationParent, name));
        await copyEntry(mirror, { held: from, path: sourceParent }, { held: to, path: destinationParent }, name, 0, undefined);
      } finally { await to.close(); }
      done.push(entry);
    } finally { await from.close(); }
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

async function copyEntry(mirror: DependencyMirror, from: Side, to: Side, name: string, depth: number, venv: string | undefined): Promise<void> {
  if (++mirror.entries > DEPENDENCY_MIRROR_LIMITS.entries) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
  if ((mirror.entries & 255) === 0) mirror.checkTime();
  const info = await lstat(from.held.entry(name)).catch(() => undefined);
  if (info === undefined) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
  if (info.isFile()) return copyRegular(mirror, from.held, to.held, name);
  if (info.isSymbolicLink()) return copyLink(mirror, from, to, name, venv);
  if (!info.isDirectory()) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
  if (depth > DEPENDENCY_MIRROR_LIMITS.depth) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.limits);
  const child = await from.held.subdirectory(name, false).catch(() => undefined);
  if (child === undefined) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
  try {
    if (await lstat(to.held.entry(name)).then(() => true, () => false)) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    const made = (await to.held.subdirectory(name, true))!;
    const source = join(from.path, name);
    const destination = join(to.path, name);
    // A directory holding its own pyvenv.cfg is a virtual environment: its interpreter link may leave the workspace, and its files are re-pointed later.
    let inner = venv;
    if (venv === undefined && (await readFileIn(child, "pyvenv.cfg", 64 * 1024).catch(() => undefined)) !== undefined) { inner = source; mirror.venvs.push(destination); }
    try {
      for await (const entry of await opendir(child.descriptorPath ?? child.path)) await copyEntry(mirror, { held: child, path: source }, { held: made, path: destination }, entry.name, depth + 1, inner);
    } finally { await made.close(); }
    await chmod(to.held.entry(name), info.mode & 0o7777);
  } finally { await child.close(); }
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
    // What was made must be a regular file (a clone of a link swapped in would not be), and the mode is set on it, never through a link.
    if (!(await lstat(to.entry(name))).isFile()) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
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
  // A virtual environment's base interpreter: outside the workspace, an executable regular file, recreated to that exact file.
  if (venv !== undefined && from.path === join(venv, "bin") && INTERPRETER.test(name)) {
    const actual = await realpath(join(from.path, name)).catch(() => undefined);
    const info = actual === undefined ? undefined : await stat(actual).catch(() => undefined);
    if (actual !== undefined && info?.isFile() === true && (info.mode & 0o111) !== 0 && !within(mirror.workspace, actual) && !within(mirror.checkRoot, actual)) {
      await symlink(actual, to.held.entry(name));
      mirror.interpreters.set(path, actual);
      return;
    }
  }
  throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.link);
}

/** Every mirrored link resolves inside the check root (or, for an interpreter, to exactly the file it was made for); then venvs are re-pointed. */
export async function finishMirror(mirror: DependencyMirror): Promise<void> {
  await verifyMirroredLinks(mirror);
  for (const venv of mirror.venvs) await relocateVenv(mirror, venv);
}

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

/** A real directory (never a link) inside the check root. */
async function realDirectory(mirror: DependencyMirror, path: string): Promise<boolean> {
  if (!within(mirror.checkRoot, path)) return false;
  const info = await lstat(path).catch(() => undefined);
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
}

/**
 * A virtual environment names its own absolute location in its scripts' shebangs, and editable installs name repository folders in `.pth` and
 * `__editable__*` files. In the copy (a clone, so the workspace's files are untouched) those are re-pointed at the copy, so a check runs the copy's
 * interpreter and imports the copy's code. Only real directories are listed and only regular files are opened, without following a link.
 */
async function relocateVenv(mirror: DependencyMirror, destination: string): Promise<void> {
  const replacements = [...mirror.map].sort((left, right) => right[0].length - left[0].length);
  const rewrite = (text: string) => {
    let result = text;
    for (const [from, to] of replacements) result = result.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[/"'\\s]|$)`, "gmu"), to);
    return result;
  };
  const files = async (directory: string, accept: (name: string) => boolean) => {
    if (!(await realDirectory(mirror, directory))) return [];
    const found: string[] = [];
    for await (const entry of await opendir(directory)) if (entry.isFile() && accept(entry.name)) found.push(join(directory, entry.name));
    return found;
  };
  const update = async (path: string, change: (text: string) => string) => {
    mirror.checkTime();
    const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (reader === undefined) return;
    let text: string;
    try {
      const info = await reader.stat();
      if (!info.isFile() || info.size > REWRITE_MAX_BYTES) return;
      text = (await reader.readFile()).toString("utf8");
    } finally { await reader.close(); }
    const next = change(text);
    if (next === text) return;
    const writer = await open(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { await writer.writeFile(next); } finally { await writer.close(); }
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
  const lib = join(destination, "lib");
  if (await realDirectory(mirror, lib)) for await (const entry of await opendir(lib)) {
    if (!entry.isDirectory() || !/^python[0-9.]+t?$/u.test(entry.name)) continue;
    for (const path of await files(join(lib, entry.name, "site-packages"), (name) => name.endsWith(".pth") || /^__editable__.*\.py$/u.test(name))) await update(path, rewrite);
  }
}

/** Gitignore pattern for one literal path: anchored, every special character escaped. */
const literalPattern = (path: string) => `/${path.replace(/[\\*?[\]!# ]/gu, "\\$&")}`;

/** Appends literal anchored excludes for the mirrored entries to the copy's own `.git/info/exclude`, so MR1's tree snapshots never take them in. */
export async function excludeMirrored(copy: string, entries: readonly string[]): Promise<void> {
  if (entries.length === 0) return;
  const repository = await openDirectory(copy);
  try {
    const git = await repository.subdirectory(".git", false);
    if (git === undefined) throw new DependencyMirrorRefusal(DEPENDENCY_REFUSAL.layout);
    try {
      const info = (await git.subdirectory("info", true))!;
      try {
        const existing = (await readFileIn(info, "exclude", 1024 * 1024))?.toString("utf8") ?? "";
        const writer = await open(info.entry("exclude"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await writer.writeFile(`${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${entries.map((entry) => `${literalPattern(entry)}\n`).join("")}`); } finally { await writer.close(); }
      } finally { await info.close(); }
    } finally { await git.close(); }
  } finally { await repository.close(); }
}
