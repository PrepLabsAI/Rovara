// Lessons replay (DECISIONS 49): what the replay report says, and what it refuses to say. Pure functions over run rows: no AWS, no model.
import { describe, expect, it } from "vitest";
import {
  GraderMismatchError, LOADED_DIFFERENCE_NEARLY_SAME, REPLAY_REPEATS, blindSheet, buildMeasureReport, importMarks, loadedLessonDifference, readReplayRunRows, renderMeasureReport, wilsonInterval,
  type ReplayRunRow,
} from "@agentx/contracts";

const GRADER = { model: "grader-model", version: "2026-11-01" };
let n = 0;
const run = (task: string, arm: string, resolved: boolean | null, extra: Partial<ReplayRunRow> = {}): ReplayRunRow => ({
  task, repeat: 1, arm, resolved, grader: resolved === null ? null : GRADER, gradedBy: resolved === null ? null : "hidden_tests", loaded: [], mistakes: [], costUsd: 0.5 + (n++ % 3) * 0.01, ...extra,
});

describe("Wilson interval (known values)", () => {
  it("matches the textbook numbers at 95%", () => {
    const close = (got: { low: number; high: number }, low: number, high: number): void => { expect(got.low).toBeCloseTo(low, 3); expect(got.high).toBeCloseTo(high, 3); };
    close(wilsonInterval(8, 10), 0.4902, 0.9433);
    close(wilsonInterval(0, 10), 0, 0.2775);
    close(wilsonInterval(10, 10), 0.7225, 1);
    close(wilsonInterval(5, 10), 0.2366, 0.7634);
    close(wilsonInterval(50, 100), 0.4038, 0.5962);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("reading run rows", () => {
  it("reads old two-arm rows (arm on/off, no grader, no loaded list) and new rows", () => {
    const rows = readReplayRunRows([{ task: "a", arm: "on", resolved: true }, { task: "a", arm: "off", resolved: false, repeat: 2 }, { task: "b", arm: "on:current", resolved: null, repeat: 1, grader: null, gradedBy: null, loaded: ["k1"], mistakes: ["c1"], costUsd: 1.25 }]);
    expect(rows.map((r) => r.arm)).toEqual(["on:legacy", "off", "on:current"]);
    expect(rows[0]).toMatchObject({ repeat: 1, grader: null, loaded: [], mistakes: [], costUsd: null });
    expect(rows[2]).toMatchObject({ loaded: ["k1"], mistakes: ["c1"], costUsd: 1.25 });
  });
  it("refuses an ungraded row that names a grader, and anything malformed", () => {
    expect(() => readReplayRunRows([{ task: "a", arm: "off", resolved: null, repeat: 1, grader: GRADER, gradedBy: "rubric" }])).toThrow();
    expect(() => readReplayRunRows([{ task: "a", arm: "off", resolved: true, repeat: 0 }])).toThrow();
    expect(() => readReplayRunRows([{ task: "a", arm: "off", resolved: true, extra: 1 }])).toThrow();
    expect(() => readReplayRunRows({})).toThrow();
  });
});

describe("the grader is fixed", () => {
  const base = (): ReplayRunRow[] => [run("a", "off", true), run("a", "on:current", false), run("a", "on:consolidated", true)];
  const input = (rows: ReplayRunRow[]) => ({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 10, learning: [], lessonSets: [] });
  it("runs graded by different graders are refused, with the graders named", () => {
    const rows = base();
    rows[1] = { ...rows[1]!, grader: { model: "other-model", version: "2026-11-01" } };
    expect(() => buildMeasureReport(input(rows))).toThrow(GraderMismatchError);
    expect(() => buildMeasureReport(input(rows))).toThrow(/grader-model/);
    const version = base();
    version[2] = { ...version[2]!, grader: { model: "grader-model", version: "2026-11-02" } };
    expect(() => buildMeasureReport(input(version))).toThrow(GraderMismatchError);
  });
  it("a task graded by tests in one arm and by a rubric in another is refused", () => {
    const rows = base();
    rows[1] = { ...rows[1]!, gradedBy: "rubric" };
    expect(() => buildMeasureReport(input(rows))).toThrow(GraderMismatchError);
  });
  it("old rows graded by an unknown grader read fine alone, but never next to rows with a named grader", () => {
    const legacy = readReplayRunRows([{ task: "a", arm: "off", resolved: true }, { task: "a", arm: "on", resolved: false }]);
    expect(buildMeasureReport(input(legacy)).grader).toBeNull();
    expect(() => buildMeasureReport(input([...legacy, run("b", "off", true)]))).toThrow(GraderMismatchError);
  });
  it("ungraded runs carry no grader and do not count as a mismatch", () => {
    const rows = [...base(), run("b", "off", null)];
    expect(() => buildMeasureReport(input(rows))).not.toThrow();
  });
  it("the report names the one grader every run used", () => {
    const report = buildMeasureReport(input(base()));
    expect(report.grader).toEqual(GRADER);
  });
});

describe("loaded-lesson difference between B and C", () => {
  const loads = (arm: string, task: string, keys: string[]): ReplayRunRow => run(task, arm, true, { loaded: keys });
  it("is the share of (task, lesson) loads that only one arm made", () => {
    const rows = [
      loads("on:current", "t1", ["a", "b", "c"]), loads("on:consolidated", "t1", ["a", "b", "x"]),
      loads("on:current", "t2", ["d"]), loads("on:consolidated", "t2", ["d"]),
    ];
    const d = loadedLessonDifference(rows, "on:current", "on:consolidated");
    expect(d).toMatchObject({ identical: 3, onlyA: 1, onlyB: 1, tasksCompared: 2 });
    expect(d.differ).toBeCloseTo(2 / 5, 6);
    expect(d.nearlySame).toBe(false);
    expect(d.nothingLoaded).toBe(false);
  });
  it("takes the union over a task's repeats, so a lesson loaded in any repeat counts once", () => {
    const rows = [
      { ...loads("on:current", "t1", ["a"]), repeat: 1 }, { ...loads("on:current", "t1", ["a", "b"]), repeat: 2 },
      { ...loads("on:consolidated", "t1", ["a", "b"]), repeat: 1 }, { ...loads("on:consolidated", "t1", ["a"]), repeat: 2 },
    ];
    expect(loadedLessonDifference(rows, "on:current", "on:consolidated")).toMatchObject({ identical: 2, onlyA: 0, onlyB: 0, differ: 0 });
  });
  it("'nearly the same' means fewer than 10% of the loads differ, and the line is exported", () => {
    expect(LOADED_DIFFERENCE_NEARLY_SAME).toBe(0.1);
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const nearly = [loads("on:current", "t", keys), loads("on:consolidated", "t", [...keys.slice(0, 19), "z"])]; // 2 of 21 differ = 9.5%
    expect(loadedLessonDifference(nearly, "on:current", "on:consolidated").nearlySame).toBe(true);
    const enough = [loads("on:current", "t", keys), loads("on:consolidated", "t", [...keys.slice(0, 18), "y", "z"])]; // 4 of 22 differ = 18%
    expect(loadedLessonDifference(enough, "on:current", "on:consolidated").nearlySame).toBe(false);
    const exactlyTen = [loads("on:current", "t", Array.from({ length: 10 }, (_, i) => `k${i}`)), loads("on:consolidated", "t", Array.from({ length: 9 }, (_, i) => `k${i}`))]; // 1 of 10
    expect(loadedLessonDifference(exactlyTen, "on:current", "on:consolidated")).toMatchObject({ nearlySame: false });
  });
  it("two arms that loaded nothing say nothing about the pipelines: that is also a stop", () => {
    const d = loadedLessonDifference([loads("on:current", "t", []), loads("on:consolidated", "t", [])], "on:current", "on:consolidated");
    expect(d).toMatchObject({ nothingLoaded: true, nearlySame: true, differ: null });
  });
  it("only tasks that both arms ran are compared", () => {
    const d = loadedLessonDifference([loads("on:current", "t1", ["a"]), loads("on:consolidated", "t1", ["a"]), loads("on:current", "t2", ["q"])], "on:current", "on:consolidated");
    expect(d.tasksCompared).toBe(1);
    expect(d.differ).toBe(0);
  });
  it("only runs completed in BOTH arms are compared: an arm whose runs all failed did not run, and that is a STOP, not a pass", () => {
    const rows: ReplayRunRow[] = [];
    for (let t = 0; t < 40; t += 1) for (let r = 1; r <= 3; r += 1) {
      rows.push({ ...run(`t${String(t)}`, "on:current", true, { loaded: ["k1", "k2"] }), repeat: r });
      rows.push({ ...run(`t${String(t)}`, "on:consolidated", null, { loaded: [] }), repeat: r });
    }
    const d = loadedLessonDifference(rows, "on:current", "on:consolidated");
    expect(d).toMatchObject({ comparable: false, armDidNotRun: "on:consolidated", nearlySame: true });
    const report = buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 20, learning: [], lessonSets: [] });
    expect(report.stopped).toBe(true);
    expect(report.results).toBeUndefined();
    expect(renderMeasureReport(report)).toMatch(/STOP: on:consolidated did not run/);
  });
  it("an arm that loaded nothing on more than half of its completed runs is a STOP; ungraded runs are left out of the comparison", () => {
    const rows: ReplayRunRow[] = [];
    for (let t = 0; t < 10; t += 1) {
      rows.push(run(`t${String(t)}`, "on:current", true, { loaded: [`a${String(t)}`] }));
      rows.push(run(`t${String(t)}`, "on:consolidated", true, { loaded: t < 4 ? [`b${String(t)}`] : [] }));
    }
    const d = loadedLessonDifference(rows, "on:current", "on:consolidated");
    expect(d).toMatchObject({ comparable: true, completedPairs: 10, loadedRunsA: 10, loadedRunsB: 4, armLoadedNothing: "on:consolidated", nearlySame: true });
    // Four runs ungraded in the empty arm: they are not part of the comparison, and the six that completed loaded lessons in four of them.
    const some = rows.map((r, i) => (r.arm === "on:consolidated" && i >= 12 ? { ...r, resolved: null, grader: null, gradedBy: null } : r));
    expect(loadedLessonDifference(some, "on:current", "on:consolidated")).toMatchObject({ completedPairs: 6, plannedPairs: 10, ungradedB: 4, ungradedA: 0, loadedRunsB: 4, nearlySame: false });
    expect(renderMeasureReport(buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning: [], lessonSets: [] }))).toMatch(/STOP: on:consolidated loaded no lesson on more than half/);
  });
  it("the report states every override in force for each arm, even when it stops, and counts the citations that could not be verified", () => {
    const rows: ReplayRunRow[] = [];
    for (let t = 0; t < 10; t += 1) { rows.push(run(`t${String(t)}`, "on:current", true, { loaded: ["k1"] })); rows.push(run(`t${String(t)}`, "on:consolidated", true, { loaded: ["k1"] })); }
    const learning = [{ arm: "on:current", usd: 1, calls: 4, proposed: 9, needsPerson: 7, unverified: 3, truncated: 0, droppedCalls: 1, overrides: ["no embedder: similar lessons are not merged", "the lessons switch is assumed on"] }, { arm: "on:consolidated", usd: 1, calls: 4 }];
    const stopped = buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning, lessonSets: [] });
    expect(stopped.stopped).toBe(true);
    const text = renderMeasureReport(stopped);
    expect(text).toMatch(/Overrides in force.*\n.*on:current: no embedder: similar lessons are not merged; the lessons switch is assumed on/u);
    const full = renderMeasureReport(buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning, lessonSets: [], continueAnyway: true }));
    expect(full).toMatch(/3 had a citation that could not be verified/u);
    expect(JSON.stringify(buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning, lessonSets: [], continueAnyway: true }))).toContain('"unverified":3');
  });
  it("the STOP floor: fewer than half of the planned pairs completed in both arms is a STOP that says how many, and an arm's stalls are its own outcome (neither a pass nor a miss)", () => {
    const rows: ReplayRunRow[] = [];
    // 40 planned pairs; B completed all, C only 1 (the rest stalled): one completed pair is not a comparison.
    for (let t = 0; t < 40; t += 1) {
      rows.push(run(`t${String(t)}`, "on:current", true, { loaded: ["k1"] }));
      rows.push(t === 0 ? run(`t${String(t)}`, "on:consolidated", false, { loaded: ["k2"] }) : { ...run(`t${String(t)}`, "on:consolidated", true, { loaded: [] }), resolved: null, grader: null, gradedBy: null });
    }
    const d = loadedLessonDifference(rows, "on:current", "on:consolidated");
    expect(d).toMatchObject({ completedPairs: 1, plannedPairs: 40, ungradedB: 39, ungradedA: 0, thinPairs: true, nearlySame: true });
    const text = renderMeasureReport(buildMeasureReport({ rows, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning: [], lessonSets: [] }));
    expect(text).toMatch(/STOP: only 1 of 40 planned runs completed in both arms \(ungraded: on:current 0, on:consolidated 39\)/);
    // Exactly half is enough to report.
    const half = rows.map((r, i) => (r.arm === "on:consolidated" && i < 40 ? { ...r, resolved: true, grader: { model: "grader-model", version: "2026-11-01" }, gradedBy: "hidden_tests" as const, loaded: ["k2"] } : r));
    expect(loadedLessonDifference(half, "on:current", "on:consolidated")).toMatchObject({ completedPairs: 20, plannedPairs: 40, nearlySame: false });
    const shown = renderMeasureReport(buildMeasureReport({ rows: half, compare: { b: "on:current", c: "on:consolidated" }, projectDays: 5, learning: [], lessonSets: [] }));
    expect(shown).toMatch(/Runs by outcome/);
    expect(shown).toMatch(/on:consolidated: 40 runs, 20 graded, 20 ungraded/);
  });
  it("an arm that is absent from the rows is reported as not comparable, not as a stop", () => {
    const d = loadedLessonDifference([loads("on:current", "t1", ["a"])], "on:current", "on:consolidated");
    expect(d).toMatchObject({ comparable: false, nearlySame: false });
  });
});

