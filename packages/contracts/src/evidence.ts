// Proof and evidence (design proof-test-env, section 3.2): the EvidencePack a task's checks, tests, coverage, API samples and browser runs add up to, and the
// view of it the task page reads. Browser-safe: nothing here imports a Node module. The worker writes the raw parts; the BROKER builds the pack, re-redacts every
// text and checks every count against the files, so a worker's own summary is never taken as truth. Every list and string is bounded, every text is one plain line
// (no control or format characters) that readers escape for their own markup, and a pack for any other candidate digest is ignored by the broker.
import { z } from "zod";
import { CHECK_KIND_ID_PATTERN, CHECK_PARTS, PROOF_BASES, EVIDENCE_TRUST_CLASSES, isRegisteredCheckKind, partsOutsideKind } from "./check-kinds.js";
import { inertEvidenceText } from "./evidence-inert.js";
import { forwardReader, safePathKey, setOwnProperty, tolerantRead, type TolerantRead, type TolerantReport } from "./forward-reader.js";
import { TEST_ID_MAX } from "./test-id.js";
import { TestAnswerRecordsSchema } from "./test-answer-labels.js";
import { ABSENT_ON_NEW_MAX, TestProofReasonSchema, TestProofVerdictSchema } from "./test-proof.js";
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

/** Days an artifact is kept, per class: the default and the range a company may set (where the install lets a company choose). Otherwise the defaults apply. */
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
  real: "real", real_project_image: "real (company-approved image)", company_approved: "company-approved image", rovara_local_aws: "Rovara local AWS", test_account: "test account",
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
const testsShape = {
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
};
/** What the WRITER builds and the worker's raw file holds: strict. */
export const EvidenceChecksTestsSchema = z.object(testsShape).strict();
/**
 * What a v1 pack's READERS parse: the same fields, plus two optional ones a later writer sets (TE-B3: `absentOnNew`, the test ids that ran on the original code and are not in this code's report, at most `ABSENT_ON_NEW_MAX`,
 * and `absentOnNewCount`, how many there are in all), and a key it does not know is dropped instead of refusing the whole pack. Readers ship before writers: a writer may add a part to `tests` once every reader has this schema.
 */
export const EvidenceChecksTestsReadSchema = z.object({
  ...testsShape,
  absentOnNew: z.array(line(TEST_ID_MAX)).max(ABSENT_ON_NEW_MAX).optional(),
  absentOnNewCount: CountSchema.optional(),
});
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
  const absent = (tests as { absentOnNew?: unknown[]; absentOnNewCount?: number } | undefined);
  if (absent !== undefined && (absent.absentOnNew === undefined) !== (absent.absentOnNewCount === undefined)) issue(["tests", "absentOnNewCount"], "absentOnNew and absentOnNewCount come together");
  if (absent?.absentOnNew !== undefined && absent.absentOnNewCount !== undefined && absent.absentOnNewCount < absent.absentOnNew.length) issue(["tests", "absentOnNewCount"], "the count is at least the names listed");
  if (entry.coverage !== undefined && entry.coverage.linesCovered > entry.coverage.linesChanged) issue(["coverage", "linesCovered"], "covered lines are some of the changed lines");
  if (entry.findings !== undefined && entry.findings.newCount !== Object.values(entry.findings.bySeverity).reduce((sum, count) => sum + count, 0)) issue(["findings", "newCount"], "newCount is the severities together");
}

