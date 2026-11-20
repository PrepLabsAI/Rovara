// TE-E0 option A, slice A1: the customer's pipeline as evidence. The settings shape (runtime refusal, never echoed), the words ("Real: reported by your pipeline", "passed on run 2", never a plain
// pass; "Not run: no result from <check> after <time>", never failed), the marked check's own clock (learned expected time, cap, timeout), the honesty rule (a pipeline pass is proof only for a test
// that failed by the same name on the base commit's main run; added tests keep their sandbox label) and what Rovara does about a red marked check (environment, ask, or fix within the cap).
import { describe, expect, it } from "vitest";
import {
  CI_EVIDENCE_ASK_WORDS, CI_EVIDENCE_REAL_LABEL, draftSkipWords, CI_EVIDENCE_SETTINGS_INVALID, DEFAULT_CI_EVIDENCE_SETTINGS, environmentLine, notRunLine, parseCiEvidenceSettings, realCheckLine, waitingCheckLine, waitWords,
  type Check,
} from "@agentx/contracts";
import {
  DURATION_HISTORY_MAX, EXPECTED_WAIT_FLOOR_MS, currentRun, expectedWaitMs, markedCheckState, waitCapMs, withDuration, type MarkedRun,
} from "../../packages/broker/src/core/ci-evidence/marked-checks.js";
import { PIPELINE_PROOF_TESTS_MAX, pipelineProof, type PipelineTestOutcome } from "../../packages/broker/src/core/ci-evidence/change-proof.js";
import { decideMarkedCheck, judgeMarkedFixPush } from "../../packages/broker/src/core/ci-evidence/fix-or-ask.js";
import { DRAFT_SCAN_FILES_MAX, detectDraftSkip, draftVerdictOf } from "../../packages/broker/src/core/ci-evidence/draft-skip.js";
import type { CiDefinitionReader } from "../../packages/broker/src/rovara-code/ci-checks.js";

const MIN = 60_000;
const HEAD = "4f2a9c1".padEnd(40, "0");
const BASE = "b".repeat(40);
const T0 = Date.parse("2026-11-15T10:00:00.000Z");

const check = (over: Partial<Check> = {}): Check => ({ name: "e2e-real", state: "completed", conclusion: "success", required: false, url: "https://github.com/acme/svc/runs/1", ...over });
const run = (over: Partial<Check> = {}, extra: Omit<MarkedRun, "check"> = {}): MarkedRun => ({ check: check(over), ...extra });
const marked = { name: "e2e-real", calledAs: "real model in our account", longOrPaid: true };
const settings = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_CI_EVIDENCE_SETTINGS, markedChecks: [marked], ...over });

describe("CI evidence settings", () => {
  it("reads valid settings and keeps the defaults: nothing marked, 2 h cap, logs off", () => {
    expect(DEFAULT_CI_EVIDENCE_SETTINGS).toEqual({ version: 1, markedChecks: [], waitCapMinutes: 120, perTestReports: true, shareLogs: false });
    const read = parseCiEvidenceSettings(settings());
    expect(read).toEqual({ ok: true, settings: settings() });
  });
  it.each([
    ["unknown field", settings({ extra: 1 })],
    ["unknown version", settings({ version: 2 })],
    ["cap below the floor", settings({ waitCapMinutes: 14 })],
    ["cap above the ceiling", settings({ waitCapMinutes: 1_441 })],
    ["fractional cap", settings({ waitCapMinutes: 30.5 })],
    ["the same check twice", settings({ markedChecks: [marked, { ...marked }] })],
    ["a mark with no words", settings({ markedChecks: [{ ...marked, calledAs: "" }] })],
    ["too many marks", settings({ markedChecks: Array.from({ length: 21 }, (_, index) => ({ ...marked, name: `c${String(index)}` })) })],
    ["a string for a flag", settings({ shareLogs: "yes" })],
    ["not an object", "settings"],
    ["null", null],
  ])("refuses %s with fixed words that never echo the input", (_label, value) => {
    const read = parseCiEvidenceSettings(value);
    expect(read).toEqual({ ok: false, message: CI_EVIDENCE_SETTINGS_INVALID });
    expect(JSON.stringify(read)).not.toContain("settings\"");
  });
  it("allows the same name from two different apps", () => {
    expect(parseCiEvidenceSettings(settings({ markedChecks: [marked, { ...marked, source: "123" }] })).ok).toBe(true);
  });
});

