// K1 lane D, D1: the spec target. Where a task's spec is written, in which format, and what the spec holds.
//
// A spec is a rendering of the owner-approved plan. The model returns a `SpecDraft` (structured, bounded, one line per statement); a deterministic renderer
// (broker/src/spec/*) turns it into the files of one format. The format is a plug-in id: this file names none of them except as the built-in ids a project may
// pick, so a new format is a new renderer, not a new contract. Everything the model wrote is untrusted text: it is cleaned to one visible line before it
// is stored or rendered, so it cannot forge a heading or a requirement line, and it carries no permission.
import { z } from "zod";
import { redactText } from "./redaction.js";

/** The formats Rovara ships a renderer for. A project's `format` is any registered id; these are the ones registered by default. */
export const BUILT_IN_SPEC_FORMATS = ["kiro", "speckit", "team_template", "rovara"] as const;
export const SPEC_WHERES = ["meta_repo", "code_repo", "pr_description"] as const;
export const SPEC_WHENS = ["always", "features", "medium_and_large", "on_request"] as const;
export const SPEC_LINK_STYLES = ["together", "spec_first"] as const;
export const SPEC_KINDS = ["feature", "bugfix"] as const;
export type SpecWhere = (typeof SPEC_WHERES)[number];
export type SpecWhen = (typeof SPEC_WHENS)[number];
export type SpecLinkStyle = (typeof SPEC_LINK_STYLES)[number];
export type SpecKind = (typeof SPEC_KINDS)[number];

export const SPEC_PATH_MAX = 200;
export const SPEC_FILE_MAX_BYTES = 64 * 1024;
export const SPEC_FILES_MAX = 12;
export const SPEC_REQUIREMENTS_MAX = 20;
export const SPEC_CRITERIA_MAX = 12;
export const SPEC_TASKS_MAX = 60;
export const SPEC_LINE_MAX = 400;
export const SPEC_DESIGN_MAX = 12_000;
export const SPEC_CHECKLIST_MAX = 7;
/** The tokens a path template may hold. */
export const SPEC_PATH_TOKENS = ["slug", "taskKey", "ticket", "n"] as const;

