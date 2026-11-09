// The nightly full baseline (design proof-test-env, section 4.5): what a full run of a project's default branch reports back, and what the broker keeps of it. Nightly results feed three things: the coverage map
// that test selection reads, the set of tests that already fail on the default branch (so a known failure is not a regression of the task), and the flaky set (a failure that passed on its one rerun).
// Everything is bounded and holds ids and counts only: no test output, no message text. Nothing here imports a Node module.
import { z } from "zod";
import { TestIdSchema } from "./test-id.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const TestId = TestIdSchema;

export const NIGHTLY_FAILED_MAX = 500;
export const NIGHTLY_FLAKY_MAX = 500;
export const NIGHTLY_SLOW_MAX = 20;
export const NIGHTLY_SOURCE = "agentx.test-env-nightly";

export const NightlyFireSchema = z.object({ source: z.literal(NIGHTLY_SOURCE), orgId: z.string().regex(/^org_[0-9a-z]{20}$/), project: z.string().min(1).max(200), scheduledAt: z.string().datetime({ offset: true }) }).strict();
export type NightlyFire = z.infer<typeof NightlyFireSchema>;

// ---- the step words (SH27, design setup-test-health 6.1): what the run says about its own steps, so the broker can tell a broken environment from failing tests. Fixed words and counts only.

/** The steps of a nightly run, in the Prove step words plus `pull` and `update`. The first seven are about the setup; `smoke` and `full_suite` are tests. */
export const NIGHTLY_STEP_WORDS = ["pull", "update", "setup", "build", "boot", "mocks", "preprod_probe", "smoke", "full_suite"] as const;
export type NightlyStepWord = (typeof NIGHTLY_STEP_WORDS)[number];
export const NIGHTLY_STEP_STATUSES = ["passed", "failed", "skipped"] as const;
/** Where the night's code and tools came from: a fresh setup, or the project's saved image (which the night then also checks). */
export const NIGHTLY_RAN_FROM = ["fresh", "saved_image"] as const;
export type NightlyRanFrom = (typeof NIGHTLY_RAN_FROM)[number];
const HealthCount = z.number().int().min(0).max(100_000_000);

/** What a run reports about itself for the health check. Strict and bounded; the broker decides what it means (`classifyNightlyHealth`), the worker's own words about it are never used. */
export const NightlyHealthReportSchema = z
  .object({
    steps: z.array(z.object({ step: z.enum(NIGHTLY_STEP_WORDS), status: z.enum(NIGHTLY_STEP_STATUSES) }).strict()).max(NIGHTLY_STEP_WORDS.length),
    /** One entry per check the run was to make. */
    checks: z
      .array(z.object({ runsTests: z.boolean(), started: z.boolean(), timedOut: z.boolean(), reportApproved: z.boolean(), reportWritten: z.boolean(), testsCollected: HealthCount }).strict())
      .max(64),
    /** `failures` are assertion failures, `errors` are collection or import errors. */
    tests: z.object({ total: HealthCount, passed: HealthCount, failures: HealthCount, errors: HealthCount, skipped: HealthCount }).strict(),
    /** Left out by a run that does not say (an older worker): read as fresh. */
    ranFrom: z.enum(NIGHTLY_RAN_FROM).optional(),
  })
  .strict();
export type NightlyHealthReport = z.infer<typeof NightlyHealthReportSchema>;

/** What the broker keeps of the classification, beside the baseline (never inside it, so an older broker still reads the baseline). `cause` is one of the fixed cause words of the classifier. */
export const StoredNightlyHealthSchema = z
  .object({
    class: z.enum(["passed", "environment", "tests", "unclear"]), cause: z.string().regex(/^[a-z_]{1,40}$/u).optional(), ranFrom: z.enum(NIGHTLY_RAN_FROM),
    /** Only with class `tests`: the night had the evidence that the setup works (see `classifyNightlyHealth`). Absent reads as false. */
    setupProved: z.boolean().optional(),
  })
  .strict();
export type StoredNightlyHealth = z.infer<typeof StoredNightlyHealthSchema>;

