// How lessons find lessons that are like them. One matcher, used by the curator (is this draft a copy, a narrowing or the opposite of a lesson we hold?), the loader
// (which lessons fit this task?) and the same-mistake-twice measure (is this correction something a lesson already says?).
//
//   code-aware BM25   words, identifiers kept whole AND split (withRetry, with_retry -> with, retry), cited and scope paths
//   path overlap      the files and folders a lesson cites or is scoped to against the ones the other side names
//   embedder cosine   OPTIONAL: the small open embedder (bge-small, our own compute). Without one the other two carry the shortlist.
//   fusion            reciprocal-rank fusion of the lists that exist, so no list's raw scale (model-specific cosines, BM25 sums) matters
//
// A score cannot tell "the same advice" from "the opposite advice" (the research found contradictions score as high as duplicates), so this module only SHORTLISTS. What a shortlisted lesson means for a draft is
// decided by one listwise judge call in curate.ts; with no judge, only a pair that is the same advice by structure merges by code (a verbatim or near copy: the same words in the same order), and with a judge only such a pair does too (closeEnoughForSame). Every copy test compares the bodies word by word, in order, keeping negations, directions, qualifiers and numbers (copy-match.ts).
//
// Nothing here calls a paid model, writes a lesson or reads the lesson store: callers pass the lessons in. The embedder is our own compute; if it is absent or fails the ranking falls back to keywords and paths (one
// fixed log code), and nothing here ever throws into a caller.
import { createHash } from "node:crypto";
import { covers, hasUnclassifiedNegation, relate, sameByStructure } from "./copy-match.js";
import type { EmbedderCall, LessonEmbedder, LessonVectors, StoredLessonVector } from "./ports.js";
import type { ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

/** The parts of a lesson (or a draft) the matcher reads. */
export type LessonLike = Pick<Lesson, "title" | "description" | "body" | "scope" | "citations"> & { id?: string };

/** The text of a lesson as it is compared and embedded. */
export const lessonTextOf = (l: Pick<Lesson, "title" | "description" | "body">): string => `${l.title}\n${l.description}\n${l.body}`;
/** Which text a stored vector was made from; an edited lesson has another hash and is embedded again. */
export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);

// ---- tokens ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const STOP: ReadonlySet<string> = new Set((
  "a an the and or but if then else so of to in on at by for with from as into onto over under about than that this these those it its is are was were be been being am do does did done has have had having " +
  "can could should would will shall may might must not no yes you your we our they them their he she his her i me my us there here which who whom what when where why how also just only very more most some any all each " +
  "every both either neither such too use used using uses make makes made get gets got one two via per up out off too always never avoid prefer instead rather"
).split(/\s+/u));

const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u;
/** A chunk of text with no whitespace that may be a path or an identifier: letters, digits and . _ - / @ : kept together so `src/retry/index.ts` and `withRetry` survive whole. */
const CHUNK = /[A-Za-z0-9_@][A-Za-z0-9_@./:-]*/gu;

function parts(chunk: string): string[] {
  const out: string[] = [];
  for (const piece of chunk.split(/[^A-Za-z0-9]+/u)) {
    if (piece === "") continue;
    for (const word of piece.split(CAMEL)) {
      const lower = word.toLowerCase();
      // Single letters and bare digits carry nothing; a stop word is dropped unless it is part of a longer identifier (that is kept whole below).
      if (lower.length >= 2 && !STOP.has(lower)) out.push(lower);
    }
  }
  return out;
}

/**
 * The tokens of a text: every word (lower case, stop words dropped), every identifier or path kept whole, and each of those split on punctuation and case (`withRetry` -> withretry, with is dropped as a stop word,
 * retry; `src/retry/index.ts` -> src/retry/index.ts, src, retry, index, ts). Order is kept and repeats are kept (term frequency).
 */
