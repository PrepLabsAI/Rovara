// Spec 025 FR-043: add the agentx MCP server to Claude Code, Codex or Cursor without touching
// any other entry, and say exactly what changed. --print only prints the entry.
//
// The entry only runs the published CLI (`npx -y @charterarc/agentx@<version> [--env <name>] mcp`);
// it never holds a token: the MCP server reads the developer sign-in from the system token store.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentXError } from "@agentx/contracts";
import { parse as parseToml, TomlError } from "smol-toml";

export type McpClientKind = "claude-code" | "codex" | "cursor";
export const MCP_CLIENTS: readonly McpClientKind[] = ["claude-code", "codex", "cursor"];
export interface McpEntry { command: "npx"; args: string[] }
export interface RunResult { code: number; stdout: string; stderr: string }
export interface McpInstallDeps { home: string; run(command: string, args: readonly string[]): Promise<RunResult>; version?: string | undefined }
type Edit = { text: string; action: "added" | "replaced" };

/** R26: the packed release's version, or latest for a CLI built from source. */
export function mcpEntry(version: string | undefined, env: string | undefined): McpEntry {
  return { command: "npx", args: ["-y", `@charterarc/agentx@${version ?? "latest"}`, ...(env === undefined ? [] : ["--env", env]), "mcp"] };
}

const tomlBlock = (entry: McpEntry) => ["[mcp_servers.agentx]", `command = ${JSON.stringify(entry.command)}`, `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
const OURS = /^\s*\[\s*mcp_servers\.agentx(\.[^\]]+)?\s*\]\s*(#.*)?$/;
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

/** The parsed file with mcp_servers.agentx set to the entry: what the edited file must parse to. */
function withEntry(document: Record<string, unknown>, entry: McpEntry): Record<string, unknown> {
  const copy = structuredClone(document);
  const servers = copy.mcp_servers;
  copy.mcp_servers = { ...(typeof servers === "object" && servers !== null && !Array.isArray(servers) ? servers : {}), agentx: { command: entry.command, args: [...entry.args] } };
  return copy;
}

/**
 * Our table, and every sub-table of it, replaced in place; comments and blank lines that lead into
 * the next table stay with it. Every other byte stays as it was. The edit is then checked by
 * parsing: the new file must parse to the old one with only mcp_servers.agentx changed, so a file
 * that defines agentx some other way is refused rather than guessed at.
 */
export function codexToml(existing: string | undefined, entry: McpEntry): Edit {
  const byHand = (why: string) => agentXError("CONFIG_INVALID", `~/.codex/config.toml ${why}, so this command will not edit it; add the entry by hand:\n${tomlBlock(entry).join("\n")}`);
  const base = existing ?? "";
  const original = tomlOf(base);
  if (!("value" in original)) throw byHand(`is not valid TOML${original.line === undefined ? "" : ` (line ${original.line})`}`);
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
    if (OURS.test(line)) {
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
  if (!("value" in edited) || !isDeepStrictEqual(edited.value, withEntry(original.value, entry))) throw byHand("defines mcp_servers or agentx in a form this command does not edit");
  return result;
}

/** The file's own indentation (a tab or a number of spaces), 2 spaces when it has none. */
function indentOf(text: string): string | number {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  if (indent === undefined) return 2;
  return indent.startsWith("\t") ? "\t" : indent.length;
}

export function cursorJson(existing: string | undefined, entry: McpEntry): Edit {
  const byHand = `add this under "mcpServers" by hand: "agentx": ${JSON.stringify(entry)}`;
  let document: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json is not plain JSON, so this command will not edit it; ${byHand}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json is not a JSON object; ${byHand}`);
    document = parsed as Record<string, unknown>;
  }
  const servers = document.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw agentXError("CONFIG_INVALID", `~/.cursor/mcp.json has an mcpServers that is not an object; ${byHand}`);
  const current = (servers as Record<string, unknown>).agentx;
  if (existing !== undefined && isDeepStrictEqual(current, entry)) return { text: existing, action: "replaced" };
  const action = Object.hasOwn(servers, "agentx") ? "replaced" : "added";
  return { text: `${JSON.stringify({ ...document, mcpServers: { ...(servers as Record<string, unknown>), agentx: entry } }, null, indentOf(existing ?? ""))}\n`, action };
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
 * points at is the one written. Returns the backup's path, if one was written.
 */
async function replaceFile(path: string, text: string, previous: string | undefined): Promise<string | undefined> {
  const isLink = await lstat(path).then((stats) => stats.isSymbolicLink(), () => false);
  const target = isLink ? await realpath(path) : path;
  await mkdir(dirname(target), { recursive: true });
  const mode = previous === undefined ? undefined : (await stat(target)).mode & 0o7777;
  const backup = previous === undefined ? undefined : `${target}.agentx-backup`;
  if (backup !== undefined) await writeAtomically(backup, previous!, mode);
  await writeAtomically(target, text, mode);
  return backup;
}

const readIfPresent = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

const NEXT = "Start a new session of your AI tool, and sign in if you have not yet: npx @charterarc/agentx login <your AgentX URL>\n";

export async function installMcp(kind: McpClientKind, options: { print: boolean; env?: string }, deps: McpInstallDeps): Promise<string> {
  const entry = mcpEntry(deps.version, options.env);
  if (kind === "claude-code") {
    const add = ["mcp", "add", "--scope", "user", "agentx", "--", entry.command, ...entry.args];
    const command = `claude ${add.join(" ")}`;
    if (options.print) return `${command}\n`;
    const manual = `run this yourself once Claude Code is installed:\n  ${command}`;
    try {
      // A failed remove means there was no entry to replace.
      await deps.run("claude", ["mcp", "remove", "--scope", "user", "agentx"]);
      const result = await deps.run("claude", add);
      if (result.code !== 0) throw agentXError("CONFIG_INVALID", `claude mcp add failed (${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}); ${manual}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw agentXError("CONFIG_INVALID", `Claude Code's claude command was not found; ${manual}`);
      throw error;
    }
    return `Added agentx to Claude Code for your user:\n  ${command}\n${NEXT}`;
  }
  const path = kind === "codex" ? join(deps.home, ".codex", "config.toml") : join(deps.home, ".cursor", "mcp.json");
  const shown = kind === "codex" ? tomlBlock(entry).join("\n") : JSON.stringify({ mcpServers: { agentx: entry } }, null, 2);
  if (options.print) return `${shown}\n`;
  const previous = await readIfPresent(path);
  const result = kind === "codex" ? codexToml(previous, entry) : cursorJson(previous, entry);
  if (result.text === previous) return `The agentx entry in ${path} is already up to date:\n${shown}\n${NEXT}`;
  const backup = await replaceFile(path, result.text, previous);
  return `${result.action === "added" ? "Added" : "Replaced"} the agentx entry in ${path}${backup === undefined ? "" : ` (the old file is at ${backup})`}:\n${shown}\n${NEXT}`;
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
