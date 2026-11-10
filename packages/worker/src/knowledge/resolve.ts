// Knowledge resolver (K1, C2): finds, reads, activates and budgets the team's knowledge for one stage.
//
// What it does, for each repository source it is given (the meta repo at its pinned commit, and each code repo at the base commit or in
// the working tree):
//   1. discovers rule files: fixed root files, the folders the readers name (bounded depth and count), and nested AGENTS.md / CLAUDE.md in
//      the folders on the way to the files in play;
//   2. reads each one through the source (verified for a commit), removes hidden characters, and lets its format reader map the front
//      matter to an activation mode;
//   3. decides per item whether this stage loads it (always / fileMatch against the files in play / manual named as `#name` / auto);
//   4. follows imports, inside the same repository and the same source;
//   5. fits the result to the size budgets, dropping farthest-first and listing every drop.
// The outcome is the items to show the model, a text-free record of everything considered, and fixed-wording notices. Nothing here
// stores rule text, logs a path, or reads outside the sources it is handed.
import { createHash } from "node:crypto";
import type { MetaSkillSnapshot } from "@agentx/contracts";
import { COMPANY_RULES_EXCEED_BUDGET_MESSAGE, agentXError, assertCompanyRulesWithinBudget } from "@agentx/contracts";
import { inertContextText, inertLabel } from "../context-text.js";
import { applyBudget } from "./budget.js";
import { firstMatchingPattern } from "./glob.js";
import { expandImports, type ImportRead, type ImportStyle } from "./imports.js";
import {
  DEFAULT_KNOWLEDGE_BUDGETS,
  JUDGING_STAGES_FOR_AUTO,
  KNOWLEDGE_LAYER_ORDER,
  MAX_DIRECTORIES_PER_REPOSITORY,
  MAX_DISCOVERY_DEPTH,
  MAX_FILES_PER_REPOSITORY,
  type KnowledgeActivation,
  type KnowledgeBudgets,
  type KnowledgeFormat,
  type KnowledgeItem,
  type KnowledgeLayer,
  type KnowledgeReadAt,
  type KnowledgeStage,
  type ParsedKnowledgeFile,
  type SkipReason,
} from "./model.js";
import { createReaderRegistry, type ReaderRegistry } from "./registry.js";
import { folderOf, type KnowledgeFormatReader } from "./reader.js";
import { rovaraRulesReader } from "./rovara-rules.js";
import type { MetaSkillSkip } from "./skills.js";
import type { DirectoryEntry, KnowledgeFileSource } from "./source.js";

// The company rules' limits and the refusal's first words are the contracts' (decision 57.6: 30 rules, 600 characters each, 12,000 in all); the broker checks the same ones before it sends a step.
export { COMPANY_RULES_EXCEED_BUDGET_MESSAGE };

const MAX_FILES_IN_PLAY = 1_000;
const MAX_NOTICES = 20;

export interface FileInPlay {
  /** The repository the path is in; absent when the caller does not know (it then counts for every repository). */
  repo?: string;
  /** Repository-relative, `/`-separated. */
  path: string;
}

export interface KnowledgeSourceEntry {
  /** The repository's name in the project. */
  name: string;
  /** Its checkout folder in the workspace (for labels only). */
  path: string;
  layer: "meta" | "repo";
  source: KnowledgeFileSource;
  /** Extra steering folders (a project's `knowledge.steering`), read with Rovara's own rule format. */
  extraRuleDirectories?: readonly string[];
  /**
   * Judging stages only: the checked-out files of the same repository. A rule file that differs between them (edited, added or removed by
   * the change under judgement) gets a fixed-wording notice; the working tree's text is never loaded.
   */
  compareWith?: KnowledgeFileSource;
}

