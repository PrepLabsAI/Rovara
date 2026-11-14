// TE-B3 (O39): the flags a reviewer reads at the top of a pull request and in the Check: Rovara instruction files changed, files CI runs changed, tests that ran before and not now, more tests skipped than before, and
// changed snapshots, fixtures and test configuration. They are FLAGS and words only (until TE-B5 makes them gating): nothing here changes a verdict, a risk level or a merge. The facts come from two places the broker
// already trusts: the changed files (read from the code host, never from the worker) and the evidence pack's test parts (the worker's report, checked by `buildEvidencePack`). Every name reaches the page through `weakeningLines`
// (contracts), which makes it inert (no link, mention, image, issue reference, closing key, heading or hidden character) and bounded.
import { inertEvidenceText, weakeningLines, type EvidencePack, type TestProof, type WeakeningFacts } from "@agentx/contracts";
import { isCiExecutedPath } from "./risk.js";
import { isInstructionFilePath } from "./weakening-paths.js";
import type { ChangedFileEntry } from "./verification-report.js";

/** The most paths and test ids one flag keeps (the contract's lists hold at most 100 paths and 200 test ids). */
const PATHS_MAX = 100;
const TEST_IDS_MAX = 200;

const unique = (values: Iterable<string>, max: number): string[] => [...new Set(values)].slice(0, max);
const namesOf = (file: ChangedFileEntry): string[] => [file.path, ...(file.renamedFrom === undefined ? [] : [file.renamedFrom])];

/**
 * What the changed files and the pack say about weakened tests. `files` are the diff's files (a rename counts under both names); `pack` is the evidence pack, already bound to the code (`boundEvidence`), or undefined.
 * The skip rise sums the checks that gave both counts: a rise in one check is a rise even when another check skipped fewer, so the checks are not netted against each other.
 */
export function weakeningFactsOf(files: readonly ChangedFileEntry[], pack: EvidencePack | undefined): WeakeningFacts {
  const instruction = files.filter((file) => namesOf(file).some(isInstructionFilePath)).map((file) => file.path);
  const ciExecuted = files.filter((file) => file.testCommandChanged === true || file.ciScriptChanged === true || file.testConfigChanged === true || namesOf(file).some(isCiExecutedPath)).map((file) => file.path);
  let rise: { before: number; after: number } | undefined;
  const absent: string[] = [];
  let absentCount = 0;
  for (const check of pack?.checks ?? []) {
    const tests = check.tests;
    if (tests === undefined) continue;
    if (tests.skippedBefore !== undefined && tests.skippedAfter !== undefined && tests.skippedAfter > tests.skippedBefore) {
      rise = { before: (rise?.before ?? 0) + tests.skippedBefore, after: (rise?.after ?? 0) + tests.skippedAfter };
    }
    if (tests.absentOnNew !== undefined && tests.absentOnNewCount !== undefined) {
      absent.push(...tests.absentOnNew);
      absentCount += tests.absentOnNewCount;
    }
  }
  return {
    ...(rise === undefined ? {} : { skipRise: rise }),
    absentOnNew: unique(absent, TEST_IDS_MAX),
    absentOnNewCount: absentCount,
    changedTestConfig: unique(files.filter((file) => file.testConfigChanged === true).map((file) => file.path), PATHS_MAX),
    changedSnapshots: unique(files.filter((file) => file.snapshotChanged === true).map((file) => file.path), PATHS_MAX),
    changedFixtures: unique(files.filter((file) => file.fixtureChanged === true).map((file) => file.path), PATHS_MAX),
    instructionFiles: unique(instruction, PATHS_MAX),
    ciExecutedFiles: unique(ciExecuted, PATHS_MAX),
  };
}

/** The heading of the flags block. */
export const WEAKENING_HEADING = "## Flags for the reviewer";

