// The "same mistake twice" measure (lessons/metric.ts). Counts, per project and over a window, how often a correction given once had to be given again on a later task, split into
// "the lesson was loaded", "the lesson existed but was not loaded" and "there was no lesson". Read-only.
import { describe, expect, it } from "vitest";
import {
  METRIC_MIN_CORRECTIONS, REPEAT_LOOKBACK_DAYS, sameMistakeTwice, type CorrectionMatcher, type CorrectionRecord, type CorrectionSource, type MetricDeps, type MetricStore,
} from "../../../packages/lessons/src/metric.js";
import { InMemoryLessonStore, type LoadManifestEntry } from "../../../packages/lessons/src/store.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { KEY, PROJECT, WS, lessonRecord, seed } from "./lesson-helpers.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WINDOW = { sinceMs: NOW - 30 * DAY, untilMs: NOW };

let n = 0;
const correction = (text: string, over: Partial<CorrectionRecord> = {}): CorrectionRecord => {
  n += 1;
  return { id: `c${String(n).padStart(4, "0")}`, taskId: `task-${n}`, at: NOW - (40 - n) * 60_000, kind: "send_back", member: true, text, ...over };
};

/** A source over a fixed list, keyed by project so a measurement of one project cannot see another's. */
function source(byProject: Record<string, CorrectionRecord[]>): CorrectionSource & { asked: Array<{ project: string; since: number; until: number; limit: number }> } {
  const asked: Array<{ project: string; since: number; until: number; limit: number }> = [];
  return {
    asked,
    async list(key, range, limit) {
      asked.push({ project: key.project, since: range.since, until: range.until, limit });
      const all = (byProject[`${key.workspaceId}/${key.project}`] ?? []).filter((c) => c.at >= range.since && c.at < range.until).sort((a, b) => a.at - b.at);
      return { corrections: all.slice(0, limit), truncated: all.length > limit };
    },
  };
}
/** Same text means the same advice; a lesson matches a correction whose text its body holds. */
const matcher = (over: Partial<CorrectionMatcher> = {}): CorrectionMatcher => ({
  sameAsCorrection: async (earlier, later) => earlier.text === later.text,
  sameAsLesson: async (c, lesson) => lesson.body.toLowerCase().includes((c.text ?? "\u0000").toLowerCase()),
  ...over,
});

const entry = (id: string, citation: LoadManifestEntry["citation"] = "valid"): LoadManifestEntry => ({ id, version: 1, score: 0.5, why: "scope", citation });
async function loadedFor(store: InMemoryLessonStore, taskId: string, ...entries: LoadManifestEntry[]): Promise<void> {
  await store.putManifest({ taskId, workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: NOW, lessons: entries, bytes: 100 });
}
const live = (id: string, body: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, body, status: "active", createdAt: NOW - 60 * DAY, updatedAt: NOW - 60 * DAY, expiresAt: NOW + 60 * DAY, ...over });

function setup(corrections: CorrectionRecord[], over: Partial<MetricDeps> = {}) {
  const store = new InMemoryLessonStore();
  const src = source({ [`${WS}/${PROJECT}`]: corrections });
  const deps: MetricDeps = { corrections: src, matcher: matcher(), store, ...over };
  return { deps, store, src };
}
const run = (deps: MetricDeps, window = WINDOW, limits = {}) => sameMistakeTwice(deps, KEY, window, limits);

/** Pads to the minimum number of judged corrections with distinct one-off corrections, so a rate is shown. */
const padding = (count: number): CorrectionRecord[] => Array.from({ length: count }, (_, i) => correction(`one-off ${i} ${Math.random()}`));