export function evidencePackShape<A extends z.ZodType>(artifact: A, reader = false) {
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
      tests: (reader ? EvidenceChecksTestsReadSchema : EvidenceChecksTestsSchema).optional(),
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
/** The same pack as a READER parses it: the `tests` part of a check ignores a key it does not know and accepts TE-B3's two optional ones. The writer keeps `EvidencePackSchema`. */
export const EvidencePackReadSchema = evidencePackShape(ArtifactRefSchema, true);
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

/** What the task page reads (version 2 views, full reads only): the pack with each artifact as a link, or as expired or withheld. */
export const EvidenceViewSchema = evidencePackShape(ArtifactLinkSchema);
/** The view as a READER parses it (the task view that the page and the CLI read): the `tests` part of a check ignores a key it does not know and accepts TE-B3's two optional parts. The broker keeps `EvidenceViewSchema` to build it. */
export const EvidenceViewReadSchema = evidencePackShape(ArtifactLinkSchema, true);
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

// ---- evidence pack v2 (TE-A2a, design testing-build-plan section 3.1): the SHAPE only. Nothing writes a v2 pack yet: the broker keeps writing v1 (`evidencePackShape`, unchanged above) until the gate of TE-A1 and
// the Cloud half (TE-A2-cl) land, and a v1 reader refuses a v2 pack. Replaces: nothing; v1 stays valid. Differences from the sketch, each so a v1 pack converts both ways without loss:
//   - the v1 parts `environment`, `selection`, `api` and `browser` are carried as optional parts (a v2 pack built by Rovara itself may leave them out);
//   - a check keeps v1's `durationMs`, `exitCode` and `outputTailRef`, and `stage`, `command`, `runBy` (who ran it: rovara or imported), `attribution`, `trust` and `proofBasis` are optional;
//   - `proof`, `weakening`, `dependencies`, `tests` and `meters` are optional, because a v1 pack cannot say them;
//   - a not-tested row is `{what, reason}` and may keep v1's `kind` and `id`.
// `EvidencePackV2Schema` is the WRITER's schema (strict, registered kinds only, every cross-check). `readEvidencePack` is the rule READERS use: the core fields are strict, everything else is read as far as it can be by
// `tolerantRead` (unknown fields kept, unknown enum values read as `NEWER_VALUE`, any kind id) and everything it met that it does not know is reported as newer evidence.

export const EVIDENCE_V2_SCHEMA_VERSION = 2 as const;
export const EVIDENCE_EDITIONS = ["cloud", "code"] as const;
/** Where the checks ran. `sealed`: Rovara's sealed round. `sandbox`: the agent's own sandbox (not sealed, O44). `developer_machine`: a person's laptop (O26). `imported`: another system's result Rovara fetched or was sent. */
export const EVIDENCE_ISOLATIONS = ["sealed", "sandbox", "developer_machine", "imported"] as const;
/** The five levels of the first line: never better than the weakest required stage. */
export const EVIDENCE_LEVELS = ["their_ci", "rovara_real_run", "sandbox_only", "no_ci", "ci_not_readable"] as const;
/** The v1 result axis, kept. */
export const EVIDENCE_RESULTS = ["verified", "code_failed", "partially_verified", "blocked_by_environment"] as const;
export const EVIDENCE_CHECK_STAGES = ["sandbox", "sealed", "confirm", "followup", "imported"] as const;
/** Who ran a check (`run_by` in the design): Rovara, or another system whose result was imported. */
export const EVIDENCE_CHECK_RUN_BY = ["rovara", "imported"] as const;
export const EVIDENCE_ATTRIBUTIONS = ["per_test", "per_check", "none"] as const;
export const EVIDENCE_MEASURE_DIRECTIONS = ["up_good", "down_good"] as const;
export const EVIDENCE_MOCK_MADE_IN = ["setup", "this_task", "merged"] as const;
export const EVIDENCE_MOCK_STORES = ["rovara", "repo"] as const;
export const EVIDENCE_RECORDING_STORES = ["customer_bucket", "rovara", "repo", "local_file"] as const;
export const EVIDENCE_REPOSITORIES_MAX = 16;
export const EVIDENCE_MEASURES_MAX = 50;
export const EVIDENCE_PAIRS_MAX = 50;
export const EVIDENCE_PROOF_VERDICTS_MAX = 200;
export const EVIDENCE_WEAKENING_LIST_MAX = 200;
/** The most bytes `readEvidencePack` and `readEvidencePackText` read. A v1 pack is bounded by its parts (about 2 MiB of test names); this leaves room for the v2 parts. */
export const EVIDENCE_V2_MAX_BYTES = 4 * 1_048_576;
/** The deepest nesting `readEvidencePack` reads. */
const EVIDENCE_V2_MAX_DEPTH = 64;

type Mode = "strict" | "reader";
const GitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "a commit id");
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "a date");
const MeasureNumberSchema = z.number().min(-1e12).max(1e12);
const MoneySchema = z.number().min(0).max(1e9);

