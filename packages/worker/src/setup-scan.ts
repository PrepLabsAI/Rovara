// Meta repo lane B (K1, task B2): the part of the setup agent that is plain code, not a model. It looks at the cloned repositories for what a person would find by listing
// folders: where the team keeps its rules, skills, specs and runbooks, which spec format is in use, which MCP servers a repository's config names, which hooks it has, and
// a project file in another tool's format (`kalmius/project.json`, read by the generic importer below). Everything it finds is a CITED proposal item in the model's own answer
// format, so the reader (contracts `sanitizeSetupProposal`) treats it exactly like a model's: same limits, same citation rules, and the broker re-reads every citation.
//
// What it never does:
//   - it never follows a link: every part of a path is `lstat`ed, and a symbolic link (or anything that is not a plain file or folder) is skipped;
//   - it reads at most 64 KiB of a file, and only the few files it names (an MCP config, a settings file, a project file); folders are listed, not read;
//   - from an MCP config it takes the NAMES of the servers and nothing else (never an address, a command, an argument or an environment value);
//   - nothing in a repository's hooks or MCP config is run or connected: both are reported as "found, not used".
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { META_KNOWLEDGE_DEFAULTS, PROVENANCE_QUOTE_MAX as QUOTE_MAX } from "@rovara-code/contracts";

export interface ScanRepository { name: string; path: string }

export interface SetupScan {
  /** Items in the model's answer format (flat, with `from`), by category. */
  repositories: unknown[];
  setup: unknown[];
  tests: unknown[];
  checks: unknown[];
  knowledge: unknown[];
  sources: unknown[];
  specTarget?: unknown;
  foundNotUsed: Array<{ kind: "hook" | "mcp_config"; repo: string; path: string }>;
  notes: string[];
}

const FILE_READ_MAX = 65_536;
const WALK_ENTRIES_MAX = 200;
/** All the folder entries one scan may list, across every folder and repository: one default folder could otherwise cost 200 x 200 listings, and there are many default folders. */
export const SCAN_ENTRIES_BUDGET = 2_000;

/** What is left of a scan's listing budget; `spent` is set when a listing was cut short for want of it. */
interface Budget { left: number; spent: boolean }
const SERVER_NAMES_MAX = 16;
const NAME_LIKE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;

/** The MCP configs a repository may carry, in the places the common tools put them. They are reported, never connected. */
export const MCP_CONFIG_PATHS = [".mcp.json", ".kiro/settings/mcp.json", ".pi/mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"] as const;
/** Root files that are always-on rules, and the documents a project is usually described by. */
const ROOT_RULE_FILES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;
const KEY_DOC_FILES = ["ARCHITECTURE.md", "DESIGN.md", "docs/ARCHITECTURE.md", "docs/architecture.md", "CONTRIBUTING.md"] as const;
const KNOWLEDGE_DIRS = [
  { kind: "rule", paths: META_KNOWLEDGE_DEFAULTS.steering },
  { kind: "skill", paths: META_KNOWLEDGE_DEFAULTS.skills },
  { kind: "spec", paths: META_KNOWLEDGE_DEFAULTS.specs },
  { kind: "runbook", paths: META_KNOWLEDGE_DEFAULTS.runbooks },
] as const;
/** Another tool's project file, read by the generic importer. The path is the only tool-specific thing in this file. */
export const PROJECT_FILE_IMPORTERS = [{ path: "kalmius/project.json" }] as const;
const NATIVE_CONFIG_PATHS = [".rovara/project.yaml", ".rovara/project.yml", ".rovara/project.json"] as const;
const DOC_FILE = /\.(?:md|mdc|mdx|txt)$/iu;

type Kind = "file" | "directory";

