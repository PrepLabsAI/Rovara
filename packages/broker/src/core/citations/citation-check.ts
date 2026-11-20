// The one citation check (W1, DEC 254z-amend): code re-reads every place a model says a statement came from, after the model has answered, and decides whether the quote is really there.
// A model can write a quote that is not in the file, a line that is not near it, or a file that does not exist; the agent that cited it could also have written its own workspace. So the
// cited file is read again through the caller's reader (the project's code host at a commit, never a working tree the agent could write), and the quote must sit within
// `CITATION_LINE_SLACK` lines of the cited line. Setup/plain citations may instead use a unique quote in the whole committed file; prose stays local.
//
// Used by:
//   - the setup agent's proposal re-read (setup-agent/proposal-verify.ts): `citationHolds`, `usableQuoteOf`, `readCitedFiles` and the reader type, with its own item rules on top;
//   - the answer service (J1) and later the wiki: `checkCitations` and `checkClaims` in the strict "prose" mode, which return a result per citation ("source_found" /
//     "source_not_found" / "unreadable") and which sentences survive.
//
// Fail closed and bounded, never a silent partial result:
//   - a read that throws, runs out of time, passes the deadline or a byte limit is "unreadable", never a pass, and makes the whole check not `complete`;
//   - at most `maxCitations` citations and `maxFiles` distinct files are looked at; the rest are "unreadable" (named as over the limit), not dropped;
//   - every citation must be at the commit the caller binds its repository to (`commits`); any other commit is not found, so a model cannot pick an old commit where its quote was true.
// No file text is kept or returned. A quote (at most 200 characters) or path that is returned for display is redacted and made inert with the same helper every model-written or file-name line of a pull request uses
// (`inertLine`, core/proof/inert-text.ts).
//
// The lessons verifier (lessons/citation-verifier.ts) does NOT use this rule: lessons are located by an exact anchor line with "moved" detection (`locateCitation` in contracts, shared with
// the worker), which is a different rule with different verdicts.
import { inertLine } from "../proof/inert-text.js";

