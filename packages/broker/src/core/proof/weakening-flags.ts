// TE-B3 (O39): the flags a reviewer reads at the top of a pull request and in the Check: Rovara instruction files changed, files CI runs changed, tests that ran before and not now, more tests skipped than before, and
// changed snapshots, fixtures and test configuration. They are FLAGS and words only (until TE-B5 makes them gating): nothing here changes a verdict, a risk level or a merge. The facts come from two places the broker
// already trusts: the changed files (read from the code host, never from the worker) and the evidence pack's test parts (the worker's report, checked by `buildEvidencePack`). Every name reaches the page through `weakeningLines`
// (contracts), which makes it inert (no link, mention, image, issue reference, closing key, heading or hidden character) and bounded.
import { weakeningLines, type EvidencePack, type WeakeningFacts } from "@agentx/contracts";
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
  const ciExecuted = files.filter((file) => file.testCommandChanged === true || file.testConfigChanged === true || namesOf(file).some(isCiExecutedPath)).map((file) => file.path);
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

/**
 * The block at the top of the Rovara status section: the heading and one bullet per flag, then a blank line; nothing at all (an empty list) when there is no flag, so a description without flags reads exactly as it did.
 * Each line is made inert and cut by `weakeningLines`; the heading and the list markers are Rovara's.
 */
export function weakeningBlock(files: readonly ChangedFileEntry[], pack: EvidencePack | undefined): string[] {
  const lines = weakeningLines(weakeningFactsOf(files, pack));
  const all = [...lines.flags, ...lines.weakening];
  return all.length === 0 ? [] : [WEAKENING_HEADING, ...all.map((line) => `- ${line}`), ""];
}
