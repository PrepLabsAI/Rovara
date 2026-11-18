// Spec 025 FR-043: add the rovara MCP server to Claude Code, Codex or Cursor without touching
// any other entry, and say exactly what changed. --print only prints the entry. An entry this
// command wrote under its old name (agentx) is upgraded: removed when the new one is written.
//
// The entry only runs the published CLI (`npx -y @preplabsai/rovara-code@<version> [--env <name>] mcp`);
// it never holds a token: the MCP server reads the developer sign-in from the system token store.
import { CLI_PACKAGE_NAME, CLI_COMMAND_NAME } from "@agentx/contracts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentXError } from "@agentx/contracts";
import { parse as parseToml, TomlError } from "smol-toml";

/** The server entry name written into a client's settings, and the name this command used before. */
export const MCP_SERVER_NAME = "rovara";
export const LEGACY_MCP_SERVER_NAME = "agentx";

export type McpClientKind = "claude-code" | "codex" | "cursor";
export const MCP_CLIENTS: readonly McpClientKind[] = ["claude-code", "codex", "cursor"];
export interface McpEntry { command: "npx"; args: string[] }
export interface RunResult { code: number; stdout: string; stderr: string }
export interface McpInstallDeps {
  home: string;
  /** Codex's settings folder when CODEX_HOME is set; ~/.codex otherwise. */
  codexHome?: string | undefined;
  run(command: string, args: readonly string[]): Promise<RunResult>;
  version?: string | undefined;
}
type Edit = { text: string; action: "added" | "replaced" };

/** R26: the packed release's version, or latest for a CLI built from source. */
export function mcpEntry(version: string | undefined, env: string | undefined): McpEntry {
  return { command: "npx", args: ["-y", `${CLI_PACKAGE_NAME}@${version ?? "latest"}`, ...(env === undefined ? [] : ["--env", env]), "mcp"] };
}

