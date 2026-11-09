// Proof and evidence (design proof-test-env, section 3.2): the EvidencePack a task's checks, tests, coverage, API samples and browser runs add up to, and the
// view of it the task page reads. Browser-safe: nothing here imports a Node module. The worker writes the raw parts; the BROKER builds the pack, re-redacts every
// text and checks every count against the files, so a worker's own summary is never taken as truth. Every list and string is bounded, every text is one plain line
// (no control or format characters) that readers escape for their own markup, and a pack for any other candidate digest is ignored by the broker.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { TEST_ID_MAX } from "./test-id.js";
import { TestProofVerdictSchema } from "./test-proof.js";
import { TestServicesUsageRecordSchema } from "./test-services-usage.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CountSchema = z.number().int().min(0).max(100_000_000);

/** One line of plain text: no control or format characters (a newline, an escape, a bidirectional override), so no reader can be misled about what a label says. */
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

// ---- check kinds and outcomes

/** What a check is for. The setup agent proposes it and the maintainer confirms it; a check with none is `other`. */
export const CHECK_KINDS = ["test", "lint", "typecheck", "security", "migration", "build", "smoke", "other"] as const;
export const CheckKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof CheckKindSchema>;
/** A check with no recorded kind is `other`. */
export function checkKindOf(kind: CheckKind | undefined): CheckKind {
  return kind ?? "other";
}

/** Browser-safe copies of `CheckOutcomeSchema` and `CheckClassSchema` (checks.ts is Node-only); a contract test keeps them equal. */
export const EVIDENCE_CHECK_OUTCOMES = ["passed", "failed", "timed_out", "unknown", "not_run"] as const;
export const EVIDENCE_CHECK_CLASSES = ["passing", "regression", "already_failing", "fixed", "failing_no_before", "not_rerun"] as const;

// ---- artifacts: kinds, size caps and retention classes

/**
 * Retention classes, applied as an S3 lifecycle tag per artifact kind.
 * evidence-short: video and trace. evidence-std: screenshots, API samples, output tails. evidence-record: the pack itself as a class of record; the stored pack object is tagged evidence-std (it expires with the tails) and is deleted with them on erasure.
 */
export const EVIDENCE_RETENTION_CLASSES = ["evidence-short", "evidence-std", "evidence-record"] as const;
export const EvidenceRetentionClassSchema = z.enum(EVIDENCE_RETENTION_CLASSES);
export type EvidenceRetentionClass = z.infer<typeof EvidenceRetentionClassSchema>;

export const EVIDENCE_ARTIFACT_KINDS = ["jpeg", "webm", "trace_zip", "api_sample_json", "log_txt"] as const;
export const EvidenceArtifactKindSchema = z.enum(EVIDENCE_ARTIFACT_KINDS);
export type EvidenceArtifactKind = z.infer<typeof EvidenceArtifactKindSchema>;

/** The class each kind is kept under. */
export const EVIDENCE_ARTIFACT_RETENTION: Record<EvidenceArtifactKind, EvidenceRetentionClass> = {
  jpeg: "evidence-std",
  webm: "evidence-short",
  trace_zip: "evidence-short",
  api_sample_json: "evidence-std",
  log_txt: "evidence-std",
};

/** The most bytes one artifact of each kind may be; a ref that claims more is refused. */
export const EVIDENCE_ARTIFACT_MAX_BYTES: Record<EvidenceArtifactKind, number> = {
  jpeg: 524_288,
  webm: 20 * 1_048_576,
  trace_zip: 25 * 1_048_576,
  api_sample_json: 16_384,
  log_txt: 65_536,
};

/** The content type each kind is served with, and the magic bytes the store checks before it keeps one (hex). Plain text and JSON have no magic bytes: they are parsed. */
export const EVIDENCE_ARTIFACT_CONTENT_TYPES: Record<EvidenceArtifactKind, string> = {
  jpeg: "image/jpeg",
  webm: "video/webm",
  trace_zip: "application/zip",
  api_sample_json: "application/json",
  log_txt: "text/plain",
};
export const EVIDENCE_ARTIFACT_MAGIC: Partial<Record<EvidenceArtifactKind, string>> = { jpeg: "ffd8ff", webm: "1a45dfa3", trace_zip: "504b0304" };

/** Days an artifact is kept, per class: the default and the range a company may set (Enterprise). The pilot's Public edition keeps the defaults. */
export const EVIDENCE_RETENTION_DAYS = {
  "evidence-short": { default: 14, min: 1, max: 90 },
  "evidence-std": { default: 30, min: 7, max: 180 },
} as const;

