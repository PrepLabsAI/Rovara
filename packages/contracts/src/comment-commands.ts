// packages/contracts/src/comment-commands.ts
// A comment can carry a command (R1-1). Many repositories merge, deploy or run workflows from comments
// (`bors r+`, `@mergifyio queue`, `/deploy production`, Atlantis), and those bots check only that the
// commenter has write access, which the Rovara GitHub App's comments pass. So an agent's comment, review,
// issue text or label is a write that can merge, even though no merge tool is granted. These pure
// functions decide whether a write is *consequential* (it needs a person) and strip @-mentions from it.
//
// Posture: when unsure, treat the text as a command. A false positive costs a person a click; a false
// negative lets an agent merge or deploy. Nothing here reads the network or the repository.
import { agentXError } from "./errors.js";

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

/** Unicode category Cf: zero-width, bidi and tag characters (U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF ...). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Invisible characters that are not Cf: variation selectors, the combining grapheme joiner, Hangul fillers ... */
const IGNORABLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;
const COMBINING_MARKS = /\p{M}/gu;
/** Spaces of every kind, and the C0 controls that Python-style `split()` treats as spaces. */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const SPACE_LIKE = /[\p{Zs}\t\v\f\u001c-\u001f]/gu;
/** Other control characters, which carry no text; U+0085 stays because it separates lines. Like invisible characters they are removed in one matching copy and read as a gap in the other. */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const OTHER_CONTROLS = /[\u0000-\u0008\u000e-\u001b\u007f-\u0084\u0086-\u009f]/gu;
/** The line separators: LF, CR, U+2028, U+2029 and U+0085. */
const LINE_SEPARATORS = /[\n\r\u2028\u2029\u0085]/u;

/**
 * The text that is SENT: NFKC with the Cf characters removed. Visible characters are kept (a Cyrillic
 * letter stays Cyrillic), so an approval and the vendor call carry exactly what was checked. NFKC maps
 * full-width forms, circled and mathematical letters, ligatures and special spaces to their plain form.
 */
export function cleanText(text: string): string {
  return text.replace(FORMAT_CHARACTERS, "").normalize("NFKC").replace(FORMAT_CHARACTERS, "");
}

function characterRun(ascii: string, characters: string): Array<[string, string]> {
  return Array.from(characters, (character): [string, string] => [character, ascii]);
}

function digitRun(zero: number): Array<[string, string]> {
  return Array.from({ length: 10 }, (_, value): [string, string] => [String.fromCodePoint(zero + value), String(value)]);
}

/**
 * Cherokee, Lisu and Coptic letters that look like a Latin letter, by code point. Cherokee's small letters
 * (U+AB70-U+ABBF and U+13F8-U+13FD) look like their capitals, so each capital's small form is added below.
 */
