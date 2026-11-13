// TE-C1 (design testing-build-plan, block TE-C1; DECISIONS 160(6)): the baseline per base commit. "Before" is known per test, per commit, from a run Rovara trusts, and the pull request says which. The pure parts live here
// (nothing imports a Node module): the row one trusted run leaves per commit, the two asked-for wire fields (the engine's candidates, the worker's claim), the stored words, and the one line.
//
//   row        TESTENV#BASELINE#SHA#<envRevision>#<headSha> on the project's partition, written only for a run the engine trusts (a nightly today; `readiness` and `final_round` are reserved words, nothing writes them yet)
//   candidates the newest few trusted rows, sent in the task plan to a worker that lists TEST_ENV_BASELINE_FEATURE (a shas-only list: a candidate carries no test name)
//   claim      what the worker found at the start of its checks round: the nearest candidate that is an ancestor of the task's base commit, and how many commits back it is (`evidence-raw.json`, asked for only)
//   words      `baselineLine`: "Compared with main at 4f2a9c1 (nightly, 2 h old, 3 commits back; partial): 3 known failing, 2 flaky"
import { z } from "zod";
import { inertEvidenceText } from "./evidence-inert.js";
import { NightlyBaselineSchema, type NightlyBaseline } from "./test-env-nightly.js";

/** A worker lists this when it checks the engine's candidates against the task's base commit (verification/baseline-ancestry.ts). The plan carries `baselineCandidates` only for a worker that lists it. */
export const TEST_ENV_BASELINE_FEATURE = "task.testEnvBaseline.v1" as const;
/** The farthest back (in commits on the base's first-parent line) an ancestor may be and still be compared with. */
export const BASELINE_ANCESTOR_MAX = 50;
/** The most candidates a plan carries. */
export const BASELINE_CANDIDATES_MAX = 5;
/** Who wrote a row. Only `nightly` is written today (readiness per-test ids need TE-D5, a final round needs TE-B1). */
export const BASELINE_WRITERS = ["nightly", "readiness", "final_round"] as const;
export const BaselineWriterSchema = z.enum(BASELINE_WRITERS);
export type BaselineWriter = z.infer<typeof BaselineWriterSchema>;

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/u);
const Count = z.number().int().min(0).max(100_000_000);

/**
 * One trusted run at one commit: the nightly baseline's own fields and rules (bounded lists, `failedUnlisted`, a whole failing set) without the coverage map, plus who wrote it. No person is named. The row's key holds the
 * environment revision and the commit; a reader checks that the row says the same.
 */
export const BaselineRowSchema = NightlyBaselineSchema.omit({ coverageMapRef: true, coverageMapBuiltAt: true }).extend({ writer: BaselineWriterSchema }).strict();
export type BaselineRow = z.infer<typeof BaselineRowSchema>;

/** The nightly baseline's rule for a failing set that may excuse failures: every failing test is listed or counted (see `failingSetIsWhole` in the nightly). Truncated or inconsistent sets excuse nothing. */
export const baselineSetIsWhole = (baseline: Pick<NightlyBaseline, "failed" | "failedUnlisted" | "tests">): boolean => baseline.failed.length + (baseline.failedUnlisted ?? 0) === baseline.tests.failed;

/** A commit the engine offers the worker to look for among the task's ancestors. A sha and nothing else. */
export const BaselineCandidateSchema = z.object({ sha: Sha40 }).strict();
/** What the worker found: one of the offered shas and how far back it is. The engine uses it only for a sha it offered itself. */
export const RawBaselineSchema = z.object({ sha: Sha40, commitsBack: z.number().int().min(0).max(BASELINE_ANCESTOR_MAX) }).strict();
export type RawBaseline = z.infer<typeof RawBaselineSchema>;

/** What the pull request and the task page read back for a task: the run the task was compared with, in numbers only. Kept beside the evidence pack (the pack's own shape is unchanged). */
export const EvidenceBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    sha: Sha40,
    branch: z.string().min(1).max(250),
    writer: BaselineWriterSchema,
    commitsBack: z.number().int().min(0).max(BASELINE_ANCESTOR_MAX),
    /** Hours between the run's end and the moment the task's checks were compared with it. */
    ageHours: z.number().int().min(0).max(1_000_000),
    knownFailing: Count,
    flaky: Count,
  })
  .strict();
export type EvidenceBaseline = z.infer<typeof EvidenceBaselineSchema>;

const WRITER_WORDS = { nightly: "nightly", readiness: "readiness run", final_round: "final round" } as const;
const number = (count: number): string => count.toLocaleString("en-US");

export interface BaselineLineInput {
  branch: string;
  shortSha: string;
  writer: BaselineWriter;
  ageHours: number;
  commitsBack: number;
  partial: boolean;
  knownFailing: number;
  flaky: number;
}

/**
 * "Compared with main at 4f2a9c1 (nightly, 2 h old): 3 known failing, 2 flaky", and "(nightly, 2 h old, 3 commits back; partial)" when the run is of an ancestor, not of the base itself. The branch name is the only
 * word a repository wrote: it goes through the inert-text function. The commit is shown only as 7 to 40 hex characters; anything else is "an unknown commit". Counts and fixed words otherwise.
 */
export function baselineLine(input: BaselineLineInput): string {
  const branch = inertEvidenceText(input.branch, 60);
  const sha = /^[a-f0-9]{7,40}$/u.test(input.shortSha) ? input.shortSha.slice(0, 7) : undefined;
  const age = input.ageHours < 1 ? "under 1 h old" : `${number(input.ageHours)} h old`;
  const back = input.partial ? `, ${number(input.commitsBack)} ${input.commitsBack === 1 ? "commit" : "commits"} back; partial` : "";
  return `Compared with ${branch === "" ? "the base branch" : branch} at ${sha ?? "an unknown commit"} (${WRITER_WORDS[input.writer]}, ${age}${back}): ${number(input.knownFailing)} known failing, ${number(input.flaky)} flaky`;
}

/** The line for the words a task kept (`EvidenceBaseline`). */
export const baselineWords = (stored: EvidenceBaseline): string =>
  baselineLine({ branch: stored.branch, shortSha: stored.sha.slice(0, 7), writer: stored.writer, ageHours: stored.ageHours, commitsBack: stored.commitsBack, partial: stored.commitsBack > 0, knownFailing: stored.knownFailing, flaky: stored.flaky });