describe("the report", () => {
  const keys = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const rowsFor = (differ: boolean): ReplayRunRow[] => {
    const out: ReplayRunRow[] = [];
    for (let t = 0; t < 4; t += 1) {
      for (let repeat = 1; repeat <= REPLAY_REPEATS; repeat += 1) {
        out.push(run(`t${t}`, "off", t === 0, { repeat }));
        out.push(run(`t${t}`, "on:current", t <= 2, { repeat, loaded: keys("b", 5), mistakes: t === 3 ? ["corr-1"] : [] }));
        out.push(run(`t${t}`, "on:consolidated", t <= 1, { repeat, loaded: differ ? keys("c", 5) : keys("b", 5), mistakes: t >= 2 ? ["corr-1", "corr-2"] : [] }));
      }
    }
    return out;
  };
  const common = { compare: { b: "on:current", c: "on:consolidated" }, projectDays: 20,
    learning: [{ arm: "off", usd: 0, calls: 0 }, { arm: "on:current", usd: 10, calls: 200 }, { arm: "on:consolidated", usd: 6, calls: 90 }],
    lessonSets: [{ arm: "on:current", size: 12, duplicates: 3, contradictions: 1 }, { arm: "on:consolidated", size: 8, duplicates: 0, contradictions: 0 }] };

  it("starts with the loaded-lesson difference; when the arms loaded nearly the same lessons it stops there and prints the line", () => {
    const report = buildMeasureReport({ ...common, rows: rowsFor(false) });
    expect(report.stopped).toBe(true);
    expect(report.results).toBeUndefined();
    const text = renderMeasureReport(report);
    expect(text).toMatch(/STOP/);
    expect(text).toMatch(/fewer than 10%/);
    expect(text).not.toMatch(/Pass rate/);
    expect(text.indexOf("STOP")).toBeGreaterThan(-1);
    // `--continue-anyway`: the rest is printed after the stop line, never instead of it.
    const forced = buildMeasureReport({ ...common, rows: rowsFor(false), continueAnyway: true });
    expect(forced.stopped).toBe(true);
    expect(forced.results).toBeDefined();
    const forcedText = renderMeasureReport(forced);
    expect(forcedText.indexOf("STOP")).toBeLessThan(forcedText.indexOf("Pass rate"));
  });

  it("when the arms loaded different lessons it reports pass rates with Wilson intervals, discordant tasks, same mistakes, cost per project-day and lesson-set size", () => {
    const report = buildMeasureReport({ ...common, rows: rowsFor(true) });
    expect(report.stopped).toBe(false);
    const results = report.results!;
    const current = results.arms.find((a) => a.arm === "on:current")!;
    expect(current).toMatchObject({ runs: 12, resolved: 9, rate: 0.75, tasks: { tasks: 4, solved: 3, rate: 0.75 } });
    // By task there are 4 observations, not 12: the interval is wider.
    expect(current.tasks.high - current.tasks.low).toBeGreaterThan(current.high - current.low);
    expect(current.low).toBeCloseTo(wilsonInterval(9, 12).low, 9);
    expect(current.high).toBeCloseTo(wilsonInterval(9, 12).high, 9);
    expect(results.discordant.find((d) => d.a === "on:consolidated" && d.b === "on:current")).toMatchObject({ onlyB: ["t2"] });
    expect(results.sameMistakes.find((m) => m.arm === "on:current")).toMatchObject({ runsWithRepeat: 3, repeats: 3 });
    expect(results.sameMistakes.find((m) => m.arm === "on:consolidated")).toMatchObject({ runsWithRepeat: 6, repeats: 12 });
    expect(results.sameMistakes.find((m) => m.arm === "off")).toMatchObject({ runsWithRepeat: 0, repeats: 0 });
    expect(results.learningCost.find((c) => c.arm === "on:current")).toMatchObject({ usd: 10, projectDays: 20, perProjectDay: 0.5 });
    expect(results.learningCost.find((c) => c.arm === "off")).toMatchObject({ perProjectDay: 0 });
    expect(results.lessonSets).toHaveLength(2);
    const text = renderMeasureReport(report);
    expect(text).toMatch(/Pass rate/);
    expect(text).toMatch(/95% interval/);
    expect(text).toMatch(/only on:current solved/i);
    expect(text).toMatch(/Same mistake/i);
    expect(text).toMatch(/per project-day/);
    expect(text).toMatch(/duplicates/);
  });

  it("gives NO verdict, winner, recommendation or pass/fail line, in the words or in the JSON", () => {
    for (const differ of [true, false]) {
      const report = buildMeasureReport({ ...common, rows: rowsFor(differ), continueAnyway: true });
      const text = renderMeasureReport(report);
      const json = JSON.stringify(report);
      for (const forbidden of [/verdict/i, /winner/i, /recommend/i, /pass\/fail/i, /clearly worse/i, /\bbetter\b/i, /\bworse\b/i, /\bwins?\b/i, /should (switch|move|keep)/i]) {
        expect(text, String(forbidden)).not.toMatch(forbidden);
        expect(json, String(forbidden)).not.toMatch(forbidden);
      }
      expect(text).toMatch(/The owner decides/);
      const keysSeen = new Set<string>();
      const walk = (value: unknown): void => { if (Array.isArray(value)) value.forEach(walk); else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { keysSeen.add(k); walk(v); } };
      walk(report);
      for (const key of keysSeen) expect(key, key).not.toMatch(/verdict|winner|recommend|decision|passed|failed|ok$/i);
    }
  });

  it("says the run-to-run luck: the sizes are small and the intervals are wide", () => {
    const text = renderMeasureReport(buildMeasureReport({ ...common, rows: rowsFor(true) }));
    expect(text).toMatch(/sanity check/i);
    expect(text).toMatch(/not proof/i);
  });

  it("names the learning-call setting the replay was run under (decision 47)", () => {
    const text = renderMeasureReport(buildMeasureReport({ ...common, rows: rowsFor(true), learningCalls: { lessonsSwitch: "off", replayLearningCalls: 0, snapshotBuilds: "explicit" } }));
    expect(text).toMatch(/lessons switch: off/i);
    expect(text).toMatch(/replays made 0 learning calls/i);
  });
});