const tomlBlock = (entry: McpEntry) => [`[mcp_servers.${MCP_SERVER_NAME}]`, `command = ${JSON.stringify(entry.command)}`, `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
const OURS = /^\s*\[\s*mcp_servers\.rovara(\.[^\]]+)?\s*\]\s*(#.*)?$/;
const LEGACY = /^\s*\[\s*mcp_servers\.agentx(\.[^\]]+)?\s*\]\s*(#.*)?$/;

/** What `claude mcp get <name>` prints for an entry that runs `npx` with our published package (or the very old one). */
function claudeEntryIsOurs(output: string): boolean {
  const command = /^\s*Command:\s*(.+)$/m.exec(output)?.[1]?.trim();
  const args = /^\s*Args:\s*(.*)$/m.exec(output)?.[1] ?? "";
  return command === "npx" && /(^|[\s/])(agentx|rovara-code)(@|\s|$)|@charterarc\/agentx|@preplabsai\/rovara-code/.test(args);
}

/** An old entry is ours to upgrade only when it still runs our published CLI through npx; a hand-made one stays. */
function isOurLegacyEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { command, args } = value as { command?: unknown; args?: unknown };
  return command === "npx" && Array.isArray(args) && args.some((arg) => typeof arg === "string" && /(^|\/)(agentx|rovara-code)(@|$)/.test(arg));
}
const TABLE = /^\s*\[/;
const KEEP_WITH_NEXT = /^\s*(#.*)?$/;

/** Parses TOML, or undefined when it does not parse; the parser's message is never shown, since it quotes the file. */
function tomlOf(text: string): { value: Record<string, unknown> } | { line: number | undefined } {
  try {
    return { value: parseToml(text) };
  } catch (error) {
    if (error instanceof TomlError) return { line: error.line };
    throw error;
  }
}

/**
 * The same value with every table as an ordinary object. smol-toml 1.9 returns tables with a null prototype,
 * and isDeepStrictEqual compares prototypes, so tables built here would never equal tables it parsed.
 * Arrays are copied element by element and anything else (strings, numbers, TomlDate) is kept as it is.
 */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== null && prototype !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
}

/** The parsed file with mcp_servers.rovara set to the entry (and our old agentx entry gone, when asked): what the edited file must parse to. */
function withEntry(document: Record<string, unknown>, entry: McpEntry, dropLegacy: boolean): Record<string, unknown> {
  // Shallow copies only: a deep clone would turn the parser's TomlDate values into plain Dates,
  // and then no file holding a date or time would ever compare equal.
  const servers = document.mcp_servers;
  const next: Record<string, unknown> = { ...(typeof servers === "object" && servers !== null && !Array.isArray(servers) ? servers : {}) };
  if (dropLegacy) delete next[LEGACY_MCP_SERVER_NAME];
  next[MCP_SERVER_NAME] = { command: entry.command, args: [...entry.args] };
  return { ...document, mcp_servers: next };
}

/**
 * Our table, and every sub-table of it, replaced in place; comments and blank lines that lead into
 * the next table stay with it. Every other byte stays as it was. The edit is then checked by
 * parsing: the new file must parse to the old one with only mcp_servers.rovara changed (and our own old
 * mcp_servers.agentx table removed), so a file that defines the entry some other way is refused rather than guessed at.
 */
export function codexToml(existing: string | undefined, entry: McpEntry, path = "~/.codex/config.toml"): Edit {
  const byHand = (why: string) => agentXError("CONFIG_INVALID", `${path} ${why}; add the entry by hand:\n${tomlBlock(entry).join("\n")}`);
  const base = existing ?? "";
  const original = tomlOf(base);
  if (!("value" in original)) throw byHand(`is not valid TOML${original.line === undefined ? "" : ` (line ${original.line})`}, so this command will not edit it`);
  const legacyValue = (original.value.mcp_servers as Record<string, unknown> | undefined)?.[LEGACY_MCP_SERVER_NAME];
  const dropLegacy = legacyValue !== undefined && isOurLegacyEntry(plain(legacyValue));
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const lines = base.split(eol);
  const kept: string[] = [];
  let insertAt = -1;
  let buffer: string[] | undefined;
  const leaveOurs = () => {
    if (buffer === undefined) return;
    let cut = buffer.length;
    while (cut > 0 && KEEP_WITH_NEXT.test(buffer[cut - 1]!)) cut -= 1;
    kept.push(...buffer.slice(cut));
    buffer = undefined;
  };
  for (const line of lines) {
    if (OURS.test(line) || (dropLegacy && LEGACY.test(line))) {
      if (insertAt === -1) insertAt = kept.length;
      buffer = [];
      continue;
    }
    if (buffer !== undefined && TABLE.test(line)) leaveOurs();
    if (buffer !== undefined) buffer.push(line);
    else kept.push(line);
  }
  leaveOurs();
  let result: Edit;
  if (insertAt !== -1) {
    kept.splice(insertAt, 0, ...tomlBlock(entry));
    result = { text: kept.join(eol), action: "replaced" };
  } else {
    const separator = base === "" ? "" : base.endsWith(eol) ? eol : `${eol}${eol}`;
    result = { text: `${base}${separator}${tomlBlock(entry).join(eol)}${eol}`, action: "added" };
  }
  const edited = tomlOf(result.text);
  if (!("value" in edited) || !isDeepStrictEqual(plain(edited.value), plain(withEntry(original.value, entry, dropLegacy)))) throw byHand(`defines ${CLI_COMMAND_NAME} in a form this command cannot edit safely`);
  return result;
}

/** The file's own indentation (a tab or a number of spaces), 2 spaces when it has none. */
function indentOf(text: string): string | number {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  if (indent === undefined) return 2;
  return indent.startsWith("\t") ? "\t" : indent.length;
}

export function cursorJson(existing: string | undefined, entry: McpEntry, path = "~/.cursor/mcp.json"): Edit {
  const byHand = `add this under "mcpServers" by hand: "${MCP_SERVER_NAME}": ${JSON.stringify(entry)}`;
  let document: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw agentXError("CONFIG_INVALID", `${path} is not plain JSON, so this command will not edit it; ${byHand}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw agentXError("CONFIG_INVALID", `${path} is not a JSON object; ${byHand}`);
    document = parsed as Record<string, unknown>;
  }
  const servers = document.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw agentXError("CONFIG_INVALID", `${path} has an mcpServers that is not an object; ${byHand}`);
  const known = servers as Record<string, unknown>;
  const dropLegacy = Object.hasOwn(known, LEGACY_MCP_SERVER_NAME) && isOurLegacyEntry(known[LEGACY_MCP_SERVER_NAME]);
  if (existing !== undefined && !dropLegacy && isDeepStrictEqual(known[MCP_SERVER_NAME], entry)) return { text: existing, action: "replaced" };
  const action = Object.hasOwn(known, MCP_SERVER_NAME) || dropLegacy ? "replaced" : "added";
  const next: Record<string, unknown> = { ...known };
  if (dropLegacy) delete next[LEGACY_MCP_SERVER_NAME];
  next[MCP_SERVER_NAME] = entry;
  return { text: `${JSON.stringify({ ...document, mcpServers: next }, null, indentOf(existing ?? ""))}\n`, action };
}