/** The schemas of a v2 pack. The writer's (`strict`) refuses an unregistered kind and runs every cross-check; the reader's (`reader`, walked by `tolerantRead`) takes any kind id and runs none (the caller makes the few it needs). */
function evidencePackV2Schemas(mode: Mode) {
  const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
  const artifact = ArtifactRefSchema;
  const kind = mode === "strict" ? z.string().regex(CHECK_KIND_ID_PATTERN).refine(isRegisteredCheckKind, "a registered check kind") : line(64);

  const measure = obj({
    name: line(80), unit: line(20), base: MeasureNumberSchema, head: MeasureNumberSchema, spread: z.number().min(0).max(1e12).optional(),
    direction: z.enum(EVIDENCE_MEASURE_DIRECTIONS), band: obj({ low: MeasureNumberSchema, high: MeasureNumberSchema }).optional(),
  });
  const pair = obj({ id: line(80), before: artifact.optional(), after: artifact.optional(), diff: artifact.optional() });

  const checkObject = obj({
    id: line(64),
    kind,
    label: line(200),
    command: line(500).optional(),
    stage: z.enum(EVIDENCE_CHECK_STAGES).optional(),
    before: z.enum(EVIDENCE_CHECK_OUTCOMES),
    after: z.enum(EVIDENCE_CHECK_OUTCOMES),
    class: z.enum(EVIDENCE_CHECK_CLASSES),
    runBy: z.enum(EVIDENCE_CHECK_RUN_BY).optional(),
    durationMs: z.number().int().min(0),
    exitCode: z.number().int().nullable().optional(),
    tests: EvidenceChecksTestsSchema.optional(),
    coverage: EvidenceCoverageSchema.optional(),
    findings: EvidenceFindingsSchema.optional(),
    migrations: EvidenceMigrationsSchema.optional(),
    outputTailRef: artifact.optional(),
    measures: z.array(measure).max(EVIDENCE_MEASURES_MAX).optional(),
    pairs: z.array(pair).max(EVIDENCE_PAIRS_MAX).optional(),
    attribution: z.enum(EVIDENCE_ATTRIBUTIONS).optional(),
    trust: z.enum(EVIDENCE_TRUST_CLASSES).optional(),
    proofBasis: z.enum(PROOF_BASES).optional(),
  });
  const check = mode === "strict"
    ? checkObject.superRefine((entry, context) => {
      const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
      checkPartsProblems(entry, issue);
      const present = CHECK_PARTS.filter((name) => (entry as Record<string, unknown>)[name] !== undefined);
      for (const name of partsOutsideKind(entry.kind, present)) issue([name], `a ${entry.kind} check does not carry ${name}`);
      if (entry.proofBasis !== undefined && entry.trust !== undefined && entry.trust !== "simulated") issue(["trust"], "a change proven with scripted AI replies is simulated, never real");
    })
    : checkObject;

  const dependency = obj({
    name: line(80),
    kind: line(40),
    backing: z.enum(EVIDENCE_BACKING_KINDS),
    label: z.enum(EVIDENCE_DEPENDENCY_LABELS),
    trust: z.enum(EVIDENCE_TRUST_CLASSES),
    recordedOn: DaySchema.optional(),
    mock: obj({ setId: line(120), version: CountSchema, branch: line(200), madeIn: z.enum(EVIDENCE_MOCK_MADE_IN), store: z.enum(EVIDENCE_MOCK_STORES), link: EvidenceHrefSchema.optional() }).optional(),
    recording: obj({ store: z.enum(EVIDENCE_RECORDING_STORES), recordedOn: DaySchema }).optional(),
    protocol: line(40).optional(),
    spec: line(200).optional(),
  });
  const dependencyChecked = mode === "strict"
    ? dependency.superRefine((entry, context) => {
      if (entry.trust === "recorded" && entry.recordedOn === undefined && entry.recording === undefined) context.addIssue({ code: "custom", path: ["recordedOn"], message: "a recorded answer states when it was recorded" });
    })
    : dependency;

  const sections = {
    proof: obj({
      verdicts: z.array(obj({ checkId: line(64).optional(), testId: line(TEST_ID_MAX).optional(), verdict: TestProofVerdictSchema, reason: TestProofReasonSchema.optional() })).max(EVIDENCE_PROOF_VERDICTS_MAX),
      provenCount: CountSchema,
      loadFailureOnOld: CountSchema,
      heldDraft: z.boolean(),
      /** "Mark ready anyway" (O2); the reason stays optional for now (O59). */
      override: obj({ actorId: line(120), at: z.string().datetime(), reason: line(300).optional() }).optional(),
    }).optional(),
    weakening: obj({
      skipRise: obj({ before: CountSchema, after: CountSchema }).optional(),
      removedTests: z.array(line(TEST_ID_MAX)).max(EVIDENCE_WEAKENING_LIST_MAX),
      absentOnNew: z.array(line(TEST_ID_MAX)).max(EVIDENCE_WEAKENING_LIST_MAX),
      changedTestConfig: z.array(line(500)).max(100),
      changedSnapshots: z.array(line(500)).max(100),
      changedFixtures: z.array(line(500)).max(100),
    }).optional(),
    dependencies: z.array(dependencyChecked).max(EVIDENCE_DEPENDENCIES_MAX).optional(),
    tests: TestAnswerRecordsSchema.optional(),
    meters: obj({ modelUsd: MoneySchema, machineMinutes: z.number().min(0).max(1e9), machineUsd: MoneySchema, caps: obj({ modelUsd: MoneySchema, machineMinutes: z.number().min(0).max(1e9) }) }).optional(),
    notTested: z.array(obj({ what: line(300, 0), reason: line(100), kind: z.enum(EVIDENCE_NOT_TESTED_KINDS).optional(), id: line(64).optional() })).max(EVIDENCE_NOT_TESTED_MAX),
    // v1's parts, kept so a v1 pack converts without loss.
    environment: EvidenceEnvironmentSchema.optional(),
    selection: EvidenceSelectionSchema.optional(),
    api: EvidencePackSchema.shape.api.optional(),
    browser: EvidencePackSchema.shape.browser.optional(),
  };
  const core = {
    schemaVersion: z.literal(EVIDENCE_V2_SCHEMA_VERSION),
    candidate: obj({ digest: Sha256Schema, repositories: z.array(obj({ id: line(120), baseBranch: line(200), baseCommit: GitCommitSchema, headCommit: GitCommitSchema })).max(EVIDENCE_REPOSITORIES_MAX) }),
    producer: obj({ edition: z.enum(EVIDENCE_EDITIONS), isolation: z.enum(EVIDENCE_ISOLATIONS) }),
    /** The first line; never better than the weakest required stage. */
    level: obj({ reached: z.enum(EVIDENCE_LEVELS), required: z.array(line(64)).max(16), weakest: obj({ stageId: line(64), words: line(200) }).optional() }),
    result: z.enum(EVIDENCE_RESULTS),
  };
  const packObject = obj({ ...core, checks: z.array(check).max(EVIDENCE_CHECKS_MAX), ...sections });
  const pack = mode === "strict"
    ? packObject.superRefine((entry, context) => {
      const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
      const duplicate = (values: readonly string[]) => new Set(values).size !== values.length;
      if (duplicate(entry.checks.map((item) => item.id))) issue(["checks"], "check ids are unique");
      if (duplicate((entry.dependencies ?? []).map((item) => item.name))) issue(["dependencies"], "dependency names are unique");
      if (entry.checks.reduce((sum, item) => sum + (item.tests?.names.length ?? 0), 0) > EVIDENCE_TEST_NAMES_TOTAL_MAX) issue(["checks"], "a pack names at most 2,000 tests in all");
      if (entry.selection !== undefined && entry.selection.selected > entry.selection.total) issue(["selection", "selected"], "selected is some of the total");
      if (entry.environment !== undefined && duplicate(entry.environment.services.map((item) => item.name))) issue(["environment", "services"], "service names are unique");
      if (entry.api !== undefined && duplicate(entry.api.map((item) => item.scenarioId))) issue(["api"], "API scenarios are unique");
      if (entry.browser !== undefined && duplicate(entry.browser.map((item) => item.scenarioId))) issue(["browser"], "browser scenarios are unique");
      // The first line is never better than where the checks ran (M4): "a real run by Rovara" is only a sealed round, and a change proven with scripted AI replies is never a real run.
      // O44: the final round runs unsealed (labelled "not sealed") while TS-L is held, so a real run in the agent's sandbox is allowed and only the words change (the renderer). A laptop or another system's result is not Rovara's round.
      if (entry.level.reached === "rovara_real_run" && (entry.producer.isolation === "developer_machine" || entry.producer.isolation === "imported")) issue(["level", "reached"], "a real run by Rovara is a round Rovara ran, not a laptop or an imported result");
      if (entry.level.reached === "rovara_real_run" && entry.checks.some((item) => item.proofBasis !== undefined)) issue(["level", "reached"], "a change proven with scripted AI replies is not a real run");
    })
    : packObject;
  return { check, pack, core, sections };
}

