// Lessons phase 1, the Beta strength (research Q3): a prior worth 4 uses at the project's clean-merge rate, over the evidence of the last 180 days. It replaces the Wilson bound, which is 0 for a lesson never loaded,
// so a new lesson ranked as if it had failed. Pure maths first, then what the loader does with it.
import { describe, expect, it } from "vitest";
import { betaStrength, legacyEvidence, priorRateOf } from "../../../packages/broker/src/lessons/strength.js";
import { wilsonLower } from "../../../packages/broker/src/lessons/load.js";
import { mergePk } from "../../../packages/broker/src/lessons/measure.js";
import { documentEvidenceSink, evidencePk, readEvidenceTotals } from "../../../packages/broker/src/lessons/evidence.js";
import { PRIOR_RATE_FALLBACK, PRIOR_RATE_RANGE, PRIOR_WEIGHT_USES, EVIDENCE_WINDOW_DAYS } from "../../../packages/broker/src/lessons/scoring-settings.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { NO_FIT_FLOOR, PROJECT, WS } from "./lesson-helpers.js";
import { A, B, DAY, fitting, ids, world } from "./phase12-helpers.js";

describe("the Beta score", () => {
  it("a lesson with no evidence starts at the project's own rate: a project that merges clean 85% of the time starts a new lesson at 0.85", () => {
    expect(betaStrength({ forW: 0, againstW: 0 }, 0.85)).toBeCloseTo(0.85, 10);
    expect(betaStrength({ forW: 0, againstW: 0 }, 0.4)).toBeCloseTo(0.4, 10);
    expect(betaStrength({ forW: 0, againstW: 0 }, undefined)).toBeCloseTo(PRIOR_RATE_FALLBACK, 10);
    expect(betaStrength({ forW: 0, againstW: 0 }, null)).toBeCloseTo(PRIOR_RATE_FALLBACK, 10);
  });

  it("the prior is worth four uses: four whole 'for' marks move a 0.5 prior to 0.75, and four 'against' to 0.25", () => {
    expect(PRIOR_WEIGHT_USES).toBe(4);
    expect(betaStrength({ forW: 4, againstW: 0 }, 0.5)).toBeCloseTo(6 / 8, 10);
    expect(betaStrength({ forW: 0, againstW: 4 }, 0.5)).toBeCloseTo(2 / 8, 10);
    expect(betaStrength({ forW: 2, againstW: 2 }, 0.5)).toBeCloseTo(0.5, 10);
  });

  it("evidence moves it the right way, and a share of a mark moves it less than a whole one", () => {
    const rate = 0.8;
    expect(betaStrength({ forW: 1, againstW: 0 }, rate)).toBeGreaterThan(betaStrength({ forW: 0, againstW: 0 }, rate));
    expect(betaStrength({ forW: 0, againstW: 1 }, rate)).toBeLessThan(betaStrength({ forW: 0, againstW: 0 }, rate));
    expect(betaStrength({ forW: 0.25, againstW: 0 }, rate)).toBeLessThan(betaStrength({ forW: 1, againstW: 0 }, rate));
    expect(betaStrength({ forW: 0.25, againstW: 0 }, rate)).toBeGreaterThan(betaStrength({ forW: 0, againstW: 0 }, rate));
  });

  it("the prior's centre is kept inside a range, so one all-clean month cannot make the prior itself decide", () => {
    expect(priorRateOf(1)).toBe(PRIOR_RATE_RANGE.max);
    expect(priorRateOf(0)).toBe(PRIOR_RATE_RANGE.min);
    expect(priorRateOf(Number.NaN)).toBe(PRIOR_RATE_FALLBACK);
  });

  it("negative or non-finite evidence counts as none (a bad row can not push a lesson up or down)", () => {
    expect(betaStrength({ forW: -5, againstW: Number.NaN }, 0.5)).toBeCloseTo(0.5, 10);
    expect(betaStrength({ forW: Number.POSITIVE_INFINITY, againstW: 0 }, 0.5)).toBeLessThanOrEqual(1);
  });

  it("the Wilson bound it replaces is 0 for a lesson never loaded (the cold start the research found)", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(betaStrength({ forW: 0, againstW: 0 }, 0.5)).toBeGreaterThan(wilsonLower(0, 0));
  });
});

