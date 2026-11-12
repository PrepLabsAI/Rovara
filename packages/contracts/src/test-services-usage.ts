// Test services, slice 1 T1 (design test-services.md 4.0 and 8.1): what a run's worker reports about the dependencies it started and what the tests called. The broker derives the evidence rows, the PR line and the two
// Prove steps (`dependencies`, `dependency_usage`) from it; the worker's own words never set a label (2.4). It is a RECORD of facts, bounded and in fixed words:
//   - per dependency: whether it started, whether it was healthy, how long the start took, how many times it was reset, and (when it was not healthy) why in a fixed word;
//   - the names the sealed tests asked for that Rovara did not start, as REGISTRABLE DOMAIN + COUNT only (TS-SEAL-1: the sealed DNS helper's record of an unknown name can hold a secret as a label of a name the program
//     tried to reach). A bare name with no dot, an address-shaped name and every name past the list are counted in `otherCount` and never shown.
// Nothing here is a secret, a host the project named, a command's text or an error message. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { TestEnvDependencyIdSchema } from "./test-env-dependency.js";
import { RelativeWorkspacePathSchema } from "./project.js";
import { AWS_KEY_ID, TestServiceHostSchema, looksLikeSecretValue } from "./test-services-shared.js";
import { awsServiceKeyOrSelf } from "./aws-emulator-service-keys.js";

export const TEST_SERVICES_USAGE_SCHEMA_VERSION = 1;
/** The key under which a candidate check's (a preparation's) usage record rides in its result. */
export const TEST_SERVICES_USAGE_RESULT_KEY = "testServicesUsage";
/** Why a dependency is not healthy, in fixed words (never the runtime's own error text). */
export const TEST_SERVICES_START_FAILURES = ["pull_failed", "start_failed", "not_healthy", "seed_failed", "reset_failed"] as const;
export type TestServicesStartFailure = (typeof TEST_SERVICES_START_FAILURES)[number];
export const TEST_SERVICES_USAGE_LIMITS = { dependencies: 16, unknownDomains: 50, count: 1_000_000_000, startMs: 86_400_000, resets: 100_000 } as const;

const Count = z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.count);

/**
 * A registrable domain (`example-pay.com`): a host of at least two labels that cannot be read as an address, and that does not look like a secret. A DNS name arrives lower-cased, so the secret check also reads it in
 * upper case (a lower-cased access key id would otherwise pass: TS-SEAL-1).
 */
export const RegistrableDomainSchema = TestServiceHostSchema.refine((domain) => !looksLikeSecretValue(domain) && !looksLikeSecretValue(domain.toUpperCase()), { message: "a domain, not a secret" });

export const TestServicesDependencyUsageSchema = z
  .object({
    /** The dependency's id in the plan (`postgres`). */
    id: TestEnvDependencyIdSchema,
    started: z.boolean(),
    healthy: z.boolean(),
    /** Milliseconds from the start request until it answered healthy (or gave up). 0 when it never started. */
    startMs: z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.startMs),
    /** How many times it was reset to a clean state between checks or rounds. */
    resetCount: z.number().int().min(0).max(TEST_SERVICES_USAGE_LIMITS.resets),
    failure: z.enum(TEST_SERVICES_START_FAILURES).optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    const problem = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
    if (usage.healthy && !usage.started) problem("healthy", "only a dependency that started can be healthy");
    if (!usage.started && (usage.startMs !== 0 || usage.resetCount !== 0)) problem("started", "a dependency that never started has no start time and no resets");
    // Fail closed: a dependency that is not healthy says why, so the Prove step names a fixed failure and never an empty one. A healthy one may still have failed its seeds or a reset.
    if (!usage.healthy && usage.failure === undefined) problem("failure", "a dependency that is not healthy names its failure");
    if (usage.healthy && usage.failure !== undefined && usage.failure !== "seed_failed" && usage.failure !== "reset_failed") problem("failure", "a healthy dependency can only have failed its seeds or a reset");
  });
export type TestServicesDependencyUsage = z.infer<typeof TestServicesDependencyUsageSchema>;