export const NightlyResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The fire this run answers: results for any other slot are refused. */
    slotId: Sha256,
    envRevision: z.number().int().min(1),
    branch: z.string().min(1).max(250),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().int().min(0),
    tests: z.object({ total: z.number().int().min(0).max(100_000_000), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0) }).strict(),
    /** Tests that failed in the first run and again on the rerun. */
    failed: z.array(TestId).max(NIGHTLY_FAILED_MAX),
    /** Tests that failed once and passed on the one rerun. */
    flaky: z.array(TestId).max(NIGHTLY_FLAKY_MAX),
    /** The digest of the coverage map the run stored, when it recorded one (coverage contexts on). */
    coverageMapRef: Sha256.optional(),
    /** How many of the failing tests have an id that is not valid (control or look-alike characters, too long): they are counted in `tests.failed` and left out of `failed`. The failing set is still whole for the rest. */
    failedUnlisted: z.number().int().min(0).max(100_000_000).optional(),
    /** The run built a coverage map and did not send it: the callback body would have been too large (a presigned upload is the follow-up). A result with this word names no map. */
    coverageMapSkipped: z.literal("too_large").optional(),
    slowest: z.array(z.object({ id: TestId, durationMs: z.number().int().min(0) }).strict()).max(NIGHTLY_SLOW_MAX),
    /** The step words (SH27). Optional: a result from before them parses exactly as it did, and carries no health. */
    health: NightlyHealthReportSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.tests.total !== result.tests.passed + result.tests.failed + result.tests.skipped) context.addIssue({ code: "custom", path: ["tests", "total"], message: "total is passed, failed and skipped together" });
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) context.addIssue({ code: "custom", path: ["finishedAt"], message: "a run finishes after it starts" });
    if (result.failedUnlisted !== undefined && result.failedUnlisted + result.failed.length > result.tests.failed) context.addIssue({ code: "custom", path: ["failedUnlisted"], message: "the failing tests listed and left out are the failing tests" });
    if (result.coverageMapSkipped !== undefined && result.coverageMapRef !== undefined) context.addIssue({ code: "custom", path: ["coverageMapSkipped"], message: "a map that was not sent is not named" });
    if (new Set(result.failed).size !== result.failed.length || new Set(result.flaky).size !== result.flaky.length) context.addIssue({ code: "custom", path: ["failed"], message: "a test appears once" });
    if (result.flaky.some((id) => result.failed.includes(id))) context.addIssue({ code: "custom", path: ["flaky"], message: "a test that failed again on the rerun is failing, not flaky" });
  });
export type NightlyResult = z.infer<typeof NightlyResultSchema>;

/** What the broker keeps as "the baseline": the latest run's summary. `failedTruncated` is true when the failing set did not fit, and then no failure is excused. */
export const NightlyBaselineSchema = z
  .object({
    recordedAt: z.string().datetime(),
    envRevision: z.number().int().min(1),
    branch: z.string(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    finishedAt: z.string().datetime(),
    tests: z.object({ total: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0) }).strict(),
    failed: z.array(TestId).max(NIGHTLY_FAILED_MAX),
    flaky: z.array(TestId).max(NIGHTLY_FLAKY_MAX),
    coverageMapRef: Sha256.optional(),
    coverageMapBuiltAt: z.string().datetime().optional(),
    /** The failing tests whose ids were left out of `failed` as not valid (see the result). The baseline's failing set is whole when `failed` and this add up to `tests.failed`. */
    failedUnlisted: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();
export type NightlyBaseline = z.infer<typeof NightlyBaselineSchema>;

/** Why a fire did not start a run (fixed words). */
export const NIGHTLY_SKIP_REASONS = ["environment_missing", "nightly_off", "branch_changed", "no_merges", "head_unreadable", "still_running", "already_handled", "stale_fire", "budget", "ran_recently", "owner_unavailable", "workspace_limit", "automatic_cap", "branch_not_default", "registries_unsupported", "services_unsupported"] as const;
export type NightlySkipReason = (typeof NIGHTLY_SKIP_REASONS)[number];

// ---- the coverage map

export const COVERAGE_MAP_FILES_MAX = 20_000;
export const COVERAGE_MAP_BYTES_MAX = 8 * 1_048_576;
/** Which tests touch each source file, from the nightly run (coverage.py dynamic contexts or the like). Test selection reads it; it is only ever as old as its `builtAt`. */
export const CoverageMapSchema = z
  .object({ builtAt: z.string().datetime(), files: z.record(z.string().min(1).max(500), z.array(TestId).max(5_000)) })
  .strict()
  .refine((map) => Object.keys(map.files).length <= COVERAGE_MAP_FILES_MAX, "a map holds at most 20,000 files")
  .refine((map) => JSON.stringify(map).length <= COVERAGE_MAP_BYTES_MAX, "a map is at most 8 MiB");
export type CoverageMapData = z.infer<typeof CoverageMapSchema>;