export function tokensOf(text: string, options: { collapsePaths?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const raw of text.match(CHUNK) ?? []) {
    const chunk = raw.replace(/[.:/-]+$/u, "");
    if (chunk === "") continue;
    // For overlap measures a path counts once (its parts would make two lessons that merely cite one file look alike); for the keyword search its parts are kept.
    const split = options.collapsePaths === true && chunk.includes("/") ? [] : parts(chunk);
    const compound = /[./_@:-]/u.test(chunk) || CAMEL.test(chunk);
    // A compound (identifier, path, file name) is kept whole as well as in parts: an exact identifier is the strongest signal there is.
    if (compound && chunk.length >= 3) out.push(chunk.toLowerCase());
    out.push(...split);
  }
  return out;
}

/** The set of tokens, for overlap measures. */
export const tokenSetOf = (text: string): Set<string> => new Set(tokensOf(text, { collapsePaths: true }));

// ---- paths -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const stripGlob = (path: string): { literal: string; glob: boolean } => {
  const trimmed = path.trim().replace(/^\.\//u, "").replaceAll("\\", "/");
  const at = trimmed.search(/[*?[{]/u);
  if (at < 0) return { literal: trimmed.replace(/\/+$/u, ""), glob: false };
  return { literal: trimmed.slice(0, at).replace(/\/+$/u, "").replace(/\/[^/]*$/u, (rest) => (trimmed[at - 1] === "/" ? "" : rest)), glob: true };
};

/** How much two path lists name the same place, 0 to 1: the same file 1, a shared folder two levels deep 0.6, a shared first folder 0.2, the same file name elsewhere 0.5. */
export function pathOverlap(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (const x of a) {
    const px = stripGlob(x);
    if (px.literal === "") continue;
    for (const y of b) {
      const py = stripGlob(y);
      if (py.literal === "") continue;
      if (!px.glob && !py.glob && px.literal.toLowerCase() === py.literal.toLowerCase()) return 1;
      const sx = px.literal.toLowerCase().split("/"), sy = py.literal.toLowerCase().split("/");
      let common = 0;
      while (common < sx.length && common < sy.length && sx[common] === sy[common]) common += 1;
      // One folder contains the other (a glob's literal folder against a file in it) or both start in the same two levels.
      const contains = common === Math.min(sx.length, sy.length);
      if (contains && common >= 2) best = Math.max(best, 0.6);
      else if (common >= 2) best = Math.max(best, 0.4);
      else if (common >= 1) best = Math.max(best, 0.2);
      if (!px.glob && !py.glob && sx.at(-1) === sy.at(-1) && sx.at(-1)!.includes(".")) best = Math.max(best, 0.5);
    }
  }
  return best;
}

// ---- documents -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface SimDoc {
  id: string;
  text: string;
  /** Scope paths and cited code paths. */
  paths: string[];
  /** Cited code files as `repo:path`. */
  files: string[];
  /** Everything the keyword search sees: the text, the title again, the paths and the cited anchors' identifiers. */
  tokens: string[];
  /** The words of the text alone. Overlap measures (and so the near-exact test) use these: two lessons that cite the same file share its paths and anchor whatever they say. */
  set: Set<string>;
  /** The words of the body alone: the statement itself. The title and description are summaries of it (and a tier-0 template replaces them), so two lessons are copies of each other when their BODIES are. */
  bodySet: Set<string>;
}

const codeFilesOf = (l: LessonLike): string[] => l.citations.flatMap((c) => (c.kind === "code" ? [`${c.repo}:${c.path}`.toLowerCase()] : []));
const pathsOf = (l: LessonLike): string[] => [...(l.scope.paths ?? []), ...l.citations.flatMap((c) => (c.kind === "code" ? [c.path] : []))];

function docFrom(id: string, text: string, paths: string[], files: string[], extraTokens: string[], body: string = text): SimDoc {
  return { id, text, paths, files, tokens: [...tokensOf(text), ...extraTokens], set: new Set(tokensOf(text, { collapsePaths: true })), bodySet: new Set(tokensOf(body, { collapsePaths: true })) };
}

/** A lesson or draft as a document: its title counts twice, its cited anchors' identifiers and its paths are tokens too. */
export function docOf(l: LessonLike, id: string = l.id ?? "draft"): SimDoc {
  const text = lessonTextOf(l);
  const extra = [...tokensOf(l.title), ...pathsOf(l).flatMap((p) => tokensOf(p)), ...l.citations.flatMap((c) => (c.kind === "code" ? tokensOf(c.anchor) : []))];
  return docFrom(id, text, pathsOf(l), codeFilesOf(l), extra, l.body);
}

/** Free text (a task's intent and plan, a correction) with the files it names. */
export function docOfText(text: string, files: readonly string[] = [], id = "query"): SimDoc {
  return docFrom(id, text, [...files], [], files.flatMap((f) => tokensOf(f)));
}

// ---- BM25 ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const K1 = 1.2;
const B = 0.75;

/** Okapi BM25 of the query against each document of a corpus; documents that share no token with the query score 0. */
export function bm25(query: SimDoc, corpus: readonly SimDoc[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (corpus.length === 0) return scores;
  const queryTerms = new Set(query.tokens);
  const df = new Map<string, number>();
  const tfs = corpus.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) if (queryTerms.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const avg = corpus.reduce((s, d) => s + d.tokens.length, 0) / corpus.length || 1;
  corpus.forEach((doc, i) => {
    let score = 0;
    for (const t of queryTerms) {
      const f = tfs[i]!.get(t);
      if (f === undefined) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (corpus.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.tokens.length) / avg)));
    }
    if (score > 0) scores.set(doc.id, score);
  });
  return scores;
}

