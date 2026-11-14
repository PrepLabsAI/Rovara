// Setup and test health SH22 (review F4): the work tree that goes into an image is the committed code, checked against a git history the sandbox could not touch.
//
// The Prove run executes the project's own commands in the fresh sandbox, and those commands can rewrite anything in the workspace, `.git` included (a planted `objects/info/alternates`, a graft, an index flag
// that hides a changed file, a config with a credential). So the build never trusts the live `.git`:
//   - the worker copies the clone's `.git` out of the sandbox's reach BEFORE the Prove run (the "trusted" copy);
//   - after the Prove run (and after every process of the sandbox is stopped) the work tree is staged WITHOUT its `.git`, and the trusted `.git` is installed beside it with a generated config;
//   - every tracked file of the trusted HEAD tree is compared, byte for byte (the Git blob hash), with the staged file. A file that differs, is missing, is the wrong kind, or sits under a symbolic link
//     is a refusal. Untracked files (installed dependencies, caches) are free: they are not code the repository's reviewers saw.
//
// This file holds the pieces that need no `git` binary: the refused `.git` entries, the generated config, the origin URL check and the byte-for-byte comparison.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** Paths inside a `.git` directory that change where Git reads history from or how it reads it. Any of them, in the trusted copy or the staged one, ends the build. */
export const REFUSED_GIT_ENTRIES: readonly string[] = [
  "objects/info/alternates", "objects/info/http-alternates", "refs/replace", "info/grafts", "info/attributes", "modules", "worktrees", "commondir", "gitdir",
];

/** How many records of `git ls-files -v -z` carry a flag other than "H" (assume-unchanged, skip-worktree, and the like). */
export function countNonStandardFlags(output: string): number {
  return output.split("\u0000").filter((record) => record !== "" && !record.startsWith("H ")).length;
}

/** The refused entries that exist in `gitDirectory` (names only). Does not follow a link: a link is reported as present. */
export async function unsafeGitEntries(gitDirectory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of REFUSED_GIT_ENTRIES) {
    try { await lstat(path.join(gitDirectory, entry)); found.push(entry); } catch { /* absent */ }
  }
  return found;
}

/** `remote.origin.url` from the text of a `.git/config`, or undefined. A small reader: the config here is the worker's own clone's. */
export function originUrlOf(configText: string): string | undefined {
  let inOrigin = false;
  for (const line of configText.split(/\r?\n/u)) {
    const section = /^\s*\[(.*)\]\s*$/u.exec(line);
    if (section !== null) { inOrigin = /^remote\s+"origin"$/u.test(section[1]!.trim()); continue; }
    if (!inOrigin) continue;
    const value = /^\s*url\s*=\s*(.+?)\s*$/u.exec(line);
    if (value !== null) return value[1];
  }
  return undefined;
}

/**
 * Whether `url` may be written into the staged config: no whitespace, quote, backslash or control character (it could not break out of its line), at most 500 characters, and NO credential: an http(s) or git URL
 * with a user name or password is refused; an ssh URL or an `user@host:path` address may name the user `git` only.
 */
