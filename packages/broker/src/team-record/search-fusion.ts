// Ported from Cloud's Team record (DEC 226: the team record lives in Code). DECISIONS 142: a Team record search blends the keyword results and the meaning (vector) results with reciprocal rank fusion (RRF);
// the retrieval eval measured bge-small alone 0.78 hit@5 / 0.72 MRR, BM25 alone 0.82 / 0.79, both with RRF 0.84 / 0.79. Until Code's own embedder is deployed the search is keyword only (BM25 per best passage,
// DECISIONS 145), which the same eval rated above the meaning side alone. This file holds the two pure parts: the keyword ranking and the fusion.

/** The RRF constant: the eval used 60 (the usual value); a document at rank r of a list adds 1 / (RRF_K + r) to its score. */
export const RRF_K = 60;

/** Words of a text for the keyword ranking: letters and digits, lower case, a light plural/tense strip on words over four letters (the eval's tokenizer, with Unicode letters). */
export function keywordTokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0).map((word) => (word.length > 4 ? word.replace(/(ing|ed|es|s)$/u, "") : word));
}

/**
 * The PASSAGE RULE (lane K1, DECISIONS 145). The keyword side scores a row by its best passage, not by the whole text: BM25's length normalisation otherwise buries a fact that stands late in a long text
 * (the eval, environments/embedder/eval/run_window_eval.py: long-late hit@5 0.25-0.38 for whole-row BM25, 0.88-1.0 for passages; 80 tokens did at least as well as 100 or 120 at every corpus size). The rule works on `keywordTokens(document)` and is written so a SQLite FTS5 port (Code's laptop index, lane K5) can match it exactly:
 *   - `PASSAGE_TOKENS` tokens is the window size and `PASSAGE_STEP` (half of it) the distance between window starts;
 *   - a document of at most `PASSAGE_TOKENS` tokens (and an empty one) is ONE passage, itself: a short row is scored exactly as the whole-row BM25 scores it;
 *   - a longer document has windows starting at token 0, `PASSAGE_STEP`, 2 x `PASSAGE_STEP`, ...; window `i` is tokens `[i x STEP, i x STEP + TOKENS)`; the last window is the FIRST one that reaches the end of the
 *     document (so it holds between `PASSAGE_STEP + 1` and `PASSAGE_TOKENS` tokens) and no window starts after it;
 *   - the statistics (N, document frequency, average length) are over ALL passages of all documents given, each passage is scored with BM25 k1 1.2, b 0.75 and idf log(1 + (N - df + 0.5) / (df + 0.5)), and a
 *     document's score is the best score of any of its passages.
 */
export const PASSAGE_TOKENS = 80;
export const PASSAGE_STEP = PASSAGE_TOKENS / 2;

/** The `[start, end)` token ranges of the passages of a document of `count` tokens (the passage rule above). */
export function passageRanges(count: number, size: number = PASSAGE_TOKENS): Array<[number, number]> {
  if (count <= size) return [[0, count]];
  const step = Math.max(1, Math.floor(size / 2));
  const ranges: Array<[number, number]> = [];
  for (let start = 0; ; start += step) {
    ranges.push([start, Math.min(count, start + size)]);
    if (start + size >= count) return ranges;
  }
}

/** The query words the keyword side counts: the distinct tokens of the query, two characters or more, at most 12 (the rule the whole-row and the passage scorer and the keyword index share). */
export function keywordNeedles(query: string): string[] {
  return [...new Set(keywordTokens(query))].filter((word) => word.length >= 2).slice(0, 12);
}

/** BM25's k1 and b, and the score of one passage with `frequency` hits of a word of weight `idf` (the formula the passage scorer and the keyword index share, written once so they cannot drift). */
export function bm25Term(idf: number, frequency: number, length: number, average: number): number {
  return idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / average));
}

function scoreByPassage(query: string, documents: readonly string[], size: number): number[] {
  const needles = keywordNeedles(query);
  if (needles.length === 0 || documents.length === 0) return documents.map(() => 0);
  const wanted = new Set(needles);
  // Only the query's words are counted inside a passage; the length of every passage is kept for the average.
  const passages: Array<{ owner: number; length: number; counts: Map<string, number> }> = [];
  documents.forEach((document, owner) => {
    const tokens = keywordTokens(document);
    for (const [from, to] of passageRanges(tokens.length, size)) {
      const counts = new Map<string, number>();
      for (let at = from; at < to; at += 1) {
        const token = tokens[at] as string;
        if (wanted.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      passages.push({ owner, length: to - from, counts });
    }
  });
  const average = passages.reduce((sum, entry) => sum + entry.length, 0) / passages.length || 1;
  const n = passages.length;
  const idf = new Map<string, number>();
  for (const word of needles) {
    const containing = passages.filter((entry) => entry.counts.has(word)).length;
    idf.set(word, Math.log(1 + (n - containing + 0.5) / (containing + 0.5)));
  }
  const best = documents.map(() => 0);
  for (const entry of passages) {
    let score = 0;
    for (const word of needles) {
      const frequency = entry.counts.get(word);
      if (frequency !== undefined) score += bm25Term(idf.get(word) as number, frequency, entry.length, average);
    }
    if (score > (best[entry.owner] as number)) best[entry.owner] = score;
  }
  return best;
}

/**
 * BM25 (k1 1.2, b 0.75) of each document for the query, the document taken WHOLE, over exactly the documents given (the idf is theirs). Returns one score per document, 0 for a document with none of the query's
 * words. At most 12 query words count. The search no longer uses this (it scores passages: `bm25PassageScores`); it stays as the whole-row reference that the eval and the tests compare the passage scorer with.
 */
export function bm25Scores(query: string, documents: readonly string[]): number[] {
  return scoreByPassage(query, documents, Number.POSITIVE_INFINITY);
}

/**
 * BM25 of each document's BEST PASSAGE (the passage rule above): what the keyword side of the search uses, over the newest rows it reads (`KEYWORD_SCAN_ROWS`) and the facts. A document of at most
 * `PASSAGE_TOKENS` tokens scores as it does whole; a longer one scores by the passage that matches best, so a fact late in a long text finds the row. At most 12 query words count.
 */
export function bm25PassageScores(query: string, documents: readonly string[]): number[] {
  return scoreByPassage(query, documents, PASSAGE_TOKENS);
}

/** One ranked list's rank (1 is best) for every id in it, in the order given. */
export function ranksOf(ids: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of ids) if (!ranks.has(id)) ranks.set(id, ranks.size + 1);
  return ranks;
}

/** Reciprocal rank fusion of ranked lists of ids (best first): the score of an id is the sum of 1 / (RRF_K + rank) over the lists it is in. Ids in several lists rank above ids in one. Best first; ties keep the order of first appearance. */
export function reciprocalRankFusion(lists: ReadonlyArray<readonly string[]>): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  for (const list of lists) for (const [id, rank] of ranksOf(list)) score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank));
  return [...score].map(([id, value]) => ({ id, score: value })).sort((left, right) => right.score - left.score);
}
