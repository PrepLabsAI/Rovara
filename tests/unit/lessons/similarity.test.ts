// The shortlist. Code-aware keywords, cited paths and (optionally) the small embedder, fused. Tested on the research's hand-written set (71 lessons, 40 labelled
// pairs, 12 task intents: designs-2026-10-30/lessons-similarity-eval) in BOTH modes: no embedder, and a fake embedder.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GATE, JUDGE_CANDIDATES, MAX_EMBED_PER_CALL, SIMILARITY_LOG, docOf, docOfText, fuse, isFlippedCopy, isNearExact, isVerbatim, keepVector, lessonTextOf, passesGate, pathOverlap, rankLessons, resetNoEmbedderNotice, textHash,
  tokensOf, type LessonLike, type SimilarityDeps,
} from "../../../packages/lessons/src/similarity.js";
import { BASE, KEY, MemoryVectors, embedder } from "./lesson-helpers.js";

interface FixtureLesson { id: string; title: string; description: string; body: string; scope: { paths?: string[] }; citations: Array<{ repo: string; path: string }>; active: boolean }
const read = <T,>(name: string): T => JSON.parse(readFileSync(new URL(`./similarity-fixture-${name}.json`, import.meta.url), "utf8")) as T;
const toLesson = (x: FixtureLesson): LessonLike & { id: string } => ({
  id: x.id, title: x.title, description: x.description, body: x.body, scope: x.scope,
  citations: x.citations.map((c) => ({ kind: "code" as const, repo: c.repo, path: c.path, startLine: 1, endLine: 2, anchor: "anchor", commit: BASE })),
});
const all = read<FixtureLesson[]>("lessons");
const byId = new Map(all.map((l) => [l.id, toLesson(l)] as const));
const stored = all.filter((l) => l.active).map(toLesson);
const pairs = read<Array<{ existing: string; draft: string; label: string }>>("pairs");
const intents = read<Array<{ id: string; intent: string; plan: string; relevant: string[] }>>("intents");

const log: Array<[string, Record<string, unknown>]> = [];
const sim = (over: Partial<SimilarityDeps> = {}): SimilarityDeps & { vectors: MemoryVectors } => ({ vectors: new MemoryVectors(), log: (event, fields) => { log.push([event, fields]); }, ...over }) as SimilarityDeps & { vectors: MemoryVectors };
beforeEach(() => { log.length = 0; resetNoEmbedderNotice(); embedder.fail = false; embedder.calls = 0; });

describe("tokens: code-aware", () => {
  it("keeps identifiers and paths whole and also splits them on case and punctuation; drops stop words", () => {
    const tokens = tokensOf("Use withRetry from src/retry/index.ts, not with_retry_v2().");
    expect(tokens).toEqual(expect.arrayContaining(["withretry", "retry", "src/retry/index.ts", "src", "index", "ts", "with_retry_v2", "v2"]));
    expect(tokens).not.toContain("use");
    expect(tokens).not.toContain("not");
  });
  it("a path counts once when asked to collapse it (overlap measures), and in parts otherwise (keyword search)", () => {
    expect(tokensOf("see src/billing/money.ts", { collapsePaths: true })).toEqual(["see", "src/billing/money.ts"]);
    expect(tokensOf("see src/billing/money.ts")).toEqual(expect.arrayContaining(["src/billing/money.ts", "billing", "money"]));
  });
});

describe("paths", () => {
  it("the same file is 1; a shared folder two levels deep 0.6; the same first folder 0.2; the same file name elsewhere 0.5; nothing 0", () => {
    expect(pathOverlap(["packages/api/prisma/schema.prisma"], ["packages/api/prisma/schema.prisma"])).toBe(1);
    expect(pathOverlap(["packages/api/prisma/**"], ["packages/api/prisma/schema.prisma"])).toBe(0.6);
    expect(pathOverlap(["packages/api/a.ts"], ["packages/web/b.ts"])).toBe(0.2);
    expect(pathOverlap(["src/a/index.ts"], ["lib/b/index.ts"])).toBe(0.5);
    expect(pathOverlap(["docs/x.md"], ["src/y.ts"])).toBe(0);
    expect(pathOverlap([], ["src/y.ts"])).toBe(0);
  });
});