const V2_STRICT = evidencePackV2Schemas("strict");
const V2_READER = evidencePackV2Schemas("reader");

/** What the writer builds. Strict: every kind registered, every part one the kind carries, unknown fields refused. */
export const EvidencePackV2Schema = V2_STRICT.pack;
export type EvidencePackV2 = z.infer<typeof EvidencePackV2Schema>;
export type EvidenceCheckV2 = EvidencePackV2["checks"][number];
/** What a reader gives: unknown fields kept, a value of an enum it does not know as `NEWER_VALUE`. */
export type EvidencePackV2Read = TolerantRead<EvidencePackV2>;

const V2_TOP_KEYS = Object.keys(V2_STRICT.pack.shape);
const V2_CORE_KEYS = Object.keys(V2_STRICT.core);
const V2_SECTION_KEYS = Object.keys(V2_STRICT.sections);

/** What a reader met that it does not know. Each list is cut at `NEWER_EVIDENCE_LISTED` entries and every entry is bounded and safe to print (it came from the pack: a path has only letters, digits and `_$-.[]`, a kind is made inert); the flags are exact. */
export interface NewerEvidence {
  /** Fields a newer writer added, by path (`hologram`, `checks[2].coverage.extra`), and parts this reader could not read at all (by path). */
  unknownParts: string[];
  /** Check kinds this build has not registered. */
  unknownKinds: string[];
  /** An enum had a value this build does not know (it reads as `NEWER_VALUE`). */
  unknownValues: boolean;
  /** Checks that could not be read, or were beyond the limit: counted, left out. */
  unreadableChecks: number;
}
export const NEWER_EVIDENCE_LISTED = 20;
const NEWER_PATH_MAX = 120;
const NEWER_KIND_MAX = 40;
export const noNewerEvidence = (): NewerEvidence => ({ unknownParts: [], unknownKinds: [], unknownValues: false, unreadableChecks: 0 });
export function hasNewerEvidence(newer: NewerEvidence): boolean {
  return newer.unknownParts.length > 0 || newer.unknownKinds.length > 0 || newer.unknownValues || newer.unreadableChecks > 0;
}