/** An AWS service key as the emulator's ledger names it (`s3`, `sqs`, `dynamodb`): a short fixed-looking word. */
export const AwsServiceKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/u);
/** An AWS operation name (`PutObject`, `SendMessage`): an upper camel case word. A path, a method or any other text the program chose is not one. */
export const AwsOperationNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{2,63}$/u).refine((name) => !looksLikeSecretValue(name) && !looksLikeSecretValue(name.toUpperCase()), { message: "an operation name, not a secret" });
/**
 * `services` is the most a record lists. `narrowServices` and no `outOfPlan` are what a record keeps when its plan did NOT use `TEST_SERVICES_AWS_ALL_SERVICES_FEATURE` (the worker's `reduceAwsUsage`): a broker from before
 * that feature parses a usage record strictly (at most 24 services, no `outOfPlan`), and such a plan only ever goes to workers its broker could read the record of.
 */
export const TEST_SERVICES_AWS_USAGE_LIMITS = { services: 64, narrowServices: 24, unsupportedOperations: 30, heavyFunctions: 16 } as const;

/**
 * Why a Lambda function is not run by Rovara local AWS itself, in fixed words (never the repository's own text): `image` (a container image), `runtime` (a runtime the emulator does not run), `native-code` (compiled
 * code the emulator cannot load), `x86-native` (x86-only native code on an Arm host), `unchecked` (the function could not be looked at), `timeout-over-28s` (it is allowed to run longer than the emulator waits).
 */
export const TEST_SERVICES_HEAVY_FUNCTION_REASONS = ["image", "runtime", "native-code", "x86-native", "unchecked", "timeout-over-28s"] as const;
export type TestServicesHeavyFunctionReason = (typeof TEST_SERVICES_HEAVY_FUNCTION_REASONS)[number];
/** The words each reason reads as in a sentence (a person reads these on the Prove report, the pull request and the Evidence tab). */
export const TEST_SERVICES_HEAVY_FUNCTION_REASON_WORDS: Readonly<Record<TestServicesHeavyFunctionReason, string>> = {
  image: "it is a container image",
  runtime: "its runtime is not one Rovara local AWS runs",
  "native-code": "it uses native code",
  "x86-native": "it uses x86-only native code",
  unchecked: "it could not be checked",
  "timeout-over-28s": "its timeout is over 28 seconds",
};
/**
 * A Lambda function name as AWS allows it: letters, digits, hyphens and underscores, at most 64. Not one that reads as a secret: an access key id in either case, or one unbroken run of 32 or more letters and digits (a
 * token). The general long-run rule of `looksLikeSecretValue` is not used as it is, because it counts `-` and `_` as part of the run and would refuse an ordinary long name such as `payments-prod-process-order-handler`.
 */
export const AwsFunctionNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u).refine((name) => !AWS_KEY_ID.test(name) && !AWS_KEY_ID.test(name.toUpperCase()) && !(/^[A-Za-z0-9]+$/u.test(name) && looksLikeSecretValue(name)), { message: "a function name, not a secret" });
export const AwsHeavyFunctionSchema = z.object({ name: AwsFunctionNameSchema, reason: z.enum(TEST_SERVICES_HEAVY_FUNCTION_REASONS) }).strict();
export type AwsHeavyFunction = z.infer<typeof AwsHeavyFunctionSchema>;

/**
 * One service of the ledger. `outOfPlan` is how many of its `calls` were to a service the plan did not name (the emulator serves every service, so the code can call one the plan left out): all of them or none.
 * Absent on a record made before the field existed, and on every record of a plan that did not use the all-services feature (the same as 0 when the service is in the plan; the verdict also compares the plan itself).
 */
export const AwsServiceUsageSchema = z
  .object({ service: AwsServiceKeySchema, calls: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count), unsupported: Count, outOfPlan: Count.optional() })
  .strict()
  .superRefine((entry, context) => {
    if (entry.outOfPlan !== undefined && entry.outOfPlan > entry.calls) context.addIssue({ code: "custom", path: ["outOfPlan"], message: "out-of-plan calls are some of the calls" });
  });

/**
 * Slice 2: what Rovara local AWS's request ledger said about a run (`GET /_rovara/ledger/summary`): calls per AWS service, and the operations the emulator does not offer. Present only when an emulator ran. Counts follow the
 * record's bucketing rule (`bucketCount`: 1, 2 to 5, 6 to 20, 21 or more, each shown as its lower bound), and a name is shown only when it is a service key or an operation name the program could not have used to carry a
 * value (the worker's `reduceAwsUsage`); every other call is counted in `otherCalls` and `otherUnsupported` and named nowhere. Never fed back to the agent or a model.
 */