const CHEROKEE_CAPITALS: ReadonlyArray<[number, string]> = [
  [0x13aa, "a"], [0x13f4, "b"], [0x13cf, "b"], [0x13df, "c"], [0x13a0, "d"], [0x13ac, "e"], [0x13c0, "g"], [0x13bb, "h"], [0x13d6, "i"],
  [0x13ab, "j"], [0x13e6, "k"], [0x13de, "l"], [0x13b7, "m"], [0x13e2, "p"], [0x13a1, "r"], [0x13d2, "r"], [0x13da, "s"], [0x13a2, "t"],
  [0x13d9, "v"], [0x13b3, "w"], [0x13b4, "w"], [0x13c3, "z"],
];
const EXTRA_SCRIPT_LETTERS: ReadonlyArray<[number, string]> = [
  ...CHEROKEE_CAPITALS,
  ...CHEROKEE_CAPITALS.map(([point, ascii]): [number, string] => [point <= 0x13ef ? point + 0x97d0 : point + 0x8, ascii]),
  // Lisu
  [0xa4ee, "a"], [0xa4d0, "b"], [0xa4da, "c"], [0xa4d3, "d"], [0xa4f0, "e"], [0xa4d6, "g"], [0xa4e7, "h"], [0xa4f2, "i"], [0xa4d9, "j"], [0xa4d7, "k"],
  [0xa4e1, "l"], [0xa4df, "m"], [0xa4f3, "o"], [0xa4d1, "p"], [0xa4e3, "r"], [0xa4e2, "s"], [0xa4d4, "t"], [0xa4f4, "u"], [0xa4e6, "v"], [0xa4ea, "w"],
  [0xa4eb, "x"], [0xa4ec, "y"], [0xa4dc, "z"],
  // Coptic
  [0x2c80, "a"], [0x2c81, "a"], [0x2c82, "b"], [0x2c88, "e"], [0x2c8e, "h"], [0x2c92, "i"], [0x2c93, "i"], [0x2c94, "k"], [0x2c98, "m"], [0x2c9a, "n"],
  [0x2c9e, "o"], [0x2c9f, "o"], [0x2ca2, "p"], [0x2ca3, "p"], [0x2ca4, "c"], [0x2ca5, "c"], [0x2ca6, "t"], [0x2ca8, "y"], [0x2cac, "x"],
];

/**
 * Look-alike characters folded to the ASCII they imitate, applied AFTER NFKC/NFKD (so full-width,
 * mathematical, circled and ligature forms are already plain, and accents are already gone). The target
 * is lowercase for letters. Coverage, by design explicit rather than the full Unicode confusables file:
 *  - Cyrillic and Greek letters that look like Latin ones (capitals and small letters), including the
 *    ones that look like a letter only in italic or small-capital form (к м н т в г);
 *  - Latin small capitals and IPA letters (ᴀ ʙ ᴄ ... ɑ ɡ ı ȷ) and a few barred or stroked letters (ø đ ł ħ ŧ);
 *  - a few Armenian and Cyrillic extension letters (ո օ ս ү ѵ ѡ);
 *  - Cherokee, Lisu and Coptic letters that imitate a Latin letter (the sets above, by code point);
 *  - decimal digits of the Arabic-Indic, Devanagari, Thai and other scripts, to 0-9;
 *  - the slash look-alikes ∕ ⁄ ⧸ ╱ ⟋ ᜵ Ⳇ and the at-sign look-alikes ＠ ﹫ (NFKC already maps both).
 * Not covered: letters that look like digits (O, l), and the open-ended tail of Unicode confusables. Those
 * would need a bot to read them as a command, which no bot does; see the plan's accepted residual risks.
 */
export const CONFUSABLE_FOLD: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...characterRun("a", "аАαΑɑᴀ"), ...characterRun("b", "βΒВвʙ"), ...characterRun("c", "сСϲϹᴄ"), ...characterRun("d", "ԁԀᴅđ"),
  ...characterRun("e", "еЕεΕᴇ"), ...characterRun("f", "ꜰ"), ...characterRun("g", "ɡɢԍ"), ...characterRun("h", "һҺнНΗʜħ"),
  ...characterRun("i", "іІιΙɪı"), ...characterRun("j", "јЈᴊȷ"), ...characterRun("k", "кКκΚᴋ"), ...characterRun("l", "ӏӀʟł"),
  ...characterRun("m", "мМΜᴍ"), ...characterRun("n", "ɴΝո"), ...characterRun("o", "оОοΟᴏøօՕ"), ...characterRun("p", "рРρΡᴘ"),
  ...characterRun("q", "ԛԚ"), ...characterRun("r", "ʀг"), ...characterRun("s", "ѕЅꜱ"), ...characterRun("t", "тТτΤᴛŧ"),
  ...characterRun("u", "υᴜս"), ...characterRun("v", "νѵᴠ"), ...characterRun("w", "ԝԜᴡѡ"), ...characterRun("x", "хХχΧ"),
  ...characterRun("y", "уУγΥʏүҮ"), ...characterRun("z", "ᴢΖ"),
  ...characterRun("/", "∕⁄⧸╱⟋᜵Ⳇ／"), ...characterRun("@", "＠﹫"),
  ...EXTRA_SCRIPT_LETTERS.map(([point, ascii]): [string, string] => [String.fromCodePoint(point), ascii]),
  // Nd blocks outside NFKC's reach (NFKC maps the full-width and mathematical digits already).
  ...[0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20,
    0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
    0xa9f0, 0xaa50, 0xabf0].flatMap(digitRun),
]));

