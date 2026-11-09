// Live interaction A2, worker side: a signed `peek` invocation reads the workspace's working tree for an "Ask about this task" and answers on the same request (diff stat, a bounded patch,
// untracked file names). It is READ ONLY by construction:
//  - every Git call goes through `runIsolatedGit` in "read" mode with an allow-listed subcommand (diff, status, rev-parse, cat-file): a throwaway repository that never reads the candidate's config
//    or hooks, with a copy of the index, so the workspace's own files and index are never written (the agent keeps running while this reads);
//  - nothing else touches the workspace: no file is opened, no command runs, no network.
// What it returns is redacted before it is cut (so a cut cannot leave half of a secret), files whose names look like credentials have their counts but no patch, and the whole patch is at most
// `maxPatchBytes` bytes. It journals nothing and calls nothing back. A failure of any kind answers `unavailable` (the caller uses the pull request's diff); no error text leaves this module.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PEEK_FILES_MAX, PEEK_PATCH_MAX_BYTES, redactText, type PeekAnswer, type WorkerInvocation } from "@agentx/contracts";
import type { PreparationManifest } from "./prepare.js";
import { redactCredentials } from "./events.js";
import { runIsolatedGit } from "./isolated-repository.js";

type PeekInvocation = Extract<WorkerInvocation, { kind: "peek" }>;

/** The only Git subcommands a peek may run. A test pins the calls against this list. */
export const PEEK_GIT_SUBCOMMANDS = ["diff", "status", "rev-parse", "cat-file"] as const;

const GIT_TIMEOUT_MS = 20_000;
/** What one repository's diff output may be before the peek gives up on its patch (the counts and names still stand). */
const GIT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const SAFE_DIFF = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--no-renames", "--no-color"] as const;

/** File names whose patch is never returned (their counts and names are). Excluded in Git itself, so the content never reaches this process. */
export const PEEK_CREDENTIAL_EXCLUDES = [
  ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*", ":(exclude,glob)**/*.pem", ":(exclude,glob)**/*.key", ":(exclude,glob)**/*.p12", ":(exclude,glob)**/*.pfx",
  ":(exclude,glob)**/id_rsa*", ":(exclude,glob)**/id_ed25519*", ":(exclude,glob)**/id_ecdsa*", ":(exclude,glob)**/.npmrc", ":(exclude,glob)**/.netrc",
  ":(exclude,glob)**/credentials", ":(exclude,glob)**/credentials.*", ":(exclude,glob)**/*.tfvars", ":(exclude,glob)**/.agentx-file-ops-*",
] as const;

const unavailable = (): PeekAnswer => ({ accepted: true, outcome: "unavailable", files: [], untracked: [], patch: "", patchTruncated: false, filesTruncated: false });

/** The first `max` bytes of `text`, never splitting a character. */
function headBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > max) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}

const clean = (value: string): string => redactText(String(redactCredentials(value)));

/** The commit the repository was prepared at, when it still has it; else HEAD (the diff then shows uncommitted changes only). */
async function baseOf(directory: string, resolvedCommit: string): Promise<string> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(resolvedCommit)) return "HEAD";
  try {
    await runIsolatedGit(directory, ["cat-file", "-e", `${resolvedCommit}^{commit}`], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return resolvedCommit;
  } catch {
    return "HEAD";
  }
}

/** `git diff --numstat -z` output: `added TAB removed TAB path NUL` (a binary file has `-` counts). With `--no-renames` every record is one NUL-terminated entry. */
export function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number; binary: boolean }> {
  const rows: Array<{ path: string; additions: number; deletions: number; binary: boolean }> = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/u.exec(record);
    if (match === null) continue;
    const binary = match[1] === "-" || match[2] === "-";
    rows.push({ path: match[3]!, additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  return rows;
}

/** `git status --short -z --untracked-files=all` entries that start with `?? `: the untracked files' names. */
export function parseUntracked(output: string): string[] {
  return output.split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3));
}

/** Reads the working tree. Never throws: anything that goes wrong answers `unavailable`. */
export async function handlePeekInvocation(invocation: PeekInvocation, rootPath: string): Promise<PeekAnswer> {
  try {
    const manifest = JSON.parse(await readFile(resolve(rootPath, ".agentx/preparation-manifest.json"), "utf8")) as PreparationManifest;
    if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) return unavailable();
    const patchBudget = Math.min(invocation.payload.maxPatchBytes, PEEK_PATCH_MAX_BYTES);
    const files: PeekAnswer["files"] = [];
    const untracked: PeekAnswer["untracked"] = [];
    const patches: string[] = [];
    let filesTruncated = false;
    let patchTruncated = false;
    for (const repository of manifest.repositories) {
      const directory = resolve(rootPath, repository.path);
      const base = await baseOf(directory, repository.resolvedCommit);
      const numstat = await runIsolatedGit(directory, ["diff", ...SAFE_DIFF, "--numstat", "-z", base, "--"], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BYTES });
      for (const row of parseNumstat(numstat)) {
        if (files.length >= PEEK_FILES_MAX) { filesTruncated = true; break; }
        files.push({ repository: repository.name, path: clean(row.path).slice(0, 1_024), additions: row.additions, deletions: row.deletions, ...(row.binary ? { binary: true } : {}) });
      }
      const status = await runIsolatedGit(directory, ["status", "--short", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BYTES });
      for (const path of parseUntracked(status)) {
        if (untracked.length >= PEEK_FILES_MAX) { filesTruncated = true; break; }
        untracked.push({ repository: repository.name, path: clean(path).slice(0, 1_024) });
      }
      try {
        const patch = await runIsolatedGit(directory, ["diff", ...SAFE_DIFF, base, "--", ".", ...PEEK_CREDENTIAL_EXCLUDES], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BYTES });
        if (patch !== "") patches.push(`## repository ${repository.name}\n${patch}`);
      } catch {
        // A diff too big to hold: the counts and names above still stand, the patch is cut.
        patchTruncated = true;
      }
    }
    // Redacted whole, then cut: a cut never leaves the first half of a secret in the text.
    const text = clean(patches.join("\n"));
    const patch = headBytes(text, patchBudget);
    return { accepted: true, outcome: "peeked", files, untracked, patch, patchTruncated: patchTruncated || patch.length < text.length, filesTruncated };
  } catch {
    return unavailable();
  }
}