describe("the shortlist on the research set", () => {
  const stage = (l: LessonLike & { id: string }) => docOf(l);
  const kinds = ["duplicate_paraphrase", "duplicate_paths_only", "contradiction", "refinement"];

  it("keywords and paths alone (no embedder): the lesson a draft duplicates, contradicts or refines is in the judge's top five, for every labelled pair", () => {
    const docs = stored.map(stage);
    const missed: string[] = [];
    let checked = 0;
    for (const pair of pairs.filter((p) => kinds.includes(p.label))) {
      const ranked = fuse(docOf(byId.get(pair.draft)!), docs).filter(passesGate).slice(0, JUDGE_CANDIDATES);
      checked += 1;
      if (!ranked.some((r) => r.id === pair.existing)) missed.push(`${pair.label}:${pair.existing}<-${pair.draft}`);
    }
    expect(checked).toBe(30);
    expect(missed).toEqual([]);
  });

  it("with an embedder: the same pairs, and the draft's own vector is made once", async () => {
    const deps = sim({ embedder });
    const missed: string[] = [];
    for (const pair of pairs.filter((p) => kinds.includes(p.label))) {
      const { ranked, mode, queryVector } = await rankLessons(deps, KEY, stored, docOf(byId.get(pair.draft)!), { embedMissing: true });
      expect(mode).toBe("fused");
      expect(queryVector).toHaveLength(embedder.dimension);
      if (!ranked.filter(passesGate).slice(0, JUDGE_CANDIDATES).some((r) => r.id === pair.existing)) missed.push(pair.draft);
    }
    expect(missed).toEqual([]);
  });

  it("a duplicate and a contradiction rank first or second among the 47 stored lessons, in both modes", async () => {
    const docs = stored.map(stage);
    for (const pair of pairs.filter((p) => p.label === "duplicate_paraphrase" || p.label === "duplicate_paths_only" || p.label === "contradiction")) {
      const keyword = fuse(docOf(byId.get(pair.draft)!), docs);
      expect(keyword.findIndex((r) => r.id === pair.existing), `${pair.draft} keyword`).toBeLessThanOrEqual(1);
    }
    const deps = sim({ embedder });
    for (const pair of pairs.filter((p) => p.label === "contradiction")) {
      const { ranked } = await rankLessons(deps, KEY, stored, docOf(byId.get(pair.draft)!), { embedMissing: true });
      expect(ranked.findIndex((r) => r.id === pair.existing), `${pair.draft} fused`).toBeLessThanOrEqual(1);
    }
  });

  it("a draft with nothing like it sends nothing to the judge: the gate keeps the shortlist short", () => {
    const docs = stored.map(stage);
    const draft: LessonLike = { title: "Prefer tabs in the Makefile", description: "", body: "Makefile recipes need a literal tab character, never spaces.", scope: {}, citations: [] };
    expect(fuse(docOf(draft, "d"), docs).filter(passesGate)).toEqual([]);
    expect(GATE.containment).toBeGreaterThan(0);
  });

  it("task ranking (the loader's use): for every task intent a relevant lesson is in the top five, and most relevant lessons are found, in both modes", async () => {
    const docs = stored.map(stage);
    let found = 0, total = 0;
    for (const intent of intents) {
      const ranked = fuse(docOfText(`${intent.intent}\n${intent.plan}`), docs).slice(0, 5).map((r) => r.id);
      expect(ranked.some((id) => intent.relevant.includes(id)), intent.id).toBe(true);
      found += intent.relevant.filter((id) => ranked.includes(id)).length;
      total += intent.relevant.length;
    }
    expect(found / total).toBeGreaterThanOrEqual(0.7);
    const deps = sim({ embedder });
    const fused = await rankLessons(deps, KEY, stored, docOfText(`${intents[0]!.intent}\n${intents[0]!.plan}`), { queryKind: "query", embedMissing: true });
    expect(fused.ranked.slice(0, 5).some((r) => intents[0]!.relevant.includes(r.id))).toBe(true);
  });
});

