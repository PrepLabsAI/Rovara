// The change tier's input from the code host: the files of each change request of a task, read as the host reports them (never what an agent says), and the commits the tier is bound to.
// A host that gives no patch text for a file leaves it unreadable, and the classifier then treats the file as risky (fail closed); the port is not changed.
import { createHash } from "node:crypto";
import type { ChangeRequestFile, CodeHost, HostScope } from "@agentx/contracts";
import { changedFilesFromHostFiles, plainChangedPath } from "../proof/changed-files.js";
import { canonicalPatchText, factKey, type DiffInput, type HeadFacts, type TierFile } from "../decisions/change-tier.js";
import { DOCS_SITE_PROBES, fileTypeOf, normalizedTierPath } from "../decisions/sensitive-list.js";
import { changeRequestRef, readChangeRequestFiles } from "./host-port.js";

export interface TierReadTarget {
  host: CodeHost;
  repositoryId: string;
  repositoryUrl: string;
  number: number;
}

/** The tier files of one change request's host list. The routes and response schemas the diff touches are read the way the risk rules read them. */
export function tierFilesOfRead(repositoryId: string, read: { files: readonly ChangeRequestFile[]; complete: boolean }): { files: TierFile[]; complete: boolean } {
  const parsed = changedFilesFromHostFiles(repositoryId, read.files, read.complete);
  const api = new Set(parsed.files.filter((entry) => entry.apiShapeChanged === true).map((entry) => `${entry.renamedFrom ?? ""}\u0000${entry.path}`));
  return {
    complete: read.complete && read.files.every((file) => plainChangedPath(file.path) && (file.previousPath === undefined || plainChangedPath(file.previousPath))),
    files: read.files.map((file) => ({
      repository: repositoryId, path: file.path, ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }), status: file.status, additions: file.additions, deletions: file.deletions,
      ...(file.patch === undefined ? {} : { patch: file.patch }), ...(api.has(`${file.previousPath ?? ""}\u0000${file.path}`) ? { apiShapeChanged: true } : {}),
    })),
  };
}

/** The instruction files whose imports are read at the head: a document one of them reads is an instruction, whatever its name. */
const INSTRUCTION_ROOTS = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", "AGENT.md", "GEMINI.md", "WARP.md", ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules", ".clinerules",
  // Cursor's rules folder cannot be listed through the port: its usual file names are asked for by name.
  ".cursor/rules/main.mdc", ".cursor/rules/index.mdc", ".cursor/rules/rules.mdc", ".cursor/rules/project.mdc", ".cursor/rules/general.mdc", ".cursor/rules/global.mdc", ".cursor/rules/default.mdc", ".cursor/rules/coding.mdc",
  ".cursor/rules/repo.mdc", ".cursor/rules/main.md", ".cursor/rules/rules.md", ".claude/CLAUDE.md",
] as const;
/** Folders where instruction files live and that the port cannot list: when one exists there may be files in it that were not read, and no document is cleared as plain docs. */
const INSTRUCTION_FOLDERS = [".cursor", ".claude", ".github/instructions", ".windsurf", ".clinerules", ".continue", ".agents", ".codex", ".openhands", ".kilocode", ".amazonq", ".kiro", ".gemini", ".roo", ".cline", ".trae", ".junie"] as const;
/** The instruction files an agent reads in the folders of the files it works on. */
const NESTED_INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
const INSTRUCTION_READ_MAX_BYTES = 100_000;
const DOCUMENT_READ_MAX_BYTES = 200_000;
/** The most host reads one tier spends on facts beyond the file list. */
const DOCUMENTS_READ_MAX = 20;
const PATH_KINDS_READ_MAX = 40;
const NESTED_FOLDERS_MAX = 30;
/** Imports are followed this many links deep (Claude's own limit is five); a longer chain is not followed, and what cannot be followed is not cleared. */
const IMPORT_DEPTH_MAX = 5;
const IMPORTED_FILES_MAX = 40;

/**
 * The paths an instruction file names, in any form: `@path` imports, Markdown inline and reference links, HTML `href` and `src`, and a path written in plain words ("read docs/rules.md"). Each is resolved against the file's
 * folder and against the repository root (an agent may read either), and written in the normalized form.
 */