describe("the 180-day window and the legacy counters", () => {
  const now = 1_800_000_000_000;
  const row = (extra: Record<string, unknown>) => ({ pk: evidencePk(WS, PROJECT), entityType: "LESSON_EVIDENCE", project: PROJECT, keepUntil: now + 30 * DAY, ...extra });

  it("only the last 180 days count: older 'for' rows drop out, newer ones stay", async () => {
    const docs = new MemoryDocumentStore();
    for (const [sk, at, w] of [["E#les_aaaa1111#1#a", now - 200 * DAY, 1], ["E#les_aaaa1111#2#b", now - 179 * DAY, 0.5], ["E#les_aaaa1111#3#c", now - 10 * DAY, 0.25]] as const) {
      await docs.put({ item: row({ sk, kind: "for", lessonId: "les_aaaa1111", w, at }) });
    }
    const totals = await readEvidenceTotals(docs, { companyId: A, project: PROJECT, now, windowMs: EVIDENCE_WINDOW_DAYS * DAY });
    expect(totals.evidence.get("les_aaaa1111")).toEqual({ forW: 0.75, againstW: 0 });
  });

  it("a row past its own keepUntil, a row of another project, a row of another shape and a row of another company are never counted", async () => {
    const docs = new MemoryDocumentStore();
    await docs.put({ item: row({ sk: "E#les_aaaa1111#1#a", kind: "for", lessonId: "les_aaaa1111", w: 1, at: now - DAY, keepUntil: now - 1 }) });
    await docs.put({ item: row({ sk: "E#les_aaaa1111#2#b", kind: "for", lessonId: "les_aaaa1111", w: 1, at: now - DAY, project: "proj-2" }) });
    await docs.put({ item: row({ sk: "E#les_aaaa1111#3#c", kind: "for", lessonId: "les_aaaa1111", w: 7, at: now - DAY }) });
    await docs.put({ item: row({ sk: "E#les_aaaa1111#4#d", kind: "mystery", lessonId: "les_aaaa1111", w: 1, at: now - DAY }) });
    await docs.put({ item: { ...row({ sk: "E#les_aaaa1111#5#e", kind: "for", lessonId: "les_aaaa1111", w: 1, at: now - DAY }), pk: evidencePk(B, PROJECT) } });
    const mine = await readEvidenceTotals(docs, { companyId: A, project: PROJECT, now, windowMs: 180 * DAY });
    expect(mine.evidence.size).toBe(0);
    const theirs = await readEvidenceTotals(docs, { companyId: B, project: PROJECT, now, windowMs: 180 * DAY });
    // Company B's partition holds one good row, but it names company A's project key: the row's own project field is checked too.
    expect(theirs.evidence.get("les_aaaa1111")).toEqual({ forW: 1, againstW: 0 });
  });

  it("a lesson from before the rows existed is weighed by its own counters (helpful dropped only when its last helpful time is known and old)", () => {
    expect(legacyEvidence({ counters: { helpful: 9, harmful: 1 } }, now, 180 * DAY)).toEqual({ forW: 9, againstW: 1 });
    expect(legacyEvidence({ counters: { helpful: 9, harmful: 1 }, lastHelpfulAt: now - 10 * DAY }, now, 180 * DAY)).toEqual({ forW: 9, againstW: 1 });
    expect(legacyEvidence({ counters: { helpful: 9, harmful: 1 }, lastHelpfulAt: now - 400 * DAY }, now, 180 * DAY)).toEqual({ forW: 0, againstW: 1 });
  });
});