export const TestServicesAwsUsageSchema = z
  .object({
    /**
     * `unreadable`: the ledger could not be read (fail closed: the lists below are empty then and say nothing, not "no calls"). `flooded`: the code made so many different calls that the ledger's summary was past its
     * limits (the emulator's counters are not capped; the reading side is), which is a failure of its own, not a quiet one.
     */
    ledger: z.enum(["read", "unreadable", "flooded"]),
    services: z.array(AwsServiceUsageSchema).max(TEST_SERVICES_AWS_USAGE_LIMITS.services),
    unsupportedOperations: z.array(z.object({ service: AwsServiceKeySchema, operation: AwsOperationNameSchema, count: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count) }).strict()).max(TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations),
    /** Calls to a service that is not shown (an unknown key, or past the list). */
    otherCalls: Count,
    /** Unsupported calls whose service or operation is not shown. */
    otherUnsupported: Count,
    /**
     * The Lambda functions of the plan's own resources that Rovara local AWS does not run itself, each with a fixed reason. Only a worker that lists `TEST_SERVICES_AWS_ALL_SERVICES_FEATURE` writes it (the worker's
     * `reduceAwsUsage`): a broker from before the field parses a record strictly, and such a plan only goes to workers whose records it can read. Absent on every older record, which still parse.
     */
    heavyFunctions: z.array(AwsHeavyFunctionSchema).max(TEST_SERVICES_AWS_USAGE_LIMITS.heavyFunctions).optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.heavyFunctions !== undefined && new Set(usage.heavyFunctions.map((entry) => entry.name)).size !== usage.heavyFunctions.length) context.addIssue({ code: "custom", path: ["heavyFunctions"], message: "a function is listed once" });
    if (usage.ledger !== "read" && usage.heavyFunctions !== undefined && usage.heavyFunctions.length > 0) context.addIssue({ code: "custom", path: ["ledger"], message: "a ledger that was not read says nothing" });
    if (usage.ledger !== "read" && (usage.services.length > 0 || usage.unsupportedOperations.length > 0 || usage.otherCalls > 0 || usage.otherUnsupported > 0)) context.addIssue({ code: "custom", path: ["ledger"], message: "a ledger that was not read says nothing" });
    if (new Set(usage.services.map((entry) => entry.service)).size !== usage.services.length) context.addIssue({ code: "custom", path: ["services"], message: "a service is listed once" });
    if (new Set(usage.unsupportedOperations.map((entry) => `${entry.service}\0${entry.operation}`)).size !== usage.unsupportedOperations.length) context.addIssue({ code: "custom", path: ["unsupportedOperations"], message: "an operation is listed once" });
  });
export type TestServicesAwsUsage = z.infer<typeof TestServicesAwsUsageSchema>;

/**
 * Slice 3: what one fake server's request ledger said about a run. A fake is Rovara's own code answering from a reviewed set, but WHICH requests it was asked is the program's choice, so every count is a coarse bucket (the
 * worker's `bucketCount`) like the other counts of this record, and nothing the program sent (a path, a host, a header, a body) is in it. `ledger: "read"` only when the fake was still running when the round ended, its
 * ledger parsed without a malformed line and was not past its bound (the fake's ledger rules, `parseFakeLedger`); anything else is `unreadable` with every count zero: never "no calls".
 */
export const TestServicesFakeUsageSchema = z
  .object({
    /** The dependency's id in the plan. */
    id: TestEnvDependencyIdSchema,
    ledger: z.enum(["read", "unreadable"]),
    /** Requests answered from the approved set. */
    matched: Count,
    /** Requests nothing in the set matched, answered with an error (policy `fail`): the tests that made them failed. */
    unmatched: Count,
    /** Requests answered with a made-up answer (policy `schema_synth`; not available in slice 3, so always 0 there). */
    synthesized: Count,
    /** Armed faults the fake served. */
    faults: Count,
    /** Calls from an address that is not the run's check sandbox: refused, never counted as the tests'. A sealed round has none. */
    foreign: Count,
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.ledger !== "read" && (usage.matched > 0 || usage.unmatched > 0 || usage.synthesized > 0 || usage.faults > 0 || usage.foreign > 0)) context.addIssue({ code: "custom", path: ["ledger"], message: "a ledger that was not read says nothing" });
  });
export type TestServicesFakeUsage = z.infer<typeof TestServicesFakeUsageSchema>;

