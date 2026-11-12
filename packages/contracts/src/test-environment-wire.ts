// Test environment (wire-testenv): the shapes that cross the wire between the broker and the worker, and the answers of the setup routes.
//
//   TestEnvDraftSchema    what a SETUP_DRAFT run reports when the broker asked it to detect (`testEnvDetect`): the detectors' environment with the source of each value. A DRAFT is never approved or run: the broker
//                         reads it again, refuses anything but the safest tier, and only a maintainer's propose / prove / approve makes it a revision.
//   TestEnvTaskPlanSchema what a CHECKS run is sent when the project has an approved environment: which readiness commands are the environment's checks, how to select tests, the round budget and the nightly's inputs.
//   the route answers     what `GET/POST /v1/app/projects/{name}/test-environment*` say.
//
// The feature strings are what a worker advertises on /ping: an older worker is refused the run at dispatch (a strict parse would refuse the field), never mis-run.
import { z } from "zod";
import { CoverageMapSchema } from "./test-env-nightly.js";
import { CheckKindSchema } from "./evidence.js";
import { ProjectCommandSchema, RelativeWorkspacePathSchema } from "./project.js";
import { SeedScriptLockSchema } from "./seed-script-lock.js";
import {
  CatalogConfigSchema, CatalogIdSchema, ConnectTemplateSchema, DnsLabelSchema, EnvNameSchema, FamilyIdSchema, TEST_ENV_DEPENDENCY_LIMITS, TEST_ENV_DEPENDENCY_RESETS, TEST_ENV_HELPER_CATALOG_NAMES, TEST_ENV_RESERVED_ALIASES,
  IacSeedRefSchema, TestEnvDependencyIdSchema, TestEnvDependencyKindSchema, TestEnvRegionSchema, catalogIdName, testEnvStartedCount,
} from "./test-env-dependency.js";
import { reservedDependencyEnvName } from "./test-services-shared.js";
import { SAGEMAKER_DETECTION_SIGNALS, SageMakerEndpointNameSchema } from "./sagemaker-endpoint.js";
import { AWS_PLAN_SERVICES_MAX, AwsPlanServiceSchema, normaliseAwsServiceKey } from "./aws-emulator-service-keys.js";
import { TEST_ENV_ROUND_BUDGET_MIN, TEST_ENV_SELECTION_METHODS, TEST_ENV_SELECT_PLACEHOLDER, TestEnvValueSourceSchema, TestEnvironmentBodySchema, type TestEnvironmentBody } from "./test-environment.js";

export const TEST_ENV_DETECT_FEATURE = "task.testEnvDetect.v1";
export const TEST_ENV_PLAN_FEATURE = "task.testEnvironment.v1";
/** A worker that lists this reads `checks[].coveragePath` of the plan (the approved report to read changed-line coverage from). A worker that does not is sent the plan without that field (informational only), because its strict parse would refuse it. */
export const TEST_ENV_COVERAGE_PATH_FEATURE = "task.testEnvCoveragePath.v1";
/**
 * Test services (slice 1): a worker that lists this reads `testEnvironment.dependencies` of the plan (the dependencies to start, pinned by digest) and runs the check rounds sealed. A worker that does not is never sent a plan with
 * the field (its strict parse would refuse it): the broker refuses the run to such a worker at dispatch (`ec2-delivery.ts`). Also in `WORKER_INVOCATION_FEATURES`; the worker lists it in `implemented-features.ts` when it can do both.
 */
export const TEST_SERVICES_PLAN_FEATURE = "task.testServices.v1";
/**
 * Test services (slice 2): a worker that lists this reads a plan dependency with `backing: "emulated"` and its `aws` block (Rovara local AWS for S3, SQS and DynamoDB). It also lists `TEST_SERVICES_PLAN_FEATURE`. A worker that does
 * not is never sent such a plan (its strict parse would refuse the field): the broker refuses the run to it at dispatch (`ec2-delivery.ts`). In `WORKER_INVOCATION_FEATURES`; the worker lists it only when it can start the emulator.
 */
export const TEST_SERVICES_AWS_PLAN_FEATURE = "task.testServices.aws.v1";
/**
 * Test services (slice 3): a worker that lists this reads a plan dependency with `backing: "fake"` and its `fake` block (the digest of an approved fixture set), starts the fake server from its own image for each phase and
 * fetches the set through the `fixture-set` callback at the start of the phase. It also lists `TEST_SERVICES_PLAN_FEATURE`. A worker that does not is never sent such a plan: the broker refuses the run to it at dispatch
 * (`ec2-delivery.ts`). In `WORKER_INVOCATION_FEATURES`.
 */
export const TEST_SERVICES_FAKE_PLAN_FEATURE = "task.testServices.fake.v1";
/**
 * Company-approved extra images (switch `pj`): a worker that lists this reads a plan dependency with `backing: "company"` and its `company` block (an image a company admin approved, by registry, repository and digest) and can
 * start exactly that digest. No worker lists it yet, so the broker never sends such a plan to any worker (`ec2-delivery.ts`); a worker that does not know the backing refuses it by its strict parse, and one that knows it and
 * cannot serve it refuses it by name. In `WORKER_INVOCATION_FEATURES`.
 */