/** The days an artifact of `retentionClass` is kept, given a company setting (the default when there is none, and always inside the allowed range). `evidence-record` has no lifecycle rule of its own (the stored pack is tagged evidence-std): null. */
export function evidenceRetentionDays(retentionClass: EvidenceRetentionClass, configured?: number): number | null {
  if (retentionClass === "evidence-record") return null;
  const rule = EVIDENCE_RETENTION_DAYS[retentionClass];
  if (configured === undefined || !Number.isInteger(configured)) return rule.default;
  return Math.min(rule.max, Math.max(rule.min, configured));
}

const EVIDENCE_RETENTION_SETTING_MESSAGE = 'evidenceRetentionDays must be a JSON object such as {"evidence-short": 30, "evidence-std": 60}';
/**
 * The company's days as the infrastructure reads them. An install's recorded settings are text, so the value is JSON text (an object, as `cdk.json` writes it, is accepted too). Text that is not a JSON
 * object is an ERROR, never "use the defaults": a customer who asked for 60 days must not get 14 without being told. Values are checked one by one by `evidenceRetentionDays` (clamped to the range).
 */
export function evidenceRetentionSetting(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === "") return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(EVIDENCE_RETENTION_SETTING_MESSAGE);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(EVIDENCE_RETENTION_SETTING_MESSAGE);
  return parsed as Record<string, unknown>;
}
/** What may be RECORDED as the setting: only the two classes, each a whole number of days inside its allowed range (the infrastructure clamps; a record states what it means). */
export function evidenceRetentionSettingProblem(value: string): string | undefined {
  let setting: Record<string, unknown> | undefined;
  try {
    setting = evidenceRetentionSetting(value);
  } catch (error) {
    return error instanceof Error ? error.message : EVIDENCE_RETENTION_SETTING_MESSAGE;
  }
  for (const [key, days] of Object.entries(setting ?? {})) {
    const rule = (EVIDENCE_RETENTION_DAYS as Record<string, { min: number; max: number } | undefined>)[key];
    if (rule === undefined) return `evidenceRetentionDays names ${JSON.stringify(key.slice(0, 40))}, which is not an evidence class (evidence-short, evidence-std)`;
    if (typeof days !== "number" || !Number.isInteger(days) || days < rule.min || days > rule.max) return `evidenceRetentionDays: ${key} is a whole number of days from ${String(rule.min)} to ${String(rule.max)}`;
  }
  return undefined;
}

/** What the pack holds about one stored artifact: never its bytes. */
export const ArtifactRefSchema = z
  .object({
    kind: EvidenceArtifactKindSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
    retentionClass: EvidenceRetentionClassSchema,
  })
  .strict()
  .superRefine((ref, context) => {
    if (ref.retentionClass !== EVIDENCE_ARTIFACT_RETENTION[ref.kind]) context.addIssue({ code: "custom", path: ["retentionClass"], message: "an artifact is kept under its kind's retention class" });
    if (ref.bytes > EVIDENCE_ARTIFACT_MAX_BYTES[ref.kind]) context.addIssue({ code: "custom", path: ["bytes"], message: "an artifact is no larger than its kind's cap" });
  });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * What the task page gets for an artifact: the ref and the route that serves it (a 60-second presigned URL after a per-request access check), or why there is no route.
 * `href` is present exactly when `state` is `available`.
 */
export const ARTIFACT_LINK_STATES = ["available", "expired", "withheld"] as const;
export const EvidenceHrefSchema = z.string().max(512).regex(/^\/v1\/app\/[A-Za-z0-9/_.~-]+$/u, "a Rovara route");
export const ArtifactLinkSchema = z
  .object({
    kind: EvidenceArtifactKindSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
    retentionClass: EvidenceRetentionClassSchema,
    state: z.enum(ARTIFACT_LINK_STATES),
    href: EvidenceHrefSchema.optional(),
  })
  .strict()
  .superRefine((link, context) => {
    if ((link.state === "available") !== (link.href !== undefined)) context.addIssue({ code: "custom", path: ["href"], message: "href is there exactly when the artifact is available" });
    if (link.retentionClass !== EVIDENCE_ARTIFACT_RETENTION[link.kind]) context.addIssue({ code: "custom", path: ["retentionClass"], message: "an artifact is kept under its kind's retention class" });
    if (link.bytes > EVIDENCE_ARTIFACT_MAX_BYTES[link.kind]) context.addIssue({ code: "custom", path: ["bytes"], message: "an artifact is no larger than its kind's cap" });
  });
export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;

// ---- the pack