export function importsOf(instructionPath: string, text: string): string[] {
  const folder = instructionPath.includes("/") ? instructionPath.slice(0, instructionPath.lastIndexOf("/") + 1) : "";
  const targets = [
    ...[...text.matchAll(/(?:^|[\s(])@([\w@./-]+\.[A-Za-z0-9]{1,6})\b/gu)].map((match) => match[1]!),
    ...[...text.matchAll(/\]\(<?([^)#\s>]+)(?:#[^)\s]*)?>?[^)]*\)/gu)].map((match) => match[1]!),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>#]+)/gmu)].map((match) => match[1]!),
    ...[...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#]+)/giu)].map((match) => match[1]!),
    ...[...text.matchAll(/(?:^|[\s("'`<])((?:[\w@.-]+\/)*[\w@.-]+\.(?:md|mdx|markdown|rst|adoc|txt|ya?ml|json|toml))(?=$|[\s)"'`>,.;:])/gmu)].map((match) => match[1]!),
  ];
  const out = new Set<string>();
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    for (const base of target.startsWith("/") ? [""] : folder === "" ? [""] : [folder, ""]) {
      const resolved: string[] = [];
      for (const part of `${base}${target.replace(/^\//u, "")}`.split("/")) { if (part === "..") resolved.pop(); else if (part !== "." && part !== "") resolved.push(part); }
      out.add(normalizedTierPath(resolved.join("/")));
    }
  }
  return [...out];
}

export interface TierReadInput { diff: DiffInput; head: HeadFacts }

/**
 * What the host knows of the code at each head commit, beyond the file list: the text of the documents the change touches (so the section a changed line sits in is known), which paths the instruction files import, and
 * which paths are symbolic links. A path kind the host cannot answer THROWS (the caller refuses, or leaves the tier unwritten); a document or an instruction file that cannot be read leaves that fact unknown, and the rules
 * then do not clear the document as plain docs. `files` are the tier files already read (each names its repository).
 */
export async function readHeadFacts(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, files: readonly TierFile[], scope: HostScope, beforeRequest?: () => void): Promise<HeadFacts> {
  const text = new Map<string, string>();
  const imports = new Set<string>();
  const links = new Set<string>();
  const unchecked = new Set<string>();
  let importsKnown: boolean | undefined;
  let docsSite: boolean | undefined;
  for (const target of targets) {
    const ref = changeRequestRef(target.repositoryUrl, target.number);
    const all = files.filter((file) => file.repository === target.repositoryId);
    const listed = all.filter((file) => file.status !== "removed");
    // Documents: the text at the head, so a changed line's heading and block are known. Past the limit the text is not read, and the document is then not cleared.
    const documents = listed.filter((file) => fileTypeOf(file.path) === "prose").slice(0, DOCUMENTS_READ_MAX);
    for (const document of documents) {
      beforeRequest?.();
      const body = await target.host.fileAtRevision(ref.repository, document.path, target.headSha, scope, { maxBytes: DOCUMENT_READ_MAX_BYTES }).catch(() => undefined);
      if (body !== undefined) text.set(factKey(target.repositoryId, document.path), body);
    }
    // A document (changed, added OR removed) may be read by an instruction file, and may be built into a documentation site.
    if (all.some((file) => fileTypeOf(file.path) === "prose" || (file.previousPath !== undefined && fileTypeOf(file.previousPath) === "prose"))) {
      importsKnown ??= true;
      const exists = async (path: string): Promise<boolean> => {
        beforeRequest?.();
        try {
          if (target.host.pathKind !== undefined) return (await target.host.pathKind(ref.repository, path, target.headSha, scope)) !== "none";
          return (await target.host.fileAtRevision(ref.repository, path, target.headSha, scope, { maxBytes: 2_000_000 })) !== undefined;
        } catch {
          return true; // it could not be asked: it may be there
        }
      };
      const read = async (path: string): Promise<{ body: string | undefined } | undefined> => {
        beforeRequest?.();
        try { return { body: await target.host.fileAtRevision(ref.repository, path, target.headSha, scope, { maxBytes: INSTRUCTION_READ_MAX_BYTES }) }; } catch { return undefined; }
      };
      // Instruction files: the roots, the ones in the folders of the changed files, then what each of them imports, to a depth of five.
      const folders = [...new Set(all.flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]).flatMap((path) => {
        const parts = path.split("/").slice(0, -1);
        return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
      }))];
      if (folders.length > NESTED_FOLDERS_MAX) importsKnown = false;
      const nested = folders.slice(0, NESTED_FOLDERS_MAX).flatMap((folder) => NESTED_INSTRUCTION_NAMES.map((name) => `${folder}/${name}`));
      const queue: Array<{ path: string; depth: number }> = [...INSTRUCTION_ROOTS, ...nested].map((path) => ({ path, depth: 0 }));
      const seen = new Set<string>();
      let followed = 0;
      while (queue.length > 0) {
        const { path, depth } = queue.shift()!;
        if (seen.has(path)) continue;
        seen.add(path);
        if (depth > 0 && ++followed > IMPORTED_FILES_MAX) { importsKnown = false; break; }
        const got = await read(path);
        if (got === undefined) { importsKnown = false; continue; }
        const body = got.body;
        if (body === undefined) continue;
        for (const imported of importsOf(path, body)) {
          imports.add(factKey(target.repositoryId, imported));
          if (depth + 1 > IMPORT_DEPTH_MAX) importsKnown = false;
          else if (!seen.has(imported) && fileTypeOf(imported) !== "code") queue.push({ path: imported, depth: depth + 1 });
        }
      }
      // A folder that holds instruction files and cannot be listed may hold files that were not read.
      for (const folder of INSTRUCTION_FOLDERS) if (await exists(folder)) importsKnown = false;
      // A repository that builds a documentation site compiles or runs its documents.
      docsSite = false;
      for (const probe of DOCS_SITE_PROBES) if (await exists(probe)) { docsSite = true; break; }
    }
    // Symbolic links, where the host can tell (the port's own optional read).
    if (target.host.pathKind !== undefined) {
      for (const file of listed.slice(0, PATH_KINDS_READ_MAX)) {
        beforeRequest?.();
        const kind = await target.host.pathKind(ref.repository, file.path, target.headSha, scope);
        if (kind === "symlink") links.add(factKey(target.repositoryId, file.path));
      }
      // Past the limit the kind is not asked: unknown is risky, never "not a link".
      for (const file of listed.slice(PATH_KINDS_READ_MAX)) unchecked.add(factKey(target.repositoryId, file.path));
    }
  }
  return { text, instructionImports: imports, ...(importsKnown === undefined ? {} : { importsKnown }), links, unchecked, ...(docsSite === undefined ? {} : { docsSite }) };
}

/** What the tier is computed from: the files of every change request of the task (as the host lists them), and the facts of `readHeadFacts`. A host that cannot answer THROWS. */
export async function readTierInput(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, scope: HostScope, beforeRequest?: () => void): Promise<TierReadInput> {
  const files: TierFile[] = [];
  let complete = true;
  for (const target of targets) {
    const read = tierFilesOfRead(target.repositoryId, await readChangeRequestFiles(target.host, changeRequestRef(target.repositoryUrl, target.number), scope, beforeRequest));
    complete &&= read.complete;
    files.push(...read.files);
  }
  return { diff: { files, complete: complete && targets.length > 0 }, head: await readHeadFacts(targets, files, scope, beforeRequest) };
}

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const digestOf = (lines: readonly string[]): string => createHash("sha1").update(lines.join("\n")).digest("hex");

/**
 * The head commit and the merge base a tier is bound to. One repository whose commit ids have 40 hex characters: its own head and the base commit the task's code was built on. Anything else (several repositories, or a repository
 * whose ids have 64 characters, as SHA-256 repositories do) is bound by a 40-hex digest of each repository's name, head and base, in repository order, so any push to any of them changes it. A base that is not known (or any head that
 * is not a commit id) is left out; the tier is then bound to the head alone.
 */
export function boundCommits(entries: ReadonlyArray<{ repositoryId: string; headSha: string; baseCommitSha?: string | undefined }>): { headSha?: string; mergeBase?: string } {
  const sorted = [...entries].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const isId = (value: string | undefined): value is string => value !== undefined && (SHA40.test(value) || SHA64.test(value));
  if (sorted.length === 0 || sorted.some((entry) => !isId(entry.headSha))) return {};
  const baseKnown = sorted.every((entry) => isId(entry.baseCommitSha));
  if (sorted.length === 1 && SHA40.test(sorted[0]!.headSha) && (!baseKnown || SHA40.test(sorted[0]!.baseCommitSha!))) return { headSha: sorted[0]!.headSha, ...(baseKnown ? { mergeBase: sorted[0]!.baseCommitSha! } : {}) };
  return {
    headSha: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.headSha}`)),
    ...(baseKnown ? { mergeBase: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.baseCommitSha!}`)) } : {}),
  };
}

/**
 * What the reviewer floor is given, read from the code host at the pinned head by the same read the merge gate makes: the paths and the patch text in the one canonical form (`canonicalPatchText`), so the digest the floor
 * records is the digest the gate recomputes. A caller never builds the patch text itself.
 */
export async function readReviewInput(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, scope: HostScope, beforeRequest?: () => void): Promise<{ files: string[]; patchText: string; diff: DiffInput }> {
  const read = await readTierInput(targets, scope, beforeRequest);
  return { files: read.diff.files.map((file) => file.path), patchText: canonicalPatchText(read.diff.files), diff: read.diff };
}
