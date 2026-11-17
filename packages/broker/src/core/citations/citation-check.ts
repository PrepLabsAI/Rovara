// The one citation check (W1, DEC 254z-amend): code re-reads every place a model says a statement came from, after the model has answered, and decides whether the quote is really there.
// A model can write a quote that is not in the file, a line that is not near it, or a file that does not exist; the agent that cited it could also have written its own workspace. So the
// cited file is read again through the caller's reader (the project's code host at a commit, never a working tree the agent could write), and the quote must sit within
// `CITATION_LINE_SLACK` lines of the cited line.
//
// Used by:
//   - the setup agent's proposal re-read (setup-agent/proposal-verify.ts): `citationHolds`, `usableQuoteOf`, `readCitedFiles` and the reader type, with its own item rules on top;
//   - the answer service (J1) and later the wiki: `checkCitations` and `checkClaims`, which return a result per citation ("holds" / "fails" / "unreadable") and which sentences survive.
//
// Fail closed and bounded, never a silent partial result:
//   - a read that throws, runs out of time, passes the deadline or a byte limit is "unreadable", never a pass, and makes the whole check not `complete`;
//   - at most `maxCitations` citations and `maxFiles` distinct files are looked at; the rest are "unreadable" (named as over the limit), not dropped;
//   - every citation must be at the commit the caller binds its repository to (`commits`); any other commit fails, so a model cannot pick an old commit where its quote was true.
// No file text is kept or returned. A quote or path that is returned for display is redacted and made inert with the same helper every model-written or file-name line of a pull request uses
// (`inertLine`, core/proof/inert-text.ts).
//
// The lessons verifier (lessons/citation-verifier.ts) does NOT use this rule: lessons are located by an exact anchor line with "moved" detection (`locateCitation` in contracts, shared with
// the worker), which is a different rule with different verdicts.
import { inertLine } from "../proof/inert-text.js";

/** Reads a file at a commit in one of the project's repositories: undefined when the file is not there; throws when the code host cannot answer. It must refuse a repository that is not the project's. */
export type CitationFileReader = (repository: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>;

/** How many lines either side of the cited line the quote may be on. Models are off by a line or two; a wider window would let a quote match anywhere. */
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
 * `CITATION_LINE_SLACK` lines of it, or anywhere in the file when no line is named.
 */
export function citationHolds(text: string, citation: { line?: number | undefined; quote?: string | undefined }): boolean {
  const wanted = usableQuoteOf(citation);
  if (wanted === undefined) return false;
  const lines = text.split(/\r\n|\r|\n/u);
  if (citation.line !== undefined && citation.line > lines.length) return false;
  if (citation.line === undefined) return collapseWhitespace(text).includes(wanted);
  const from = Math.max(0, citation.line - 1 - CITATION_LINE_SLACK);
  const window = lines.slice(from, citation.line + CITATION_LINE_SLACK).join("\n");
  return collapseWhitespace(window).includes(wanted);
}

/** How far a citation needs its file read: through the cited line and the margin after it, or the whole file when no line is named. */
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
  /** Once the files read add up to more than this, that file and every later one are unread. No limit when absent. */
  maxTotalBytes?: number | undefined;
}

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
          const text = await read(need.repository, need.path, need.commit, {
            ...(need.whole ? {} : { untilLine: need.untilLine! }), timeoutMs: Math.max(1, Math.min(limits.readTimeoutMs, remaining)),
          });
          if (text === undefined) { texts.set(key, { kind: "missing" }); continue; }
          if (countBytes) {
            // Throws for an answer that is not text (a broken reader): that read did not finish.
            const bytes = Buffer.byteLength(text, "utf8");
            if (limits.maxFileBytes !== undefined && bytes > limits.maxFileBytes) { texts.set(key, { kind: "unread", reason: "file_too_large" }); continue; }
            total += bytes;
            if (limits.maxTotalBytes !== undefined && total > limits.maxTotalBytes) { overTotal = true; texts.set(key, { kind: "unread", reason: "total_bytes" }); continue; }
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

/** A place a statement says it came from. The commit is the one the citation was recorded at; it must equal the commit the caller binds the repository to. */
export interface CitationRef { repo: string; path: string; commit: string; line?: number | undefined; quote?: string | undefined }

export type CitationOutcome = "holds" | "fails" | "unreadable";
/** Fixed reasons, never text from the file or the model. */
export type CitationFailReason = "quote_not_at_line" | "file_missing" | "no_usable_quote" | "bad_line" | "commit_not_bound" | "path_not_safe";
export type CitationUnreadableReason = CitedFileUnreadReason | "commit_not_readable" | "over_citation_limit" | "over_file_limit" | "no_reader";

/** A citation as it may be stored or shown: repository, path and quote redacted and made inert, one line each, bounded. */
export interface ShownCitation { repo: string; path: string; commit: string; line?: number; quote?: string }

export type CitationResult =
  | { outcome: "holds"; shown: ShownCitation }
  | { outcome: "fails"; reason: CitationFailReason; shown: ShownCitation }
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
  /** The commit each repository must be checked at (the answer's current commit, the wiki page's build commit). A citation of a repository not in it, or at another commit, fails. */
  commits: ReadonlyMap<string, string>;
  limits?: Partial<CitationCheckLimits> | undefined;
  now?: (() => number) | undefined;
}