describe("CI evidence words", () => {
  it("says a pass with the run, the commit and the counts, never a plain pass", () => {
    expect(realCheckLine({ calledAs: "real model in our account", check: "e2e-real", outcome: "passed", attempt: 2, commit: HEAD, counts: { passed: 212, failed: 0, skipped: 0 } }))
      .toBe("Real: reported by your pipeline: real model in our account (e2e-real) passed on run 2, commit 4f2a9c1, 212 passed, 0 failed");
    expect(realCheckLine({ calledAs: "x", check: "e2e", outcome: "passed", commit: HEAD })).toBe(`${CI_EVIDENCE_REAL_LABEL}: x (e2e) passed (run number not reported), commit 4f2a9c1, no per-test counts reported`);
    expect(realCheckLine({ calledAs: "x", check: "e2e", outcome: "failed", attempt: 1, commit: HEAD, counts: { passed: 3, failed: 1, skipped: 2 } })).toContain("failed on run 1, commit 4f2a9c1, 3 passed, 1 failed, 2 skipped");
  });
  it.each([0, -1, 1.5, Number.NaN])("never prints a made-up run number (%s)", (attempt) => {
    expect(realCheckLine({ calledAs: "x", check: "e2e", outcome: "passed", attempt, commit: HEAD })).toContain("(run number not reported)");
  });
  it("makes customer and repository words inert, and refuses a bad commit", () => {
    const text = realCheckLine({ calledAs: "@team see [x](https://evil.example) <b>", check: "e2e‮evil\nnext", outcome: "passed", attempt: 1, commit: "not-a-sha" });
    expect(text).not.toMatch(/@team|\]\(|<b>|‮|\n/u);
    expect(text).toContain("commit ?");
  });
  it("says a timeout as not run, never failed", () => {
    expect(notRunLine({ check: "e2e-real", reason: "timed_out", afterMs: 120 * MIN })).toBe("Not run: no result from e2e-real after 2 h");
    expect(notRunLine({ check: "e2e-real", reason: "timed_out", afterMs: 90 * MIN })).toBe("Not run: no result from e2e-real after 1 h 30 min");
    expect(notRunLine({ check: "e2e-real", reason: "skipped" })).toBe("Not run: your pipeline reported e2e-real as skipped");
    expect(notRunLine({ check: "e2e-real", reason: "timed_out", afterMs: 120 * MIN })).not.toMatch(/fail/u);
  });
  it("words the wait and the duration", () => {
    expect(waitingCheckLine({ calledAs: "real model", check: "e2e-real", expectedMs: 40 * MIN })).toBe("Real: reported by your pipeline: waiting for real model (e2e-real), usually 40 min");
    expect([waitWords(30_000), waitWords(59 * MIN), waitWords(60 * MIN), waitWords(Number.NaN), waitWords(-1)]).toEqual(["1 min", "59 min", "1 h", "?", "?"]);
  });
  it("says the environment with a re-run link only when it is a plain https address", () => {
    expect(environmentLine({ check: "e2e-real", reason: "failed_before_tests", rerunUrl: "https://github.com/acme/svc/actions/runs/9" }))
      .toBe("Your environment: e2e-real failed before any test ran, so Rovara is not changing the code for it. Re-run it when it is fixed: https://github.com/acme/svc/actions/runs/9");
    expect(environmentLine({ check: "e2e-real", reason: "red_on_main", baseBranch: "main" })).toBe("Your environment: e2e-real is also failing on main's latest run, so Rovara is not changing the code for it. Re-run it in your pipeline when it is fixed.");
    for (const bad of ["http://x.example/run", "https://user:pw@x.example/run", "javascript:alert(1)", "not a url"]) {
      expect(environmentLine({ check: "c", reason: "red_on_main", rerunUrl: bad })).toContain("Re-run it in your pipeline when it is fixed.");
    }
    expect(environmentLine({ check: "c", reason: "red_on_main", rerunUrl: "https://x.example/run?token=abc#f" })).toContain("https://x.example/run");
    expect(environmentLine({ check: "c", reason: "red_on_main", rerunUrl: "https://x.example/run?token=abc#f" })).not.toContain("token");
  });
  it("has fixed ask words that name the check inertly", () => {
    for (const words of Object.values(CI_EVIDENCE_ASK_WORDS)) expect(words("@x e2e")).not.toMatch(/(^|\s)@x/u);
  });
});