export interface ResolveKnowledgeInput {
  stage: KnowledgeStage;
  sources: readonly KnowledgeSourceEntry[];
  /** Company, group and project rules from "How we work", already normalised. A locked one is never dropped. */
  external?: readonly KnowledgeItem[];
  filesInPlay?: readonly FileInPlay[];
  /** `#name` tokens that name manual rules: from the request, an owner message, the approved plan, or ticked in the start box. */
  manualNames?: ReadonlySet<string>;
  /** Judging stages: the `auto` rules the Plan stage loaded. Their own choice never widens it (Q9). */
  plannedAuto?: ReadonlySet<string>;
  registry?: ReaderRegistry;
  budgets?: KnowledgeBudgets;
}

export type LoadReason =
  | { kind: "always" }
  | { kind: "required" }
  | { kind: "matched"; detail: string }
  | { kind: "named"; detail: string }
  | { kind: "read_by_tool" };

/** One considered item, without its text. The loaded-knowledge manifest is made from these. */
export interface KnowledgeRecord {
  layer: KnowledgeLayer;
  repo?: string;
  path?: string;
  scopeDir: string;
  format: KnowledgeFormat;
  activation?: KnowledgeActivation;
  patterns?: string[];
  name?: string;
  bytes: number;
  digest?: string;
  fileDigest?: string;
  readAt?: KnowledgeReadAt;
  locked?: boolean;
  status: "loaded" | "skipped" | "available";
  why?: LoadReason;
  reason?: SkipReason;
}

export interface AutoCatalogEntry {
  name: string;
  description: string;
  repo?: string;
  path?: string;
}

