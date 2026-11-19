// L4-EINT: the two readers of the stand-in writer's request (standin-shapes.ts), now real. They read the TRACKED files of the repositories a setup run was given (never an untracked file, never a link, a bounded number of files and
// bytes) and answer NAMES, KINDS and SHAPES only: `StandInTableSeam` and `StandInOperationSeam` have no value field, so nothing a reader copies can be a row or an answer.
//   - tables (E3's schema reading, from the repository's own SQL): each `CREATE TABLE` in a tracked `.sql` file, with its columns' kinds and which are keys (primary or foreign). A table or column the writer's request refuses is left out whole.
//   - operations (E6's contract finder): each operation of a tracked OpenAPI description (`openapi*.yaml|json`, `swagger*`) for the host its `servers` names, with the SHAPE of the example answer the description's own schema gives.
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { parse } from "yaml";
import { buildOpenApiFake, isEvalStandInPlanHost, standInOperationsOf, type StandInColumnKind, type StandInOperationSeam, type StandInTableSeam } from "@agentx/contracts";
import type { SetupAgentRepository } from "./setup-agent.js";
import type { TrackedPaths } from "./setup-citations.js";

export const STANDIN_READ_LIMITS = { files: 64, fileBytes: 524_288, totalBytes: 4 * 1_048_576, tables: 64 } as const;
const OPENAPI_NAME = /(?:^|[/._-])(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/iu;
const SQL_NAME = /\.sql$/iu;

async function readTracked(directory: string, relative: string, budget: { bytes: number }): Promise<string | undefined> {
  try {
    const root = await realpath(directory);
    const path = join(root, relative);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > STANDIN_READ_LIMITS.fileBytes || budget.bytes + info.size > STANDIN_READ_LIMITS.totalBytes) return undefined;
    const real = await realpath(path);
    if (!real.startsWith(`${root}${sep}`)) return undefined;
    const handle = await open(real, "r");
    try { const text = (await handle.readFile()).toString("utf8"); budget.bytes += info.size; return text; } finally { await handle.close(); }
  } catch { return undefined; }
}

const trackedFiles = (repository: SetupAgentRepository, tracked: TrackedPaths, pattern: RegExp): string[] => [...(tracked.get(repository.name) ?? [])].filter((path) => pattern.test(path) && !path.split("/").some((part) => part === "node_modules" || part === "vendor")).sort().slice(0, STANDIN_READ_LIMITS.files);

// ---- operations

/** The host a description's `servers` names (the first https one that is a plain outside name), or undefined. */
export function openApiHostOf(document: unknown): string | undefined {
  const servers = typeof document === "object" && document !== null ? (document as { servers?: unknown }).servers : undefined;
  if (!Array.isArray(servers)) return undefined;
  for (const server of servers.slice(0, 8)) {
    const url = typeof server === "object" && server !== null ? (server as { url?: unknown }).url : undefined;
    if (typeof url !== "string" || !/^https:\/\//iu.test(url)) continue;
    try { const host = new URL(url).hostname.toLowerCase(); if (isEvalStandInPlanHost(host)) return host; } catch { /* next */ }
  }
  return undefined;
}

export async function readOperationSeams(repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths): Promise<readonly StandInOperationSeam[]> {
  const out: StandInOperationSeam[] = [];
  const budget = { bytes: 0 };
  for (const repository of repositories) {
    for (const path of trackedFiles(repository, tracked, OPENAPI_NAME)) {
      const text = await readTracked(repository.directory, path, budget);
      if (text === undefined) continue;
      try {
        const document = parse(text, { maxAliasCount: 50, prettyErrors: false }) as unknown;
        const host = openApiHostOf(document);
        if (host === undefined) continue;
        const fake = buildOpenApiFake(document, path);
        if (fake.status === "built") for (const operation of standInOperationsOf(host, fake)) if (!out.some((seen) => seen.id === operation.id)) out.push(operation);
      } catch { /* a description that does not read is left out */ }
    }
  }
  return out;
}

// ---- tables

const kindOf = (type: string): StandInColumnKind => /int|serial/iu.test(type) ? "integer" : /numeric|decimal|float|double|real|money/iu.test(type) ? "number" : /bool/iu.test(type) ? "boolean" : /timestamp|date|time/iu.test(type) ? "timestamp" : "text";

/** The balanced parenthesised body starting at `open` (the index of "("), or undefined. */
function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 20_000; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return undefined;
}
const topLevelParts = (body: string): string[] => {
  const parts: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "(") depth += 1; else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
};
const unquote = (name: string): string => name.replace(/^["`[]|["`\]]$/gu, "");

/** The tables a SQL text creates, as names, kinds and keys (no value). Pure; bounded. */
export function tablesOfSql(sql: string): StandInTableSeam[] {
  const out: StandInTableSeam[] = [];
  const header = /create\s+(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:["`]?[A-Za-z_][A-Za-z0-9_]*["`]?\.)?["`]?[A-Za-z_][A-Za-z0-9_]*["`]?)\s*\(/giu;
  for (const match of sql.matchAll(header)) {
    if (out.length >= STANDIN_READ_LIMITS.tables) break;
    const body = balanced(sql, (match.index ?? 0) + match[0].length - 1);
    if (body === undefined) continue;
    const name = unquote(match[1]!.split(".").pop()!);
    const keys = new Set<string>();
    const columns: StandInTableSeam["columns"][number][] = [];
    for (const part of topLevelParts(body)) {
      const constraint = /^(?:constraint\s+\S+\s+)?(primary\s+key|foreign\s+key|unique|check|exclude|index|key|like)\b/iu.exec(part);
      if (constraint !== null) {
        if (/^(?:primary|foreign)/iu.test(constraint[1]!)) for (const column of /\(([^)]*)\)/u.exec(part)?.[1]?.split(",") ?? []) keys.add(unquote(column.trim()));
        continue;
      }
      const column = /^(["`]?[A-Za-z_][A-Za-z0-9_]*["`]?)\s+([A-Za-z_][A-Za-z0-9_ ]*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/u.exec(part);
      if (column === null) continue;
      const columnName = unquote(column[1]!);
      const maxChars = /\(\s*(\d{1,4})\s*\)/u.exec(column[2]!)?.[1];
      columns.push({ name: columnName, kind: kindOf(column[2]!), key: /primary\s+key|references\s/iu.test(part), ...(maxChars === undefined || kindOf(column[2]!) !== "text" ? {} : { maxChars: Number(maxChars) }) });
    }
    if (columns.length === 0) continue;
    out.push({ name, columns: columns.map((column) => (keys.has(column.name) ? { ...column, key: true } : column)), rows: 10 });
  }
  return out;
}

export async function readTableSeams(repositories: ReadonlyArray<SetupAgentRepository>, tracked: TrackedPaths): Promise<readonly StandInTableSeam[]> {
  const out = new Map<string, StandInTableSeam>();
  const budget = { bytes: 0 };
  for (const repository of repositories) {
    for (const path of trackedFiles(repository, tracked, SQL_NAME)) {
      const text = await readTracked(repository.directory, path, budget);
      if (text === undefined) continue;
      try { for (const table of tablesOfSql(text)) if (!out.has(table.name)) out.set(table.name, table); } catch { /* left out */ }
    }
  }
  return [...out.values()];
}