describe("the marked check's clock", () => {
  it("learns from past runs: 90th percentile with a quarter more, at least the floor, never above the cap", () => {
    const durations = [30, 32, 34, 36, 38, 40, 42, 44, 46, 48].map((minutes) => minutes * MIN);
    expect(expectedWaitMs({ durationsMs: durations, capMinutes: 120 })).toBe(Math.ceil(46 * MIN * 1.25));
    expect(expectedWaitMs({ durationsMs: [MIN, MIN, MIN], capMinutes: 120 })).toBe(EXPECTED_WAIT_FLOOR_MS);
    expect(expectedWaitMs({ durationsMs: [200 * MIN, 200 * MIN, 200 * MIN], capMinutes: 120 })).toBe(120 * MIN);
  });
  it("takes the customer's own expected time, still capped", () => {
    expect(expectedWaitMs({ durationsMs: [MIN, MIN, MIN], expectedMinutes: 45, capMinutes: 120 })).toBe(45 * MIN);
    expect(expectedWaitMs({ durationsMs: [], expectedMinutes: 600, capMinutes: 120 })).toBe(120 * MIN);
  });
  it("uses the default cap when the cap is out of range", () => {
    expect(waitCapMs(5)).toBe(120 * MIN);
    expect(waitCapMs(2_000)).toBe(120 * MIN);
    expect(waitCapMs(30)).toBe(30 * MIN);
  });
  it("keeps the newest durations, bounded", () => {
    let history: number[] = [];
    for (let index = 1; index <= 30; index += 1) history = withDuration(history, index * MIN);
    expect(history).toHaveLength(DURATION_HISTORY_MAX);
    expect(history[0]).toBe(11 * MIN);
    expect(withDuration([MIN], Number.NaN)).toEqual([MIN]);
  });
  it("gives a run that has started the whole cap, not the learned time", () => {
    const running = run({ state: "pending", conclusion: undefined });
    expect(markedCheckState({ run: running, waitStart: T0, expectedMs: 40 * MIN, capMs: 120 * MIN, now: T0 + 41 * MIN })).toEqual({ kind: "waiting", until: T0 + 120 * MIN, expectedMs: 40 * MIN });
    expect(markedCheckState({ run: running, waitStart: T0, expectedMs: 40 * MIN, capMs: 120 * MIN, now: T0 + 120 * MIN })).toEqual({ kind: "not_run", reason: "timed_out", afterMs: 120 * MIN });
    expect(markedCheckState({ run: undefined, waitStart: T0, expectedMs: 40 * MIN, capMs: 120 * MIN, now: T0 + 40 * MIN })).toEqual({ kind: "not_run", reason: "timed_out", afterMs: 40 * MIN });
  });
  it("reads pass and failure with their run, and a skip as not run", () => {
    expect(markedCheckState({ run: run({}, { attempt: 2 }), waitStart: T0, expectedMs: MIN, now: T0 })).toMatchObject({ kind: "passed", attempt: 2 });
    expect(markedCheckState({ run: run({ conclusion: "failure" }, { attempt: 1 }), waitStart: T0, expectedMs: MIN, now: T0 })).toMatchObject({ kind: "failed", attempt: 1 });
    expect(markedCheckState({ run: run({ conclusion: "timed_out" }), waitStart: T0, expectedMs: MIN, now: T0 }).kind).toBe("failed");
    expect(markedCheckState({ run: run({ conclusion: "skipped" }), waitStart: T0, expectedMs: MIN, now: T0 })).toEqual({ kind: "not_run", reason: "skipped" });
    expect(markedCheckState({ run: run({ conclusion: "neutral" }), waitStart: T0, expectedMs: MIN, now: T0 })).toEqual({ kind: "not_run", reason: "neutral" });
  });
  it("picks the run that speaks for the head: running first, then the highest attempt, then the latest, and a failure on a tie", () => {
    const first = run({ conclusion: "failure" }, { attempt: 1, completedAt: T0 });
    const second = run({ conclusion: "success" }, { attempt: 2, completedAt: T0 + MIN });
    const rerun = run({ state: "pending", conclusion: undefined });
    expect(currentRun(marked, [first, second])).toBe(second);
    expect(currentRun(marked, [second, first, rerun])).toBe(rerun);
    const later = run({ conclusion: "success" }, { completedAt: T0 + 5 * MIN });
    const earlier = run({ conclusion: "failure" }, { completedAt: T0 });
    expect(currentRun(marked, [earlier, later])).toBe(later);
    const tiePass = run({ conclusion: "success" });
    const tieFail = run({ conclusion: "failure" });
    expect(currentRun(marked, [tiePass, tieFail])).toBe(tieFail);
    expect(currentRun(marked, [run({ name: "other" })])).toBeUndefined();
  });
});

