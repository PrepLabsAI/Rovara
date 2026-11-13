// Per-test labels for faked and recorded answers: the state a test result has when something other than the real service answered the dependency it called, and the words a pull request carries for it.
// Why: evidence that names a faked answer per DEPENDENCY ("SageMaker endpoint X: answered by recorded fixtures") does not say which passing TESTS depended on it, and one green tick for a whole run hides that a value
// the test asserted on was never real model output. So a test that passed against a faked or recorded answer is reported in its own state, apart from "passed", and a test that could not run because nothing answered
// its dependency is reported "not run", by name, with the reason. Nothing here is specific to SageMaker: any backing that fakes or replays (Bedrock, an HTTP service, ...) fills the same records.
//
// The contract, and who fills it:
//   - `TestAnswerRecord` is one test's record: its id, how it ended, which dependencies answered it with a faked or a recorded answer, or, for a test that was not run, which dependency had no answer.
//   - The WORKER fills it (a Cloud lane, not in this repository). For each test it takes the test runner's id and window, and the ledger of the fake that answered during that window (for SageMaker, the front's
//     request ledger, which counts calls per endpoint and marks each as recorded, hand-written or unmatched). It writes one record per test and nothing else about a request: no body, no header, no value.
//   - The BROKER reads the records, never the worker's words for them: `testResultState` and `testAnswerSummaryLines` turn records into the state and the pull request lines.
//   - For SageMaker the front marks a call that found no answer for its endpoint (no recording, no approved fixture) in its request ledger: `SAGEMAKER_NO_ANSWER_MARKER`, matched by its prefix
//     `SAGEMAKER_NO_ANSWER_MARKER_PREFIX` (see `sagemaker-endpoint.ts`, which also gives the message the call is answered with). The worker sets a test's `notRun` from that marker, and from the marker alone: a status or
//     an error code also fits a real validation error. The dependency it names is the endpoint.
//
// Precedence when one test used several dependencies: faked beats recorded beats real (the least trusted answer names the state). A test that failed is `failed` whatever answered it.
// Test ids and dependency names come from a repository: every one is made plain (control characters out, cut short) before it is written into a line. Nothing here imports a Node module.
import { z } from "zod";
import { SCRIPTED_REPLY_SOURCES, SCRIPTED_REPLY_SOURCE_WORDS, scriptedRepliesCountTowardProof, type EvidenceTrustClass } from "./check-kinds.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
const Date10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "a date");

export const TEST_ANSWER_RECORDS_MAX = 5_000;
export const TEST_ANSWER_USES_MAX = 16;

/**
 * What answered one dependency a test called, from every kind of backing (TE-A3): a fake of the customer's that makes answers up or serves hand-written ones, a recording (with the day it was recorded), Rovara local AWS,
 * a mock Rovara made, or scripted AI replies (with who wrote them, DECISIONS 161). A real answer needs no record. A record written before TE-A3 holds only the first two and still reads.
 */
export const TestAnswerUseSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("faked"), dependency: line(80) }).strict(),
  z.object({ source: z.literal("recorded"), dependency: line(80), recordedOn: Date10 }).strict(),
  z.object({ source: z.literal("emulated"), dependency: line(80) }).strict(),
  z.object({ source: z.literal("made_by_rovara"), dependency: line(80) }).strict(),
  z.object({ source: z.literal("scripted"), dependency: line(80), repliesBy: z.enum(SCRIPTED_REPLY_SOURCES) }).strict(),
]);
export type TestAnswerUse = z.infer<typeof TestAnswerUseSchema>;

export const TEST_NOT_RUN_REASONS = ["no_recording"] as const;
export const TestNotRunSchema = z.object({ dependency: line(80), reason: z.enum(TEST_NOT_RUN_REASONS) }).strict();
export type TestNotRun = z.infer<typeof TestNotRunSchema>;

export const TestAnswerRecordSchema = z
  .object({
    testId: line(200),
    status: z.enum(["passed", "failed", "not_run"]),
    uses: z.array(TestAnswerUseSchema).max(TEST_ANSWER_USES_MAX),
    notRun: TestNotRunSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.status === "not_run") !== (record.notRun !== undefined)) context.addIssue({ code: "custom", path: ["notRun"], message: "a test that was not run says which dependency had no answer, and no other test does" });
    if (record.status === "not_run" && record.uses.length > 0) context.addIssue({ code: "custom", path: ["uses"], message: "a test that was not run called nothing" });
  });