describe("the blind reviewer sheet", () => {
  const lessons = [
    { arm: "on:current", title: "Use pnpm", body: "Use pnpm, not npm." },
    { arm: "on:consolidated", title: "Use pnpm", body: "Use pnpm, not npm." },
    { arm: "on:current", title: "Run lint first", body: "Run lint before the tests." },
    { arm: "on:consolidated", title: "Keep handlers thin", body: "Move logic out of route handlers." },
  ];
  it("lists each distinct lesson once under an opaque id and shows no arm, pipeline or order that gives one away", () => {
    const { sheet, key } = blindSheet(lessons, "seed-1");
    expect(sheet.items).toHaveLength(3);
    const shown = JSON.stringify(sheet);
    for (const word of ["on:current", "on:consolidated", "current", "consolidated", "arm", "pipeline"]) expect(shown, word).not.toContain(word);
    expect(new Set(sheet.items.map((i) => i.id)).size).toBe(3);
    expect(Object.keys(key).sort()).toEqual(sheet.items.map((i) => i.id).sort());
    const pnpm = sheet.items.find((i) => i.title === "Use pnpm")!;
    expect(key[pnpm.id]!.arms.sort()).toEqual(["on:consolidated", "on:current"]);
  });
  it("is the same for the same seed and the same lessons in any order, and reorders for another seed", () => {
    const a = blindSheet(lessons, "seed-1");
    const b = blindSheet([...lessons].reverse(), "seed-1");
    expect(b.sheet).toEqual(a.sheet);
    expect(b.key).toEqual(a.key);
    const orders = new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => blindSheet(lessons, s).sheet.items.map((i) => i.title).join("|")));
    expect(orders.size).toBeGreaterThan(1);
  });
  it("marks come back per arm: a lesson in both arms counts for both", () => {
    const { sheet, key } = blindSheet(lessons, "seed-1");
    const idOf = (title: string): string => sheet.items.find((i) => i.title === title)!.id;
    const marks = importMarks(key, [{ id: idOf("Use pnpm"), useful: true }, { id: idOf("Run lint first"), useful: false }, { id: idOf("Keep handlers thin"), useful: null }]);
    expect(marks.find((m) => m.arm === "on:current")).toMatchObject({ size: 2, marked: 2, useful: 1 });
    expect(marks.find((m) => m.arm === "on:consolidated")).toMatchObject({ size: 2, marked: 1, useful: 1 });
  });
  it("a mark for an id that is not on the sheet, a repeated id, or a mark that is not true/false/null is refused", () => {
    const { sheet, key } = blindSheet(lessons, "seed-1");
    const id = sheet.items[0]!.id;
    expect(() => importMarks(key, [{ id: "R999", useful: true }])).toThrow();
    expect(() => importMarks(key, [{ id, useful: true }, { id, useful: false }])).toThrow();
    expect(() => importMarks(key, [{ id, useful: "yes" as never }])).toThrow();
  });
});