export type EvidencePackRead =
  | { status: "v1"; pack: EvidencePack }
  | { status: "v2"; pack: EvidencePackV2Read; newer: NewerEvidence }
  | { status: "newer"; schemaVersion: number; candidateDigest?: string }
  | { status: "unreadable"; reason: "not_json" | "too_large" | "not_a_pack" | "core_invalid" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a parsed value is bigger than `limit` bytes (as text, roughly) or nested deeper than the reader reads. Iterative, so a hostile value costs a bounded amount. */
function exceedsReadLimit(value: unknown, limit: number): boolean {
  let bytes = 0;
  let nodes = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    nodes += 1;
    if (depth > EVIDENCE_V2_MAX_DEPTH || nodes > limit) return true;
    if (typeof current === "string") bytes += current.length;
    else if (typeof current === "number") bytes += 8;
    else if (typeof current === "boolean" || current === null) bytes += 5;
    else if (Array.isArray(current)) {
      bytes += 2 + current.length;
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
    } else if (isRecord(current)) {
      for (const [key, item] of Object.entries(current)) {
        bytes += key.length + 4;
        stack.push({ value: item, depth: depth + 1 });
      }
    }
    if (bytes > limit) return true;
  }
  return false;
}

/**
 * The reader rule for every version of the pack. Never throws and never fails on what it does not know:
 *   - a value larger or deeper than the reader reads is `unreadable` (`too_large`), before anything else is done with it;
 *   - version 1: the strict v1 parse, as before (a v1 pack that does not parse is `unreadable`);
 *   - version 2: the core (version, candidate, producer, level, result) is strict, so a pack that cannot say what it is for or where it ran is `unreadable`. Everything else is read by `tolerantRead`: unknown fields are KEPT
 *     (a `__proto__` key too, as an ordinary own key) and reported by path at every level, an enum value it does not know reads as `NEWER_VALUE`, an unknown check kind is kept, a part that cannot be read is left out and
 *     reported, and a check that cannot be read, is inconsistent (covered lines above changed lines, more than 2,000 test names in all) or is beyond the 64-check limit is left out and counted. All of it is in `newer`;
 *   - a later version: `newer`, not parsed, with the candidate digest when it is there.
 */
