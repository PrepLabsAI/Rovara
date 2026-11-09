// Knowledge resolver (K1, C1): the pluggable reader contract.
//
// A reader knows one team's rule-file convention: where its files live, how to tell them apart, and how their front matter maps to an
// activation mode. The resolver (resolve.ts) asks every registered reader where to look, lists those places through a verified file
// source and hands each file to the reader that accepts its path. Adding a format is adding a reader; nothing else changes.
import type { FormatParseResult, KnowledgeFormat } from "./model.js";

export interface KnowledgeDiscovery {
  /** Directories (repository-relative, no trailing slash) scanned, to a bounded depth, for files `accepts` takes. */
  directories?: readonly string[];
  /** Exact files at the repository root, or at a path below it (`.github/copilot-instructions.md`). */
  rootFiles?: readonly string[];
  /** File names looked for in every folder on the way from the repository root to a file in play (nested guidance). */
  nestedNames?: readonly string[];
  /** Folders where this tool keeps hooks. Rovara finds them and never runs them. */
  hookDirectories?: readonly string[];
  /** Folders where this tool keeps skills (read from the meta repo only). */
  skillDirectories?: readonly string[];
}

export interface KnowledgeParseContext {
  /** The folder the file sits in (`""` at the root). */
  scopeDir: string;
  /** True for a file below the repository root that is found by `nestedNames`. */
  nested: boolean;
}

export interface KnowledgeFormatReader {
  readonly id: KnowledgeFormat;
  readonly discovery: KnowledgeDiscovery;
  /** Whether this reader owns `path` (repository-relative, `/`-separated). */
  accepts(path: string): boolean;
  /** Reads one file's text (hidden characters already removed). A file the reader cannot map is `{ ok: false, reason }`, never guessed. */
  parse(path: string, text: string, context: KnowledgeParseContext): FormatParseResult;
}

/** A file name without its folders and extension: the `#name` of a manual rule. */
export function ruleStem(path: string, extraSuffixes: readonly string[] = []): string {
  let name = path.slice(path.lastIndexOf("/") + 1);
  for (const suffix of extraSuffixes) if (name.endsWith(suffix)) { name = name.slice(0, -suffix.length); return name; }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