/** Shared tokens over the smaller side (how much of the shorter text the longer one repeats), and over the union. */
export function overlapOf(a: ReadonlySet<string>, b: ReadonlySet<string>): { containment: number; jaccard: number; shared: number; /** shared over the LARGER side: how much of the bigger text the smaller one accounts for */ mutual: number } {
  if (a.size === 0 || b.size === 0) return { containment: 0, jaccard: 0, shared: 0, mutual: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return { containment: shared / Math.min(a.size, b.size), jaccard: shared / (a.size + b.size - shared), shared, mutual: shared / Math.max(a.size, b.size) };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// ---- fusion ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** Reciprocal-rank fusion: a lesson scores 1 / (RRF_K + rank) in each list it appears in. A small K keeps the top of each list apart (rank 1 against rank 5 is 0.73 of it). */
export const RRF_K = 10;
/** A list is cut at this many entries before fusing. */
export const LIST_DEPTH = 20;
/** The most a draft is compared with, and the most that go to the judge. */
export const NEIGHBOURS = 8;
/** The most LIVE lessons the judge is shown, and the most previously rejected lessons it is shown IN ADDITION: one call, at most seven candidates. */
export const JUDGE_CANDIDATES = 5;
export const JUDGE_REJECTED = 2;
/** A lexical hit needs at least this many tokens in common with the query (one shared word is not a neighbour). */
const MIN_SHARED_TOKENS = 2;
/** A cosine below this does not enter the embedder's list. It is a floor, not a threshold: the list is ranked and cut at LIST_DEPTH. */
const MIN_COSINE = 0.5;
/**
 * A shortlisted lesson goes to the judge when it shares a quarter of the shorter text's words, or shares a tenth AND names the same folder (two levels deep or the same file), or (with an embedder) is close in
 * meaning. Paths alone never qualify: two lessons about one folder are not neighbours. It only saves a call on a draft with nothing like it; it is loose on purpose, because a lesson that narrows another often
 * shares few words. Calibrated on the fixture of the research (tests/unit/lessons/similarity.test.ts); real data may move it.
 */
export const GATE = { containment: 0.25, weakContainment: 0.1, path: 0.5, cosine: 0.72 } as const;

export interface Ranked {
  id: string;
  /** The fused score, 0 to 1: 1 means first in every list that exists for this query. */
  fused: number;
  bm25: number;
  path: number;
  cosine?: number;
  containment: number;
  jaccard: number;
  /** The same two measures over the bodies alone (copies are judged on these). */
  bodyContainment: number;
  bodyJaccard: number;
  /** The share of the larger body that the smaller one holds (words, order ignored). */
  bodyMutual: number;
  sharedFile: boolean;
  /** Neither side cites a code file. */
  bothUncited: boolean;
}

export const passesGate = (r: Ranked): boolean => r.containment >= GATE.containment || (r.containment >= GATE.weakContainment && r.path >= GATE.path) || (r.cosine !== undefined && r.cosine >= GATE.cosine);

/** Ranks a corpus against a query with the lists that exist (keywords always; paths when the query names any; cosines when given). Pure. */
export function fuse(query: SimDoc, corpus: readonly SimDoc[], cosines?: ReadonlyMap<string, number>): Ranked[] {
  const lexical = bm25(query, corpus);
  const measures = new Map<string, { containment: number; jaccard: number; bodyContainment: number; bodyJaccard: number; bodyMutual: number; shared: number; path: number; sharedFile: boolean; bothUncited: boolean }>();
  for (const doc of corpus) {
    const overlap = overlapOf(query.set, doc.set);
    const body = overlapOf(query.bodySet, doc.bodySet);
    measures.set(doc.id, { ...overlap, bodyContainment: body.containment, bodyJaccard: body.jaccard, bodyMutual: body.mutual, path: pathOverlap(query.paths, doc.paths), sharedFile: doc.files.some((f) => query.files.includes(f)), bothUncited: doc.files.length === 0 && query.files.length === 0 });
  }
  const lists: Array<Array<{ id: string }>> = [];
  const lexicalList = [...lexical.entries()].filter(([id]) => (measures.get(id)?.shared ?? 0) >= MIN_SHARED_TOKENS).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, LIST_DEPTH).map(([id]) => ({ id }));
  lists.push(lexicalList);
  if (query.paths.length > 0) {
    lists.push([...measures.entries()].filter(([, m]) => m.path > 0).sort((a, b) => b[1].path - a[1].path || b[1].containment - a[1].containment || a[0].localeCompare(b[0])).slice(0, LIST_DEPTH).map(([id]) => ({ id })));
  }
  if (cosines !== undefined && cosines.size > 0) {
    lists.push([...cosines.entries()].filter(([, c]) => c >= MIN_COSINE).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, LIST_DEPTH).map(([id]) => ({ id })));
  }
  const fusedRaw = new Map<string, number>();
  for (const list of lists) list.forEach((entry, rank) => fusedRaw.set(entry.id, (fusedRaw.get(entry.id) ?? 0) + 1 / (RRF_K + rank + 1)));
  const best = lists.length / (RRF_K + 1);
  const out: Ranked[] = [];
  for (const [id, raw] of fusedRaw) {
    const m = measures.get(id)!;
    const c = cosines?.get(id);
    out.push({ id, fused: Math.min(1, raw / best), bm25: lexical.get(id) ?? 0, path: m.path, ...(c === undefined ? {} : { cosine: c }), containment: m.containment, jaccard: m.jaccard, bodyContainment: m.bodyContainment, bodyJaccard: m.bodyJaccard, bodyMutual: m.bodyMutual, sharedFile: m.sharedFile, bothUncited: m.bothUncited });
  }
  return out.sort((a, b) => b.fused - a.fused || b.containment - a.containment || a.id.localeCompare(b.id));
}