export function readEvidencePack(input: unknown): EvidencePackRead {
  if (!isRecord(input) || typeof input.schemaVersion !== "number" || !Number.isInteger(input.schemaVersion)) return { status: "unreadable", reason: "not_a_pack" };
  if (exceedsReadLimit(input, EVIDENCE_V2_MAX_BYTES)) return { status: "unreadable", reason: "too_large" };
  if (input.schemaVersion === 1) {
    const parsed = EvidencePackSchema.safeParse(input);
    return parsed.success ? { status: "v1", pack: parsed.data } : { status: "unreadable", reason: "not_a_pack" };
  }
  if (input.schemaVersion > EVIDENCE_V2_SCHEMA_VERSION) {
    const digest = isRecord(input.candidate) && typeof input.candidate.digest === "string" && Sha256Schema.safeParse(input.candidate.digest).success ? input.candidate.digest : undefined;
    return { status: "newer", schemaVersion: input.schemaVersion, ...(digest === undefined ? {} : { candidateDigest: digest }) };
  }
  if (input.schemaVersion !== EVIDENCE_V2_SCHEMA_VERSION) return { status: "unreadable", reason: "not_a_pack" };

  const newer = noNewerEvidence();
  const note = (list: string[], text: string) => { if (list.length < NEWER_EVIDENCE_LISTED) list.push(text); };
  const notePath = (path: string) => note(newer.unknownParts, path.slice(0, NEWER_PATH_MAX));
  const report: TolerantReport = { unknownKey: notePath, newerValue: () => { newer.unknownValues = true; }, unreadable: notePath };
  const out: Record<string, unknown> = {};
  const own = (key: string): unknown => (Object.hasOwn(input, key) ? input[key] : undefined);
  for (const key of Object.keys(input)) {
    if (V2_TOP_KEYS.includes(key)) continue;
    setOwnProperty(out, key, input[key]);
    notePath(safePathKey(key));
  }
  for (const key of V2_CORE_KEYS) {
    const read = tolerantRead((V2_READER.core as Record<string, z.ZodType>)[key]!, own(key), key, report);
    if (!read.ok) return { status: "unreadable", reason: "core_invalid" };
    setOwnProperty(out, key, read.value);
  }
  for (const key of V2_SECTION_KEYS) {
    const raw = own(key);
    if (raw === undefined) {
      if (key === "notTested") setOwnProperty(out, key, []);
      continue;
    }
    const read = tolerantRead((V2_READER.sections as Record<string, z.ZodType>)[key]!, raw, key, report);
    if (read.ok && read.value !== undefined) setOwnProperty(out, key, read.value);
    else {
      if (key === "notTested") setOwnProperty(out, key, []);
      notePath(key);
    }
  }
  const rawChecks = own("checks");
  if (!Array.isArray(rawChecks)) return { status: "unreadable", reason: "core_invalid" };
  const checks: unknown[] = [];
  let namedTests = 0;
  for (const [index, raw] of rawChecks.entries()) {
    const read = index < EVIDENCE_CHECKS_MAX ? tolerantRead(V2_READER.check, raw, `checks[${String(index)}]`, report) : { ok: false as const };
    if (!read.ok) {
      newer.unreadableChecks += 1;
      continue;
    }
    const entry = read.value as Record<string, unknown> & { kind: string; tests?: { names: unknown[] } };
    let consistent = true;
    checkPartsProblems(entry as unknown as Parameters<typeof checkPartsProblems>[0], () => { consistent = false; });
    const names = entry.tests?.names.length ?? 0;
    if (!consistent || namedTests + names > EVIDENCE_TEST_NAMES_TOTAL_MAX) {
      newer.unreadableChecks += 1;
      continue;
    }
    namedTests += names;
    const kindShown = inertEvidenceText(entry.kind, NEWER_KIND_MAX);
    if (!isRegisteredCheckKind(entry.kind) && !newer.unknownKinds.includes(kindShown)) note(newer.unknownKinds, kindShown);
    checks.push(entry);
  }
  setOwnProperty(out, "checks", checks);
  return { status: "v2", pack: out as EvidencePackV2Read, newer };
}