export const TEST_SERVICES_COMPANY_IMAGE_PLAN_FEATURE = "task.testServices.companyImage.v1";
/**
 * TS-UX-1 item 9: a worker that lists this loads a dependency's seed FILE (`seeds[].fixturePath`) into its test database. An older worker failed such a seed ("not available yet"); the broker never sends it a plan with a
 * file seed (`ec2-delivery.ts`). In `WORKER_INVOCATION_FEATURES`.
 */
export const TEST_SERVICES_FILE_SEED_FEATURE = "task.testServices.fileSeed.v1";
/** SEED-RISK-1: a worker that checks a seed command's `lock` (re-hashes the repository's seed script from its checkout, refuses on a difference). A plan with a locked seed goes only to such a worker. */
export const TEST_SERVICES_SEED_LOCK_FEATURE = "task.testServices.seedLock.v1";
/**
 * A worker that lists this reads a plan whose `aws.services` names any service of the generated table (`AWS_EMULATOR_SERVICES`). A worker without it only accepts the three services of `SEEDED_AWS_SERVICES`, so the
 * broker adds this feature to a plan with any other service (`featuresForTestPlan`, which the delivery guard reads) and the run goes only to a worker that lists it. It is in `WORKER_INVOCATION_FEATURES`; a worker
 * advertises it with the other test-services features (`testServicesAdvertisedFeatures`), when it can run an emulated plan at all.
 */
export const TEST_SERVICES_AWS_ALL_SERVICES_FEATURE = "task.testServices.aws.allServices.v1";
/**
 * The three AWS services a worker WITHOUT `TEST_SERVICES_AWS_ALL_SERVICES_FEATURE` accepts in a plan (what could be seeded before that feature). This is the old worker's list, kept for the feature check; the services Rovara
 * now seeds are `AWS_SEEDED_KINDS`, and any other service of the table starts empty.
 */
export const SEEDED_AWS_SERVICES = ["s3", "sqs", "dynamodb"] as const;
/**
 * Whether a plan's services need `TEST_SERVICES_AWS_ALL_SERVICES_FEATURE`: any of them is not one a worker without the feature accepts, or the list is longer than the three such a worker takes (so a list of repeated
 * names cannot slip past it; the environment's own schema lists a service once, but the plan's does not). Legacy spellings are read as their keys. This is the broker's fence for the wider environment cap
 * (`TEST_ENV_DEPENDENCY_LIMITS.awsServices`): a plan that is not wide never goes to a worker that would refuse it, and a wide one goes only to a worker that lists the feature.
 */
export function awsPlanNeedsAllServices(services: readonly string[]): boolean {
  return services.length > SEEDED_AWS_SERVICES.length || services.some((service) => !(SEEDED_AWS_SERVICES as readonly string[]).includes(normaliseAwsServiceKey(service) ?? service));
}

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

/** The most inline coverage map a CHECKS run is sent: a larger one is not sent (the run then selects nothing and runs the whole check). */
export const TEST_ENV_PLAN_MAP_MAX_BYTES = 256 * 1_024;
export const TEST_ENV_PLAN_FAILURES_MAX = 500;

/** A service the code calls that the detectors found, listed so a person can decide; it is not part of the environment (a mocked service needs a recorded fixture set first). */
export const TestEnvPendingServiceSchema = z.object({ kind: z.enum(["sagemaker_runtime", "http"]), target: line(253) }).strict();
export type TestEnvPendingService = z.infer<typeof TestEnvPendingServiceSchema>;

// ---- dependency candidates (what the detectors found, in a draft)

/** Things a detector saw that Rovara would refuse to run as written (compose / CI / dev container). Fixed words, never repository text. Mirrors the worker's `DEPENDENCY_REFUSED_FIELDS`. */
export const TEST_ENV_CANDIDATE_REFUSED_FIELDS = ["privileged", "host_network", "host_pid", "host_ipc", "host_volume", "docker_socket", "cap_add", "devices", "build"] as const;
export const TEST_ENV_CANDIDATE_STRENGTHS = ["declared", "used", "mentioned"] as const;
export const TEST_ENV_CANDIDATE_MAX = 64;
export const TEST_ENV_SEED_COMMANDS_MAX = 8;

const CandidateKeyAttribute = z.object({ name: line(255), type: z.enum(["S", "N", "B"]) }).strict();
const CandidateResource = z
  .object({
    kind: z.enum(["table", "bucket", "queue", "topic", "secret", "parameter", "key", "bus", "rule"]),
    name: line(300),
    keySchema: z.object({ partitionKey: CandidateKeyAttribute, sortKey: CandidateKeyAttribute.optional() }).strict().optional(),
  })
  .strict();

/**
 * One dependency a detector found (test services D1-D7), as it rides in a setup draft. UNTRUSTED like the rest of the draft: every field is a family id, a kind, a fixed word, a number, a variable NAME or a repository path
 * (never a value read from a file: no host, password or token). It is not a `TestEnvDependency`: the broker turns a candidate into a proposed dependency only through `chooseBacking`, and a person approves it.
 * Mirrors the worker's `DependencyCandidate` (`env-detect/types.ts`).
 */