/** What `relative` is inside `root`, looking at every part of the path without following a link; undefined when any part is missing, a link, or the wrong kind. */
async function plain(root: string, relative: string, wanted: Kind): Promise<boolean> {
  let current = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      const last = index === parts.length - 1;
      if (last ? (wanted === "file" ? !info.isFile() : !info.isDirectory()) : !info.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readText(root: string, relative: string, max = FILE_READ_MAX): Promise<string | undefined> {
  if (!await plain(root, relative, "file")) return undefined;
  let handle;
  try {
    handle = await open(join(root, relative), "r");
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    return bytesRead > max ? undefined : buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function names(root: string, relative: string, budget: Budget): Promise<Array<{ name: string; kind: Kind }>> {
  if (budget.left <= 0) { budget.spent = true; return []; }
  if (!await plain(root, relative, "directory")) return [];
  try {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    const listed = entries
      .filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" as const : "file" as const }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    // Each listing costs one, plus one for each entry it returns.
    const kept = listed.slice(0, Math.min(WALK_ENTRIES_MAX, Math.max(0, budget.left - 1)));
    if (kept.length < listed.length) budget.spent = true;
    budget.left -= kept.length + 1;
    return kept;
  } catch {
    return [];
  }
}

/** The first document file under a folder (shallowest first, then by name), at most three levels deep; undefined for an empty folder. */
async function firstDocument(root: string, relative: string, budget: Budget, depth = 0): Promise<string | undefined> {
  const entries = await names(root, relative, budget);
  for (const entry of entries) if (entry.kind === "file" && DOC_FILE.test(entry.name)) return `${relative}/${entry.name}`;
  if (depth >= 2) return undefined;
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const found = await firstDocument(root, `${relative}/${entry.name}`, budget, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const cite = (repo: string, path: string, extra: Record<string, unknown> = {}) => ({ kind: "file", repo, path, ...extra });

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Everything the scan finds in the meta repository (knowledge, specs) and in every repository (MCP configs, hooks, project files). */
export async function scanRepositories(rootPath: string, repositories: readonly ScanRepository[], options: { metaRepo?: string | undefined; entriesBudget?: number } = {}): Promise<SetupScan> {
  const scan: SetupScan = { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] };
  const metaName = options.metaRepo ?? (repositories.length === 1 ? repositories[0]!.name : undefined);
  if (options.metaRepo !== undefined && !repositories.some((repository) => repository.name === options.metaRepo)) {
    scan.notes.push("The meta repository was not among the repositories Rovara could read, so its rules, skills and specs were not looked at.");
  }
  const budget: Budget = { left: options.entriesBudget ?? SCAN_ENTRIES_BUDGET, spent: false };
  for (const repository of repositories) {
    const root = join(rootPath, repository.path);
    if (repository.name === metaName) await scanKnowledge(root, repository.name, scan, budget);
    await scanConfigs(root, repository.name, scan, budget);
  }
  if (budget.spent) scan.notes.push("The folders were too large to list in full, so some rules, skills or specs may not be listed.");
  return scan;
}

async function scanKnowledge(root: string, repo: string, scan: SetupScan, budget: Budget): Promise<void> {
  for (const path of ROOT_RULE_FILES) {
    if (await plain(root, path, "file")) scan.knowledge.push({ path, kind: "rule", activation: "always", confidence: "high", from: [cite(repo, path)] });
  }
  for (const group of KNOWLEDGE_DIRS) {
    for (const path of group.paths) {
      const first = await firstDocument(root, path, budget);
      if (first !== undefined) scan.knowledge.push({ path, kind: group.kind, confidence: "high", from: [cite(repo, first)] });
    }
  }
  for (const path of KEY_DOC_FILES) {
    if (await plain(root, path, "file")) scan.knowledge.push({ path, kind: "keyDoc", confidence: "medium", from: [cite(repo, path)] });
  }
  // Spec formats. Kiro keeps a folder per feature with requirements (or bugfix), design and tasks; Spec Kit keeps `specs/<number>-<name>/spec.md`.
  for (const feature of await names(root, ".kiro/specs", budget)) {
    if (feature.kind !== "directory") continue;
    for (const file of ["requirements.md", "bugfix.md", "design.md", "tasks.md"]) {
      const path = `.kiro/specs/${feature.name}/${file}`;
      if (await plain(root, path, "file")) { scan.specTarget = { format: "kiro", path: ".kiro/specs", confidence: "high", from: [cite(repo, path)] }; break; }
    }
    if (scan.specTarget !== undefined) break;
  }
  if (scan.specTarget === undefined) {
    for (const feature of await names(root, "specs", budget)) {
      if (feature.kind !== "directory") continue;
      const path = `specs/${feature.name}/spec.md`;
      if (await plain(root, path, "file")) { scan.specTarget = { format: "spec_kit", path: "specs", confidence: "medium", from: [cite(repo, path)] }; break; }
    }
  }
  for (const path of NATIVE_CONFIG_PATHS) {
    if (await plain(root, path, "file")) {
      scan.notes.push(`${repo} already has ${path}. Rovara applies that file from the pending change it shows after a push, not from this proposal.`);
      break;
    }
  }
}

async function scanConfigs(root: string, repo: string, scan: SetupScan, budget: Budget): Promise<void> {
  for (const path of MCP_CONFIG_PATHS) {
    const config = parseJson(await readText(root, path));
    if (!isObject(config)) continue;
    const servers = isObject(config["mcpServers"]) ? config["mcpServers"] : isObject(config["servers"]) ? config["servers"] : undefined;
    if (servers === undefined) continue;
    scan.foundNotUsed.push({ kind: "mcp_config", repo, path });
    for (const name of Object.keys(servers).slice(0, SERVER_NAMES_MAX)) {
      // The NAME only. A name that is not plain (an address, a token) is not carried.
      if (NAME_LIKE.test(name)) scan.sources.push({ name, foundIn: "mcp_config", confidence: "high", from: [cite(repo, path)] });
    }
  }
  if ((await names(root, ".kiro/hooks", budget)).length > 0) scan.foundNotUsed.push({ kind: "hook", repo, path: ".kiro/hooks" });
  const claudeSettings = parseJson(await readText(root, ".claude/settings.json"));
  if (isObject(claudeSettings) && isObject(claudeSettings["hooks"]) && Object.keys(claudeSettings["hooks"]).length > 0) scan.foundNotUsed.push({ kind: "hook", repo, path: ".claude/settings.json" });
  for (const importer of PROJECT_FILE_IMPORTERS) {
    const text = await readText(root, importer.path);
    const value = parseJson(text);
    if (value !== undefined) importProjectFile(value, repo, importer.path, scan, text);
  }
}

// ---- the generic project-file importer

const REPO_URL = /^https:\/\/[^\s/@]+\/[^\s?#]+$/u;
const first = (source: Record<string, unknown>, keys: readonly string[]): unknown => keys.map((key) => source[key]).find((value) => value !== undefined);
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 32) : []);

/**
 * Reads another tool's project file (a JSON object) into proposal items, by the field names such files commonly use. The shape is a GUESS (`[I]`: no sample was available when
 * this was written); a field it does not recognise is ignored and a value it cannot use is left out. Each item cites the file, so the broker re-reads it like any other. Only
 * ever PROPOSES: nothing from the file is applied without a person's tick.
 *   repositories | repos: [{ name?, url | repository | git | remote, branch | defaultBranch }]   (https URLs only)
 *   setup | setupCommands | install:  { <repo>: [commands] }  or  [{ repo, commands }]
 *   tests | test | testCommands:      { <repo>: [commands] | { commands } }  or  [{ repo, commands }]
 *   checks: [{ name, repo, command }]
 * Because the field names are a guess, every item is `low` confidence. An item cites the line(s) of the file that hold its value, with that line as the quote, so the broker can
 * check the quote supports the value; when a value cannot be found on a line of the text, the item cites the file with no quote and is never shown as checked.
 */
export function importProjectFile(value: unknown, repo: string, path: string, scan: Pick<SetupScan, "repositories" | "setup" | "tests" | "checks">, text?: string): void {
  if (!isObject(value)) return;
  const lines = text === undefined ? [] : text.split(/\r\n|\r|\n/u);
  /** The citation(s) of the lines that hold every one of these values; one plain citation (no quote) when a value is on no line, or its line is too long to quote whole. */
  const fromOf = (values: readonly string[]): Array<Record<string, unknown>> => {
    const found = new Map<number, string>();
    for (const wanted of values) {
      const needle = JSON.stringify(wanted);
      const index = lines.findIndex((line) => line.includes(needle));
      const quote = index < 0 ? "" : (lines[index] ?? "").trim().replace(/\s+/gu, " ");
      if (index < 0 || quote.length > QUOTE_MAX) return [cite(repo, path)];
      found.set(index + 1, quote);
    }
    return found.size === 0 || found.size > 8 ? [cite(repo, path)] : [...found].map(([line, quote]) => cite(repo, path, { line, quote }));
  };
  const repositories = first(value, ["repositories", "repos"]);
  for (const entry of Array.isArray(repositories) ? repositories.slice(0, 31) : []) {
    const source = typeof entry === "string" ? { url: entry } : isObject(entry) ? entry : undefined;
    if (source === undefined) continue;
    const url = first(source, ["url", "repository", "git", "remote"]);
    if (typeof url !== "string" || !REPO_URL.test(url)) continue;
    const name = typeof source["name"] === "string" ? source["name"] : url.replace(/\.git$/u, "").split("/").pop() ?? "";
    const branch = first(source, ["defaultBranch", "branch"]);
    scan.repositories.push({ name, url, ...(typeof branch === "string" ? { defaultBranch: branch } : {}), confidence: "low", from: fromOf([url]) });
  }
  const commandItems = (raw: unknown, target: unknown[]): void => {
    if (Array.isArray(raw)) {
      for (const entry of raw.slice(0, 32)) {
        if (isObject(entry) && typeof entry["repo"] === "string") { const list = stringList(entry["commands"]); target.push({ repo: entry["repo"], commands: list, confidence: "low", from: fromOf(list) }); }
      }
    } else if (isObject(raw)) {
      for (const [name, commands] of Object.entries(raw).slice(0, 32)) {
        const list = isObject(commands) ? stringList(commands["commands"]) : stringList(commands);
        target.push({ repo: name, commands: list, confidence: "low", from: fromOf(list) });
      }
    }
  };
  commandItems(first(value, ["setup", "setupCommands", "install"]), scan.setup);
  commandItems(first(value, ["tests", "test", "testCommands"]), scan.tests);
  const checks = value["checks"];
  for (const entry of Array.isArray(checks) ? checks.slice(0, 20) : []) {
    if (isObject(entry) && typeof entry["name"] === "string" && typeof entry["repo"] === "string" && typeof entry["command"] === "string") {
      scan.checks.push({ name: entry["name"], repo: entry["repo"], command: entry["command"], confidence: "low", from: fromOf([entry["command"]]) });
    }
  }
}