/** Writes beside the file and renames over it, so a reader sees the old file or the new one, never half of one. */
async function writeAtomically(path: string, text: string, mode: number | undefined): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Replaces the file atomically with the same permissions, keeping the old one beside it as
 * <file>.agentx-backup. A symbolic link (a dotfiles checkout, say) stays a link: the file it
 * points at is the one written, while the backup goes beside the link, never into the folder the
 * link points at. Returns the backup's path, if one was written.
 */
async function replaceFile(path: string, text: string, previous: string | undefined, isLink: boolean): Promise<string | undefined> {
  const target = isLink ? await realpath(path) : path;
  await mkdir(dirname(target), { recursive: true });
  const mode = previous === undefined ? undefined : (await stat(target)).mode & 0o7777;
  const backup = previous === undefined ? undefined : `${path}.agentx-backup`;
  if (backup !== undefined) await writeAtomically(backup, previous!, mode);
  await writeAtomically(target, text, mode);
  return backup;
}

/** True when the path, followed through any link, names something that exists. */
const exists = (path: string) => stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

const readIfPresent = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

const NEXT = `Start a new session of your AI tool, and sign in if you have not yet: npx ${CLI_PACKAGE_NAME} login <your Rovara URL>\n`;

export async function installMcp(kind: McpClientKind, options: { print: boolean; env?: string }, deps: McpInstallDeps): Promise<string> {
  const entry = mcpEntry(deps.version, options.env);
  if (kind === "claude-code") {
    const add = ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", entry.command, ...entry.args];
    const command = `claude ${add.join(" ")}`;
    if (options.print) return `${command}\n`;
    const manual = `run this yourself once Claude Code is installed:\n  ${command}`;
    try {
      // A failed remove means there was no entry to replace.
      const removed = (await deps.run("claude", ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME])).code === 0;
      // An entry this command wrote under its old name (agentx) is upgraded: removed before the new one is added.
      // It is read first, and only an entry that runs our published CLI through npx is ours; a hand-made one stays.
      const legacy = await deps.run("claude", ["mcp", "get", LEGACY_MCP_SERVER_NAME]);
      const removedLegacy = legacy.code === 0 && claudeEntryIsOurs(legacy.stdout)
        && (await deps.run("claude", ["mcp", "remove", "--scope", "user", LEGACY_MCP_SERVER_NAME])).code === 0;
      const result = await deps.run("claude", add);
      if (result.code !== 0) {
        const failed = `claude mcp add failed (${result.stderr.trim().slice(0, 300) || `exit ${result.code}`})`;
        // Final review M4: the old entry is gone, so say so, and how to put agentx back.
        throw agentXError("CONFIG_INVALID", removed || removedLegacy
          ? `${failed}; the previous ${CLI_COMMAND_NAME} entry was removed; add it back with:\n  ${command}`
          : `${failed}; ${manual}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw agentXError("CONFIG_INVALID", `Claude Code's claude command was not found; ${manual}`);
      throw error;
    }
    return `Added ${CLI_COMMAND_NAME} to Claude Code for your user:\n  ${command}\n${NEXT}`;
  }
  const path = kind === "codex" ? join(deps.codexHome ?? join(deps.home, ".codex"), "config.toml") : join(deps.home, ".cursor", "mcp.json");
  const shown = kind === "codex" ? tomlBlock(entry).join("\n") : JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2);
  if (options.print) return `${shown}\n`;
  const isLink = await lstat(path).then((stats) => stats.isSymbolicLink(), () => false);
  if (isLink && !(await exists(path))) throw agentXError("CONFIG_INVALID", `${path} is a symbolic link, and the link points at a missing file; fix or remove the link and run this again, or add the entry by hand:\n${shown}`);
  const previous = await readIfPresent(path);
  const result = kind === "codex" ? codexToml(previous, entry, path) : cursorJson(previous, entry, path);
  if (result.text === previous) return `The ${CLI_COMMAND_NAME} entry in ${path} is already up to date:\n${shown}\n${NEXT}`;
  const backup = await replaceFile(path, result.text, previous, isLink);
  return `${result.action === "added" ? "Added" : "Replaced"} the ${CLI_COMMAND_NAME} entry in ${path}${backup === undefined ? "" : ` (the old file is at ${backup})`}:\n${shown}\n${NEXT}`;
}

/** The real runner: exit code and output, never a shell. */
export function runCommand(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return reject(Object.assign(new Error(error.message), { code: "ENOENT" }));
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
