// TESTPROOF: does the change's new or changed test fail on the original code? The worker writes test-proof.json at the end of a
// CHECKS run; the broker reads it at publication and shows one or two lines in the pull request. Informational only: it never
// changes a check result, never blocks and never sends the work back.
import { z } from "zod";

export const TEST_PROOF_ARTIFACT = "test-proof.json";

/**
 * proves_change: failed with an assertion on the original code and passes now.
 * could_not_run_on_old: failed to load or compile on the original code (a missing file or symbol), or failed in a way AgentX could not tell.
 * does_not_prove: also passes on the original code (a warning).
 * not_checked: a timeout, a stop or an infrastructure fault, so nothing is known.
 */
export const TestProofVerdictSchema = z.enum(["proves_change", "could_not_run_on_old", "does_not_prove", "not_checked"]);
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
]);
export type TestProofReason = z.infer<typeof TestProofReasonSchema>;

export const TestProofItemSchema = z.object({
  checkId: z.string().min(1).max(64),
  /** The check's label, redacted by the worker. */
  label: z.string().min(1).max(1_024),
  /** `check`: one verdict for the whole check. `test`: one per test, from a JUnit or JSON report the check already writes. */
  granularity: z.enum(["check", "test"]),
  /** The test's name, for a `test` item. */
  test: z.string().min(1).max(300).optional(),
  verdict: TestProofVerdictSchema,
  reason: TestProofReasonSchema,
}).strict();
export type TestProofItem = z.infer<typeof TestProofItemSchema>;

export const TestProofSchema = z.object({
  schemaVersion: z.literal(1),
  /** The candidate digest of the code the checks passed on. A proof for any other digest is ignored. */
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** no_changed_tests: nothing was run. checked: the checks ran on the original code with the new tests. not_checked: the run could not be made. */
  status: z.enum(["no_changed_tests", "checked", "not_checked"]),
  note: z.enum(["no_changed_tests", "no_project_checks", "no_passing_checks", "completed", "timed_out", "stopped", "original_code_unavailable"]),
  changedTests: z.object({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() }).strict(),
  items: z.array(TestProofItemSchema).max(200),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type TestProof = z.infer<typeof TestProofSchema>;