describe("copies: the only thing that merges by code", () => {
  const cited = (path: string): LessonLike["citations"] => [{ kind: "code", repo: "api", path, startLine: 1, endLine: 2, anchor: "x", commit: BASE }];
  const mk = (body: string, path: string | undefined, title = "Retries"): LessonLike & { id: string } => ({ id: "x", title, description: "", body, scope: { repos: ["api"] }, citations: path === undefined ? [] : cited(path) });
  const rank = (a: LessonLike, b: LessonLike & { id: string }) => fuse(docOf(a, "q"), [docOf(b)])[0]!;
  const text = (l: LessonLike): string => l.body;

  it("the same cited file, the same polarity and nearly the same words: a near-exact copy; the same words with another file are not", () => {
    const a = mk("HTTP retries in the api service use withRetry from src/retry/index.ts.", "src/retry/index.ts");
    const near = mk("HTTP retries in the api service use withRetry from src/retry/index.ts too.", "src/retry/index.ts");
    expect(isNearExact(rank(a, near), text(a), text(near))).toBe(true);
    const other = mk("HTTP retries in the api service use withRetry from src/retry/index.ts too.", "src/other/file.ts");
    expect(isNearExact(rank(a, other), text(a), text(other))).toBe(false);
  });

  it("the same advice in other words, or with a clause added, is not a near-exact copy: it goes to the judge", () => {
    const a = mk("Use withRetry for HTTP retries in the api service client.", "src/retry/index.ts");
    const other = mk("Wrap outbound calls with withRetry, except webhook deliveries which must fail fast, in the api service.", "src/retry/index.ts");
    expect(isNearExact(rank(a, other), text(a), text(other))).toBe(false);
  });

  it("opposite polarity is never a copy: the pair that differs only in polarity is flipped (judge or person), and is not verbatim either", () => {
    const a = mk("Always use withRetry for HTTP calls in the api service wrapper.", "src/retry/index.ts", "Retries");
    const b = mk("Never use withRetry for HTTP calls in the api service wrapper.", "src/retry/index.ts", "Retries");
    const r = rank(a, b);
    expect(isNearExact(r, text(a), text(b))).toBe(false);
    expect(isVerbatim(r, text(a), text(b))).toBe(false);
    expect(isFlippedCopy(r, text(a), text(b))).toBe(true);
  });

  it("verbatim: the very same body words with the same file, or with no file on either side", () => {
    const a = mk("Money amounts are stored as integer cents.", undefined);
    const b = mk("Money amounts are stored as integer cents.", undefined, "Cents");
    expect(isVerbatim(rank(a, b), text(a), text(b))).toBe(true);
    const c = mk("Money amounts are stored as integer cents.", "src/billing/money.ts");
    expect(isVerbatim(rank(a, c), text(a), text(c))).toBe(false);
  });
});