/** Reads a file at a commit in one of the project's repositories: undefined when the file is not there; throws when the code host cannot answer. It must refuse a repository that is not the project's. */
export type CitationFileReader = (repository: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>;

/** How many lines either side of the cited line allow a quote without requiring whole-file uniqueness. Prose always uses this window. */
export const CITATION_LINE_SLACK = 3;
/** The shortest quote (whitespace collapsed) that can show anything. A one-word quote is in nearly every file. */
export const CITATION_QUOTE_MIN_CHARS = 8;
/** The commit forms the code host reader fetches: a full SHA-1 or SHA-256 hash. */
export const READABLE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const collapseWhitespace = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** The collapsed quote of a citation when it is long enough to show anything; undefined otherwise. */
export function usableQuoteOf(citation: { quote?: string | undefined }): string | undefined {
  if (citation.quote === undefined) return undefined;
  const wanted = collapseWhitespace(citation.quote);
  return [...wanted].length >= CITATION_QUOTE_MIN_CHARS ? wanted : undefined;
}

/**
 * Whether a file's text supports a citation: the citation has a usable quote (a citation with none holds nothing), the line exists, and the quote (whitespace collapsed) is within
 * `CITATION_LINE_SLACK` lines of it, or occurs exactly once in the whole file outside comment lines, preserving multiline quote boundaries. With no line, the quote may appear anywhere.
 * Callers must supply the whole committed file and separately check that quotes support their proposed values as whole tokens.
 */
export function citationHolds(text: string, citation: { line?: number | undefined; quote?: string | undefined; path?: string | undefined }): boolean {
  const wanted = usableQuoteOf(citation);
  if (wanted === undefined) return false;
  const lines = text.split(/\r\n|\r|\n/u);
  if (citation.line !== undefined && citation.line > lines.length) return false;
  if (citation.line === undefined) return collapseWhitespace(text).includes(wanted);
  if (quoteInWindow(lines, citation.line, wanted)) return true;
  const whole = collapseWhitespace(text);
  const first = whole.indexOf(wanted);
  // Advance one character, rather than the quote length, so overlapping occurrences count too.
  if (first === -1 || whole.indexOf(wanted, first + 1) !== -1) return false;
  // Preserve line boundaries for multiline fallback quotes. The original local window still collapses all whitespace.
  const quoteLines = citation.quote!.split(/\r\n|\r|\n/u).map(collapseWhitespace);
  if (quoteLines.length > 1 && !lines.map(collapseWhitespace).join("\n").includes(quoteLines.join("\n"))) return false;
  // Locate every source line contributing to the unique collapsed match, including a clipped first line.
  let offset = 0;
  for (const line of lines) {
    const normalised = collapseWhitespace(line);
    if (normalised === "") continue;
    if (offset > 0) offset += 1;
    const end = offset + normalised.length;
    if (offset < first + wanted.length && end > first && isCommentLine(line, citation.path)) return false;
    offset = end;
  }
  return true;
}

/** Comment syntax is file-specific; unknown types conservatively recognise all listed comment prefixes. */
function isCommentLine(line: string, path: string | undefined): boolean {
  const name = path?.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  let markers: readonly string[];
  if (["yml", "yaml", "sh", "bash", "zsh", "fish", "toml", "py", "rb", "ps1"].includes(extension) || ["dockerfile", "makefile"].includes(name)) markers = ["#"];
  else if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "c", "h", "cpp", "hpp", "java", "go", "rs", "cs", "swift", "kt"].includes(extension)) markers = ["//", "/*", "*"];
  else if (["css", "scss"].includes(extension)) markers = ["/*", "*"];
  else if (["ini", "cfg", "conf"].includes(extension)) markers = ["#", ";"];
  else if (extension === "sql") markers = ["--", "/*", "*"];
  else if (["html", "htm", "xml", "md", "markdown"].includes(extension)) markers = ["<!--"];
  else markers = ["#", "//", ";", "--", "/*", "*", "<!--"];
  return markers.some((marker) => line.trimStart().startsWith(marker));
}

/** The strict prose match, kept separate from the setup/plain whole-file fallback. */
function quoteInWindow(lines: readonly string[], line: number, wanted: string): boolean {
  if (line > lines.length) return false;
  const from = Math.max(0, line - 1 - CITATION_LINE_SLACK);
  return collapseWhitespace(lines.slice(from, line + CITATION_LINE_SLACK).join("\n")).includes(wanted);
}

/** How far a strict prose citation needs its file read: through the cited line and the margin after it, or the whole file when no line is named. */
export function untilLineOf(citation: { line?: number | undefined }): number | undefined {
  return citation.line === undefined ? undefined : citation.line + CITATION_LINE_SLACK + 1;
}

// ---- Bounded reads -------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One file to read: `untilLine` is the deepest line any citation of it needs; `whole` when one of them names no line. */
export interface CitedFileNeed { repository: string; path: string; commit: string; untilLine: number | undefined; whole: boolean }
export type CitedFileUnreadReason = "read_failed" | "deadline" | "file_too_large" | "total_bytes";
export type CitedFileRead = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unread"; reason: CitedFileUnreadReason };

export interface CitedFileReadLimits {
  /** At most this many files (the first ones, in the order given) are queued; the rest are never read. */
  maxFiles: number;
  concurrency: number;
  readTimeoutMs: number;
  /** The absolute time (by `now`) after which no read starts. */
  deadline: number;
  now: () => number;
  /** A file larger than this (UTF-8 bytes) is unread. No limit when absent. */
  maxFileBytes?: number | undefined;
  /** Once the files read (oversized ones included) add up to more than this, that file and every later one are unread. No limit when absent. */
  maxTotalBytes?: number | undefined;
  /** Race every read against its own timeout, so a reader that ignores `timeoutMs` cannot hang the check (a lost race is `deadline`). Off for the setup re-read, which is unchanged. */
  enforceTimeout?: boolean | undefined;
}