export const TestEnvDependencyCandidateSchema = z
  .object({
    family: FamilyIdSchema,
    kind: TestEnvDependencyKindSchema,
    /** Where it was seen: files and lines, at least one and at most 8. */
    evidence: z.array(z.object({ path: line(500), line: z.number().int().min(1).max(10_000_000) }).strict()).min(1).max(TEST_ENV_DEPENDENCY_LIMITS.sources),
    strength: z.enum(TEST_ENV_CANDIDATE_STRENGTHS),
    hints: z
      .object({
        version: z.string().regex(/^\d{1,3}$/u).optional(),
        envNames: z.array(EnvNameSchema).max(16).optional(),
        ports: z.array(z.number().int().min(1).max(65_535)).max(8).optional(),
        hasHealthcheck: z.boolean().optional(),
        initFiles: z.array(RelativeWorkspacePathSchema).max(4).optional(),
        dependsOn: z.array(line(80)).max(16).optional(),
        refused: z.array(z.enum(TEST_ENV_CANDIDATE_REFUSED_FIELDS)).max(TEST_ENV_CANDIDATE_REFUSED_FIELDS.length).optional(),
        explicitEndpoint: z.boolean().optional(),
        fakedByTests: z.boolean().optional(),
        testcontainers: z.boolean().optional(),
        /** The settings that name it, parsed down to the scheme and the host FAMILY; never the host. */
        url: z.object({ scheme: line(32), hostFamily: z.enum(["local", "private", "cloud", "unknown"]) }).strict().optional(),
        resources: z.array(CandidateResource).max(TEST_ENV_DEPENDENCY_LIMITS.candidateResources).optional(),
        /** An AWS service no seed handler creates resources for: its emulator starts empty and the tests create their resources. */
        startsEmpty: z.boolean().optional(),
        /** SM4: the SageMaker endpoint names the code, its settings or its infrastructure code write as literals (SageMaker's own name pattern), and fixed words for what else a detector saw. */
        endpointNames: z.array(SageMakerEndpointNameSchema).max(16).optional(),
        sagemakerSignals: z.array(z.enum(SAGEMAKER_DETECTION_SIGNALS)).max(SAGEMAKER_DETECTION_SIGNALS.length).optional(),
        seenBy: z.array(line(40)).max(8).optional(),
      })
      .strict(),
  })
  .strict();
export type TestEnvDependencyCandidate = z.infer<typeof TestEnvDependencyCandidateSchema>;

export const TestEnvDraftSchema = z
  .object({
    environment: TestEnvironmentBodySchema,
    valueSources: z.array(z.object({ field: line(200), source: TestEnvValueSourceSchema }).strict()).max(400),
    pendingServices: z.array(TestEnvPendingServiceSchema).max(32),
    /**
     * Test services: the dependencies the detectors found (CANDIDATES, not an environment). Absent unless a detector found one, so a draft with none is today's draft byte for byte. This is a different thing from
     * `environment.dependencies`: a draft's environment must carry none (a worker cannot approve a backing); the broker turns these candidates into proposed dependencies through `chooseBacking` (`sanitizeTestEnvDraft`).
     */
    dependencies: z.array(TestEnvDependencyCandidateSchema).max(TEST_ENV_CANDIDATE_MAX).optional(),
    /**
     * TS-UX-1: commands that fill or migrate a database (`npm run seed`), found in the repository or proposed by the setup agent, and kept OUT of the environment's setup commands (setup has no database). The broker
     * offers them as the seed of the database dependency it proposes (`sanitizeTestEnvDraft`); a person approves it, as a seed command is always a less-safe change. Absent when none.
     */
    seedCommands: z.array(z.object({ command: ProjectCommandSchema, source: TestEnvValueSourceSchema }).strict()).max(TEST_ENV_SEED_COMMANDS_MAX).optional(),
    /**
     * TS-UX-1 item 9: SQL files of test data found in the repository (workspace-relative, as a seed's `fixturePath`). The broker offers them as the database dependency's FILE seed, preferred over a seed command (a file
     * is SQL the database's own client runs as a role with no superuser rights, in the sealed test database; it cannot reach the network or a secret). Absent when none.
     */
    seedFiles: z.array(z.object({ path: RelativeWorkspacePathSchema, source: TestEnvValueSourceSchema }).strict()).max(TEST_ENV_SEED_COMMANDS_MAX).optional(),
    /** Fixed statements for the maintainer (what was found that the proposal cannot use, and what is not known). */
    notes: z.array(line(400)).max(60),
    questions: z.array(line(400)).max(60),
  })
  .strict()
  // A worker never proposes a backing: what it reports is candidates, and the environment of its draft carries no dependencies. The broker proposes dependencies itself (`sanitizeTestEnvDraft`), after this parse.
  .superRefine((draft, context) => {
    if ((draft.environment.dependencies?.length ?? 0) > 0) context.addIssue({ code: "custom", path: ["environment", "dependencies"], message: "a draft reports dependency candidates; its environment holds no dependencies" });
  });
export type TestEnvDraft = z.infer<typeof TestEnvDraftSchema>;

/** The most a draft may weigh once serialized (worker and broker both hold to it): well under DynamoDB's 400 KB item limit, which would cancel the setup draft's own result write. */
export const TEST_ENV_DRAFT_MAX_BYTES = 200 * 1_024;