export type TestAnswerRecord = z.infer<typeof TestAnswerRecordSchema>;
export const TestAnswerRecordsSchema = z.array(TestAnswerRecordSchema).max(TEST_ANSWER_RECORDS_MAX);

/** The state a test result has. `passed` is only for a test that no faked or recorded answer stood behind. */
export const TEST_RESULT_STATES = ["passed", "passed_faked", "passed_recorded", "passed_emulated", "passed_made_by_rovara", "passed_scripted", "failed", "not_run_no_recording"] as const;
export type TestResultState = (typeof TEST_RESULT_STATES)[number];
export const TEST_RESULT_STATE_WORDS: Record<TestResultState, string> = {
  passed: "passed",
  passed_faked: "passed against faked answers",
  passed_recorded: "passed against recorded answers",
  passed_emulated: "passed against Rovara local AWS answers",
  passed_made_by_rovara: "passed against answers made by Rovara",
  passed_scripted: "passed against scripted AI replies",
  failed: "failed",
  not_run_no_recording: "not run (no recording)",
};

/** The sources of an answer, least trusted first: the state of a test is the first of these that any of its answers has. */
const SOURCE_PRECEDENCE = ["made_by_rovara", "scripted", "faked", "emulated", "recorded"] as const;
const STATE_OF_SOURCE: Record<(typeof SOURCE_PRECEDENCE)[number], TestResultState> = {
  made_by_rovara: "passed_made_by_rovara", scripted: "passed_scripted", faked: "passed_faked", emulated: "passed_emulated", recorded: "passed_recorded",
};

/** The state of one record. A passing test is in the state of the least trusted answer behind it (Made by Rovara, then scripted, faked, Rovara local AWS, recorded), else `passed`. */
export function testResultState(record: TestAnswerRecord): TestResultState {
  if (record.status === "not_run") return "not_run_no_recording";
  if (record.status === "failed") return "failed";
  const first = SOURCE_PRECEDENCE.find((source) => record.uses.some((use) => use.source === source));
  return first === undefined ? "passed" : STATE_OF_SOURCE[first];
}

/** The trust class of one answer (O51): a recording is Recorded, never Real; a mock Rovara made is Made by Rovara; everything else that is not a real answer is Simulated, and so is a source this build does not know. */
export function testAnswerTrustClass(use: TestAnswerUse): EvidenceTrustClass {
  switch (use.source) {
    case "recorded": return "recorded";
    case "made_by_rovara": return "made_by_rovara";
    default: return "simulated";
  }
}

/** The trust classes of the answers behind a test, each once, in the order of `EVIDENCE_TRUST_CLASSES`. A test with no recorded use has none: this lane only maps what the worker recorded (the join with detected in-process fakes is TE-A6). */
export function testTrustClasses(record: TestAnswerRecord): EvidenceTrustClass[] {
  const found = new Set(record.uses.map(testAnswerTrustClass));
  return (["real", "recorded", "simulated", "made_by_rovara", "no_outside_calls"] as const).filter((trust) => found.has(trust));
}

/** Whether one answer can stand behind a proof: never a mock Rovara made, scripted replies only from a source that counts (DECISIONS 161), and a source this build does not know does not count. */
export function testAnswerCountsTowardProof(use: TestAnswerUse): boolean {
  switch (use.source) {
    case "faked":
    case "recorded":
    case "emulated":
      return true;
    case "scripted":
      return scriptedRepliesCountTowardProof(use.repliesBy);
    default:
      return false;
  }
}

/** Whether a test counts toward the proof: it passed, and every answer behind it counts. */
export function testCountsTowardProof(record: TestAnswerRecord): boolean {
  return record.status === "passed" && record.uses.every(testAnswerCountsTowardProof);
}

/** The oldest recording a test's answers came from (the least fresh answer names the date), or undefined when none was recorded. */
export function testRecordedOn(record: TestAnswerRecord): string | undefined {
  const dates = record.uses.flatMap((use) => (use.source === "recorded" ? [use.recordedOn] : []));
  return dates.length === 0 ? undefined : [...dates].sort()[0];
}

/** The scripted source that names a test's line: the one that counts least (replies the coding agent wrote, then an independent agent's, then the project's set), so a mix never reads better than its worst part. */
function scriptedSourceOf(record: TestAnswerRecord): (typeof SCRIPTED_REPLY_SOURCES)[number] | undefined {
  const found = record.uses.flatMap((use) => (use.source === "scripted" ? [use.repliesBy] : []));
  return [...SCRIPTED_REPLY_SOURCES].reverse().find((source) => found.includes(source));
}