// ---- copies --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * What may decide that two lessons are one, by code (review). Every test here compares the two BODIES word by word, in order (copy-match.ts), and keeps negations, direction words, qualifiers
 * and numbers: a changed digit, "on" for "off", "instead of" turned round, a clause such as "except the billing service" added, or two words swapped is NOT a copy. The set measures of the shortlist (containment, Jaccard)
 * never decide a copy; they only choose what a judge or a person looks at.
 *
 *   verbatim   the bodies are equal after case, whitespace and punctuation are normalised (code operators kept as tokens); the same cited file, or neither cites one. Merges with no judge call at all.
 *   near       the same cited file and the same words in the same order, differing by filler only (equal word sequences once filler is removed and plurals are stemmed: no content word differs, at any length). With NO
 *              judge it merges, because it is the same advice by structure (a tier-0 lesson is stored in a template's wording, so its corroborating drafts are near copies, not verbatim ones).
 *   flipped    the same words with a polarity, direction or number changed (or in another order), the same cited file or none: a person decides, as a contradiction. Never merged.
 *   narrows    the draft holds the lesson's words in order and more: a refinement for a person.
 */
export const isVerbatim = (ranked: Pick<Ranked, "sharedFile" | "bothUncited">, a: string, b: string): boolean => (ranked.sharedFile || ranked.bothUncited) && relate(a, b).verbatim;
export const isNearExact = (ranked: Pick<Ranked, "sharedFile" | "bothUncited">, a: string, b: string): boolean => ranked.sharedFile && relate(a, b).near;
export const isFlippedCopy = (ranked: Pick<Ranked, "sharedFile" | "bothUncited">, a: string, b: string): boolean => (ranked.sharedFile || ranked.bothUncited) && relate(a, b).flipped;
export const isNarrowing = (ranked: Pick<Ranked, "sharedFile" | "bothUncited">, a: string, b: string): boolean => (ranked.sharedFile || ranked.bothUncited) && relate(a, b).narrows;

/**
 * a judge's "same" merges two lessons only when they are the same advice BY STRUCTURE (copy-match.ts `sameByStructure`): the same words once case, punctuation, plurals and filler are normalised (the same
 * multiset of words, so no word added, dropped or swapped), the same signs and operators, and the negation, direction, number and operator tokens in the same order. Anything else, however alike it reads and
 * whatever the judge or the embedder says, is NOT merged: the curator keeps the draft as its own candidate linked as a possible duplicate, and a person decides. Safety does not depend on a word list: an antonym
 * nobody listed (pause / resume) is a swapped word. The first argument (how close the shortlist found the two) is kept for callers and no longer matters: equal words are as close as two texts get.
 * Text with a negation this module cannot classify (any non-ASCII word, a known ASCII negation of another language) merges only as a verbatim or near copy (DEFERRED-CHECKS).
 * What this does NOT do: it does not recognise a paraphrase as a duplicate. Two lessons that say the same thing in different words are shown to a person as a possible duplicate, never merged.
 */
export const closeEnoughForSame = (_ranked: Pick<Ranked, "bodyMutual" | "cosine" | "sharedFile" | "bothUncited">, a: string, b: string): boolean => {
  const relation = relate(a, b);
  if (relation.verbatim || relation.near) return true;
  if (relation.flipped || hasUnclassifiedNegation(a) || hasUnclassifiedNegation(b)) return false;
  return sameByStructure(a, b);
};

/**
 * Whether a draft is the advice a person already REJECTED coming back: the same words in the same order (a copy), or the rejected lesson's words nearly all present in the draft, or (with an embedder) a very
 * close vector, with no polarity, direction or number changed. It does not ask for a shared file, so an uncited rejected lesson is matched too. A rejected lesson shorter than four words is matched only as a copy.
 */
export const REJECTED_MATCH = { mutual: 0.7, contained: 0.85, minWords: 4, cosine: 0.92 } as const;
export function matchesRejected(draft: { bodySet: ReadonlySet<string> }, rejected: { bodySet: ReadonlySet<string> }, cosineValue: number | undefined, draftBody: string, rejectedBody: string): boolean {
  const overlap = overlapOf(draft.bodySet, rejected.bodySet);
  const closeVector = cosineValue !== undefined && cosineValue >= REJECTED_MATCH.cosine;
  const containedShare = rejected.bodySet.size === 0 ? 0 : overlap.shared / rejected.bodySet.size;
  // A cheap cut before the word-by-word test: a copy shares most of its words, so a rejected lesson sharing under half of them is not one.
  if (overlap.mutual < 0.5 && containedShare < 0.6 && !closeVector) return false;
  // The prefix-antonym rule is for refusing a merge; here it is off, so a prefixed word added to the draft (connecting -> disconnecting) cannot take it out of the match.
  const relation = relate(draftBody, rejectedBody, { antonyms: false });
  if (relation.verbatim || relation.near) return true;
  // A close vector counts unless the advice really points the other way. A synonym swap ("disable" for "turn off", "skip" for "ignore", "never" for "avoid") is flipped by the word lists but keeps its
  // stance, direction words and numbers, so the vector may speak for it; a different stance, direction word, number, unit, antonym or order is "opposed" and the vector may not.
  if (closeVector && !relation.opposed) return true;
  // Every negation, direction word and number of the rejected advice must be in the draft; the draft may say more (padding with other lessons' words, digits included, does not clear it).
  if (relation.flipped || !covers(rejectedBody, draftBody, { antonyms: false }).polarityContained) return false;
  if (rejected.bodySet.size >= REJECTED_MATCH.minWords && (overlap.mutual >= REJECTED_MATCH.mutual || containedShare >= REJECTED_MATCH.contained)) return true;
  return closeVector;
}

// ---- the stored vectors and the ranking -----------------------------------------------------------------------------------------------------------------------------------------------
export type SimilarityLog = (event: string, fields: Record<string, unknown>) => void;
export interface SimilarityDeps {
  /** Absent: keywords and paths only. */
  embedder?: LessonEmbedder | undefined;
  vectors: LessonVectors;
  log?: SimilarityLog | undefined;
  metrics?: { count(name: string, tags?: Record<string, string>): void } | undefined;
  /** The clock for the "no embedder" notice (default Date.now). */
  now?: (() => number) | undefined;
}

/** The fixed log codes (no text from an error, nothing a person wrote). */
export const SIMILARITY_LOG = {
  noEmbedder: "lessons.similarity_no_embedder",
  embedderDown: "lessons.similarity_embedder_unavailable",
  embedderSlow: "lessons.similarity_embedder_timeout",
  vectorsDown: "lessons.similarity_vectors_unavailable",
  /** The embedder's SDK client was not loaded yet: this ranking used keywords and paths, and the next finds it ready. */
  embedderLoading: "lessons.similarity_embedder_loading",
} as const;

/** The most lessons embedded in one call (the rest are made on a later call): a first call after the embedder arrives, or after a model change, must not wait on 2,000 texts. */
export const MAX_EMBED_PER_CALL = 48;

export interface RankOptions {
  /** Embed the lessons that have no current vector, up to MAX_EMBED_PER_CALL (the curator). The loader does not: it must be quick, so it ranks by the vectors that exist. */
  embedMissing?: boolean;
  /** `query` for a task's intent or a correction against lessons, `document` for lesson against lesson. */
  queryKind?: "query" | "document";
  /** The longest the vectors and the embedder may take, together. Past it the ranking is keywords and paths (the loader must not wait on a slow embedder). Default `EMBED_TIMEOUT_MS.curate`. */
  timeoutMs?: number;
  /**
   * The longest to wait for the embedder's SDK client to LOAD before the time budget starts: the load is never part of `timeoutMs`. Past it the ranking is keywords and paths (the load carries on in the
   * background, so the next call finds it ready). Default `EMBED_WARM_MS.curate`; the loader passes 0 and never waits.
   */
  warmMs?: number;
}
/** How long the embedder may take before the ranking falls back to keywords: the loader is quick (it is inside a dispatch), the curator may wait a few seconds. */
export const EMBED_TIMEOUT_MS = { load: 300, curate: 5000 } as const;
/** How long a ranking waits for the embedder's SDK to load (outside the budget above): the loader does not wait at all, the curator may. */
export const EMBED_WARM_MS = { load: 0, curate: 1000 } as const;
/** The vector read gets at most a third of the ranking's budget, and never more than this: a slow read must not eat the embedder's time. */
export const VECTOR_READ_MAX_MS = 1000;
/** The "no embedder" line is written at most once per project per hour. */
export const NO_EMBEDDER_NOTICE_MS = 60 * 60 * 1000;
export interface RankResult {
  ranked: Ranked[];
  /** The query's vector when the embedder gave one (the curator stores it with the lesson it creates). */
  queryVector?: number[];
  /** `fused`: the embedder took part. `keyword`: keywords and paths only. */
  mode: "fused" | "keyword";
}

const asNumbers = (value: unknown): number[] | undefined => (Array.isArray(value) ? (value as number[]) : ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : undefined);
const validVector = (v: readonly number[] | undefined, dimension: number): v is readonly number[] => v !== undefined && v.length === dimension && v.every((x) => Number.isFinite(x));

const noEmbedderNoticeAt = new Map<string, number>();
/** Test hook: the "no embedder" notice starts again. */
export const resetNoEmbedderNotice = (): void => { noEmbedderNoticeAt.clear(); };

class EmbedTimeout extends Error { constructor() { super("embedder timeout"); } }
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EmbedTimeout()), ms); timer.unref?.(); });
  return Promise.race([work, limit]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * Ranks `corpus` (lessons the caller already read and filtered) against `query`. Never throws: an embedder or a vector store that fails is one fixed log code and the ranking is keywords and paths.
 */
export async function rankLessons(deps: SimilarityDeps, key: ScopeKey, corpus: ReadonlyArray<LessonLike & { id: string }>, query: SimDoc, options: RankOptions = {}): Promise<RankResult> {
  const docs = corpus.map((l) => docOf(l));
  const keyword: RankResult = { ranked: fuse(query, docs), mode: "keyword" };
  if (deps.embedder === undefined) {
    // A no-embedder state that comes back after a deploy must show again: the line repeats once an hour for each project, not once for the life of the process.
    const at = (deps.now ?? Date.now)();
    const scope = `${key.workspaceId}\u0001${key.project}`;
    const last = noEmbedderNoticeAt.get(scope);
    if (last === undefined || at - last >= NO_EMBEDDER_NOTICE_MS || at < last) { noEmbedderNoticeAt.set(scope, at); deps.log?.(SIMILARITY_LOG.noEmbedder, {}); }
    deps.metrics?.count("learning.similarity_no_embedder");
    return keyword;
  }
  const embedder = deps.embedder;
  // The SDK client is loaded BEFORE the budget starts: a container's first call used to spend part of its 300 ms loading modules. Not ready in time: keywords and paths, no pause (nothing was asked of the function).
  if (embedder.warm !== undefined) {
    let ready: boolean;
    // A client whose SDK failed to load is "unavailable", not "still loading": the line and the count must not say "loading" for ever.
    try { ready = await embedder.warm(options.warmMs ?? EMBED_WARM_MS.curate); } catch {
      deps.log?.(SIMILARITY_LOG.embedderDown, {});
      deps.metrics?.count("learning.similarity_embedder_unavailable");
      return keyword;
    }
    if (!ready) {
      deps.log?.(SIMILARITY_LOG.embedderLoading, {});
      deps.metrics?.count("learning.similarity_embedder_loading");
      return keyword;
    }
  }
  try {
    // The race is also the embedder call's DEADLINE: a call still running when the race ends is aborted by the client at that moment, and no later call of this run is started. The abandoned
    // work therefore cannot start another cold container.
    const limit = options.timeoutMs ?? EMBED_TIMEOUT_MS.curate;
    return await withTimeout(fusedRanking(deps, embedder, key, corpus, query, docs, options, { deadline: Date.now() + limit }, Math.min(VECTOR_READ_MAX_MS, Math.floor(limit / 3))), limit);
  } catch (error) {
    deps.log?.(error instanceof EmbedTimeout ? SIMILARITY_LOG.embedderSlow : SIMILARITY_LOG.embedderDown, {});
    deps.metrics?.count(error instanceof EmbedTimeout ? "learning.similarity_embedder_timeout" : "learning.similarity_embedder_unavailable");
    return keyword;
  }
}

async function fusedRanking(deps: SimilarityDeps, embedder: LessonEmbedder, key: ScopeKey, corpus: ReadonlyArray<LessonLike & { id: string }>, query: SimDoc, docs: readonly SimDoc[], options: RankOptions, call: EmbedderCall, readMs: number): Promise<RankResult> {
  const hashes = new Map(corpus.map((l) => [l.id, textHash(lessonTextOf(l))] as const));
  let stored: Map<string, StoredLessonVector>;
  // The read has its own small timeout: a slow vector store ends in keyword-only ranking for the stored vectors, and the query is still embedded in what is left of the budget.
  try { stored = await withTimeout(deps.vectors.get(key.workspaceId, key.project, embedder.spec, corpus.map((l) => l.id)), readMs); } catch { deps.log?.(SIMILARITY_LOG.vectorsDown, {}); stored = new Map(); }
  const vectors = new Map<string, readonly number[]>();
  for (const l of corpus) {
    const found = stored.get(l.id);
    const vector = found === undefined ? undefined : asNumbers(found.vector);
    if (found !== undefined && found.hash === hashes.get(l.id) && validVector(vector, embedder.dimension)) vectors.set(l.id, vector);
  }
  if (options.embedMissing === true) {
    const missing = corpus.filter((l) => !vectors.has(l.id)).slice(0, MAX_EMBED_PER_CALL);
    if (missing.length > 0) {
      const made = await embedder.embedMany(missing.map((l) => lessonTextOf(l)), "document", call);
      for (const [i, l] of missing.entries()) {
        const vector = made[i];
        if (!validVector(vector, embedder.dimension)) continue;
        vectors.set(l.id, vector);
        try { await deps.vectors.put(key.workspaceId, key.project, embedder.spec, l.id, { hash: hashes.get(l.id)!, vector }); } catch { deps.log?.(SIMILARITY_LOG.vectorsDown, {}); }
      }
    }
  }
  const [queryVector] = await embedder.embedMany([query.text], options.queryKind ?? "document", call);
  if (!validVector(queryVector, embedder.dimension)) throw new Error("bad vector");
  const cosines = new Map<string, number>();
  for (const [id, vector] of vectors) cosines.set(id, cosine(queryVector, vector));
  return { ranked: fuse(query, docs, cosines), queryVector: [...queryVector], mode: "fused" };
}

/** Stores a lesson's vector (the curator, for the lesson it just created). Never throws. */
export async function keepVector(deps: SimilarityDeps, key: ScopeKey, lesson: Pick<Lesson, "id" | "title" | "description" | "body">, vector: readonly number[] | undefined): Promise<void> {
  if (deps.embedder === undefined || vector === undefined || !validVector(vector, deps.embedder.dimension)) return;
  try { await deps.vectors.put(key.workspaceId, key.project, deps.embedder.spec, lesson.id, { hash: textHash(lessonTextOf(lesson)), vector }); } catch { deps.log?.(SIMILARITY_LOG.vectorsDown, {}); }
}

/** Removes a lesson's vector. Never throws (a vector that stays is removed by the deletion paths, which do throw). */
export async function dropVector(vectors: LessonVectors | undefined, key: ScopeKey, id: string): Promise<void> {
  if (vectors === undefined) return;
  try { await vectors.remove(key.workspaceId, key.project, id); } catch { /* the lesson's deletion paths remove it again */ }
}