describe("what the loader does with the strength", () => {
  const same = { title: "Retries", body: "Retry failed HTTP calls in the api service with withRetry" };

  it("a NEW lesson is not ranked below an old one for age alone (it starts at the project's rate, not at zero)", async () => {
    const w = await world();
    // Both fit equally. The old lesson has been loaded 30 times with 2 helpful marks and 20 against (a poor record, though its Wilson bound is above 0); the new one has none.
    // (Lessons of identical words are ranked in id order by the similarity step, so the OLD lesson is named to come first on that tie: the new one must win on its strength alone.)
    await w.add(fitting("les_aold0001", { ...same, counters: { loaded: 30, helpful: 2, harmful: 20, citationStale: 0 } }), fitting("les_znew0001", same));
    const result = await w.load({}, { ranking: { ...NO_FIT_FLOOR, newcomerSlots: 0 } });
    expect(ids(result)[0]).toBe("les_znew0001");
    // Under Wilson the new lesson's third of the score was 0 and the middling old lesson's was positive: the old one won on age.
    expect(result.manifest.lessons[0]!.score).toBeGreaterThanOrEqual(result.manifest.lessons[1]!.score);
  });

  it("a lesson with evidence rows 'for' outranks an untouched one of equal fit, and one with rows 'against' ranks below it", async () => {
    const w = await world();
    // (Ids chosen so that the similarity step's id-order tie-break favours the lesson with 'against' rows and disfavours the one with 'for' rows: the evidence has to overcome it.)
    await w.add(fitting("les_bbbb0001", same), fitting("les_zzzz0001", same), fitting("les_aaaa0001", same));
    for (let i = 0; i < 4; i += 1) {
      await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_zzzz0001", kind: "for", weight: 1, at: w.clock.now() - i * DAY, id: `t${i}` });
      await w.evidence.note({ workspaceId: WS, project: PROJECT, lessonId: "les_aaaa0001", kind: "against", weight: 1, at: w.clock.now() - i * DAY, id: `m${i}` });
    }
    const order = ids(await w.load({}, { ranking: { ...NO_FIT_FLOOR, newcomerSlots: 0 } }));
    expect(order).toEqual(["les_zzzz0001", "les_bbbb0001", "les_aaaa0001"]);
  });

  it("the prior follows the project's clean-merge rate: with the same evidence a lesson ranks higher in a project that merges clean than in one that does not", async () => {
    const scores: number[] = [];
    for (const reverted of [0, 8]) {
      const w = await world();
      await w.add(fitting("les_a0000001", same));
      for (let i = 0; i < 10; i += 1) {
        await w.documents.put({ item: { pk: mergePk(WS, PROJECT), sk: `M#task-${i}`, entityType: "LESSON_MERGE", kind: "merged", project: PROJECT, taskId: `task-${i}`, at: w.clock.now() - 20 * DAY, keepUntil: w.clock.now() + 30 * DAY } });
        if (i < reverted) await w.documents.put({ item: { pk: mergePk(WS, PROJECT), sk: `R#task-${i}`, entityType: "LESSON_MERGE", kind: "reverted", project: PROJECT, taskId: `task-${i}`, at: w.clock.now(), keepUntil: w.clock.now() + 30 * DAY } });
      }
      scores.push((await w.load({}, { ranking: NO_FIT_FLOOR })).manifest.lessons[0]!.score);
    }
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });

  it("evidence of another company or another project never moves this project's ranking", async () => {
    const w = await world();
    await w.add(fitting("les_a0000001", same), fitting("les_b0000001", same));
    const other = documentEvidenceSink(w.documents, B);
    await other.note({ workspaceId: B, project: PROJECT, lessonId: "les_b0000001", kind: "for", weight: 1, at: w.clock.now(), id: "x" });
    await w.evidence.note({ workspaceId: WS, project: "proj-2", lessonId: "les_b0000001", kind: "for", weight: 1, at: w.clock.now(), id: "y" });
    const order = ids(await w.load({}, { ranking: { ...NO_FIT_FLOOR, newcomerSlots: 0 } }));
    expect(order).toEqual(["les_a0000001", "les_b0000001"]);
  });
});