/** The key under which a draft rides in a SETUP_DRAFT run's result. */
export const TEST_ENV_DRAFT_RESULT_KEY = "testEnvironmentDraft";
/**
 * TS-UX-1 item 6: why a SETUP_DRAFT run that ran the detectors reports no draft (`no_test_command`: the detectors found no command that runs the tests, or nothing they found could be put together; `failed`: the
 * detection itself failed). Present only when detection ran and made no draft, so a result with neither key is a worker that did not run detection (an older one, or the field was not sent).
 */
export const TEST_ENV_DRAFT_NONE_KEY = "testEnvironmentDraftNone";
export const TEST_ENV_DRAFT_NONE_REASONS = ["no_test_command", "failed"] as const;
export type TestEnvDraftNoneReason = (typeof TEST_ENV_DRAFT_NONE_REASONS)[number];

/**
 * Test services: one dependency of a task's run as the worker starts it. Everything is a pin or a name, never a secret: the catalog entry and image digest the broker chose (the worker checks its own signed catalog agrees
 * on the digest and refuses otherwise), the names the code reaches it by, the connection TEMPLATES (the worker fills `{user}`, `{password}` and the rest at run time; the run's own password never rides here), the seeds
 * and the reset. Slice 1 starts real software from the catalog only (`backing: "local"`); a later slice that starts anything else lists it under a new feature string.
 */