describe("the honesty rule: a pipeline pass is not change proof", () => {
  const tests = (entries: Array<[string, PipelineTestOutcome]>) => new Map(entries);
  it("proves only a test that failed by the same name on the base commit's main run", () => {
    const proof = pipelineProof({
      headCommit: HEAD, head: { commit: HEAD, tests: tests([["a", "passed"], ["b", "passed"], ["c", "passed"], ["d", "failed"], ["e", "skipped"], ["f", "passed"]]) },
      base: { commit: BASE, tests: tests([["a", "failed"], ["b", "passed"], ["d", "failed"], ["f", "skipped"]]) },
      baseCommit: BASE, addedTests: new Set(["c"]),
    });
    expect(proof).toEqual({ proven: ["a"], addedByChange: ["c"], passedNotProof: ["b", "f"], failed: ["d"] });
  });
  it("proves nothing without the base run, or with a base run on another commit", () => {
    const head = { commit: HEAD, tests: tests([["a", "passed"]]) };
    expect(pipelineProof({ headCommit: HEAD, head, base: undefined, baseCommit: BASE, addedTests: new Set() })).toEqual({ proven: [], addedByChange: [], passedNotProof: ["a"], failed: [], noBase: "no_base_run" });
    expect(pipelineProof({ headCommit: HEAD, head, base: { commit: "c".repeat(40), tests: tests([["a", "failed"]]) }, baseCommit: BASE, addedTests: new Set() }))
      .toEqual({ proven: [], addedByChange: [], passedNotProof: ["a"], failed: [], noBase: "base_commit_differs" });
  });
  it("refuses a head report for another commit (an earlier push) whole", () => {
    const proof = pipelineProof({ headCommit: HEAD, head: { commit: "c".repeat(40), tests: tests([["a", "passed"], ["b", "failed"]]) }, base: { commit: BASE, tests: tests([["a", "failed"]]) }, baseCommit: BASE, addedTests: new Set() });
    expect(proof).toEqual({ proven: [], addedByChange: [], passedNotProof: [], failed: [], noBase: "head_commit_differs" });
  });
  it("refuses an oversized run whole instead of cutting it, in bounded time", () => {
    const big = new Map(Array.from({ length: PIPELINE_PROOF_TESTS_MAX + 1 }, (_, index) => [`t${String(index)}`, "passed" as const]));
    const started = performance.now();
    const proof = pipelineProof({ headCommit: HEAD, head: { commit: HEAD, tests: big }, base: { commit: BASE, tests: new Map([["t1", "failed"]]) }, baseCommit: BASE, addedTests: new Set() });
    expect(proof).toEqual({ proven: [], addedByChange: [], passedNotProof: [], failed: [], noBase: "report_too_large" });
    const baseBig = new Map(Array.from({ length: PIPELINE_PROOF_TESTS_MAX + 1 }, (_, index) => [`t${String(index)}`, "failed" as const]));
    expect(pipelineProof({ headCommit: HEAD, head: { commit: HEAD, tests: new Map([["t1", "passed"]]) }, base: { commit: BASE, tests: baseBig }, baseCommit: BASE, addedTests: new Set() })).toEqual({ proven: [], addedByChange: [], passedNotProof: ["t1"], failed: [], noBase: "report_too_large" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("environment, ask or fix", () => {
  const failed = markedCheckState({ run: run({ conclusion: "failure" }, { attempt: 1 }), waitStart: T0, expectedMs: MIN, now: T0 });
  const base = { state: failed, longOrPaid: true, testsRan: 12, testsFailed: 1, logShared: false, mainRun: "passed" as const, roundsUsed: 0, roundsMax: 3 };
  it("does nothing on a pass, waits while waiting, and leaves a skip alone", () => {
    expect(decideMarkedCheck({ ...base, state: markedCheckState({ run: run(), waitStart: T0, expectedMs: MIN, now: T0 }) })).toEqual({ kind: "none" });
    expect(decideMarkedCheck({ ...base, state: { kind: "waiting", until: T0, expectedMs: MIN } })).toEqual({ kind: "wait" });
    expect(decideMarkedCheck({ ...base, state: { kind: "not_run", reason: "skipped" } })).toEqual({ kind: "ask", reason: "skipped" });
    expect(decideMarkedCheck({ ...base, state: { kind: "not_run", reason: "neutral" } })).toEqual({ kind: "ask", reason: "skipped" });
  });
  it("calls a run that failed before any test ran the environment, even when main is green", () => {
    expect(decideMarkedCheck({ ...base, testsRan: 0 })).toEqual({ kind: "environment", reason: "failed_before_tests" });
  });
  it.each([[Number.NaN, 3], [-1, 3], [1.5, 3], [0, Number.NaN], [0, 0], [0, Number.POSITIVE_INFINITY]])("never opens an uncapped round on counts that are not counts (%s used of %s)", (roundsUsed, roundsMax) => {
    expect(decideMarkedCheck({ ...base, roundsUsed, roundsMax })).toEqual({ kind: "ask", reason: "cap_reached" });
  });
  it("keeps today's cap for a normal marked check, and never more than the normal cap", () => {
    expect(decideMarkedCheck({ ...base, longOrPaid: false, roundsUsed: 2 })).toEqual({ kind: "fix", roundsMax: 3, fullSandboxPassFirst: false });
    expect(decideMarkedCheck({ ...base, longOrPaid: false, roundsUsed: 3 })).toEqual({ kind: "ask", reason: "cap_reached" });
    expect(decideMarkedCheck({ ...base, roundsMax: 1, roundsUsed: 1 })).toEqual({ kind: "ask", reason: "cap_reached" });
  });
  it("never pushes a fix that weakens a test, and holds a long check's fix until the full sandbox passed", () => {
    expect(judgeMarkedFixPush({ weakensTest: true, fullSandboxPassFirst: false, fullSandboxPassed: true })).toEqual({ kind: "ask", reason: "weakens_test" });
    expect(judgeMarkedFixPush({ weakensTest: false, fullSandboxPassFirst: true, fullSandboxPassed: false })).toEqual({ kind: "hold", reason: "sandbox_not_passed" });
    expect(judgeMarkedFixPush({ weakensTest: false, fullSandboxPassFirst: true, fullSandboxPassed: true })).toEqual({ kind: "push" });
    expect(judgeMarkedFixPush({ weakensTest: false, fullSandboxPassFirst: false, fullSandboxPassed: false })).toEqual({ kind: "push" });
  });
});

describe("does the customer's CI skip drafts", () => {
  const reader = (files: Record<string, string>, options: { truncated?: boolean; tooLarge?: string[]; throws?: boolean } = {}): CiDefinitionReader => ({
    list: async (path) => {
      if (options.throws === true) throw new Error("host down");
      if (path !== ".github/workflows") return undefined;
      return { entries: Object.keys(files).map((name) => ({ name, path: `.github/workflows/${name}`, type: "file" })), truncated: options.truncated === true };
    },
    read: async (path) => {
      const name = path.slice(".github/workflows/".length);
      if (options.tooLarge?.includes(name) === true) return { tooLarge: true };
      return files[name] === undefined ? undefined : { text: files[name] };
    },
  });
  const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  it("finds a job condition on the draft flag", async () => {
    expect(DEFAULT_CI_EVIDENCE_SETTINGS.markedChecks).toEqual([]);
    expect(() => (DEFAULT_CI_EVIDENCE_SETTINGS.markedChecks as unknown as unknown[]).push(1)).toThrow();
    const skips = `on: pull_request\njobs:\n  test:\n    if: github.event.pull_request.draft == false\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
    expect(await detectDraftSkip(reader({ "ci.yml": skips, "lint.yml": `on: [push, pull_request]\n${job}` }))).toEqual({ verdict: "skips_drafts", workflows: [".github/workflows/ci.yml"] });
    expect(draftVerdictOf(`on: pull_request\njobs:\n  t:\n    if: \${{ !github.event.pull_request['draft'] }}\n    steps: []\n`)).toBe("unknown");
  });
  it("reads each job's own condition, never a comment, and can't tell on a mix or an unknown spelling", () => {
    const head = "on: pull_request\njobs:\n";
    const jobWith = (name: string, condition?: string) => `  ${name}:\n${condition === undefined ? "" : `    if: ${condition}\n`}    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
    expect(draftVerdictOf(`# skip when github.event.pull_request.draft\n${head}${jobWith("t")}`)).toBe("runs");
    expect(draftVerdictOf(`${head}${jobWith("lint", "github.event.pull_request.draft == false")}${jobWith("e2e")}`)).toBe("unknown");
    expect(draftVerdictOf(`${head}${jobWith("t", "github.event.pull_request.draft == true")}`)).toBe("unknown");
    expect(draftVerdictOf(`${head}${jobWith("t", "github.event['pull_request']['draft'] == false")}`)).toBe("unknown");
    expect(draftVerdictOf(`${head}${jobWith("t", "\"github.event_name == 'push' || !github.event.pull_request.draft\"")}`)).toBe("unknown");
    expect(draftVerdictOf(`${head}${jobWith("t", "github.repository == 'a/b' && !github.event.pull_request.draft")}`)).toBe("skips");
    expect(draftVerdictOf(`${head}${jobWith("a", "${{ github.event.pull_request.draft != true }}")}${jobWith("b", "'!github.event.pull_request.draft'")}`)).toBe("skips");
    expect(draftVerdictOf(`${head}${jobWith("t", "github.repository == 'a/b'")}`)).toBe("runs");
    for (const condition of ["github.actor == 'bot' || github.repository == 'a/b' && !github.event.pull_request.draft", "!github.event.pull_request.draft && github.ref != '' || always()",
      "github.event.pull_request.draft == false && !cancelled() || failure()", "(!github.event.pull_request.draft", "github.event.pull_request.draft == false && github.ref == 'x"]) {
      expect(draftVerdictOf(`${head}${jobWith("t", JSON.stringify(condition))}`)).toBe("unknown");
    }
    expect(draftVerdictOf(`${head}${jobWith("t", JSON.stringify("github.ref == 'a&&b||c' && !github.event.pull_request.draft"))}`)).toBe("skips");
    expect(draftVerdictOf(`${head}${jobWith("t", "\"!github.event.pull_request.draft && (github.actor == 'a' || github.actor == 'b')\"")}`)).toBe("skips");
    expect(draftVerdictOf(`${head}${jobWith("t", "${{ github.event.pull_request.draft == false }} && ${{ true }}")}`)).toBe("unknown");
    expect(draftVerdictOf(`on:\n  pull_request:\n    types: []\n${head.slice(17)}${jobWith("t")}`)).toBe("unknown");
  });
  it("finds a trigger that runs only when a draft is marked ready", async () => {
    expect(draftVerdictOf(`on:\n  pull_request:\n    types: [ready_for_review]\n${job}`)).toBe("skips");
    expect(draftVerdictOf(`on:\n  pull_request:\n    types: [opened, synchronize, ready_for_review]\n${job}`)).toBe("runs");
    expect(draftVerdictOf(`on:\n  pull_request:\n    types: ready_for_review\n${job}`)).toBe("skips");
  });
  it("says runs on drafts only when every file was read and a pull request workflow runs", async () => {
    expect(await detectDraftSkip(reader({ "ci.yml": `on: pull_request\n${job}`, "release.yml": `on: push\n${job}` }))).toEqual({ verdict: "runs_on_drafts" });
    expect(await detectDraftSkip(reader({ "release.yml": `on: push\n${job}` }))).toEqual({ verdict: "unknown" });
  });
  it.each([
    ["a file it cannot parse", { "ci.yml": `on: pull_request\n${job}`, "bad.yml": "on: [unclosed\n" }, {}],
    ["a trigger shape it does not know", { "ci.yml": `on:\n  pull_request: 5\n${job}` }, {}],
    ["types it does not know", { "ci.yml": `on:\n  pull_request:\n    types: [{ a: 1 }]\n${job}` }, {}],
    ["no jobs", { "ci.yml": "on: pull_request\n" }, {}],
    ["a truncated listing", { "ci.yml": `on: pull_request\n${job}` }, { truncated: true }],
    ["a file too large", { "ci.yml": `on: pull_request\n${job}`, "big.yml": "x" }, { tooLarge: ["big.yml"] }],
    ["a host that fails", { "ci.yml": `on: pull_request\n${job}` }, { throws: true }],
    ["no workflows", {}, {}],
  ])("can't tell on %s, for the whole repository", async (_label, files, options) => {
    expect(await detectDraftSkip(reader(files as Record<string, string>, options))).toEqual({ verdict: "unknown" });
  });
  it("can't tell with too many files or too many bytes in all", async () => {
    const many = Object.fromEntries(Array.from({ length: DRAFT_SCAN_FILES_MAX + 1 }, (_, index) => [`w${String(index).padStart(2, "0")}.yml`, `on: pull_request\n${job}`]));
    expect(await detectDraftSkip(reader(many))).toEqual({ verdict: "unknown" });
    const padding = `# ${"x".repeat(60_000)}\n`;
    const heavy = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`w${String(index)}.yml`, `${padding}on: pull_request\n${job}`]));
    expect(await detectDraftSkip(reader(heavy))).toEqual({ verdict: "unknown" });
  });
  it("tells the customer in fixed words, naming files inertly", () => {
    expect(draftSkipWords({ verdict: "skips_drafts", workflows: [".github/workflows/ci.yml"] })).toBe("Your CI skips draft pull requests (ci.yml). Rovara opens drafts first, so your checks would not run until a person marks the pull request ready. Let them run on drafts, or expect \"Not run\" on the checks you mark.");
    expect(draftSkipWords({ verdict: "skips_drafts", workflows: [".github/workflows/@x.yml", "a", "b", "c"] })).toMatch(/and 1 more/u);
    expect(draftSkipWords({ verdict: "skips_drafts", workflows: [".github/workflows/@x.yml"] })).not.toMatch(/(^|[\s(])@x/u);
    expect(draftSkipWords({ verdict: "unknown" })).toMatch(/could not tell/u);
  });
});
