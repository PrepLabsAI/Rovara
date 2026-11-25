// The broker re-reads every place a setup proposal says a value came from. The worker's copy of a proposal is never trusted, and neither is the
// model behind it: a model can write a quote that is not in the file, or a file that does not exist. For each file citation (`file`, `ci`, `readme`, `manifest`) the broker reads
// `repo@commit:path` from the project's code host and checks that the quote is in that file. A citation is a file and an exact quote: any line a stored proposal still carries is ignored (the model cannot count lines).
// The whole file is read once per (repository, commit, path) and the quote must be in its code, comments cut off, whitespace made single on both sides (citation-locate.ts). For a command (setup, tests, check) or a name (a repository
// address, an allowed website) the place is also judged on the characters beside it in the file: the quote may not be cut out of a longer word (`npm ci` in `pnpm ci`, `acme/widgets` in `acme/widgets-old`).
//
// "Verified" has to mean that the quoted text SUPPORTS the proposed value, because a verified item for an empty setting is the only thing the page ticks for a person:
//   - a citation with no quote, or a quote shorter than `VERIFY_QUOTE_MIN_CHARS` (whitespace collapsed), proves nothing about a value: the item is `unchecked`;
//   - the value itself must be in the quotes: every proposed command (whitespace collapsed), the repository's URL or `owner/name`, a website's domain, or, for an existing dev
//     container, a citation of that very file. A quote that is in the file but does not contain the value makes the item `unverified`;
//   - an item of a kind with no value that a quote can show (a hint, a name, an inferred conclusion) is `unchecked` whatever it cites.
//
// An item is
//   `verified`    every file citation it has was read and holds with a usable quote, and the quotes support the value;
//   `unverified`  a citation was read and does NOT hold (missing file, or a quote that is not in the file at that commit), or the quotes do not contain the value;
//   `unchecked`   nothing could be shown: no usable quote, an inferred item, the code host could not be asked, or the budget for reads ran out.
// Only a verified, safe item for an empty setting is pre-ticked on the page. An unverified or unchecked item is still shown, so a person can decide, but never ticked for them.
//
// Bounded and fail closed: at most `READS_MAX` distinct files per proposal, a few at a time, within one deadline; whatever is left is `unchecked`. A file is read whole, within the code-host reader's existing byte cap (never a cut prefix;
// a file over the cap is `unchecked`). No file text is kept or returned: only the verdict. Whether a verdict is FINAL
// (so it can be kept on the draft and not read again on every page load) is decided here too: a read that failed or ran out of time is not final; a citation that cannot be read
// by design (no usable quote, a commit the reader cannot fetch, beyond the budget) is a final `unchecked`.
import { FILE_PROVENANCE_KINDS, setupItemsOf, type Provenance, type SetupItem, type SetupProposal, type SetupVerification } from "@agentx/contracts";
import {
  CITATION_QUOTE_MIN_CHARS, READABLE_COMMIT, collapseWhitespace as collapse, readCitedFiles, usableQuoteOf,
  type CitationFileReader, type CitedFileNeed,
} from "../citations/citation-check.js";
import { codeTextOf, isCommandClean, judgedOccurrence, type CodeText, type QuoteOccurrence } from "./citation-locate.js";

/** `owner/name` of a repository address on any host (the first two parts of its path), lower-cased; undefined for an address that is not an https address of that shape. */
export function repositoryFullNameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    const parts = parsed.pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
    return parts.length === 2 ? parts.join("/").toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export const VERIFY_READS_MAX = 40;
export const VERIFY_CONCURRENCY = 4;
export const VERIFY_DEADLINE_MS = 20_000;
export const VERIFY_READ_TIMEOUT_MS = 8_000;
/** The most characters of file text one verification scans for comments (three files of the code host's 20 MiB cap); past it the rest reads as comment. */
export const VERIFY_SCAN_BUDGET_CHARS = 64 * 1024 * 1024;
/** The shortest quote (whitespace collapsed) that can support a value: the shared citation check's minimum. */
export const VERIFY_QUOTE_MIN_CHARS = CITATION_QUOTE_MIN_CHARS;

const isFileCitation = (citation: Provenance): boolean => FILE_PROVENANCE_KINDS.includes(citation.kind);

/** Whether a quote can show an item's value at all. The kinds left out (a hint, a name, a drafted file) have no value a quote could contain: they are never `verified`. */
function isCheckable(item: SetupItem): boolean {
  switch (item.kind) {
    case "setup":
    case "tests":
    case "check":
    case "repository":
    case "knowledge":
    case "spec_target":
    case "allowed_domain": return true;
    case "devcontainer": return (item.proposed.value as { exists?: unknown }).exists === true;
    default: return false;
  }
}

/**
 * Whether `needle` is in `text` as a whole token: at some hit, the character before passes `beforeOk` (or the hit starts the text) and the text after passes `afterOk` (or the
 * hit ends it). A plain substring test would accept `npm ci` inside `pnpm ci`, `npm cia` or `rm -rf /` inside `rm -rf /tmp/cache`.
 */
