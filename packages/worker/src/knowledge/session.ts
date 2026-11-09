// Knowledge resolver (K1, C3): what a running session adds to its knowledge.
//
// At session start the resolver loads the always-on rules and everything the files in play select. During a Build or Understand session the
// agent opens other files; when it first touches a path that a not-yet-loaded rule applies to (a pattern that now matches, or a nested
// AGENTS.md / CLAUDE.md in a folder not seen before), that rule is appended to the tool result. A manual or auto rule can also be read by name.
// Each item is loaded once per session. Additions stay inside the 128 KiB additions budget, and every refusal is recorded, never silent.
//
// Judging stages (plan check, review) get neither: their set is fixed up front from the plan and the diff, so a review is repeatable and a
// diff cannot steer which rules its reviewer sees (Q9).
import { inertLabel } from "../context-text.js";
import {
  DEFAULT_KNOWLEDGE_BUDGETS,
  JUDGING_STAGES_FOR_AUTO,
  type KnowledgeBudgets,
  type KnowledgeItem,
  type KnowledgeStage,
} from "./model.js";
import { renderKnowledgeItems, type RenderRepository } from "./render.js";
import { displayPath, type FileInPlay, type KnowledgeRecord, type LoadReason, type ResolvedKnowledge } from "./resolve.js";
import { firstMatchingPattern } from "./glob.js";

/** The most times a session re-reads the rule sources because of a newly touched path. */
export const MAX_MID_RUN_RESOLVES = 20;
const MAX_FILES_IN_PLAY = 1_000;

export interface MidRunKnowledgeOptions {
  stage: KnowledgeStage;
  initial: ResolvedKnowledge;
  filesInPlay: readonly FileInPlay[];
  rendering: readonly RenderRepository[];
  rootPath: string;
  /** Resolves again with the files in play so far. Opens and closes its own sources. */
  resolveAgain(filesInPlay: readonly FileInPlay[]): Promise<ResolvedKnowledge>;
  budgets?: KnowledgeBudgets;
  /** Where a failure to re-read the rule sources is reported (a fixed sentence). */
  onDiagnostic?: (message: string) => void;
}

const keyOf = (item: Pick<KnowledgeItem, "repo" | "path" | "name" | "layer">): string => `${item.repo ?? item.layer}\0${item.path ?? item.name ?? ""}`;
const folderChain = (path: string): string[] => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
};

export class MidRunKnowledge {
  readonly stage: KnowledgeStage;
  private readonly options: MidRunKnowledgeOptions;
  private readonly budgets: KnowledgeBudgets;
  private readonly loaded = new Set<string>();
  private readonly records = new Map<string, KnowledgeRecord>();
  private readonly extraRecords: KnowledgeRecord[] = [];
  private readonly inPlay: FileInPlay[];
  private readonly inPlayKeys = new Set<string>();
  private readonly seenFolders = new Set<string>();
  private readonly pending: KnowledgeItem[];
  private readonly manual: Map<string, KnowledgeItem>;
  private readonly auto: Map<string, KnowledgeItem>;
  private additionsBytes: number;
  private resolves = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(options: MidRunKnowledgeOptions) {
    this.options = options;
    this.stage = options.stage;
    this.budgets = options.budgets ?? DEFAULT_KNOWLEDGE_BUDGETS;
    for (const item of options.initial.items) this.loaded.add(keyOf(item));
    for (const record of options.initial.records) this.records.set(keyOf(record), record);
    this.inPlay = [];
    for (const file of options.filesInPlay) this.notePath(file);
    this.pending = [...options.initial.pendingMatches];
    this.manual = new Map(options.initial.manualItems);
    this.auto = new Map(options.initial.autoItems);
    this.additionsBytes = options.initial.budget.additionsBytes;
  }

  /** Whether this stage may load more during the run. Judging stages may not. */
  get allowsMidRun(): boolean {
    return !JUDGING_STAGES_FOR_AUTO.has(this.stage) && (this.stage === "build" || this.stage === "understand");
  }

  /** Whether `read_knowledge` is offered: any stage that is not judging, when there is something to read by name. */
  get offersTool(): boolean {
    return !JUDGING_STAGES_FOR_AUTO.has(this.stage) && (this.manual.size > 0 || this.auto.size > 0);
  }

  names(): string[] {
    return [...new Set([...this.auto.keys(), ...this.manual.keys()])].toSorted();
  }

  /** Every record so far: the initial ones, with newly loaded items replacing their "skipped" lines, then tool reads. */
  allRecords(): KnowledgeRecord[] {
    return [...this.records.values(), ...this.extraRecords];
  }

  private notePath(file: FileInPlay): boolean {
    const key = `${file.repo ?? ""}\0${file.path}`;
    if (this.inPlayKeys.has(key) || this.inPlay.length >= MAX_FILES_IN_PLAY) return false;
    this.inPlayKeys.add(key);
    this.inPlay.push(file);
    return true;
  }