const NOT_COMPARED_WORDS = {
  no_report: "a test report was not available from both runs",
  original_run_incomplete: "the run on the original code did not finish",
  original_run_truncated: "the run on the original code looks cut short",
} as const;
const NOT_CHECKED_WORDS = {
  budget: "there was no time left to run the original code",
  timed_out: "the run on the original code timed out",
  stopped: "the run was stopped",
  original_code_unavailable: "the original code could not be shown",
} as const;

/**
 * Why the test proof could not compare the untouched tests before and after, in fixed words; undefined when it compared every check it ran (a check that was not compared is named by `notComparedLines`). A proof that did not
 * run, was for other code, ran nothing, or compared nothing is never silence: the description says it could not compare, so "no flag" never reads as "no weakening".
 */
export function notComparedReason(proof: TestProof | undefined, candidateDigest: string | undefined): string | undefined {
  if (proof === undefined || candidateDigest === undefined || proof.candidateDigest !== candidateDigest) return "the test proof did not run for this code";
  if (proof.status === "no_changed_tests") return "no test was added or changed, so the original code was not run";
  if (proof.status === "not_checked") return Object.hasOwn(NOT_CHECKED_WORDS, proof.note) ? NOT_CHECKED_WORDS[proof.note as keyof typeof NOT_CHECKED_WORDS] : "the original code was not run";
  if ((proof.weakening ?? []).length > 0) return undefined;
  const first = proof.weakeningNotCompared?.[0]?.reason;
  return first === undefined ? "no test report to compare" : NOT_COMPARED_WORDS[first];
}

/** The most checks named one by one; the rest are counted. */
const NOT_COMPARED_LISTED = 5;

/**
 * The "Test weakening: could not compare" lines: one for the whole proof when it did not run or compared nothing, else one for EACH check that was not compared, with its name and the reason, even when another check was
 * compared (a check that was not compared must not hide behind one that was). At most five are named; the rest are counted.
 */
export function notComparedLines(proof: TestProof | undefined, candidateDigest: string | undefined): string[] {
  const whole = notComparedReason(proof, candidateDigest);
  if (whole !== undefined && ((proof?.weakeningNotCompared ?? []).length === 0 || proof?.status !== "checked")) return [`Test weakening: could not compare (${whole})`];
  const skipped = proof?.weakeningNotCompared ?? [];
  const named = skipped.slice(0, NOT_COMPARED_LISTED).map((entry) => {
    const label = (proof?.items ?? []).find((item) => item.checkId === entry.checkId)?.label;
    const words = NOT_COMPARED_WORDS[entry.reason];
    return `Test weakening: could not compare ${label === undefined ? "" : `${inertEvidenceText(label, 60)} `}(${words})`;
  });
  return [...named, ...(skipped.length > NOT_COMPARED_LISTED ? [`Test weakening: could not compare ${String(skipped.length - NOT_COMPARED_LISTED)} more ${skipped.length - NOT_COMPARED_LISTED === 1 ? "check" : "checks"}`] : [])];
}

/**
 * The block at the top of the Rovara status section: the heading and one bullet per flag, then a blank line; nothing at all (an empty list) when there is no flag, so a description without flags reads exactly as it did.
 * Each line is made inert and cut by `weakeningLines`; the heading and the list markers are Rovara's. `proof` is given when the description has a Proof context (the test proof's reading for this code): then a proof that
 * could not compare adds "Test weakening: could not compare (<reason>)" (fixed words), once for the proof or once per check that was not compared, so a missing flag never reads as "nothing was weakened".
 */
export function weakeningBlock(files: readonly ChangedFileEntry[], pack: EvidencePack | undefined, proof?: { testProof: TestProof | undefined; candidateDigest: string | undefined }): string[] {
  const lines = weakeningLines(weakeningFactsOf(files, pack));
  const notCompared = proof === undefined ? [] : notComparedLines(proof.testProof, proof.candidateDigest);
  const all = [...lines.flags, ...lines.weakening, ...notCompared];
  return all.length === 0 ? [] : [WEAKENING_HEADING, ...all.map((line) => `- ${line}`), ""];
}