export const TestServicesUsageRecordSchema = z
  .object({
    schemaVersion: z.literal(TEST_SERVICES_USAGE_SCHEMA_VERSION),
    dependencies: z.array(TestServicesDependencyUsageSchema).max(TEST_SERVICES_USAGE_LIMITS.dependencies),
    /** Names the sealed tests asked for that no dependency of the run answers (an "unknown call": "Blocked by environment"). */
    unknownCalls: z
      .object({
        /** At most 50, each with how many times it was asked for. */
        domains: z.array(z.object({ domain: RegistrableDomainSchema, count: z.number().int().min(1).max(TEST_SERVICES_USAGE_LIMITS.count) }).strict()).max(TEST_SERVICES_USAGE_LIMITS.unknownDomains),
        /** Calls whose name is not shown: a bare name, an address-shaped name, and every name past the list. */
        otherCount: Count,
      })
      .strict(),
    /** Slice 2: the emulator's ledger as a record of facts (see `TestServicesAwsUsageSchema`). Absent when no emulator ran, so a record without one is slice 1's record byte for byte. */
    aws: TestServicesAwsUsageSchema.optional(),
    /** Slice 3: one row for every fake server the run started, from its ledger. Absent when no fake ran, so a record without one is the earlier slices' record byte for byte. */
    fakes: z.array(TestServicesFakeUsageSchema).max(TEST_SERVICES_USAGE_LIMITS.dependencies).optional(),
    /** Review I3: the seed files the run loaded, with the sha256 of the bytes it loaded (what an approval of a candidate check binds). Absent when none was loaded. */
    seedFiles: z.array(z.object({ id: TestEnvDependencyIdSchema, path: RelativeWorkspacePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(16).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.fakes !== undefined && new Set(record.fakes.map((entry) => entry.id)).size !== record.fakes.length) context.addIssue({ code: "custom", path: ["fakes"], message: "a fake is listed once" });
    if (new Set(record.dependencies.map((entry) => entry.id)).size !== record.dependencies.length) context.addIssue({ code: "custom", path: ["dependencies"], message: "a dependency is listed once" });
    if (new Set(record.unknownCalls.domains.map((entry) => entry.domain)).size !== record.unknownCalls.domains.length) context.addIssue({ code: "custom", path: ["unknownCalls", "domains"], message: "a domain is listed once" });
  });
export type TestServicesUsageRecord = z.infer<typeof TestServicesUsageRecordSchema>;

/** How many calls went to a name no dependency of the run answers (shown names and hidden ones together). */
export function testServicesUnknownCallCount(record: TestServicesUsageRecord): number {
  return record.unknownCalls.domains.reduce((total, entry) => total + entry.count, record.unknownCalls.otherCount);
}

/** The ids of the dependencies that did not start healthy: what the Prove step "start dependencies" fails on. */
export function testServicesUnhealthy(record: TestServicesUsageRecord): string[] {
  return record.dependencies.filter((entry) => !entry.healthy).map((entry) => entry.id);
}

// ---- what the emulator's usage means for a result (the broker's rule, in one place)

/** Why the AWS usage of a run with an emulator is not clean: in the order they are decided. */
export const TEST_SERVICES_AWS_USAGE_PROBLEMS = ["not_checked", "flooded", "out_of_plan", "unsupported"] as const;
export type TestServicesAwsUsageProblem = (typeof TEST_SERVICES_AWS_USAGE_PROBLEMS)[number];
/** The fixed words for each problem (a person reads these on the Prove report, the pull request and the Evidence tab). */
export const TEST_SERVICES_AWS_USAGE_WORDS: Readonly<Record<TestServicesAwsUsageProblem, string>> = {
  not_checked: "AWS usage could not be checked",
  flooded: "AWS usage could not be checked: the code made too many different AWS calls",
  out_of_plan: "The code called AWS services that are not in the plan",
  unsupported: "The code called AWS operations that Rovara local AWS does not support",
};
export type TestServicesAwsUsageVerdict = { ok: true } | { ok: false; problem: TestServicesAwsUsageProblem; /** The service keys outside the plan (out_of_plan only; keys that are not shown are not here). */ services: string[] };

/**
 * Whether the record's AWS usage is clean for a run whose emulator was planned for `planned` services. NOT clean, and never read as a quiet pass, when: the record has no `aws` facts (the ledger was not read at all),
 * the ledger was unreadable or flooded, the code called a service outside the plan (or one the record does not name), or called an operation the emulator does not offer. Call it only when the plan has an emulated entry.
 */
export function testServicesAwsUsageVerdict(usage: TestServicesUsageRecord | undefined, planned: readonly string[]): TestServicesAwsUsageVerdict {
  const aws = usage?.aws;
  if (aws === undefined || aws.ledger === "unreadable") return { ok: false, problem: "not_checked", services: [] };
  if (aws.ledger === "flooded") return { ok: false, problem: "flooded", services: [] };
  // A legacy id and its key are one service, so a plan that spells it one way and a ledger that spells it the other agree.
  const plannedKeys = new Set(planned.map(awsServiceKeyOrSelf));
  const outside = aws.services.filter((entry) => !plannedKeys.has(awsServiceKeyOrSelf(entry.service)) || (entry.outOfPlan ?? 0) > 0).map((entry) => entry.service);
  if (outside.length > 0 || aws.otherCalls > 0) return { ok: false, problem: "out_of_plan", services: outside };
  if (aws.services.some((entry) => entry.unsupported > 0) || aws.unsupportedOperations.length > 0 || aws.otherUnsupported > 0) return { ok: false, problem: "unsupported", services: [] };
  return { ok: true };
}

/**
 * The evidence sentence of one heavy function, in fixed words and the function's own name (which passed `AwsFunctionNameSchema`). While there is no function runner (`runnerAvailable` false):
 * "Lambda function <name> was not run locally (<reason>); the function runner is not available yet". Once there is one: "Lambda function <name> ran in the Rovara function runner (<reason>)".
 */
export function awsHeavyFunctionEvidenceLine(entry: AwsHeavyFunction, options: { runnerAvailable?: boolean } = {}): string {
  const words = TEST_SERVICES_HEAVY_FUNCTION_REASON_WORDS[entry.reason];
  return options.runnerAvailable === true
    ? `Lambda function ${entry.name} ran in the Rovara function runner (${words})`
    : `Lambda function ${entry.name} was not run locally (${words}); the function runner is not available yet`;
}

/** The sentences for a record's heavy functions (none when the record has none, its ledger was not read, or it is an older record). */
export function awsHeavyFunctionEvidenceLines(usage: TestServicesAwsUsage | undefined, options: { runnerAvailable?: boolean } = {}): string[] {
  if (usage === undefined || usage.ledger !== "read") return [];
  return (usage.heavyFunctions ?? []).map((entry) => awsHeavyFunctionEvidenceLine(entry, options));
}

// ---- what a fake's usage means for a result (the broker's rule, in one place)

/** Why the usage of the planned fakes is not clean: in the order they are decided. */
export const TEST_SERVICES_FAKE_USAGE_PROBLEMS = ["not_checked", "foreign", "unmatched"] as const;
export type TestServicesFakeUsageProblem = (typeof TEST_SERVICES_FAKE_USAGE_PROBLEMS)[number];
/** The fixed words for each problem (a person reads these on the Prove report, the pull request and the Evidence tab). */
export const TEST_SERVICES_FAKE_USAGE_WORDS: Readonly<Record<TestServicesFakeUsageProblem, string>> = {
  not_checked: "A fake's requests could not be checked",
  foreign: "Something other than the tests called a fake",
  unmatched: "The tests made requests a fake had no recording for",
};
export type TestServicesFakeUsageVerdict = { ok: true } | { ok: false; problem: TestServicesFakeUsageProblem; /** The planned fakes the problem is about, by id. */ ids: string[] };

/**
 * Whether the record's usage of the fakes the plan started is clean. NOT clean, and never a quiet pass, when: the record has no row for a planned fake or its ledger was not read, a call came from an address that is not the
 * check sandbox, or a request nothing in the set matched (policy `fail`: the test that made it failed, and this keeps the result from reading as a clean run). Call it only when the plan has a fake.
 */
export function testServicesFakeUsageVerdict(usage: TestServicesUsageRecord | undefined, plannedFakeIds: readonly string[]): TestServicesFakeUsageVerdict {
  const rows = new Map((usage?.fakes ?? []).map((entry) => [entry.id, entry]));
  const missing = plannedFakeIds.filter((id) => rows.get(id)?.ledger !== "read");
  if (missing.length > 0) return { ok: false, problem: "not_checked", ids: missing };
  const foreign = plannedFakeIds.filter((id) => (rows.get(id)?.foreign ?? 0) > 0);
  if (foreign.length > 0) return { ok: false, problem: "foreign", ids: foreign };
  const unmatched = plannedFakeIds.filter((id) => (rows.get(id)?.unmatched ?? 0) > 0);
  if (unmatched.length > 0) return { ok: false, problem: "unmatched", ids: unmatched };
  return { ok: true };
}