/** `readEvidencePack` for stored text: larger than `EVIDENCE_V2_MAX_BYTES` is refused before it is even encoded (a string is at least as many bytes as it has characters), and text that is not JSON is `unreadable`. */
export function readEvidencePackText(text: string): EvidencePackRead {
  if (text.length > EVIDENCE_V2_MAX_BYTES || (text.length * 3 > EVIDENCE_V2_MAX_BYTES && utf8Length(text) > EVIDENCE_V2_MAX_BYTES)) return { status: "unreadable", reason: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable", reason: "not_json" };
  }
  return readEvidencePack(parsed);
}
/** UTF-8 length without Buffer (this file is browser-safe). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What a v1 pack does not say and a v2 pack must: who ran it, how far it got, and the result. The repositories are unknown to a v1 pack and default to none. */
export interface EvidenceV2Context {
  producer: EvidencePackV2["producer"];
  level: EvidencePackV2["level"];
  result: EvidencePackV2["result"];
  repositories?: EvidencePackV2["candidate"]["repositories"];
}

/** A v1 pack as a v2 pack, with everything v1 held kept (`evidencePackV2ToV1` gives the same v1 pack back). Validate the result with `EvidencePackV2Schema` before storing it. */
export function evidencePackV1ToV2(pack: EvidencePack, context: EvidenceV2Context): EvidencePackV2 {
  return {
    schemaVersion: 2,
    candidate: { digest: pack.candidateDigest, repositories: context.repositories ?? [] },
    producer: context.producer,
    level: context.level,
    result: context.result,
    checks: pack.checks.map(({ checkId, ...rest }) => ({ id: checkId, ...rest })),
    notTested: pack.notTested.map(({ text, ...rest }) => ({ what: text, ...rest })),
    environment: pack.environment,
    selection: pack.selection,
    api: pack.api,
    browser: pack.browser,
  };
}

/**
 * A v2 pack as a v1 pack, for a v1-only reader: what v1 has no place for (producer, level, proof, weakening, dependencies, meters, `measures`, `pairs`) is dropped, and a check kind v1 does not have is `other`.
 * Undefined when the v2 pack does not carry the parts v1 requires (`environment`, `selection`, `api`, `browser`): a pack Rovara built for v2 has no honest v1 form.
 */
export function evidencePackV2ToV1(pack: EvidencePackV2): EvidencePack | undefined {
  if (pack.environment === undefined || pack.selection === undefined || pack.api === undefined || pack.browser === undefined) return undefined;
  const v1Kinds: readonly string[] = CHECK_KINDS;
  return {
    schemaVersion: 1,
    candidateDigest: pack.candidate.digest,
    environment: pack.environment,
    checks: pack.checks.map((entry) => ({
      checkId: entry.id,
      kind: (v1Kinds.includes(entry.kind) ? entry.kind : "other") as CheckKind,
      label: entry.label,
      before: entry.before,
      after: entry.after,
      class: entry.class,
      durationMs: entry.durationMs,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.tests === undefined ? {} : { tests: entry.tests }),
      ...(entry.coverage === undefined ? {} : { coverage: entry.coverage }),
      ...(entry.findings === undefined ? {} : { findings: entry.findings }),
      ...(entry.migrations === undefined ? {} : { migrations: entry.migrations }),
      ...(entry.outputTailRef === undefined ? {} : { outputTailRef: entry.outputTailRef }),
    })),
    selection: pack.selection,
    api: pack.api,
    browser: pack.browser,
    notTested: pack.notTested.map((entry, index) => ({ kind: entry.kind ?? "claim", id: entry.id ?? `item-${String(index + 1)}`, text: entry.what, reason: entry.reason })),
  };
}
