// Wiki W3: the per-page citation check (review fix 4: chunked, cached by file version). Every sentence and every link the worker sends back is re-read through the code host at the
// run's pinned commits with the shared check (W1) in its strict PROSE mode, before the page is kept. What survives becomes the store's page write (W2 `WikiPageWrite`: every claim
// `found`, every citation at the page's repository commit); the rest is counted by fixed reason, never stored.
//
// Rules (each is a test):
//   - a sentence is kept only when it has a citation, every one of its sources is found at the pinned commit, and every code name it mentions is a whole token of one of its quotes (W1);
//   - a link ("How the repos connect") is kept only when BOTH sides' sources are found, the two sides are in different repositories, and its code names are in one of the two quotes;
//   - the check reads in chunks within the shared check's limits (at most 32 citations and 16 files a chunk) and under one page deadline; a chunk that cannot run is "unreadable", never a pass;
//   - a final verdict (found, or not found because of what the file holds) is cached by file version: the hash of repository, path, version (the file's blob id when the code host gives one,
//     else the commit), line and quote. A verdict that depends on anything else (an unbound commit, a limit, a failed read) is never cached. No file text and no quote is kept in the cache;
//   - the page's title is Rovara's own and its summary is the first kept sentence: no uncited model text heads a page. Section headings are short and stored as plain text;
//   - stored text is redacted, one line, without hidden characters, and with every frame tag broken, so a page cannot carry a frame into an agent's prompt later (page -> agent hop).
import { createHash } from "node:crypto";
import {
  WIKI_LIMITS, WIKI_QUOTE_MAX, defuseFrameTags, redactText, stripHiddenCharacters,
  type DocumentStore, type JsonValue, type WikiBlock, type WikiClaim, type WikiDraftCitation, type WikiPageDraft, type WikiPagePlan, type WikiPageWrite,
} from "@agentx/contracts";
import {
  CITATION_CHECK_LIMITS, PROSE_CODE_NAMES_MAX, checkCitations, codeNamesOf, collapseWhitespace, hasCodeToken, isSafeCitedPath,
  type CitationFileReader, type CitationRef, type CitationResult,
} from "../citations/citation-check.js";
import { wikiCheckCacheKey, wikiExpiryOf, type WikiBuildScope } from "./keys.js";

/** How long one page's check may take in all (every chunk). Past it, the chunks left are unreadable. */
export const WIKI_PAGE_CHECK_DEADLINE_MS = 90_000;
/** Bounds of stored text (characters). */
export const WIKI_TEXT_MAX = { heading: 80, sentence: 600, summary: 300, title: 120 } as const;
/** Kept claims per paragraph block (the store's `claimsPerBlock`). */
const CLAIMS_PER_PARAGRAPH = WIKI_LIMITS.claimsPerBlock;