export const EVIDENCE_TIERS = ["sandbox", "preview", "shared"] as const;
export const EVIDENCE_SERVICE_MODES = ["preprod", "mocked", "live-forbidden"] as const;
export const EVIDENCE_ACCOUNT_KINDS = ["run_scoped", "registered"] as const;
export const EVIDENCE_SELECTION_METHODS = ["coverage_map", "import_graph", "declared", "full"] as const;
/** Why a video or a trace is not on the page (fixed words, never an error text). */
export const EVIDENCE_WITHHELD_REASONS = ["account_not_run_scoped", "tier_not_allowed", "data_not_synthetic", "company_setting_off", "revocation_not_confirmed", "size_over_cap", "upload_failed"] as const;
export type EvidenceWithheldReason = (typeof EVIDENCE_WITHHELD_REASONS)[number];
export const EVIDENCE_NOT_TESTED_KINDS = ["claim", "scenario", "check", "mocked_service", "not_selected", "environment"] as const;
export const EVIDENCE_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const EVIDENCE_TEST_STATUSES = ["passed", "failed", "skipped", "errored"] as const;

export const EVIDENCE_CHECKS_MAX = 64;
export const EVIDENCE_TEST_NAMES_MAX = 500;
export const EVIDENCE_NEW_TESTS_MAX = 100;
export const EVIDENCE_TEST_NAMES_TOTAL_MAX = 2_000;
export const EVIDENCE_COVERAGE_FILES_MAX = 100;
export const EVIDENCE_UNCOVERED_LINES_MAX = 200;
export const EVIDENCE_FINDINGS_MAX = 100;
export const EVIDENCE_SCENARIOS_MAX = 64;
export const EVIDENCE_API_SAMPLES_MAX = 5;
export const EVIDENCE_STRIP_MAX = 6;
export const EVIDENCE_NOT_TESTED_MAX = 200;