export function originUrlIsSafe(url: string): boolean {
  if (url.length === 0 || url.length > 500 || [...url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || /[\s"'\\]/u.test(char))) return false;
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):[A-Za-z0-9._/~-]+$/u.exec(url);
  if (scp !== null) return scp[1] === "git";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ssh:") return parsed.password === "" && (parsed.username === "" || parsed.username === "git");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "git:") return false;
    return parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The config the staged repository gets: only the origin URL (so a later fetch knows where it came from), nothing the project's commands could have written. */
export function minimalGitConfig(originUrl: string, extraCore: readonly string[] = []): string {
  if (!originUrlIsSafe(originUrl)) throw new RangeError("the origin URL is not safe to write");
  return [
    "[core]", "\trepositoryformatversion = 0", "\tfilemode = true", "\tbare = false", ...extraCore.map((line) => `\t${line}`),
    '[remote "origin"]', `\turl = ${originUrl}`, "\tfetch = +refs/heads/*:refs/remotes/origin/*", "",
  ].join("\n");
}

export interface TreeEntry { mode: string; type: string; sha: string; path: string }

/** Parses `git ls-tree -r -z HEAD`: `<mode> SP <type> SP <sha> TAB <path> NUL`. Throws on anything else. */
export function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\u0000")) {
    if (record === "") continue;
    const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(record);
    if (match === null) throw new RangeError("not a tree listing");
    const entryPath = match[4]!;
    if (entryPath.startsWith("/") || entryPath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new RangeError("not a tree path");
    entries.push({ mode: match[1]!, type: match[2]!, sha: match[3]!, path: entryPath });
  }
  return entries;
}

export type TreeMismatch = "submodule" | "missing" | "wrong_kind" | "linked_directory" | "content" | "mode" | "unreadable";
export type TreeComparison = { ok: true; files: number } | { ok: false; reason: TreeMismatch; count: number };

/** The Git blob hash of a file's bytes: sha1 over `blob <size> NUL` and the content, streamed. */
async function blobHash(file: string, size: number): Promise<string> {
  const hash = createHash("sha1");
  hash.update(`blob ${String(size)}\u0000`);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Compares every entry of the trusted HEAD tree with the staged work tree at `root`. Refuses (with the first reason met and how many entries failed):
 *   - a gitlink (a submodule): there is none in an image;
 *   - a missing file, or a file of another kind than the tree says (a directory, a link where a file belongs, a file where a link belongs);
 *   - any directory on the way that is a symbolic link (a tracked path read through a link reaches a file the tree never named);
 *   - content that is not the committed content, or an executable bit that is not the committed one;
 *   - a symbolic link whose target is not the committed target.
 * The staged tree must not change while this runs (the sandbox's processes are stopped first).
 */
export interface CompareOptions {
  /**
   * Git's own CLEAN conversion of working tree files (`git hash-object --stdin-paths` in the staged repository: end-of-line and ident attributes, no filter driver). Asked only for regular files whose raw hash
   * differs, and only after every `.gitattributes` file matched byte for byte (the attributes that drive the conversion are themselves verified). Absent, or a path it does not return: the file fails.
   */
  convertedHashes?: (paths: string[]) => Promise<ReadonlyMap<string, string> | undefined>;
}

export async function compareTrackedFiles(entries: readonly TreeEntry[], root: string, options: CompareOptions = {}): Promise<TreeComparison> {
  let count = 0;
  let first: TreeMismatch | undefined;
  const fail = (reason: TreeMismatch): void => { count += 1; first ??= reason; };
  const directories = new Map<string, boolean>();
  /** Whether every directory above `relative` is a real directory. */
  const parentsAreReal = async (relative: string): Promise<boolean> => {
    const parts = relative.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      let real = directories.get(current);
      if (real === undefined) {
        try { const info = await lstat(path.join(root, current)); real = info.isDirectory() && !info.isSymbolicLink(); } catch { real = false; }
        directories.set(current, real);
      }
      if (!real) return false;
    }
    return true;
  };
  let files = 0;
  const converting: Array<{ path: string; sha: string }> = [];
  for (const entry of entries) {
    if (entry.type === "commit" || entry.mode === "160000") { fail("submodule"); continue; }
    if (entry.type !== "blob") { fail("wrong_kind"); continue; }
    if (!(await parentsAreReal(entry.path))) { fail("linked_directory"); continue; }
    const full = path.join(root, entry.path);
    let info;
    try { info = await lstat(full); } catch { fail("missing"); continue; }
    try {
      if (entry.mode === "120000") {
        if (!info.isSymbolicLink()) { fail("wrong_kind"); continue; }
        const target = await readlink(full);
        if (createHash("sha1").update(`blob ${String(Buffer.byteLength(target))}\u0000`).update(target).digest("hex") !== entry.sha) fail("content");
        else files += 1;
        continue;
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") { fail("wrong_kind"); continue; }
      if (!info.isFile() || info.isSymbolicLink()) { fail("wrong_kind"); continue; }
      if (((info.mode & 0o111) !== 0) !== (entry.mode === "100755")) { fail("mode"); continue; }
      if (await blobHash(full, info.size) === entry.sha) files += 1;
      // A raw difference may be the end-of-line conversion the repository's attributes ask for. The attributes files themselves are never converted: they are compared raw.
      else if (path.posix.basename(entry.path) === ".gitattributes" || entry.path.includes("\n")) fail("content");
      else converting.push({ path: entry.path, sha: entry.sha });
    } catch {
      fail("unreadable");
    }
  }
  if (converting.length > 0) {
    // Only when every attributes file matched raw: otherwise the conversion would be driven by attributes nobody verified.
    const converted = count === 0 && options.convertedHashes !== undefined ? await options.convertedHashes(converting.map((item) => item.path)).catch(() => undefined) : undefined;
    for (const item of converting) {
      if (converted?.get(item.path) === item.sha) files += 1;
      else fail("content");
    }
  }
  return count === 0 ? { ok: true, files } : { ok: false, reason: first!, count };
}

/** Reads `.git/config` of a repository directory, or undefined. */
export async function readGitConfig(repositoryDirectory: string): Promise<string | undefined> {
  try { return await readFile(path.join(repositoryDirectory, ".git", "config"), "utf8"); } catch { return undefined; }
}