describe("what is a repeat, and the three groups", () => {
  it("splits repeats into lesson loaded, lesson not loaded and no lesson; each repeat is in exactly one group", async () => {
    n = 0;
    const first = correction("use withRetry for http calls", { taskId: "T1" });
    const loaded = correction("use withRetry for http calls", { taskId: "T2" });
    const missed = correction("use withRetry for http calls", { taskId: "T3" });
    const noLessonFirst = correction("keep unit tests under a second", { taskId: "T4" });
    const noLessonRepeat = correction("keep unit tests under a second", { taskId: "T5" });
    const { deps, store } = setup([first, loaded, missed, noLessonFirst, noLessonRepeat, ...padding(6)]);
    // The lesson went live after the first correction and before the second.
    await seed(store, live("les_retry001", "Use withRetry for http calls in the api.", { createdAt: first.at + 1, updatedAt: first.at + 1 }));
    await loadedFor(store, "T2", entry("les_retry001"));
    const result = await run(deps);
    expect(result).toMatchObject({ corrections: 11, repeats: 3, split: { lessonLoaded: 1, lessonNotLoaded: 1, noLesson: 1 }, unjudged: 0, truncated: false, enoughData: true });
    expect(result.split.lessonLoaded + result.split.lessonNotLoaded + result.split.noLesson).toBe(result.repeats);
    expect(result.rate).toBeCloseTo(3 / 11, 10);
  });

  it("a correction that matches a live lesson is a repeat even with no earlier correction of its own (the lesson came from somewhere else)", async () => {
    n = 0;
    const only = correction("use withRetry for http calls", { taskId: "T1" });
    const { deps, store } = setup([only, ...padding(9)]);
    await seed(store, live("les_retry002", "Use withRetry for http calls.", { createdAt: only.at - DAY, updatedAt: only.at - DAY }));
    const result = await run(deps);
    expect(result).toMatchObject({ corrections: 10, repeats: 1, split: { lessonLoaded: 0, lessonNotLoaded: 1, noLesson: 0 } });
  });

  it("the same correction twice in ONE task is not a repeat (it has to come back on a later task)", async () => {
    n = 0;
    const a = correction("tag the release", { taskId: "T1" });
    const b = correction("tag the release", { taskId: "T1" });
    const { deps } = setup([a, b, ...padding(8)]);
    expect(await run(deps)).toMatchObject({ corrections: 10, repeats: 0 });
  });

  it("only an earlier task counts, and only within 90 days", async () => {
    n = 0;
    const old = correction("pin the base image", { taskId: "T1", at: WINDOW.sinceMs - (REPEAT_LOOKBACK_DAYS + 5) * DAY });
    const inRange = correction("rename the flag", { taskId: "T2", at: WINDOW.sinceMs - 30 * DAY });
    const repeatsOld = correction("pin the base image", { taskId: "T3" });
    const repeatsInRange = correction("rename the flag", { taskId: "T4" });
    // Inside the read range (80 days before the window) but 100 days before the late correction that says it again: each correction has its OWN 90 days.
    const farEarlier = correction("drop the legacy route", { taskId: "T5", at: WINDOW.sinceMs - 80 * DAY });
    const tooLate = correction("drop the legacy route", { taskId: "T6", at: WINDOW.untilMs - DAY });
    const { deps } = setup([old, inRange, repeatsOld, repeatsInRange, farEarlier, tooLate, ...padding(6)]);
    const result = await run(deps);
    // The 95-day-old correction is outside the lookback; the 30-days-before-the-window one is inside. Those two and farEarlier are not in the window, so they are not counted themselves.
    expect(result.corrections).toBe(9);
    expect(result.repeats).toBe(1);
  });

  it("a later correction never makes an earlier one a repeat (time runs one way)", async () => {
    n = 0;
    const early = correction("add a changelog line", { taskId: "T1", at: NOW - 10 * DAY });
    const late = correction("add a changelog line", { taskId: "T2", at: NOW - 5 * DAY });
    const { deps } = setup([early, late, ...padding(8).map((c, i) => ({ ...c, at: NOW - (9 - i) * DAY / 2 }))]);
    const result = await run(deps);
    expect(result.repeats).toBe(1);
  });

  it("the repeat the capture step already found is believed, but only when it points at an earlier task", async () => {
    n = 0;
    const asked: string[] = [];
    const first = correction("alpha beta", { taskId: "T1" });
    const believed = correction("something else entirely", { taskId: "T2", repeatOf: first.id });
    const sameTask = correction("another thing", { taskId: "T1", repeatOf: first.id });
    const future = correction("one more thing", { taskId: "T9", repeatOf: "c9999" });
    const { deps } = setup([first, believed, sameTask, future, ...padding(6)], { matcher: matcher({ sameAsCorrection: async (e, l) => { asked.push(`${e.id}->${l.id}`); return false; } }) });
    const result = await run(deps);
    expect(result.repeats).toBe(1);
    expect(asked.some((pair) => pair.endsWith(`->${believed.id}`))).toBe(false);
    expect(asked.some((pair) => pair.endsWith(`->${sameTask.id}`) || pair.endsWith(`->${future.id}`))).toBe(true);
  });
});