/** A read that gives up after `timeoutMs`, whatever the reader does; the timer never keeps the process alive. */
async function raced<T>(read: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); timer.unref?.(); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const TIMED_OUT = Symbol("timed out");

/**
 * Reads the needed files, a few at a time, within the deadline. Never throws: a read that throws is `unread`, a file that is not there is `missing`. `queued` names the files that were
 * within `maxFiles` (with no reader they are queued and left unread, so a caller can tell "could not read" from "beyond the budget").
 */
export async function readCitedFiles(read: CitationFileReader | undefined, needs: ReadonlyMap<string, CitedFileNeed>, limits: CitedFileReadLimits): Promise<{ texts: Map<string, CitedFileRead>; queued: ReadonlySet<string> }> {
  const texts = new Map<string, CitedFileRead>();
  const queue = [...needs.entries()].slice(0, limits.maxFiles);
  const queued = new Set(queue.map(([key]) => key));
  if (read !== undefined) {
    const countBytes = limits.maxFileBytes !== undefined || limits.maxTotalBytes !== undefined;
    let total = 0;
    let overTotal = false;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next;
        next += 1;
        const entry = queue[index];
        if (entry === undefined) return;
        const remaining = limits.deadline - limits.now();
        if (remaining <= 0) { texts.set(entry[0], { kind: "unread", reason: "deadline" }); continue; }
        if (overTotal) { texts.set(entry[0], { kind: "unread", reason: "total_bytes" }); continue; }
        const [key, need] = entry;
        try {
          const timeoutMs = Math.max(1, Math.min(limits.readTimeoutMs, remaining));
          const reading = read(need.repository, need.path, need.commit, { ...(need.whole ? {} : { untilLine: need.untilLine! }), timeoutMs });
          const text = limits.enforceTimeout === true ? await raced(reading, timeoutMs) : await reading;
          if (text === TIMED_OUT) { texts.set(key, { kind: "unread", reason: "deadline" }); continue; }
          if (text === undefined) { texts.set(key, { kind: "missing" }); continue; }
          if (countBytes) {
            // Throws for an answer that is not text (a broken reader): that read did not finish.
            const bytes = Buffer.byteLength(text, "utf8");
            // An oversized file was still fetched: it counts toward the total too.
            total += bytes;
            const overFile = limits.maxFileBytes !== undefined && bytes > limits.maxFileBytes;
            if (limits.maxTotalBytes !== undefined && total > limits.maxTotalBytes) overTotal = true;
            if (overFile) { texts.set(key, { kind: "unread", reason: "file_too_large" }); continue; }
            if (overTotal) { texts.set(key, { kind: "unread", reason: "total_bytes" }); continue; }
          }
          texts.set(key, { kind: "text", text });
        } catch {
          texts.set(key, { kind: "unread", reason: "read_failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, queue.length) }, worker));
  }
  return { texts, queued };
}

// ---- Per-citation check (answers, wiki) ----------------------------------------------------------------------------------------------------------------------------------------------
//
// Wording (DEC 254zh, wiki design review fix 1): a result says the SOURCE was found or not found. It never says the statement is true ("verified"): the check proves that the quoted text
// is in the file at that place, not that the sentence is right.
//
// Two modes. "prose" (the default; for answers and the wiki) is strict, because prose has no value a quote can be compared with the way a setup command can:
//   - a line is required (no match anywhere in the file);
//   - the quote must be at least `PROSE_QUOTE_MIN_CHARS` characters (whitespace collapsed);
//   - in `checkClaims`, every code name in the sentence (a span in backticks, a path or file name, a camelCase, PascalCase or snake_case name, a `name()` call) must appear as a whole token
//     in one of that sentence's quotes.
// "plain" is the setup rule (`citationHolds` as it is: an 8-character quote, anywhere when no line is named), for a caller that compares a value itself.

/** A place a statement says it came from. The commit is the one the citation was recorded at; it must equal the commit the caller binds the repository to. */
export interface CitationRef { repo: string; path: string; commit: string; line?: number | undefined; quote?: string | undefined }

/** The shortest quote (whitespace collapsed) prose may lean on. */
export const PROSE_QUOTE_MIN_CHARS = 20;

export type CitationCheckMode = "prose" | "plain";
export type CitationOutcome = "source_found" | "source_not_found" | "unreadable";
/** Fixed reasons, never text from the file or the model. */
export type CitationNotFoundReason = "quote_not_at_line" | "file_missing" | "no_usable_quote" | "quote_too_short" | "line_required" | "bad_line" | "commit_not_bound" | "path_not_safe";
export type CitationUnreadableReason = CitedFileUnreadReason | "commit_not_readable" | "over_citation_limit" | "over_file_limit" | "no_reader";

/**
 * A citation as it may be stored or shown: repository, path and quote redacted and made inert, one line each, bounded (a quote to `SHOWN_QUOTE_MAX` characters). Stored only as fields of a
 * row (never as a file), so the company purge removes it with the row.
 */
export interface ShownCitation { repo: string; path: string; commit: string; line?: number; quote?: string }

export type CitationResult =
  | { outcome: "source_found"; shown: ShownCitation }
  | { outcome: "source_not_found"; reason: CitationNotFoundReason; shown: ShownCitation }
  | { outcome: "unreadable"; reason: CitationUnreadableReason; shown: ShownCitation };

export interface CitationCheckLimits {
  maxCitations: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  concurrency: number;
  deadlineMs: number;
  readTimeoutMs: number;
}

/** The defaults, which are also the ceilings: a caller may only lower them, so no caller can make the check unbounded. */
export const CITATION_CHECK_LIMITS: Readonly<CitationCheckLimits> = Object.freeze({
  maxCitations: 32,
  maxFiles: 16,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  concurrency: 4,
  deadlineMs: 20_000,
  readTimeoutMs: 8_000,
});

export const SHOWN_REPO_MAX = 100;
export const SHOWN_PATH_MAX = 256;
export const SHOWN_QUOTE_MAX = 200;

export interface CitationCheckOptions {
  /** The commit each repository must be checked at (the answer's current commit, the wiki page's build commit). A citation of a repository not in it, or at another commit, is not found. */
  commits: ReadonlyMap<string, string>;
  /** "prose" when absent. */
  mode?: CitationCheckMode | undefined;
  limits?: Partial<CitationCheckLimits> | undefined;
  now?: (() => number) | undefined;
}

/** `complete` is true only when every citation got a final "source_found" or "source_not_found": any "unreadable" makes it false. */
export interface CitationCheck { results: CitationResult[]; complete: boolean }

/** The limits in force: each one the caller's value when it is a positive whole number at or below the default, otherwise the default. */
export function effectiveCitationLimits(given: Partial<CitationCheckLimits> | undefined): CitationCheckLimits {
  const out = { ...CITATION_CHECK_LIMITS };
  if (given !== undefined) {
    for (const key of Object.keys(out) as (keyof CitationCheckLimits)[]) {
      const value = given[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value < out[key]) out[key] = value;
    }
  }
  return out;
}

/** A repository-relative path a citation may name: no empty, dot or dot-dot segment, no backslash, no leading slash, no control character, bounded. */
export function isSafeCitedPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512 || path.includes("\\") || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

const isLine = (line: unknown): line is number => typeof line === "number" && Number.isInteger(line) && line >= 1;
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** A citation made safe to store or show: redacted and inert (`inertLine`), one line, bounded; the line only when it is a whole positive number. */
export function shownCitation(citation: CitationRef): ShownCitation {
  const quote = asText(citation.quote);
  return {
    repo: inertLine(asText(citation.repo), SHOWN_REPO_MAX),
    path: inertLine(asText(citation.path), SHOWN_PATH_MAX),
    commit: READABLE_COMMIT.test(asText(citation.commit)) ? citation.commit : inertLine(asText(citation.commit), 64),
    ...(isLine(citation.line) ? { line: citation.line } : {}),
    ...(quote === "" ? {} : { quote: inertLine(quote, SHOWN_QUOTE_MAX) }),
  };
}

/**
 * Re-reads every citation through `read` and returns one result per citation, in order. Never throws. A source is found only when the citation's repository is bound to exactly its commit,
 * its path is safe, it has a usable quote (in prose: a line and a quote of at least `PROSE_QUOTE_MIN_CHARS`), its file was read within the limits, and the quote is within
 * `CITATION_LINE_SLACK` lines of its line (in plain mode, also a unique whole-file quote, or anywhere when it names none).
 */
export async function checkCitations(read: CitationFileReader | undefined, citations: readonly CitationRef[], options: CitationCheckOptions): Promise<CitationCheck> {
  const prose = (options.mode ?? "prose") !== "plain";
  const limits = effectiveCitationLimits(options.limits);
  const now = options.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const keyOf = (citation: CitationRef) => `${citation.repo}\0${citation.commit}\0${citation.path}`;

  // First what needs no read; then one read per (repository, commit, path), as far as the deepest line any citation needs.
  const early: (CitationResult | undefined)[] = citations.map((citation, index) => {
    const shown = shownCitation(citation);
    if (index >= limits.maxCitations) return { outcome: "unreadable", reason: "over_citation_limit", shown };
    const bound = typeof citation.repo === "string" ? options.commits.get(citation.repo) : undefined;
    if (bound === undefined || citation.commit !== bound) return { outcome: "source_not_found", reason: "commit_not_bound", shown };
    if (!READABLE_COMMIT.test(citation.commit)) return { outcome: "unreadable", reason: "commit_not_readable", shown };
    if (!isSafeCitedPath(citation.path)) return { outcome: "source_not_found", reason: "path_not_safe", shown };
    if (citation.line !== undefined && !isLine(citation.line)) return { outcome: "source_not_found", reason: "bad_line", shown };
    if (prose && citation.line === undefined) return { outcome: "source_not_found", reason: "line_required", shown };
    if (citation.quote !== undefined && typeof citation.quote !== "string") return { outcome: "source_not_found", reason: "no_usable_quote", shown };
    const quote = usableQuoteOf(citation);
    if (quote === undefined) return { outcome: "source_not_found", reason: "no_usable_quote", shown };
    if (prose && [...quote].length < PROSE_QUOTE_MIN_CHARS) return { outcome: "source_not_found", reason: "quote_too_short", shown };
    return undefined;
  });
  const needs = new Map<string, CitedFileNeed>();
  citations.forEach((citation, index) => {
    if (early[index] !== undefined) return;
    const key = keyOf(citation);
    const entry = needs.get(key) ?? { repository: citation.repo, path: citation.path, commit: citation.commit, untilLine: 0, whole: false };
    const until = prose ? untilLineOf(citation) : undefined;
    if (until === undefined) entry.whole = true;
    else entry.untilLine = Math.max(entry.untilLine ?? 0, until);
    needs.set(key, entry);
  });

  const { texts, queued } = await readCitedFiles(read, needs, {
    maxFiles: limits.maxFiles, concurrency: limits.concurrency, readTimeoutMs: limits.readTimeoutMs, deadline, now, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes,
    enforceTimeout: true,
  });

  const results = citations.map((citation, index): CitationResult => {
    const known = early[index];
    if (known !== undefined) return known;
    const shown = shownCitation(citation);
    const key = keyOf(citation);
    if (!queued.has(key)) return { outcome: "unreadable", reason: "over_file_limit", shown };
    const found = texts.get(key);
    if (found === undefined) return { outcome: "unreadable", reason: read === undefined ? "no_reader" : "read_failed", shown };
    if (found.kind === "unread") return { outcome: "unreadable", reason: found.reason, shown };
    if (found.kind === "missing") return { outcome: "source_not_found", reason: "file_missing", shown };
    // A reader that answers with something that is not text (a Buffer, say) did not finish the read.
    if (typeof found.text !== "string") return { outcome: "unreadable", reason: "read_failed", shown };
    const holds = prose ? quoteInWindow(found.text.split(/\r\n|\r|\n/u), citation.line!, usableQuoteOf(citation)!) : citationHolds(found.text, citation);
    return holds ? { outcome: "source_found", shown } : { outcome: "source_not_found", reason: "quote_not_at_line", shown };
  });
  return { results, complete: results.every((result) => result.outcome !== "unreadable") };
}

// ---- Code names in a sentence (prose) ------------------------------------------------------------------------------------------------------------------------------------------------

/** At most this many code names are taken from one sentence; a sentence with more is not kept (it cannot be checked within the bound). */
export const PROSE_CODE_NAMES_MAX = 16;
/** A sentence longer than this (characters) is not kept: one sentence of an answer or a wiki claim is never this long, and the code-name scan stays cheap. */
export const PROSE_SENTENCE_MAX_CHARS = 2_000;
const BACKTICKED = /`([^`\n]{1,200})`/gu;
// Every quantifier is bounded (a code name is at most 200 characters), so no shape can take quadratic time on a long run of word characters.
const CODE_SHAPES: readonly RegExp[] = [
  /[A-Za-z0-9_.-]{0,200}[A-Za-z0-9_-]\/[A-Za-z0-9_./-]{0,200}[A-Za-z0-9_-]/gu, // a path: a/b, src/app.ts
  /\b[A-Za-z0-9_-]{2,200}\.[a-z][a-z0-9]{0,5}\b/gu, // a file or member name: app.ts, Refund.limit
  /\b[A-Za-z_$][\w$]{0,200}(?=\(\))/gu, // a call: refund()
  /\b[a-z][a-z0-9]{0,200}[A-Z][A-Za-z0-9]{0,200}\b/gu, // camelCase
  /\b[A-Z][a-z0-9]{1,200}[A-Z][A-Za-z0-9]{0,200}\b/gu, // PascalCase with two humps
  /\b[A-Za-z][A-Za-z0-9]{0,200}_[A-Za-z0-9_]{1,200}\b/gu, // snake_case, SCREAMING_CASE
];

/** The code names a sentence mentions, in order of first appearance, each once: backticked spans (whitespace collapsed) and code-shaped words outside backticks. */
export function codeNamesOf(raw: string): string[] {
  const sentence = visibleText(raw);
  const names: string[] = [];
  const add = (name: string) => { const clean = collapseWhitespace(name); if (clean !== "" && !names.includes(clean)) names.push(clean); };
  for (const match of sentence.matchAll(BACKTICKED)) add(match[1]!);
  const outside = sentence.replace(BACKTICKED, " ");
  for (const shape of CODE_SHAPES) for (const match of outside.matchAll(shape)) add(match[0]);
  return names;
}

/** Text as a person reads it: compatibility forms folded (NFKC) and invisible format characters removed, so `refund\u200BLimit` is the code name it looks like. */
const visibleText = (text: string): string => text.normalize("NFKC").replace(/\p{Cf}/gu, "");

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/u;
/** Whether `name` is in `quote` as a whole token: the characters either side (if any) are not identifier characters. Case-sensitive; whitespace collapsed on both. */
export function hasCodeToken(quote: string, name: string): boolean {
  const text = collapseWhitespace(visibleText(quote));
  const wanted = collapseWhitespace(visibleText(name));
  if (wanted === "") return false;
  for (let from = text.indexOf(wanted); from !== -1; from = text.indexOf(wanted, from + 1)) {
    const before = from === 0 ? "" : text[from - 1]!;
    const after = text[from + wanted.length] ?? "";
    if (!IDENTIFIER_CHARACTER.test(before) && !IDENTIFIER_CHARACTER.test(after)) return true;
  }
  return false;
}

// ---- Claims: which sentences survive -------------------------------------------------------------------------------------------------------------------------------------------------

/** One sentence of an answer (or one wiki claim) and the citations that are meant to support it. */
export interface ClaimToCheck { sentence: string; citations: readonly CitationRef[] }

/** Why a sentence was dropped; fixed words, never the sentence's or the file's text. */
export type ClaimDropReason = "uncited" | "not_a_sentence" | "source_not_found" | "unreadable" | "code_name_not_in_quote" | "too_many_code_names" | "code_name_too_long" | "sentence_too_long";

/** A sentence survives only when it has at least one citation, every source was found, and (prose) every code name it mentions is in one of its quotes. Sentences are returned as given: the caller makes them inert for the surface it shows them on. */
export interface ClaimResult { sentence: string; kept: boolean; dropped?: ClaimDropReason; results: CitationResult[] }
export interface ClaimsCheck {
  claims: ClaimResult[];
  /** The positions (in the order given) of the sentences that survive. */
  kept: number[];
  /** False when any citation was unreadable (a read failed, a limit was reached): the caller must not present the result as fully checked. */
  complete: boolean;
}

/** Why a claim cannot stand, or undefined when it can. */
function dropReasonOf(claim: ClaimToCheck, results: readonly CitationResult[], prose: boolean): ClaimDropReason | undefined {
  if (typeof claim.sentence !== "string") return "not_a_sentence";
  if (results.length === 0) return "uncited";
  if (results.some((result) => result.outcome === "unreadable")) return "unreadable";
  if (results.some((result) => result.outcome !== "source_found")) return "source_not_found";
  if (!prose) return undefined;
  if (claim.sentence.length > PROSE_SENTENCE_MAX_CHARS) return "sentence_too_long";
  // The code-name shapes stop at 200 characters, so a longer run of name characters could hide a name from them: such a sentence is not kept. (Linear: one character class.)
  if (/[A-Za-z0-9_$./-]{201}/u.test(visibleText(claim.sentence))) return "code_name_too_long";
  const names = codeNamesOf(claim.sentence);
  if (names.length > PROSE_CODE_NAMES_MAX) return "too_many_code_names";
  const quotes = claim.citations.map((citation) => asText(citation.quote));
  return names.every((name) => quotes.some((quote) => hasCodeToken(quote, name))) ? undefined : "code_name_not_in_quote";
}

/**
 * Checks a list of (sentence, citations) items in one bounded pass (the limits cover all citations together, in order) and says which sentences survive. A sentence with no citation,
 * with any citation whose source was not found or could not be read, or (prose) with a code name that none of its quotes contains, is dropped.
 */
export async function checkClaims(read: CitationFileReader | undefined, claims: readonly ClaimToCheck[], options: CitationCheckOptions): Promise<ClaimsCheck> {
  const prose = (options.mode ?? "prose") !== "plain";
  const flat = claims.flatMap((claim) => claim.citations);
  const { results, complete } = await checkCitations(read, flat, options);
  let at = 0;
  const out: ClaimResult[] = claims.map((claim) => {
    const mine = results.slice(at, at + claim.citations.length);
    at += claim.citations.length;
    const dropped = dropReasonOf(claim, mine, prose);
    return { sentence: claim.sentence, kept: dropped === undefined, ...(dropped === undefined ? {} : { dropped }), results: mine };
  });
  return { claims: out, kept: out.flatMap((claim, index) => (claim.kept ? [index] : [])), complete };
}
