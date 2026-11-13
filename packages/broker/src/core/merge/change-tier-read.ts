// The change tier's input from the code host: the files of each change request of a task, read as the host reports them (never what an agent says), and the commits the tier is bound to.
// A host that gives no patch text for a file leaves it unreadable, and the classifier then treats the file as risky (fail closed); the port is not changed.
import { createHash } from "node:crypto";
import type { ChangeRequestFile, CodeHost, HostScope } from "@agentx/contracts";
import { changedFilesFromHostFiles, plainChangedPath } from "../proof/changed-files.js";
import { factKey, type DiffInput, type HeadFacts, type TierFile } from "../decisions/change-tier.js";
import { fileTypeOf, normalizedTierPath } from "../decisions/sensitive-list.js";
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
const INSTRUCTION_ROOTS = ["AGENTS.md", "CLAUDE.md", "AGENT.md", "GEMINI.md", ".github/copilot-instructions.md"] as const;
const INSTRUCTION_READ_MAX_BYTES = 100_000;
const DOCUMENT_READ_MAX_BYTES = 200_000;
/** The most host reads one tier spends on facts beyond the file list. */
const DOCUMENTS_READ_MAX = 20;
const PATH_KINDS_READ_MAX = 40;

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
  for (const target of targets) {
    const ref = changeRequestRef(target.repositoryUrl, target.number);
    const listed = files.filter((file) => file.repository === target.repositoryId && file.status !== "removed");
    // Documents: the text at the head, so a changed line's heading and block are known.
    const documents = listed.filter((file) => fileTypeOf(file.path) === "prose").slice(0, DOCUMENTS_READ_MAX);
    for (const document of documents) {
      beforeRequest?.();
      const body = await target.host.fileAtRevision(ref.repository, document.path, target.headSha, scope, { maxBytes: DOCUMENT_READ_MAX_BYTES }).catch(() => undefined);
      if (body !== undefined) text.set(factKey(target.repositoryId, document.path), body);
    }
    // Instruction files at the head: what they import is an instruction too.
    if (documents.length > 0) {
      importsKnown ??= true;
      for (const root of INSTRUCTION_ROOTS) {
        beforeRequest?.();
        try {
          const body = await target.host.fileAtRevision(ref.repository, root, target.headSha, scope, { maxBytes: INSTRUCTION_READ_MAX_BYTES });
          if (body !== undefined) for (const imported of importsOf(root, body)) imports.add(factKey(target.repositoryId, imported));
        } catch {
          importsKnown = false;
        }
      }
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
  return { text, instructionImports: imports, ...(importsKnown === undefined ? {} : { importsKnown }), links, unchecked };
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

const SHA = /^[a-f0-9]{40}$/u;
const digestOf = (lines: readonly string[]): string => createHash("sha1").update(lines.join("\n")).digest("hex");

/**
 * The head commit and the merge base a tier is bound to. One repository: its own head and the base commit the task's code was built on. Several: a 40-hex digest of each repository's name, head and base, in repository order,
 * so any push to any of them changes it. A base that is not known (or any head that is not a commit) is left out; the tier is then bound to the head alone.
 */
export function boundCommits(entries: ReadonlyArray<{ repositoryId: string; headSha: string; baseCommitSha?: string | undefined }>): { headSha?: string; mergeBase?: string } {
  const sorted = [...entries].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (sorted.length === 0 || sorted.some((entry) => !SHA.test(entry.headSha))) return {};
  const bases = sorted.map((entry) => entry.baseCommitSha);
  const baseKnown = bases.every((base) => base !== undefined && SHA.test(base));
  if (sorted.length === 1) return { headSha: sorted[0]!.headSha, ...(baseKnown ? { mergeBase: sorted[0]!.baseCommitSha! } : {}) };
  return {
    headSha: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.headSha}`)),
    ...(baseKnown ? { mergeBase: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.baseCommitSha!}`)) } : {}),
  };
}