/**
 * The copy that patterns run on: cleaned, then stripped of the other invisible characters and of
 * combining marks (NFKD), folded through CONFUSABLE_FOLD, with every kind of space as a plain space.
 * Line separators are kept (see commentLines). Letter case is kept for ASCII; matchers are case-insensitive.
 * Never send this copy anywhere; send cleanText.
 */
export function normalizeForMatching(text: string): string {
  return foldedCopy(text, "");
}

/** The copy of a text with each invisible character and control character removed (gap "") or replaced by a space (gap " "). */
function foldedCopy(text: string, gap: "" | " "): string {
  const visible = text.replace(FORMAT_CHARACTERS, gap).normalize("NFKC").replace(FORMAT_CHARACTERS, gap);
  const stripped = visible.replace(IGNORABLE_CHARACTERS, gap).normalize("NFKD").replace(COMBINING_MARKS, "");
  let folded = "";
  for (const character of stripped) folded += CONFUSABLE_FOLD[character] ?? character;
  return folded.replace(SPACE_LIKE, " ").replace(OTHER_CONTROLS, gap);
}

/**
 * What the matchers scan: the normalized copy, and, when the text holds invisible characters, a second
 * copy in which each of them (and each control character) is a space. A zero-width character may stand in for the gap between a
 * command and its argument (`bors\u200Br+`) as easily as it may hide inside a word (`/de\u200Bploy`),
 * and which one a given bot reads is not knowable, so both are checked.
 */
function matchingCopies(text: string): string[] {
  const joined = foldedCopy(text, "");
  const spaced = foldedCopy(text, " ");
  return joined === spaced ? [joined] : [joined, spaced];
}

/** The lines of a text, on LF, CR, U+2028, U+2029 and U+0085, normalized for matching. */
export function commentLines(text: string): string[] {
  return normalizeForMatching(text).split(LINE_SEPARATORS);
}

// ---------------------------------------------------------------------------------------------
// Patterns and constants
// ---------------------------------------------------------------------------------------------

/** Tags whose closing form `</tag>` is markup, not a command. Only these; `</deploy>` and `</merge>` are commands. */
export const HTML_TAG_NAMES: readonly string[] = Object.freeze([
  "details", "summary", "sub", "sup", "br", "b", "i", "em", "strong", "code", "pre", "p", "div", "span", "kbd", "table", "thead", "tbody",
  "tr", "td", "th", "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
]);
const HTML_TAGS = new Set(HTML_TAG_NAMES);

/** Bot and app accounts an @-mention of which is always consequential. */
export const KNOWN_BOT_ACCOUNTS: readonly string[] = Object.freeze(["mergifyio", "mergify", "kodiakhq", "dependabot", "renovate", "bors", "github-actions"]);
const KNOWN_BOTS = new Set(KNOWN_BOT_ACCOUNTS);

/** Not preceded by a word character, so `dependabot@example.com` is an email address, not a mention. */
const MENTION_START = "(?<![A-Za-z0-9_])@";
/** Word boundaries that treat `_`, `*` and other Markdown marks as separators (unlike \b): a letter or digit is the only word character. */
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

/**
 * Bots that act on a comment's text. Maintained: new bots are added in releases. Each pattern runs
 * case-insensitively on the normalized copy of ONE line, anywhere in the line, unanchored.
 */