const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** Every character that can start Markdown syntax in running text: a backslash, brackets, parentheses, angle brackets, `!`, `*`, `_`, `#`, `|`, `~` and the backtick. */
const MARKDOWN_ACTIVE = /[\\[\]()<>!*_#|~`]/gu;
/** CommonMark: a backslash before an ASCII punctuation character is that character, as text. */
const MARKDOWN_ESCAPED = /\\([!-/:-@[-`{-~])/gu;

/** The text a Markdown escape stands for: `\[` is `[`. */
export function unescapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPED, "$1");
}

/**
 * Model text made inert on GitHub by escaping, not by looking for patterns: every character that can start Markdown syntax is written as a backslash escape, so the text can never form a link, an image,
 * a raw HTML tag or comment, a reference definition or a heading, however it is split over lines or nested; what the model wrote is what a reader sees. Bare URLs and `www.` are broken with a zero-width joiner so
 * GitHub does not link them, and `@` and `#<digit>` so nothing mentions anyone or cross-references an issue. Text that is already escaped is unescaped first, so applying it twice gives the same text.
 */
export function inertSpecText(text: string): string {
  // Our own joiners go first, so the second pass of anything gives what the first did.
  return escapeUnescaped(unescapeMarkdown(text.replaceAll("\u200D", "")));
}

/** The escaping itself, for text that is already unescaped (the text as the model meant it). */
function escapeUnescaped(text: string): string {
  return text
    .replaceAll("@", "@\u200D")
    .replaceAll("://", ":\u200D//\u200D")
    .replace(/www\./giu, (match) => `${match.slice(0, 3)}\u200D.`)
    .replace(/#(?=\d)/gu, "#\u200D")
    .replace(MARKDOWN_ACTIVE, (character) => `\\${character}`);
}

/**
 * Untrusted text as one visible line: secrets redacted, hidden and control characters (line breaks included) gone, white space collapsed, a leading list or heading marker
 * dropped, cut to `max` characters, and escaped (see inertSpecText). A line made this way cannot start a heading, a list item or a code fence in a file that holds it, nor render a link, image or tag.
 */
export function specLine(text: string, max: number = SPEC_LINE_MAX): string {
  const plain = redactText(text).replace(/[\r\n\t\u2028\u2029]+/gu, " ").replace(HIDDEN, "").replace(/\s+/gu, " ").trim();
  // Leading markers go one after another until none is left: `- 1.1 text` is `text`.
  let bare = unescapeMarkdown(plain);
  for (let guard = 0; guard < 8; guard += 1) {
    const next = bare.replace(/^(?:[#>*+\-=`|~]+|\d+(?:\.\d+)+\.?|\d+[.)])\s*/u, "").trim();
    if (next === bare) break;
    bare = next;
  }
  const points = Array.from(bare);
  const cut = points.length <= max ? bare : `${points.slice(0, max - 1).join("")}…`;
  return escapeUnescaped(cut).trim();
}

/** A code fence line: its character and length, or undefined. A backtick fence's info string has no backtick (CommonMark). */
export function markdownFenceOf(line: string): { char: "`" | "~"; length: number; rest: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return undefined;
  const run = match[1]!;
  const rest = match[2] ?? "";
  if (run[0] === "`" && rest.includes("`")) return undefined;
  return { char: run[0] as "`" | "~", length: run.length, rest };
}

/** Follows fences the CommonMark way: an open fence closes only on the same character, at least as long, with nothing after it but white space. */
export function nextFenceState(open: { char: "`" | "~"; length: number } | undefined, line: string): { char: "`" | "~"; length: number } | undefined {
  const fence = markdownFenceOf(line);
  if (fence === undefined) return open;
  if (open === undefined) return { char: fence.char, length: fence.length };
  return fence.char === open.char && fence.length >= open.length && fence.rest.trim() === "" ? undefined : open;
}

/** A line of only `-` or `=` under a paragraph makes a setext heading: its first mark is escaped (the escape is read back and written again on a second pass, so the text is stable). */
function noSetext(line: string): string {
  return /^\s*[-=]+\s*$/u.test(line) ? line.replace(/[-=]/u, (mark) => `\\${mark}`) : line;
}

/**
 * Untrusted multi-line markdown (a design section) made safe to sit inside one section of a spec. The model never decides where a fence opens or closes: a code block it writes at column 0 (a run of three or
 * more backticks or tildes, closed by a run of the same character at least as long) is taken apart and written again by us, its content inside a backtick fence we generate at column 0 that is longer than any
 * backtick run in the content, closed even if the model did not close it. Anything that merely looks like a fence anywhere else (indented, in a list item, in a block quote) is ordinary text. Every other line is escaped
 * (see inertSpecText), headings become bold lines, hidden characters are gone, and the result is bounded by whole blocks. Applying it twice gives the same text.
 */
export function specMarkdown(text: string, max: number = SPEC_DESIGN_MAX): string {
  const lines = redactText(text).replace(/\r\n?/gu, "\n").replace(HIDDEN_BUT_NEWLINE, "").split("\n");
  const blocks: string[][] = [];
  let index = 0;
  let blank = false;
  while (index < lines.length) {
    const line = lines[index]!;
    const open = /^(`{3,}|~{3,})(.*)$/u.exec(line);
    if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      const char = open[1]![0]!;
      const content: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closer = /^(`{3,}|~{3,})[ \t]*$/u.exec(lines[index]!);
        if (closer !== null && closer[1]![0] === char && closer[1]!.length >= open[1]!.length) { index += 1; break; }
        content.push(lines[index]!);
        index += 1;
      }
      const longest = Math.max(0, ...content.flatMap((entry) => [...entry.matchAll(/`+/gu)].map((run) => run[0].length)));
      const fence = "`".repeat(Math.max(3, longest + 1));
      const info = open[2]!.trim();
      blocks.push([`${fence}${/^[A-Za-z0-9_+.-]{1,20}$/u.test(info) ? info : ""}`, ...content, fence]);
      blank = false;
      continue;
    }
    index += 1;
    const trimmed = line.replace(/[ \t]+$/u, "");
    if (trimmed === "") { if (!blank) blocks.push([""]); blank = true; continue; }
    blank = false;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(trimmed);
    // A bold line made of text that is already in its escaped form is one of our own headings from an earlier pass: kept as it is. Any other bold line is escaped like the rest.
    const ours = /^\*\*(.+)\*\*$/u.exec(trimmed);
    const ourInner = ours?.[1];
    if (heading !== null) blocks.push([`**${inertSpecText((heading[1] ?? "").replace(/\s*#+\s*$/u, "").trim())}**`]);
    else if (ourInner !== undefined && inertSpecText(ourInner).replaceAll("\u200D", "") === ourInner) blocks.push([`**${inertSpecText(ourInner)}**`]);
    else blocks.push([noSetext(inertSpecText(trimmed))]);
  }
  while (blocks.length > 0 && blocks[0]!.length === 1 && blocks[0]![0] === "") blocks.shift();
  while (blocks.length > 0 && blocks[blocks.length - 1]!.length === 1 && blocks[blocks.length - 1]![0] === "") blocks.pop();
  // Bounded by whole blocks, so a fence is never cut open.
  const kept: string[] = [];
  let size = 0;
  let cut = false;
  for (const block of blocks) {
    const length = block.reduce((sum, entry) => sum + Array.from(entry).length + 1, 0);
    if (size + length > max - 2) { cut = true; break; }
    kept.push(...block);
    size += length;
  }
  const head = kept.join("\n").trimEnd();
  return cut ? (head === "" ? "…" : `${head}\n…`) : kept.join("\n");
}
const HIDDEN_BUT_NEWLINE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** Text with hidden and control characters removed (new lines and tabs stay), line endings made `\n`. For text that is kept as written (a team's template), where `specMarkdown` would rewrite headings. */
export function specStripHidden(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(HIDDEN_BUT_NEWLINE, "");
}

/** The URL-safe slug of a title: lower case, letters, digits and single hyphens, at most 48 characters. Never empty. */
export function specSlug(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  return slug === "" ? "spec" : slug;
}

/**
 * Why a path (or path template) is not one a spec may be written to, or undefined. A path is relative to the repository, uses `/`, has no `.`/`..`/empty/hidden-git segment,
 * holds only letters, digits, `.`, `_`, `-` and the tokens `{slug}`, `{taskKey}`, `{ticket}`, `{n}`, and never touches `.git`. (A dot folder such as `.kiro` is fine.)
 */
export function specPathProblem(path: string, options: { tokens?: boolean } = {}): string | undefined {
  if (path.length === 0 || path.length > SPEC_PATH_MAX) return `must be 1 to ${String(SPEC_PATH_MAX)} characters`;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "must be a relative path with / separators";
  const segments = path.replace(/\/$/u, "").split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return "must not have an empty, . or .. folder";
    if (segment.toLowerCase() === ".git" || segment.toLowerCase().startsWith(".git")) return "must not touch .git";
    const bare = options.tokens === true ? segment.replace(/\{(?:slug|taskKey|ticket|n)\}/gu, "x") : segment;
    if (!/^[A-Za-z0-9._-]+$/u.test(bare)) return "may hold only letters, digits, . _ - and the tokens {slug} {taskKey} {ticket} {n}";
  }
  return undefined;
}

/** Folders a spec is never written into: Rovara's own config, the places teams keep rules, steering, skills and hooks for their tools, and the repository's automation. Compared by prefix, any case. */
export const SPEC_FORBIDDEN_FOLDERS: readonly string[] = [
  ".rovara", ".github", ".kiro/steering", ".kiro/hooks", ".kiro/skills", ".cursor", ".claude", ".agents", ".windsurf", ".continue", ".gemini", ".codex", ".vscode",
  ".rovara/rules", ".cursor/rules", ".claude/rules", ".github/instructions", ".agents/skills", ".claude/skills", "runbooks", "docs/runbooks",
];

/** File names that are rules, steering, skills or ownership for some tool whatever folder they sit in: a spec never contains one. Compared by base name, any case. */
export const SPEC_FORBIDDEN_FILE_NAMES: readonly string[] = [
  "codeowners", "agents.md", "agents.override.md", "claude.md", "gemini.md", "skill.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md", ".rules", "project.yaml", "project.yml", "project.json",
];

/**
 * Why a folder (no tokens left in it) is not one a spec may be written to, or undefined. `extra` are the project's own knowledge folders (steering, skills, runbooks, key docs). The repository root
 * is refused: a spec has a folder of its own, and the first folder is named by the project, never by a token.
 */
export function specFolderProblem(folder: string, extra: readonly string[] = []): string | undefined {
  const bare = folder.replace(/\/+$/u, "").toLowerCase();
  if (bare === "") return "must be a folder, not the repository root";
  for (const forbidden of [...SPEC_FORBIDDEN_FOLDERS, ...extra.map((entry) => entry.replace(/\/+$/u, "").toLowerCase())]) {
    if (forbidden !== "" && (bare === forbidden.toLowerCase() || bare.startsWith(`${forbidden.toLowerCase()}/`))) return "must not be a rules, steering, skills, config or automation folder";
  }
  return undefined;
}

/** Why a spec file's name is refused (see SPEC_FORBIDDEN_FILE_NAMES), or undefined. */
export function specFileNameProblem(path: string): string | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  return SPEC_FORBIDDEN_FILE_NAMES.includes(name) ? "a spec cannot hold a rules, steering or ownership file" : undefined;
}

const pathTemplate = z.string().superRefine((value, context) => {
  const problem = specPathProblem(value, { tokens: true });
  if (problem !== undefined) { context.addIssue({ code: "custom", message: `a path template ${problem}` }); return; }
  const first = value.split("/")[0]!;
  if (/\{(?:slug|taskKey|ticket|n)\}/u.test(first)) { context.addIssue({ code: "custom", message: "a path template starts with a folder the project names, not a token" }); return; }
  // The literal folders before the first token; what a token could complete is checked when the folder is resolved (specFolderProblem again, with the project's own knowledge folders).
  const segments = value.replace(/\/$/u, "").split("/");
  const firstToken = segments.findIndex((segment) => /\{/u.test(segment));
  const folderProblem = specFolderProblem((firstToken === -1 ? segments : segments.slice(0, firstToken)).join("/"));
  if (folderProblem !== undefined) context.addIssue({ code: "custom", message: `a path template ${folderProblem}` });
});
const folderPath = z.string().superRefine((value, context) => {
  const problem = specPathProblem(value);
  if (problem !== undefined) context.addIssue({ code: "custom", message: `a path ${problem}` });
});

/** The team's answers to the setup questions about how they write specs. Names are short keys, answers are one line. */
export const TeamChecklistAnswersSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/u), z.string().max(500))
  .refine((answers) => Object.keys(answers).length <= SPEC_CHECKLIST_MAX, `at most ${String(SPEC_CHECKLIST_MAX)} answers`);
export type TeamChecklistAnswers = z.infer<typeof TeamChecklistAnswersSchema>;

export const SpecTargetSchema = z.object({
  where: z.enum(SPEC_WHERES).default("meta_repo"),
  /** The spec's folder inside the repository it is written to. Default: the format's own. */
  pathTemplate: pathTemplate.optional(),
  /** A registered format id; an unknown one is refused when a spec is due, never guessed. */
  format: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u).default("kiro"),
  /** `team_template`: a folder in the meta repo with one file per section, read at the task's `knowledgeCommit`. */
  templatePath: folderPath.optional(),
  when: z.enum(SPEC_WHENS).default("features"),
  linkStyle: z.enum(SPEC_LINK_STYLES).default("together"),
  checklist: TeamChecklistAnswersSchema.optional(),
}).strict().superRefine((target, context) => {
  if (target.format === "team_template" && target.templatePath === undefined) context.addIssue({ code: "custom", path: ["templatePath"], message: "the team template format needs the folder that holds the template" });
  if (target.templatePath !== undefined && target.format !== "team_template") context.addIssue({ code: "custom", path: ["templatePath"], message: "only the team template format reads a template folder" });
  if (target.where === "pr_description" && target.linkStyle === "spec_first") context.addIssue({ code: "custom", path: ["linkStyle"], message: "a spec in the pull request description has no pull request of its own to wait for" });
});
export type SpecTarget = z.infer<typeof SpecTargetSchema>;

/** The spec target a project has when it names none: nothing is written (`when` "on_request" is the only way to ask, and only the owner can). */
export function defaultSpecTarget(): SpecTarget {
  return SpecTargetSchema.parse({});
}

// ---------------------------------------------------------------------------------------------------------------------
// The draft the SPEC_WRITE operation returns, and the files a renderer makes from it.
// ---------------------------------------------------------------------------------------------------------------------

const Line = z.string().transform((value) => specLine(value)).pipe(z.string().min(1).max(SPEC_LINE_MAX * 3));
const OptionalLine = z.string().transform((value) => specLine(value)).pipe(z.string().max(SPEC_LINE_MAX * 3)).transform((value) => (value === "" ? undefined : value));

/** One EARS statement: `WHEN <when> THE SYSTEM SHALL <shall>`; without `when`, `THE SYSTEM SHALL <shall>`. The words WHEN and SHALL are added by the renderer. */
export const SpecCriterionSchema = z.object({
  when: OptionalLine.optional(),
  shall: Line,
}).strict();
export type SpecCriterion = z.infer<typeof SpecCriterionSchema>;

export const SpecRequirementSchema = z.object({
  title: Line,
  userStory: OptionalLine.optional(),
  criteria: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
}).strict();
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

export const SpecBugfixSchema = z.object({
  /** The defect: what happens now. `shall` holds the faulty behaviour in the words of an observation, not a promise. */
  current: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
  expected: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
  unchanged: z.array(SpecCriterionSchema).max(SPEC_CRITERIA_MAX),
}).strict();
export type SpecBugfix = z.infer<typeof SpecBugfixSchema>;

export const SpecTaskSchema = z.object({
  title: Line,
  /** Requirement labels this step covers, as `SpecRequirementRef.id` gives them (`1.2`). Unknown labels are dropped when rendered. */
  covers: z.array(z.string().regex(/^[0-9]{1,2}\.[0-9]{1,2}$/u)).max(SPEC_CRITERIA_MAX).default([]),
}).strict();
export type SpecTask = z.infer<typeof SpecTaskSchema>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const SpecDraftSchema = z.object({
  version: z.literal(1),
  kind: z.enum(SPEC_KINDS),
  title: Line,
  summary: z.string().transform((value) => specLine(value, 1_500)).pipe(z.string().max(4_500)),
  requirements: z.array(SpecRequirementSchema).max(SPEC_REQUIREMENTS_MAX).default([]),
  bugfix: SpecBugfixSchema.optional(),
  design: z.string().transform((value) => specMarkdown(value)).pipe(z.string().max(SPEC_DESIGN_MAX)).default(""),
  tasks: z.array(SpecTaskSchema).max(SPEC_TASKS_MAX).default([]),
  /** The digest of the approved plan this draft was written from. The broker refuses a draft whose digest is not the approved plan's. */
  planDigest: Sha256,
}).strict().superRefine((draft, context) => {
  if (draft.kind === "feature" && (draft.requirements.length === 0 || draft.bugfix !== undefined)) context.addIssue({ code: "custom", path: ["requirements"], message: "a feature spec has requirements and no bugfix section" });
  if (draft.kind === "bugfix" && (draft.bugfix === undefined || draft.requirements.length > 0)) context.addIssue({ code: "custom", path: ["bugfix"], message: "a bugfix spec has a bugfix section and no feature requirements" });
});
export type SpecDraft = z.infer<typeof SpecDraftSchema>;

/** What a SPEC_WRITE run is told besides its prompt: the format it writes for, and the approved plan's digest it must echo in its draft. */
export const SpecWriteBindingSchema = z.object({
  format: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  kind: z.enum(SPEC_KINDS),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type SpecWriteBinding = z.infer<typeof SpecWriteBindingSchema>;

export const SpecFileSchema = z.object({
  /** Relative to the repository root. */
  path: folderPath,
  content: z.string().max(SPEC_FILE_MAX_BYTES),
}).strict().refine((file) => new TextEncoder().encode(file.content).byteLength <= SPEC_FILE_MAX_BYTES, "a spec file is at most 64 KiB");
export type SpecFile = z.infer<typeof SpecFileSchema>;

/** One checkable statement of a spec. `id` is the label as the spec shows it (`1.2`, `FR-001`); review answers by it, and W4's requirement-to-evidence table keys on `(specPath, id)`. */
export const SpecRequirementRefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/u),
  text: z.string().min(1).max(SPEC_LINE_MAX + 40),
  /** "defect" lines (a bug's current behaviour) describe the fault and are not checked against the code. */
  kind: z.enum(["requirement", "defect"]),
  /** The file the statement is in. */
  path: folderPath,
}).strict();
export type SpecRequirementRef = z.infer<typeof SpecRequirementRefSchema>;

/** The most requirements one review walks. A spec with more is walked up to this many and said so. */
export const SPEC_REVIEW_REQUIREMENTS_MAX = 80;

/**
 * The EARS words for one criterion. A `when` that already starts with WHEN, and a `shall` that already starts with THE SYSTEM SHALL, are not doubled.
 * `verb: "observed"` writes a defect (what the system does now) without a promise: `WHEN <when> THE SYSTEM <what happens>`.
 */
export function earsLine(criterion: SpecCriterion, options: { verb?: "SHALL" | "SHALL CONTINUE TO" | "observed" } = {}): string {
  const verb = options.verb ?? "SHALL";
  const when = criterion.when === undefined ? undefined : criterion.when.replace(/^when\s+/iu, "").trim();
  const prefix = when === undefined || when === "" ? "" : `WHEN ${when} `;
  if (verb === "observed") return `${prefix}THE SYSTEM ${criterion.shall.replace(/^the system\s+/iu, "").trim()}`;
  const shall = criterion.shall.replace(/^(?:the system\s+)?shall(?:\s+continue\s+to)?\s+/iu, "").trim();
  return `${prefix}THE SYSTEM ${verb} ${shall}`;
}

/** The requirement labels a draft has, in order, as the format-independent `n.m` numbers (a bug's three sections are 1.x defect, 2.x expected, 3.x unchanged, as Kiro numbers them). */
export function specDraftStatements(draft: SpecDraft): Array<{ id: string; text: string; kind: "requirement" | "defect" }> {
  if (draft.kind === "bugfix" && draft.bugfix !== undefined) {
    return [
      ...draft.bugfix.current.map((criterion, index) => ({ id: `1.${String(index + 1)}`, text: earsLine(criterion, { verb: "observed" }), kind: "defect" as const })),
      ...draft.bugfix.expected.map((criterion, index) => ({ id: `2.${String(index + 1)}`, text: earsLine(criterion), kind: "requirement" as const })),
      ...draft.bugfix.unchanged.map((criterion, index) => ({ id: `3.${String(index + 1)}`, text: earsLine(criterion, { verb: "SHALL CONTINUE TO" }), kind: "requirement" as const })),
    ];
  }
  return draft.requirements.flatMap((requirement, requirementIndex) => requirement.criteria.map((criterion, index) => ({
    id: `${String(requirementIndex + 1)}.${String(index + 1)}`, text: earsLine(criterion), kind: "requirement" as const,
  })));
}

// ---------------------------------------------------------------------------------------------------------------------
// What a review says about a spec (D3).
// ---------------------------------------------------------------------------------------------------------------------

export const SPEC_VERDICTS = ["met", "not_met", "not_applicable"] as const;
export type SpecVerdict = (typeof SPEC_VERDICTS)[number];

/** One requirement's verdict, as the review reports it and W4's requirement-to-evidence table reads it. `evidence` names code (diff lines or a test) the verdict rests on; it is text, never a command. */
export const SpecRequirementVerdictSchema = z.object({
  id: SpecRequirementRefSchema.shape.id,
  verdict: z.enum(SPEC_VERDICTS),
  /** Why, in one line. For not_met this is the finding; for not_applicable it is the reason; for met it names the evidence. */
  reason: Line,
  evidence: z.array(Line).max(6).default([]),
}).strict();
export type SpecRequirementVerdict = z.infer<typeof SpecRequirementVerdictSchema>;

/** The review's walk of one spec: the commit it was read at, and one verdict per requirement the review was given. */
export const SpecReviewResultSchema = z.object({
  specPath: folderPath,
  specCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  verdicts: z.array(SpecRequirementVerdictSchema).max(SPEC_REVIEW_REQUIREMENTS_MAX),
  /** Requirements the review was given but did not answer. Each counts as not met. */
  unanswered: z.array(SpecRequirementRefSchema.shape.id).max(SPEC_REVIEW_REQUIREMENTS_MAX).default([]),
  /** The spec had more requirements than the walk takes. */
  truncated: z.boolean().default(false),
}).strict();
export type SpecReviewResult = z.infer<typeof SpecReviewResultSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// The SPEC_WRITE run's answer.
// ---------------------------------------------------------------------------------------------------------------------

/** The label of the fenced block the spec write answers in. */
export const SPEC_WRITE_INFO_STRING = "rovara-spec";
/** The most bytes of an answer that is read. */
export const SPEC_WRITE_ANSWER_MAX_BYTES = 192 * 1024;

/** The JSON in the LAST block fenced with the spec label of a model's final message; undefined when there is none, it is not JSON or it is too large. Text outside the block is chat. */
export function specWriteAnswerOf(text: string): unknown {
  const pattern = new RegExp(String.raw`(?:^|\n)\x60\x60\x60${SPEC_WRITE_INFO_STRING}[ \t]*\n([\s\S]*?)\n\x60\x60\x60(?=\n|$)`, "gu");
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) last = match[1];
  if (last === undefined || new TextEncoder().encode(last).byteLength > SPEC_WRITE_ANSWER_MAX_BYTES) return undefined;
  try { return JSON.parse(last) as unknown; } catch { return undefined; }
}

export type SpecDraftRead = { ok: true; draft: SpecDraft } | { ok: false; errors: string[] };

/**
 * A model's answer read as a draft for one binding. The digest is the binding's, never the model's; the kind must be the binding's; and the answer must fit `SpecDraftSchema`. The problems named are the
 * reader's own words (paths and fixed phrases), never the model's text.
 */
export function readSpecDraft(answer: unknown, binding: SpecWriteBinding): SpecDraftRead {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return { ok: false, errors: [`there is no ${SPEC_WRITE_INFO_STRING} block with a JSON object in it`] };
  const record = answer as Record<string, unknown>;
  if (record["kind"] !== binding.kind) return { ok: false, errors: [`kind must be "${binding.kind}"`] };
  const parsed = SpecDraftSchema.safeParse({ ...record, version: 1, planDigest: binding.planDigest });
  if (parsed.success) return { ok: true, draft: parsed.data };
  return { ok: false, errors: parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.map(String).join(".") || "(answer)"}: ${issue.message}`.slice(0, 160)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// D3: the requirements a review is given, and how its answer is read.
// ---------------------------------------------------------------------------------------------------------------------

/** What a review operation is given about the spec: the requirements as the spec shows them at the recorded commit. The text is the team's (and its editors'), so the review treats it as data. */
export const SpecReviewInputSchema = z.object({
  specPath: folderPath,
  specCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  requirements: z.array(SpecRequirementRefSchema.extend({ kind: z.literal("requirement") })).min(1).max(SPEC_REVIEW_REQUIREMENTS_MAX),
  /** The spec had more requirements than the walk takes. */
  truncated: z.boolean().default(false),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, requirement] of input.requirements.entries()) {
    if (seen.has(requirement.id)) context.addIssue({ code: "custom", path: ["requirements", index, "id"], message: "requirement labels must be unique" });
    seen.add(requirement.id);
  }
});
export type SpecReviewInput = z.infer<typeof SpecReviewInputSchema>;

const VerdictAnswerSchema = z.object({
  id: z.string(),
  verdict: z.enum(SPEC_VERDICTS),
  reason: z.string(),
  evidence: z.array(z.string()).max(12).optional(),
}).strict();

/**
 * A review's answer about a spec, read against the requirements it was given. Fail closed: only labels that were asked about count (a made-up label is dropped); a label answered twice keeps its first answer;
 * `met` needs a stated reason AND at least one piece of evidence that `evidenceOk` accepts (a file in the change or at the head, a line inside it), or it stands as unanswered; every label not answered counts as not met. The result is bounded by the input.
 */
export function readSpecVerdicts(answer: unknown, input: SpecReviewInput, options: { evidenceOk?: (entry: string) => boolean } = {}): SpecReviewResult {
  const asked = new Map(input.requirements.map((requirement) => [requirement.id, requirement]));
  const rows = typeof answer === "object" && answer !== null && Array.isArray((answer as { specVerdicts?: unknown }).specVerdicts) ? (answer as { specVerdicts: unknown[] }).specVerdicts : [];
  const verdicts = new Map<string, SpecRequirementVerdict>();
  for (const row of rows.slice(0, input.requirements.length * 2)) {
    const parsed = VerdictAnswerSchema.safeParse(row);
    if (!parsed.success || !asked.has(parsed.data.id) || verdicts.has(parsed.data.id)) continue;
    const reason = specLine(parsed.data.reason, 300);
    // Evidence is kept only when it names something that is there (a file in the change or at the head, a line inside it): a claim of "met" that points at nothing is not met.
    const evidence = (parsed.data.evidence ?? []).map((entry) => specLine(entry, 200)).filter((entry) => entry !== "" && (options.evidenceOk === undefined || options.evidenceOk(entry))).slice(0, 6);
    if (reason === "" || (parsed.data.verdict === "met" && evidence.length === 0)) continue;
    verdicts.set(parsed.data.id, { id: parsed.data.id, verdict: parsed.data.verdict, reason, evidence });
  }
  return {
    specPath: input.specPath, specCommit: input.specCommit,
    verdicts: input.requirements.flatMap((requirement) => { const verdict = verdicts.get(requirement.id); return verdict === undefined ? [] : [verdict]; }),
    unanswered: input.requirements.map((requirement) => requirement.id).filter((id) => !verdicts.has(id)),
    truncated: input.truncated,
  };
}

/** The review findings a spec walk adds: one for each requirement not met and each left unanswered (which counts as not met). Fixed words around a one-line cleaned reason. */
export function specReviewFindings(result: SpecReviewResult): Array<{ text: string; origin: "INTRODUCED"; severity: "MEDIUM" }> {
  const notMet = result.verdicts.filter((verdict) => verdict.verdict === "not_met").map((verdict) => ({ text: `Spec ${verdict.id} is not met: ${verdict.reason}`.slice(0, 600), origin: "INTRODUCED" as const, severity: "MEDIUM" as const }));
  const unanswered = result.unanswered.map((id) => ({ text: `Spec ${id} could not be checked, so it counts as not met.`, origin: "INTRODUCED" as const, severity: "MEDIUM" as const }));
  return [...notMet, ...unanswered];
}

/** The rows W4's requirement-to-evidence table reads: one for each requirement the review walked, keyed by the spec path and the label as the spec shows it. */
export function specRequirementRows(result: SpecReviewResult): Array<{ specPath: string; specCommit: string; id: string; verdict: SpecVerdict | "unanswered"; reason: string; evidence: string[] }> {
  return [
    ...result.verdicts.map((verdict) => ({ specPath: result.specPath, specCommit: result.specCommit, id: verdict.id, verdict: verdict.verdict, reason: verdict.reason, evidence: verdict.evidence })),
    ...result.unanswered.map((id) => ({ specPath: result.specPath, specCommit: result.specCommit, id, verdict: "unanswered" as const, reason: "", evidence: [] as string[] })),
  ];
}
