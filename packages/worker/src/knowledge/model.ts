// Knowledge resolver (K1, C1): the normalised model.
//
// Every rule format a team might already use (AGENTS.md, CLAUDE.md, Kiro steering, Cursor rules, Copilot instructions, Claude rules,
// Rovara's own rules) is read by a pluggable `KnowledgeFormatReader` (see registry.ts) into one shape, `KnowledgeItem`. Kiro is one reader
// among several: nothing outside kiro.ts knows its keys. The model carries no rule text beyond `text`; the manifest (manifest.ts) is the
// text-free record of what a stage loaded.

/** The stages that load knowledge. Understand, plan, plan check and review judge; build writes. */
export type KnowledgeStage = "understand" | "plan" | "plan_check" | "build" | "review";

export const KNOWLEDGE_STAGES: readonly KnowledgeStage[] = ["understand", "plan", "plan_check", "build", "review"];

/** Plan check and review decide on someone else's change: the `auto` set they see is the plan's, never their own choice (Q9). */
export const JUDGING_STAGES_FOR_AUTO: ReadonlySet<KnowledgeStage> = new Set<KnowledgeStage>(["plan_check", "review"]);

/** Where an item sits in the stack, farthest from the code first (company is the widest). The closest layer wins. */
export type KnowledgeLayer = "company" | "group" | "project" | "meta" | "repo" | "folder";

export const KNOWLEDGE_LAYER_ORDER: readonly KnowledgeLayer[] = ["company", "group", "project", "meta", "repo", "folder"];

/** The built-in reader ids. A reader registered by someone else may use any other id; the model treats the id as opaque text. */
export const BUILT_IN_FORMATS = [
  "agents_md",
  "claude_md",
  "kiro_steering",
  "cursor_mdc",
  "copilot_repo",
  "copilot_instructions",
  "claude_rules",
  "rovara_rule",
] as const;
export type BuiltInFormat = (typeof BUILT_IN_FORMATS)[number];
export type KnowledgeFormat = BuiltInFormat | (string & {});

export type KnowledgeActivation = "always" | "fileMatch" | "manual" | "auto";

/** Which commit or tree an item's text came from. */
export type KnowledgeReadAt = "base" | "working" | "knowledgeCommit";

/** What a reader makes of one file, before the resolver places it in a layer and reads its imports. */
export interface ParsedKnowledgeFile {
  activation: KnowledgeActivation;
  /** `fileMatch` only: the patterns, matched against repository-relative paths. */
  patterns?: string[];
  /** The `#name` of a manual item, the name of an auto item. */
  name?: string;
  description?: string;
  /** Stages this item is left out of (Copilot's `excludeAgent`). */
  excludeStages?: readonly KnowledgeStage[];
  /** The text after any front matter. */
  body: string;
  /** Whether `@path` / `#[[file:...]]` references in the body are followed (see imports.ts). */
  imports: "claude" | "kiro" | "none";
}

export type FormatParseResult = { ok: true; value: ParsedKnowledgeFile } | { ok: false; reason: SkipReason };

/** The fixed codes a manifest line may carry. Free text from a file never reaches a reason (checklist 1). */
export type SkipReason =
  | "not_matched"
  | "not_requested"
  | "excluded_stage"
  | "bad_front_matter"
  | "too_large"
  | "over_budget"
  | "not_in_plan_set"
  | "unreadable"
  | "symlink"
  | "found_not_run"
  | "duplicate"
  | "overridden";

/** The normalised item (design 3.3). `text` is what the model would see, after hidden characters are removed and imports are read. */
export interface KnowledgeItem {
  layer: KnowledgeLayer;
  repo?: string;
  /** Repository-relative path of the file; absent for items that are not files (Rovara's own rules). */
  path?: string;
  /** The folder the item applies under (`""` is the repository root). */
  scopeDir: string;
  format: KnowledgeFormat;
  activation: KnowledgeActivation;
  patterns?: string[];
  name?: string;
  description?: string;
  excludeStages?: readonly KnowledgeStage[];
  /** UTF-8 byte length of `text`. */
  bytes: number;
  /** SHA-256 (hex) of `text`: what the agent saw. */
  digest: string;
  /** SHA-256 of the file's bytes exactly as stored at the commit (nothing removed): lets the task page check the file it fetches later. */
  fileDigest?: string;
  readAt: KnowledgeReadAt;
  /** A company rule an admin locked: never dropped, never skipped. */
  locked?: boolean;
  text: string;
}

/** The budgets of design 3.3. */
export interface KnowledgeBudgets {
  perFileBytes: number;
  alwaysOnBytes: number;
  /** fileMatch, manual and auto additions together, per session. */
  additionsBytes: number;
  importDepth: number;
}

export const DEFAULT_KNOWLEDGE_BUDGETS: KnowledgeBudgets = {
  perFileBytes: 64 * 1024,
  alwaysOnBytes: 128 * 1024,
  additionsBytes: 128 * 1024,
  importDepth: 4,
};

/** The most rule files read from one repository in one stage, and the most directories listed to find them. */
export const MAX_FILES_PER_REPOSITORY = 200;
export const MAX_DIRECTORIES_PER_REPOSITORY = 400;
export const MAX_DISCOVERY_DEPTH = 6;