export const COMMAND_COMMENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  // bors: generic on purpose, so `bors r+`, `bors r=alice`, `bors delegate+`, `bors try` and `bors ping` all count,
  // and so do the same words wrapped in markdown (`_bors r+_`, `**bors** r+`). No \b: an underscore is a word
  // character to \b, and Markdown puts underscores and asterisks around words. A command that wraps onto the
  // next line is handled by BORS_AT_LINE_END.
  { name: "bors", pattern: new RegExp(`${NOT_WORD_BEFORE}bors${NOT_WORD_AFTER}(?:\\s+\\S|[\\s\\p{P}\\p{S}]*[\\p{L}\\p{N}])`, "iu") },
  { name: "mergify", pattern: new RegExp(`${MENTION_START}mergify(?:io)?${NOT_WORD_AFTER}`, "iu") },
  { name: "kodiak", pattern: new RegExp(`${MENTION_START}kodiakhq${NOT_WORD_AFTER}|${NOT_WORD_BEFORE}kodiak${NOT_WORD_AFTER}(?:\\s+\\S|[\\s\\p{P}\\p{S}]*[\\p{L}\\p{N}])`, "iu") },
  { name: "atlantis", pattern: new RegExp(`${NOT_WORD_BEFORE}atlantis${NOT_WORD_AFTER}[\\s\\p{P}\\p{S}]*(?:plan|apply|unlock|approve_policies|import|state|version|help)${NOT_WORD_AFTER}`, "iu") },
  { name: "dependabot", pattern: new RegExp(`${MENTION_START}dependabot${NOT_WORD_AFTER}`, "iu") },
  { name: "renovate", pattern: new RegExp(`${MENTION_START}renovate${NOT_WORD_AFTER}`, "iu") },
  { name: "bors mention", pattern: new RegExp(`${MENTION_START}bors${NOT_WORD_AFTER}`, "iu") },
  { name: "github-actions", pattern: new RegExp(`${MENTION_START}github-actions${NOT_WORD_AFTER}`, "iu") },
  { name: "coding agents", pattern: new RegExp(`${MENTION_START}(?:copilot|claude|codex|coderabbitai)${NOT_WORD_AFTER}`, "iu") },
  { name: "jenkins", pattern: new RegExp(`${NOT_WORD_BEFORE}(?:retest|test)\\s+this\\s+please${NOT_WORD_AFTER}|${NOT_WORD_BEFORE}ok\\s+to\\s+test${NOT_WORD_AFTER}`, "iu") },
]);

/** `bors` at the end of a line: its command may be on the next line. */
const BORS_AT_LINE_END = new RegExp(`${NOT_WORD_BEFORE}bors${NOT_WORD_AFTER}[\\s\\p{P}\\p{S}]*$`, "iu");

/** A label whose addition starts a merge, deploy or release in many repositories. Matched against a whole label, case-insensitively. */
export const TRIGGER_LABEL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: "automerge", pattern: /^auto[-_ ]?merge$/iu },
  { name: "merge", pattern: /^merge$/iu },
  { name: "ready-to-merge", pattern: /^ready[-_ ]?to[-_ ]?merge$/iu },
  { name: "merge-queue", pattern: /^merge[-_ ]?queue$/iu },
  { name: "deploy", pattern: /^deploy(?:$|[-_:/ ])/iu },
  { name: "release", pattern: /^release(?:$|[-_:/ ])/iu },
  { name: "ship", pattern: /^ship(?:[-_ ]?it)?$/iu },
  { name: "rollback", pattern: /^roll[-_ ]?back$/iu },
  { name: "hotfix-deploy", pattern: /^hotfix[-_ ]?deploy$/iu },
]);