describe("what counts as 'the lesson existed' and 'was loaded'", () => {
  async function scenario(lesson: Lesson, manifest: LoadManifestEntry[] | undefined, extra: (store: InMemoryLessonStore) => Promise<void> = async () => undefined) {
    n = 0;
    const c = correction("use withRetry for http calls", { taskId: "T1" });
    const { deps, store } = setup([c, ...padding(9)]);
    await seed(store, lesson);
    await extra(store);
    if (manifest !== undefined) await loadedFor(store, "T1", ...manifest);
    return run(deps);
  }
  const body = "Use withRetry for http calls.";
  const early = (over: Partial<Lesson> = {}) => live("les_ex000001", body, { createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY, ...over });

  it("loaded: the worker reported it reached the prompt (valid, moved or none)", async () => {
    for (const citation of ["valid", "moved", "none"] as const) expect((await scenario(early(), [entry("les_ex000001", citation)])).split.lessonLoaded, citation).toBe(1);
  });
  it("not loaded: a manifest entry the worker dropped (stale or unchecked) is a lesson that existed and did not reach the agent", async () => {
    for (const citation of ["stale_dropped", "unchecked_dropped", "unchecked"] as const) expect((await scenario(early(), [entry("les_ex000001", citation)])).split.lessonNotLoaded, citation).toBe(1);
  });
  it("a lesson that was not live then does not count as existing: pending, stale, retired, withdrawn, expired, or created after the correction", async () => {
    for (const over of [{ status: "pending" as const }, { status: "stale" as const }, { status: "retired" as const }, { status: "withdrawn" as const }, { expiresAt: NOW - 50 * DAY }, { createdAt: NOW + DAY, updatedAt: NOW + DAY }]) {
      const result = await scenario(early(over), undefined);
      expect(result.repeats, JSON.stringify(over)).toBe(0);
    }
  });
  it("it is the lesson AS IT WAS at the correction: one retired afterwards still counts, one that went live afterwards does not", async () => {
    n = 0;
    const c = correction("use withRetry for http calls", { taskId: "T1" });
    const { deps, store } = setup([c, ...padding(9)]);
    // v1 active (before the correction), v2 retired (after it).
    await seed(store, live("les_hist0001", body, { version: 1, createdAt: c.at - 5 * DAY, updatedAt: c.at - 5 * DAY }));
    await store.commit(KEY, await store.setVersion(KEY), [live("les_hist0001", body, { version: 2, status: "retired", createdAt: c.at - 5 * DAY, updatedAt: c.at + DAY })], c.at + DAY);
    // v1 pending (before), v2 active (after).
    await seed(store, live("les_hist0002", body, { version: 1, status: "pending", createdAt: c.at - 5 * DAY, updatedAt: c.at - 5 * DAY }));
    await store.commit(KEY, await store.setVersion(KEY), [live("les_hist0002", body, { version: 2, status: "active", createdAt: c.at - 5 * DAY, updatedAt: c.at + DAY })], c.at + DAY);
    await loadedFor(store, "T1", entry("les_hist0001"));
    const result = await run(deps);
    expect(result).toMatchObject({ repeats: 1, split: { lessonLoaded: 1, lessonNotLoaded: 0, noLesson: 0 } });
  });
  it("a lesson scoped to other paths is not the one that failed: a path-scoped lesson matches only a correction in its files", async () => {
    const docsOnly = early({ scope: { repos: ["api"], paths: ["docs/**"] } });
    n = 0;
    const inSrc = correction("use withRetry for http calls", { taskId: "T1", paths: ["src/a.ts"] });
    const inDocs = correction("use withRetry for http calls", { taskId: "T2", paths: ["docs/a.md"] });
    const { deps, store } = setup([inSrc, inDocs, ...padding(8)]);
    await seed(store, docsOnly);
    const result = await run(deps);
    // The docs correction is a repeat of the first AND matches the lesson; the src one matches no lesson (and it is the first of its kind).
    expect(result.repeats).toBe(1);
    expect(result.split.lessonNotLoaded).toBe(1);
  });
  it("when several lessons match, one of them being loaded makes it a loaded repeat", async () => {
    n = 0;
    const c = correction("use withRetry for http calls", { taskId: "T1" });
    const { deps, store } = setup([c, ...padding(9)]);
    await seed(store, live("les_a0000001", body, { createdAt: c.at - DAY, updatedAt: c.at - DAY }), live("les_b0000001", body, { createdAt: c.at - DAY, updatedAt: c.at - DAY }));
    await loadedFor(store, "T1", entry("les_b0000001"));
    expect((await run(deps)).split).toEqual({ lessonLoaded: 1, lessonNotLoaded: 0, noLesson: 0 });
  });
});