type SourceEdges = { before: string | undefined; after: string | undefined };

function hasToken(text: string, needle: string, beforeOk: (character: string) => boolean, afterOk: (rest: string) => boolean, edges?: SourceEdges): boolean {
  if (needle === "") return false;
  for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
    const before = from === 0 ? edges?.before : text[from - 1]!;
    const rest = text.slice(from + needle.length) || edges?.after || "";
    if ((before === undefined || beforeOk(before)) && (rest === "" || afterOk(rest))) return true;
  }
  return false;
}

/** What may stand either side of a command: whitespace, a quote, or a shell separator or bracket. Anything else (a letter, `-`, `:`, `/`, `.`) makes it part of a longer token. */
const COMMAND_EDGE = /^[\s"'`;&|()[\]{},=]$/u;
/** The characters of a name (a repository's owner or name, a host label). */
const NAME_CHARACTER = /^[A-Za-z0-9_.-]$/u;
/** After a repository name or a host: the end, anything that is not a name character, or a full stop that ends a sentence (and `.git` after a repository). */
const endsName = (rest: string, allowGit: boolean): boolean => {
  const tail = allowGit && rest.startsWith(".git") ? rest.slice(4) : rest;
  return tail === "" || !/^[A-Za-z0-9_-]/u.test(tail) && (tail[0] !== "." || tail.length === 1 || !/^\.[A-Za-z0-9_-]/u.test(tail));
};

/** Whether the quotes (already shown to be in the files) contain what the item proposes, as whole tokens. Call only for a checkable item whose every file citation holds. */
function quotesSupport(item: SetupItem, citations: readonly Provenance[], sourceEdges: (citation: Provenance) => SourceEdges | undefined): boolean {
  const has = (needle: string): boolean => {
    const wanted = collapse(needle);
    return citations.some((citation) => {
      const quote = usableQuoteOf(citation);
      return quote !== undefined && hasToken(quote, wanted, (character) => COMMAND_EDGE.test(character), (rest) => COMMAND_EDGE.test(rest[0]!), sourceEdges(citation));
    });
  };
  /** A repository or host name, case-folded: not part of a longer name before it, and ending where a name ends. */
  const hasName = (needle: string, allowGit: boolean, bare = false): boolean => {
    const wanted = collapse(needle).toLowerCase();
    // A bare `owner/name` is not the address of a host: after `/`, `:` or `@` it is the path of some other host's repository (`https://evil.net/acme/widgets`).
    const beforeOk = (character: string): boolean => !NAME_CHARACTER.test(character) && !(bare && "/:@".includes(character));
    return citations.some((citation) => {
      const quote = usableQuoteOf(citation);
      return quote !== undefined && hasToken(quote.toLowerCase(), wanted, beforeOk, (rest) => endsName(rest, allowGit), sourceEdges(citation));
    });
  };
  const value = item.proposed.value as Record<string, unknown> | string;
  switch (item.kind) {
    case "setup":
    case "tests": return (value as { commands: string[] }).commands.every(has);
    case "check": return has((value as { command: string }).command);
    case "repository": {
      const url = String((value as { url: string }).url).replace(/\/+$/u, "").replace(/\.git$/u, "");
      const fullName = repositoryFullNameOf(url);
      const host = fullName === undefined ? "" : new URL(url).host;
      return hasName(url, true) || hasName(url.replace(/^https:\/\//u, ""), true) || (fullName !== undefined && (hasName(`${host}:${fullName}`, true) || hasName(fullName, true, true)));
    }
    case "devcontainer": return citations.some((citation) => citation.repo === (value as { repository: string }).repository && citation.path === (value as { configPath: string }).configPath);
    case "knowledge":
    case "spec_target": {
      const path = (value as { path: string }).path.replace(/\/+$/u, "");
      return citations.some((citation) => citation.path !== undefined && (citation.path === path || citation.path.startsWith(`${path}/`)));
    }
    case "allowed_domain": return hasName(value as string, false);
    default: return false;
  }
}

/** Only a command is held to a non-comment line and to whole tokens at the quote's edges; the other item kinds are checked against their own names and values. */
const isCommandItem = (item: SetupItem): boolean => item.kind === "setup" || item.kind === "tests" || item.kind === "check";

type Verdict = "holds" | "fails" | "unread" | "skipped";

/** Where a citation's quote was found: the verdict and, for a command, the characters beside the place judged (the quote may not be cut out of a longer word). */
interface Located { verdict: Verdict; edges?: SourceEdges }

/** Whether a name's quote (a repository address, a host) is cut out of a longer name at either end: a name character before it, or one after it that carries on the name. */
const isNameClean = (place: QuoteOccurrence): boolean => (place.before === undefined || !NAME_CHARACTER.test(place.before)) && endsName(place.after ?? "", true);

/** Items whose value is a name (a repository address, a host): the quote is judged on the name characters beside it, as a command's is on the shell separators. */
const isNameItem = (item: SetupItem): boolean => item.kind === "repository" || item.kind === "allowed_domain";

/**
 * A citation of a file that was read whole: its quote must be in the file's code text (comments cut off, a wholly commented line a break). A command's and a name's quote must also not be cut out of a longer word,
 * judged on the characters beside the place in the file; the edges are handed to the value check, which looks at the characters beside the quote.
 */
function locateInText(citation: Provenance, item: SetupItem, code: CodeText): Located {
  const place = judgedOccurrence(code, citation.quote!, isNameItem(item) ? isNameClean : isCommandClean);
  if (place === undefined) return { verdict: "fails" };
  return { verdict: "holds", ...(isCommandItem(item) || isNameItem(item) ? { edges: { before: place.before, after: place.after } } : {}) };
}

/** What re-reading a proposal found: a verdict per item, and whether every verdict is final (nothing was left unread by a failed read, a timeout or a deadline). */
export interface ProposalVerification { items: Record<string, SetupVerification>; final: boolean }

/** The verdict for every item of a proposal. Never throws: a failed read leaves the items that needed it `unchecked` and the result not final. */
export async function verifyProposalDetailed(
  read: CitationFileReader | undefined,
  proposal: SetupProposal,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<ProposalVerification> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? VERIFY_DEADLINE_MS);
  const items = setupItemsOf(proposal);
  /** Whether a citation is worth reading: a file citation of a checkable item that has a usable quote and a commit the reader can fetch. */
  const readable = (item: SetupItem, citation: Provenance): boolean => isCheckable(item) && isFileCitation(citation) && usableQuoteOf(citation) !== undefined && READABLE_COMMIT.test(citation.commit ?? "");

  // One read per (repository, commit, path): the whole file.
  const needs = new Map<string, CitedFileNeed>();
  const keyOf = (citation: Provenance) => `${citation.repo!}\0${citation.commit!}\0${citation.path!}`;
  for (const item of items) {
    for (const citation of item.proposed.from) {
      if (readable(item, citation)) needs.set(keyOf(citation), { repository: citation.repo!, path: citation.path!, commit: citation.commit!, untilLine: undefined, whole: true });
    }
  }

  // The shared bounded reader, with this proposal's budget and the code-host reader's existing byte cap.
  const { texts, queued } = await readCitedFiles(read, needs, { maxFiles: VERIFY_READS_MAX, concurrency: VERIFY_CONCURRENCY, readTimeoutMs: VERIFY_READ_TIMEOUT_MS, deadline, now });

  const located = new Map<Provenance, Located>();
  /** Each file's code text, made once (comments cut, whitespace made single), whatever number of citations it has. */
  const codes = new Map<string, CodeText>();
  /** The characters of file text the comment scan may go over in this verification; past it the rest of a file reads as comment, so a pile of huge files fails closed and fast. */
  const scanBudget = { left: VERIFY_SCAN_BUDGET_CHARS };
  const locationOf = (item: SetupItem, citation: Provenance): Located => {
    // Not worth a read, by design: it can never be better than unchecked, and reading it again would change nothing.
    if (!readable(item, citation)) return { verdict: "skipped" };
    const key = keyOf(citation);
    const found = texts.get(key);
    // Past the budget (never queued) is final too; a read that failed or ran out of time (queued) is not.
    if (found === undefined) return { verdict: queued.has(key) ? "unread" : "skipped" };
    // A file over the code host's size cap stays over it: a final unchecked, so the verdicts are kept and the file is not fetched again on every page load.
    if (found.kind === "unread") return { verdict: found.reason === "file_too_large" ? "skipped" : "unread" };
    if (found.kind === "missing") return { verdict: "fails" };
    const code = codes.get(key) ?? codeTextOf(found.text, citation.path, scanBudget);
    codes.set(key, code);
    const made = locateInText(citation, item, code);
    located.set(citation, made);
    return made;
  };

  /** Command matches must stay inside the original quote; source edges only validate a match touching a quote edge, never add evidence. */
  const sourceEdges = (citation: Provenance): SourceEdges | undefined => located.get(citation)?.edges;

  const result: Record<string, SetupVerification> = {};
  let final = true;
  for (const item of items) {
    const fileCitations = item.proposed.from.filter(isFileCitation);
    if (fileCitations.length === 0 || !isCheckable(item)) { result[item.id] = "unchecked"; continue; }
    const verdicts = fileCitations.map((citation) => locationOf(item, citation).verdict);
    if (verdicts.includes("fails")) result[item.id] = "unverified";
    else if (verdicts.includes("unread")) { result[item.id] = "unchecked"; final = false; }
    else if (verdicts.includes("skipped")) result[item.id] = "unchecked";
    else result[item.id] = quotesSupport(item, fileCitations, sourceEdges) ? "verified" : "unverified";
  }
  return { items: result, final };
}

/** The verdict for every item of a proposal (see `verifyProposalDetailed`). */
export async function verifyProposal(
  read: CitationFileReader | undefined,
  proposal: SetupProposal,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<Record<string, SetupVerification>> {
  return (await verifyProposalDetailed(read, proposal, options)).items;
}
