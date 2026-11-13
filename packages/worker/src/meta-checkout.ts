// Meta repo lane A, task A3: the project's meta repository in the workspace, read-only and sparse.
//
// The meta repo holds the team's knowledge (rules, steering, skills, specs, runbooks). A task reads it at ONE commit, the meta repo's default-branch head when the workspace
// was prepared (`knowledgeCommit`), so every stage sees the same files and a builder cannot change what the judging stages are told. Only the knowledge paths are materialized:
// a meta repo can be large, and nothing else of it is ever read. The files are made read-only (0444); the meta repo is not code to a worker (`workerProjectDefinition` leaves
// it out of the project), so it is never changed, committed or published from here. The lane C resolver verifies the files against the commit with trusted-base-objects.
//
// Fail closed and bounded: a path that cannot be resolved, a tree that is too large, more files or bytes than the caps below, or a symbolic link or submodule among the
// chosen entries (not materialized, and not silently followed) either ends the preparation with a fixed message or is skipped and counted. Nothing from Git's output or the
// repository's file names is put into an error.
import { chmod, lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { PrepareMeta } from "@rovara-code/contracts";
import { runIsolatedGit } from "./isolated-repository.js";

/** More than this many files are not read: a knowledge folder is documents, not a code tree. */
export const META_CHECKOUT_MAX_FILES = 2_000;
/** Total size of the materialized files. */
export const META_CHECKOUT_MAX_BYTES = 16 * 1024 * 1024;
/** The listing of the whole tree (names and sizes) is read once; a tree whose listing is larger is refused. */
const LISTING_MAX_BYTES = 32 * 1024 * 1024;
/** Files per `git checkout` call, to keep the command line short. */
const CHECKOUT_BATCH = 200;

/**
 * Rule files that can sit in any folder of the meta repo: they apply under their folder (the resolver's `scopeDir`). A folder's own rules are found wherever the
 * folder is, so these are matched by name, not by a listed path.
 */
export const NESTED_RULE_FILE_NAMES: readonly string[] = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"];

export interface MetaCheckoutResult {
  /** The commit the meta repo's default branch was at; the one every stage reads. */
  commit: string;
  /** Files materialized. */
  files: number;
  bytes: number;
  /** Chosen entries that were not materialized because they are symbolic links or submodules. */
  skipped: number;
}

export class MetaCheckoutRefusal extends Error {
  constructor(readonly code: "too_many_files" | "too_large" | "listing_too_large" | "unreadable") {
    super(`the meta repo cannot be read: ${code.replace(/_/g, " ")}`);
    this.name = "MetaCheckoutRefusal";
  }
}

interface TreeEntry { mode: string; type: string; size: number; path: string }

/** `git ls-tree -r -l -z` output as entries. A line that does not have the expected shape is dropped, not guessed at. */
export function parseTreeListing(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const fields = record.slice(0, tab).trim().split(/\s+/);
    if (fields.length !== 4) continue;
    const [mode, type, , size] = fields as [string, string, string, string];
    const bytes = size === "-" ? 0 : Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
    entries.push({ mode, type, size: bytes, path: record.slice(tab + 1) });
  }
  return entries;
}

/** Whether `path` is one of the chosen paths, under one of them (a folder), or a nested rule file anywhere. */
export function metaPathWanted(path: string, chosen: readonly string[]): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (NESTED_RULE_FILE_NAMES.includes(name)) return true;
  return chosen.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/**
 * Materializes the knowledge paths of an already cloned (`--no-checkout`) meta repository at `commit`, and makes the files read-only. `destination` is the repository's
 * folder. The clone is a normal `--no-checkout` one (full history), so the rest of the tree shows as staged deletions in `git status`, and every meta file is readable with `git show`: this is not a security boundary, and lane C reads the knowledge by object id at the pinned commit.
 */
export async function materializeMetaKnowledge(destination: string, commit: string, meta: Pick<PrepareMeta, "paths">): Promise<MetaCheckoutResult> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) throw new MetaCheckoutRefusal("unreadable");
  let listing: string;
  try {
    listing = await runIsolatedGit(destination, ["ls-tree", "-r", "-l", "-z", commit], { maxBuffer: LISTING_MAX_BYTES, timeout: 120_000 });
  } catch (error) {
    // Git's own words (a path, a hash, a remote) stay out of the message; a tree larger than the buffer is a different answer from a tree that cannot be read.
    throw new MetaCheckoutRefusal(error instanceof Error && /maxBuffer/i.test(error.message) ? "listing_too_large" : "unreadable");
  }
  const wanted = parseTreeListing(listing).filter((entry) => metaPathWanted(entry.path, meta.paths));
  // A symbolic link (120000) or submodule (160000) is not followed: a link could point out of the folder, a submodule is another repository.
  const files = wanted.filter((entry) => entry.type === "blob" && entry.mode !== "120000");
  const skipped = wanted.length - files.length;
  if (files.length > META_CHECKOUT_MAX_FILES) throw new MetaCheckoutRefusal("too_many_files");
  const bytes = files.reduce((total, entry) => total + entry.size, 0);
  if (bytes > META_CHECKOUT_MAX_BYTES) throw new MetaCheckoutRefusal("too_large");

  for (let start = 0; start < files.length; start += CHECKOUT_BATCH) {
    const batch = files.slice(start, start + CHECKOUT_BATCH).map((entry) => entry.path);
    // `--` ends the options, so a file called like an option is a path; the pathspecs are literal (no globbing).
    await runIsolatedGit(destination, ["--literal-pathspecs", "checkout", commit, "--", ...batch], { timeout: 120_000 });
  }
  await makeReadOnly(destination);
  return { commit, files: files.length, bytes, skipped };
}

/** Every regular file under `directory` (not Git's own folder) becomes 0444. Nothing is followed through a symbolic link. */
async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    if (info.isDirectory()) await makeReadOnly(path);
    else if (info.isFile()) await chmod(path, 0o444);
  }
}

/** The paths relative to the repository's folder that exist now: what the lane C resolver may read. Used by tests and by the manifest's check. */
export async function listMaterialized(destination: string, directory = destination): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === destination && entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listMaterialized(destination, path));
    else found.push(relative(destination, path).split(sep).join("/"));
  }
  return found.sort();
}