/** A model-written line made safe to store: hidden characters gone, one line, redacted, frame tags broken, bounded (code points). Never empty-safe: callers skip an empty result. */
export function wikiStoredText(text: unknown, max: number): string {
  const plain = redactText(stripHiddenCharacters(typeof text === "string" ? text : "").text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const safe = defuseFrameTags(plain);
  const points = [...safe];
  return points.length <= max ? safe : `${points.slice(0, max - 1).join("")}…`;
}

/** A page's title, in Rovara's own words from the plan (never the model's): "Overview", the repository's name, the module's folder, or "How the repos connect". */
export function wikiPageTitle(plan: Pick<WikiPagePlan, "kind" | "repo" | "path">): string {
  if (plan.kind === "overview") return "Overview";
  if (plan.kind === "connections") return "How the repos connect";
  if (plan.kind === "repo") return wikiStoredText(plan.repo ?? "", WIKI_TEXT_MAX.title) || "Repository";
  return wikiStoredText(`${plan.repo ?? ""} / ${plan.path ?? ""}`, WIKI_TEXT_MAX.title) || "Module";
}

/** A citation as the store keeps it: the checked repository, path, commit and line, and the quote redacted and cut to 200 characters (the store redacts and cuts again). */
function storedCitation(citation: WikiDraftCitation): WikiClaim["citations"][number] {
  return { repo: citation.repo, path: citation.path, commit: citation.commit, line: citation.line, quote: wikiStoredText(citation.quote, WIKI_QUOTE_MAX) || "-" };
}

export type CachedVerdict = { outcome: "source_found" } | { outcome: "source_not_found"; reason: "quote_not_at_line" | "file_missing" };

export interface WikiCheckCache {
  get(hashes: readonly string[]): Promise<Map<string, CachedVerdict>>;
  put(entries: ReadonlyArray<[string, CachedVerdict]>): Promise<void>;
}

/** The cache over the project's own build partition (company AND project in the key). A row that does not read is a miss. */
export function storeCheckCache(store: Pick<DocumentStore, "getMany" | "put">, scope: WikiBuildScope, now: () => number): WikiCheckCache {
  return {
    async get(hashes) {
      const out = new Map<string, CachedVerdict>();
      for (let at = 0; at < hashes.length; at += 100) {
        const slice = hashes.slice(at, at + 100);
        const rows = await store.getMany(slice.map((hash) => wikiCheckCacheKey(scope, hash)));
        rows.forEach((row, index) => {
          if (row === undefined || row["orgId"] !== scope.orgId || row["project"] !== scope.project) return;
          if (row["outcome"] === "source_found") out.set(slice[index]!, { outcome: "source_found" });
          else if (row["outcome"] === "source_not_found" && (row["reason"] === "quote_not_at_line" || row["reason"] === "file_missing")) out.set(slice[index]!, { outcome: "source_not_found", reason: row["reason"] });
        });
      }
      return out;
    },
    async put(entries) {
      for (const [hash, verdict] of entries) {
        await store.put({ item: { ...wikiCheckCacheKey(scope, hash), entityType: "WIKI_CHECK", orgId: scope.orgId, project: scope.project, ...(verdict as unknown as Record<string, JsonValue>), ...wikiExpiryOf(now()) } });
      }
    },
  };
}

/** The cache hash of one citation at one file version. */
export function citationCacheHash(citation: Pick<WikiDraftCitation, "repo" | "path" | "line" | "quote">, version: string): string {
  return createHash("sha256").update(["wiki-check-v1", citation.repo, citation.path, version, String(citation.line), collapseWhitespace(citation.quote)].join("\0"), "utf8").digest("hex");
}

export interface WikiPageCheckInput {
  read: CitationFileReader | undefined;
  plan: WikiPagePlan;
  draft: WikiPageDraft;
  /** The run's pinned commit per repository. */
  pins: ReadonlyMap<string, string>;
  taskId: string;
  cache?: WikiCheckCache | undefined;
  /** The file's version id (a blob id) at a commit, when the code host can say; else the commit is the version. Throwing or undefined: the commit. */
  fileVersion?: ((repo: string, path: string, commit: string) => Promise<string | undefined>) | undefined;
  now: () => number;
}

export interface WikiPageCheck {
  /** The store's page write, or undefined when nothing on it survived. */
  page: WikiPageWrite | undefined;
  claimsKept: number;
  claimsDropped: number;
  dropped: Record<string, number>;
  /** False when any citation could not be read (a limit, a failed read, the deadline): the kept text is still only what was found. */
  complete: boolean;
}

type Verdict = { outcome: CitationResult["outcome"]; reason?: string };

/** Splits citations into chunks within the shared check's limits (citations and distinct files per chunk). */
function chunksOf(items: ReadonlyArray<{ index: number; citation: CitationRef }>): Array<Array<{ index: number; citation: CitationRef }>> {
  const chunks: Array<Array<{ index: number; citation: CitationRef }>> = [];
  let current: Array<{ index: number; citation: CitationRef }> = [];
  let files = new Set<string>();
  for (const item of items) {
    const file = `${item.citation.repo}\0${item.citation.commit}\0${item.citation.path}`;
    const newFile = !files.has(file);
    if (current.length >= CITATION_CHECK_LIMITS.maxCitations || (newFile && files.size >= CITATION_CHECK_LIMITS.maxFiles)) {
      chunks.push(current);
      current = [];
      files = new Set();
    }
    current.push(item);
    files.add(file);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** W1's sentence rule on per-citation verdicts: cited, every source found, every code name a whole token of one of the quotes. */
function claimDrop(sentence: string, quotes: readonly string[], verdicts: readonly Verdict[]): string | undefined {
  if (verdicts.length === 0) return "uncited";
  if (verdicts.some((verdict) => verdict.outcome === "unreadable")) return "unreadable";
  if (verdicts.some((verdict) => verdict.outcome !== "source_found")) return "source_not_found";
  const names = codeNamesOf(sentence);
  if (names.length > PROSE_CODE_NAMES_MAX) return "too_many_code_names";
  return names.every((name) => quotes.some((quote) => hasCodeToken(quote, name))) ? undefined : "code_name_not_in_quote";
}

/** Checks one page. Never throws for a reader or cache fault: those make citations unreadable (cache faults are misses). */
export async function checkWikiPage(input: WikiPageCheckInput): Promise<WikiPageCheck> {
  const { draft, pins } = input;
  const all: CitationRef[] = [];
  for (const section of draft.sections) for (const claim of section.claims) all.push(...claim.citations);
  for (const link of draft.links) all.push(link.from, link.to);

  // The version of each file: only for a citation whose commit is the pinned one (anything else is "not bound" and never cached).
  const versionOf = new Map<string, string>();
  const cacheable = (citation: CitationRef) => pins.get(citation.repo) === citation.commit && isSafeCitedPath(citation.path);
  for (const citation of all) {
    if (!cacheable(citation)) continue;
    const file = `${citation.repo}\0${citation.path}`;
    if (versionOf.has(file)) continue;
    let version: string | undefined;
    try { version = await input.fileVersion?.(citation.repo, citation.path, citation.commit); } catch { version = undefined; }
    versionOf.set(file, typeof version === "string" && /^[A-Za-z0-9]{7,64}$/u.test(version) ? `blob:${version}` : `commit:${citation.commit}`);
  }
  const hashes = all.map((citation) => (cacheable(citation) ? citationCacheHash(citation as WikiDraftCitation, versionOf.get(`${citation.repo}\0${citation.path}`)!) : undefined));
  let cached = new Map<string, CachedVerdict>();
  if (input.cache !== undefined) {
    try { cached = await input.cache.get([...new Set(hashes.filter((hash): hash is string => hash !== undefined))]); } catch { cached = new Map(); }
  }

  const verdicts: Verdict[] = all.map((): Verdict => ({ outcome: "unreadable", reason: "not_checked" }));
  const toRead: Array<{ index: number; citation: CitationRef }> = [];
  all.forEach((citation, index) => {
    const hash = hashes[index];
    const known = hash === undefined ? undefined : cached.get(hash);
    if (known !== undefined) verdicts[index] = known;
    else toRead.push({ index, citation });
  });
  const deadline = input.now() + WIKI_PAGE_CHECK_DEADLINE_MS;
  const fresh: Array<[string, CachedVerdict]> = [];
  for (const chunk of chunksOf(toRead)) {
    const remaining = deadline - input.now();
    if (remaining <= 0) { for (const item of chunk) verdicts[item.index] = { outcome: "unreadable", reason: "deadline" }; continue; }
    const check = await checkCitations(input.read, chunk.map((item) => item.citation), {
      commits: pins, mode: "prose", now: input.now, limits: { deadlineMs: Math.max(1, Math.min(CITATION_CHECK_LIMITS.deadlineMs, remaining)) },
    });
    chunk.forEach((item, at) => {
      const result = check.results[at];
      if (result === undefined) { verdicts[item.index] = { outcome: "unreadable", reason: "read_failed" }; return; }
      verdicts[item.index] = result.outcome === "source_found" ? { outcome: "source_found" } : { outcome: result.outcome, reason: result.reason };
      const hash = hashes[item.index];
      if (hash === undefined) return;
      if (result.outcome === "source_found") fresh.push([hash, { outcome: "source_found" }]);
      else if (result.outcome === "source_not_found" && (result.reason === "quote_not_at_line" || result.reason === "file_missing")) fresh.push([hash, { outcome: "source_not_found", reason: result.reason }]);
    });
  }
  if (input.cache !== undefined && fresh.length > 0) {
    try { await input.cache.put(fresh); } catch { /* a cache that cannot write only costs a re-read next time */ }
  }

  const dropped: Record<string, number> = {};
  const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const checkedAt = new Date(input.now()).toISOString();
  const claims: WikiClaim[] = [];
  const blocks: WikiBlock[] = [];
  const repos = new Map<string, string>();
  let bytes = 0;
  let blockN = 0;
  let droppedCount = 0;
  const fits = (texts: readonly string[]) => bytes + texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0) <= WIKI_LIMITS.pageTextBytes;
  /** Adds one section: a heading and paragraphs of at most `CLAIMS_PER_PARAGRAPH` kept claims each, within the page's limits; a claim that does not fit is dropped as `page_full`. */
  const addSection = (heading: string, kept: ReadonlyArray<{ text: string; citations: WikiDraftCitation[] }>) => {
    const accepted: Array<{ claimId: string; text: string }> = [];
    for (const item of kept) {
      const projected = [...accepted.map((entry) => entry.text), item.text, accepted.length === 0 ? heading : ""];
      if (claims.length >= WIKI_LIMITS.claimsPerPage || blocks.length + 2 + Math.ceil((accepted.length + 1) / CLAIMS_PER_PARAGRAPH) > WIKI_LIMITS.blocksPerPage || !fits(projected)) {
        drop("page_full"); droppedCount += 1; continue;
      }
      const claimId = `c${String(claims.length + 1).padStart(3, "0")}`;
      claims.push({ claimId, text: item.text, citations: item.citations.map(storedCitation), source: "found", checkedAt });
      for (const citation of item.citations) repos.set(citation.repo, citation.commit);
      accepted.push({ claimId, text: item.text });
    }
    if (accepted.length === 0) return;
    blockN += 1;
    blocks.push({ kind: "heading", blockId: `b${String(blockN).padStart(3, "0")}`, level: 2, text: heading });
    bytes += Buffer.byteLength(heading, "utf8");
    for (let from = 0; from < accepted.length; from += CLAIMS_PER_PARAGRAPH) {
      const part = accepted.slice(from, from + CLAIMS_PER_PARAGRAPH);
      const text = part.map((entry) => entry.text).join(" ");
      blockN += 1;
      blocks.push({ kind: "paragraph", blockId: `b${String(blockN).padStart(3, "0")}`, text, claimIds: part.map((entry) => entry.claimId) });
      bytes += Buffer.byteLength(text, "utf8");
    }
  };

  let at = 0;
  let kept = 0;
  for (const section of draft.sections) {
    const survivors: Array<{ text: string; citations: WikiDraftCitation[] }> = [];
    for (const claim of section.claims) {
      const mine = verdicts.slice(at, at + claim.citations.length);
      at += claim.citations.length;
      const reason = claimDrop(claim.sentence, claim.citations.map((citation) => citation.quote), mine);
      const text = wikiStoredText(claim.sentence, WIKI_TEXT_MAX.sentence);
      if (reason !== undefined || text === "") { drop(reason ?? "uncited"); droppedCount += 1; continue; }
      survivors.push({ text, citations: [...claim.citations] });
    }
    const before = claims.length;
    addSection(wikiStoredText(section.heading, WIKI_TEXT_MAX.heading) || "Details", survivors);
    kept += claims.length - before;
  }
  const linkSurvivors: Array<{ text: string; citations: WikiDraftCitation[] }> = [];
  for (const link of draft.links) {
    const mine = verdicts.slice(at, at + 2);
    at += 2;
    let reason = claimDrop(link.sentence, [link.from.quote, link.to.quote], mine);
    // Both sides, in two different repositories: a "link" inside one repository connects nothing.
    if (reason === undefined && link.from.repo === link.to.repo) reason = "link_same_repository";
    const text = wikiStoredText(link.sentence, WIKI_TEXT_MAX.sentence);
    if (reason !== undefined || text === "") { drop(reason === undefined ? "uncited" : `link_${reason.replace(/^link_/u, "")}`); droppedCount += 1; continue; }
    linkSurvivors.push({ text, citations: [link.from, link.to] });
  }
  const beforeLinks = claims.length;
  addSection("Connections", linkSurvivors);
  kept += claims.length - beforeLinks;

  const complete = verdicts.every((verdict) => verdict.outcome !== "unreadable");
  if (claims.length === 0 || repos.size > WIKI_LIMITS.reposPerPage) {
    if (repos.size > WIKI_LIMITS.reposPerPage) drop("too_many_repositories");
    return { page: undefined, claimsKept: 0, claimsDropped: droppedCount + claims.length, dropped, complete };
  }
  const page: WikiPageWrite = {
    pageId: input.plan.id, kind: input.plan.kind, title: wikiPageTitle(input.plan),
    summary: [...claims[0]!.text].slice(0, WIKI_TEXT_MAX.summary).join(""),
    ...(input.plan.parentId === undefined ? {} : { parentId: input.plan.parentId }),
    order: input.plan.position,
    repos: [...repos.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([repo, commit]) => ({ repo, commit })),
    blocks, claims, buildId: input.taskId,
  };
  return { page, claimsKept: kept, claimsDropped: droppedCount, dropped, complete };
}