export interface ResolvedKnowledge {
  /** The items to show the model, in stacking order (the closest last). */
  items: KnowledgeItem[];
  /** `auto` items the model may load with `read_knowledge` (non-judging stages), by name. */
  autoCatalog: AutoCatalogEntry[];
  autoItems: Map<string, KnowledgeItem>;
  /** Manual items not loaded now, by lower-case name: a later `#name` or a tool call can load them. */
  manualItems: Map<string, KnowledgeItem>;
  /** Items whose `fileMatch` did not hit yet: the mid-run extension loads them when a file they match is touched. */
  pendingMatches: KnowledgeItem[];
  records: KnowledgeRecord[];
  notices: string[];
  /** Fixed-wording lines for the worker's log. They never carry a path or any text from a file. */
  diagnostics: string[];
  /** The meta repo's skills the session was given, by reference (no text). Filled by the loader, which reads skills beside the rules. */
  skills: MetaSkillSnapshot[];
  /** Skills found in the meta repo and left out, with a fixed reason. */
  skippedSkills: MetaSkillSkip[];
  budget: { alwaysOnBytes: number; alwaysOnLimitBytes: number; additionsBytes: number; additionsLimitBytes: number; skipped: number };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A path from a plan, a diff or a request as one bounded, printable string for a manifest line. */
export function displayPath(path: string): string {
  return path.slice(0, 200).replace(/[^\x20-\x7e]/gu, "?");
}

function normalisedFilesInPlay(files: readonly FileInPlay[] | undefined): FileInPlay[] {
  const kept: FileInPlay[] = [];
  const seen = new Set<string>();
  for (const file of files ?? []) {
    const path = file.path.replace(/^\.\//u, "");
    if (path === "" || path.length > 400 || path.startsWith("/") || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) continue;
    const key = `${file.repo ?? ""}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...(file.repo === undefined ? {} : { repo: file.repo }), path });
    if (kept.length >= MAX_FILES_IN_PLAY) break;
  }
  return kept;
}

interface Candidate {
  path: string;
  nested: boolean;
  scopeDir: string;
  reader: KnowledgeFormatReader;
}

interface SkippedCandidate {
  path: string;
  reader?: KnowledgeFormatReader;
  scopeDir: string;
  reason: SkipReason;
}

interface Discovery {
  candidates: Candidate[];
  skipped: SkippedCandidate[];
  hooks: string[];
  diagnostics: string[];
}

/** The listing cache for one source: a folder is listed once, and no more than MAX_DIRECTORIES_PER_REPOSITORY folders are listed at all. */
function directoryLister(source: KnowledgeFileSource): (directory: string) => Promise<DirectoryEntry[] | undefined> {
  const cache = new Map<string, DirectoryEntry[] | undefined>();
  return async (directory) => {
    if (cache.has(directory)) return cache.get(directory);
    if (cache.size >= MAX_DIRECTORIES_PER_REPOSITORY) return undefined;
    const entries = (await source.listDirectory(directory))?.toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    cache.set(directory, entries);
    return entries;
  };
}

async function discover(
  source: KnowledgeFileSource,
  registry: ReaderRegistry,
  extraDirectories: readonly string[],
  filePathsInPlay: readonly string[],
): Promise<Discovery> {
  const list = directoryLister(source);
  const candidates: Candidate[] = [];
  const skipped: SkippedCandidate[] = [];
  const hooks: string[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate): boolean => {
    if (seen.has(candidate.path)) return true;
    if (candidates.length >= MAX_FILES_PER_REPOSITORY) {
      if (!diagnostics.includes("too many rule files: the first ones were read")) diagnostics.push("too many rule files: the first ones were read");
      return false;
    }
    seen.add(candidate.path);
    candidates.push(candidate);
    return true;
  };
  const consider = (entry: DirectoryEntry, path: string, scopeDir: string, nested: boolean, reader: KnowledgeFormatReader | undefined): void => {
    if (reader === undefined) return;
    if (entry.kind === "symlink") { skipped.push({ path, reader, scopeDir, reason: "symlink" }); return; }
    if (entry.kind === "file") add({ path, nested, scopeDir, reader });
  };

  // 1. Fixed files: the root's AGENTS.md and CLAUDE.md, `.github/copilot-instructions.md`, `.claude/CLAUDE.md`.
  for (const file of registry.rootFiles()) {
    const folder = folderOf(file);
    const entry = (await list(folder))?.find((candidate) => candidate.name === baseName(file));
    if (entry !== undefined) consider(entry, file, "", false, registry.readerFor(file));
  }

  // 2. Rule folders, to a bounded depth.
  const walk = async (directory: string, depth: number, extra: boolean): Promise<void> => {
    const entries = await list(directory);
    if (entries === undefined) return;
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.kind === "dir") {
        if (depth + 1 < MAX_DISCOVERY_DEPTH) await walk(path, depth + 1, extra);
        continue;
      }
      // A steering folder a project names is read in Rovara's own format; every other folder is its readers'.
      const reader = extra ? (entry.name.endsWith(".md") ? rovaraRulesReader : undefined) : registry.readerFor(path);
      consider(entry, path, "", false, reader);
    }
  };
  for (const directory of registry.directories()) await walk(directory, 0, false);
  for (const directory of extraDirectories) await walk(directory, 0, true);

  // 3. Hooks are found but never run.
  // Hooks are found, never run: Rovara does not run repository hooks, and the panel says so. Which folders hold them is each reader's knowledge.
  for (const directory of registry.hookDirectories()) {
    for (const entry of (await list(directory)) ?? []) if (entry.kind === "file") hooks.push(`${directory}/${entry.name}`);
  }

  // 4. Nested guidance in the folders on the way to the files in play.
  const folders = new Set<string>();
  for (const file of filePathsInPlay) {
    const parts = file.split("/");
    for (let length = 1; length < parts.length; length += 1) folders.add(parts.slice(0, length).join("/"));
  }
  for (const folder of [...folders].toSorted()) {
    const entries = await list(folder);
    if (entries === undefined) continue;
    for (const name of registry.nestedNames()) {
      const entry = entries.find((candidate) => candidate.name === name);
      const path = `${folder}/${name}`;
      if (entry !== undefined) consider(entry, path, folder, true, registry.readerFor(path));
    }
  }
  return { candidates, skipped, hooks, diagnostics };
}

/** AGENTS.override.md replaces AGENTS.md in the same folder; a second spelling of one name (AGENTS.MD, CLAUDE.MD) is a duplicate. */
function collapseNames(candidates: readonly Candidate[]): { kept: Candidate[]; dropped: SkippedCandidate[] } {
  const kept: Candidate[] = [];
  const dropped: SkippedCandidate[] = [];
  const names = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const folder = folderOf(candidate.path);
    names.set(folder, (names.get(folder) ?? new Set()).add(baseName(candidate.path)));
  }
  for (const candidate of candidates) {
    const present = names.get(folderOf(candidate.path))!;
    const name = baseName(candidate.path);
    const drop = (reason: SkipReason): void => { dropped.push({ path: candidate.path, reader: candidate.reader, scopeDir: candidate.scopeDir, reason }); };
    if ((name === "AGENTS.md" || name === "AGENTS.MD") && present.has("AGENTS.override.md")) drop("overridden");
    else if (name === "AGENTS.MD" && present.has("AGENTS.md")) drop("duplicate");
    else if (name === "CLAUDE.MD" && present.has("CLAUDE.md")) drop("duplicate");
    else kept.push(candidate);
  }
  return { kept, dropped };
}

interface ReadCandidate {
  candidate: Candidate;
  parsed: ParsedKnowledgeFile;
  /** The file's own text (after front matter), hidden characters removed. */
  text: string;
  fileDigest: string;
}

interface ReadOutcome {
  read: ReadCandidate[];
  skipped: SkippedCandidate[];
  /** Digest of each candidate's whole stripped text, or a fixed marker, by path: what the edit notice compares. */
  signatures: Map<string, string>;
  removedHidden: number;
}

async function readCandidates(source: KnowledgeFileSource, candidates: readonly Candidate[], perFileBytes: number): Promise<ReadOutcome> {
  const read: ReadCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  const signatures = new Map<string, string>();
  let removedHidden = 0;
  for (const candidate of candidates) {
    const result = await source.readFile(candidate.path, perFileBytes);
    const skip = (reason: SkipReason): void => {
      skipped.push({ path: candidate.path, reader: candidate.reader, scopeDir: candidate.scopeDir, reason });
      signatures.set(candidate.path, `skipped:${reason}`);
    };
    if (result.kind === "too_large") { skip("too_large"); continue; }
    if (result.kind === "symlink") { skip("symlink"); continue; }
    if (result.kind !== "file") { skip("unreadable"); continue; }
    const { text, removed } = inertContextText(result.content);
    removedHidden += removed;
    signatures.set(candidate.path, `file:${sha256(text)}`);
    const fileDigest = sha256(result.content);
    const parsed = candidate.reader.parse(candidate.path, text, { scopeDir: candidate.scopeDir, nested: candidate.nested });
    if (!parsed.ok) { skipped.push({ path: candidate.path, reader: candidate.reader, scopeDir: candidate.scopeDir, reason: parsed.reason }); continue; }
    read.push({ candidate, parsed: parsed.value, text: parsed.value.body, fileDigest });
  }
  return { read, skipped, signatures, removedHidden };
}

const layerOf = (entry: KnowledgeSourceEntry, scopeDir: string): KnowledgeLayer => (scopeDir !== "" ? "folder" : entry.layer === "meta" ? "meta" : "repo");

function activationDecision(
  item: { parsed: ParsedKnowledgeFile; layer: KnowledgeLayer; scopeDir: string },
  context: {
    stage: KnowledgeStage;
    entryName: string;
    filesInPlay: readonly FileInPlay[];
    manualNames: ReadonlySet<string>;
    /** The plan's auto set; undefined when it is not known (judging stages then load every auto rule, a safe superset). */
    plannedAuto: ReadonlySet<string> | undefined;
    pathName: string | undefined;
  },
): { action: "load"; why: LoadReason } | { action: "skip"; reason: SkipReason } | { action: "auto" } {
  const { parsed } = item;
  if (parsed.excludeStages?.includes(context.stage) === true) return { action: "skip", reason: "excluded_stage" };
  if (parsed.activation === "always") return { action: "load", why: { kind: "always" } };
  if (parsed.activation === "fileMatch") {
    const patterns = parsed.patterns ?? [];
    // A meta repo's rules speak for the whole project: they match the files of every repository. Anything else matches its own repository's files.
    const wide = item.layer === "meta";
    for (const file of context.filesInPlay) {
      if (!wide && file.repo !== undefined && file.repo !== context.entryName) continue;
      const hit = firstMatchingPattern(patterns, file.path) ?? (wide && file.repo !== undefined ? firstMatchingPattern(patterns, `${file.repo}/${file.path}`) : undefined);
      if (hit !== undefined) return { action: "load", why: { kind: "matched", detail: displayPath(file.path) } };
    }
    return { action: "skip", reason: "not_matched" };
  }
  if (parsed.activation === "manual") {
    const name = (parsed.name ?? context.pathName ?? "").toLowerCase();
    return name !== "" && context.manualNames.has(name) ? { action: "load", why: { kind: "named", detail: displayPath(name) } } : { action: "skip", reason: "not_requested" };
  }
  // auto: the non-judging stages list them and let the model read one by name. Judging stages (plan check, review) load, from the same
  // commits, the rules the plan chose PLUS any whose patterns the diff hits, so a planner that drops a rule cannot hide it from them. When
  // the plan's set is not known they load every auto rule: more rules than the plan chose, never fewer.
  if (JUDGING_STAGES_FOR_AUTO.has(context.stage)) {
    const name = (parsed.name ?? "").toLowerCase();
    if (context.plannedAuto === undefined) return { action: "load", why: { kind: "named", detail: displayPath(name) } };
    if (context.plannedAuto.has(name)) return { action: "load", why: { kind: "named", detail: displayPath(name) } };
    for (const file of context.filesInPlay) {
      if (file.repo !== undefined && file.repo !== context.entryName && item.layer !== "meta") continue;
      const hit = firstMatchingPattern(parsed.patterns ?? [], file.path);
      if (hit !== undefined) return { action: "load", why: { kind: "matched", detail: displayPath(file.path) } };
    }
    return { action: "skip", reason: "not_in_plan_set" };
  }
  return { action: "auto" };
}

const importStyleOf = (parsed: ParsedKnowledgeFile): ImportStyle => parsed.imports;

function recordOf(item: KnowledgeItem, status: KnowledgeRecord["status"], extra: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    layer: item.layer,
    ...(item.repo === undefined ? {} : { repo: item.repo }),
    ...(item.path === undefined ? {} : { path: item.path }),
    scopeDir: item.scopeDir,
    format: item.format,
    activation: item.activation,
    ...(item.patterns === undefined ? {} : { patterns: item.patterns }),
    ...(item.name === undefined ? {} : { name: item.name }),
    bytes: item.bytes,
    digest: item.digest,
    ...(item.fileDigest === undefined ? {} : { fileDigest: item.fileDigest }),
    readAt: item.readAt,
    ...(item.locked === true ? { locked: true } : {}),
    status,
    ...extra,
  };
}

export async function resolveKnowledge(input: ResolveKnowledgeInput): Promise<ResolvedKnowledge> {
  const registry = input.registry ?? createReaderRegistry();
  const budgets = input.budgets ?? DEFAULT_KNOWLEDGE_BUDGETS;
  const filesInPlay = normalisedFilesInPlay(input.filesInPlay);
  const manualNames = new Set([...(input.manualNames ?? [])].map((name) => name.toLowerCase()));
  const plannedAuto = input.plannedAuto === undefined ? undefined : new Set([...input.plannedAuto].map((name) => name.toLowerCase()));
  const records: KnowledgeRecord[] = [];
  const notices: string[] = [];
  const diagnostics: string[] = [];
  const toLoad: Array<{ item: KnowledgeItem; why: LoadReason }> = [];
  const autoItems = new Map<string, KnowledgeItem>();
  const manualItems = new Map<string, KnowledgeItem>();
  const pendingMatches: KnowledgeItem[] = [];
  const autoCatalog: AutoCatalogEntry[] = [];

  // Company rules (decision 57.6): 30 rules, 600 characters each, 12,000 in all. Over the limit the stage fails closed with a clear error; no rule is ever cut or dropped to fit.
  assertCompanyRulesWithinBudget((input.external ?? []).filter((item) => item.layer === "company"));
  for (const external of input.external ?? []) toLoad.push({ item: external, why: external.locked === true ? { kind: "required" } : { kind: "always" } });

  for (const entry of input.sources) {
    const ownFiles = filesInPlay.filter((file) => file.repo === undefined || file.repo === entry.name);
    const found = await discover(entry.source, registry, entry.extraRuleDirectories ?? [], ownFiles.map((file) => file.path));
    diagnostics.push(...found.diagnostics);
    const collapsed = collapseNames(found.candidates);
    const outcome = await readCandidates(entry.source, collapsed.kept, budgets.perFileBytes);
    if (outcome.removedHidden > 0) diagnostics.push(`removed ${outcome.removedHidden} hidden characters from the rule files of ${inertLabel(entry.name)}`);

    const skippedRecord = (skip: SkippedCandidate): void => {
      records.push({
        layer: layerOf(entry, skip.scopeDir), repo: entry.name, path: skip.path, scopeDir: skip.scopeDir,
        format: skip.reader?.id ?? "unknown", bytes: 0, readAt: entry.source.readAt, status: "skipped", reason: skip.reason,
      });
    };
    for (const skip of [...found.skipped, ...collapsed.dropped, ...outcome.skipped]) skippedRecord(skip);
    for (const hook of found.hooks) {
      records.push({ layer: layerOf(entry, ""), repo: entry.name, path: hook, scopeDir: "", format: "kiro_hook", bytes: 0, readAt: entry.source.readAt, status: "skipped", reason: "found_not_run" });
    }

    // Decide, then follow imports for what loads. Imports already pulled in by an earlier item are not repeated.
    const loadedPaths = new Set<string>();
    const decisions = outcome.read.map((read) => {
      const layer = layerOf(entry, read.candidate.scopeDir);
      const decision = activationDecision({ parsed: read.parsed, layer, scopeDir: read.candidate.scopeDir }, {
        stage: input.stage, entryName: entry.name, filesInPlay, manualNames, plannedAuto,
        pathName: read.parsed.name,
      });
      if (decision.action === "load") loadedPaths.add(read.candidate.path);
      return { read, layer, decision };
    });
    const included = new Set<string>();
    const readImport = async (path: string): Promise<ImportRead> => {
      const result = await entry.source.readFile(path, budgets.perFileBytes);
      if (result.kind === "file") return { kind: "file", text: result.content };
      return result.kind === "too_large" ? { kind: "too_large" } : { kind: "missing" };
    };
    for (const { read, layer, decision } of decisions) {
      const { candidate, parsed } = read;
      const loading = decision.action === "load";
      const expanded = decision.action === "skip" && decision.reason === "excluded_stage"
        ? undefined
        : await expandImports({
            text: read.text, path: candidate.path, style: importStyleOf(parsed), maxDepth: budgets.importDepth,
            budgetBytes: Math.max(0, budgets.perFileBytes - bytesOf(read.text)),
            // An item that is not loaded now (it may load later) never makes a loaded item skip an import.
            alreadyIncluded: new Set([...loadedPaths, ...(loading ? included : [])]), read: readImport,
            listDirectory: async (directory) => (await entry.source.listDirectory(directory))?.map((child) => child.name).toSorted(),
          });
      if (loading) for (const imported of expanded?.imported ?? []) included.add(imported);
      // Hidden characters are removed from the whole expanded text, so imported text and folder listings are covered as well as the file itself.
      const text = inertContextText(expanded?.text ?? read.text).text;
      const item: KnowledgeItem = {
        layer, repo: entry.name, path: candidate.path, scopeDir: candidate.scopeDir, format: candidate.reader.id,
        activation: parsed.activation, ...(parsed.patterns === undefined ? {} : { patterns: parsed.patterns }),
        ...(parsed.name === undefined ? {} : { name: parsed.name }), ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.excludeStages === undefined ? {} : { excludeStages: parsed.excludeStages }),
        bytes: bytesOf(text), digest: sha256(text), fileDigest: read.fileDigest, readAt: entry.source.readAt, text,
      };
      if (decision.action === "load") { toLoad.push({ item, why: decision.why }); continue; }
      if (decision.action === "auto") {
        const name = (parsed.name ?? "").toLowerCase();
        if (name !== "" && !autoItems.has(name)) {
          autoItems.set(name, item);
          autoCatalog.push({ name: parsed.name!, description: parsed.description ?? "", repo: entry.name, path: candidate.path });
        }
        records.push(recordOf(item, "available"));
        continue;
      }
      if (decision.reason === "not_requested") manualItems.set((parsed.name ?? "").toLowerCase(), item);
      if (decision.reason === "not_matched") pendingMatches.push(item);
      records.push(recordOf(item, "skipped", { reason: decision.reason }));
    }

    if (entry.compareWith !== undefined) {
      const working = await discover(entry.compareWith, registry, entry.extraRuleDirectories ?? [], ownFiles.map((file) => file.path));
      const workingRead = await readCandidates(entry.compareWith, collapseNames(working.candidates).kept, budgets.perFileBytes);
      const changed = [...new Set([...outcome.signatures.keys(), ...workingRead.signatures.keys()])]
        .filter((path) => outcome.signatures.get(path) !== workingRead.signatures.get(path))
        .toSorted();
      for (const path of changed.slice(0, MAX_NOTICES)) {
        notices.push(`This change edits ${inertLabel(path)} of ${inertLabel(entry.name)}. Review that edit as code; the rules above are the ones from before the change.`);
      }
      if (changed.length > MAX_NOTICES) notices.push(`This change edits ${changed.length - MAX_NOTICES} more rule files of ${inertLabel(entry.name)}. Review those edits as code.`);
    }
  }

  // Budgets: two pools, each dropped farthest-first; every drop is listed.
  const fitted = applyBudget(toLoad.map(({ item }) => item), budgets);
  if (fitted.alwaysOn.lockedOverflow) throw agentXError("CONFIG_INVALID", COMPANY_RULES_EXCEED_BUDGET_MESSAGE);
  const dropped = new Set<KnowledgeItem>([...fitted.alwaysOn.dropped, ...fitted.additions.dropped]);
  for (const { item, why } of toLoad) {
    records.push(dropped.has(item) ? recordOf(item, "skipped", { reason: "over_budget" }) : recordOf(item, "loaded", { why }));
  }
  const order = (item: KnowledgeItem): number => KNOWLEDGE_LAYER_ORDER.indexOf(item.layer);
  const items = toLoad
    .map(({ item }) => item)
    .filter((item) => !dropped.has(item))
    .toSorted((left, right) => order(left) - order(right) || (left.repo ?? "").localeCompare(right.repo ?? "") || (left.path ?? "").localeCompare(right.path ?? ""));
  return {
    items, autoCatalog, autoItems, manualItems, pendingMatches, records, notices, diagnostics, skills: [], skippedSkills: [],
    budget: {
      alwaysOnBytes: fitted.alwaysOn.bytes, alwaysOnLimitBytes: budgets.alwaysOnBytes,
      additionsBytes: fitted.additions.bytes, additionsLimitBytes: budgets.additionsBytes,
      skipped: records.filter((record) => record.status === "skipped" && record.reason === "over_budget").length,
    },
  };
}

/** A company, group or project rule from "How we work" as an item. Locked company rules are never dropped. */
export function externalRuleItem(input: { layer: "company" | "group" | "project"; name: string; text: string; locked?: boolean }): KnowledgeItem {
  const { text } = inertContextText(input.text);
  return {
    layer: input.layer, scopeDir: "", format: "rovara_rule", activation: "always", name: input.name,
    bytes: bytesOf(text), digest: sha256(text), readAt: "working", ...(input.locked === true ? { locked: true } : {}), text,
  };
}
