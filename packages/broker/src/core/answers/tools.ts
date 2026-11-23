// The three read-only lookups the model may ask for (lead 4, J1): `wiki_search`, `wiki_read`, `code_read`. Nothing else exists: the service refuses any other name before it runs anything.
//
//  - Every lookup is bounded (calls, files, lines, bytes) and works on ONE project of ONE company: the wiki store is made for the company, every call names the project, and the code source is that
//    project's own repositories at the commits this answer is bound to.
//  - The wiki is read as an AGENT reads it (`audience: "agent"`): flagged and not-found claims, and pages marked wrong, are not shown; only approved notes are shown. The model is never shown a stored quote.
//  - Code is read at the commit bound for the answer, never a branch name, and secret-shaped files are refused with the same words as a file that is not there. Lines are redacted before the model sees them.
//  - Every result is framed as data (`frameUntrusted`).
import { ANSWER_LIMITS, WikiPageIdSchema, type WikiCitation, type WikiIndexEntry, type WikiStore } from "@agentx/contracts";
import { isSafeCitedPath } from "../citations/citation-check.js";
import { frameUntrusted } from "./frame.js";
import type { AnswerCodeSource } from "./ports.js";
import type { ToolCall } from "./protocol.js";
import { holdsPrivateKey, redactedLines, secretShapedPath } from "./secret-files.js";

/** The words a refused or failed lookup says. Fixed: they repeat nothing of the request. */
export const TOOL_WORDS = {
  callsUsed: `You have used all ${String(ANSWER_LIMITS.toolCalls)} lookups. Give your final answer now from what you have read.`,
  notATool: "That is not one of the three lookups (wiki_search, wiki_read, code_read). Use one of them or give your final answer.",
  noPage: "There is no such wiki page.",
  noFile: "That file is not available.",
  noRepo: "That is not a repository of this project.",
  tooManyFiles: `You have already opened ${String(ANSWER_LIMITS.codeFiles)} different files. Give your final answer from what you have read.`,
  notText: "That file is not text.",
  unavailable: "That lookup is not available right now.",
  empty: "Nothing found.",
} as const;

export interface WikiClaimSeen { pageId: string; claimId: string; citations: readonly WikiCitation[] }

export interface Toolbox {
  /** Runs one lookup. Always answers with framed text; never throws. `counted` is whether it used one of the answer's lookups. */
  run(call: ToolCall): Promise<{ text: string; ok: boolean }>;
  /** A refusal for a lookup of something that is not one of the three (counted against the budget like any other). */
  refuseOther(): { text: string; ok: false };
  /** The lookups used so far. */
  readonly used: number;
  readonly exhausted: boolean;
  /** The wiki pages read in full (id and title), in order. */
  readonly pagesRead: ReadonlyMap<string, string>;
  /** The claims the model was shown, so a "wiki_wrong" can only name a claim it really read. */
  readonly claimsSeen: ReadonlyMap<string, WikiClaimSeen>;
  /** Whether any wiki text was shown (a hit or a page); false means the wiki gave nothing and the code had to carry the answer. */
  readonly wikiShown: boolean;
  /** Drops presentation from a discarded attempt, retaining the whole-question lookup budget. */
  resetPresentation(): void;
}

export interface ToolboxOptions {
  project: string;
  wiki: Pick<WikiStore, "readIndex" | "readPage">;
  code: AnswerCodeSource;
  /** The commit bound to each repository for this answer. */
  heads: ReadonlyMap<string, string>;
  readTimeoutMs?: number | undefined;
}

const words = (query: string): string[] => [...new Set(query.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 2))].slice(0, 8);
const countHits = (haystack: string, terms: readonly string[]): number => { const lower = haystack.toLowerCase(); return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0); };