export const EvidenceTestSchema = z
  .object({
    // The test's id (`testIdOf`: file::name), the same string the nightly run and the known-failing marks use.
    name: line(TEST_ID_MAX),
    /** The name is NOT a valid test id (hidden characters, too long, a space at an end): it is shown as a plain line and is never matched against the nightly's failing set or the marks. */
    unlisted: z.literal(true).optional(),
    status: z.enum(EVIDENCE_TEST_STATUSES),
    /** TESTPROOF's verdict for this test, when the check wrote a per-test report and the test is new or changed. */
    proof: TestProofVerdictSchema.optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();
export type EvidenceTest = z.infer<typeof EvidenceTestSchema>;

export const EvidenceFindingSchema = z
  .object({
    ruleId: line(100),
    severity: z.enum(EVIDENCE_FINDING_SEVERITIES),
    path: line(500),
    line: z.number().int().min(1).max(10_000_000),
    /** The tool's message, redacted by the broker and plain text for every reader. */
    message: line(300, 0),
  })
  .strict();
export type EvidenceFinding = z.infer<typeof EvidenceFindingSchema>;

// ---- test services (TS5, design test-services.md 2.4): how each dependency of a run was backed, in fixed words.
// Self-contained on purpose: this file is in the browser entry's exact import graph, so it imports nothing new (the usage record schema is a leaf of that graph already). A contract test keeps `EVIDENCE_BACKING_KINDS` equal to `TEST_ENV_BACKING_KINDS`.
// Replaces: nothing. `environment.services` keeps its old meaning and old packs still parse; a run with test services carries `environment.dependencies` beside it. Readers of the pack are strict, so a reader built before this field REJECTS a pack that carries it: roll out forward only (every reader upgraded before any writer sets the field; the switch `tx` stays off until then).

export const EVIDENCE_BACKING_KINDS = ["local", "project_image", "emulated", "test_account", "fake", "none"] as const;
export type EvidenceBackingKind = (typeof EVIDENCE_BACKING_KINDS)[number];
/** The honesty labels of 2.4, by id. The BROKER computes the label from the pinned plan (`evidenceDependencyLabelFor`); a worker's own words never set it. */
export const EVIDENCE_DEPENDENCY_LABELS = ["real", "real_project_image", "company_approved", "rovara_local_aws", "test_account", "recorded_fake", "hand_written_fake", "faked_by_tests", "not_available"] as const;
export type EvidenceDependencyLabel = (typeof EVIDENCE_DEPENDENCY_LABELS)[number];
/** The backing each label can belong to: a label that does not fit its backing is refused. */
export const EVIDENCE_DEPENDENCY_LABEL_BACKING: Record<EvidenceDependencyLabel, EvidenceBackingKind> = {
  real: "local", real_project_image: "project_image", company_approved: "local", rovara_local_aws: "emulated", test_account: "test_account",
  recorded_fake: "fake", hand_written_fake: "fake", faked_by_tests: "none", not_available: "none",
};
/** The fixed words of each label. `company_approved` is completed with the service by `evidenceDependencyLabelWords`; a fake that made up answers adds "(+N made-up answers)" there too. */
export const EVIDENCE_DEPENDENCY_LABEL_WORDS: Record<EvidenceDependencyLabel, string> = {
  real: "real", real_project_image: "real (your image)", company_approved: "company-approved image", rovara_local_aws: "Rovara local AWS", test_account: "test account",
  recorded_fake: "recorded fake", hand_written_fake: "hand-written fake", faked_by_tests: "faked by your tests", not_available: "not available",
};
/** Why a run used the fallback (a fake, or nothing) in place of the dependency's backing. Fixed words, never an error text. */
export const EVIDENCE_FALLBACK_REASONS = ["test_account_unreachable", "test_account_expired", "test_account_busy", "did_not_start"] as const;
export type EvidenceFallbackReason = (typeof EVIDENCE_FALLBACK_REASONS)[number];
export const EVIDENCE_FALLBACK_REASON_WORDS: Record<EvidenceFallbackReason, string> = {
  test_account_unreachable: "test account unreachable", test_account_expired: "test account expired", test_account_busy: "test account busy", did_not_start: "did not start",
};
export const EVIDENCE_DEPENDENCIES_MAX = 24;
const FAKE_LABELS: readonly EvidenceDependencyLabel[] = ["recorded_fake", "hand_written_fake"];

/** The label a pinned backing earns. A fake of unknown origin is "hand-written", the less trusted of the two words. */
export function evidenceDependencyLabelFor(input: { backing: "local"; substituteImage?: boolean } | { backing: "project_image" } | { backing: "emulated" } | { backing: "test_account" } | { backing: "fake"; recorded: boolean } | { backing: "none"; fakedByTests: boolean }): EvidenceDependencyLabel {
  switch (input.backing) {
    case "local": return input.substituteImage === true ? "company_approved" : "real";
    case "project_image": return "real_project_image";
    case "emulated": return "rovara_local_aws";
    case "test_account": return "test_account";
    case "fake": return input.recorded ? "recorded_fake" : "hand_written_fake";
    case "none": return input.fakedByTests ? "faked_by_tests" : "not_available";
  }
}

/** The words of a label: "company-approved <service> image" names its service (owner Q9), and a fake that made up answers says how many. */
export function evidenceDependencyLabelWords(label: EvidenceDependencyLabel, service: string, madeUpAnswers = 0): string {
  if (label === "company_approved") return `company-approved ${service} image`;
  const words = EVIDENCE_DEPENDENCY_LABEL_WORDS[label];
  return madeUpAnswers > 0 && FAKE_LABELS.includes(label) ? `${words} (+${madeUpAnswers} made-up answers)` : words;
}

export const EvidenceDependencySchema = z
  .object({
    name: line(80),
    backing: z.enum(EVIDENCE_BACKING_KINDS),
    label: z.enum(EVIDENCE_DEPENDENCY_LABELS),
    /** The image that ran (a company-approved image states it). */
    imageDigest: Sha256Schema.optional(),
    /** The fixture set's revision, for a fake. */
    fixtureRevision: z.number().int().min(0).optional(),
    /** When a recorded fake's answers were recorded. */
    recordedAt: z.string().datetime().optional(),
    /** Requests a fake answered without a recording: counted, never hidden. */
    madeUpAnswers: CountSchema.optional(),
    /** Tests that did not run because nothing backed this dependency. */
    testsNotRun: CountSchema.optional(),
    /** The backing this run used instead of the pinned one: the label and the other facts above describe what actually ran. */
    fellBack: z.object({ from: z.enum(["local", "project_image", "emulated", "test_account"]), reason: z.enum(EVIDENCE_FALLBACK_REASONS) }).strict().optional(),
    startedMs: z.number().int().min(0).max(86_400_000).optional(),
    usage: z.object({ requests: CountSchema, unmatched: CountSchema, faults: CountSchema }).strict().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const problem = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    const fake = FAKE_LABELS.includes(entry.label);
    if (EVIDENCE_DEPENDENCY_LABEL_BACKING[entry.label] !== entry.backing) problem("label", "the label belongs to the backing that ran");
    if (entry.label === "company_approved" && entry.imageDigest === undefined) problem("imageDigest", "a company-approved image states the digest it ran");
    if (entry.label === "recorded_fake" && entry.recordedAt === undefined) problem("recordedAt", "a recorded fake states when it was recorded");
    if (entry.label !== "recorded_fake" && entry.recordedAt !== undefined) problem("recordedAt", "only a recorded fake was recorded");
    if (!fake && entry.fixtureRevision !== undefined) problem("fixtureRevision", "only a fake has a fixture revision");
    if (!fake && entry.madeUpAnswers !== undefined) problem("madeUpAnswers", "only a fake makes up answers");
    if (entry.label !== "not_available" && entry.testsNotRun !== undefined) problem("testsNotRun", "only a dependency that was not available has tests that did not run");
    if (entry.fellBack !== undefined && entry.backing !== "fake" && entry.backing !== "none") problem("fellBack", "a fallback is a fake or nothing");
    // A fallback is a fake, or nothing: the tests' own fake (`faked_by_tests`) is not something a run falls back to.
    if (entry.fellBack !== undefined && entry.label !== "recorded_fake" && entry.label !== "hand_written_fake" && entry.label !== "not_available") problem("fellBack", "a fallback is a recorded fake, a hand-written fake or not available");
    if (entry.fellBack !== undefined && entry.fellBack.reason.startsWith("test_account_") && entry.fellBack.from !== "test_account") problem("fellBack", "a test account reason belongs to a fallback from a test account");
    if (entry.usage !== undefined && entry.usage.unmatched > entry.usage.requests) problem("usage", "unmatched requests are some of the requests");
  });
export type EvidenceDependency = z.infer<typeof EvidenceDependencySchema>;

export const EvidenceEnvironmentSchema = z
  .object({
    tier: z.enum(EVIDENCE_TIERS),
    envRevision: z.number().int().min(0),
    services: z
      .array(
        z
          .object({
            name: line(80),
            mode: z.enum(EVIDENCE_SERVICE_MODES),
            fixtureRevision: z.number().int().min(0).optional(),
            schemaVersion: z.number().int().min(1).optional(),
            recordedAt: z.string().datetime().optional(),
            /** Requests a mock answered without a recording (`schema_synth`): counted, never hidden. */
            unrecordedAnswered: CountSchema.optional(),
            /** New mock answers made in this task for cases the change introduced (owner decision Q9), and the digest the broker pinned them by: listed, never silent. */
            newAnswers: CountSchema.optional(),
            newAnswersDigest: Sha256Schema.optional(),
          })
          .strict(),
      )
      .max(32),
    /** Test services (TS5): what backed each dependency of the run. Absent on every pack built before test services, and while they are off. */
    dependencies: z.array(EvidenceDependencySchema).max(EVIDENCE_DEPENDENCIES_MAX).optional(),
    data: z.literal("synthetic"),
    accounts: z.array(z.object({ profileId: line(120), kind: z.enum(EVIDENCE_ACCOUNT_KINDS) }).strict()).max(16),
  })
  .strict();
export type EvidenceEnvironment = z.infer<typeof EvidenceEnvironmentSchema>;
export const EvidenceNotTestedSchema = z.object({ kind: z.enum(EVIDENCE_NOT_TESTED_KINDS), id: line(64), text: line(300, 0), reason: line(100) }).strict();
export type EvidenceNotTested = z.infer<typeof EvidenceNotTestedSchema>;

const SeverityCountsSchema = z.object({ critical: CountSchema, high: CountSchema, medium: CountSchema, low: CountSchema, info: CountSchema }).strict();

/** The parts of a check's evidence that do not hold an artifact: the worker reports them and the broker verifies them. */
export const EvidenceChecksTestsSchema = z
  .object({
    total: CountSchema,
    passed: CountSchema,
    failed: CountSchema,
    skipped: CountSchema,
    errored: CountSchema,
    /** Skips among tests the change did not touch, on the run before (the original code or the baseline) and on this run: a rise is shown as a not-tested reason. Both or neither. */
    skippedBefore: CountSchema.optional(),
    skippedAfter: CountSchema.optional(),
    names: z.array(EvidenceTestSchema).max(EVIDENCE_TEST_NAMES_MAX),
    newTests: z.array(line(TEST_ID_MAX)).max(EVIDENCE_NEW_TESTS_MAX),
  })
  .strict();
export const EvidenceCoverageSchema = z
  .object({
    linesChanged: CountSchema,
    linesCovered: CountSchema,
    files: z.array(z.object({ path: line(500), uncovered: z.array(z.number().int().min(1).max(10_000_000)).max(EVIDENCE_UNCOVERED_LINES_MAX) }).strict()).max(EVIDENCE_COVERAGE_FILES_MAX),
    /** Changed source files (not tests) that the coverage report does not name, so none of their lines is in the counts above. Absent = none (and an older worker never says). */
    unlistedFiles: CountSchema.optional(),
  })
  .strict();
export const EvidenceFindingsSchema = z
  .object({
    tool: line(60),
    newCount: CountSchema,
    bySeverity: SeverityCountsSchema,
    items: z.array(EvidenceFindingSchema).max(EVIDENCE_FINDINGS_MAX),
    /** High or critical findings the scan reported on this code that could not be compared with the original code (no baseline, or one that cannot be trusted): they are NOT in the new-findings counts above. Absent = none. */
    unverified: CountSchema.optional(),
  })
  .strict();
export const EvidenceMigrationsSchema = z.object({ applied: z.array(line(100)).max(50), rolledBack: z.boolean().nullable(), schemaChanges: z.array(line(200)).max(100) }).strict();
export const EvidenceSelectionSchema = z
  .object({
    method: z.enum(EVIDENCE_SELECTION_METHODS),
    selected: CountSchema,
    total: CountSchema,
    mapAgeHours: z.number().int().min(0).max(100_000).optional(),
    fallbackReason: z.enum(["full_suite_on_path", "map_missing", "map_stale", "unknown_file", "over_selected", "no_template"]).optional(),
    lastFullRun: z.object({ at: z.string().datetime(), status: z.enum(["passed", "failed"]), passed: CountSchema, total: CountSchema, flaky: CountSchema }).strict().optional(),
  })
  .strict();

/** Consistency every check's parts must keep, wherever they came from (the worker's raw parts and the broker's pack). */
function checkPartsProblems(entry: { tests?: z.infer<typeof EvidenceChecksTestsSchema> | undefined; coverage?: z.infer<typeof EvidenceCoverageSchema> | undefined; findings?: z.infer<typeof EvidenceFindingsSchema> | undefined }, issue: (path: (string | number)[], message: string) => void): void {
  const tests = entry.tests;
  if (tests !== undefined && tests.total !== tests.passed + tests.failed + tests.skipped + tests.errored) issue(["tests", "total"], "total is passed, failed, skipped and errored together");
  if (tests !== undefined && (tests.skippedBefore === undefined) !== (tests.skippedAfter === undefined)) issue(["tests", "skippedAfter"], "skippedBefore and skippedAfter come together");
  if (tests?.skippedAfter !== undefined && tests.skippedAfter > tests.skipped) issue(["tests", "skippedAfter"], "skips among untouched tests are some of the skips");
  if (entry.coverage !== undefined && entry.coverage.linesCovered > entry.coverage.linesChanged) issue(["coverage", "linesCovered"], "covered lines are some of the changed lines");
  if (entry.findings !== undefined && entry.findings.newCount !== Object.values(entry.findings.bySeverity).reduce((sum, count) => sum + count, 0)) issue(["findings", "newCount"], "newCount is the severities together");
}

export function evidencePackShape<A extends z.ZodType>(artifact: A) {
  const check = z
    .object({
      checkId: line(64),
      kind: CheckKindSchema,
      label: line(200),
      before: z.enum(EVIDENCE_CHECK_OUTCOMES),
      after: z.enum(EVIDENCE_CHECK_OUTCOMES),
      class: z.enum(EVIDENCE_CHECK_CLASSES),
      durationMs: z.number().int().min(0),
      exitCode: z.number().int().nullable().optional(),
      tests: EvidenceChecksTestsSchema.optional(),
      coverage: EvidenceCoverageSchema.optional(),
      findings: EvidenceFindingsSchema.optional(),
      migrations: EvidenceMigrationsSchema.optional(),
      outputTailRef: artifact.optional(),
    })
    .strict()
    .superRefine((entry, context) => checkPartsProblems(entry, (path, message) => context.addIssue({ code: "custom", path, message })));

  const api = z
    .array(z.object({ scenarioId: line(120), samples: z.array(artifact).max(EVIDENCE_API_SAMPLES_MAX), diff: z.enum(["none", "changed", "no_baseline"]), changedPaths: z.array(line(300)).max(50) }).strict())
    .max(EVIDENCE_SCENARIOS_MAX);
  const browser = z
    .array(
      z
        .object({
          scenarioId: line(120),
          strip: z.object({ before: z.array(artifact).max(EVIDENCE_STRIP_MAX), after: z.array(artifact).max(EVIDENCE_STRIP_MAX) }).strict(),
          video: artifact.optional(),
          trace: artifact.optional(),
          /** Absent = NOT MEASURED. No console capture exists yet, so nothing writes this; a reader must never show an absent count as zero. */
          consoleErrors: CountSchema.optional(),
          withheld: z.array(z.object({ artifact: z.enum(["video", "trace"]), reason: z.enum(EVIDENCE_WITHHELD_REASONS) }).strict()).max(2).optional(),
        })
        .strict(),
    )
    .max(EVIDENCE_SCENARIOS_MAX);

  return z
    .object({
      schemaVersion: z.literal(1),
      /** The code the checks ran on. A pack for any other digest is ignored. */
      candidateDigest: Sha256Schema,
      environment: EvidenceEnvironmentSchema,
      checks: z.array(check).max(EVIDENCE_CHECKS_MAX),
      selection: EvidenceSelectionSchema,
      api,
      browser,
      notTested: z.array(EvidenceNotTestedSchema).max(EVIDENCE_NOT_TESTED_MAX),
    })
    .strict()
    .superRefine((pack, context) => {
      const duplicate = (values: readonly string[]) => new Set(values).size !== values.length;
      if (duplicate((pack.environment.dependencies ?? []).map((entry) => entry.name))) context.addIssue({ code: "custom", path: ["environment", "dependencies"], message: "dependency names are unique" });
      if (duplicate(pack.checks.map((entry) => entry.checkId))) context.addIssue({ code: "custom", path: ["checks"], message: "check ids are unique" });
      if (duplicate(pack.environment.services.map((service) => service.name))) context.addIssue({ code: "custom", path: ["environment", "services"], message: "service names are unique" });
      if (duplicate(pack.api.map((entry) => entry.scenarioId))) context.addIssue({ code: "custom", path: ["api"], message: "API scenarios are unique" });
      if (duplicate(pack.browser.map((entry) => entry.scenarioId))) context.addIssue({ code: "custom", path: ["browser"], message: "browser scenarios are unique" });
      if (pack.checks.reduce((sum, entry) => sum + (entry.tests?.names.length ?? 0), 0) > EVIDENCE_TEST_NAMES_TOTAL_MAX) context.addIssue({ code: "custom", path: ["checks"], message: "a pack names at most 2,000 tests in all" });
      if (pack.selection.selected > pack.selection.total) context.addIssue({ code: "custom", path: ["selection", "selected"], message: "selected is some of the total" });
      for (const [index, scenario] of pack.browser.entries()) {
        for (const kind of ["video", "trace"] as const) {
          if (scenario[kind] !== undefined && scenario.withheld?.some((item) => item.artifact === kind) === true) context.addIssue({ code: "custom", path: ["browser", index, "withheld"], message: `${kind} is either there or withheld` });
        }
      }
    });
}

/** What the broker builds from the worker's raw parts and keeps in the artifact store, next to the task's evidence (tagged evidence-std; see rovara-code/evidence-keep.ts). */
export const EvidencePackSchema = evidencePackShape(ArtifactRefSchema);
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

/** What the task page reads (version 2 views, full reads only): the pack with each artifact as a link, or as expired or withheld. */
export const EvidenceViewSchema = evidencePackShape(ArtifactLinkSchema);
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export const EvidenceViewReaderSchema = forwardReader(EvidenceViewSchema);

/**
 * What the worker writes at the end of a CHECKS run (`evidence-raw.json`, through the evidence upload path) and the broker reads as UNTRUSTED input: the parts only a worker can know (a check's test
 * report, coverage, findings, migrations and output tail, the test selection, and the API and browser artifacts it uploaded). The broker takes labels, outcomes and classes from its own check report and
 * the environment from the approved setting, so none of those is here. A file larger than `EVIDENCE_RAW_MAX_BYTES` is not read.
 */
export const EVIDENCE_RAW_ARTIFACT = "evidence-raw.json";
/** The worker feature that reads `evidenceCapture` (a CHECKS run writes `evidence-raw.json`). The broker sends the field only when the proof switch is on, and never to a worker that does not list this. */
export const EVIDENCE_CAPTURE_FEATURE = "task.evidenceCapture.v1" as const;
export const EVIDENCE_RAW_MAX_BYTES = 2 * 1_048_576;
export const EvidenceRawCheckSchema = z
  .object({
    checkId: line(64),
    tests: EvidenceChecksTestsSchema.optional(),
    coverage: EvidenceCoverageSchema.optional(),
    findings: EvidenceFindingsSchema.optional(),
    migrations: EvidenceMigrationsSchema.optional(),
    /** The redacted tail of the check's output; the broker stores it as a `log_txt` artifact. */
    outputTail: z.string().max(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt).optional(),
  })
  .strict()
  .superRefine((entry, context) => checkPartsProblems(entry, (path, message) => context.addIssue({ code: "custom", path, message })));
export const EvidenceRawSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: Sha256Schema,
    checks: z.array(EvidenceRawCheckSchema).max(EVIDENCE_CHECKS_MAX),
    selection: EvidenceSelectionSchema.optional(),
    api: EvidencePackSchema.shape.api.optional(),
    browser: EvidencePackSchema.shape.browser.optional(),
    /** Test services: what the worker saw of the dependencies it started for the round, and the names the sealed tests asked for that no dependency answers. FACTS only: the broker decides every label from the pinned plan. */
    testServices: TestServicesUsageRecordSchema.optional(),
  })
  .strict()
  .superRefine((raw, context) => {
    if (new Set(raw.checks.map((entry) => entry.checkId)).size !== raw.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "check ids are unique" });
  });