describe("who and what is counted", () => {
  it("an outsider's correction and an eval run's correction are never counted, and never make a member's a repeat", async () => {
    n = 0;
    const outsider = correction("mind the retry budget", { taskId: "T1", member: false });
    const evalRun = correction("mind the retry budget", { taskId: "T2", evalRun: true });
    const member = correction("mind the retry budget", { taskId: "T3" });
    const { deps } = setup([outsider, evalRun, member, ...padding(9)]);
    const result = await run(deps);
    expect(result.corrections).toBe(10);
    expect(result.repeats).toBe(0);
  });

  it("another project's corrections and another organisation's lessons are not read into this project", async () => {
    n = 0;
    const mine = correction("mind the retry budget", { taskId: "T1" });
    const theirs = correction("mind the retry budget", { taskId: "T2" });
    const store = new InMemoryLessonStore();
    const src = source({ [`${WS}/${PROJECT}`]: [mine, ...padding(9)], [`${WS}/proj-2`]: [theirs], [`org_bbbbbbbbbbbbbbbbbbbb/${PROJECT}`]: [theirs] });
    await seed(store, live("les_other001", "Mind the retry budget.", { project: "proj-2" }), live("les_other002", "Mind the retry budget.", { workspaceId: "org_bbbbbbbbbbbbbbbbbbbb" }));
    const result = await run({ corrections: src, matcher: matcher(), store });
    expect(result).toMatchObject({ corrections: 10, repeats: 0 });
    expect(src.asked.every((q) => q.project === PROJECT)).toBe(true);
    // A store that hands back another project's head (a bug) is not trusted either.
    const hostile: MetricStore = { ...store, listAllHeads: async () => [live("les_leak0001", "Mind the retry budget.", { project: "proj-2" })], versions: async () => [live("les_leak0001", "Mind the retry budget.", { project: "proj-2" })], manifests: async () => [] };
    expect(await run({ corrections: src, matcher: matcher(), store: hostile })).toMatchObject({ repeats: 0 });
  });

  it("only the window is counted; what came before it is read only to find repeats", async () => {
    n = 0;
    const before = correction("sign the commits", { taskId: "T1", at: WINDOW.sinceMs - 2 * DAY });
    const after = correction("sign the commits", { taskId: "T2", at: WINDOW.untilMs + DAY });
    const inside = correction("sign the commits", { taskId: "T3" });
    const { deps, src } = setup([before, after, inside, ...padding(9)]);
    const result = await run(deps);
    expect(result).toMatchObject({ corrections: 10, repeats: 1 });
    expect(src.asked[0]).toMatchObject({ since: WINDOW.sinceMs - REPEAT_LOOKBACK_DAYS * DAY, until: WINDOW.untilMs });
  });

  it("a source that returns more than it was asked for is not trusted to filter", async () => {
    n = 0;
    const outside = correction("sign the commits", { taskId: "T1", at: WINDOW.untilMs + 5 * DAY });
    const inside = correction("sign the commits", { taskId: "T2" });
    const greedy: CorrectionSource = { list: async () => ({ corrections: [outside, inside, ...padding(9)], truncated: false }) };
    const store = new InMemoryLessonStore();
    expect(await run({ corrections: greedy, matcher: matcher(), store })).toMatchObject({ corrections: 10, repeats: 0 });
  });
});

describe("the rate", () => {
  it("shows no rate below the minimum number of corrections", async () => {
    n = 0;
    const { deps } = setup([correction("a"), correction("a"), ...padding(METRIC_MIN_CORRECTIONS - 3)]);
    const result = await run(deps);
    expect(result).toMatchObject({ corrections: METRIC_MIN_CORRECTIONS - 1, enoughData: false, rate: null });
  });
  it("shows repeats over corrections from the minimum up, and 0 when nothing repeated", async () => {
    n = 0;
    const { deps } = setup(padding(METRIC_MIN_CORRECTIONS));
    expect(await run(deps)).toMatchObject({ corrections: METRIC_MIN_CORRECTIONS, repeats: 0, rate: 0, enoughData: true });
  });
});