/** `complete` is true only when every citation got a final "holds" or "fails": any "unreadable" makes it false. */
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
 * Re-reads every citation through `read` and returns one result per citation, in order. Never throws. A citation holds only when its repository is bound to exactly its commit, its path is
 * safe, it has a usable quote, its file was read within the limits, and the quote is within `CITATION_LINE_SLACK` lines of its line (or anywhere when it names none).
 */
export async function checkCitations(read: CitationFileReader | undefined, citations: readonly CitationRef[], options: CitationCheckOptions): Promise<CitationCheck> {
  const limits = effectiveCitationLimits(options.limits);
  const now = options.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const keyOf = (citation: CitationRef) => `${citation.repo}\0${citation.commit}\0${citation.path}`;

  // First what needs no read; then one read per (repository, commit, path), as far as the deepest line any citation needs.
  const early: (CitationResult | undefined)[] = citations.map((citation, index) => {
    const shown = shownCitation(citation);
    if (index >= limits.maxCitations) return { outcome: "unreadable", reason: "over_citation_limit", shown };
    const bound = typeof citation.repo === "string" ? options.commits.get(citation.repo) : undefined;
    if (bound === undefined || citation.commit !== bound) return { outcome: "fails", reason: "commit_not_bound", shown };
    if (!READABLE_COMMIT.test(citation.commit)) return { outcome: "unreadable", reason: "commit_not_readable", shown };
    if (!isSafeCitedPath(citation.path)) return { outcome: "fails", reason: "path_not_safe", shown };
    if (citation.line !== undefined && !isLine(citation.line)) return { outcome: "fails", reason: "bad_line", shown };
    if (usableQuoteOf(citation) === undefined) return { outcome: "fails", reason: "no_usable_quote", shown };
    return undefined;
  });
  const needs = new Map<string, CitedFileNeed>();
  citations.forEach((citation, index) => {
    if (early[index] !== undefined) return;
    const key = keyOf(citation);
    const entry = needs.get(key) ?? { repository: citation.repo, path: citation.path, commit: citation.commit, untilLine: 0, whole: false };
    const until = untilLineOf(citation);
    if (until === undefined) entry.whole = true;
    else entry.untilLine = Math.max(entry.untilLine ?? 0, until);
    needs.set(key, entry);
  });

  const { texts, queued } = await readCitedFiles(read, needs, {
    maxFiles: limits.maxFiles, concurrency: limits.concurrency, readTimeoutMs: limits.readTimeoutMs, deadline, now, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes,
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
    if (found.kind === "missing") return { outcome: "fails", reason: "file_missing", shown };
    return citationHolds(found.text, citation) ? { outcome: "holds", shown } : { outcome: "fails", reason: "quote_not_at_line", shown };
  });
  return { results, complete: results.every((result) => result.outcome !== "unreadable") };
}

// ---- Claims: which sentences survive -------------------------------------------------------------------------------------------------------------------------------------------------

/** One sentence of an answer (or one wiki claim) and the citations that are meant to support it. */
export interface ClaimToCheck { sentence: string; citations: readonly CitationRef[] }

/** A sentence survives only when it has at least one citation and EVERY citation holds. Sentences are returned as given: the caller makes them inert for the surface it shows them on. */
export interface ClaimResult { sentence: string; kept: boolean; results: CitationResult[] }
export interface ClaimsCheck {
  claims: ClaimResult[];
  /** The positions (in the order given) of the sentences that survive. */
  kept: number[];
  /** False when any citation was unreadable (a read failed, a limit was reached): the caller must not present the result as fully checked. */
  complete: boolean;
}

/**
 * Checks a list of (sentence, citations) items in one bounded pass (the limits cover all citations together, in order) and says which sentences survive. A sentence with no citation,
 * or with any citation that fails or could not be read, is dropped.
 */
export async function checkClaims(read: CitationFileReader | undefined, claims: readonly ClaimToCheck[], options: CitationCheckOptions): Promise<ClaimsCheck> {
  const flat = claims.flatMap((claim) => claim.citations);
  const { results, complete } = await checkCitations(read, flat, options);
  let at = 0;
  const out: ClaimResult[] = claims.map((claim) => {
    const mine = results.slice(at, at + claim.citations.length);
    at += claim.citations.length;
    return { sentence: claim.sentence, kept: mine.length > 0 && mine.every((result) => result.outcome === "holds"), results: mine };
  });
  return { claims: out, kept: out.flatMap((claim, index) => (claim.kept ? [index] : [])), complete };
}