export type EvidenceRaw = z.infer<typeof EvidenceRawSchema>;

/** True when the pack is for exactly this candidate. Any other digest means the pack is for other code, and it is ignored. */
export function evidenceIsFor(pack: Pick<EvidencePack, "candidateDigest"> | undefined, candidateDigest: string): boolean {
  return pack !== undefined && pack.candidateDigest === candidateDigest;
}

/** What a page says for a scenario's console error count: the number when one was measured, "not measured" when none was (the count is absent, never zero by default). */
export function consoleErrorsWords(count: number | undefined): string {
  return count === undefined ? "not measured" : count === 1 ? "1 console error" : `${count} console errors`;
}

/** Every artifact link in a view, in a fixed order. */
export function evidenceViewLinks(view: EvidenceView): ArtifactLink[] {
  return [
    ...view.checks.flatMap((entry) => (entry.outputTailRef === undefined ? [] : [entry.outputTailRef])),
    ...view.api.flatMap((scenario) => scenario.samples),
    ...view.browser.flatMap((scenario) => [...scenario.strip.before, ...scenario.strip.after, ...(scenario.video === undefined ? [] : [scenario.video]), ...(scenario.trace === undefined ? [] : [scenario.trace])]),
  ];
}

/**
 * The download contract: an artifact is served only when it is named by the CURRENT pack of the task (the one for the candidate's digest now) and is `available` there. A hash the store happens to hold (a withheld
 * video, a file of an older candidate, another task's file) is never served by this answer. Retention is part of `available`: the view says `expired` once the period has passed.
 */