/**
 * A `/word` token: a `/` followed by a letter, not preceded by a letter, digit, `.`, `/`, `-` or `:`,
 * and not followed by another `/` (a token followed by `/` is a path segment, as in /usr/bin). The word
 * runs to the first character that is not a letter, digit, `_` or `-`; the trailing lookahead stops the
 * engine backtracking to a shorter word that a `/` would then no longer follow.
 */
const SLASH_COMMAND = /(?<![\p{L}\p{N}./:-])\/(\p{L}[\p{L}\p{N}_-]*)(?![\p{L}\p{N}_/-])/gu;
/**
 * A line whose first non-space character is a slash followed by a letter is a command whatever follows
 * (`/deploy/production`, `/merge/`, `//deploy`): bots and workflows test the start of the comment, and
 * the path exemption of SLASH_COMMAND is for the middle of a line only. A quote or Markdown mark before
 * the slash (`> /merge/`, `` `/merge/` ``) does not hide it.
 */
const LINE_START_SLASH = /^[\s>`"'*_~]*\/+(\p{L}[\p{L}\p{N}_-]*)/u;
const MENTION = /(?<![A-Za-z0-9_])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?(?:\[bot\])?)/gu;

/** The deepest nesting walked. Real arguments (a Jira document is about a dozen levels) stay far below it. */
const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------------------------
// Walking the arguments
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every string value and every object key of the arguments at any depth, with whether it sits under a label path. Paths use
 * the item-path syntax (`a.b`, `a[].b`). A skipped path drops its whole subtree. Returns true when the
 * arguments nest deeper than the limit, which the caller treats as consequential.
 */
function walkStrings(
  value: unknown,
  path: string,
  depth: number,
  inLabel: boolean,
  skip: ReadonlySet<string>,
  labels: ReadonlySet<string>,
  visit: (text: string, isLabel: boolean) => void,
): boolean {
  if (typeof value === "string") {
    visit(value, inLabel);
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  if (depth > MAX_DEPTH) return true;
  let tooDeep = false;
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) tooDeep = walkStrings(entry, `${path}[]`, depth + 1, inLabel, skip, labels, visit) || tooDeep;
    return tooDeep;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (skip.has(childPath)) continue;
    // A key can reach the vendor as text (a custom-field or label map), so it is scanned like a value; under a label path it is a label.
    visit(key, inLabel);
    tooDeep = walkStrings(entry, childPath, depth + 1, inLabel || labels.has(childPath), skip, labels, visit) || tooDeep;
  }
  return tooDeep;
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

export interface CommentSignalOptions {
  /** The recipe setting: when true, mentions are kept (and every one is consequential). */
  allowMentions: boolean;
  /** Item-path syntax paths whose values are label names (a string, or an array or object of them). */
  labelPaths: readonly string[];
  /** Item-reference and enum-valued arguments named in the tool's schema, which are not text. Their whole subtree is skipped. */
  skipPaths?: readonly string[] | undefined;
  /** Words an org's own automations act on (guardrail, at most 50). Any occurrence anywhere, with or without a slash, makes the write consequential. */
  extraCommandWords?: readonly string[] | undefined;
  /** Org-added trigger label patterns (guardrail `extraTriggerLabels`); `*` matches any run of characters. */
  extraTriggerLabels?: readonly string[] | undefined;
}

export interface CommentSignal { consequential: boolean; reasons: string[] }

/**
 * Whether a label matches a glob in which `*` is any run of characters: the first part is a prefix, the
 * last a suffix and the parts between occur in order. No regular expression, so no backtracking.
 */
function globMatches(glob: string, text: string): boolean {
  const parts = glob.split("*");
  if (parts.length === 1) return text === glob;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  const limit = text.length - last.length;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const at = text.indexOf(part, position);
    if (at < 0 || at + part.length > limit) return false;
    position = at + part.length;
  }
  return true;
}

/** The longest label that is matched; a longer one is consequential (GitHub allows 50 characters). */
const LABEL_MAX = 512;

function trimTrailingDotsAndHyphens(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === "." || name[end - 1] === "-")) end -= 1;
  return name.slice(0, end);
}

function isBotName(name: string): boolean {
  const lowered = trimTrailingDotsAndHyphens(name.toLowerCase());
  const bare = lowered.endsWith("[bot]") ? lowered.slice(0, -5) : lowered;
  if (bare !== lowered || bare.endsWith("-bot") || bare.endsWith("_bot")) return true;
  return bare.split("/").some((segment) => KNOWN_BOTS.has(segment));
}

/** Words one of which every COMMAND_COMMENT_PATTERNS entry needs; a line with none of them is not run through the patterns. */
const PATTERN_KEYWORDS = ["bors", "mergify", "kodiak", "atlantis", "dependabot", "renovate", "github-actions", "copilot", "claude", "codex", "coderabbitai", "test"] as const;

function lineReasons(line: string, reasons: Set<string>, options: CommentSignalOptions): void {
  // Cheap substring checks first, so a text of many short lines costs a few indexOf calls per line, not a dozen regular expressions.
  const lowered = line.toLowerCase();
  if (PATTERN_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
    for (const { name, pattern } of COMMAND_COMMENT_PATTERNS) if (pattern.test(line)) reasons.add(`command pattern: ${name}`);
  }
  if (line.includes("/")) {
    const leading = LINE_START_SLASH.exec(line);
    if (leading !== null) reasons.add(`slash command /${(leading[1] ?? "").toLowerCase().slice(0, 40)}`);
    for (const match of line.matchAll(SLASH_COMMAND)) {
      const word = (match[1] ?? "").toLowerCase();
      const index = match.index;
      if (index > 0 && line[index - 1] === "<" && HTML_TAGS.has(word)) continue;
      reasons.add(`slash command /${word.slice(0, 40)}`);
    }
  }
  if (line.includes("@")) {
    for (const match of line.matchAll(MENTION)) {
      const name = match[1] ?? "";
      if (isBotName(name)) reasons.add(`mention of a bot: @${name.slice(0, 40)}`);
      else if (options.allowMentions) reasons.add(`mention: @${name.slice(0, 40)}`);
    }
  }
}

/** The label values to test: the whole label, and each part of a comma- or semicolon-separated list. */
function labelCandidates(folded: string): string[] {
  return [folded, ...folded.split(/[,;\n]+/u).map((part) => part.trim())].filter((part) => part !== "");
}

/** Scans the lines of one matching copy. A line that ends in `bors` may continue on the next non-blank line. */
function scanLines(copy: string, reasons: Set<string>, options: CommentSignalOptions): void {
  const lines = copy.split(LINE_SEPARATORS);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    lineReasons(line, reasons, options);
    if (!line.toLowerCase().includes("bors") || !BORS_AT_LINE_END.test(line)) continue;
    let next = index + 1;
    while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
    if (next < lines.length) reasons.add("command pattern: bors (command on the next line)");
  }
}

/**
 * Whether a text or label write is consequential, and why. It is when any string of the arguments, at
 * any depth: holds a slash command; matches a COMMAND_COMMENT_PATTERNS entry on some line; @-mentions a
 * bot or app account (always) or anyone (when allowMentions keeps mentions); holds an extra command word;
 * or, under a label path, matches a trigger label. Arguments nested beyond the walk limit are consequential.
 */
export function commentSignal(args: unknown, options: CommentSignalOptions): CommentSignal {
  const reasons = new Set<string>();
  const extraWords = (options.extraCommandWords ?? []).map((word) => normalizeForMatching(word).trim().toLowerCase()).filter((word) => word !== "");
  const extraLabels = (options.extraTriggerLabels ?? []).map((glob) => normalizeForMatching(glob).trim().toLowerCase()).filter((glob) => glob !== "");
  const tooDeep = walkStrings(args, "", 0, false, new Set(options.skipPaths ?? []), new Set(options.labelPaths), (text, isLabel) => {
    for (const copy of matchingCopies(text)) {
      scanLines(copy, reasons, options);
      const lowered = copy.toLowerCase();
      for (const word of extraWords) if (lowered.includes(word)) reasons.add(`extra command word: ${word.slice(0, 40)}`);
    }
    if (!isLabel) return;
    const folded = normalizeForMatching(text).trim();
    if (folded.length > LABEL_MAX) {
      reasons.add("label too long to check");
      return;
    }
    for (const candidate of labelCandidates(folded)) {
      for (const { name, pattern } of TRIGGER_LABEL_PATTERNS) if (pattern.test(candidate)) reasons.add(`trigger label: ${name}`);
      const lowered = candidate.toLowerCase();
      for (const glob of extraLabels) if (globMatches(glob, lowered)) reasons.add(`trigger label: ${candidate.slice(0, 40)}`);
    }
  });
  if (tooDeep) reasons.add("arguments nested too deeply to check");
  return { consequential: reasons.size > 0, reasons: [...reasons].slice(0, 20) };
}

// ---------------------------------------------------------------------------------------------
// Stripping mentions
// ---------------------------------------------------------------------------------------------

export interface StripMentionsOptions {
  /** Item-reference and enum-valued arguments, left exactly as given. */
  skipPaths?: readonly string[] | undefined;
}

/**
 * A run of `@` that starts a mention: not preceded by another `@`, followed by a name character, as in
 * `@alice`, `@@alice` and `@acme/team`. The lookbehind keeps the engine from restarting inside a run, and
 * the name is captured in a lookahead so the whole pass is linear.
 */
const MENTION_RUN = /(?<!@)(@+)(?=([\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?))/gu;
const ASCII_WORD_CHARACTER = /[A-Za-z0-9_]/u;
/** The most removed mentions listed in `stripped`. */
const STRIPPED_MAX = 200;

function stripMentionsFromText(text: string, stripped: Set<string>): string {
  const cleaned = cleanText(text);
  // Every `@` of a run is removed, except that the first stays after a word character: `a@@b` becomes the
  // email-like `a@b`, which no vendor reads as a mention.
  return cleaned.replace(MENTION_RUN, (run: string, _at: string, name: string, offset: number) => {
    const afterWord = offset > 0 && ASCII_WORD_CHARACTER.test(cleaned[offset - 1] ?? "");
    if (run.length - (afterWord ? 1 : 0) > 0 && stripped.size < STRIPPED_MAX) stripped.add(`@${trimTrailingDotsAndHyphens(name)}`);
    return afterWord ? "@" : "";
  });
}

function stripValue(value: unknown, path: string, depth: number, skip: ReadonlySet<string>, stripped: Set<string>): unknown {
  if (typeof value === "string") return stripMentionsFromText(value, stripped);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) throw agentXError("CONFIG_INVALID", "The arguments are nested too deeply to check, so the request was not sent.");
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => stripValue(entry, `${path}[]`, depth + 1, skip, stripped));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const childPath = path === "" ? key : `${path}.${key}`;
    return [key, skip.has(childPath) ? entry : stripValue(entry, childPath, depth + 1, skip, stripped)];
  }));
}

/**
 * The arguments with every @name and @org/team turned into plain text (the `@` removed), by default for
 * every agent write; the recipe setting `allowMentions` keeps them. Every string it returns is the
 * cleaned (NFKC, Cf-removed) text, so what is approved and sent is what was checked. `stripped` lists
 * the mentions removed. The input is not changed. Arguments nested beyond the walk limit are refused.
 */
export function stripMentions(args: unknown, options: StripMentionsOptions = {}): { args: unknown; stripped: string[] } {
  const stripped = new Set<string>();
  const result = stripValue(args, "", 0, new Set(options.skipPaths ?? []), stripped);
  return { args: result, stripped: [...stripped] };
}