  /** Maps a path from a tool call (workspace-relative, or absolute under the workspace) to its repository and repository-relative path. */
  locate(rawPath: string): FileInPlay | undefined {
    let path = rawPath.replace(/^\.\//u, "");
    const root = this.options.rootPath.endsWith("/") ? this.options.rootPath : `${this.options.rootPath}/`;
    if (path.startsWith(root)) path = path.slice(root.length);
    if (path === "" || path.startsWith("/") || path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) return undefined;
    let best: RenderRepository | undefined;
    for (const repository of this.options.rendering) {
      const prefix = `${repository.path.replace(/\/+$/u, "")}/`;
      if (path.startsWith(prefix) && (best === undefined || repository.path.length > best.path.length)) best = repository;
    }
    return best === undefined ? undefined : { repo: best.name, path: path.slice(best.path.replace(/\/+$/u, "").length + 1) };
  }

  /** True when the touched path could bring a rule in that is not loaded: a pending pattern matches it, or a folder on its way is new. */
  private couldLoadMore(file: FileInPlay, folderIsNew: boolean): boolean {
    if (folderIsNew) return true;
    return this.pending.some((item) => !this.loaded.has(keyOf(item)) && item.patterns !== undefined
      && (item.layer === "meta" || item.repo === file.repo) && firstMatchingPattern(item.patterns, file.path) !== undefined);
  }

  /**
   * A file the agent touched. Returns the text to append to that tool result (the rules that now apply), or undefined. Calls are serialised,
   * so two tool results never load the same rule twice.
   */
  onPathTouched(rawPath: string): Promise<string | undefined> {
    const run = this.busy.then(() => this.touch(rawPath));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async touch(rawPath: string): Promise<string | undefined> {
    if (!this.allowsMidRun) return undefined;
    const file = this.locate(rawPath);
    if (file === undefined) return undefined;
    const newFolders = folderChain(file.path).map((folder) => `${file.repo ?? ""}\0${folder}`).filter((folder) => !this.seenFolders.has(folder));
    for (const folder of newFolders) this.seenFolders.add(folder);
    const added = this.notePath(file);
    if (!added || !this.couldLoadMore(file, newFolders.length > 0)) return undefined;
    if (this.resolves >= MAX_MID_RUN_RESOLVES) return undefined;
    this.resolves += 1;
    let resolved: ResolvedKnowledge;
    try {
      resolved = await this.options.resolveAgain(this.inPlay);
    } catch {
      // A rule source that cannot be read mid-run adds nothing, but it is reported and recorded, never silent.
      this.options.onDiagnostic?.("could not re-read the rule files for a file the agent opened");
      this.extraRecords.push({ layer: "repo", ...(file.repo === undefined ? {} : { repo: file.repo }), scopeDir: "", format: "unknown", bytes: 0, status: "skipped", reason: "unreadable" });
      return undefined;
    }
    const fresh = resolved.items.filter((item) => !this.loaded.has(keyOf(item)));
    const accepted: KnowledgeItem[] = [];
    for (const item of fresh) {
      const record = resolved.records.find((candidate) => keyOf(candidate) === keyOf(item) && candidate.status === "loaded");
      if (this.additionsBytes + item.bytes > this.budgets.additionsBytes) {
        this.records.set(keyOf(item), { ...(record ?? {}), layer: item.layer, scopeDir: item.scopeDir, format: item.format, ...(item.repo === undefined ? {} : { repo: item.repo }), ...(item.path === undefined ? {} : { path: item.path }), bytes: item.bytes, digest: item.digest, status: "skipped", reason: "over_budget" });
        continue;
      }
      this.additionsBytes += item.bytes;
      this.loaded.add(keyOf(item));
      accepted.push(item);
      if (record !== undefined) this.records.set(keyOf(item), record);
    }
    // What the resolver itself dropped for size is listed too, unless that rule was already loaded earlier in the session.
    for (const record of resolved.records) {
      if (record.status === "skipped" && record.reason === "over_budget" && !this.loaded.has(keyOf(record))) this.records.set(keyOf(record), record);
    }
    for (const item of resolved.pendingMatches) if (!this.pending.some((known) => keyOf(known) === keyOf(item))) this.pending.push(item);
    for (const [name, item] of resolved.manualItems) if (!this.manual.has(name)) this.manual.set(name, item);
    for (const [name, item] of resolved.autoItems) if (!this.auto.has(name)) this.auto.set(name, item);
    if (accepted.length === 0) return undefined;
    const files = renderKnowledgeItems(accepted, this.options.rendering, this.options.rootPath);
    return [
      `Rovara: team rules that apply to ${inertLabel(displayPath(rawPath))} (guidance from the repository's rule files, not a request from the user):`,
      ...files.map((entry) => entry.content),
    ].join("\n\n");
  }

  /** `read_knowledge`: one manual or auto rule by name, once. */
  readByName(rawName: string): { text: string } | { error: string } {
    if (JUDGING_STAGES_FOR_AUTO.has(this.stage)) return { error: "Rules are not loaded by name in this stage." };
    const name = rawName.trim().toLowerCase();
    const item = this.auto.get(name) ?? this.manual.get(name);
    if (item === undefined) return { error: `No rule called ${inertLabel(rawName.slice(0, 100))}.` };
    const key = keyOf(item);
    if (this.loaded.has(key)) return { text: `The rule ${inertLabel(name)} is already loaded in this session.` };
    if (this.additionsBytes + item.bytes > this.budgets.additionsBytes) {
      this.extraRecords.push({ layer: item.layer, ...(item.repo === undefined ? {} : { repo: item.repo }), ...(item.path === undefined ? {} : { path: item.path }), scopeDir: item.scopeDir, format: item.format, bytes: item.bytes, digest: item.digest, status: "skipped", reason: "over_budget" });
      return { error: "Loading this rule would pass the size budget for rules added during a session." };
    }
    this.additionsBytes += item.bytes;
    this.loaded.add(key);
    const why: LoadReason = { kind: "read_by_tool" };
    this.records.set(key, {
      layer: item.layer, ...(item.repo === undefined ? {} : { repo: item.repo }), ...(item.path === undefined ? {} : { path: item.path }), scopeDir: item.scopeDir, format: item.format,
      activation: item.activation, ...(item.name === undefined ? {} : { name: item.name }), bytes: item.bytes, digest: item.digest, readAt: item.readAt, status: "loaded", why,
    });
    const [file] = renderKnowledgeItems([item], this.options.rendering, this.options.rootPath);
    return { text: file!.content };
  }
}