export function createToolbox(options: ToolboxOptions): Toolbox {
  const { project, wiki, code, heads } = options;
  const timeoutMs = options.readTimeoutMs ?? 8_000;
  let used = 0;
  const files = new Set<string>();
  const pagesRead = new Map<string, string>();
  const claimsSeen = new Map<string, WikiClaimSeen>();
  let wikiShown = false;
  const pageCache = new Map<string, Awaited<ReturnType<WikiStore["readPage"]>>>();
  const frame = (from: string, item: string, text: string): string => frameUntrusted({ from, item, text, maxBytes: ANSWER_LIMITS.resultBytes });

  async function pageOf(pageId: string): Promise<Awaited<ReturnType<WikiStore["readPage"]>>> {
    if (pageCache.has(pageId)) return pageCache.get(pageId);
    const read = await wiki.readPage(project, pageId, "agent");
    pageCache.set(pageId, read);
    return read;
  }

  async function search(query: string): Promise<string> {
    const terms = words(query);
    if (terms.length === 0) return frame("the project wiki", "search", TOOL_WORDS.empty);
    const index: WikiIndexEntry[] = await wiki.readIndex(project);
    // Titles and summaries first, then the text of the best-looking pages (bounded), so a search never walks a whole large wiki.
    const ranked = index.filter((entry) => !entry.flagged).map((entry) => ({ entry, score: countHits(`${entry.title} ${entry.summary} ${entry.pageId}`, terms) * 3 }));
    ranked.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order || a.entry.pageId.localeCompare(b.entry.pageId));
    const hits: Array<{ entry: WikiIndexEntry; score: number; snippet: string }> = [];
    for (const [position, candidate] of ranked.entries()) {
      let score = candidate.score;
      let snippet = candidate.entry.summary;
      if (position < ANSWER_LIMITS.searchPageReads) {
        const read = await pageOf(candidate.entry.pageId);
        if (read !== undefined) {
          for (const claim of read.page.claims) {
            if (claim.source === "not_found") continue;
            const found = countHits(claim.text, terms);
            if (found > 0) { score += found; if (countHits(snippet, terms) === 0) snippet = claim.text; }
          }
        }
      }
      if (score > 0) hits.push({ entry: candidate.entry, score, snippet });
    }
    hits.sort((a, b) => b.score - a.score || a.entry.pageId.localeCompare(b.entry.pageId));
    if (hits.length === 0) return frame("the project wiki", "search", TOOL_WORDS.empty);
    wikiShown = true;
    return frame("the project wiki", "search", hits.slice(0, ANSWER_LIMITS.searchHits).map(({ entry, snippet }) => `${entry.pageId} | ${entry.title} | ${snippet.slice(0, 160)}`).join("\n"));
  }

  async function readPage(pageIdRaw: string): Promise<string> {
    const parsed = WikiPageIdSchema.safeParse(pageIdRaw);
    if (!parsed.success) return frame("the project wiki", "page", TOOL_WORDS.noPage);
    const read = await pageOf(parsed.data);
    if (read === undefined) return frame("the project wiki", "page", TOOL_WORDS.noPage);
    const { page, notes, staleBlockIds } = read;
    const stale = new Set(staleBlockIds);
    const shownClaims = new Set(page.claims.map((claim) => claim.claimId));
    const lines: string[] = [`${page.title}`, page.summary];
    for (const block of page.blocks) {
      if (block.kind === "heading") lines.push(`\n## ${block.text}`);
      else if (block.kind === "paragraph") {
        // A paragraph resting on a claim the audience may not see (flagged, not found) is not shown at all.
        if (block.claimIds.some((id) => !shownClaims.has(id))) continue;
        lines.push(`${block.text}${stale.has(block.blockId) ? " (may be out of date)" : ""}`);
      }
    }
    lines.push("\nClaims:");
    for (const claim of page.claims) {
      const first = claim.citations[0];
      lines.push(`[${claim.claimId}] ${claim.text}${claim.source === "changed" ? " (may be out of date)" : ""}${first === undefined ? "" : ` (${first.repo}/${first.path}:${String(first.line)})`}`);
      claimsSeen.set(`${page.pageId}\0${claim.claimId}`, { pageId: page.pageId, claimId: claim.claimId, citations: claim.citations });
    }
    if (notes.length > 0) {
      lines.push("\nNotes a maintainer approved:");
      for (const note of notes) lines.push(`- ${note.text}`);
    }
    pagesRead.set(page.pageId, page.title);
    wikiShown = true;
    return frame("the project wiki", page.pageId, lines.join("\n"));
  }

  async function readCode(call: Extract<ToolCall, { tool: "code_read" }>): Promise<string> {
    const commit = heads.get(call.repo);
    if (commit === undefined || !code.repositories.includes(call.repo)) return frame("the project's code", "file", TOOL_WORDS.noRepo);
    // A secret-shaped or unsafe path says the same as a file that is not there.
    if (secretShapedPath(call.path) || !isSafeCitedPath(call.path)) return frame("the project's code", "file", TOOL_WORDS.noFile);
    const key = `${call.repo}\0${call.path}`;
    if (!files.has(key) && files.size >= ANSWER_LIMITS.codeFiles) return frame("the project's code", "file", TOOL_WORDS.tooManyFiles);
    const from = call.from ?? 1;
    const to = Math.min(call.to ?? from + ANSWER_LIMITS.linesPerRead - 1, from + ANSWER_LIMITS.linesPerRead - 1);
    if (to < from) return frame("the project's code", "file", TOOL_WORDS.noFile);
    files.add(key);
    let text: string | undefined;
    try { text = await code.read(call.repo, call.path, commit, { untilLine: to, timeoutMs }); } catch { return frame("the project's code", "file", TOOL_WORDS.unavailable); }
    if (text === undefined || typeof text !== "string") return frame("the project's code", "file", TOOL_WORDS.noFile);
    if (text.includes("\u0000")) return frame("the project's code", "file", TOOL_WORDS.notText);
    if (holdsPrivateKey(text)) return frame("the project's code", "file", TOOL_WORDS.noFile);
    const all = redactedLines(text).split("\n");
    const shown = all.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(5)}: ${line.length > ANSWER_LIMITS.lineChars ? `${line.slice(0, ANSWER_LIMITS.lineChars)}…` : line}`);
    if (shown.length === 0) return frame("the project's code", `${call.repo}/${call.path}`, "That file has no lines there.");
    return frame("the project's code", `${call.repo}/${call.path}@${commit.slice(0, 12)}`, shown.join("\n"));
  }

  return {
    async run(call) {
      if (used >= ANSWER_LIMITS.toolCalls) return { text: TOOL_WORDS.callsUsed, ok: false };
      used += 1;
      try {
        const text = call.tool === "wiki_search" ? await search(call.query) : call.tool === "wiki_read" ? await readPage(call.page) : await readCode(call);
        return { text, ok: true };
      } catch {
        return { text: frame("the answer service", "lookup", TOOL_WORDS.unavailable), ok: false };
      }
    },
    refuseOther() {
      used = Math.min(ANSWER_LIMITS.toolCalls, used + 1);
      return { text: TOOL_WORDS.notATool, ok: false };
    },
    get used() { return used; },
    get exhausted() { return used >= ANSWER_LIMITS.toolCalls; },
    get pagesRead() { return pagesRead; },
    get claimsSeen() { return claimsSeen; },
    get wikiShown() { return wikiShown; },
    resetPresentation() {
      pagesRead.clear();
      claimsSeen.clear();
      wikiShown = false;
    },
  };
}