describe("the ranking in both modes", () => {
  const pool = stored.slice(0, 12);
  const draft = docOf(byId.get("b1")!);

  it("no embedder: keywords and paths, no vector is read or written, and one fixed log line says so (once)", async () => {
    const deps = sim();
    const first = await rankLessons(deps, KEY, pool, draft, { embedMissing: true });
    await rankLessons(deps, KEY, pool, draft, { embedMissing: true });
    expect(first.mode).toBe("keyword");
    expect(first.queryVector).toBeUndefined();
    expect(first.ranked.length).toBeGreaterThan(0);
    expect(deps.vectors.rows.size).toBe(0);
    expect(log.filter(([event]) => event === SIMILARITY_LOG.noEmbedder)).toEqual([[SIMILARITY_LOG.noEmbedder, {}]]);
  });

  it("with an embedder: lessons without a vector are embedded (once each) and stored with the spec and the text hash; a second call embeds only the query", async () => {
    const deps = sim({ embedder });
    const first = await rankLessons(deps, KEY, pool, draft, { embedMissing: true });
    expect(first.mode).toBe("fused");
    expect(deps.vectors.rows.size).toBe(pool.length);
    const row = deps.vectors.rows.get(`${KEY.workspaceId}\u0001${KEY.project}\u0001${pool[0]!.id}`)!;
    expect(row).toMatchObject({ spec: embedder.spec, hash: textHash(lessonTextOf(pool[0]!)) });
    expect(row.vector).toHaveLength(embedder.dimension);
    embedder.calls = 0;
    await rankLessons(deps, KEY, pool, draft, { embedMissing: true });
    expect(embedder.calls).toBe(1);
  });

  it("the embedder takes part in the fusion: a lesson with no word in common but a near vector is still found", async () => {
    const twin = { ...pool[0]!, id: "twin", title: "zzz", description: "", body: "qqq www eee", scope: {}, citations: [] };
    const deps = sim({ embedder: { ...embedder, embedMany: async (texts: readonly string[]) => texts.map((t) => (t.includes("qqq") || t.includes("Retries draft") ? Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)) : Array.from({ length: 256 }, (_, i) => (i === 1 ? 1 : 0)))) } });
    const query = docOfText("Retries draft");
    const keyword = fuse(query, [docOf(twin)]);
    expect(keyword).toEqual([]);
    const fused = await rankLessons(deps, KEY, [twin], query, { embedMissing: true });
    expect(fused.ranked.map((r) => r.id)).toEqual(["twin"]);
    expect(fused.ranked[0]!.cosine).toBeCloseTo(1);
  });

  it("an edited lesson (another text hash) and a changed embedder spec both make the vector stale: it is embedded again", async () => {
    const deps = sim({ embedder });
    await rankLessons(deps, KEY, pool, draft, { embedMissing: true });
    const edited = [{ ...pool[0]!, body: `${pool[0]!.body} Edited.` }, ...pool.slice(1)];
    embedder.calls = 0;
    await rankLessons(deps, KEY, edited, draft, { embedMissing: true });
    expect(embedder.calls).toBe(2); // one batch for the edited lesson, one for the query
    const newSpec = { ...embedder, spec: "test-bow-256-v2", embedMany: embedder.embedMany.bind(embedder) } as typeof embedder;
    embedder.calls = 0;
    const again = sim({ embedder: newSpec, vectors: deps.vectors });
    await rankLessons(again, KEY, pool, draft, { embedMissing: true });
    // Every lesson has only the old spec's vector: all are made again (in one batch) and replace the old ones.
    expect(embedder.calls).toBe(pool.length + 1);
    expect([...deps.vectors.rows.values()].every((r) => r.spec === "test-bow-256-v2")).toBe(true);
  });

  it("the loader's form (embedMissing off) reads the vectors that exist and makes none", async () => {
    const deps = sim({ embedder });
    embedder.calls = 0;
    const result = await rankLessons(deps, KEY, pool, draft, { queryKind: "query" });
    expect(result.mode).toBe("fused");
    expect(deps.vectors.rows.size).toBe(0);
    expect(embedder.calls).toBe(1);
  });

  it(`at most ${MAX_EMBED_PER_CALL} lessons are embedded in one call; the rest wait for the next`, async () => {
    const many = Array.from({ length: MAX_EMBED_PER_CALL + 10 }, (_, i) => ({ ...pool[0]!, id: `les_many${i}`, body: `Body number ${i} about withRetry` }));
    const deps = sim({ embedder });
    await rankLessons(deps, KEY, many, draft, { embedMissing: true });
    expect(deps.vectors.rows.size).toBe(MAX_EMBED_PER_CALL);
    await rankLessons(deps, KEY, many, draft, { embedMissing: true });
    expect(deps.vectors.rows.size).toBe(MAX_EMBED_PER_CALL + 10);
  });

  it("an embedder that is down, a vector store that is down, or a wrong-sized vector falls back to keywords and paths with one fixed log code, and never throws", async () => {
    const keyword = (await rankLessons(sim(), KEY, pool, draft)).ranked.map((r) => r.id);
    embedder.fail = true;
    const down = await rankLessons(sim({ embedder }), KEY, pool, draft, { embedMissing: true });
    expect(down.mode).toBe("keyword");
    expect(down.ranked.map((r) => r.id)).toEqual(keyword);
    expect(log.some(([event]) => event === SIMILARITY_LOG.embedderDown)).toBe(true);
    embedder.fail = false;
    const broken = sim({ embedder });
    broken.vectors.fail = true;
    const stillFused = await rankLessons(broken, KEY, pool, draft, { embedMissing: true });
    expect(stillFused.mode).toBe("fused");
    expect(log.some(([event]) => event === SIMILARITY_LOG.vectorsDown)).toBe(true);
    const wrong = await rankLessons(sim({ embedder: { ...embedder, embedMany: async (texts: readonly string[]) => texts.map(() => [1, 0]) } }), KEY, pool, draft, { embedMissing: true });
    expect(wrong.mode).toBe("keyword");
    // No log line holds text from an error or from a lesson.
    expect(JSON.stringify(log)).not.toContain("embed down");
  });

  it("keepVector stores a lesson's vector for the current spec, only with an embedder and a vector of the right size", async () => {
    const deps = sim({ embedder });
    const lesson = { id: "les_keep0001", title: "t", description: "d", body: "b" };
    await keepVector(deps, KEY, lesson, [1, 2]);
    expect(deps.vectors.rows.size).toBe(0);
    await keepVector(sim(), KEY, lesson, new Array<number>(256).fill(0.1));
    await keepVector(deps, KEY, lesson, new Array<number>(256).fill(0.1));
    expect(deps.vectors.rows.size).toBe(1);
  });
});