const plain = (text: string, max: number): string => {
  const one = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};
const tests = (count: number): string => `${String(count)} ${count === 1 ? "test" : "tests"}`;
const NAMES_LISTED = 5;
const named = (ids: readonly string[]): string => {
  const listed = ids.slice(0, NAMES_LISTED).map((id) => plain(id, 80)).filter((id) => id !== "");
  return `${listed.join(", ")}${ids.length > NAMES_LISTED ? `, and ${String(ids.length - NAMES_LISTED)} more` : ""}`;
};

export interface TestAnswerSummaryOptions {
  /** The service whose answers were faked or recorded, in a pull request's words: `SageMaker`, `Bedrock`, `the payments API`. */
  service: string;
  /** What the real answer would have been: `model output` for a model, `output` by default. */
  realThing?: string;
  /** What a dependency is called in "no recording for endpoint X": `endpoint` by default. */
  dependencyNoun?: string;
}

/**
 * The pull request lines for a list of test records, one per state worth saying, in a fixed order: tests that passed against faked answers, then against recorded ones (one line for each recording date), then
 * tests not run. A run where every test passed against real answers gives no line. Words are fixed; test ids and names are made plain and at most five ids are listed.
 *   12 tests passed against faked SageMaker answers (not real model output): a, b, c, d, e, and 7 more
 *   3 tests passed against recorded SageMaker answers (recorded 2026-11-20; not real model output): x, y, z
 *   3 tests not run: no recording for endpoint fraud-scorer (tests: x, y, z)
 */
export function testAnswerSummaryLines(records: readonly TestAnswerRecord[], options: TestAnswerSummaryOptions): string[] {
  const service = plain(options.service, 60) || "service";
  const real = plain(options.realThing ?? "output", 40) || "output";
  const noun = plain(options.dependencyNoun ?? "endpoint", 40) || "endpoint";
  const lines: string[] = [];
  const faked = records.filter((record) => testResultState(record) === "passed_faked");
  if (faked.length > 0) lines.push(`${tests(faked.length)} passed against faked ${service} answers (not real ${real}): ${named(faked.map((record) => record.testId))}`);
  const emulated = records.filter((record) => testResultState(record) === "passed_emulated");
  if (emulated.length > 0) lines.push(`${tests(emulated.length)} passed against ${service} answers from Rovara local AWS (not real ${real}): ${named(emulated.map((record) => record.testId))}`);
  const scriptedBy = (source: (typeof SCRIPTED_REPLY_SOURCES)[number]) => records.filter((record) => testResultState(record) === "passed_scripted" && scriptedSourceOf(record) === source);
  for (const source of SCRIPTED_REPLY_SOURCES) {
    const group = scriptedBy(source);
    if (group.length > 0) lines.push(`${tests(group.length)} passed against scripted ${service} replies (${SCRIPTED_REPLY_SOURCE_WORDS[source]}; not real ${real}): ${named(group.map((record) => record.testId))}`);
  }
  const madeByRovara = records.filter((record) => testResultState(record) === "passed_made_by_rovara");
  if (madeByRovara.length > 0) lines.push(`${tests(madeByRovara.length)} passed against answers Rovara made for ${service} (Made by Rovara, not counted toward the proof; not real ${real}): ${named(madeByRovara.map((record) => record.testId))}`);
  const byDate = new Map<string, TestAnswerRecord[]>();
  for (const record of records.filter((entry) => testResultState(entry) === "passed_recorded")) {
    const date = testRecordedOn(record) ?? "";
    byDate.set(date, [...(byDate.get(date) ?? []), record]);
  }
  for (const [date, group] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) lines.push(`${tests(group.length)} passed against recorded ${service} answers (recorded ${date}; not real ${real}): ${named(group.map((record) => record.testId))}`);
  const skipped = records.filter((record) => record.status === "not_run" && record.notRun !== undefined);
  if (skipped.length > 0) {
    const dependencies = [...new Set(skipped.map((record) => plain(record.notRun!.dependency, 80)))].filter((name) => name !== "");
    lines.push(`${tests(skipped.length)} not run: no recording for ${dependencies.length === 1 ? noun : `${noun}s`} ${dependencies.slice(0, NAMES_LISTED).join(", ")}${dependencies.length > NAMES_LISTED ? `, and ${String(dependencies.length - NAMES_LISTED)} more` : ""} (tests: ${named(skipped.map((record) => record.testId))})`);
  }
  return lines;
}