export function servableEvidenceArtifact(view: EvidenceView | undefined, candidateDigest: string | undefined, sha256: string): ArtifactLink | undefined {
  if (view === undefined || candidateDigest === undefined || view.candidateDigest !== candidateDigest) return undefined;
  return evidenceViewLinks(view).find((link) => link.sha256 === sha256 && link.state === "available");
}

// ---- the proof table's extra words and the pull request's evidence mode

/** The fixed words a proof row's evidence may add after its label (the Proof table's `detail`). Never a test's or a repository's own words. */
export const PROOF_DETAILS = ["fails on old code", "passes on old code too", "not run on old code", "no API diff", "API fields changed", "no baseline to compare", "before and after screenshots"] as const;
export const ProofDetailSchema = z.enum(PROOF_DETAILS);
export type ProofDetail = z.infer<typeof ProofDetailSchema>;

/**
 * What the pull request carries of the evidence (a company setting, lockable; per project when not locked).
 * summary: counts and labels only, no link. link: the same plus a link to the task page behind sign-in. embed (less safe): also the after screenshot of each UI scenario as an image, private repositories only.
 */
export const EVIDENCE_MODES = ["summary", "link", "embed"] as const;
export const EvidenceModeSchema = z.enum(EVIDENCE_MODES);
export type EvidenceMode = z.infer<typeof EvidenceModeSchema>;
/** Owner decision 2026-10-30 (DECISIONS.md, Proof Q8): both editions default to a summary on the pull request plus a link to the full evidence behind sign-in. */
export const EVIDENCE_MODE_DEFAULT: EvidenceMode = "link";

/**
 * The mode a pull request is written with. Fails closed: `embed` is used only for a private repository whose visibility was just read and only when the company allows it
 * (otherwise it is `link`), and an unknown visibility is read as public.
 */
export function resolveEvidenceMode(input: { configured?: EvidenceMode; repositoryVisibility: "private" | "public" | "unknown"; embedAllowed: boolean }): EvidenceMode {
  const mode = input.configured ?? EVIDENCE_MODE_DEFAULT;
  if (mode === "embed" && !(input.embedAllowed && input.repositoryVisibility === "private")) return "link";
  return mode;
}