describe("a matcher that fails never flatters the rate", () => {
  it("corrections the matcher cannot rate are unjudged: in neither the count nor the repeats", async () => {
    n = 0;
    const a0 = correction("earlier thing", { taskId: "T0" });
    const a = correction("will fail", { taskId: "T1" });
    const b = correction("fine", { taskId: "T2" });
    const failing = matcher({ sameAsCorrection: async (e, l) => { if (l.text === "will fail") throw new Error("model down"); return e.text === l.text; } });
    const { deps } = setup([a0, a, b, ...padding(8)], { matcher: failing });
    const result = await run(deps);
    expect(result).toMatchObject({ unjudged: 1, corrections: 10, repeats: 0 });
  });
  it("a budget of matcher calls bounds the work: the rest are unjudged and the answer says it was cut short", async () => {
    n = 0;
    const { deps } = setup(padding(30));
    const result = await run(deps, WINDOW, { maxMatcherCalls: 40 });
    expect(result.truncated).toBe(true);
    expect(result.unjudged).toBeGreaterThan(0);
    expect(result.corrections + result.unjudged).toBe(30);
  });
  it("a source or a store that fails fails the whole measurement (no half answer)", async () => {
    n = 0;
    const { deps, store } = setup(padding(10));
    await expect(run({ ...deps, corrections: { list: async () => { throw new Error("table down"); } } })).rejects.toThrow("table down");
    const broken: MetricStore = { listAllHeads: async () => { throw new Error("store down"); }, versions: (k, id) => store.versions(k, id), manifests: (k, id) => store.manifests(k, id) };
    await expect(run({ ...deps, store: broken })).rejects.toThrow("store down");
  });
  it("limits cut the input and say so", async () => {
    n = 0;
    const { deps } = setup(padding(20));
    expect(await run(deps, WINDOW, { maxCorrections: 12 })).toMatchObject({ corrections: 12, truncated: true });
  });
});

describe("read only, and counts only", () => {
  it("calls only listAllHeads, versions and manifests; the store is byte-for-byte the same after; the answer holds no text", async () => {
    n = 0;
    const first = correction("use withRetry for http calls (secret-marker-correction)", { taskId: "T1" });
    const again = correction("use withRetry for http calls (secret-marker-correction)", { taskId: "T2" });
    const { deps, store } = setup([first, again, ...padding(8)]);
    await seed(store, live("les_ro000001", "Use withRetry for http calls (secret-marker-correction) (secret-marker-lesson).", { createdAt: first.at - DAY, updatedAt: first.at - DAY }));
    await loadedFor(store, "T2", entry("les_ro000001"));
    const snapshot = async () => JSON.stringify({ heads: await store.listAllHeads(KEY), versions: await store.versions(KEY, "les_ro000001"), manifests: await store.manifests(KEY, "T2"), flags: await store.flags(KEY), sets: await store.snapshots(KEY) });
    const before = await snapshot();
    const called: string[] = [];
    const watched = new Proxy(store, { get(target, prop, receiver) { const value = Reflect.get(target, prop, receiver) as unknown; if (typeof value === "function" && typeof prop === "string") return (...args: unknown[]) => { called.push(prop); return (value as (...a: unknown[]) => unknown).apply(target, args); }; return value; } });
    const result = await sameMistakeTwice({ ...deps, store: watched }, KEY, WINDOW);
    expect(result.repeats).toBe(2);
    expect([...new Set(called)].sort()).toEqual(["listAllHeads", "manifests", "versions"]);
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
    expect(Object.keys(result).sort()).toEqual(["corrections", "embeddingBudget", "embeddingCalls", "enoughData", "rate", "repeats", "split", "truncated", "unjudged", "window"]);
  });

  it("a bad window is refused", async () => {
    const { deps } = setup([]);
    await expect(run(deps, { sinceMs: NOW, untilMs: NOW })).rejects.toThrow(RangeError);
    await expect(run(deps, { sinceMs: NOW, untilMs: NOW - DAY })).rejects.toThrow(RangeError);
    await expect(run(deps, { sinceMs: Number.NaN, untilMs: NOW })).rejects.toThrow(RangeError);
    await expect(run(deps, { sinceMs: NOW - 500 * DAY, untilMs: NOW })).rejects.toThrow(RangeError);
  });
});