export const TaskDependencyPlanSchema = z
  .object({
    id: TestEnvDependencyIdSchema,
    name: line(80),
    kind: TestEnvDependencyKindSchema,
    family: FamilyIdSchema,
    /**
     * `local`: real software from the catalog. `emulated` (slice 2): Rovara local AWS, with the `aws` block below; every emulated entry of one plan names the same image, and all of them share one helper.
     * `fake` (slice 3): the fake server, from the worker's own image, serving the approved fixture set the `fake` block names.
     */
    backing: z.enum(["local", "emulated", "fake", "company"]),
    catalogId: CatalogIdSchema,
    /** The repository under the install's registry (`svc/postgres`); the registry host is the install's. */
    repository: z.string().regex(/^svc\/[a-z0-9][a-z0-9._-]{0,62}$/u),
    /** The image digest the catalog pinned: required, because an unpinned image is never started. A fake has none: its server is the worker's own image (the catalog marks it a worker-image helper). */
    digest: Sha256.optional(),
    /**
     * Only on a `fake` entry: the digest of the approved fixture set the fake serves, and what it does with a request nothing in the set matches. NOT a URL: a 15-minute read address would expire before the round, so the
     * worker asks the broker for a fresh one at the start of each phase (the `fixture-set` callback), and holds the downloaded set to this digest. `fail` is the only policy this slice carries: a request with no
     * recording is answered with an error and counted (a made-up answer is not available yet).
     */
    fake: z.object({ fixtureSetRef: Sha256, unmatched: z.literal("fail") }).strict().optional(),
    /**
     * Only on a `company` entry (switch `pj`): the image a company admin approved, so a company image is never dressed as one of Rovara's catalog images. `imageId` is the approval's id (it names the digest), `registry` and
     * `repository` say where the image comes from, and `digest` is the approved digest (equal to the plan's `digest`). `catalogId` is then only the catalog entry whose RUN PROFILE the image runs with (user, memory, ports,
     * health check, reset), never the source of the image.
     */
    company: z.object({ imageId: z.string().regex(/^img_[a-f0-9]{20}$/u), registry: z.string().min(4).max(253), repository: z.string().min(1).max(250), digest: Sha256 }).strict().optional(),
    /** Names and files carried over from the project (database, user, extensions, init files); no password. */
    config: CatalogConfigSchema,
    aliases: z.array(DnsLabelSchema).max(TEST_ENV_DEPENDENCY_LIMITS.hostAliases),
    connect: z.array(z.object({ name: EnvNameSchema, template: ConnectTemplateSchema }).strict()).max(TEST_ENV_DEPENDENCY_LIMITS.connectEnv),
    /**
     * The dependency's seeds. Review I3 (owner decision 12, SEED-FILE-LOCK): a file seed of a plan made from an APPROVED environment names the sha256 the approval bound, and the worker refuses a file whose content
     * differs. A candidate check's plan names none (it loads the file and reports the sha256 it loaded, which the approval binds). SEED-RISK-1: a command seed may carry the broker's `lock` (seed-script-lock.ts); the
     * worker re-hashes it from its checkout before every run and refuses on a difference.
     */
    seeds: z.array(z.union([z.object({ command: ProjectCommandSchema, lock: SeedScriptLockSchema.optional() }).strict(), z.object({ fixturePath: RelativeWorkspacePathSchema, sha256: Sha256.optional() }).strict()])).max(TEST_ENV_DEPENDENCY_LIMITS.seeds),
    reset: z.enum(TEST_ENV_DEPENDENCY_RESETS),
    /** Only on an `emulated` entry: the AWS services this dependency needs from Rovara local AWS, the region the code is told, and where the project declares its resources (a file, never read by the broker). */
    aws: z.object({ services: z.array(AwsPlanServiceSchema).min(1).max(AWS_PLAN_SERVICES_MAX), region: TestEnvRegionSchema, resources: IacSeedRefSchema.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if (plan.backing === "local" && (TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(catalogIdName(plan.catalogId))) problem(["catalogId"], "a local dependency is real software from the catalog, not one of Rovara's helpers");
    if (plan.backing === "local" && plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    if (plan.backing === "company") {
      if ((TEST_ENV_HELPER_CATALOG_NAMES as readonly string[]).includes(catalogIdName(plan.catalogId))) problem(["catalogId"], "a company image runs with the profile of real software from the catalog, not of one of Rovara's helpers");
      if (plan.company === undefined) problem(["company"], "a company image names the approval it runs");
      else if (plan.company.digest !== plan.digest) problem(["company", "digest"], "a company image runs exactly the digest that was approved");
      if (plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    } else if (plan.company !== undefined) problem(["company"], "only a company image names an approval");
    if (plan.backing === "fake") {
      if (catalogIdName(plan.catalogId) !== "fake-server") problem(["catalogId"], "a fake dependency runs the fake server");
      if (plan.fake === undefined) problem(["fake"], "a fake dependency names its fixture set");
      if (plan.digest !== undefined) problem(["digest"], "the fake server is the worker's own image: it has no image digest");
      if (plan.aws !== undefined) problem(["aws"], "only an emulated dependency has AWS services");
    } else {
      if (plan.digest === undefined) problem(["digest"], "an image that is started is pinned by digest");
      if (plan.fake !== undefined) problem(["fake"], "only a fake dependency has a fixture set");
    }
    if (plan.backing === "emulated") {
      if (catalogIdName(plan.catalogId) !== "local-aws") problem(["catalogId"], "an emulated dependency runs Rovara local AWS");
      if (!plan.family.startsWith("aws:")) problem(["family"], "Rovara local AWS backs AWS families only");
      if (plan.aws === undefined) problem(["aws"], "an emulated dependency names its AWS services");
      else {
        if (new Set(plan.aws.services).size !== plan.aws.services.length) problem(["aws", "services"], "a service is listed once");
        if (plan.family.startsWith("aws:") && !(plan.aws.services as readonly string[]).includes(normaliseAwsServiceKey(plan.family.slice(4)) ?? plan.family.slice(4))) problem(["aws", "services"], "the services include the family's own service");
      }
    }
    if (new Set(plan.aliases).size !== plan.aliases.length) problem(["aliases"], "an alias is listed once");
    plan.aliases.forEach((alias, index) => {
      if ((TEST_ENV_RESERVED_ALIASES as readonly string[]).includes(alias)) problem(["aliases", index], "this name belongs to a Rovara helper");
    });
    if (new Set(plan.connect.map((entry) => entry.name)).size !== plan.connect.length) problem(["connect"], "a variable is set once");
    plan.connect.forEach((entry, index) => {
      if (reservedDependencyEnvName(entry.name)) problem(["connect", index, "name"], "this variable is set by Rovara or the system, not by a dependency");
    });
  });
export type TaskDependencyPlan = z.infer<typeof TaskDependencyPlanSchema>;

/** The most dependencies one run starts (the Rovara maximum; the default cap is lower and the broker applies it). */
export const TASK_DEPENDENCY_PLAN_MAX = TEST_ENV_DEPENDENCY_LIMITS.startedMax;

export const TestEnvTaskPlanSchema = z
  .object({
    revision: z.number().int().min(1),
    /** The approved environment's digest (`testEnvDigest`): the worker echoes it into the evidence, the broker compares it. */
    digest: Sha256,
    roundBudgetMin: z.number().int().min(TEST_ENV_ROUND_BUDGET_MIN.min).max(TEST_ENV_ROUND_BUDGET_MIN.max),
    selection: z
      .object({
        method: z.enum(TEST_ENV_SELECTION_METHODS),
        declared: z.array(z.object({ glob: z.string().min(1).max(256), tests: z.array(z.string().min(1).max(256)).min(1).max(50) }).strict()).max(100).optional(),
        alwaysRun: z.array(Id).max(32),
        fullSuiteOn: z.array(z.string().min(1).max(256)).max(100),
      })
      .strict(),
    /** Readiness command `i` of the run is the environment's check `checks[i]`, for `i < checks.length`: the run's first commands are the environment's checks, in order. */
    checks: z.array(z.object({ id: Id, kind: CheckKindSchema, coveragePath: RelativeWorkspacePathSchema.optional(), selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict()
      .superRefine((check, context) => {
        if (check.selectArgs !== undefined && check.selectArgs.filter((arg) => arg === TEST_ENV_SELECT_PLACEHOLDER).length !== 1) context.addIssue({ code: "custom", path: ["selectArgs"], message: "selectArgs holds {tests} exactly once" });
      })).min(1).max(32),
    /** The tests that failed in the last nightly: they always run. */
    lastNightlyFailures: z.array(z.string().min(1).max(500)).max(TEST_ENV_PLAN_FAILURES_MAX).optional(),
    /** The nightly's coverage map, only when it fits (`TEST_ENV_PLAN_MAP_MAX_BYTES`); without it a coverage-map selection runs the whole check, with its reason. */
    coverageMap: CoverageMapSchema.optional(),
    /**
     * Test services: the dependencies this run starts, pinned. Present only when the switch `tx` is on, the project's approved environment has dependencies and the plan could pin every one of them (otherwise the run is
     * refused before dispatch, never sent half a plan); absent otherwise, so a plan without test services is today's plan byte for byte. Sent only to a worker whose /ping lists `TEST_SERVICES_PLAN_FEATURE`. Never empty.
     */
    dependencies: z.array(TaskDependencyPlanSchema).min(1).max(TASK_DEPENDENCY_PLAN_MAX).optional(),
  })
  .strict()
  .refine((plan) => plan.coverageMap === undefined || JSON.stringify(plan.coverageMap).length <= TEST_ENV_PLAN_MAP_MAX_BYTES, { message: "an inline coverage map is at most 256 KiB", path: ["coverageMap"] })
  .superRefine((plan, context) => {
    const dependencies = plan.dependencies ?? [];
    const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
    if (!unique(dependencies.map((dependency) => dependency.id))) context.addIssue({ code: "custom", path: ["dependencies"], message: "dependency ids are unique" });
    if (!unique(dependencies.flatMap((dependency) => dependency.connect.map((entry) => entry.name)))) context.addIssue({ code: "custom", path: ["dependencies"], message: "two dependencies set the same variable" });
    if (!unique(dependencies.flatMap((dependency) => dependency.aliases))) context.addIssue({ code: "custom", path: ["dependencies"], message: "two dependencies use the same alias" });
  });
export type TestEnvTaskPlan = z.infer<typeof TestEnvTaskPlanSchema>;

// ---- fixture delivery (slice 3)

/**
 * `POST .../operations/{o}/fixture-set`: the worker's request, at the start of a phase that serves a fake, for a fresh read address of ONE approved fixture set. It names the digest the pinned plan named and nothing else: the
 * organisation, the project and the task come from the operation the capability belongs to, never from the body.
 */
export const FixtureSetCallbackRequestSchema = z.object({ digest: Sha256 }).strict();
export type FixtureSetCallbackRequest = z.infer<typeof FixtureSetCallbackRequestSchema>;
/** The broker's answer: a signed https read address good for 15 minutes, for that digest. The worker downloads at once and holds the bytes to the digest (`fetchFixtureSet`); the address is never kept, logged or sent on. */
export const FixtureSetCallbackReplySchema = z.object({ digest: Sha256, url: z.string().min(12).max(4_096).regex(/^https:\/\/[^\s]+$/u), expiresAt: z.string().datetime() }).strict();
export type FixtureSetCallbackReply = z.infer<typeof FixtureSetCallbackReplySchema>;

// ---- the setup routes

export const TEST_ENV_REFUSALS = [
  "no_draft", "stale_draft", "no_proposal", "not_provable", "outdated", "checking", "failed", "no_setup_check", "commands_differ", "nothing_to_prove", "services_need_prove", "setup_check_old", "setup_run_moved", "dependencies_not_checked",
] as const;
export type TestEnvRefusal = (typeof TEST_ENV_REFUSALS)[number];

/** A check as the approval card shows it, with the arguments that narrow its tests (shown, because they decide which tests run once a map exists). */
const CheckRow = z.object({ id: Id, label: line(80), kind: CheckKindSchema, selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict();
export const TestEnvSummarySchema = z
  .object({
    tier: z.enum(["sandbox", "preview", "shared"]),
    repositories: z.array(z.object({ repositoryId: line(200), setupCommands: z.number().int().min(0), checks: z.array(CheckRow).max(32) }).strict()).max(16),
    selectionMethod: z.enum(TEST_ENV_SELECTION_METHODS),
    roundBudgetMin: z.number().int(),
    nightly: z.object({ enabled: z.boolean(), cronUtc: line(64), branch: line(255) }).strict(),
    services: z.number().int().min(0),
    /** Test services: how many dependencies the environment lists, and how many of them run something Rovara starts. Absent when there are none, so a summary without test services is today's summary. */
    dependencies: z.object({ count: z.number().int().min(1).max(TEST_ENV_DEPENDENCY_LIMITS.dependencies), started: z.number().int().min(0).max(TEST_ENV_DEPENDENCY_LIMITS.dependencies) }).strict().optional(),
  })
  .strict();
export type TestEnvSummary = z.infer<typeof TestEnvSummarySchema>;

export function testEnvSummaryOf(body: TestEnvironmentBody): TestEnvSummary {
  return {
    tier: body.tier,
    repositories: body.repos.map((repo) => ({ repositoryId: repo.repositoryId, setupCommands: repo.setupCommands.length, checks: repo.checks.map((check) => ({ id: check.id, label: check.label, kind: check.kind, ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }) })) })),
    selectionMethod: body.selection.method,
    roundBudgetMin: body.roundBudgetMin,
    nightly: { enabled: body.nightly.enabled, cronUtc: body.nightly.cronUtc, branch: body.nightly.branch },
    services: body.services.length,
    ...(body.dependencies === undefined || body.dependencies.length === 0 ? {} : { dependencies: { count: body.dependencies.length, started: testEnvStartedCount(body.dependencies) } }),
  };
}

/** One repository's commands as the broker formats them: the lines a person reads before approving. `selectArgs` is shown because it decides which tests run once a coverage map exists. */
export const TestEnvRunsSchema = z
  .object({
    repositoryId: line(200),
    setup: z.array(line(600)).max(20),
    checks: z.array(z.object({ id: Id, label: line(80), kind: CheckKindSchema, command: line(600), selectArgs: z.array(z.string().min(1).max(256)).max(8).optional() }).strict()).max(32),
  })
  .strict();
export type TestEnvRuns = z.infer<typeof TestEnvRunsSchema>;

export const TestEnvironmentStateSchema = z
  .object({
    approved: z.object({
      revision: z.number().int().min(1), approvedAt: z.string().datetime(), digest: Sha256, summary: TestEnvSummarySchema,
      /** S2: the approved environment's commands that the project's settings do not hold (the write after the approval did not land, or the settings changed since), and where the check of this digest stands at the current settings revision. */
      commandsNotInSettings: z.number().int().min(0).max(1000).default(0),
      check: z.object({ status: z.enum(["unchecked", "checking", "ready", "failed", "outdated"]), failedStep: line(400).optional() }).strict().default({ status: "unchecked" }),
    }).strict().optional(),
    /** What the latest setup run found, ready to propose. `stale`: the setup run is older than the project's settings or is not ready. */
    draft: z.object({ looked: z.boolean().default(false), status: z.enum(["none", "ready", "stale"]), notes: z.array(line(400)).max(60), questions: z.array(line(400)).max(60), pendingServices: z.array(TestEnvPendingServiceSchema).max(32) }).strict(),
    proposal: z
      .object({
        digest: Sha256,
        /** `setup`: what Rovara drafted from the default branch. `edited`: a maintainer's own edit of it. */
        source: z.enum(["setup", "edited"]).default("setup"),
        risk: z.enum(["low", "medium", "high"]),
        lessSafe: z.array(z.string().max(60)).max(20),
        summary: TestEnvSummarySchema,
        /** The whole proposed body, so a maintainer can edit it. */
        environment: TestEnvironmentBodySchema,
        /** What will run, as the broker formats it (never the browser): each setup command and check, with the arguments that narrow its tests. */
        runs: z.array(TestEnvRunsSchema).max(16).default([]),
        /** Where each value came from: a file and line, a code detector, or the setup agent. */
        valueSources: z.array(z.object({ field: line(200), source: TestEnvValueSourceSchema }).strict()).max(400).default([]),
        proved: z.boolean(),
        proveSteps: z.array(z.object({ step: z.string().max(40), status: z.enum(["passed", "failed", "skipped"]) }).strict()).max(10),
        /**
         * What approving it needs. A change that is less safe, or high risk, needs a fresh sign-in from the person who presses Approve; a less-safe one also needs a second person, who
         * confirms on the confirmation page (or the one owner of a company with nobody else, by the sole-owner exception).
         */
        needs: z.object({ freshSignIn: z.boolean(), secondPerson: z.boolean() }).strict().default({ freshSignIn: false, secondPerson: false }),
        /** The confirmation card the CALLER asked for, for a change that needs a second person. `approved`: it was confirmed and the caller can finish the approval. */
        approval: z.object({
          status: z.enum(["none", "pending", "approved", "expired"]),
          /** TS-UX-1 item 1: the viewer asked for the card (they finish the approval once it is confirmed). */
          askedByYou: z.boolean().optional(),
          /** The card waits and the viewer may confirm it now: the page shows the card itself, decided with the email-code sign-in. */
          youConfirm: z.boolean().optional(),
          /** The card, for the asker and for a viewer who may confirm it (`approve_request:<id>` on the decision cards). */
          approvalId: z.string().regex(/^apr_[0-9a-z]{20}$/u).optional(),
          /** Who a waiting card waits for, for the asker: a second person, or the asker themselves as the company's only owner (the sole-owner exception, with the company switch on). */
          waitingFor: z.enum(["second_person", "you_sole_owner"]).optional(),
        }).strict().default({ status: "none" }),
        /** TS-UX-1: the dependencies the proposal starts that can hold a seed, each with EVERY command that fills it with test data (as the broker formats them, in the order they run). */
        dependencySeeds: z.array(z.object({ id: TestEnvDependencyIdSchema, name: line(80), commands: z.array(line(600)).max(TEST_ENV_SEED_COMMANDS_MAX).default([]) }).strict()).max(TEST_ENV_DEPENDENCY_LIMITS.dependencies).default([]),
        /** SEED-RISK-1: each seed command's risk and why, in fixed words from the broker (medium: detected unchanged from the repository's files and run only on the test database; high: the reason). */
        seedRisks: z.array(z.object({ dependencyId: TestEnvDependencyIdSchema, risk: z.enum(["medium", "high"]), reason: line(400) }).strict()).max(TEST_ENV_DEPENDENCY_LIMITS.dependencies * TEST_ENV_DEPENDENCY_LIMITS.seeds).default([]),
        /** The project's commands that the proposal's commands are not among: approving writes them into the settings, after the check ran them. */
        commandsNotInSettings: z.number().int().min(0).max(1000).default(0),
        /** TE-2: the candidate check of THIS proposal (a fresh workspace prepared from the proposal's commands, never from the applied settings), at the settings revision as they stand now. */
        check: z.object({ status: z.enum(["unchecked", "checking", "ready", "failed", "outdated"]), failedStep: line(400).optional() }).strict().default({ status: "unchecked" }),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TestEnvironmentState = z.infer<typeof TestEnvironmentStateSchema>;

export const TestEnvProposeBodySchema = z.object({}).strict();
export const TestEnvProveBodySchema = z.object({ digest: Sha256 }).strict();
/**
 * Run the candidate check of a proposal: a request id, so a retry is one check. TS-UX-1 item 2 ("Check it works", one press): with no digest, the broker first proposes what the latest look found (as `propose`
 * does), then checks that proposal; the Prove is read from the check when it passes, with no press of its own.
 */
export const TestEnvCheckBodySchema = z.object({ digest: Sha256.optional(), requestId: z.string().uuid() }).strict();
export type TestEnvCheckBody = z.infer<typeof TestEnvCheckBodySchema>;
export const TestEnvApproveBodySchema = z.object({ digest: Sha256, expectedRevision: z.number().int().min(0), requestId: z.string().min(8).max(100).optional() }).strict();

/**
 * A maintainer's edited proposal: the whole body, validated like any other (the broker checks it again and refuses production, recordings in the shared tier and unsafe selection). `digest` is the digest of the proposal
 * the person was editing: when it is given and that is no longer the project's current proposal (someone proposed or edited since), the broker refuses the edit with `TEST_ENV_EDIT_STALE_MESSAGE` (409) instead of
 * replacing the newer one. Optional, so a client that does not send it behaves as before.
 */
export const TestEnvEditBodySchema = z.object({ environment: TestEnvironmentBodySchema, digest: Sha256.optional() }).strict();
/** The fixed sentence of a refused stale edit (never the digests). */
export const TEST_ENV_EDIT_STALE_MESSAGE = "The proposal you edited has changed since you opened it. Reload it and make your edit again.";
/** The longest seed command line the field takes (the same bound a command line has in the settings). */
export const TEST_ENV_SEED_COMMAND_MAX_CHARS = 500;
/**
 * TS-UX-1: set the commands that fill one dependency with test data ("Fill it with test data"): ALL of them, one line each, in the order they run (at most `TEST_ENV_SEED_COMMANDS_MAX`). Each line is one plain line the BROKER
 * reads (the same rules as a setup command: one program, no pipes); an empty list clears them. It becomes a maintainer's edited proposal, proved and approved like any edit, and, as a seed command, a less-safe change.
 */
export const TestEnvSeedBodySchema = z.object({ digest: Sha256, dependencyId: TestEnvDependencyIdSchema, commands: z.array(z.string().max(TEST_ENV_SEED_COMMAND_MAX_CHARS).regex(NO_HIDDEN, "one plain line")).max(TEST_ENV_SEED_COMMANDS_MAX) }).strict();
export type TestEnvSeedBody = z.infer<typeof TestEnvSeedBodySchema>;
export type TestEnvEditBody = z.infer<typeof TestEnvEditBodySchema>;

/** Apply a proposal's commands to the project's settings: the settings revision the person looked at, and a request id so a retry is one save. */
export const TestEnvApplyBodySchema = z.object({ digest: Sha256, requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export type TestEnvApplyBody = z.infer<typeof TestEnvApplyBodySchema>;

export const TEST_ENV_APPLY_SKIPPED = ["different_directory", "too_many", "download_and_run", "not_needed"] as const;
export const TestEnvApplyAnswerSchema = z
  .object({
    /** The commands now in the project's settings that came from the proposal, as the settings hold them. */
    added: z.array(line(600)).max(40),
    /** Commands left out, and why (fixed words, never the command). */
    skipped: z.array(z.object({ reason: z.enum(TEST_ENV_APPLY_SKIPPED), count: z.number().int().min(1) }).strict()).max(8),
    settingsRevision: z.number().int().min(1),
    setupCheck: z.enum(["started", "not_started", "not_needed"]),
    state: TestEnvironmentStateSchema,
  })
  .strict();
export type TestEnvApplyAnswer = z.infer<typeof TestEnvApplyAnswerSchema>;

/** Ask for the second person's confirmation of a change that needs one. */
export const TestEnvRequestApprovalBodySchema = z.object({ digest: Sha256, expectedRevision: z.number().int().min(0) }).strict();
export type TestEnvRequestApprovalBody = z.infer<typeof TestEnvRequestApprovalBodySchema>;
export const TestEnvRequestApprovalAnswerSchema = z.object({ status: z.enum(["pending", "approved"]), confirmUrl: z.string().max(2048).optional(), state: TestEnvironmentStateSchema }).strict();
export type TestEnvRequestApprovalAnswer = z.infer<typeof TestEnvRequestApprovalAnswerSchema>;

/** What an approval answers. `needs_second_person`: nothing was approved; the confirmation card is what to open. */
export const TestEnvApproveAnswerSchema = z.object({ revision: z.number().int().min(1), digest: Sha256, replayed: z.boolean(), state: TestEnvironmentStateSchema }).strict();
export type TestEnvApproveAnswer = z.infer<typeof TestEnvApproveAnswerSchema>;
