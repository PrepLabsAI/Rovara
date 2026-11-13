// TESTPROOF: does the change's new or changed test fail on the original code? The worker writes test-proof.json at the end of a
// CHECKS run; the broker reads it at publication and shows one or two lines in the pull request. Informational only: it never
// changes a check result, never blocks and never sends the work back.
import { z } from "zod";
import { TEST_ID_MAX } from "./test-id.js";

export const TEST_PROOF_ARTIFACT = "test-proof.json";

/**
 * proves_change: failed with an assertion on the original code and passes now.
 * could_not_run_on_old: failed to load or compile on the original code (a missing file or symbol), or failed in a way AgentX could not tell.
 * does_not_prove: also passes on the original code (a warning).
 * not_checked: a timeout, a stop or an infrastructure fault, so nothing is known.
 * not_applicable: the check is not a test runner (a linter, a type check): it is neither counted nor warned about.
 */
export const TestProofVerdictSchema = z.enum(["proves_change", "could_not_run_on_old", "does_not_prove", "not_checked", "not_applicable"]);
export type TestProofVerdict = z.infer<typeof TestProofVerdictSchema>;

/** Fixed codes only: no command output or error text is ever stored here. */
export const TestProofReasonSchema = z.enum([
  "assertion_failed_on_old",
  "load_failure_on_old",
  "unrecognized_failure_on_old",
  "passed_on_old",
  "test_missing_on_old",
  "timed_out",
  "stopped",
  "budget",
  "infrastructure",
  "not_passed_on_new",
  "not_a_test_check",
]);
export type TestProofReason = z.infer<typeof TestProofReasonSchema>;

export const TestProofItemSchema = z.object({
  checkId: z.string().min(1).max(64),
  /** The check's label, redacted by the worker. */
  label: z.string().min(1).max(1_024),
  /** `check`: one verdict for the whole check. `test`: one per test, from a JUnit or JSON report the check already writes. */
  granularity: z.enum(["check", "test"]),
  /** The test's name, for a `test` item. */
  test: z.string().min(1).max(TEST_ID_MAX).optional(),
  verdict: TestProofVerdictSchema,
  reason: TestProofReasonSchema,
}).strict();
export type TestProofItem = z.infer<typeof TestProofItemSchema>;

/** The most test ids one check names as "ran before, not now" (the count says the rest). */
export const ABSENT_ON_NEW_MAX = 100;

/** Why a check's untouched tests could not be compared with the run on the original code. Fixed codes only. `no_report`: one of the two runs left no report of its own that can be read. `original_run_incomplete`: the run on the original code did not end (timed out, stopped). `original_run_truncated`: it looks cut short (collection errors, a stop-at-first-failure option, far fewer untouched tests than this code's run), so a missing test or a skip count would only be the cut. */
export const TestProofNotComparedReasonSchema = z.enum(["no_report", "original_run_incomplete", "original_run_truncated"]);
export type TestProofNotComparedReason = z.infer<typeof TestProofNotComparedReasonSchema>;

/**
 * TE-B3: what the run on the original code shows about a check's untouched tests, per COMPARED check (a check that was compared and shows nothing has zeros, so a reader can tell it from one that was not compared).
 * `skippedBefore` and `skippedAfter` are the skips among tests the change did not touch (original code, this code); `absentOnNew` names tests that ran on the original code and are not in this code's report (at most
 * `ABSENT_ON_NEW_MAX`, as test ids), and `absentOnNewCount` is how many there are in all. Facts only: the broker words them.
 * The WRITER's schema is strict. The READER (`TestProofSchema`) strips what it does not know and drops a weakening part it cannot read, so a broker ships the reader before any worker writes the part.
 */
const weakeningShape = {
  checkId: z.string().min(1).max(64),
  skippedBefore: z.number().int().min(0).max(100_000_000),
  skippedAfter: z.number().int().min(0).max(100_000_000),
  absentOnNew: z.array(z.string().min(1).max(TEST_ID_MAX)).max(ABSENT_ON_NEW_MAX),
  absentOnNewCount: z.number().int().min(0).max(100_000_000),
};
const countCheck = (item: { absentOnNew: unknown[]; absentOnNewCount: number }) => item.absentOnNewCount >= item.absentOnNew.length;
export const TestProofWeakeningSchema = z.object(weakeningShape).strict().refine(countCheck, "the count is at least the names listed");
const TestProofWeakeningReadSchema = z.object(weakeningShape).refine(countCheck, "the count is at least the names listed");
export type TestProofWeakening = z.infer<typeof TestProofWeakeningSchema>;

const notComparedShape = { checkId: z.string().min(1).max(64), reason: TestProofNotComparedReasonSchema };
const proofShape = {
  schemaVersion: z.literal(1),
  /** The candidate digest of the code the checks passed on. A proof for any other digest is ignored. */
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** no_changed_tests: nothing was run. checked: the checks ran on the original code with the new tests. not_checked: the run could not be made. */
  status: z.enum(["no_changed_tests", "checked", "not_checked"]),
  note: z.enum(["no_changed_tests", "no_project_checks", "no_passing_checks", "no_test_checks", "budget", "completed", "timed_out", "stopped", "original_code_unavailable"]),
  changedTests: z.object({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() }).strict(),
  items: z.array(TestProofItemSchema).max(200),
  durationMs: z.number().int().nonnegative(),
};

/** What the WORKER writes (strict). */
export const TestProofWriteSchema = z.object({
  ...proofShape,
  /** TE-B3: per compared check, what the original code's run shows about tests the change did not touch. */
  weakening: z.array(TestProofWeakeningSchema).max(64).optional(),
  /** TE-B3: the checks that were run on the original code and could not be compared, with the fixed reason. */
  weakeningNotCompared: z.array(z.object(notComparedShape).strict()).max(64).optional(),
}).strict();

/** What READERS parse: the same, but a key a newer writer added is dropped, and a weakening part that does not read is dropped alone (the rest of the proof still reads). */
export const TestProofSchema = z.object({
  ...proofShape,
  weakening: z.array(TestProofWeakeningReadSchema).max(64).optional().catch(undefined),
  weakeningNotCompared: z.array(z.object(notComparedShape)).max(64).optional().catch(undefined),
});
export type TestProof = z.infer<typeof TestProofSchema>;
